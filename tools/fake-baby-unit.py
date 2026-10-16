#!/usr/bin/env python3
"""
A stand-in baby unit for testing the parent app in the iOS Simulator (which has no camera).

It speaks the app's signalling protocol, version 2 (src/session/secure/handshake.ts): advertises
itself over Bonjour, accepts TCP on the monitor port, pairs parents with CPace and the pairing code
(--code, default 123456), authenticates parents it paired with before, then streams a moving test
pattern (plus silent audio) over WebRTC with all signalling encrypted. It also sends a motion event
every --motion-every seconds.

Needs libsodium for ristretto255 (CPace); `cryptography` comes with aiortc:

    brew install libsodium                       # Debian/Ubuntu: apt install libsodium23
    python3 -m venv .venv && .venv/bin/pip install aiortc numpy pillow
    .venv/bin/python tools/fake-baby-unit.py
    .venv/bin/python tools/fake-baby-unit.py --self-test    # CPace test vectors, then exit

Pairing keys live in memory, so a restarted stand-in asks the parent for the code again
(--keys FILE keeps them). Development builds only: debug port and Bonjour type.
"""
import argparse
import asyncio
import base64
import ctypes
import ctypes.util
import hashlib
import hmac
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time

# Development builds of the app use their own port and Bonjour type (see src/session/media.ts),
# so this stand-in never mixes with real baby units on the same Wi-Fi.
PORT = 47301
SERVICE_TYPE = "_babymondev._tcp"
MONITOR_ID = "fake-baby-unit"

PROTOCOL_VERSION = 2
LABEL = b"moonbeam/2"
AD_PARENT = b"moonbeam/2 parent"
AD_BABY = b"moonbeam/2 baby"
DSI = b"CPaceRistretto255"


# --- libsodium (ristretto255) -------------------------------------------------------------------

_sodium = None


def sodium():
    global _sodium
    if _sodium is None:
        candidates = [
            ctypes.util.find_library("sodium"),
            "/opt/homebrew/lib/libsodium.dylib",
            "/usr/local/lib/libsodium.dylib",
            "libsodium.so.23",
            "libsodium.so.26",
        ]
        for name in filter(None, candidates):
            try:
                lib = ctypes.CDLL(name)
            except OSError:
                continue
            if lib.sodium_init() >= 0:
                _sodium = lib
                break
        else:
            sys.exit("libsodium not found: brew install libsodium (or apt install libsodium23)")
    return _sodium


def ristretto_from_hash(digest64):
    """RFC 9496 element derivation (G.calculate_generator's last step); returns the encoding."""
    out = ctypes.create_string_buffer(32)
    sodium().crypto_core_ristretto255_from_hash(out, digest64)
    return out.raw


def ristretto_mult(scalar, encoded):
    """y·X, or None for an invalid encoding, the neutral element or a neutral result."""
    if len(encoded) != 32:
        return None
    out = ctypes.create_string_buffer(32)
    if sodium().crypto_scalarmult_ristretto255(out, scalar, encoded) != 0:
        return None
    return out.raw


# --- CPace (draft-irtf-cfrg-cpace-21), same as src/session/secure/cpace.ts ----------------------


def prepend_len(data):
    length, encoded = len(data), b""
    while True:
        encoded += bytes([length if length < 128 else (length & 0x7F) | 0x80])
        length >>= 7
        if length == 0:
            return encoded + data


def lv_cat(*parts):
    return b"".join(prepend_len(part) for part in parts)


def sha512(data):
    return hashlib.sha512(data).digest()


def calculate_generator(prs, ci, sid):
    zpad = max(0, 128 - 1 - len(prepend_len(prs)) - len(prepend_len(DSI)))
    return ristretto_from_hash(sha512(lv_cat(DSI, prs, bytes(zpad), ci, sid)))


def sample_scalar():
    while True:
        scalar = bytearray(secrets.token_bytes(32))
        scalar[31] &= 0x0F
        if any(scalar):
            return bytes(scalar)


def intermediate_key(sid, k, ya, ada, yb, adb):
    return sha512(lv_cat(DSI + b"_ISK", sid, k) + lv_cat(ya, ada) + lv_cat(yb, adb))


def confirmation_tag(sid, isk, share, ad):
    return hmac.new(sha512(b"CPaceMac" + sid + isk), lv_cat(share, ad), hashlib.sha512).digest()


def hkdf(ikm, salt, info, length):
    prk = hmac.new(salt, ikm, hashlib.sha512).digest()
    out, block, counter = b"", b"", 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha512).digest()
        out += block
        counter += 1
    return out[:length]


def self_test():
    """Test vectors from draft-irtf-cfrg-cpace-21, appendix B.3."""
    prs, ci = b"Password", bytes.fromhex("0b415f696e69746961746f720b425f726573706f6e646572")
    sid = bytes.fromhex("7e4b4791d6a8ef019b936c79fb7f2c57")
    g = calculate_generator(prs, ci, sid)
    assert g.hex() == "222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56", g.hex()
    ya_s = bytes.fromhex("da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08")
    yb_s = bytes.fromhex("d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d")
    ya, yb = ristretto_mult(ya_s, g), ristretto_mult(yb_s, g)
    assert ya.hex() == "d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157"
    assert yb.hex() == "3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258"
    k = ristretto_mult(yb_s, ya)
    assert k == ristretto_mult(ya_s, yb)
    assert k.hex() == "80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f"
    isk = intermediate_key(sid, k, ya, b"ADa", yb, b"ADb")
    assert isk.hex() == (
        "b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd"
        "2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447"
    )
    s = bytes.fromhex("7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05")
    assert ristretto_mult(s, bytes.fromhex("2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c")) is None
    assert ristretto_mult(s, bytes(32)) is None
    print("CPace test vectors: ok")


# --- Protocol, same as src/session/secure/handshake.ts ------------------------------------------


class ProtocolError(Exception):
    pass


def b64(data):
    return base64.b64encode(data).decode()


def field(message, key, length):
    value = message.get(key)
    if not isinstance(value, str):
        raise ProtocolError(f"missing {key}")
    try:
        data = base64.b64decode(value, validate=True)
    except ValueError as error:
        raise ProtocolError(f"bad {key}") from error
    if len(data) != length:
        raise ProtocolError(f"bad {key}")
    return data


def id_field(message, key):
    value = message.get(key)
    if not isinstance(value, str) or not 1 <= len(value) <= 64 or not all(c.isascii() and (c.isalnum() or c in "_-") for c in value):
        raise ProtocolError(f"bad {key}")
    return value


def version_of(message):
    v = message.get("v")
    return v if isinstance(v, int) and not isinstance(v, bool) else 1


def cpace_inputs(monitor_id, parent_id, monitor_nonce, parent_nonce):
    ci = lv_cat(LABEL, b"parent", parent_id.encode(), b"baby", monitor_id.encode())
    sid = sha512(lv_cat(LABEL, b"sid", parent_id.encode(), monitor_id.encode(), monitor_nonce, parent_nonce))[:32]
    return ci, sid


def auth_transcript(monitor_id, parent_id, monitor_nonce, parent_nonce, parent_share):
    return lv_cat(LABEL, b"auth", monitor_id.encode(), parent_id.encode(), monitor_nonce, parent_nonce, parent_share)


def auth_mac(pairing_key, role, data):
    key = hkdf(pairing_key, b"", b"moonbeam/2 auth " + role, 32)
    return hmac.new(key, data, hashlib.sha512).digest()


class Channel:
    """ChaCha20-Poly1305, one key per direction, message counter as the nonce."""

    def __init__(self, send_key, receive_key):
        from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

        self.send_cipher, self.receive_cipher = ChaCha20Poly1305(send_key), ChaCha20Poly1305(receive_key)
        self.sent = self.received = 0

    def seal(self, message):
        box = self.send_cipher.encrypt(bytes(4) + self.sent.to_bytes(8, "big"), json.dumps(message).encode(), LABEL)
        self.sent += 1
        return {"type": "sealed", "box": b64(box)}

    def open(self, message):
        if message.get("type") != "sealed" or not isinstance(message.get("box"), str):
            raise ProtocolError("not sealed")
        try:
            plain = self.receive_cipher.decrypt(
                bytes(4) + self.received.to_bytes(8, "big"), base64.b64decode(message["box"], validate=True), LABEL
            )
        except Exception as error:
            raise ProtocolError("message does not authenticate") from error
        self.received += 1
        return json.loads(plain)


class Keys:
    """Pairing keys by parent id, optionally kept in a JSON file between runs."""

    def __init__(self, path):
        self.path, self.keys = path, {}
        if path and os.path.exists(path):
            with open(path) as file:
                self.keys = {pid: base64.b64decode(key) for pid, key in json.load(file).items()}

    def get(self, parent_id):
        return self.keys.get(parent_id)

    def put(self, parent_id, key):
        self.keys[parent_id] = key
        if self.path:
            with open(self.path, "w") as file:
                json.dump({pid: b64(k) for pid, k in self.keys.items()}, file)


async def handshake(reader, send_raw, code, keys, peer):
    """Runs the baby unit's side until the parent is authenticated; returns the channel or None."""
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    nonce = secrets.token_bytes(32)
    await send_raw({"type": "welcome", "v": PROTOCOL_VERSION, "id": MONITOR_ID, "nonce": b64(nonce)})
    stage, pending = "hello", None
    while line := await reader.readline():
        message = json.loads(line)
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            raise ProtocolError("not a message")
        kind = message["type"]
        if stage in ("hello", "awaitPair") and (kind == "join" or version_of(message) != PROTOCOL_VERSION):
            print(f"{peer}: parent speaks protocol version {version_of(message)}, this is {PROTOCOL_VERSION}")
            await send_raw({"type": "version", "v": PROTOCOL_VERSION})
            return None
        if kind == "auth" and stage == "hello":
            parent_id = id_field(message, "pid")
            parent_nonce, parent_share = field(message, "nonce", 32), field(message, "e", 32)
            mac, key = field(message, "mac", 64), keys.get(parent_id)
            transcript = auth_transcript(MONITOR_ID, parent_id, nonce, parent_nonce, parent_share)
            if key is None or not hmac.compare_digest(mac, auth_mac(key, b"parent", transcript)):
                print(f"{peer}: unknown parent {parent_id[:8]}…, asking for the code")
                stage = "awaitPair"
                await send_raw({"type": "pairRequired"})
                continue
            secret = X25519PrivateKey.generate()
            baby_share = secret.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
            shared = secret.exchange(X25519PublicKey.from_public_bytes(parent_share))  # rejects low-order shares
            await send_raw({"type": "authOk", "e": b64(baby_share), "mac": b64(auth_mac(key, b"baby", transcript + lv_cat(baby_share)))})
            info = b"moonbeam/2 auth session" + sha512(transcript + lv_cat(baby_share))
            okm = hkdf(shared, key, info, 64)
            print(f"{peer}: authenticated with the key of {parent_id[:8]}…")
            return Channel(okm[32:], okm[:32])
        if kind == "pair" and stage in ("hello", "awaitPair"):
            parent_id = id_field(message, "pid")
            parent_nonce, parent_share = field(message, "nonce", 32), field(message, "y", 32)
            ci, sid = cpace_inputs(MONITOR_ID, parent_id, nonce, parent_nonce)
            scalar = sample_scalar()
            baby_share = ristretto_mult(scalar, calculate_generator(code.encode(), ci, sid))
            k = ristretto_mult(scalar, parent_share)
            if k is None:
                raise ProtocolError("bad share")
            isk = intermediate_key(sid, k, parent_share, AD_PARENT, baby_share, AD_BABY)
            pending = (parent_id, sid, isk, parent_share)
            stage = "confirm"
            await send_raw({"type": "pairReply", "y": b64(baby_share), "mac": b64(confirmation_tag(sid, isk, baby_share, AD_BABY))})
            continue
        if kind == "pairConfirm" and stage == "confirm":
            parent_id, sid, isk, parent_share = pending
            if not hmac.compare_digest(field(message, "mac", 64), confirmation_tag(sid, isk, parent_share, AD_PARENT)):
                print(f"{peer}: wrong code")
                await asyncio.sleep(1)
                await send_raw({"type": "pairFailed"})
                return None
            keys.put(parent_id, hkdf(isk, sid, b"moonbeam/2 pairing key", 32))
            okm = hkdf(isk, sid, b"moonbeam/2 pairing session", 64)
            print(f"{peer}: paired with {parent_id[:8]}…")
            return Channel(okm[32:], okm[:32])
        raise ProtocolError(f"unexpected {kind}")
    return None


# --- Media --------------------------------------------------------------------------------------


def media_tracks(args):
    import numpy as np
    from aiortc import AudioStreamTrack, VideoStreamTrack
    from av import VideoFrame

    class ImageTrack(VideoStreamTrack):
        """Streams a still picture."""

        def __init__(self, path):
            super().__init__()
            from PIL import Image

            self.frame = np.asarray(Image.open(path).convert("RGB"))

        async def recv(self):
            pts, time_base = await self.next_timestamp()
            video = VideoFrame.from_ndarray(self.frame, format="rgb24")
            video.pts, video.time_base = pts, time_base
            return video

    class PatternTrack(VideoStreamTrack):
        """A bright bar sweeping across a night-blue frame: easy to spot, obviously moving."""

        async def recv(self):
            pts, time_base = await self.next_timestamp()
            frame = np.empty((360, 640, 3), np.uint8)
            frame[:] = (20, 26, 64)
            x = int(time.time() * 160) % 640
            frame[:, max(0, x - 24) : x + 24] = (255, 214, 128)
            video = VideoFrame.from_ndarray(frame, format="rgb24")
            video.pts, video.time_base = pts, time_base
            return video

    tracks = [ImageTrack(args.image) if args.image else PatternTrack()]
    if not args.no_audio:
        tracks.append(AudioStreamTrack())
    return tracks


def local_ip():
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))  # no packet is sent; this only picks the outgoing interface
        return probe.getsockname()[0]
    finally:
        probe.close()


async def serve_parent(reader, writer, args, keys):
    from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
    from aiortc.sdp import candidate_from_sdp

    peer = writer.get_extra_info("peername")
    pc = None
    channel = None
    tasks = []

    async def send_raw(message):
        writer.write((json.dumps(message) + "\n").encode())
        await writer.drain()

    async def send(message):
        await send_raw(channel.seal(message))

    async def every(seconds, message):
        while True:
            await asyncio.sleep(seconds)
            print(f"{peer}: {message['type']}")
            await send(message)

    try:
        channel = await handshake(reader, send_raw, args.code, keys, peer)
        if channel is None:
            return
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        for track in media_tracks(args):
            pc.addTrack(track)
        await pc.setLocalDescription(await pc.createOffer())
        await send({"type": "hello", "addresses": [local_ip()]})
        await send({"type": "status", "video": True})
        ends_at = int((time.time() + args.sound_minutes * 60) * 1000) if args.sound != "off" else None
        await send({
            "type": "settings",
            "settings": {"camera": "back", "quality": "1080p", "night": "auto", "motion": "medium", "loudness": "medium", "cry": "on",
                         "sound": args.sound, "soundVolume": "medium", "soundTimer": "30"},
            "soundEndsAt": ends_at,
        })
        await send({"type": "battery", "level": args.battery / 100, "charging": args.charging})
        await send({"type": "offer", "sdp": pc.localDescription.sdp})
        if args.motion_every > 0:
            tasks.append(asyncio.create_task(every(args.motion_every, {"type": "motion"})))
        if args.sound_event_every > 0:
            tasks.append(asyncio.create_task(every(args.sound_event_every, {"type": "sound"})))
        if args.cry_every > 0:
            tasks.append(asyncio.create_task(every(args.cry_every, {"type": "cry"})))

        while line := await reader.readline():
            message = channel.open(json.loads(line))
            kind = message.get("type")
            if kind == "answer":
                await pc.setRemoteDescription(RTCSessionDescription(message["sdp"], "answer"))
                print(f"{peer}: answered")
            elif kind == "candidate" and message["candidate"].get("candidate"):
                raw = message["candidate"]
                candidate = candidate_from_sdp(raw["candidate"].split(":", 1)[1])
                candidate.sdpMid = raw.get("sdpMid")
                candidate.sdpMLineIndex = raw.get("sdpMLineIndex")
                await pc.addIceCandidate(candidate)
            elif kind == "setSettings":
                print(f"{peer}: settings {message.get('settings')}")
    except (ProtocolError, ValueError, KeyError, ConnectionError) as error:
        print(f"{peer}: {error or type(error).__name__}")
    finally:
        for task in tasks:
            task.cancel()
        if pc:
            await pc.close()
        writer.close()
        print(f"{peer}: closed")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", default="Test Baby Unit")
    parser.add_argument("--code", default="123456")
    parser.add_argument("--keys", help="JSON file that keeps parents' pairing keys between runs")
    parser.add_argument("--motion-every", type=float, default=20)
    parser.add_argument("--sound-event-every", type=float, default=0, help="seconds between loud-sound events")
    parser.add_argument("--cry-every", type=float, default=0, help="seconds between crying events")
    parser.add_argument("--battery", type=float, default=78, help="battery percent to report")
    parser.add_argument("--charging", action="store_true", help="report the baby unit as charging")
    parser.add_argument("--image", help="stream this picture instead of the moving test pattern")
    parser.add_argument("--sound", default="off", help="sleep sound to report as playing, e.g. lullaby")
    parser.add_argument("--sound-minutes", type=float, default=23, help="minutes left on the sleep timer")
    parser.add_argument("--no-audio", action="store_true", help="video only: simulators can crash when they start playing sound")
    parser.add_argument("--self-test", action="store_true", help="check CPace against the draft's test vectors and exit")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return
    if not (len(args.code) == 6 and args.code.isdigit()):
        sys.exit("--code must be 6 digits")
    self_test()
    keys = Keys(args.keys)

    server = await asyncio.start_server(lambda r, w: serve_parent(r, w, args, keys), "0.0.0.0", PORT)
    bonjour = subprocess.Popen(["dns-sd", "-R", args.name, SERVICE_TYPE, "local.", str(PORT)], stdout=subprocess.DEVNULL)
    print(f"Fake baby unit '{args.name}' on {local_ip()}:{PORT}, code {args.code}")
    # Ctrl-C or kill (also when started in the background) removes the Bonjour registration too.
    stop = asyncio.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(signum, stop.set)
    try:
        await stop.wait()
    finally:
        # Don't wait for connected parents to hang up; asyncio.run cancels their handlers on exit.
        server.close()
        bonjour.terminate()


if __name__ == "__main__":
    asyncio.run(main())

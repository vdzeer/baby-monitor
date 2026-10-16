# Moonbeam: Baby Monitor

Moonbeam turns two or more iPhones or iPads into a video baby monitor that works only on your local network. One device, the baby unit, streams its camera and microphone over WebRTC to one or more parent devices. There is no server, account or cloud service: discovery, pairing and streaming happen directly between the devices.

The app is built with Expo (SDK 57) and React Native, plus a local Swift module for networking, audio and camera processing. It runs on iOS and iPadOS only. The UI is in English and Ukrainian.

## Features

- Live video (720p or 1080p) and sound from the baby unit to several parent devices at once.
- The baby unit keeps its screen dark. Its menu opens only after holding two fingers on the screen for 2 seconds.
- Motion detection on camera frames, loud-sound detection, and crying detection with Apple's built-in sound classifier. All detection runs on the baby unit; parents receive only the event.
- Local notifications on parent devices, a Live Activity on the Lock Screen and in the Dynamic Island (iPhone), or Picture in Picture.
- Night mode that brightens the picture and allows longer exposure in a dark room.
- Sleep sounds synthesized on the device (rain and piano, lullaby, rain, ocean, pink noise) with volume and timer. The microphone's echo canceller removes them, so parents still hear the baby.
- Baby unit battery level, with alerts when it is unplugged or low.
- Parents can change the baby unit's camera, quality, night mode, alert sensitivity and sleep sounds remotely.
- Automatic discovery and reconnection: Bonjour first, then the last known IP address, then a scan of the local /24 subnet. Manual connection by IP address is also available.

## How it works

1. **Roles.** On first launch you choose a role for the device: baby unit or parent unit. The choice is saved and the app starts in that role from then on.
2. **Baby unit.** On first launch it creates a random 16-digit device id and a 6-digit pairing code (kept in the Keychain). It opens the camera and microphone, listens on a fixed TCP port and advertises itself over Bonjour.
3. **Discovery.** The parent unit browses Bonjour for the service type. If it finds nothing, it tries the addresses the baby unit reported last time, then probes the monitor port on every address of its /24 subnet.
4. **Pairing.** Signalling is newline-delimited JSON over TCP (`modules/baby-native/ios/BabyNativeModule.swift`), with the protocol in `src/session/secure/handshake.ts`. The first time, the parent asks for the code shown on the baby unit and the two devices run the CPace password-authenticated key exchange with it. From the result both derive a pairing key for that parent, which later connections use instead of the code. See the security notes below.
5. **Streaming.** After the handshake every signalling message is encrypted. The baby unit creates one WebRTC peer connection per parent; the SDP offer and answer travel in the encrypted channel and carry the DTLS certificate fingerprints, so the DTLS-SRTP encryption of the media is bound to the authenticated pairing.
6. **Local network only.** The peer connections have no STUN or TURN servers, so media flows only between devices that can reach each other directly. Signalling never uses cellular interfaces.

### Security notes

Version 2 of the signalling protocol (Moonbeam 1.0 shipped version 1). The design follows [draft-irtf-cfrg-cpace](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/); the code is in `src/session/secure/` and has unit tests, including the draft's test vectors. It has not had an independent review.

- **First pairing.** The parent and the baby unit run CPace over ristretto255 with SHA-512, using the 6-digit code, and confirm the result in both directions before anything else happens. A device that doesn't know the code gets exactly one guess per attempt: nothing it records, whether it watches a pairing or poses as a baby unit, lets it test other codes offline. Both device ids, both connections' nonces and the protocol version are bound into the session. A parent sends its confirmation only after the baby unit has proven the code, so a fake baby unit learns nothing beyond its one wrong guess.
- **Later connections** don't use the code. Both devices derive a 256-bit pairing key from the CPace result; it never travels over the network. Each connection proves it with MACs over fresh nonces from both sides and runs an ephemeral X25519 exchange, so recorded traffic can't be decrypted later even with the pairing key. The code is needed only to pair a new parent device.
- **Encrypted signalling.** After the handshake, every message (alerts, battery, settings, the WebRTC offer and answer with their DTLS fingerprints, ICE candidates) is sealed with ChaCha20-Poly1305, one key per direction and a counter as the nonce: altered, replayed or reordered messages close the connection. Neither side acts on anything but handshake messages before the other side has authenticated. The media is DTLS-SRTP, bound to this channel through the fingerprints.
- **Guessing the code online.** The baby unit counts every code attempt as failed until the parent proves the right code. Each source address waits 1 s, 2 s, 4 s and so on (up to 5 minutes) after its failures, and all sources together get at most 5 failed attempts per 10 minutes and 20 per day. That limits an attacker to about 7,300 guesses a year, under 1% of the codes. The limits block only new pairings: parents with a pairing key always connect. A new code resets them.
- **Revoking parents.** "New pairing code" in the baby unit's menu deletes every parent's pairing key, so each parent has to pair again with the new code. The new code takes effect only once it is saved in the Keychain; otherwise the baby unit says so and nothing changes. There is no way yet to remove a single parent device.
- **Who else can watch.** A parent device's settings show how many devices are paired with the baby unit and how many watch right now, and the parent device alerts you when a device paired since it last connected. The baby unit counts every pairing with the current code, so a pairing that took over another parent's slot (parent ids are visible on the network) or pushed out the oldest one is announced too. If there are more than your family's devices, create a new pairing code. A pairing still in progress when you create a new code can't finish: it was made with the old code.
- **One way only.** The baby unit's WebRTC connection to each parent only sends; a parent device can't play sound or video into the nursery.
- **Storage.** The code and the pairing keys are in the iOS Keychain, readable after the first unlock since restart, on this device only: they are never restored onto another device. Restoring the same device from its own backup may bring back the code and keys it had then, so after such a restore create a new code. A parent device never deletes a stored key or code because of a message from a device that hasn't authenticated.
- **Updating from version 1.** Both devices need the update; each side tells you to update the other one when the versions differ. The baby unit creates a new code on its first launch of version 2 and drops the old one, and parent devices drop the codes they saved: version 1 let anyone who recorded a pairing work the code out offline, and parents that haven't been updated keep sending such proofs. Enter the new code once on each parent device, after updating it.

Not covered:

- Anyone who can see the code on the baby unit's screen can pair. Its menu shows the code to anyone who knows the two-finger gesture.
- The limits on code attempts are kept in memory, so restarting the baby unit app resets them.
- A device on the network can use up the code attempts and so block new pairings for up to a day (creating a new code ends that), and can delay connections by holding open many unauthenticated ones (the baby unit keeps 8 at most, 3 per address, drops the oldest first and closes each after 2 minutes; the app accepts at most 32 connections at once, so a flood of them can't exhaust its memory). It can't make a paired parent forget its key or read or change anything.
- Discovery is not authenticated: any device can advertise itself as a baby unit, and a parent device that hasn't paired with it will show it and can ask for the code (one guess per attempt). Each baby unit advertises its own name (with the last digits of its id). Something that answers at your baby unit's name or address without proving itself is skipped for a while, and the parent looks for the baby unit at its other names and addresses meanwhile. Device ids and protocol messages are visible on the network; only their contents after the handshake are encrypted.
- The cryptography runs in JavaScript ([noble](https://paulmillr.com/noble/) libraries). JavaScript engines give no hard guarantees against timing side channels.
- A paired parent device can change the baby unit's settings.

## Requirements

- A Mac with Xcode and CocoaPods. The project is tested with Xcode 27.0.
- Node.js 20.19.4+, 22.13+ or 24.3+ (the versions React Native 0.86 supports).
- An Apple ID signed in to Xcode (Settings, Accounts). TestFlight and App Store builds need a paid Apple Developer Program membership.
- Two devices with iOS or iPadOS 16.4 or later on the same Wi-Fi network. The baby unit needs a real device (the Simulator has no camera). The parent unit also runs in the Simulator, against the stand-in baby unit described below.

## Setup

```sh
git clone https://github.com/vdzeer/baby-monitor.git
cd baby-monitor
npm ci
```

### Signing with your own team and bundle id

`app.json` contains the original author's Apple team id and bundle id (`com.vdzeer.babymonitor`). Signing fails with them unless you are on that team. Set your own through environment variables, which `app.config.js` and `scripts/testflight.sh` read:

```sh
export APPLE_TEAM_ID=ABCDE12345                 # Xcode, Settings, Accounts, or developer.apple.com, Membership
export IOS_BUNDLE_ID=com.example.babymonitor    # any id you can register
npx expo prebuild --platform ios --clean
```

The Live Activity widget gets `<bundle id>.widget` automatically. If you prefer to edit files instead, change `ios.appleTeamId` and `ios.bundleIdentifier` in `app.json` and the default team id in `scripts/testflight.sh`.

`ios/` is generated by `expo prebuild` and is not committed. Configure native behaviour in `app.json`, `app.config.js` and the config plugins, never in `ios/` directly.

### Running

```sh
npx expo run:ios --device                            # debug build on a connected device, with Metro
npx expo run:ios --device --configuration Release    # release build on a connected device
```

Install the app on two devices. On the device next to the baby choose "Baby unit" and allow the camera, microphone and local network. On the other device choose "Parent unit" and enter the 6-digit code shown on the baby unit.

Debug and release builds use different ports and Bonjour types, so a development build can never find or connect to a baby unit running a release build:

| Build   | TCP port | Bonjour type        |
| ------- | -------- | ------------------- |
| Debug   | 47301    | `_babymondev._tcp`  |
| Release | 47300    | `_babymon._tcp`     |

Both units must be the same kind of build to see each other.

### Stand-in baby unit (Simulator)

`tools/fake-baby-unit.py` speaks the app's protocol from a Mac: it advertises itself over Bonjour (`dns-sd`), pairs with the code `123456` (or `--code`), authenticates parents it paired with before and streams a test pattern over WebRTC. It uses the debug port and Bonjour type, so it works only with debug builds. CPace needs libsodium's ristretto255 functions; `cryptography` comes with aiortc.

```sh
brew install libsodium              # Debian/Ubuntu: apt install libsodium23
python3 -m venv .venv
.venv/bin/pip install aiortc numpy pillow
.venv/bin/python tools/fake-baby-unit.py --self-test    # CPace test vectors from the draft
.venv/bin/python tools/fake-baby-unit.py --help
```

Pairing keys stay in memory, so after a restart the stand-in asks the parent for the code again (`--keys FILE` keeps them). To check that the stand-in and the app's protocol code agree on the wire, run the app's parent side against it from Node:

```sh
.venv/bin/python tools/fake-baby-unit.py --no-audio --motion-every 0 &
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/interop-check.ts
kill %1
```

### TestFlight

```sh
npm run testflight              # archive, sign and upload with the account signed in to Xcode
npm run testflight -- export    # archive and sign locally, no upload
```

Output goes to `build/testflight/` (not committed).

## Checks

```sh
npm test            # protocol unit tests (Node's test runner; needs Node 22.18+ or 24+)
npx tsc --noEmit    # typecheck
npx expo lint       # ESLint with eslint-config-expo
```

The unit tests cover the pairing protocol in `src/session/secure/`: the CPace test vectors, pairing, authentication with a stored key, wrong codes, tampered and replayed messages, version mismatches, the limits on code attempts, and that nothing saved by version 1 is taken over.

## Project layout

```
App.tsx                         role switch: setup, baby unit, parent unit
src/session/                    MonitorSession (baby unit), ParentSession, app messages, media presets
src/session/secure/             pairing protocol: CPace, handshake, encrypted channel, stored credentials (+ tests)
src/secrets.ts                  Keychain storage of the code and pairing keys
src/screens/                    screens and sheets
src/hooks/                      session, alerts, Live Activity and screen dimming hooks
src/i18n.ts                     English and Ukrainian UI strings
locales/                        localized display name and iOS permission texts
modules/baby-native/            local Expo module in Swift: Bonjour and TCP signalling, audio device,
                                motion and cry detection, night vision, sleep sounds, Live Activity, PiP
targets/widget/                 Live Activity widget extension (@bacons/apple-targets)
plugins/withSceneDelegate.js    config plugin: UIScene life cycle for the iOS 27 SDK on Expo SDK 57
scripts/testflight.sh           signed archive and TestFlight upload
tools/                          stand-in baby unit and its interoperability check
```

## Privacy

- No accounts, analytics, advertising or servers. The app makes no network requests outside the local network.
- Video and sound are streamed live and never recorded or saved.
- Motion, sound and crying are detected on the baby unit; parent devices receive only the event and its time.
- Each device stores its settings in the app's own storage: the role, the baby unit's id and the last known IP addresses of the baby unit. The pairing code and the pairing keys are in the iOS Keychain, on this device only. Deleting the app deletes them: iOS may keep Keychain items after the app is deleted, but a new installation replaces them with a new code and new keys.

The full privacy policy: <https://docs.google.com/document/d/1NMBnB1xcw9Xwo4lsXURHNM3e24jQ9YsqIHYCDiQKieQ/view>.

## License

MIT, see [LICENSE](LICENSE).

### Third-party software

- [Expo](https://github.com/expo/expo), [React Native](https://github.com/facebook/react-native) and [React](https://github.com/facebook/react): MIT.
- [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc): MIT. It ships Jitsi's build of [WebRTC](https://webrtc.org/) (BSD-3-Clause).
- [@bacons/apple-targets](https://github.com/EvanBacon/expo-apple-targets), [@config-plugins/react-native-webrtc](https://github.com/expo/config-plugins), [@react-native-async-storage/async-storage](https://github.com/react-native-async-storage/async-storage), [react-native-safe-area-context](https://github.com/AppAndFlow/react-native-safe-area-context): MIT.
- [@noble/curves, @noble/hashes and @noble/ciphers](https://paulmillr.com/noble/) (ristretto255, X25519, SHA-512, HKDF, HMAC, ChaCha20-Poly1305): MIT.
- Development tools only, not part of the app: [aiortc](https://github.com/aiortc/aiortc) (BSD-3-Clause), [NumPy](https://numpy.org/) (BSD-3-Clause), [Pillow](https://python-pillow.github.io/) (MIT-CMU), [libsodium](https://libsodium.org/) (ISC), [cryptography](https://github.com/pyca/cryptography) (Apache-2.0 or BSD-3-Clause).

The sleep sounds are synthesized in code (`modules/baby-native/ios/SleepSynth.swift`); no audio files are included. The lullaby plays Brahms' "Wiegenlied" (1868) and "Twinkle, Twinkle, Little Star", both in the public domain. Crying detection uses Apple's SoundAnalysis framework.

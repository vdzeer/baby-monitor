import type { MediaStream, RTCIceCandidate, RTCPeerConnection } from 'react-native-webrtc';

type PeerConnectionEvents = {
  icecandidate: { candidate: RTCIceCandidate | null };
  track: { streams: MediaStream[] };
  connectionstatechange: unknown;
};

type Listenable = { addEventListener(type: string, listener: (event: never) => void): void };

/**
 * react-native-webrtc publishes its types without the EventTarget base class,
 * so `addEventListener` is missing from RTCPeerConnection. Type the events we use.
 */
export function listen<K extends keyof PeerConnectionEvents>(
  pc: RTCPeerConnection,
  type: K,
  listener: (event: PeerConnectionEvents[K]) => void,
) {
  (pc as unknown as Listenable).addEventListener(type, listener);
}

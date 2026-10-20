// Video from the backend over WebRTC, which plays on a plain http page where WebCodecs cannot.
// One receiving connection per import a screen plays, shared by every element showing it,
// offered over the socket, and offered again when the socket comes back.

import { type Accessor, createEffect, createRoot, createSignal, on, type Setter } from "solid-js";
import { setState, state } from "../state/store";
import { send } from "./connection";

interface Playing {
  users: number;
  pc: RTCPeerConnection | null;
  stream: Accessor<MediaStream | null>;
  setStream: Setter<MediaStream | null>;
}

const playing = new Map<string, Playing>();

/** Starts or joins playing an import's video. The stream comes once the backend answers. */
export function play(alias: string): Accessor<MediaStream | null> {
  let p = playing.get(alias);
  if (!p) {
    const [stream, setStream] = createSignal<MediaStream | null>(null);
    p = { users: 0, pc: null, stream, setStream };
    playing.set(alias, p);
    void offer(alias, p);
  }
  p.users++;
  return p.stream;
}

/** Leaves playing an import's video, which ends once nothing on this screen shows it. */
export function stopPlaying(alias: string) {
  const p = playing.get(alias);
  if (!p || --p.users > 0) return;
  playing.delete(alias);
  p.pc?.close();
  if (state.link === "open") send({ type: "stop_playing", alias });
}

async function offer(alias: string, p: Playing) {
  p.pc?.close();
  p.pc = null;
  if (state.link !== "open") return;
  const pc = new RTCPeerConnection();
  p.pc = pc;
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.ontrack = (e) => p.setStream(new MediaStream([e.track]));
  await pc.setLocalDescription(await pc.createOffer());
  // a later offer or a stop replaced this one while it was made
  if (p.pc === pc && pc.localDescription) send({ type: "play", alias, offer: pc.localDescription.sdp });
}

createRoot(() => {
  // the backend's answer completes the connection that offered, then is spent
  createEffect(() => {
    for (const [alias, sdp] of Object.entries(state.answers)) {
      if (!sdp) continue;
      setState("answers", alias, undefined);
      const pc = playing.get(alias)?.pc;
      if (pc?.signalingState === "have-local-offer") void pc.setRemoteDescription({ type: "answer", sdp });
    }
  });
  // a new socket is a new session, which knows nothing of what this screen played
  createEffect(
    on(
      () => state.link,
      (link) => {
        if (link === "open") for (const [alias, p] of playing) void offer(alias, p);
      },
    ),
  );
});

// The one socket to the backend, CBOR both ways. It heartbeats so the backend can tell a
// lost screen, and reconnects by itself, at once when the page shows again.

import { Decoder, Encoder } from "cbor-x";
import type { ClientMsg } from "../protocol/ClientMsg";
import type { ServerMsg } from "../protocol/ServerMsg";
import { notify, receive, setState, state } from "../state/store";

const HEARTBEAT_MS = 100;
const RETRY_MAX_MS = 2000;

// plain CBOR maps as objects, none of cbor-x's own record extension, so Rust reads it
const cbor = { encoder: new Encoder({ useRecords: false }), decoder: new Decoder({ mapsAsObjects: true, useRecords: false }) };

let socket: WebSocket | null = null;
let beat: number | undefined;
let retry: number | undefined;
let tries = 0;

export function connect() {
  if (socket) return;
  clearTimeout(retry);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  socket = ws;
  setState("link", "connecting");
  ws.onopen = () => {
    tries = 0;
    setState("link", "open");
    beat = window.setInterval(() => send({ type: "ping", t: performance.now() }), HEARTBEAT_MS);
  };
  ws.onmessage = (e) => {
    const msg = cbor.decoder.decode(new Uint8Array(e.data as ArrayBuffer)) as ServerMsg;
    if (msg.type === "pong") {
      const rtt = performance.now() - msg.t;
      setState("rttMs", state.rttMs === null ? rtt : state.rttMs * 0.8 + rtt * 0.2);
    } else {
      receive(msg);
    }
  };
  ws.onclose = () => {
    clearInterval(beat);
    socket = null;
    setState({ link: "closed", rttMs: null });
    retry = window.setTimeout(connect, Math.min(RETRY_MAX_MS, 200 * 2 ** tries++));
  };
}

/** Sends at once, true when it went. Without a link nothing can be done, so the person hears
 *  it was not. */
export function send(msg: ClientMsg): boolean {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(cbor.encoder.encode(msg));
    return true;
  }
  if (msg.type !== "ping") notify("The HMI is out of reach, so that was not done.", "warn");
  return false;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !socket) connect();
});

// The link to the backend: one socket, CBOR both ways, and a WebRTC data connection offered
// over it, a reliable ordered channel and a best effort one. The socket carries everything the
// channels do not, times the round trip for the status bar, and reconnects by itself, at once
// when the page shows again.

import { Decoder, Encoder } from "cbor-x";
import type { ClientMsg } from "../protocol/ClientMsg";
import type { ServerMsg } from "../protocol/ServerMsg";
import { notify, receive, setState, state } from "../state/store";

/** 20 times a second, so the round trip shown is a fresh one. */
const ROUND_TRIP_EVERY_MS = 50;
const RETRY_MAX_MS = 2000;
/** How long the channels may take to open before they count as failed. */
const CHANNELS_WAIT_MS = 10_000;
/** Failed channels are offered again after this, doubling each time up to a minute. */
const CHANNELS_RETRY_MS = 2000;
const CHANNELS_RETRY_MAX_MS = 60_000;

/** What a person does on a running page, which goes on the reliable channel while it is open. */
const ON_CHANNEL: ReadonlySet<ClientMsg["type"]> = new Set(["fire", "set", "answer"]);

// plain CBOR maps as objects, none of cbor-x's own record extension, so Rust reads it
const cbor = { encoder: new Encoder({ useRecords: false }), decoder: new Decoder({ mapsAsObjects: true, useRecords: false }) };

let socket: WebSocket | null = null;
let beat: number | undefined;
let retry: number | undefined;
let tries = 0;

interface Channels {
  pc: RTCPeerConnection;
  reliable: RTCDataChannel;
  bestEffort: RTCDataChannel;
}

let channels: Channels | null = null;
let channelsRetry: number | undefined;
let channelsTries = 0;

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
    beat = window.setInterval(() => send({ type: "ping", t: performance.now() }), ROUND_TRIP_EVERY_MS);
    channelsTries = 0;
    void openChannels();
  };
  ws.onmessage = (e) => heard(e.data as ArrayBuffer);
  ws.onclose = () => {
    clearInterval(beat);
    socket = null;
    closeChannels();
    setState({ link: "closed", rttMs: null });
    retry = window.setTimeout(connect, Math.min(RETRY_MAX_MS, 200 * 2 ** tries++));
  };
}

function heard(data: ArrayBuffer) {
  const msg = cbor.decoder.decode(new Uint8Array(data)) as ServerMsg;
  if (msg.type === "pong") {
    const rtt = performance.now() - msg.t;
    setState("rttMs", state.rttMs === null ? rtt : state.rttMs * 0.8 + rtt * 0.2);
  } else if (msg.type === "channels") {
    answered(msg.answer);
  } else {
    receive(msg);
  }
}

/** Sends at once, true when it went. Without a link nothing can be done, so the person hears
 *  it was not. */
export function send(msg: ClientMsg): boolean {
  if (state.channels && channels?.reliable.readyState === "open" && ON_CHANNEL.has(msg.type)) {
    channels.reliable.send(cbor.encoder.encode(msg));
    return true;
  }
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(cbor.encoder.encode(msg));
    return true;
  }
  if (msg.type !== "ping") notify("The HMI is out of reach, so that was not done.", "warn");
  return false;
}

/** Offers the data channels over the socket. They count once both are open. */
async function openChannels() {
  closeChannels();
  if (typeof RTCPeerConnection === "undefined" || state.link !== "open") return;
  const pc = new RTCPeerConnection();
  const c: Channels = {
    pc,
    reliable: pc.createDataChannel("reliable"),
    bestEffort: pc.createDataChannel("best-effort", { ordered: false, maxRetransmits: 0 }),
  };
  channels = c;
  for (const ch of [c.reliable, c.bestEffort]) {
    ch.binaryType = "arraybuffer";
    ch.onmessage = (e) => heard(e.data as ArrayBuffer);
    ch.onopen = () => {
      if (channels === c && c.reliable.readyState === "open" && c.bestEffort.readyState === "open") {
        channelsTries = 0;
        // the backend holds what the channel brings until this, so the socket's come first
        send({ type: "on_channels" });
        setState("channels", true);
      }
    };
    ch.onclose = () => {
      if (channels === c) channelsFailed();
    };
  }
  pc.onconnectionstatechange = () => {
    if (channels === c && pc.connectionState === "failed") channelsFailed();
  };
  window.setTimeout(() => {
    if (channels === c && !state.channels) channelsFailed();
  }, CHANNELS_WAIT_MS);
  await pc.setLocalDescription(await pc.createOffer());
  // a later offer or the socket's close replaced this one while it was made
  if (channels === c && pc.localDescription) send({ type: "channels", offer: pc.localDescription.sdp });
}

/** The backend's answer completes the offer. Without one the backend cannot make channels, so
 *  the screen stays on its socket until it connects again. */
function answered(answer: string | null) {
  const c = channels;
  if (!c) return;
  if (answer === null) closeChannels();
  else if (c.pc.signalingState === "have-local-offer") void c.pc.setRemoteDescription({ type: "answer", sdp: answer });
}

function closeChannels() {
  clearTimeout(channelsRetry);
  const c = channels;
  channels = null;
  c?.pc.close();
  setState("channels", false);
}

/** The channels closed while the socket stays, so they are offered again a while later. */
function channelsFailed() {
  closeChannels();
  if (state.link !== "open") return;
  channelsRetry = window.setTimeout(() => void openChannels(), Math.min(CHANNELS_RETRY_MAX_MS, CHANNELS_RETRY_MS * 2 ** channelsTries++));
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !socket) connect();
});

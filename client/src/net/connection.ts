// The link to the backend: one socket, CBOR both ways, and a WebRTC data connection offered
// over it: a reliable ordered channel, a best effort one, and the video of each import the
// screen plays, which plays on a plain http page where WebCodecs cannot. The socket carries
// everything the channels do not, and reconnects by itself, at once when the page shows again.
// The round trip for the status bar is timed the way a person's actions go.

import { Decoder, Encoder } from "cbor-x";
import { type Accessor, createSignal, type Setter } from "solid-js";
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
/** A ping on the channels unanswered this long means they broke, so the socket takes over. */
const CHANNELS_SILENT_MS = 1000;

/** What a person does on a running page, which goes on the reliable channel while it is open,
 *  and the ping that times it. */
const ON_CHANNEL: ReadonlySet<ClientMsg["type"]> = new Set(["fire", "set", "answer", "ping"]);

// cbor-x reads this option and its README names it, but its types leave it out
declare module "cbor-x" {
  interface Options {
    int64AsNumber?: boolean;
  }
}

// plain CBOR maps as objects, none of cbor-x's own record extension, so Rust reads it, and a
// 64 bit integer, as a Timestamp is, a number the page's math can add, never a BigInt
const cbor = { encoder: new Encoder({ useRecords: false }), decoder: new Decoder({ mapsAsObjects: true, useRecords: false, int64AsNumber: true }) };

let socket: WebSocket | null = null;
let beat: number | undefined;
let retry: number | undefined;
let tries = 0;

interface Channels {
  pc: RTCPeerConnection;
  reliable: RTCDataChannel;
  bestEffort: RTCDataChannel;
  /** An offer is out, so a change to the videos waits for its answer. */
  offering: boolean;
  /** The videos changed while an offer was out. */
  again: boolean;
}

interface Video {
  users: number;
  stream: Accessor<MediaStream | null>;
  setStream: Setter<MediaStream | null>;
  /** Where it comes in on the data connection, once offered there. */
  transceiver: RTCRtpTransceiver | null;
}

/** The imports whose video this screen plays, each shared by every element showing it. */
const videos = new Map<string, Video>();

let channels: Channels | null = null;
let channelsRetry: number | undefined;
let channelsTries = 0;
/** When the oldest ping on the channels still unanswered went. */
let unanswered: number | null = null;
/** The last round trip timed, which the next ping tells the backend. */
let timed: number | undefined;

export function connect() {
  if (socket) return;
  clearTimeout(retry);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  socket = ws;
  parts.clear();
  setState("link", "connecting");
  ws.onopen = () => {
    tries = 0;
    setState("link", "open");
    beat = window.setInterval(ping, ROUND_TRIP_EVERY_MS);
    channelsTries = 0;
    void openChannels();
  };
  ws.onmessage = (e) => joined(e.data as ArrayBuffer);
  ws.onclose = () => {
    clearInterval(beat);
    socket = null;
    closeChannels();
    setState({ link: "closed", rttMs: null });
    retry = window.setTimeout(connect, Math.min(RETRY_MAX_MS, 200 * 2 ** tries++));
  };
}

/** The pieces of each lane's message so far. The socket brings each message in pieces,
 *  `[u16 lane][u8 more]` then its share, the lanes taking turns as the backend's lanes.rs
 *  sends them, so a small message never waits behind a whole picture. */
const parts = new Map<number, Uint8Array[]>();

function joined(data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  const lane = bytes[0] | (bytes[1] << 8);
  const piece = bytes.subarray(3);
  const before = parts.get(lane);
  if (bytes[2] === 1) {
    if (before) before.push(piece);
    else parts.set(lane, [piece]);
    return;
  }
  if (!before) return heard(piece);
  parts.delete(lane);
  const whole = new Uint8Array(before.reduce((n, p) => n + p.length, piece.length));
  let at = 0;
  for (const p of [...before, piece]) {
    whole.set(p, at);
    at += p.length;
  }
  heard(whole);
}

function heard(bytes: Uint8Array) {
  const msg = cbor.decoder.decode(bytes) as ServerMsg;
  if (msg.type === "pong") {
    const rtt = performance.now() - msg.t;
    timed = rtt;
    if (unanswered !== null && msg.t >= unanswered) unanswered = null;
    setState("rttMs", state.rttMs === null ? rtt : state.rttMs * 0.8 + rtt * 0.2);
  } else if (msg.type === "channels") {
    answered(msg.answer);
  } else {
    receive(msg);
  }
}

function ping() {
  const t = performance.now();
  if (state.channels && unanswered !== null && t - unanswered > CHANNELS_SILENT_MS) channelsFailed();
  if (state.channels) unanswered ??= t;
  send({ type: "ping", t, rtt: timed });
  timed = undefined;
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
    offering: false,
    again: videos.size > 0,
  };
  channels = c;
  for (const ch of [c.reliable, c.bestEffort]) {
    ch.binaryType = "arraybuffer";
    ch.onmessage = (e) => heard(new Uint8Array(e.data as ArrayBuffer));
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
  await offer(c, (sdp) => ({ type: "channels", offer: sdp }));
}

/** Offers the data connection again with the videos this screen plays now. A new video gets
 *  its transceiver here, and a stopped one's stopped with it. */
async function offerVideos() {
  const c = channels;
  if (!c) return;
  if (c.offering) {
    c.again = true;
    return;
  }
  c.again = false;
  for (const v of videos.values()) {
    if (v.transceiver) continue;
    v.transceiver = c.pc.addTransceiver("video", { direction: "recvonly" });
    v.setStream(new MediaStream([v.transceiver.receiver.track]));
  }
  // a transceiver has its mid once the offer is set
  await offer(c, (sdp) => ({
    type: "play",
    offer: sdp,
    videos: [...videos].flatMap(([alias, v]) => (v.transceiver?.mid ? [{ mid: v.transceiver.mid, alias }] : [])),
  }));
}

/** Makes an offer on the connection and sends it, unless the connection closed while it was
 *  made. The next offer waits for its answer. */
async function offer(c: Channels, msg: (sdp: string) => ClientMsg) {
  c.offering = true;
  try {
    await c.pc.setLocalDescription(await c.pc.createOffer());
  } catch (e) {
    if (channels === c) throw e;
    return;
  }
  if (channels === c && c.pc.localDescription) send(msg(c.pc.localDescription.sdp));
}

/** The backend's answer completes the offer. Without one to the first the backend cannot make
 *  channels, so the screen stays on its socket until it connects again. Without one to a later
 *  offer the connection is gone, so it is made again. */
function answered(answer: string | null) {
  const c = channels;
  if (!c) return;
  if (answer === null) return c.pc.remoteDescription ? channelsFailed() : closeChannels();
  if (c.pc.signalingState !== "have-local-offer") return;
  c.pc.setRemoteDescription({ type: "answer", sdp: answer }).then(
    () => {
      c.offering = false;
      if (channels === c && c.again) void offerVideos();
    },
    () => channels === c && channelsFailed(),
  );
}

/** Starts or joins playing an import's video, which comes once the data connection is open. */
export function play(alias: string): Accessor<MediaStream | null> {
  let v = videos.get(alias);
  if (!v) {
    const [stream, setStream] = createSignal<MediaStream | null>(null);
    v = { users: 0, stream, setStream, transceiver: null };
    videos.set(alias, v);
    void offerVideos();
  }
  v.users++;
  return v.stream;
}

/** Leaves playing an import's video, which ends once nothing on this screen shows it. */
export function stopPlaying(alias: string) {
  const v = videos.get(alias);
  if (!v || --v.users > 0) return;
  videos.delete(alias);
  if (!v.transceiver) return;
  v.transceiver.stop();
  void offerVideos();
}

/** Ends the data connection, and with it every video this screen plays until it opens again. */
function closeChannels() {
  clearTimeout(channelsRetry);
  const c = channels;
  channels = null;
  unanswered = null;
  c?.pc.close();
  for (const v of videos.values()) {
    v.transceiver = null;
    v.setStream(null);
  }
  setState("channels", false);
}

/** The channels broke while the socket stays, so the backend hears it there at once, and they
 *  are offered again a while later. */
function channelsFailed() {
  const used = state.channels;
  closeChannels();
  if (state.link !== "open") return;
  if (used) send({ type: "off_channels" });
  channelsRetry = window.setTimeout(() => void openChannels(), Math.min(CHANNELS_RETRY_MAX_MS, CHANNELS_RETRY_MS * 2 ** channelsTries++));
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !socket) connect();
});

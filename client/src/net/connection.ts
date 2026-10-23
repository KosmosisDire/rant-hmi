// The link to the backend: one socket, or in rant-hmi-app the window's own link (link.ts), CBOR
// both ways, and over a network a WebRTC data connection offered over it: a reliable ordered
// channel, a reliable unordered one for small messages, which never wait behind a big one, a
// best effort one, and the video of each import the screen plays, which plays on a plain http
// page where WebCodecs cannot. The link carries everything the channels do not, a
// video's frames too while WebRTC brings none, and reconnects by itself, at once when the page
// shows again. The round trip for the status bar is timed the way a person's actions go.

import { Decoder, Encoder } from "cbor-x";
import { type Accessor, createSignal, type Setter, untrack } from "solid-js";
import type { ClientMsg } from "../protocol/ClientMsg";
import type { ServerMsg } from "../protocol/ServerMsg";
import { cameBack, notify, receive, setState, state } from "../state/store";
import { decodes, Decoded } from "./decode";
import { type Link, openLink } from "./link";
import { readPacked } from "./packed";

/** 20 times a second, so the round trip shown is a fresh one. */
const ROUND_TRIP_EVERY_MS = 50;
const RETRY_MAX_MS = 2000;
/** How long the channels may take to open, and to answer their first ping, before they count
 *  as failed. */
const CHANNELS_WAIT_MS = 10_000;
/** Failed channels are offered again after this, doubling each time up to a minute. */
const CHANNELS_RETRY_MS = 2000;
const CHANNELS_RETRY_MAX_MS = 60_000;
/** A ping on the channels unanswered this long, once one was answered, means they broke, so
 *  the link takes over. */
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
readPacked();
const cbor = { encoder: new Encoder({ useRecords: false }), decoder: new Decoder({ mapsAsObjects: true, useRecords: false, int64AsNumber: true }) };

let link: Link | null = null;
let beat: number | undefined;
let retry: number | undefined;
let tries = 0;

interface Channels {
  pc: RTCPeerConnection;
  reliable: RTCDataChannel;
  small: RTCDataChannel;
  bestEffort: RTCDataChannel;
  /** An offer is out, so a change to the videos waits for its answer. */
  offering: boolean;
  /** The videos changed while an offer was out. */
  again: boolean;
}

/** A video as an element shows it: the stream WebRTC brings, and the frames from the link
 *  decoded here while WebRTC brings none. */
export interface Playing {
  stream: Accessor<MediaStream | null>;
  decoded: Accessor<Decoded | null>;
}

interface Video extends Playing {
  users: number;
  setStream: Setter<MediaStream | null>;
  setDecoded: Setter<Decoded | null>;
  /** Where it comes in on the data connection, once offered there. */
  transceiver: RTCRtpTransceiver | null;
  /** Its frames come over WebRTC, so the link need not bring them. */
  live: boolean;
}

/** The imports whose video this screen plays, each shared by every element showing it. */
const videos = new Map<string, Video>();

let channels: Channels | null = null;
let channelsRetry: number | undefined;
let channelsTries = 0;
/** When the oldest ping on the channels still unanswered went, and whether one was answered
 *  since they opened. Until one is, its answer waits for the switch, which goes on the link. */
let unanswered: number | null = null;
let answeredThere = false;
/** The last round trip timed, which the next ping tells the backend. */
let timed: number | undefined;
/** The videos whose frames the link brings, as last asked. */
let asked = "";
/** WebRTC did not open, or broke, and has not opened again since. */
const [stuck, setStuck] = createSignal(false);

export function connect() {
  if (link) return;
  clearTimeout(retry);
  setState("link", "connecting");
  link = openLink({
    opened() {
      tries = 0;
      setState("link", "open");
      beat = window.setInterval(ping, ROUND_TRIP_EVERY_MS);
    },
    heard: joiner(),
    closed() {
      clearInterval(beat);
      link = null;
      closeChannels();
      setState({ link: "closed", rttMs: null });
      retry = window.setTimeout(connect, Math.min(RETRY_MAX_MS, 200 * 2 ** tries++));
    },
  });
}

/** Joins what the link or the reliable channel brings into messages. Each comes in pieces,
 *  `[u16 lane][u8 more]` then its share, the lanes taking turns as the backend's lanes.rs
 *  sends them, so a small message never waits behind a whole picture. */
function joiner(): (data: ArrayBuffer) => void {
  const parts = new Map<number, Uint8Array[]>();
  return (data) => {
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
  };
}

function heard(bytes: Uint8Array) {
  const msg = cbor.decoder.decode(bytes) as ServerMsg;
  if (msg.type === "frame") {
    videos.get(msg.alias)?.decoded()?.feed(msg);
  } else if (msg.type === "pong") {
    const rtt = performance.now() - msg.t;
    timed = rtt;
    if (unanswered !== null && msg.t >= unanswered) {
      unanswered = null;
      answeredThere = true;
    }
    setState("rttMs", state.rttMs === null ? rtt : state.rttMs * 0.8 + rtt * 0.2);
    cameBack(msg.t);
  } else if (msg.type === "channels") {
    answered(msg.answer);
  } else if (msg.type === "candidate") {
    // one for an earlier connection, which this one cannot take, is left
    channels?.pc.addIceCandidate({ candidate: msg.candidate, sdpMLineIndex: 0 }).catch(() => {});
  } else {
    receive(msg);
    // the hello names the servers the channels find their way through, and starts a session
    // that has asked for no frames yet
    if (msg.type === "hello") {
      asked = "";
      askFrames();
      channelsTries = 0;
      void openChannels();
    }
  }
}

function ping() {
  const t = performance.now();
  const silent = answeredThere ? CHANNELS_SILENT_MS : CHANNELS_WAIT_MS;
  if (state.channels && unanswered !== null && t - unanswered > silent) channelsFailed();
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
  if (link?.send(cbor.encoder.encode(msg))) return true;
  if (msg.type !== "ping") notify("The HMI is out of reach, so that was not done.", "warn");
  return false;
}

/** Offers the data channels over the link, where a network lies under it. They count once all
 *  are open. */
async function openChannels() {
  closeChannels();
  if (state.link !== "open" || !link?.network) return;
  if (typeof RTCPeerConnection === "undefined") return setStuck(true);
  // the null the backend sends for no username would reach the browser as the word null
  const iceServers = (state.project?.ice ?? []).map(({ urls, username, credential }) => (username == null ? { urls } : { urls, username, credential: credential ?? "" }));
  const pc = new RTCPeerConnection({ iceServers });
  const c: Channels = {
    pc,
    reliable: pc.createDataChannel("reliable"),
    small: pc.createDataChannel("small", { ordered: false }),
    bestEffort: pc.createDataChannel("best-effort", { ordered: false, maxRetransmits: 0 }),
    offering: false,
    again: videos.size > 0,
  };
  channels = c;
  const join = joiner();
  c.reliable.onmessage = (e) => join(e.data as ArrayBuffer);
  c.small.onmessage = c.bestEffort.onmessage = (e) => heard(new Uint8Array(e.data as ArrayBuffer));
  const all = [c.reliable, c.small, c.bestEffort];
  for (const ch of all) {
    ch.binaryType = "arraybuffer";
    ch.onopen = () => {
      if (channels === c && all.every((a) => a.readyState === "open")) {
        channelsTries = 0;
        setStuck(false);
        // the backend holds what the channel brings until this, so the link's come first
        send({ type: "on_channels" });
        setState("channels", true);
      }
    };
    ch.onclose = () => {
      if (channels === c) channelsFailed();
    };
  }
  pc.onicecandidate = (e) => {
    if (channels === c && e.candidate?.candidate) send({ type: "candidate", candidate: e.candidate.candidate });
  };
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
    const track = v.transceiver.receiver.track;
    v.setStream(new MediaStream([track]));
    // a track unmutes as its first frames come, which the backend starts at a keyframe
    track.onunmute = track.onmute = () => {
      if (v.transceiver?.receiver.track !== track) return;
      v.live = !track.muted;
      askFrames();
    };
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
 *  channels, so the screen stays on its link until it connects again. Without one to a later
 *  offer the connection is gone, so it is made again. */
function answered(answer: string | null) {
  const c = channels;
  if (!c) return;
  if (answer === null) {
    if (c.pc.remoteDescription) return channelsFailed();
    closeChannels();
    return setStuck(true);
  }
  if (c.pc.signalingState !== "have-local-offer") return;
  c.pc.setRemoteDescription({ type: "answer", sdp: answer }).then(
    () => {
      c.offering = false;
      if (channels === c && c.again) void offerVideos();
    },
    () => channels === c && channelsFailed(),
  );
}

/** Starts or joins playing an import's video, over WebRTC once the data connection is open,
 *  and from frames on the link until WebRTC brings it. An effect calls it, so it tracks none
 *  of what it reads: its decoder, set here, would run that effect again, and stop it. */
export function play(alias: string): Playing {
  return untrack(() => {
    let v = videos.get(alias);
    if (!v) {
      const [stream, setStream] = createSignal<MediaStream | null>(null);
      const [decoded, setDecoded] = createSignal<Decoded | null>(null);
      v = { users: 0, stream, setStream, decoded, setDecoded, transceiver: null, live: false };
      videos.set(alias, v);
      askFrames();
      void offerVideos();
    }
    v.users++;
    return v;
  });
}

/** Leaves playing an import's video, which ends once nothing on this screen shows it. */
export function stopPlaying(alias: string) {
  untrack(() => {
    const v = videos.get(alias);
    if (!v || --v.users > 0) return;
    videos.delete(alias);
    v.decoded()?.close();
    askFrames();
    if (!v.transceiver) return;
    v.transceiver.stop();
    void offerVideos();
  });
}

/** Asks the link for the frames of each video WebRTC does not bring, where this page can
 *  decode them, and decodes them. */
function askFrames() {
  const aliases = decodes ? [...videos].flatMap(([alias, v]) => (v.live ? [] : [alias])).sort() : [];
  for (const [alias, v] of videos) {
    const wanted = aliases.includes(alias);
    if (wanted && !v.decoded()) v.setDecoded(new Decoded());
    if (!wanted && v.decoded()) {
      v.decoded()?.close();
      v.setDecoded(null);
    }
  }
  const key = aliases.join("\n");
  if (key === asked || state.link !== "open") return;
  asked = key;
  send({ type: "frames", aliases });
}

/** Why this screen shows no video, or null while it does or may yet: WebRTC did not open, and
 *  the page cannot decode video without it. */
export function unplayable(): string | null {
  if (decodes || !stuck()) return null;
  return window.isSecureContext ? "WebRTC did not connect, and this browser cannot decode video without it" : "WebRTC did not connect, and video without it needs this page on https";
}

/** Ends the data connection, and with it every video this screen plays until it opens again. */
function closeChannels() {
  clearTimeout(channelsRetry);
  const c = channels;
  channels = null;
  unanswered = null;
  answeredThere = false;
  c?.pc.close();
  for (const v of videos.values()) {
    v.transceiver = null;
    v.setStream(null);
    v.live = false;
  }
  askFrames();
  setState("channels", false);
}

/** The channels broke while the link stays, so the backend hears it there at once, and they
 *  are offered again a while later. */
function channelsFailed() {
  const used = state.channels;
  closeChannels();
  setStuck(true);
  if (state.link !== "open") return;
  if (used) send({ type: "off_channels" });
  channelsRetry = window.setTimeout(() => void openChannels(), Math.min(CHANNELS_RETRY_MAX_MS, CHANNELS_RETRY_MS * 2 ** channelsTries++));
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !link) connect();
});

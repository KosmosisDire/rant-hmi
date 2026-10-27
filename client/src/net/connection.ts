// The link to the backend: one socket, or in rant-hmi-app the window's own link (link.ts), CBOR
// both ways. Small values, pongs and everything not values come on it and are read here. Big
// values come on a second way the data worker opens, WebTransport on https where it opens and
// else a second socket, or on the link while it has none. The worker reads them either way
// (data.worker.ts), so the main thread never unpacks one, and draws the scenes. Each big value
// is said to be taken once it is shown, so the next comes only then. A WebRTC
// connection opens beside the link once the screen plays a video, which it brings where WebCodecs
// cannot decode the video's frames from the link. It opens at once, and its `link` channel
// carries what the link did once the backend switches to it, big values too, as that way is
// direct where the link may come through a proxy. The link reconnects by itself, at once when
// the page shows again. The round trip for the status bar is timed the way a person's actions
// and the values go, on the link channel once it carries them.

import { Decoder, Encoder } from "cbor-x";
import { type Accessor, createEffect, createRoot, createSignal, on, type Setter, untrack } from "solid-js";
import { unwrap } from "solid-js/store";
import type { ClientMsg } from "../protocol/ClientMsg";
import type { ServerMsg } from "../protocol/ServerMsg";
import { faultOf } from "../state/caught";
import { operator } from "../state/mode";
import { problems, report } from "../state/problems";
import { cameBack, notify, onReading, receive, setState, state, type WebrtcProblem } from "../state/store";
import { countRead, previewing, watched, wholeNames } from "../state/watch";
import type { FromData, Second, ToData } from "./data.worker";
import type { Drawing, Drew } from "./draw";
import { decodes, Decoded } from "./decode";
import { inApp, type Link, openLink } from "./link";
import { readPacked, revive } from "./packed";
import { BIG, joiner, own } from "./pieces";

/** 20 times a second, so the round trip shown is a fresh one. */
const ROUND_TRIP_EVERY_MS = 50;
/** How often this screen's problems may go, so a fault that comes each frame is one send. */
const PROBLEMS_EVERY_MS = 250;
const RETRY_MAX_MS = 2000;
/** How long the WebRTC connection may take to answer and connect before it counts as failed. */
const RTC_WAIT_MS = 10_000;
/** A failed WebRTC connection is offered again after this, doubling each time up to a minute,
 *  as is a second way that closed. */
const RETRY_LATER_MS = 2000;
const RETRY_LATER_MAX_MS = 60_000;

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

/** The data worker, made once, and the second way it should have, how often it failed, and when
 *  it is tried again. */
const data = new Worker(new URL("./data.worker.ts", import.meta.url), { type: "module" });
// the worker tells its own faults, so one heard here is the worker failing to run at all
data.onerror = (e) => report(faultOf([`the data worker failed: ${e.message || "its script did not load"}`]));
let second: Second | null = null;
let secondTries = 0;
/** The link's session, from its hello, null while it has none. */
let session: number | null = null;
let secondRetry: number | undefined;
/** The second way the hello named, which the link channel stands in for while it carries all. */
let secondNamed: Second | null = null;

/** The WebRTC link channel, what it brought before the backend's marker on the link, held so
 *  nothing comes out of turn, and whether the screen sends on it. */
let channel: RTCDataChannel | null = null;
let early: ArrayBuffer[] | null = null;
let switched = false;

interface Rtc {
  pc: RTCPeerConnection;
  /** An offer is out, so a change to the videos waits for its answer. */
  offering: boolean;
  /** The videos changed while an offer was out. */
  again: boolean;
  /** The UDP addresses it gathered, any and public, which say why it did not connect. */
  udp: number;
  public: number;
}

/** Why a WebRTC connection that did not connect failed, as the backend names it (status.rs). */
function diagnose(c: Rtc | null): WebrtcProblem {
  if (typeof RTCPeerConnection === "undefined") return "no_webrtc";
  // a browser that gathered no address at all, not even its own, was told not to use UDP
  if (!c || c.udp === 0) return "browser_blocks";
  if (c.public === 0 && (state.project?.ice ?? []).length > 0) return "network_blocks_udp";
  return "no_path";
}

/** Says why this screen has no WebRTC, or with null that it has, once that changed, and to a
 *  new session whatever it is. */
function problem(p: WebrtcProblem | null, again = false) {
  if (p === state.webrtcProblem && !again) return;
  setState("webrtcProblem", p);
  send(p === null ? { type: "webrtc_problem" } : { type: "webrtc_problem", problem: p });
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
  /** Where it comes in on the WebRTC connection, once offered there. */
  transceiver: RTCRtpTransceiver | null;
  /** Its frames come over WebRTC, so the link need not bring them. */
  live: boolean;
}

/** The imports whose video this screen plays, each shared by every element showing it. */
const videos = new Map<string, Video>();

let rtc: Rtc | null = null;
let rtcRetry: number | undefined;
let rtcTries = 0;
/** The last round trip timed, which the next ping tells the backend. */
let timed: number | undefined;
/** The videos whose frames the link brings, and the names watched, as last told. */
let asked = "";
let toldWatch: string | undefined;
/** What the data worker was last told is read whole and shown. */
let toldData: string | undefined;
/** This screen's problems as the backend was last told them, and the telling that waits. */
let toldProblems: string | undefined;
let problemsDue: number | undefined;
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
    heard: joiner(heard),
    closed() {
      clearInterval(beat);
      link = null;
      session = null;
      closeRtc();
      openSecond(null);
      setState({ link: "closed", rttMs: null });
      retry = window.setTimeout(connect, Math.min(RETRY_MAX_MS, 200 * 2 ** tries++));
    },
  });
}

/** A message the link brought: a big value's, handed to the data worker unread, or any other,
 *  read here. */
function heard(bytes: Uint8Array, lane: number) {
  if (lane & BIG) {
    const message = own(bytes);
    return tell({ message }, [message]);
  }
  const msg = cbor.decoder.decode(bytes) as ServerMsg;
  if (msg.type === "frame") {
    videos.get(msg.alias)?.decoded()?.feed(msg);
  } else if (msg.type === "pong") {
    const rtt = performance.now() - msg.t;
    timed = rtt;
    pings.push(rtt);
    if (pings.length > 1000) pings.splice(0, pings.length - 1000);
    setState("rttMs", state.rttMs === null ? rtt : state.rttMs * 0.8 + rtt * 0.2);
    cameBack(msg.t);
  } else if (msg.type === "switched") {
    // the last on the link before the channel, so what the channel held comes next, and the
    // backend hears on the link, last, that what follows comes on the channel
    if (!channel || !early) return;
    const [held, join] = [early, joinChannel];
    early = null;
    for (const piece of held) join(piece);
    send({ type: "switch" });
    switched = true;
    setState("path", "channel");
    openSecond(null);
  } else if (msg.type === "video") {
    answered(msg.answer);
  } else if (msg.type === "candidate") {
    // one for an earlier connection, which this one cannot take, is left
    rtc?.pc.addIceCandidate({ candidate: msg.candidate, sdpMLineIndex: 0 }).catch(() => {});
  } else {
    receive(msg);
    // a new session has asked for no frames and watches nothing yet, and its big values come
    // on its own second way
    if (msg.type === "hello") {
      helloWt = msg.wt ?? null;
      asked = "";
      askFrames();
      toldWatch = undefined;
      tellWatch();
      toldProblems = undefined;
      tellProblems();
      secondTries = 0;
      session = msg.session;
      if (state.webrtcProblem) problem(state.webrtcProblem, true);
      const [secure, path] = [location.protocol === "https:", `/bulk?session=${msg.session}&key=${msg.key}`];
      const wt = secure && msg.wt ? { url: `https://${location.host}${path}`, hash: msg.wt } : undefined;
      // for comparing: a screen told hmi.noSecond = 1 takes its big values on the link
      let noSecond = false;
      try {
        noSecond = localStorage.getItem("hmi.noSecond") === "1";
      } catch {}
      secondNamed = inApp || noSecond ? null : { socket: `${secure ? "wss" : "ws"}://${location.host}${path}`, wt };
      openSecond(secondNamed);
      void offerVideos();
    }
  }
}

function tell(m: ToData, transfer: Transferable[] = []) {
  data.postMessage(m, transfer);
}

data.onmessage = (e: MessageEvent<FromData>) => {
  const d = e.data;
  if ("drew" in d) return drew(d.drew);
  if ("problem" in d) return report(d.problem);
  // read for a session before the link came again, whose batches count apart
  if (("msg" in d || "took" in d) && d.session !== session) return;
  if (!("msg" in d) && "took" in d) return void send(d.missed ? { type: "took", alias: d.took, seq: d.seq, missed: true } : { type: "took", alias: d.took, seq: d.seq });
  if ("open" in d) {
    setState("second", d.open);
    if (d.open) secondTries = 0;
    // a second way that closed while the link stays is opened again a while later
    else if (second !== null) secondRetry = window.setTimeout(() => openSecond(second), Math.min(RETRY_LATER_MAX_MS, RETRY_LATER_MS * 2 ** secondTries++));
    return;
  }
  const msg = revive(d.msg) as ServerMsg;
  receive(msg, d.far);
  // shown now, as the page draws what changed in the same task, so the next may come
  if (msg.type === "values") for (const alias of d.took) send({ type: "took", alias, seq: msg.seq });
};

/** Tells the scenes the data worker draws, handing over `transfer`. */
export function drawing(m: Drawing, transfer: Transferable[] = []) {
  tell({ draw: m }, transfer);
}

/** Hears what the scenes found. */
let drew: (d: Drew) => void = () => {};
export function onDrew(f: (d: Drew) => void) {
  drew = f;
}

/** Has the data worker open the screen's second way, or close it with null. */
function openSecond(to: Second | null) {
  clearTimeout(secondRetry);
  second = to;
  setState("second", null);
  tell({ second: to, session });
}

/** Tells the backend the names this screen shows, once they changed. */
function tellWatch() {
  if (state.link !== "open") return;
  const [names, previews] = [watched(), previewing()];
  const key = `${previews}${names === null ? "" : `\n${names.join("\n")}`}`;
  if (key === toldWatch) return;
  toldWatch = key;
  send({ type: "watch", names, previews });
}

/** Tells the backend this screen's problems once they changed, at most every PROBLEMS_EVERY_MS,
 *  and whether it shows every screen's, as the editor does. */
function tellProblems() {
  if (state.link !== "open" || problemsDue !== undefined) return;
  problemsDue = window.setTimeout(() => {
    problemsDue = undefined;
    if (state.link !== "open") return;
    const msg: ClientMsg = { type: "problems", problems: unwrap(problems), every: !operator };
    const key = JSON.stringify(msg);
    if (key === toldProblems) return;
    toldProblems = key;
    send(msg);
  }, PROBLEMS_EVERY_MS);
}
createRoot(() => createEffect(on(() => JSON.stringify(problems), tellProblems)));

/** Tells the data worker the names read whole and those shown, once they changed. */
function tellData() {
  const [whole, shown] = [wholeNames(), watched()];
  const key = JSON.stringify([whole, shown]);
  if (key === toldData) return;
  toldData = key;
  tell({ whole, watched: shown });
}

createRoot(() =>
  createEffect(() => {
    tellWatch();
    tellData();
  }),
);
// a name something drawn reads joins what the screen watches while it does, told once the
// drawing ends
let retell = false;
onReading((alias, whole) =>
  countRead(alias, whole, () => {
    if (retell) return;
    retell = true;
    queueMicrotask(() => {
      retell = false;
      tellWatch();
      tellData();
    });
  }),
);

function ping() {
  send({ type: "ping", t: performance.now(), rtt: timed });
  timed = undefined;
}

/** Sends at once, true when it went. Without a link nothing can be done, so the person hears
 *  it was not. */
/** The round trips of the link's last pings, as they came, for the probe. */
const pings: number[] = [];
let helloWt: string | null = null;
export const rawPings = () => pings;
/** The hash of the backend's WebTransport certificate, as its hello gave it. */
export const wtHash = () => helloWt;

// for the console: the WebRTC connection as it is, connected or not
(window as unknown as { hmiRtc: () => RTCPeerConnection | null }).hmiRtc = () => rtc?.pc ?? null;

/** The screen's WebRTC connection once it connected, offered now when it has none. */
export async function probeRtc(): Promise<RTCPeerConnection | null> {
  if (!rtc) void offerVideos();
  const c = rtc;
  if (!c) return null;
  for (let i = 0; i < 100 && c.pc.connectionState !== "connected"; i++) await new Promise((r) => setTimeout(r, 100));
  return c.pc.connectionState === "connected" ? c.pc : null;
}

export function send(msg: ClientMsg): boolean {
  if (switched && channel?.readyState === "open") {
    channel.send(cbor.encoder.encode(msg));
    return true;
  }
  if (link?.send(cbor.encoder.encode(msg))) return true;
  if (msg.type !== "ping" && msg.type !== "took" && msg.type !== "watch") notify("The HMI is out of reach, so that was not done.", "warn");
  return false;
}

/** Opens the WebRTC connection for this screen's videos, where a network lies under the link. */
function openRtc(): Rtc | null {
  if (rtc) return rtc;
  if (state.link !== "open" || !link?.network) return null;
  if (typeof RTCPeerConnection === "undefined") {
    setStuck(true);
    problem("no_webrtc");
    return null;
  }
  // the null the backend sends for no username would reach the browser as the word null
  const iceServers = (state.project?.ice ?? []).map(({ urls, username, credential }) => (username == null ? { urls } : { urls, username, credential: credential ?? "" }));
  const pc = new RTCPeerConnection({ iceServers });
  // a section that never plays, so an offer with every video stopped still bundles one, which
  // the backend needs, and the connection outlives a page without video
  pc.addTransceiver("video", { direction: "inactive" });
  // in the first offer, so later channels, the probe's too (probe.ts), open with no offer of
  // their own
  // for comparing: a screen told hmi.noChannel = 1 keeps all on its link
  let noChannel = false;
  try {
    noChannel = localStorage.getItem("hmi.noChannel") === "1";
  } catch {}
  const ch = pc.createDataChannel(noChannel ? "keep" : "link");
  ch.binaryType = "arraybuffer";
  [channel, early, switched] = [ch, [], false];
  joinChannel = joiner(heard);
  ch.onmessage = (e) => {
    if (channel !== ch) return;
    const bytes = new Uint8Array(e.data as ArrayBuffer);
    // a mark, `[u16 0xFFFF]` and the backend's ping, goes back at once as `[0xFF]` and the ping,
    // so the backend keeps on the way what arrives in a round trip (rtc.rs)
    if (bytes[0] === 0xff && bytes[1] === 0xff) {
      const back = new Uint8Array(bytes.length - 1);
      back[0] = 0xff;
      back.set(bytes.subarray(2), 1);
      return ch.send(back);
    }
    if (early) early.push(e.data as ArrayBuffer);
    else joinChannel(e.data as ArrayBuffer);
  };
  ch.onclose = () => channel === ch && channelLost();
  const c: Rtc = { pc, offering: false, again: false, udp: 0, public: 0 };
  rtc = c;
  pc.onicecandidate = (e) => {
    const line = e.candidate?.candidate;
    if (rtc !== c || !line) return;
    if (/ udp /i.test(line)) c.udp++;
    if (/ typ (srflx|relay) /.test(line)) c.public++;
    send({ type: "candidate", candidate: line });
  };
  pc.onconnectionstatechange = () => {
    if (rtc !== c) return;
    if (pc.connectionState === "connected") {
      rtcTries = 0;
      setStuck(false);
      setState("webrtc", true);
      problem(null);
    }
    if (pc.connectionState === "failed") rtcFailed();
  };
  window.setTimeout(() => {
    if (rtc === c && pc.connectionState !== "connected") rtcFailed();
  }, RTC_WAIT_MS);
  return c;
}

/** Offers the WebRTC connection with the videos this screen plays now, opening it for the first.
 *  A new video gets its transceiver here, and a stopped one's stopped with it. */
async function offerVideos() {
  const c = openRtc();
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
  c.offering = true;
  try {
    await c.pc.setLocalDescription(await c.pc.createOffer());
  } catch (e) {
    if (rtc === c) throw e;
    return;
  }
  // a transceiver has its mid once the offer is set
  if (rtc === c && c.pc.localDescription)
    send({ type: "play", offer: c.pc.localDescription.sdp, videos: [...videos].flatMap(([alias, v]) => (v.transceiver?.mid ? [{ mid: v.transceiver.mid, alias }] : [])) });
}

/** The backend's answer completes the offer. Without one the connection cannot carry video, so
 *  it is made again later. */
function answered(answer: string | null) {
  const c = rtc;
  if (!c) return;
  if (answer === null) return rtcFailed();
  if (c.pc.signalingState !== "have-local-offer") return;
  c.pc.setRemoteDescription({ type: "answer", sdp: answer }).then(
    () => {
      c.offering = false;
      if (rtc === c && c.again) void offerVideos();
    },
    () => rtc === c && rtcFailed(),
  );
}

/** Starts or joins playing an import's video, over WebRTC once it connects, and from frames on
 *  the link until WebRTC brings it. An effect calls it, so it tracks none of what it reads: its
 *  decoder, set here, would run that effect again, and stop it. */
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

/** Joins what the link channel brings, as the link's own joiner does what it brings. */
let joinChannel: (data: ArrayBuffer) => void = () => {};

/** The link channel closed, so the link carries all again, and the second way the big values. */
function channelLost() {
  const was = switched;
  [channel, early, switched] = [null, null, false];
  setState("path", "socket");
  if (!was || state.link !== "open") return;
  // the backend hears at once, so it sends on the socket again and every value anew
  send({ type: "unswitch" });
  openSecond(secondNamed);
}

/** Ends the WebRTC connection, and with it every video this screen plays until it opens again. */
function closeRtc() {
  clearTimeout(rtcRetry);
  if (channel) channelLost();
  const c = rtc;
  rtc = null;
  c?.pc.close();
  for (const v of videos.values()) {
    v.transceiver = null;
    v.setStream(null);
    v.live = false;
  }
  askFrames();
  setState("webrtc", false);
}

/** The WebRTC connection broke while the link stays, so it is offered again a while later. */
function rtcFailed() {
  const failed = rtc;
  closeRtc();
  setStuck(true);
  if (state.link !== "open") return;
  problem(diagnose(failed));
  rtcRetry = window.setTimeout(() => void offerVideos(), Math.min(RETRY_LATER_MAX_MS, RETRY_LATER_MS * 2 ** rtcTries++));
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !link) connect();
});

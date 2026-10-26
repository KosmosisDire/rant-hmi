// Times each way this page may reach the backend, apart from the screen's own traffic, as
// `await hmiProbe.run()` in the console: the screen's link as its pings go, a socket to the
// echo at /probe/ws, WebTransport to /probe on this page's host and straight to each address of
// the backend's host, and a WebRTC channel on the screen's connection. Each echoes small
// messages one after another, and reports the round trips of those that came back.

import { probeRtc, rawPings, wtHash } from "./connection";

interface Times {
  n: number;
  lost: number;
  min?: number;
  p50?: number;
  p90?: number;
  max?: number;
  error?: string;
}

/** A sender of one small message, and the next it hears, as a promise of its bytes. */
interface Echo {
  send(bytes: Uint8Array<ArrayBuffer>): void;
  next(): Promise<Uint8Array>;
  close(): void;
}

const ECHO_WAIT_MS = 1000;

function summary(rtts: number[], lost: number): Times {
  const s = [...rtts].sort((a, b) => a - b);
  const at = (q: number) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10;
  return s.length === 0 ? { n: 0, lost } : { n: s.length, lost, min: at(0), p50: at(0.5), p90: at(0.9), max: at(1) };
}

/** Messages heard in order, waited for one at a time. */
function inbox() {
  const heard: Uint8Array[] = [];
  let waiting: ((b: Uint8Array) => void) | null = null;
  return {
    put(b: Uint8Array) {
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(b);
      } else heard.push(b);
    },
    next: () => (heard.length > 0 ? Promise.resolve(heard.shift()!) : new Promise<Uint8Array>((r) => (waiting = r))),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => null)]);

/** Sends `count` numbered messages one after another, each once the last came back or was lost. */
async function time(echo: Echo, count: number, gapMs: number): Promise<Times> {
  const rtts: number[] = [];
  let lost = 0;
  for (let i = 0; i < count; i++) {
    const msg = new Uint8Array(8);
    new DataView(msg.buffer).setUint32(0, i);
    const t = performance.now();
    echo.send(msg);
    // a late echo of one counted lost is passed over
    for (;;) {
      const back = await timeout(echo.next(), ECHO_WAIT_MS - (performance.now() - t));
      if (back === null) {
        lost++;
        break;
      }
      if (new DataView(back.buffer, back.byteOffset).getUint32(0) === i) {
        rtts.push(performance.now() - t);
        break;
      }
    }
    await sleep(gapMs);
  }
  echo.close();
  return summary(rtts, lost);
}

async function socket(url: string): Promise<Echo> {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const box = inbox();
  ws.onmessage = (e) => box.put(new Uint8Array(e.data as ArrayBuffer));
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok();
    ws.onerror = () => fail(new Error("did not open"));
  });
  return { send: (b) => ws.send(b), next: box.next, close: () => ws.close() };
}

async function transport(url: string, hash: string, datagrams: boolean): Promise<Echo> {
  const bytes = new Uint8Array(hash.match(/../g)!.map((h) => parseInt(h, 16)));
  const wt = new WebTransport(url, { serverCertificateHashes: [{ algorithm: "sha-256", value: bytes }] });
  const opened = await timeout(wt.ready, 3000);
  if (opened === null) {
    wt.close();
    throw new Error("did not open in 3 s");
  }
  const box = inbox();
  if (datagrams) {
    const writer = wt.datagrams.writable.getWriter();
    void (async () => {
      const reader = wt.datagrams.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done || !value) return;
        box.put(value);
      }
    })();
    return { send: (b) => void writer.write(b), next: box.next, close: () => wt.close() };
  }
  const stream = await wt.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  void (async () => {
    const reader = stream.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !value) return;
      // an echo may come back joined with the next or split, which these 8 byte ones are not
      // at this rate, one at a time
      box.put(value);
    }
  })();
  return { send: (b) => void writer.write(b), next: box.next, close: () => wt.close() };
}

async function channel(ordered: boolean): Promise<Echo> {
  const pc = await probeRtc();
  if (!pc) throw new Error("this screen has no WebRTC connection");
  const ch = pc.createDataChannel(ordered ? "probe-reliable" : "probe", ordered ? {} : { ordered: false, maxRetransmits: 0 });
  ch.binaryType = "arraybuffer";
  const box = inbox();
  ch.onmessage = (e) => box.put(new Uint8Array(e.data as ArrayBuffer));
  const opened = await timeout(new Promise<void>((ok) => (ch.onopen = () => ok())), 5000);
  if (opened === null) {
    ch.close();
    throw new Error("the channel did not open in 5 s");
  }
  return { send: (b) => ch.send(b), next: box.next, close: () => ch.close() };
}

/** The candidate pair the WebRTC connection took, and ICE's own round trip on it. */
async function pair() {
  const pc = await probeRtc();
  if (!pc) return null;
  const stats = await pc.getStats();
  const all = new Map<string, Record<string, unknown>>();
  stats.forEach((s) => all.set(s.id, s as Record<string, unknown>));
  const chosen = [...all.values()].find((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
  if (!chosen) return null;
  const side = (id: unknown) => {
    const c = all.get(id as string);
    return c && `${c.candidateType} ${c.address ?? "?"}:${c.port} ${c.protocol}`;
  };
  return { local: side(chosen.localCandidateId), remote: side(chosen.remoteCandidateId), iceRttMs: typeof chosen.currentRoundTripTime === "number" ? chosen.currentRoundTripTime * 1000 : null };
}

async function attempt(make: () => Promise<Echo>, count: number, gapMs: number): Promise<Times> {
  try {
    return await time(await make(), count, gapMs);
  } catch (e) {
    return { n: 0, lost: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Times every way at once, `count` echoes each, `gapMs` apart. */
export async function run(count = 50, gapMs = 20) {
  const secure = location.protocol === "https:";
  const info = (await fetch("/probe/info").then((r) => r.json()).catch(() => ({ ips: [], port: 0 }))) as { ips: string[]; port: number };
  const hash = wtHash();
  const ways: Record<string, Promise<Times>> = {
    "socket /probe/ws": attempt(() => socket(`${secure ? "wss" : "ws"}://${location.host}/probe/ws`), count, gapMs),
    "webrtc unordered": attempt(() => channel(false), count, gapMs),
    "webrtc reliable": attempt(() => channel(true), count, gapMs),
  };
  if (typeof WebTransport === "undefined") ways["webtransport"] = Promise.resolve({ n: 0, lost: 0, error: "this browser has no WebTransport" });
  else if (!hash) ways["webtransport"] = Promise.resolve({ n: 0, lost: 0, error: "the hello named no WebTransport certificate" });
  else {
    if (secure) ways[`wt stream ${location.host}`] = attempt(() => transport(`https://${location.host}/probe`, hash, false), count, gapMs);
    for (const ip of info.ips) {
      ways[`wt datagram ${ip}`] = attempt(() => transport(`https://${ip}:${info.port}/probe`, hash, true), count, gapMs);
      ways[`wt stream ${ip}`] = attempt(() => transport(`https://${ip}:${info.port}/probe`, hash, false), count, gapMs);
    }
  }
  const before = rawPings().length;
  const results: Record<string, Times> = {};
  for (const [name, p] of Object.entries(ways)) results[name] = await p;
  const pings = rawPings();
  results["link, the screen's pings"] = summary(pings.slice(Math.max(0, before - count)), 0);
  return { page: location.host, webrtcPair: await pair().catch(() => null), results };
}

declare global {
  interface Window {
    hmiProbe: { run: typeof run };
  }
}
window.hmiProbe = { run };

// The screen's data worker: it brings the big values, on the screen's second way or handed on
// unread from its link, reads them off the main thread, and draws the screen's scenes
// (draw.ts). It keeps each value's lists of numbers, which a scene's points follow and the next
// value's changes apply to, and hands the main thread a list itself only where something there
// reads the value whole. Elsewhere a list goes as a far one, its length alone. A value is said
// to be taken once shown, by the main thread where that reads it whole, else by the scene that
// draws it, so the slower of the two holds back the next. The second way is WebTransport on a
// page over https, else a socket, or the socket where WebTransport fails.

import { Decoder, Encoder } from "cbor-x";
import { catchFaults, type Found } from "../state/caught";
import type { Drawing, Drew, Host } from "./draw";
import { buffers, Change, changed, type Column, readPackedPlain } from "./packed";
import { joiner, streams } from "./pieces";

/** The second way to open: the socket's address, and WebTransport's with its certificate's
 *  SHA-256 in hex, to try first. */
export interface Second {
  socket: string;
  wt?: { url: string; hash: string };
}

/** Which second way is open. */
export type Way = "socket" | "webtransport";

/** What the main thread tells the worker: the second way to open for the link's session, or
 *  none to close it, a big value's message the link brought, the imports read whole and those
 *  shown, or a scene's news. */
export type ToData = { second: Second | null; session: number | null } | { message: ArrayBuffer } | { whole: string[]; watched: string[] | null } | { draw: Drawing };

/** What the worker tells the main thread: a big value read with the imports that came far and
 *  those the main thread says it took, which second way is open, a value taken, or missed, to
 *  say so on the link, what a scene found, or a fault in the worker's own code. Each names the
 *  session it was read in, as one read before the link came again belongs to the last. */
type Said = { msg: unknown; far: string[]; took: string[] } | { open: Way | null } | { took: string; seq: number; missed?: boolean } | { drew: Drew } | { problem: Found };
export type FromData = Said & { session: number | null };

/** A value, and for one sent as the change from one held, that one's batch. */
type Update = { alias: string; value: unknown; known: boolean; base?: number };
type Values = { type: "values"; seq: number; values: Update[] };

readPackedPlain();
const decoder = new Decoder({ mapsAsObjects: true, useRecords: false, int64AsNumber: true });
const encoder = new Encoder({ useRecords: false });
/** The link's session the worker reads for now. */
let session: number | null = null;
const post = (m: Said, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage({ ...m, session }, transfer);

catchFaults((problem) => post({ problem }));
// told once, from here: an error left alone would reach the main thread a second time
addEventListener("error", (e) => e.preventDefault());

/** How long WebTransport may take to open before the socket is tried. */
const WT_WAIT_MS = 5000;

/** The second way as it opens, and once open how it says a value was taken. */
interface Opened {
  open: boolean;
  send(bytes: Uint8Array<ArrayBuffer>, failed: () => void): void;
  close(): void;
}
let way: Opened | null = null;
/** The imports something on the main thread reads whole, and those the screen shows, or null
 *  for every one. */
let whole = new Set<string>();
let watched: Set<string> | null = null;
/** Each import's newest value that holds lists, kept to hand on whole once that is asked, and
 *  the imports last handed on far. */
const kept = new Map<string, { seq: number; update: Update }>();
const farSent = new Set<string>();
/** Each import's newest batch handed on in this session, so one older, as one still on a way
 *  the screen let go may be, never follows it. */
const newest = new Map<string, number>();
/** Each list a kept value holds, by its ref: the import's alias, then the path to it. */
const held = new Map<string, Column>();

/** Whether `ref` is a list of import `alias`'s value. */
const under = (ref: string, alias: string) => ref === alias || ref.startsWith(`${alias}/`);

/** A list as `readPackedPlain` marks it. */
const marked = (v: unknown): v is { packed: Column } =>
  typeof v === "object" && v !== null && !ArrayBuffer.isView(v) && "packed" in v && Object.keys(v).length === 1;

/** Calls `each` with every marked list in `v` and its path, and with its bytes, as a cloud's,
 *  which a scene draws from too. */
function lists(v: unknown, path: string, each: (c: Column, ref: string, bytes: boolean) => void) {
  if (marked(v)) return each(v.packed, path, false);
  if (ArrayBuffer.isView(v)) return each(v as Uint8Array, path, true);
  if (typeof v !== "object" || v === null) return;
  for (const [k, x] of Object.entries(v)) lists(x, `${path}/${k}`, each);
}

const copied = (c: Column): Column => (ArrayBuffer.isView(c) ? c.slice() : Object.fromEntries(Object.entries(c).map(([k, x]) => [k, copied(x)])));
const sizeOf = (c: Column): number => (ArrayBuffer.isView(c) ? c.length : Object.values(c).map(sizeOf)[0] ?? 0);

/** `v` as the main thread gets it: each list a copy with its ref when `whole`, else far, and its
 *  bytes always a copy with their ref, as the kept value holds on to its own. */
function handed(v: unknown, path: string, isWhole: boolean): unknown {
  if (marked(v)) return isWhole ? { packed: copied(v.packed), ref: path } : { far: path, length: sizeOf(v.packed) };
  if (ArrayBuffer.isView(v)) return { bytes: (v as Uint8Array).slice(), ref: path };
  if (Array.isArray(v)) return v.map((x, i) => handed(x, `${path}/${i}`, isWhole));
  if (typeof v !== "object" || v === null) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, handed(x, `${path}/${k}`, isWhole)]));
}

/** A value sent as the change from the one held, its lists made from those held, or null when
 *  the worker no longer holds that one. */
function applied(u: Update): Update | null {
  const has = kept.get(u.alias)?.seq === u.base;
  let lacks = false;
  const made = (v: unknown, path: string): unknown => {
    if (v instanceof Change) {
      const base = has ? held.get(path) : undefined;
      try {
        if (base) return { packed: changed(base, v) };
      } catch (e) {
        console.warn(`a change to ${path} did not apply`, e);
      }
      lacks = true;
      return null;
    }
    if (typeof v !== "object" || v === null || ArrayBuffer.isView(v) || marked(v)) return v;
    if (Array.isArray(v)) return v.map((x, i) => made(x, `${path}/${i}`));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, made(x, `${path}/${k}`)]));
  };
  const value = made(u.value, u.alias);
  return lacks ? null : { alias: u.alias, value, known: u.known };
}

/** Hands a values message on, keeping each value that holds lists. One that is a change from a
 *  value no longer held is said to be missed, so it comes again whole. */
function values(msg: Values) {
  const [far, took]: string[][] = [[], []];
  const out: Update[] = [];
  for (const sent of msg.values) {
    // one the screen no longer shows was on its way as it said so, and the backend lets it go
    if (watched && !watched.has(sent.alias)) continue;
    if ((newest.get(sent.alias) ?? -1) > msg.seq) continue;
    const u = sent.base === undefined ? sent : applied(sent);
    if (!u) {
      host.took(sent.alias, msg.seq, true);
      continue;
    }
    newest.set(u.alias, msg.seq);
    for (const ref of held.keys()) if (under(ref, u.alias)) held.delete(ref);
    // a value of bytes and no lists goes whole as ever, its bytes kept for a scene to draw too
    let [holds, listed] = [false, false];
    lists(u.value, u.alias, (c, ref, bytes) => {
      held.set(ref, c);
      holds = true;
      listed ||= !bytes;
    });
    // one the main thread reads is taken there, as it may lag behind the scene that draws it
    const read = !listed || whole.has(u.alias);
    if (!scenes?.came(u.alias, read ? undefined : msg.seq) || read) took.push(u.alias);
    if (!holds) {
      kept.delete(u.alias);
      farSent.delete(u.alias);
      out.push(u);
      continue;
    }
    kept.set(u.alias, { seq: msg.seq, update: u });
    const isWhole = !listed || whole.has(u.alias);
    if (isWhole) farSent.delete(u.alias);
    else {
      farSent.add(u.alias);
      far.push(u.alias);
    }
    out.push({ ...u, value: handed(u.value, u.alias, isWhole) });
  }
  if (out.length === 0) return;
  const m = { ...msg, values: out };
  post({ msg: m, far, took }, buffers(m));
}

function read(bytes: Uint8Array) {
  let msg: unknown;
  try {
    msg = decoder.decode(bytes);
  } catch (e) {
    console.warn("a big value did not read", e);
    return;
  }
  if ((msg as Values | null)?.type === "values") return values(msg as Values);
  post({ msg, far: [], took: [] }, buffers(msg));
}

/** The imports read whole and those shown changed: a kept value handed on far goes again whole,
 *  and one no longer shown is let go. */
function reads(w: string[], shown: string[] | null) {
  whole = new Set(w);
  watched = shown && new Set(shown);
  for (const alias of [...kept.keys()]) {
    if (watched && !watched.has(alias)) {
      kept.delete(alias);
      farSent.delete(alias);
      for (const ref of held.keys()) if (under(ref, alias)) held.delete(ref);
      continue;
    }
    if (!whole.has(alias) || !farSent.has(alias)) continue;
    farSent.delete(alias);
    const { seq, update } = kept.get(alias)!;
    const m = { type: "values", seq, values: [{ ...update, value: handed(update.value, alias, true) }] };
    post({ msg: m, far: [], took: [] }, buffers(m));
  }
}

function open(second: Second | null) {
  const was = way;
  way = null;
  was?.close();
  if (second === null) return;
  if (second.wt && typeof WebTransport !== "undefined") openWt(second.wt, second.socket);
  else openSocket(second.socket);
}

function openSocket(url: string) {
  const s = new WebSocket(url);
  const w: Opened = {
    open: false,
    send: (bytes, failed) => (s.readyState === WebSocket.OPEN ? s.send(bytes) : failed()),
    close: () => {
      s.onclose = null;
      s.close();
    },
  };
  way = w;
  s.binaryType = "arraybuffer";
  // each socket joins its own pieces, so one that broke mid message leaves nothing behind
  const join = joiner((bytes) => read(bytes));
  s.onmessage = (e) => join(e.data as ArrayBuffer);
  s.onopen = () => {
    w.open = true;
    post({ open: "socket" });
  };
  s.onclose = () => {
    if (way !== w) return;
    way = null;
    post({ open: null });
  };
}

/** Opens WebTransport by its certificate's hash, or the socket at `socket` should it not open. */
function openWt(wt: { url: string; hash: string }, socket: string) {
  let t: WebTransport;
  try {
    const value = Uint8Array.from(wt.hash.match(/../g) ?? [], (h) => parseInt(h, 16));
    t = new WebTransport(wt.url, { serverCertificateHashes: [{ algorithm: "sha-256", value }] });
  } catch {
    return openSocket(socket);
  }
  const w: Opened = {
    open: false,
    send: (bytes, failed) => {
      t.createUnidirectionalStream()
        .then(async (s) => {
          const writer = s.getWriter();
          await writer.write(bytes);
          await writer.close();
        })
        .catch(failed);
    },
    close: () => t.close(),
  };
  way = w;
  const late = setTimeout(() => t.close(), WT_WAIT_MS);
  t.ready.then(
    () => {
      clearTimeout(late);
      if (way !== w) return;
      w.open = true;
      post({ open: "webtransport" });
      streams(t, read).catch(() => {});
    },
    () => {},
  );
  const closed = () => {
    clearTimeout(late);
    if (way !== w) return;
    way = null;
    if (w.open) post({ open: null });
    else openSocket(socket);
  };
  t.closed.then(closed, closed);
}

const host: Host = {
  post: (drew) => post({ drew }),
  column: (ref) => held.get(ref),
  value: (path) => {
    const [alias, ...keys] = path.split("/");
    let v = kept.get(alias)?.update.value;
    for (const k of keys) v = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined;
    return v;
  },
  // on the second way, or on the link while there is none
  took: (alias, seq, missed = false) => {
    const toLink = () => post({ took: alias, seq, missed });
    if (way?.open) way.send(encoder.encode(missed ? { type: "took", alias, seq, missed } : { type: "took", alias, seq }), toLink);
    else toLink();
  },
};

/** three.js loads only once the screen shows a scene, and what the page said meanwhile waits. */
let scenes: typeof import("./draw") | null = null;
let loading: Promise<void> | null = null;
const waiting: Drawing[] = [];
function draw(m: Drawing) {
  if (scenes) return scenes.hear(m);
  waiting.push(m);
  loading ??= import("./draw").then((d) => {
    d.start(host);
    scenes = d;
    for (const w of waiting.splice(0)) d.hear(w);
  });
}

self.onmessage = (e: MessageEvent<ToData>) => {
  const d = e.data;
  if ("second" in d) {
    // a new session counts its batches anew
    if (d.session !== session) newest.clear();
    session = d.session;
    open(d.second);
  }
  else if ("message" in d) read(new Uint8Array(d.message));
  else if ("whole" in d) reads(d.whole, d.watched);
  else draw(d.draw);
};

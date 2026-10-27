// What the backend told this screen, in one store, and the values beside it. Every server message
// lands through receive(), and reconcile keeps object identity so only what changed redraws.

import { batch, createSignal, type Signal, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { Way } from "../net/data.worker";
import { packed, samePacked } from "../net/packed";
import type { Computed } from "../protocol/Computed";
import type { EntityInfo } from "../protocol/EntityInfo";
import type { EnumInfo } from "../protocol/EnumInfo";
import type { Import } from "../protocol/Import";
import type { Page } from "../protocol/Page";
import type { Level } from "../protocol/Level";
import type { Value } from "../protocol/Value";
import type { PeerInfo } from "../protocol/PeerInfo";
import type { ProjectInfo } from "../protocol/ProjectInfo";
import type { Record as History } from "../protocol/Record";
import type { Sample } from "../protocol/Sample";
import type { ServerMsg } from "../protocol/ServerMsg";
import type { Rule } from "../protocol/Rule";
import type { Token } from "../protocol/Token";
import type { Variable } from "../protocol/Variable";
import { closeWith, follow, push } from "./stack";

export interface Live {
  value: Value | null;
  known: boolean;
}

export interface Refusal {
  text: string;
  alias: string | null;
}

export interface Notice {
  n: number;
  text: string;
  level: Level;
}

/** The batch each value last came in. A big value on the second way may pass a small one
 *  on the link, so a value never gives way to an older batch's. */
const batches = new Map<string, number>();

/** How long a notice stays, by how much it matters. */
const STAYS: Record<Level, number> = { info: 4000, warn: 7000, fault: 10000 };

/** Why a WebRTC connection did not open, as the backend names it (status.rs WEBRTC_PROBLEMS). */
export type WebrtcProblem = "no_webrtc" | "browser_blocks" | "network_blocks_udp" | "no_path";

export interface State {
  link: "connecting" | "open" | "closed";
  /** The smoothed round trip to the backend. */
  rttMs: number | null;
  /** Whether the WebRTC connection, which brings video, is open. */
  webrtc: boolean;
  /** The second way, which brings big values, while it is open. */
  second: Way | null;
  /** The way values, pings and actions go: the socket, or the WebRTC link channel. */
  path: "socket" | "channel";
  /** Why the WebRTC connection did not open, null while it did or has not failed. */
  webrtcProblem: WebrtcProblem | null;
  project: ProjectInfo | null;
  node: string;
  version: string;
  imports: Import[];
  variables: Variable[];
  /** Histories the backend samples, whose samples come as their values. */
  records: History[];
  /** Values the backend works out from others. */
  computed: Computed[];
  /** The mesh's enums code names, each by its type. */
  enums: EnumInfo[];
  /** The HMI's own handlers. */
  rules: Rule[];
  tokens: Token[];
  entities: EntityInfo[];
  peers: PeerInfo[];
  pages: Page[];
  /** What this screen's last edit made, to open or select. `n` counts, so the same id twice
   *  still reads as new. */
  made: { page: string; id: string; n: number } | null;
  refused: Refusal | null;
  /** What this screen should tell the person, newest last. */
  notices: Notice[];
}

export const [state, setState] = createStore<State>({
  link: "connecting",
  rttMs: null,
  webrtc: false,
  second: null,
  path: "socket",
  webrtcProblem: null,
  project: null,
  node: "",
  version: "",
  imports: [],
  variables: [],
  records: [],
  computed: [],
  enums: [],
  rules: [],
  tokens: [],
  entities: [],
  peers: [],
  pages: [],
  made: null,
  refused: null,
  notices: [],
});

/** Loads the client the backend serves when this screen runs another, as after an update.
 *  Only once per build, so a screen that still differs never reloads for ever. */
function catchUp(build: string) {
  const own = document.querySelector<HTMLScriptElement>('script[type="module"]')?.getAttribute("src") ?? "";
  if (!build || !own.startsWith("/assets/") || own === build) return;
  try {
    if (sessionStorage.getItem("rant-hmi.reloaded") === build) return;
    sessionStorage.setItem("rant-hmi.reloaded", build);
  } catch {
    return;
  }
  location.reload();
}

let notices = 0;

export function notify(text: string, level: Level) {
  const n = ++notices;
  setState("notices", (all) => [...all.slice(-4), { n, text, level }]);
  setTimeout(() => dismiss(n), STAYS[level]);
}

export function dismiss(n: number) {
  setState("notices", (all) => all.filter((x) => x.n !== n));
}

/** Takes a message from the backend. `far` names the imports whose values in it hold lists the
 *  data worker keeps. */
export function receive(msg: ServerMsg, far: readonly string[] = []) {
  switch (msg.type) {
    case "hello":
      batches.clear();
      setState({ project: msg.project, node: msg.node, version: msg.version });
      catchUp(msg.build);
      break;
    case "project":
      setState("project", msg.project);
      break;
    case "imports":
      setState("imports", reconcile(msg.imports, { key: "alias" }));
      break;
    case "theme":
      setState("tokens", reconcile(msg.tokens, { key: "name" }));
      break;
    case "rules":
      setState("rules", reconcile(msg.rules, { key: "id" }));
      break;
    case "variables":
      setState("variables", reconcile(msg.variables, { key: "name" }));
      break;
    case "computed":
      setState("computed", reconcile(msg.computed, { key: "name" }));
      break;
    case "enums":
      setState("enums", reconcile(msg.enums, { key: "name" }));
      break;
    case "records":
      setState("records", reconcile(msg.records, { key: "name" }));
      break;
    case "samples": {
      // a record's value is its samples, appended and pruned here as the backend keeps them
      const keep = (state.records.find((r) => r.name === msg.name)?.keep_s ?? 0) * 1000;
      const had = untrack(cell(values, msg.name)[0])?.value as Sample[] | undefined;
      if (msg.whole || !Array.isArray(had)) {
        give(msg.name, msg.samples as unknown as Value, true);
        break;
      }
      const all = [...had, ...msg.samples];
      const last = all[all.length - 1]?.t ?? 0;
      let old = 0;
      while (old < all.length && all[old].t < last - keep) old++;
      give(msg.name, all.slice(old) as unknown as Value, true);
      break;
    }
    case "mesh":
      setState("entities", reconcile(msg.entities, { key: "name" }));
      break;
    case "values":
      batch(() => {
        for (const u of msg.values) {
          if ((batches.get(u.alias) ?? 0) > msg.seq) continue;
          batches.set(u.alias, msg.seq);
          if (far.includes(u.alias)) kept.add(u.alias);
          else kept.delete(u.alias);
          give(u.alias, u.value, u.known);
          const p = untrack(cell(promised, u.alias)[0]);
          if (p && same(p.value, u.value)) settle(u.alias);
        }
      });
      break;
    case "health":
      setState("peers", reconcile(msg.peers, { key: "id" }));
      break;
    case "pages":
      setState("pages", reconcile(msg.pages, { key: "id" }));
      break;
    case "moved":
      // the page takes its new id here at once, so nothing showing it loses it before its list comes
      batch(() => {
        setState("pages", (p) => p.id === msg.from, "id", msg.to);
        follow(msg.from, msg.to);
        for (const f of movers) f(msg.from, msg.to);
      });
      break;
    case "page": {
      const at = state.pages.findIndex((p) => p.id === msg.page.id);
      if (at < 0) setState("pages", state.pages.length, msg.page);
      else setState("pages", at, reconcile(msg.page, { key: "id" }));
      break;
    }
    case "made":
      setState("made", { page: msg.page, id: msg.id, n: (state.made?.n ?? 0) + 1 });
      break;
    case "refused":
      setState("refused", { text: msg.text, alias: msg.alias });
      if (msg.alias !== null) settle(msg.alias);
      // one about a mesh import shows beside it, any other here
      if (msg.alias === null) notify(msg.text, "fault");
      break;
    case "notice":
      notify(msg.text, msg.level);
      break;
    case "open":
      push(msg.page, msg.replace, msg.ask);
      break;
    case "close":
      closeWith(msg.answer);
      break;
    case "pong":
    case "video":
      break;
  }
}

/** How long the screen still shows what it wrote to its own variable once the system has had
 *  the write, should the system's value never come to match, as when a rule changes it again. */
const KEPT_MS = 1000;

/** Each value as the system last gave it, by name, in a signal of its own and as plain data,
 *  frozen so no reader changes it. Not in the store, where a value is read through proxies that
 *  make a signal for every field read: an expression walking a point cloud made thousands each
 *  update. */
const values = new Map<string, Signal<Live | undefined>>();

/** What the screen wrote to its own variables, shown over the system's value until that comes
 *  to match, so what it draws never waits on the round trip nor steps back through older
 *  values on their way back. */
const promised = new Map<string, Signal<{ value: Value } | undefined>>();

/** The signal holding `name`'s in `cells`, made the first time it is read or given. */
function cell<T>(cells: Map<string, Signal<T | undefined>>, name: string): Signal<T | undefined> {
  let c = cells.get(name);
  if (!c) cells.set(name, (c = createSignal<T | undefined>(undefined)));
  return c;
}

/** Gives `alias` its value, holding on to every part of the one before that it equals, so what
 *  reads an unchanged part sees the very thing it saw and stays as it is. */
function give(alias: string, value: Value, known: boolean) {
  const [now, set] = cell(values, alias);
  const was = untrack(now);
  const next = shared(was?.value, value) as Value;
  if (!was || was.value !== next || was.known !== known) set({ value: next, known });
}

/** A list or a map, not text, a number or bytes. */
const holds = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !ArrayBuffer.isView(v);

/** `next` made frozen in place, each part of it that equals the same part of `was` taken from
 *  `was`, and `was` itself when it all does. What is frozen already was shared before. */
function shared(was: unknown, next: unknown): unknown {
  if (was === next || !holds(next) || Object.isFrozen(next)) return next;
  // frozen already, and its numbers compare far faster than its records
  if (packed(next)) return samePacked(was, next) ? was : next;
  const old = holds(was) && Array.isArray(was) === Array.isArray(next) ? was : undefined;
  let same = old !== undefined;
  if (Array.isArray(next)) {
    const before = old as unknown[] | undefined;
    same &&= before!.length === next.length;
    for (let i = 0; i < next.length; i++) {
      next[i] = shared(before?.[i], next[i]);
      same &&= next[i] === before![i];
    }
  } else {
    const keys = Object.keys(next);
    same &&= Object.keys(old!).length === keys.length;
    for (const k of keys) {
      next[k] = shared(old?.[k], next[k]);
      same &&= next[k] === old![k];
    }
  }
  return same ? was : Object.freeze(next);
}
/** When each promise was made, and its lapse once the system has had it. */
const pending = new Map<string, { at: number; lapse?: ReturnType<typeof setTimeout> }>();

/** Shows `value` as `alias`'s at once, as the screen wrote it, until the system's matches. */
export function promise(alias: string, value: Value) {
  cell(promised, alias)[1]({ value: shared(undefined, value) as Value });
  clearTimeout(pending.get(alias)?.lapse);
  pending.set(alias, { at: performance.now() });
}

/** A ping sent at `sent` came back, so the system has had every write made before it, however
 *  slow the link. */
export function cameBack(sent: number) {
  for (const [alias, p] of pending) if (p.at < sent && !p.lapse) p.lapse = setTimeout(() => settle(alias), KEPT_MS);
}

function settle(alias: string) {
  clearTimeout(pending.get(alias)?.lapse);
  pending.delete(alias);
  cell(promised, alias)[1](undefined);
}

/** Whether two values hold the same, the order of their fields aside. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every((k) => same(x[k], y[k]));
}

/** Hears each name read for the screen, so one the pages' text does not name still comes, and
 *  whether it was read whole, so its lists come to the main thread. */
let reading: (alias: string, whole: boolean) => void = () => {};
export function onReading(f: (alias: string, whole: boolean) => void) {
  reading = f;
}

/** The imports whose value now holds lists the data worker keeps, and the names read by what
 *  runs in `readFar`, which may take those, or null outside it. */
const kept = new Set<string>();
let farReads: string[] | null = null;

/** Runs `read`, in which an import whose lists the data worker keeps reads as it is, each a far
 *  list a scene's points follow there. Gives back what it gave and the names it read. */
export function readFar<T>(read: () => T): { value: T; names: string[] } {
  const [was, names] = [farReads, [] as string[]];
  farReads = names;
  try {
    return { value: read(), names };
  } finally {
    farReads = was;
  }
}

/** Counts `names` as read whole, as by a part whose points they make but are no far list. */
export function readWhole(names: string[]) {
  for (const n of names) reading(n, true);
}

/** A mesh import is shown as known only while the backend link is up too. Read whole, one whose
 *  lists the data worker keeps is not known until they come. */
export function live(alias: string): Live {
  farReads?.push(alias);
  reading(alias, farReads === null);
  if (farReads === null && kept.has(alias) && cell(values, alias)[0]()) return { value: null, known: false };
  const p = cell(promised, alias)[0]();
  if (p) return { value: p.value, known: state.link === "open" };
  const v = cell(values, alias)[0]();
  return { value: v?.value ?? null, known: state.link === "open" && !!v?.known };
}

export function entity(name: string): EntityInfo | undefined {
  return state.entities.find((e) => e.name === name);
}

/** Whether an import has the Video child rant-transcoder makes, which plays as H264. */
export function transcoded(imp: Import): boolean {
  return entity(`${imp.entity}/Video`)?.schema?.name === "VideoFrame";
}

export function importOf(entityName: string): Import | undefined {
  return state.imports.find((i) => i.entity === entityName);
}

const movers = new Set<(from: string, to: string) => void>();

/** Calls `f` with each page or component id a rename moves, until what it returns is called. */
export function onMoved(f: (from: string, to: string) => void): () => void {
  movers.add(f);
  return () => movers.delete(f);
}

export function page(id: string): Page | undefined {
  return state.pages.find((p) => p.id === id);
}

/** A component by the name its instances give. */
export function component(name: string): Page | undefined {
  return state.pages.find((p) => p.interface !== null && p.name === name);
}

/** The page operators' screens open on: the project's start, else the first page. */
export function startPage(): string | undefined {
  const start = state.project?.start;
  return start && page(start)?.interface === null ? start : state.pages.find((p) => p.interface === null)?.id;
}

// What the backend told this screen, in one store. Every server message lands through
// receive(), and reconcile keeps object identity so only what changed redraws.

import { createStore, produce, reconcile } from "solid-js/store";
import type { EntityInfo } from "../protocol/EntityInfo";
import type { Import } from "../protocol/Import";
import type { Page } from "../protocol/Page";
import type { Level } from "../protocol/Level";
import type { JsonValue } from "../protocol/serde_json/JsonValue";
import type { PeerInfo } from "../protocol/PeerInfo";
import type { ProjectInfo } from "../protocol/ProjectInfo";
import type { ServerMsg } from "../protocol/ServerMsg";
import type { Rule } from "../protocol/Rule";
import type { Token } from "../protocol/Token";
import type { Variable } from "../protocol/Variable";
import { closeWith, push } from "./stack";

export interface Live {
  value: JsonValue | null;
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

/** How long a notice stays, by how much it matters. */
const STAYS: Record<Level, number> = { info: 4000, warn: 7000, fault: 10000 };

export interface State {
  link: "connecting" | "open" | "closed";
  /** The smoothed round trip to the backend. */
  rttMs: number | null;
  project: ProjectInfo | null;
  node: string;
  version: string;
  imports: Import[];
  variables: Variable[];
  /** The HMI's own handlers. */
  rules: Rule[];
  tokens: Token[];
  entities: EntityInfo[];
  values: Record<string, Live>;
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
  project: null,
  node: "",
  version: "",
  imports: [],
  variables: [],
  rules: [],
  tokens: [],
  entities: [],
  values: {},
  peers: [],
  pages: [],
  made: null,
  refused: null,
  notices: [],
});

/** The lists a screen changes a record of at a time, by the field that names a record. */
const KEYS = { imports: "alias", variables: "name", tokens: "name", rules: "id" } as const;
type Keyed = { [L in keyof typeof KEYS]: State[L][number] };

/** Writes a record here at once, in place, or removes it, so a change right after builds on
 *  this one. The backend sends the list back should it refuse. */
export function putLocal<L extends keyof Keyed>(list: L, key: string, record: Keyed[L] | null) {
  setState(
    produce((s: State) => {
      const all = s[list] as Keyed[L][];
      const at = all.findIndex((r) => (r as Record<string, unknown>)[KEYS[list]] === key);
      if (at < 0) return;
      if (record) Object.assign(all[at], record);
      else all.splice(at, 1);
    }),
  );
}

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

export function receive(msg: ServerMsg) {
  switch (msg.type) {
    case "hello":
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
    case "mesh":
      setState("entities", reconcile(msg.entities, { key: "name" }));
      break;
    case "values":
      for (const u of msg.values) {
        setState("values", u.alias, reconcile({ value: u.value, known: u.known }));
      }
      break;
    case "health":
      setState("peers", reconcile(msg.peers, { key: "id" }));
      break;
    case "pages":
      setState("pages", reconcile(msg.pages, { key: "id" }));
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
      // one about a datapoint shows beside it, any other here
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
      break;
  }
}

/** A datapoint is shown as known only while the backend link is up too. */
export function live(alias: string): Live {
  const v = state.values[alias];
  return { value: v?.value ?? null, known: state.link === "open" && !!v?.known };
}

export function entity(name: string): EntityInfo | undefined {
  return state.entities.find((e) => e.name === name);
}

export function importOf(entityName: string): Import | undefined {
  return state.imports.find((i) => i.entity === entityName);
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

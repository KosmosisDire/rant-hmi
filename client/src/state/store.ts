// What the backend told this screen, in one store. Every server message lands through
// receive(), and reconcile keeps object identity so only what changed redraws.

import { createStore, reconcile } from "solid-js/store";
import type { EntityInfo } from "../protocol/EntityInfo";
import type { Import } from "../protocol/Import";
import type { Page } from "../protocol/Page";
import type { JsonValue } from "../protocol/serde_json/JsonValue";
import type { PeerInfo } from "../protocol/PeerInfo";
import type { ProjectInfo } from "../protocol/ProjectInfo";
import type { ServerMsg } from "../protocol/ServerMsg";

export interface Live {
  value: JsonValue | null;
  known: boolean;
}

export interface Refusal {
  text: string;
  alias: string | null;
}

export interface State {
  link: "connecting" | "open" | "closed";
  /** The smoothed round trip to the backend. */
  rttMs: number | null;
  project: ProjectInfo | null;
  node: string;
  version: string;
  imports: Import[];
  entities: EntityInfo[];
  values: Record<string, Live>;
  peers: PeerInfo[];
  pages: Page[];
  /** What this screen's last edit made, to open or select. `n` counts, so the same id twice
   *  still reads as new. */
  made: { page: string; id: string; n: number } | null;
  refused: Refusal | null;
}

export const [state, setState] = createStore<State>({
  link: "connecting",
  rttMs: null,
  project: null,
  node: "",
  version: "",
  imports: [],
  entities: [],
  values: {},
  peers: [],
  pages: [],
  made: null,
  refused: null,
});

export function receive(msg: ServerMsg) {
  switch (msg.type) {
    case "hello":
      setState({ project: msg.project, node: msg.node, version: msg.version });
      break;
    case "imports":
      setState("imports", reconcile(msg.imports, { key: "alias" }));
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

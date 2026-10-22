// Changes this screen asks the backend for, made here at once too where the store can make them
// alone, so what is typed or dragged next builds on them. A refusal sends back what it named.

import { produce } from "solid-js/store";
import { send } from "../net/connection";
import type { ClientMsg } from "../protocol/ClientMsg";
import type { Edit } from "../protocol/Edit";
import { find } from "./elements";
import { setState, type State } from "./store";

/** Sends `msg`, and makes its change here at once when the store can make it alone. */
export function change(msg: ClientMsg): boolean {
  if (!send(msg)) return false;
  setState(produce((s: State) => mirror(s, msg)));
  return true;
}

/** Sends an edit of the pages or the rules, made here at once when the store can make it alone. */
export const edit = (e: Edit) => change({ type: "edit", edit: e });

/** Makes an edit here only, as a gesture does before it lets go and keeps it with `edit`. */
export const show = (e: Edit) => setState(produce((s: State) => edited(s, e)));

/** The edits that change only what the page or rule they name holds. */
const ALONE = new Set<Edit["kind"]>(["set_props", "set_handler", "set_input", "set_local", "set_event", "resize_page", "set_fill", "set_shows", "set_sizing", "set_rule"]);

function mirror(s: State, msg: ClientMsg) {
  switch (msg.type) {
    case "set_variable":
      return putIn(s.variables, msg.name, msg.variable, (v) => v.name);
    case "set_computed":
      return putIn(s.computed, msg.name, msg.computed, (c) => c.name);
    case "set_record":
      return putIn(s.records, msg.name, msg.record, (r) => r.name);
    case "set_token":
      return putIn(s.tokens, msg.name, msg.token, (t) => t.name);
    case "change_import":
      return putIn(s.imports, msg.alias, msg.import, (i) => i.alias);
    case "edit":
      return edited(s, msg.edit);
  }
}

/** Makes an edit in the store being produced. A batch is made whole or not at all. */
function edited(s: State, e: Edit) {
  if (e.kind === "batch") return e.edits.every((x) => ALONE.has(x.kind)) && e.edits.forEach((x) => edited(s, x));
  if (e.kind === "set_rule") return e.id && putIn(s.rules, e.id, e.rule && { ...e.rule, id: e.id }, (r) => r.id);
  const pg = "page" in e ? s.pages.find((p) => p.id === e.page) : undefined;
  if (!pg) return;
  switch (e.kind) {
    case "resize_page":
      return Object.assign(pg, { width: e.width, height: e.height });
    case "set_fill":
      return (pg.fill = e.fill);
    case "set_shows":
      return (pg.shows = e.shows);
    case "set_sizing":
      return pg.interface && (pg.interface.sizing = e.sizing);
    case "set_input":
      return pg.interface && putIn(pg.interface.inputs, e.name, e.input, (i) => i.name);
    case "set_local":
      return pg.interface && putIn(pg.interface.variables, e.name, e.local, (v) => v.name);
    case "set_event":
      return pg.interface && putIn(pg.interface.events, e.name, e.to, (name) => name);
    case "set_props": {
      const el = find(pg.children, e.id);
      for (const [k, v] of Object.entries(e.props)) {
        if (!el) return;
        if (!v) delete el.props[k];
        else el.props[k] = v;
      }
      return;
    }
    case "set_handler": {
      const el = find(pg.children, e.id);
      const at = el?.handlers.findIndex((h) => h.event === e.event) ?? -1;
      if (!el) return;
      if (e.code === null) {
        if (at >= 0) el.handlers.splice(at, 1);
        return;
      }
      const attrs = { ...el.handlers[at]?.attrs };
      for (const [k, v] of Object.entries(e.attrs ?? {})) {
        if (v?.trim()) attrs[k] = v.trim();
        else delete attrs[k];
      }
      if (at >= 0) Object.assign(el.handlers[at], { code: e.code, attrs });
      else el.handlers.push({ event: e.event, code: e.code, attrs });
    }
  }
}

/** Puts `item` in place of the one `key` names in a list being produced, keeping that one's
 *  identity, or with null removes it. A new item waits for the backend to send it. */
function putIn<T>(all: T[], key: string, item: T | null, keyOf: (t: T) => string) {
  const at = all.findIndex((t) => keyOf(t) === key);
  if (at < 0) return;
  if (item === null) all.splice(at, 1);
  else if (typeof item === "object") Object.assign(all[at] as object, item);
  else all[at] = item;
}

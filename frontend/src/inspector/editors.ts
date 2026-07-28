/* Value editors, chosen by SHAPE, and the entity reference editor. Nothing here switches
 * on a widget type or a slot name: the registry says what shape a slot is and this maps a
 * shape to a control.
 *
 * Every editor is built once and then DRIVEN: it takes the key it shows and a reader, and
 * registers a binding that assigns the current value into the control it already made
 * (reconcile.ts). Nothing in here ever replaces a node to show a new value, so a slot fed
 * at 30 Hz costs one assignment per frame and no layout at all.
 *
 * A bound slot with nothing delivered yet reads as UNKNOWN, and UNKNOWN is a STATE of the
 * ordinary editor (an empty field behind a "--" placeholder, no button lit) rather than a
 * different control: swapping in a different control would change the row's height, and a
 * row that changes height moves everything under it. */

import { colorField } from "../colorpicker.js";
import { alignGrid, boolPair, chip, commitInput, el, numberInput, pickerOf, selectField } from "../dom.js";
import { kindMark } from "../icons.js";
import { bindChoice, bindField, bindFlag, bindGroup, bindText } from "../reconcile.js";
import { UNKNOWN_TEXT } from "../template.js";
import { Json, SlotSpec } from "../types.js";

export function valueEditor(
  spec: SlotSpec | null,
  shape: string,
  key: string,
  read: () => Json,
  commit: (v: Json) => void,
  unknown = false,
): HTMLElement {
  const value = read();
  const text = (v: Json) => (typeof v === "string" ? v : "");
  const placeholder = unknown ? { placeholder: UNKNOWN_TEXT } : {};

  /* an editor hint outranks the shape: the align enum edits as a 3x3 grid */
  if (spec?.editor === "align") {
    const grid = alignGrid(text(value) || "center", commit);
    bindGroup(key, grid, () => text(read()) || (unknown ? "" : "center"));
    return grid;
  }
  switch (shape) {
    case "bool": {
      const pair = boolPair(value === true, commit);
      bindGroup(key, pair, () => {
        const next = read();
        if (next === null && unknown) return "";
        return next === true ? "on" : "off";
      });
      return pair;
    }
    case "num": {
      const field = numberInput(typeof value === "number" ? value : 0, commit, {
        class: "field grow",
        ...placeholder,
      });
      bindField(key, field, () => {
        const next = read();
        return typeof next === "number" ? String(next) : unknown ? "" : "0";
      });
      return field;
    }
    case "color":
      return colorField(text(value), commit, key, () => text(read()));
    case "enum": {
      const wrap = selectField(
        (spec?.variants ?? []).map((v) => ({ value: v })),
        text(value),
        commit,
      );
      bindChoice(key, pickerOf(wrap), () => text(read()));
      return wrap;
    }
    case "text": {
      const field = commitInput(text(value), commit, { class: "field grow", ...placeholder });
      bindField(key, field, () => text(read()));
      return field;
    }
    default: {
      const node = el("code", { class: "empty" });
      bindText(key, node, () => JSON.stringify(read() ?? null));
      return node;
    }
  }
}

export const ENTITY_KINDS = [
  { value: "V", label: "V  variable" },
  { value: "T", label: "T  topic" },
  { value: "F", label: "F  function" },
  { value: "S", label: "S  signal" },
  { value: "L", label: "L  hmi variable" },
];

/* An entity reference: kind mark, then the name. Reflection turns the name into a picker
 * at the mesh stage; until then it is typed, which is what a deep path wants anyway. */
export function entityRefEditor(
  key: string,
  read: () => { kind: string; name: string } | undefined,
  commit: (ref: { kind: string; name: string }) => void,
): HTMLElement {
  const current = () => {
    const ref = read();
    return { kind: ref?.kind ?? "V", name: ref?.name ?? "" };
  };
  const start = current();
  const wrap = selectField(
    ENTITY_KINDS.map((k) => ({ value: k.value, label: k.value })),
    start.kind,
    (kind) => commit({ ...current(), kind }),
  );
  bindChoice(key + ".kind", pickerOf(wrap), () => current().kind);
  const name = commitInput(start.name, (text) => commit({ ...current(), name: text }), {
    class: "field grow",
    placeholder: "entity name",
  });
  bindField(key + ".name", name, () => current().name);
  return el("span", { class: "value-cell" }, [kindMark(start.kind, "entity kind"), wrap, name]);
}

/* the read-only form of the same thing, for a collapsed sentence. The kind mark is a glyph
 * chosen by the shape; only the words move, so only the words are bound. */
export function entityChip(
  key: string,
  read: () => { ref?: { kind: string; name: string }; path?: string },
): HTMLElement {
  const kind = read().ref?.kind ?? "?";
  const node = chip("", "pad-mark");
  bindFlag(key + ".ghost", node, "ghost-chip", () => !read().ref?.name);
  node.appendChild(kindMark(kind));
  const name = el("span");
  bindText(key + ".name", name, () => read().ref?.name || "pick source");
  node.appendChild(name);
  const sep = el("span", { class: "sep" });
  bindText(key + ".sep", sep, () => (read().path ? " > " : ""));
  node.appendChild(sep);
  const path = el("span", { class: "path" });
  bindText(key + ".path", path, () => read().path ?? "");
  node.appendChild(path);
  return node;
}

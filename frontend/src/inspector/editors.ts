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
import { alignGrid, boolPair, chip, commitTextInput, el, numberInput, pickerOf, selectField } from "../dom.js";
import { Editor } from "../editor.js";
import { kindMark } from "../icons.js";
import { bindChoice, bindField, bindFlag, bindGroup, bindText } from "../reconcile.js";
import { UNKNOWN_TEXT } from "../template.js";
import { Json, SlotSpec, Widget } from "../types.js";
import { openSourceTree, resolveShape, SourcePick, SourceTreeOptions } from "./sourcetree.js";
import { openTypeTree } from "./typetree.js";

export function valueEditor(
  spec: SlotSpec | null,
  shape: string,
  key: string,
  read: () => Json,
  commit: (v: Json) => void,
  unknown = false,
  editor: Editor | null = null,
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
  /* ... and a Dropdown's options hold a TypeRef naming an enum (spec 6.2), picked from
     the type tree so the option list can never drift from the schema */
  if (spec?.editor === "enum-type") {
    const node = el("button", { class: "chip pad-mark source-chip", title: "pick an enum" });
    bindFlag(key + ".ghost", node, "ghost-chip", () => !text(read()));
    const name = el("span", { class: "name" });
    bindText(key + ".name", name, () => text(read()) || "pick an enum");
    node.appendChild(name);
    node.addEventListener("click", () => {
      if (editor)
        openTypeTree(node, editor, { enums: true }, (pick) => commit(pick.ref),
                     text(read()));
    });
    return node;
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
      const lo = typeof spec?.min === "number" ? spec.min : null;
      const hi = typeof spec?.max === "number" ? spec.max : null;
      const bounded = lo !== null && hi !== null && hi > lo;
      /* a bounded slot clamps whatever is typed: the range is the contract */
      const put = bounded
        ? (n: number) => commit(Math.max(lo, Math.min(hi, n)))
        : commit;
      const field = numberInput(typeof value === "number" ? value : 0, put, {
        class: bounded ? "field num" : "field grow",
        ...(spec?.step ? { step: String(spec.step) } : {}),
        ...placeholder,
      });
      const reader = () => {
        const next = read();
        return typeof next === "number" ? String(next) : unknown ? "" : "0";
      };
      bindField(key, field, reader);
      if (!bounded) return field;
      /* the Unity treatment: a slider carries the range, the field stays for typing */
      const slider = el("input", {
        class: "range",
        type: "range",
        min: String(lo),
        max: String(hi),
        step: String(spec?.step ?? (hi - lo) / 100),
        value: String(typeof value === "number" ? value : lo),
        oninput: (ev: Event) => {
          const n = Number((ev.target as HTMLInputElement).value);
          if (Number.isFinite(n)) put(n);
        },
      }) as HTMLInputElement;
      bindField(key + ".range", slider, reader);
      return el("span", { class: "range-pair" }, [slider, field]);
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
      /* a textarea, not an input: a caption may hold EXPLICIT newlines (Shift+Enter);
         Enter still commits, and the row stays one line tall either way */
      const field = commitTextInput(text(value), commit, { class: "field grow", ...placeholder });
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

/* An entity reference is PICKED, never typed: a button carrying the current reference
 * that opens the hierarchical source tree (dart + hmi roots). The pick brings kind,
 * name, path and value type along in one act, so no kind or type dropdown exists. The
 * structure key of the row containing this must include the reference's kind, so a
 * cross-kind repick rebuilds the kind mark. */
/* the scope mark for an HMI variable reference: blue local, violet global */
function scopeMark(widget: Widget | null, name: string | undefined): string {
  return widget?.locals.some((v) => v.name === name) ? "l" : "g";
}

export function sourceField(
  key: string,
  editor: Editor,
  widget: Widget | null,
  opts: SourceTreeOptions,
  read: () => { ref?: { kind: string; name: string }; path?: string },
  onPick: (pick: SourcePick) => void,
): HTMLElement {
  const raw = read().ref?.kind ?? "?";
  const kind = raw === "L" ? scopeMark(widget, read().ref?.name) : raw;
  const node = el("button", { class: "chip pad-mark source-chip", title: "pick from the network" });
  bindFlag(key + ".ghost", node, "ghost-chip", () => !read().ref?.name);
  node.appendChild(kindMark(kind));
  const name = el("span", { class: "name" });
  bindText(key + ".name", name, () => read().ref?.name || "pick source");
  node.appendChild(name);
  const sep = el("span", { class: "sep" });
  bindText(key + ".sep", sep, () => (read().path ? " > " : ""));
  node.appendChild(sep);
  const path = el("span", { class: "path" });
  bindText(key + ".path", path, () => read().path ?? "");
  node.appendChild(path);
  const shape = el("span", { class: "shape" });
  bindText(key + ".shape", shape, () => {
    const at = read();
    const resolved = resolveShape(editor, widget, at.ref, at.path);
    return resolved ? resolved : "";
  });
  node.appendChild(shape);
  node.addEventListener("click", () => {
    const at = read();
    openSourceTree(node, editor, widget, opts, onPick,
                   at.ref ? { ...at.ref, path: at.path ?? "" } : undefined);
  });
  return node;
}

/* the read-only form of the same thing, for a collapsed sentence. The kind mark is a glyph
 * chosen by the shape; only the words move, so only the words are bound. */
export function entityChip(
  key: string,
  read: () => { ref?: { kind: string; name: string }; path?: string },
  editor?: Editor,
  widget?: Widget | null,
): HTMLElement {
  const raw = read().ref?.kind ?? "?";
  const kind = raw === "L" ? scopeMark(widget ?? null, read().ref?.name) : raw;
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
  if (editor) {
    const shape = el("span", { class: "shape" });
    bindText(key + ".shape", shape, () => {
      const at = read();
      return resolveShape(editor, widget ?? null, at.ref, at.path);
    });
    node.appendChild(shape);
  }
  return node;
}

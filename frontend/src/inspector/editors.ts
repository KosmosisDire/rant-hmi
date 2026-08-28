/* Value editors, chosen by SHAPE. Nothing here switches
 * on a component or a slot name: the registry says what shape a slot is and this maps a
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
import { iconField } from "../iconpicker.js";
import { alignGrid, boolPair, commitTextInput, el, numberInput, pickerOf, selectField } from "../dom.js";
import { Editor, UNKNOWN_TEXT } from "../editor.js";
import { bindChoice, bindField, bindGroup, bindText } from "../reconcile.js";
import { Json, SlotSpec } from "../types.js";
import { tokenAccess } from "./scope.js";

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
  /* ... an OPTIONS slot's value edits in the instance panel's slot row, whose browse
     (optionsSlotScope) offers every enum-typed value in reach as its .Variants()
     read — so this editor needs no case for it */
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
      /* the value may be "$token": the swatch shows the resolved color, the field the
         honest reference, and the $ button offers the document's tokens */
      return colorField(text(value), commit, key, () => text(read()),
                        editor ? tokenAccess(editor) : undefined);
    case "enum": {
      const wrap = selectField(
        (spec?.variants ?? []).map((v) => ({ value: v })),
        text(value),
        commit,
      );
      bindChoice(key, pickerOf(wrap), () => text(read()));
      return wrap;
    }
    case "icon":
      /* the raw value is the glyph's BARE name; the button paints it and opens the
         grid — the colorField anatomy carried to ink */
      return iconField(text(value), commit, key, () => text(read()));
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


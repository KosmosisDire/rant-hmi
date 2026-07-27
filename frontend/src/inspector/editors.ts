/* Value editors, chosen by SHAPE, and the entity reference editor. Nothing here switches
 * on a widget type or a slot name: the registry says what shape a slot is and this maps a
 * shape to a control. */

import { colorField } from "../colorpicker.js";
import { alignGrid, boolPair, chip, commitInput, el, numberInput, selectField } from "../dom.js";
import { kindMark } from "../icons.js";
import { Json, SlotSpec } from "../types.js";

export function valueEditor(
  spec: SlotSpec | null,
  shape: string,
  value: Json,
  commit: (v: Json) => void,
): HTMLElement {
  /* an editor hint outranks the shape: the align enum edits as a 3x3 grid */
  if (spec?.editor === "align")
    return alignGrid(typeof value === "string" ? value : "center", commit);
  switch (shape) {
    case "bool":
      return boolPair(value === true, commit);
    case "num":
      return numberInput(typeof value === "number" ? value : 0, commit, { class: "field grow" });
    case "color":
      return colorField(typeof value === "string" ? value : "", commit);
    case "enum":
      return selectField(
        (spec?.variants ?? []).map((v) => ({ value: v })),
        typeof value === "string" ? value : "",
        commit,
      );
    case "text":
      return commitInput(typeof value === "string" ? value : "", commit, { class: "field grow" });
    default:
      return el("code", { class: "empty", text: JSON.stringify(value ?? null) });
  }
}

/* An expression cell. The tier (display vs wire) and the autocomplete arrive with the
 * compiler; the field is already the one the compiler will read. */
export function exprField(value: string, commit: (text: string) => void, placeholder = "x"): HTMLElement {
  return el("span", { class: "value-cell" }, [
    el("span", { class: "op", text: "ƒ" }),
    commitInput(value ?? "", commit, { class: "field grow", placeholder }),
  ]);
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
  ref: { kind: string; name: string } | undefined,
  commit: (ref: { kind: string; name: string }) => void,
): HTMLElement {
  const current = { kind: ref?.kind ?? "V", name: ref?.name ?? "" };
  return el("span", { class: "value-cell" }, [
    kindMark(current.kind, "entity kind"),
    selectField(
      ENTITY_KINDS.map((k) => ({ value: k.value, label: k.value })),
      current.kind,
      (kind) => commit({ ...current, kind }),
    ),
    commitInput(current.name, (name) => commit({ ...current, name }), {
      class: "field grow",
      placeholder: "entity name",
    }),
  ]);
}

/* the read-only form of the same thing, for a collapsed sentence */
export function entityChip(ref: { kind: string; name: string } | undefined, path = ""): HTMLElement {
  const kind = ref?.kind ?? "?";
  const name = ref?.name ?? "";
  const node = chip("", "pad-mark" + (name ? "" : " ghost-chip"));
  node.appendChild(kindMark(kind));
  node.appendChild(el("span", { text: name || "pick source" }));
  if (path) {
    node.appendChild(el("span", { class: "sep", text: " > " }));
    node.appendChild(el("span", { class: "path", text: path }));
  }
  return node;
}

/* The variable card: name, NOW (live), TYPE, INIT. Global and widget-local cards are the
 * same card; only the scope note differs (spec 3.9). */

import { commitInput, el, iconButton, selectField } from "../dom.js";
import { Editor, liveIsOn, liveText, trackLive } from "../editor.js";
import { kindMark } from "../icons.js";
import { Json, Var } from "../types.js";
import { valueEditor } from "./editors.js";

const TYPES = [
  { value: "f64", label: "number" },
  { value: "bool", label: "bool" },
  { value: "str", label: "text" },
  { value: "timer", label: "timer" },
];

export function varCard(editor: Editor, variable: Var, scope: "global" | "local"): HTMLElement {
  const setProp = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: variable.id, key, value }]);
  const cell = "v" + variable.id;
  const now = trackLive(
    el("span", {
      class: "now-value" + (liveIsOn(editor.live, cell) ? " on" : ""),
      text: liveText(editor.live, cell),
    }),
    (live) => {
      now.textContent = liveText(live, cell);
      now.classList.toggle("on", liveIsOn(live, cell));
    },
  );
  const initShape =
    variable.type === "bool" ? "bool" : variable.type === "str" ? "text" : "num";

  return el("div", { class: "card" }, [
    el("div", { class: "row", style: "margin-bottom:7px" }, [
      kindMark("L", scope === "local" ? "Only visible to this widget" : "Lives in the HMI"),
      commitInput(
        variable.name,
        (name) => editor.apply([{ op: "rename", node: variable.id, name }]),
        { class: "field grow" },
      ),
      iconButton("x", "remove " + variable.name, () =>
        editor.apply([{ op: "remove", node: variable.id }]),
      ),
    ]),
    el("div", { class: "var-now" }, [el("span", { class: "row-label", text: "NOW" }), now]),
    el("div", { class: "var-grid" }, [
      el("span", { class: "row-label", text: "TYPE" }),
      selectField(TYPES, variable.type, (type) => setProp("type", type)),
      el("span", { class: "row-label", text: variable.type === "timer" ? "SECS" : "INIT" }),
      el("span", { class: "value-cell" }, [
        valueEditor(null, initShape, variable.init, (value) => setProp("init", value)),
        variable.type === "timer" ? el("span", { class: "op", text: "s" }) : null,
      ]),
      el("span", { class: "row-label", text: "KEEP" }),
      valueEditor(null, "bool", variable.persist, (value) => setProp("persist", value)),
    ]),
  ]);
}

/* a fresh name that is free in this scope */
export function newVariable(editor: Editor, parent: number, list: string, taken: Var[]): void {
  const names = new Set(taken.map((v) => v.name));
  let n = 1;
  while (names.has("var" + n)) n++;
  editor.apply([{ op: "insert", parent, list, node: { name: "var" + n, type: "f64", init: 0 } }]);
}

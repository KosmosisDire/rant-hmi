/* The variable card: name, NOW (live), TYPE, INIT. Global and widget-local cards are the
 * same card; only the scope note differs (spec 3.9).
 *
 * A variable's TYPE is structure (it picks the INIT editor and renames the row); everything
 * else on the card is a value pushed into standing controls, so the NOW readout tracking a
 * 30 Hz timer never touches the card around it. */

import { commitInput, el, iconButton, pickerOf, selectField } from "../dom.js";
import { diagIcon, Editor, liveIsOn, liveText } from "../editor.js";
import { bind, bindChoice, bindField } from "../reconcile.js";
import { kindMark } from "../icons.js";
import { Json, Var } from "../types.js";
import { valueEditor } from "./editors.js";

const TYPES = [
  { value: "f64", label: "number" },
  { value: "bool", label: "bool" },
  { value: "str", label: "text" },
  { value: "timer", label: "timer" },
];

export function varShape(variable: Var): Json {
  return [variable.id, variable.type];
}

export function varCard(editor: Editor, variable: Var, scope: "global" | "local"): HTMLElement {
  const at = () => (editor.store.node(variable.id) as Var | null) ?? variable;
  const setProp = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: variable.id, key, value }]);
  const cell = "v" + variable.id;

  const name = commitInput(
    variable.name,
    (text) => editor.apply([{ op: "rename", node: variable.id, name: text }]),
    { class: "field grow" },
  );
  bindField(variable.id + ":name", name, () => at().name ?? "");

  const now = el("span", { class: "now-value" });
  bind(variable.id + ":now", now, () => {
    const text = liveText(editor.live, cell);
    if (now.textContent !== text) now.textContent = text;
    now.classList.toggle("on", liveIsOn(editor.live, cell));
  });

  const type = selectField(TYPES, variable.type, (next) => setProp("type", next));
  bindChoice(variable.id + ":type", pickerOf(type), () => at().type);

  const initShape =
    variable.type === "bool" ? "bool" : variable.type === "str" ? "text" : "num";

  return el("div", { class: "card" }, [
    el("div", { class: "row", style: "margin-bottom:7px" }, [
      kindMark("L", scope === "local" ? "Only visible to this widget" : "Lives in the HMI"),
      name,
      /* a finding about the variable itself (an unknown type) sits on its name row */
      diagIcon(editor.diagAt(variable.id)),
      iconButton("x", "remove this variable", () =>
        editor.apply([{ op: "remove", node: variable.id }]),
      ),
    ]),
    el("div", { class: "var-now" }, [el("span", { class: "row-label", text: "NOW" }), now]),
    el("div", { class: "var-grid" }, [
      el("span", { class: "row-label", text: "TYPE" }),
      type,
      /* init and keep share one full-width line: the label rides inline, the init editor
         takes the room, keep sits at the right edge. The controls live in a flex line
         because a bare control as a grid item would be stretched to the column, which is
         exactly not what a two-state pair wants. */
      el("div", { class: "var-line" }, [
        el("span", { class: "row-label", text: variable.type === "timer" ? "SECS" : "INIT" }, [
          /* an init that cannot be the variable's shape is pinned on the INIT row */
          diagIcon(editor.diagAt(variable.id, "init")),
        ]),
        valueEditor(
          null,
          initShape,
          variable.id + ":init",
          () => at().init,
          (value) => setProp("init", value),
        ),
        variable.type === "timer" ? el("span", { class: "op", text: "s" }) : null,
        el("span", { class: "row-label keep-label", text: "KEEP" }),
        valueEditor(
          null,
          "bool",
          variable.id + ":persist",
          () => at().persist,
          (value) => setProp("persist", value),
        ),
      ]),
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

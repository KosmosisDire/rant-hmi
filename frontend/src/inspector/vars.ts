/* The variable card: collapsed it is the name and what the variable reads right NOW, which
 * is what a variable is looked at for; open it adds the settings behind that value (TYPE,
 * INIT, KEEP). Global and widget-local cards are the same card; only the scope note differs
 * (spec 3.9). It folds like a feed or a flow card, same caret and same click.
 *
 * A variable's TYPE is structure (it picks the INIT editor and renames the row), and so is
 * whether the card is open; everything else is a value pushed into standing controls, so the
 * NOW readout tracking a 30 Hz timer never touches the card around it. */

import { commitInput, el, iconButton, pickerOf, selectField } from "../dom.js";
import { diagIcon, Editor, liveIsOn, liveText } from "../editor.js";
import { bind, bindChoice, bindField } from "../reconcile.js";
import { iconMarkup, kindMark } from "../icons.js";
import { Json, Var } from "../types.js";
import { valueEditor } from "./editors.js";

const TYPES = [
  { value: "f64", label: "number" },
  { value: "bool", label: "bool" },
  { value: "str", label: "text" },
  { value: "timer", label: "timer" },
];

const opened = new Set<number>();

export function varShape(variable: Var): Json {
  return [variable.id, variable.type, opened.has(variable.id)];
}

export function varCard(editor: Editor, variable: Var, scope: "global" | "local"): HTMLElement {
  const at = () => (editor.store.node(variable.id) as Var | null) ?? variable;
  const open = opened.has(variable.id);
  const setProp = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: variable.id, key, value }]);
  const cell = "v" + variable.id;

  const caret = el("span", {
    class: "arrow",
    html: iconMarkup("chevron-down", 10, 2),
    style: open ? "" : "transform:rotate(-90deg)",
  });

  const name = commitInput(
    variable.name,
    (text) => editor.apply([{ op: "rename", node: variable.id, name: text }]),
    { class: "field grow" },
  );
  bindField(variable.id + ":name", name, () => at().name ?? "");

  /* the live value rides the name line: what the variable READS is the thing a card is
     opened for, so it stays visible folded */
  const now = el("span", { class: "now-value" });
  bind(variable.id + ":now", now, () => {
    const text = liveText(editor.live, cell);
    if (now.textContent !== text) now.textContent = text;
    now.classList.toggle("on", liveIsOn(editor.live, cell));
  });

  /* the init finding lives on the INIT row; folded that row does not exist, so the head
     carries it, like a feed's */
  const initDiags = editor.diagAt(variable.id, "init");
  const head = el("div", { class: "card-head" }, [
    caret,
    kindMark("L", scope === "local" ? "Only visible to this widget" : "Lives in the HMI"),
    name,
    now,
    /* a finding about the variable itself (an unknown type) sits on its name row */
    diagIcon(open ? editor.diagAt(variable.id) : editor.diagAt(variable.id).concat(initDiags)),
    iconButton("x", "remove this variable", () =>
      editor.apply([{ op: "remove", node: variable.id }]),
    ),
  ]);

  const card = el("div", { class: "card" + (open ? " open" : "") }, [head]);
  head.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest("input, select, button")) return;
    if (open) opened.delete(variable.id);
    else opened.add(variable.id);
    editor.refresh();
  });
  if (!open) return card;

  const type = selectField(TYPES, variable.type, (next) => setProp("type", next));
  bindChoice(variable.id + ":type", pickerOf(type), () => at().type);

  const initShape =
    variable.type === "bool" ? "bool" : variable.type === "str" ? "text" : "num";

  /* One label column, one setting per line, so the labels stack and every control starts
     at the same x. A row's controls sit in a flex line rather than in the grid cell itself:
     a bare control as a grid item would be stretched to the column, which is exactly not
     what a picker or a two-state pair wants. */
  card.appendChild(
    el("div", { class: "card-body var-body" }, [
      el("div", { class: "var-grid" }, [
        el("span", { class: "row-label", text: "TYPE" }),
        el("div", { class: "var-line" }, [type]),
        el("span", { class: "row-label", text: variable.type === "timer" ? "SECS" : "INIT" }, [
          diagIcon(initDiags),
        ]),
        el("div", { class: "var-line" }, [
          valueEditor(
            null,
            initShape,
            variable.id + ":init",
            () => at().init,
            (value) => setProp("init", value),
          ),
          variable.type === "timer" ? el("span", { class: "op", text: "s" }) : null,
        ]),
        el("span", { class: "row-label", text: "KEEP" }),
        el("div", { class: "var-line" }, [
          valueEditor(
            null,
            "bool",
            variable.id + ":persist",
            () => at().persist,
            (value) => setProp("persist", value),
          ),
        ]),
      ]),
    ]),
  );
  return card;
}

/* a fresh name that is free in this scope */
export function newVariable(editor: Editor, parent: number, list: string, taken: Var[]): void {
  const names = new Set(taken.map((v) => v.name));
  let n = 1;
  while (names.has("var" + n)) n++;
  editor.apply([{ op: "insert", parent, list, node: { name: "var" + n, type: "f64", init: 0 } }]);
}

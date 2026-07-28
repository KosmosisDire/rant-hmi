/* The variable card: collapsed it is the name and what the variable reads right NOW, which
 * is what a variable is looked at for; open it adds the settings behind that value (TYPE,
 * INIT, KEEP). Global and widget-local cards are the same card; only the scope note differs
 * (spec 3.9). It folds like a feed or a flow card, same caret and same click.
 *
 * A variable's TYPE is any TypeRef from the mesh besides the four scalars (spec 2.7): the
 * picker is the TYPE TREE, and a struct-typed variable is born zeroed, so it shows no INIT
 * row (there is nothing scalar to seed) and its NOW readout names its type. The type is
 * structure (it picks the INIT editor and renames the row); everything else is a value
 * pushed into standing controls. */

import { commitInput, el, iconButton } from "../dom.js";
import { diagIcon, Editor, liveIsOn, liveText } from "../editor.js";
import { bind, bindField, bindText } from "../reconcile.js";
import { iconMarkup, kindMark } from "../icons.js";
import { Json, Var } from "../types.js";
import { valueEditor } from "./editors.js";
import { openTypeTree } from "./typetree.js";

const SCALAR_LABEL: Record<string, string> = {
  f64: "number", bool: "bool", str: "text", timer: "timer",
};

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
  const isStruct = !SCALAR_LABEL[variable.type];

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
     opened for, so it stays visible folded. An enum-typed variable reads as its variant
     name; a struct variable has no one live scalar, so its type stands in. */
  const now = el("span", { class: "now-value" });
  bind(variable.id + ":now", now, () => {
    const live = liveText(editor.live, cell);
    const text = isStruct && live === "--" ? at().type : live;
    if (now.textContent !== text) now.textContent = text;
    now.classList.toggle("on", liveIsOn(editor.live, cell));
  });

  /* findings on rows the fold hides ride the head, like a feed's */
  const initDiags = editor.diagAt(variable.id, "init");
  const typeDiags = editor.diagAt(variable.id, "type");
  const head = el("div", { class: "card-head" }, [
    caret,
    kindMark("L", scope === "local" ? "Only visible to this widget" : "Lives in the HMI"),
    name,
    now,
    diagIcon(open ? editor.diagAt(variable.id)
                  : editor.diagAt(variable.id).concat(initDiags, typeDiags)),
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

  /* the TYPE is picked from the type tree: the four scalars, then every struct root the
     mesh serves. What the document stores is the TypeRef itself. */
  const type = el("button", { class: "chip pad-mark source-chip", title: "pick a type" });
  const typeText = el("span", { class: "name" });
  bindText(variable.id + ":type", typeText, () => SCALAR_LABEL[at().type] ?? at().type);
  type.appendChild(typeText);
  type.addEventListener("click", () =>
    openTypeTree(type, editor, { scalars: true, structs: true, enums: true },
                 (pick) => setProp("type", pick.ref)),
  );

  const initShape =
    variable.type === "bool" ? "bool" : variable.type === "str" ? "text" : "num";

  /* One label column, one setting per line, so the labels stack and every control starts
     at the same x. A struct variable shows no INIT: it is born zeroed (spec 2.7). */
  card.appendChild(
    el("div", { class: "card-body var-body" }, [
      el("div", { class: "var-grid" }, [
        el("span", { class: "row-label", text: "TYPE" }, [diagIcon(typeDiags)]),
        el("div", { class: "var-line" }, [type]),
        ...(isStruct
          ? []
          : [
              el("span", { class: "row-label",
                           text: variable.type === "timer" ? "SECS" : "INIT" }, [
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

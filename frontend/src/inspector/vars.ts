/* The variable card: collapsed it is the name and what the variable reads right NOW, which
 * is what a variable is looked at for; open it adds the settings behind that value (TYPE,
 * INIT, KEEP). Global and widget-local cards are the same card; only the scope note differs
 *. It folds like a feed or a flow card, same caret and same click.
 *
 * A variable's TYPE is any TypeRef from the mesh besides the four scalars: the
 * picker is the TYPE TREE, and a struct-typed variable is born zeroed, so it shows no INIT
 * row (there is nothing scalar to seed) and its NOW readout names its type. The type is
 * structure (it picks the INIT editor and renames the row); everything else is a value
 * pushed into standing controls. */

import { commitInput, el, iconButton, pickerOf, selectField } from "../dom.js";
import { cellText, diagIcon, Editor, liveIsOn } from "../editor.js";
import { makeFolds } from "../fold.js";
import { bind, bindChoice, bindField, bindText } from "../reconcile.js";
import { iconMarkup, kindMark } from "../icons.js";
import { Json, MeshField, SCALAR_LABEL, Var } from "../types.js";
import { valueEditor } from "./editors.js";
import { openTypeTree, resolveTypeRef } from "./typetree.js";

/* which cards stand open, keyed by variable id: the open bit rides varShape, so a
 * toggle rebuilds exactly that card */
const opened = makeFolds();

export function varShape(variable: Var): Json {
  return [variable.id, variable.type, opened.open(String(variable.id))];
}

export function varCard(editor: Editor, variable: Var, scope: "global" | "local"): HTMLElement {
  const at = () => (editor.store.node(variable.id) as Var | null) ?? variable;
  const open = opened.open(String(variable.id));
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
    const live = cellText(editor, cell);
    const text = isStruct && live === "--" ? at().type : live;
    if (now.textContent !== text) now.textContent = text;
    now.classList.toggle("on", liveIsOn(editor.live, cell));
  });

  /* findings on rows the fold hides ride the head, like a feed's */
  const initDiags = editor.diagAt(variable.id, "init");
  const typeDiags = editor.diagAt(variable.id, "type");
  const head = el("div", { class: "card-head" }, [
    caret,
    kindMark(scope === "local" ? "l" : "g",
             scope === "local" ? "Only visible to this widget" : "Lives in the HMI"),
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
    opened.set(String(variable.id), !open);
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
                 (pick) => setProp("type", pick.ref), at().type),
  );

  const initShape =
    variable.type === "bool" ? "bool" : variable.type === "str" ? "text" : "num";
  const isAgg = variable.type === "list" || variable.type === "map";

  /* the INIT rows: a scalar edits one value; a list or a map edits the JSON of where it
     starts (empty means an empty container -- a declared buffer is appendable from
     birth, never UNKNOWN); an enum picks its start VARIANT; a struct edits a default
     per scalar field over the type's zero */
  const initRows: (HTMLElement | null)[] = [];
  const resolved = isStruct ? resolveTypeRef(editor.mesh, variable.type) : null;
  if (isAgg) {
    initRows.push(
      el("span", { class: "row-label", text: "INIT" }, [diagIcon(initDiags)]),
      el("div", { class: "var-line" }, [
        valueEditor(
          null,
          "text",
          variable.id + ":init",
          () => {
            const init = at().init;
            if (init === undefined || init === null || init === "") return "";
            return typeof init === "string" ? init : JSON.stringify(init);
          },
          /* the document keeps real JSON where the text parses to the right shape and
             the raw text otherwise -- the compiler's refusal is the teacher, and it
             must see what was typed */
          (value) => {
            const text = typeof value === "string" ? value.trim() : "";
            if (!text) { setProp("init", null); return; }
            try { setProp("init", JSON.parse(text)); }
            catch { setProp("init", text); }
          },
        ),
      ]),
    );
  } else if (!isStruct) {
    initRows.push(
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
    );
  } else if (resolved?.kind === "enum") {
    const names = (resolved.field?.variants ?? []).map((v) => ({ value: v.name }));
    const start = selectField(names.length ? names : [{ value: "" }],
                              typeof variable.init === "string" ? variable.init
                                                                : names[0]?.value ?? "",
                              (name) => setProp("init", name));
    bindChoice(variable.id + ":init", pickerOf(start), () =>
      typeof at().init === "string" ? String(at().init) : names[0]?.value ?? "");
    initRows.push(
      el("span", { class: "row-label", text: "INIT" }, [diagIcon(initDiags)]),
      el("div", { class: "var-line" }, [start]),
    );
  } else if (resolved?.kind === "struct") {
    /* one default per settable field, held in the init OBJECT; an untouched field
       starts at the type's zero */
    const fieldRow = (field: MeshField) => {
      const read = () => {
        const init = at().init;
        return init && typeof init === "object" ? (init as Json)[field.path] : undefined;
      };
      const commit = (value: Json) => {
        const init = at().init;
        const next = init && typeof init === "object" ? { ...(init as Json) } : {};
        next[field.path] = value;
        setProp("init", next);
      };
      let control: HTMLElement;
      if (field.variants?.length) {
        const names = field.variants.map((v) => ({ value: v.name }));
        const picker = selectField([{ value: "" }, ...names],
                                   typeof read() === "string" ? String(read()) : "",
                                   (name) => commit(name));
        bindChoice(variable.id + ":init." + field.path, pickerOf(picker), () =>
          typeof read() === "string" ? String(read()) : "");
        control = picker;
      } else if (field.shape === "num" || field.shape === "bool" ||
                 field.shape === "text") {
        control = valueEditor(
          null,
          field.shape,
          variable.id + ":init." + field.path,
          () => read() ?? null,
          commit,
          /*unknown=*/ true,
        );
      } else {
        return null;
      }
      initRows.push(
        el("span", { class: "row-label init-field", text: field.path }),
        el("div", { class: "var-line" }, [control]),
      );
      return null;
    };
    if (resolved.type.fields.length) {
      initRows.push(
        el("span", { class: "row-label", text: "INIT" }, [diagIcon(initDiags)]),
        el("div", { class: "var-line" }, [
          el("span", { class: "op", text: "defaults over the type's zero" }),
        ]),
      );
      for (const field of resolved.type.fields) fieldRow(field);
    }
  }

  /* One label column, one setting per line, so the labels stack and every control starts
     at the same x. KEEP is offered for every type. (Runtime value persistence is not
     wired up yet for ANY type; the document itself is what saves today.) */
  card.appendChild(
    el("div", { class: "card-body var-body" }, [
      el("div", { class: "var-grid" }, [
        el("span", { class: "row-label", text: "TYPE" }, [diagIcon(typeDiags)]),
        el("div", { class: "var-line" }, [type]),
        ...initRows,
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

/* The variable card: collapsed it is the name and what the variable reads right NOW, which
 * is what a variable is looked at for; open it adds the settings behind that value (TYPE,
 * INIT, KEEP). Global and instance-local cards are the same card; only the scope note differs
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
import { openMenu } from "../menu.js";
import { bind, bindChoice, bindField, bindFlag } from "../reconcile.js";
import { iconMarkup, kindMark } from "../icons.js";
import { Json, MeshField, Node, Op, SCALAR_LABEL, Var } from "../types.js";
import { valueEditor } from "./editors.js";
import { refChip } from "./refchip.js";
import { attrScope } from "./scope.js";
import { openTypeTree, resolveTypeRef } from "./typetree.js";
import { valueBox } from "./valuebox.js";

/* which cards stand open, keyed by variable id: the open bit rides varShape, so a
 * toggle rebuilds exactly that card */
const opened = makeFolds();

/* `public` and the type both decide which rows exist, so both ride the shape — and so
 * does `elem`, because elements that are ROWS bring the leaf row with them */
export function varShape(variable: Var): Json {
  return [variable.id, variable.type, String(variable.elem ?? ""),
          Boolean(variable.public), opened.open(String(variable.id))];
}

/* WHERE THE VARIABLE IS DECLARED, which is what decides whether it can be an input at
 * all: a page element is its own placement and has nothing to be public TO, while a
 * component's is storage per placement and may be part of its interface. */
export function varCard(
  editor: Editor,
  variable: Var,
  scope: "global" | "local" | "component",
  /* the element that DECLARES it — the scope its sweep expressions are read against */
  ownerId = 0,
): HTMLElement {
  const at = () => (editor.store.node(variable.id) as Var | null) ?? variable;
  const open = opened.open(String(variable.id));
  const setProp = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: variable.id, key, value }]);
  const cell = "v" + variable.id;
  const isStruct = !SCALAR_LABEL[variable.type];
  const inComp = scope === "component";
  const isPublic = inComp && Boolean(variable.public);

  const caret = el("span", {
    class: "icon-mark fold-caret",
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
  const elemDiags = editor.diagAt(variable.id, "elem");
  const leafDiags = editor.diagAt(variable.id, "leaf");
  const head = el("div", { class: "card-head" }, [
    caret,
    kindMark(scope === "global" ? "g" : "l",
             scope === "global" ? "Lives in the HMI"
             : inComp ? "The component's own, one per placement"
             : "Only visible to this element"),
    name,
    /* a folded card still says whether this is part of the interface: it is the one
       thing about a component's variable that anything outside it can see */
    isPublic ? el("span", { class: "badge", text: "input",
                            title: "every instance shows this and may set it" }) : null,
    now,
    diagIcon(open ? editor.diagAt(variable.id)
                  : editor.diagAt(variable.id)
                      .concat(initDiags, typeDiags, elemDiags, leafDiags)),
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
     mesh serves. What the document stores is the TypeRef itself. The one reference
     chip, opening the TYPE tree rather than the source tree. */
  const type = refChip({
    key: variable.id + ":type",
    name: () => SCALAR_LABEL[at().type] ?? at().type,
    title: "pick a type",
    /* a component's variable takes no timer and no mesh type: it is storage per
       placement, and neither has a per-placement form. The picker offers what the
       compiler will accept rather than teaching the rule after the fact. */
    onPick: (chip) =>
      openTypeTree(chip, editor,
                   { scalars: true, timers: !inComp, structs: !inComp, enums: !inComp },
                   (pick) => setProp("type", pick.ref), at().type),
  });

  const initShape =
    variable.type === "bool" ? "bool"
    : variable.type === "text" ? "text"
    : variable.type === "icon" ? "icon"
    : variable.type === "color" ? "color"
    : "num";
  const isAgg = variable.type === "list" || variable.type === "map";

  /* OF: list/map only — the element type the compiler enforces on appends and on
     an indexed/keyed element write. Picking `list` or `map` here says the elements are
     ROWS, which is the whole of what a nested variable is; ROWS OF then says what one
     row holds. Nesting is ONE level, so that second picker offers scalars only. */
  const ofRow: HTMLElement[] = [];
  if (isAgg) {
    const nested = variable.elem === "list" || variable.elem === "map";
    const of = selectField(
      [...ELEM_TYPES, { value: "list", label: "list" }, { value: "map", label: "map" }],
      String(variable.elem ?? ""),
      /* one apply, both keys: a leaf says what a ROW holds, so it cannot outlive the
         row that carried it (and a second apply would ride a stale version) */
      (choice) => {
        const ops: Op[] = [
          { op: "set_prop", node: variable.id, key: "elem", value: choice },
        ];
        if (choice !== "list" && choice !== "map" && at().leaf)
          ops.push({ op: "set_prop", node: variable.id, key: "leaf", value: "" });
        editor.apply(ops);
      },
    );
    bindChoice(variable.id + ":elem", pickerOf(of), () => String(at().elem ?? ""));
    ofRow.push(
      el("span", { class: "row-label", text: "OF" }, [diagIcon(elemDiags)]),
      el("div", { class: "var-line" }, [of]),
    );
    if (nested) {
      const rows = selectField(ELEM_TYPES, String(variable.leaf ?? ""),
                               (choice) => setProp("leaf", choice));
      bindChoice(variable.id + ":leaf", pickerOf(rows), () => String(at().leaf ?? ""));
      ofRow.push(
        el("span", { class: "row-label", text: "ROWS OF" }, [diagIcon(leafDiags)]),
        el("div", { class: "var-line" }, [
          rows,
          el("span", { class: "op", text: "what one row holds" }),
        ]),
      );
    }
  }

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

  /* ---- THE INTERFACE ROWS: what makes this variable an input ----
   *
   * Only inside a component, because only there is there a placement to be an input TO.
   * INPUT is the switch; everything under it describes how the instance's inspector
   * should EDIT the value, and is inert until the switch is on. */
  const publicRows: (HTMLElement | null)[] = [];
  if (inComp) {
    publicRows.push(
      el("span", { class: "row-label", text: "INPUT" }),
      el("div", { class: "var-line" }, [
        valueEditor(
          null,
          "bool",
          variable.id + ":public",
          () => Boolean(at().public),
          (value) => setProp("public", Boolean(value)),
        ),
        el("span", { class: "op", text: "every instance can set it" }),
      ]),
    );
  }
  if (isPublic) {
    /* WHICH SECTION of the instance inspector it lands in: what the control IS, how it
       looks, how it is set up, or the pane around it */
    const group = selectField(
      GROUPS.map((v) => ({ value: v })),
      String(variable.group ?? "appearance"),
      (choice) => setProp("group", choice),
    );
    bindChoice(variable.id + ":group", pickerOf(group), () =>
      String(at().group ?? "appearance"));
    publicRows.push(
      el("span", { class: "row-label", text: "SHOWN IN" }),
      el("div", { class: "var-line" }, [group]),
    );

    /* A BOUNDED NUMBER EDITS AS A SLIDER beside its field, and steps by its own grain
       rather than by 1 — the two facts a number input needs that its type cannot say. */
    if (variable.type === "num") {
      const bound = (key: "min" | "max" | "step") =>
        valueEditor(
          null,
          "num",
          variable.id + ":" + key,
          () => (at() as Json)[key] ?? null,
          (value) => setProp(key, value === "" || value === null ? null : value),
          /*unknown=*/ true,
        );
      publicRows.push(
        el("span", { class: "row-label", text: "RANGE" }),
        el("div", { class: "var-line" }, [
          bound("min"), el("span", { class: "op", text: "to" }), bound("max"),
          el("span", { class: "op", text: "by" }), bound("step"),
          sweepChip(editor, variable, ownerId, at, setProp),
          diagIcon(editor.diagAt(variable.id, "smooth").length
                     ? editor.diagAt(variable.id, "smooth")
                     : editor.diagAt(variable.id, "profile")),
        ]),
      );
    }

    /* A TEXT THAT CARRIES ITS OWN VOCABULARY is picked from it — which is the whole of
       what an "enum" property was. Written as the words themselves, comma separated. */
    if (variable.type === "text") {
      publicRows.push(
        el("span", { class: "row-label", text: "ONE OF" }),
        el("div", { class: "var-line" }, [
          valueEditor(
            null,
            "text",
            variable.id + ":variants",
            () => (at().variants ?? []).join(", "),
            (value) => {
              const words = String(value ?? "")
                .split(",").map((w) => w.trim()).filter(Boolean);
              setProp("variants", words);
            },
          ),
          el("span", { class: "op", text: "blank = any text" }),
        ]),
      );
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
        ...ofRow,
        ...initRows,
        ...publicRows,
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

/* which section of the instance inspector a public variable lands in */
const GROUPS = ["value", "appearance", "config", "frame"];

/* what ONE VALUE inside a list or a map may be — the OF picker's scalars, and the whole
 * of what a nested variable's ROWS may hold. `list` and `map` join this list on the OF
 * picker alone, because that is the one place where an element may itself be a row. */
const ELEM_TYPES = [
  { value: "", label: "anything" }, { value: "num", label: "number" },
  { value: "bool", label: "bool" }, { value: "text", label: "text" },
  { value: "icon", label: "icon" },
];

/* THE DECLARED SWEEP, number inputs only: rendered reads of this variable ease toward the
 * true value over this time — the needle, the arc and the readout all together — while
 * behavior, gestures and the wire keep reading truth. `smooth` and `profile` are
 * EXPRESSIONS over the DECLARING element's scope (which is exactly the universe attrScope
 * serves); a plain number / bare easing name is the literal. The same motion popover the
 * attr rows wear: the timer button, MS and EASE value boxes, lit while a sweep stands. */
function sweepChip(
  editor: Editor,
  variable: Var,
  ownerId: number,
  at: () => Var,
  setProp: (key: string, value: Json) => void,
): HTMLElement {
  const shown = (v: number | string | null | undefined) =>
    typeof v === "number" ? (v > 0 ? String(v) : "") : (v ?? "");
  const sweeping = () => {
    const held = at().smooth;
    return typeof held === "number" ? held > 0 : Boolean(held);
  };
  const chip = iconButton("timer", "sweep: rendered reads of this input ease toward a new "
                                   + "value (the value itself is never eased)", () => {
    const rect = chip.getBoundingClientRect();
    const held = sweeping();
    const scope = attrScope(editor, (editor.store.node(ownerId) ?? { id: ownerId }) as Node);
    const ms = valueBox({
      key: variable.id + ":smooth",
      read: () => shown(at().smooth),
      commit: (text) => {
        const trimmed = text.trim();
        const folded = Number(trimmed);
        setProp("smooth", !trimmed ? 0 : Number.isFinite(folded) ? folded : trimmed);
      },
      emptyMeans: "unset",
      placeholder: "none",
      title: "milliseconds — a number or an expression over this component; empty = none",
      type: { shape: "num" },
      scope,
    });
    const profile = valueBox({
      key: variable.id + ":profile",
      read: () => at().profile || "",
      commit: (text) => setProp("profile", text.trim()),
      emptyMeans: "unset",
      placeholder: "ease",
      title: "linear, ease, ease-in, ease-out or ease-in-out — or an expression "
             + "yielding one",
      type: { shape: "text" },
      scope,
    });
    openMenu(rect.left, rect.bottom + 4, "sweep " + at().name, [
      { node: el("div", { class: "menu-field" },
                 [el("span", { class: "row-label", text: "MS" }), ms]) },
      { node: el("div", { class: "menu-field" },
                 [el("span", { class: "row-label", text: "EASE" }), profile]) },
      ...(held ? [{ label: "remove the sweep", icon: "trash", run: () =>
          editor.apply([{ op: "set_prop", node: variable.id, key: "smooth", value: 0 },
                        { op: "set_prop", node: variable.id, key: "profile", value: "" }]) }]
               : []),
    ]);
  });
  chip.classList.add("transition-chip");
  if (sweeping()) chip.classList.add("on");
  bindFlag(variable.id + ":sweep.on", chip, "on", sweeping);
  return chip;
}

/* a fresh name that is free in this scope */
export function newVariable(editor: Editor, parent: number, list: string, taken: Var[]): void {
  const names = new Set(taken.map((v) => v.name));
  let n = 1;
  while (names.has("var" + n)) n++;
  editor.apply([{ op: "insert", parent, list, node: { name: "var" + n, type: "num", init: 0 } }]);
}

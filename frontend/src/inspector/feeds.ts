/* A feed is ONE LINE, sitting under the slot it fills: the source picked from
 * the tree (which carries kind, name, path and type in one act), then the transform, then
 * the poll rate where the source is a function. The slot itself is said by WHERE the line
 * sits, so the line does not restate it. There is nothing to fold: the line is the
 * editor, it never wraps, and content squishes rather than reflowing the sidebar.
 *
 * "+ case" graduates the one transform into CONDITIONAL arms: the expression
 * moves onto its own row, each row a condition over x and its expression, first match
 * wins, with the feed's own xf standing as the else. There is no value matching: a
 * condition (`x == .run`, `x > 40`) says everything a picked value said and more.
 *
 * The line's SHAPE is which controls exist: the source kind, and how many case rows.
 * The names, paths, conditions and rates inside are values, pushed in place. */

import { chip, commitInput, el, iconButton, numberInput } from "../dom.js";
import { diagIcon, Editor } from "../editor.js";
import { iconMarkup } from "../icons.js";
import { bindField } from "../reconcile.js";
import { Feed, Json, SlotSpec, Node, WidgetType } from "../types.js";
import { attachAutocomplete, exprContext, feedX } from "./autocomplete.js";
import { sourceField, valueEditor } from "./editors.js";
import { highlighted } from "../highlight.js";

/* a result cell's chosen mode, per view like folds; unset = decide from the text */
const resultMode = new Map<string, "expr" | "value">();

/* A result literal: the value a native picker edits IS an expression literal, so the
 * document stays expression-only and the picker is sugar over it. `undefined` = the
 * text is a real expression (or unparseable), so only the expression editor fits. */
function literalOf(shape: string, text: string): Json | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (shape === "color")
    return /^#[0-9a-fA-F]{3,8}$/.test(trimmed) ? trimmed : undefined;
  if (shape === "bool")
    return trimmed === "true" ? true : trimmed === "false" ? false : undefined;
  if (shape === "num") {
    const numeric = Number(trimmed);
    return /^[-+0-9.eE]+$/.test(trimmed) && Number.isFinite(numeric) ? numeric : undefined;
  }
  /* text / enum / align: a quoted literal */
  const quoted = /^"((?:\\.|[^"\\])*)"$/.exec(trimmed);
  return quoted ? quoted[1].replace(/\\(.)/g, "$1") : undefined;
}

function literalText(shape: string, value: Json): string {
  if (value === null || value === undefined) return "";
  if (shape === "color" || shape === "bool" || shape === "num") return String(value);
  return '"' + String(value).replace(/(["\\])/g, "\\$1") + '"';
}

/* the shapes with a native picker worth offering */
function pickable(spec: SlotSpec | undefined): boolean {
  if (!spec) return false;
  return spec.shape === "color" || spec.shape === "bool" || spec.shape === "num" ||
         spec.shape === "enum" || spec.editor === "align";
}

export function feedShape(feed: Feed): Json {
  return [feed.id, feed.slot, feed.src?.kind ?? "V", (feed.cases ?? []).length];
}

export function feedCard(editor: Editor, widget: Node, type: WidgetType | null, feed: Feed): HTMLElement {
  const at = () => (editor.store.node(feed.id) as Feed | null) ?? feed;
  const set = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: feed.id, key, value }]);
  const isFunction = feed.src?.kind === "F";
  const cases = feed.cases ?? [];
  void type;

  const source = sourceField(
    feed.id + ":src",
    editor,
    widget,
    /* an entity is also pickable WHOLE (path ""): the transform then reads x.<field>,
       which is how a color struct comes in as a color */
    { fields: true, hmi: true, wholeEntity: true },
    () => ({ ref: at().src, path: at().path }),
    /* one pick, one batch: the source and the field land together, and the value type
       follows from what was picked rather than a dropdown */
    (pick) =>
      editor.apply([
        { op: "set_prop", node: feed.id, key: "src",
          value: { kind: pick.family === "local" ? "L" : pick.kind, name: pick.name } },
        { op: "set_prop", node: feed.id, key: "path", value: pick.path },
      ]),
  );

  const xfInput = (key: string, read: () => string, commit: (text: string) => void,
                   placeholder: string) => {
    const input = commitInput(read(), commit, { class: "field grow", placeholder });
    bindField(key, input, read);
    /* a feed's transform is DISPLAY tier: the full formatting vocabulary */
    attachAutocomplete(input, exprContext(editor, widget, "display", feedX(editor, widget, at)));
    return highlighted(input);
  };

  /* A RESULT cell: the slot's native picker where the text is a plain literal (a color
     swatch beats typing hex), the expression editor for everything else, a button
     between the two. Picking writes the LITERAL as the expression. The else prefers
     the expression editor while EMPTY, so "passes through" stays readable. */
  const spec = (type?.slots ?? []).find((s) => s.name === feed.slot);
  const resultCell = (key: string, read: () => string, commit: (text: string) => void,
                      placeholder = "expression", emptyExpr = false): HTMLElement => {
    const cell = el("span", { class: "case-result" });
    const render = () => {
      cell.innerHTML = "";
      const text = read();
      const literal = spec ? literalOf(spec.shape, text) : undefined;
      const override = resultMode.get(key);
      const valued = pickable(spec) && literal !== undefined && override !== "expr" &&
                     (override === "value" || text.trim() !== "" || !emptyExpr);
      if (valued) {
        cell.appendChild(valueEditor(
          spec!, spec!.shape, key + ".value",
          () => literalOf(spec!.shape, read()) ?? null,
          (value) => commit(literalText(spec!.shape, value)),
          /*unknown=*/ true, editor));
        cell.appendChild(iconButton("pencil", "write an expression instead", () => {
          resultMode.set(key, "expr");
          render();
        }));
      } else {
        cell.appendChild(xfInput(key, read, commit, placeholder));
        if (pickable(spec))
          cell.appendChild(iconButton("check", "pick a value instead", () => {
            resultMode.set(key, "value");
            if (spec && literalOf(spec.shape, read()) === undefined) commit("");
            render();
          }));
      }
    };
    render();
    return cell;
  };

  const rate = isFunction
    ? numberInput(feed.poll_hz ?? 2, (hz) => set("poll_hz", hz), { class: "field num" })
    : null;
  if (rate) bindField(feed.id + ":poll_hz", rate, () => String(at().poll_hz ?? 2));

  /* "+ case": the FIRST one carries the standing expression onto its own row */
  const addCase = iconButton("plus", "add a conditional case", () => {
    const held = at();
    const list = (held.cases ?? []).slice();
    if (!list.length) {
      editor.apply([
        { op: "set_prop", node: feed.id, key: "cases",
          value: [{ test: "", xf: held.xf ?? "" }] },
        { op: "set_prop", node: feed.id, key: "xf", value: "" },
      ]);
      return;
    }
    list.push({ test: "", xf: "" });
    set("cases", list);
  });

  const line = el("div", { class: "feed-line" }, [
    /* the feed sits UNDER the slot it fills, so the arrow points back up at it */
    el("span", { class: "arrow", html: iconMarkup("arrow-up", 10, 1.5) }),
    source,
    ...(cases.length
      ? []
      : [el("span", { class: "op", text: "f" }),
         xfInput(feed.id + ":xf", () => at().xf ?? "",
                 (text) => set("xf", text), "expression")]),
    rate ? el("span", { class: "op", text: "at" }) : null,
    rate,
    rate ? el("span", { class: "op", text: "Hz" }) : null,
    addCase,
    diagIcon(cases.length
      ? editor.diagAt(feed.id).concat(editor.diagAt(feed.id, "src"),
                                      editor.diagAt(feed.id, "path"),
                                      editor.diagAt(feed.id, "slot"))
      : editor.diagNode(feed.id)),
    iconButton("x", "remove this feed", () =>
      editor.apply([{ op: "remove", node: feed.id }]),
    ),
  ]);
  if (!cases.length) return line;

  /* the case rows: condition column, expression column; the else is the feed's xf */
  const block = el("div", { class: "feed-block" }, [line]);
  type Case = { test?: string; xf: string };
  const editCase = (index: number, next: Case) => {
    const list = ((at().cases ?? []) as Case[]).slice();
    if (index >= list.length) return;
    list[index] = next;
    set("cases", list);
  };
  const heldCase = (index: number): Case => (at().cases ?? [])[index] ?? { xf: "" };

  cases.forEach((entry, index) => {
    const key = feed.id + ":case" + index;
    const test = commitInput(entry.test ?? "", (text) =>
      editCase(index, { test: text, xf: heldCase(index).xf }),
      { class: "field grow", placeholder: "condition" });
    bindField(key + ".test", test, () => String(heldCase(index).test ?? ""));
    attachAutocomplete(test,
      exprContext(editor, widget, "display", feedX(editor, widget, at)));
    block.appendChild(
      el("div", { class: "feed-case" }, [
        highlighted(test, "when"),
        el("span", { class: "arrow", html: iconMarkup("arrow-right", 10, 1.5) }),
        resultCell(key + ".xf", () => String(heldCase(index).xf ?? ""),
                   (text) => editCase(index, { ...heldCase(index), xf: text })),
        diagIcon(editor.diagAt(feed.id, "case" + index)),
        iconButton("x", "remove this case", () => {
          const list = ((at().cases ?? []) as Json[]).slice();
          list.splice(index, 1);
          set("cases", list);
        }),
      ]),
    );
  });
  block.appendChild(
    el("div", { class: "feed-case" }, [
      chip("else", "ghost-chip"),
      el("span", { class: "arrow", html: iconMarkup("arrow-right", 10, 1.5) }),
      resultCell(feed.id + ":xf", () => at().xf ?? "",
                 (text) => set("xf", text), "passes through", /*emptyExpr=*/ true),
      diagIcon(editor.diagAt(feed.id, "xf").concat(editor.diagAt(feed.id, "cases"))),
    ]),
  );
  return block;
}

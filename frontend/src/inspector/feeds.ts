/* A feed is ONE LINE (spec 3.3), sitting under the slot it fills: the source picked from
 * the tree (which carries kind, name, path and type in one act), then the transform, then
 * the poll rate where the source is a function. The slot itself is said by WHERE the line
 * sits, so the line does not restate it. There is nothing to fold: the line is the
 * editor, it never wraps, and content squishes rather than reflowing the sidebar.
 *
 * "+ case" graduates the one transform into PATTERN MATCHING (spec 2.4): the expression
 * moves onto its own row, each row gaining a condition column (a variant dropdown when
 * the source is an enum, so the vocabulary is picked, never typed) and an expression
 * column, with the feed's own xf standing as the else. Coverage is the compiler's check;
 * the rows just carry its findings.
 *
 * The line's SHAPE is which controls exist: the source kind, and how many case rows.
 * The names, paths, conditions and rates inside are values, pushed in place. */

import { chip, commitInput, el, iconButton, numberInput, pickerOf, selectField } from "../dom.js";
import { diagIcon, Editor } from "../editor.js";
import { iconMarkup } from "../icons.js";
import { bindChoice, bindField } from "../reconcile.js";
import { Feed, Json, Widget, WidgetType } from "../types.js";
import { attachAutocomplete, exprContext, feedX } from "./autocomplete.js";
import { sourceField } from "./editors.js";
import { highlighted } from "../highlight.js";

export function feedShape(feed: Feed): Json {
  return [feed.id, feed.slot, feed.src?.kind ?? "V", (feed.cases ?? []).length];
}

/* the enum vocabulary behind the feed's source, when it has one */
function sourceVariants(
  editor: Editor,
  feed: () => Feed,
): { name: string; value: number }[] {
  const at = feed();
  if (!at.src?.name || at.src.kind === "L") return [];
  const entity = editor.mesh.entities.find(
    (e) => e.kind === at.src.kind && e.name === at.src.name,
  );
  const fields = entity?.kind === "F" ? entity.returns ?? [] : entity?.fields ?? [];
  const field = at.path ? fields.find((f) => f.path === at.path)
                        : fields.length === 1 ? fields[0] : undefined;
  return field?.variants ?? [];
}

export function feedCard(editor: Editor, widget: Widget, type: WidgetType | null, feed: Feed): HTMLElement {
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
    { fields: true, hmi: true },
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

  const rate = isFunction
    ? numberInput(feed.poll_hz ?? 2, (hz) => set("poll_hz", hz), { class: "field num" })
    : null;
  if (rate) bindField(feed.id + ":poll_hz", rate, () => String(at().poll_hz ?? 2));

  /* "+ case": the FIRST one carries the standing expression onto its own row */
  const addCase = iconButton("plus", "add a case (pattern match on the value)", () => {
    const held = at();
    const list = (held.cases ?? []).slice();
    if (!list.length) {
      editor.apply([
        { op: "set_prop", node: feed.id, key: "cases",
          value: [{ when: null, xf: held.xf ?? "" }] },
        { op: "set_prop", node: feed.id, key: "xf", value: "" },
      ]);
      return;
    }
    list.push({ when: null, xf: "" });
    set("cases", list);
  });

  const line = el("div", { class: "feed-line" }, [
    el("span", { class: "arrow", html: iconMarkup("arrow-left", 10, 1.5) }),
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
  const editCase = (index: number, patch: Partial<{ when: Json; xf: string }>) => {
    const list = ((at().cases ?? []) as { when: Json; xf: string }[]).slice();
    if (index >= list.length) return;
    list[index] = { ...list[index], ...patch };
    set("cases", list);
  };
  const variants = sourceVariants(editor, at);

  cases.forEach((entry, index) => {
    const key = feed.id + ":case" + index;
    let when: HTMLElement;
    if (variants.length) {
      const options = [{ value: "" }, ...variants.map((v) => ({ value: v.name }))];
      const picker = selectField(options,
                                 typeof entry.when === "string" ? entry.when : "",
                                 (name) => editCase(index, { when: name }));
      bindChoice(key + ".when", pickerOf(picker), () => {
        const held = (at().cases ?? [])[index]?.when;
        return typeof held === "string" ? held : "";
      });
      when = picker;
    } else {
      /* free scalar: a number stays a number, true/false a bool, the rest text */
      const input = commitInput(
        entry.when === null || entry.when === undefined ? "" : String(entry.when),
        (text) => {
          const trimmed = text.trim();
          const numeric = Number(trimmed);
          editCase(index, {
            when: trimmed === "" ? null
              : trimmed === "true" ? true
              : trimmed === "false" ? false
              : Number.isFinite(numeric) && trimmed !== "" && !Number.isNaN(numeric) &&
                /^[-+0-9.eE]+$/.test(trimmed) ? numeric
              : trimmed,
          });
        },
        { class: "field num", placeholder: "value" });
      bindField(key + ".when", input, () => {
        const held = (at().cases ?? [])[index]?.when;
        return held === null || held === undefined ? "" : String(held);
      });
      when = input;
    }
    block.appendChild(
      el("div", { class: "feed-case" }, [
        when,
        el("span", { class: "arrow", html: iconMarkup("arrow-right", 10, 1.5) }),
        xfInput(key + ".xf",
                () => String((at().cases ?? [])[index]?.xf ?? ""),
                (text) => editCase(index, { xf: text }), "expression"),
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
      xfInput(feed.id + ":xf", () => at().xf ?? "",
              (text) => set("xf", text), "passes through"),
      diagIcon(editor.diagAt(feed.id, "xf").concat(editor.diagAt(feed.id, "cases"))),
    ]),
  );
  return block;
}

/* Feed cards (spec 3.3): collapsed, a feed reads as one right-to-left sentence; open, it
 * is a numbered grid of the steps a value takes to reach the slot. Same document node
 * either way, so the collapsed form summarizes identity and the open form exposes fields:
 * there is no third representation.
 *
 * The card's SHAPE is which rows it has: whether it is open, which source kind it names
 * (a function polls, so it grows a rate field), and whether it carries a transform at all.
 * The names, paths and rates inside those rows are values, pushed in place, so editing one
 * field never rebuilds the sentence above it. */

import { chip, commitInput, el, numberInput, pickerOf, selectField } from "../dom.js";
import { diagIcon, Editor } from "../editor.js";
import { iconMarkup } from "../icons.js";
import { bind, bindChoice, bindField, bindText } from "../reconcile.js";
import { Feed, Json, Widget, WidgetType } from "../types.js";
import { attachAutocomplete, attachPathAutocomplete, exprContext, feedPaths, feedX } from "./autocomplete.js";
import { entityChip, sourceField } from "./editors.js";

const opened = new Set<number>();
const XF_CHIP_MAX = 14;   /* expression characters the collapsed head shows before "..." */

export function feedShape(feed: Feed): Json {
  return [feed.id, feed.slot, opened.has(feed.id), feed.src?.kind ?? "V", Boolean(feed.xf)];
}

export function feedCard(editor: Editor, widget: Widget, type: WidgetType | null, feed: Feed): HTMLElement {
  const at = () => (editor.store.node(feed.id) as Feed | null) ?? feed;
  const open = opened.has(feed.id);
  const set = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: feed.id, key, value }]);
  const isFunction = feed.src?.kind === "F";

  const caret = el("span", {
    class: "arrow",
    html: iconMarkup("chevron-down", 10, 2),
    style: open ? "" : "transform:rotate(-90deg)",
  });

  const slotChip = chip("", "slot");
  bindText(feed.id + ":slot.chip", slotChip, () => at().slot || "slot");
  /* the head says WHICH steps a value takes, not what they contain: an expression runs to
     any length, so the chip shows its head and the whole of it stays on row 3 (and in the
     hover title, so the collapsed card can still be read without opening it) */
  const xfChip = feed.xf ? chip("", "xf") : null;
  if (xfChip)
    bind(feed.id + ":xf.chip", xfChip, () => {
      const text = (at().xf ?? "").trim();
      const cut = text.length > XF_CHIP_MAX ? text.slice(0, XF_CHIP_MAX).trimEnd() + "..." : text;
      if (xfChip.textContent !== "f " + cut) xfChip.textContent = "f " + cut;
      if (xfChip.title !== text) xfChip.title = text;
    });
  const rateChip = isFunction ? chip("", "timer") : null;
  if (rateChip)
    bindText(feed.id + ":poll.chip", rateChip, () =>
      at().poll_hz ? at().poll_hz + " Hz" : "",
    );

  /* Findings live on the LINE they name: the source row ("src"), the path row ("path"),
     the transform row ("xf") and the slot picker ("slot"). Collapsed, those rows do not
     exist, so the head carries the rollup; open, it keeps only what has no better row
     (and the slot finding when the one-slot card shows no slot picker). */
  const slotDiags = editor.diagAt(feed.id, "slot");
  const slots = (type?.slots ?? []).filter((s) => s.group === "value");
  const headDiags = open
    ? editor.diagAt(feed.id).concat(slots.length > 1 ? [] : slotDiags)
    : editor
        .diagAt(feed.id)
        .concat(slotDiags, editor.diagAt(feed.id, "src"), editor.diagAt(feed.id, "path"),
                editor.diagAt(feed.id, "xf"));
  const head = el("div", { class: "card-head" }, [
    caret,
    diagIcon(headDiags),
    slotChip,
    el("span", { class: "arrow", html: iconMarkup("arrow-left", 10, 1.5) }),
    xfChip,
    xfChip ? el("span", { class: "arrow", html: iconMarkup("arrow-left", 10, 1.5) }) : null,
    entityChip(feed.id + ":src.chip", () => ({ ref: at().src, path: at().path }), editor, widget),
    rateChip,
  ]);

  const card = el("div", { class: "card" + (open ? " open" : "") }, [head]);
  head.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest("input, select, button")) return;
    if (open) opened.delete(feed.id);
    else opened.add(feed.id);
    editor.refresh();
  });
  if (!open) return card;

  const body = el("div", { class: "card-body" }, []);
  const row = (label: string, cells: (HTMLElement | null)[]) => {
    body.appendChild(el("span", { class: "row-num", text: label }));
    body.appendChild(el("div", { class: "row" }, cells));
  };

  if (slots.length > 1) {
    const picker = selectField(
      slots.map((s) => ({ value: s.name })),
      feed.slot,
      (slot) => set("slot", slot),
    );
    bindChoice(feed.id + ":slot", pickerOf(picker), () => at().slot ?? "");
    row("", [diagIcon(slotDiags), el("span", { class: "kw", text: "slot" }), picker]);
  }

  const rate = isFunction
    ? numberInput(feed.poll_hz ?? 2, (hz) => set("poll_hz", hz), { class: "field num" })
    : null;
  if (rate) bindField(feed.id + ":poll_hz", rate, () => String(at().poll_hz ?? 2));

  row("1", [
    diagIcon(editor.diagAt(feed.id, "src")),
    el("span", { class: "kw", text: "msg =" }),
    sourceField(
      feed.id + ":src",
      editor,
      widget,
      { fields: true, hmi: true },
      () => ({ ref: at().src, path: at().path }),
      /* one pick, one batch: the source and the field land together, and the value
         type follows from what was picked rather than a dropdown */
      (pick) =>
        editor.apply([
          { op: "set_prop", node: feed.id, key: "src", value: { kind: pick.kind, name: pick.name } },
          { op: "set_prop", node: feed.id, key: "path", value: pick.path },
        ]),
    ),
    isFunction ? el("span", { class: "op", text: "polled at" }) : null,
    rate,
    isFunction ? el("span", { class: "op", text: "Hz" }) : null,
  ]);

  const path = commitInput(feed.path ?? "", (text) => set("path", text), {
    class: "field grow",
    placeholder: "value",
    title: "Dotted path into the payload",
  });
  bindField(feed.id + ":path", path, () => at().path ?? "");
  /* completing here IS completing on msg: the source's reflected field paths */
  attachPathAutocomplete(path, feedPaths(editor, at));
  row("2", [
    diagIcon(editor.diagAt(feed.id, "path")),
    el("span", { class: "kw", html: 'x = <span style="color:#7fc4a0">msg.</span>' }),
    path,
  ]);

  const xf = commitInput(feed.xf ?? "", (text) => set("xf", text), {
    class: "field grow",
    placeholder: "x",
    title: "Formatting expression, evaluated on the backend",
  });
  bindField(feed.id + ":xf", xf, () => at().xf ?? "");
  /* a feed's transform is DISPLAY tier: the full formatting vocabulary */
  attachAutocomplete(xf, exprContext(editor, widget, "display", feedX(editor, widget, at)));
  row("3", [
    diagIcon(editor.diagAt(feed.id, "xf")),
    el("span", { class: "kw", text: "x =" }),
    el("span", { class: "op", text: "f" }),
    xf,
  ]);

  card.appendChild(body);
  card.appendChild(
    el("div", { class: "card-foot" }, [
      el("button", {
        text: "remove",
        onclick: () => editor.apply([{ op: "remove", node: feed.id }]),
      }),
    ]),
  );
  return card;
}

/* A feed is ONE LINE (spec 3.3), sitting under the slot it fills: the source picked from
 * the tree (which carries kind, name, path and type in one act), then the transform, then
 * the poll rate where the source is a function. The slot itself is said by WHERE the line
 * sits, so the line does not restate it. There is nothing to fold: the line is the
 * editor, it never wraps, and content squishes rather than reflowing the sidebar.
 *
 * The line's SHAPE is which controls exist: the source kind (a function polls, so it
 * grows a rate field). The names, paths and rates inside are values, pushed in place. */

import { commitInput, el, iconButton, numberInput } from "../dom.js";
import { diagIcon, Editor } from "../editor.js";
import { iconMarkup } from "../icons.js";
import { bindField } from "../reconcile.js";
import { Feed, Json, Widget, WidgetType } from "../types.js";
import { attachAutocomplete, exprContext, feedX } from "./autocomplete.js";
import { sourceField } from "./editors.js";

export function feedShape(feed: Feed): Json {
  return [feed.id, feed.slot, feed.src?.kind ?? "V"];
}

export function feedCard(editor: Editor, widget: Widget, type: WidgetType | null, feed: Feed): HTMLElement {
  const at = () => (editor.store.node(feed.id) as Feed | null) ?? feed;
  const set = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: feed.id, key, value }]);
  const isFunction = feed.src?.kind === "F";
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

  const xf = commitInput(feed.xf ?? "", (text) => set("xf", text), {
    class: "field grow",
    placeholder: "x",
    title: "Transform, evaluated on the backend; empty passes the value through",
  });
  bindField(feed.id + ":xf", xf, () => at().xf ?? "");
  /* a feed's transform is DISPLAY tier: the full formatting vocabulary */
  attachAutocomplete(xf, exprContext(editor, widget, "display", feedX(editor, widget, at)));

  const rate = isFunction
    ? numberInput(feed.poll_hz ?? 2, (hz) => set("poll_hz", hz), { class: "field num" })
    : null;
  if (rate) bindField(feed.id + ":poll_hz", rate, () => String(at().poll_hz ?? 2));

  return el("div", { class: "feed-line" }, [
    el("span", { class: "arrow", html: iconMarkup("arrow-left", 10, 1.5) }),
    source,
    el("span", { class: "op", text: "f" }),
    xf,
    rate ? el("span", { class: "op", text: "at" }) : null,
    rate,
    rate ? el("span", { class: "op", text: "Hz" }) : null,
    diagIcon(editor.diagNode(feed.id)),
    iconButton("x", "remove this feed", () =>
      editor.apply([{ op: "remove", node: feed.id }]),
    ),
  ]);
}

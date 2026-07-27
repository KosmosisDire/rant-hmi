/* Feed cards (spec 3.3): collapsed, a feed reads as one right-to-left sentence; open, it
 * is a numbered grid of the steps a value takes to reach the slot. Same document node
 * either way, so the collapsed form summarizes identity and the open form exposes fields:
 * there is no third representation. */

import { chip, commitInput, el, numberInput, selectField } from "../dom.js";
import { Editor } from "../editor.js";
import { iconMarkup } from "../icons.js";
import { Feed, Json, Widget, WidgetType } from "../types.js";
import { entityChip, entityRefEditor } from "./editors.js";

const opened = new Set<number>();

export function feedCard(editor: Editor, _widget: Widget, type: WidgetType | null, feed: Feed): HTMLElement {
  const open = opened.has(feed.id);
  const set = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: feed.id, key, value }]);
  const isFunction = feed.src?.kind === "F";

  const caret = el("span", {
    class: "arrow",
    html: iconMarkup("chevron-down", 10, 2),
    style: open ? "" : "transform:rotate(-90deg)",
  });
  const head = el("div", { class: "card-head" }, [
    caret,
    chip(feed.slot || "slot", "slot"),
    el("span", { class: "arrow", html: iconMarkup("arrow-left", 10, 1.5) }),
    feed.xf ? chip("f " + feed.xf, "xf") : null,
    feed.xf ? el("span", { class: "arrow", html: iconMarkup("arrow-left", 10, 1.5) }) : null,
    entityChip(feed.src, feed.path),
    isFunction && feed.poll_hz ? chip(feed.poll_hz + " Hz", "timer") : null,
  ]);

  const card = el("div", { class: "card" + (open ? " open" : "") }, [head]);
  head.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest("input, select, button")) return;
    if (open) opened.delete(feed.id);
    else opened.add(feed.id);
    editor.refresh();
  });
  if (!open) return card;

  const slots = (type?.slots ?? []).filter((s) => s.group === "value");
  const body = el("div", { class: "card-body" }, []);
  const row = (label: string, cells: (HTMLElement | null)[]) => {
    body.appendChild(el("span", { class: "row-num", text: label }));
    body.appendChild(el("div", { class: "row" }, cells));
  };

  if (slots.length > 1)
    row("", [
      el("span", { class: "kw", text: "slot" }),
      selectField(
        slots.map((s) => ({ value: s.name })),
        feed.slot,
        (slot) => set("slot", slot),
      ),
    ]);

  row("1", [
    el("span", { class: "kw", text: "msg =" }),
    entityRefEditor(feed.src, (src) => set("src", src)),
    isFunction ? el("span", { class: "op", text: "polled at" }) : null,
    isFunction
      ? numberInput(feed.poll_hz ?? 2, (hz) => set("poll_hz", hz), { class: "field num" })
      : null,
    isFunction ? el("span", { class: "op", text: "Hz" }) : null,
  ]);

  row("2", [
    el("span", { class: "kw", html: 'x = <span style="color:#7fc4a0">msg.</span>' }),
    commitInput(feed.path ?? "", (path) => set("path", path), {
      class: "field grow",
      placeholder: "value",
      title: "Dotted path into the payload",
    }),
  ]);

  row("3", [
    el("span", { class: "kw", text: "x =" }),
    el("span", { class: "op", text: "f" }),
    commitInput(feed.xf ?? "", (xf) => set("xf", xf), {
      class: "field grow",
      placeholder: "x",
      title: "Formatting expression, evaluated on the backend",
    }),
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

/* one feed per slot, so the button offers the first slot that has none */
export function addFeedButton(editor: Editor, widget: Widget, type: WidgetType | null): HTMLElement | null {
  const slots = (type?.slots ?? []).filter((s) => s.group === "value");
  const used = new Set((widget.feeds ?? []).map((f) => f.slot));
  const free = slots.find((s) => !used.has(s.name));
  if (!free) return null;
  return el("button", {
    class: "dashed-btn",
    text: "+ Source",
    onclick: () => {
      editor.apply([
        {
          op: "insert",
          parent: widget.id,
          list: "feeds",
          node: { slot: free.name, src: { kind: "V", name: "" }, path: "", xf: "" },
        },
      ]);
    },
  });
}

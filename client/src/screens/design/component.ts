// A component made from elements on a page: the names their values read become inputs the
// instance binds, and their handlers become events the instance handles, so nothing changes.

import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Input } from "../../protocol/Input";
import type { Page } from "../../protocol/Page";
import { isPercent } from "../../state/bind";
import { notify, state } from "../../state/store";
import { paint } from "../../ui/highlight";
import { boxOf, childrenOf, literal, parentOf, roomOf, sendEdits, tops } from "./tree";

/** A name's words joined, each after the first with a capital: "Start stop" gives startStop. */
function joined(text: string, first: (w: string) => string): string {
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((w, n) => (n === 0 ? first(w) : w[0].toUpperCase() + w.slice(1))).join("");
}

/** The first of `base`, base2, base3 that `taken` leaves free. */
function free(base: string, taken: (name: string) => boolean): string {
  let name = base;
  for (let n = 2; taken(name); n++) name = `${base}${n}`;
  return name;
}

/** As the backend spells a page's id from its name. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Every element in the trees, outermost first. */
function each(elements: Element[]): Element[] {
  return elements.flatMap((e) => [e, ...each(e.children)]);
}

/** Replaces the selected elements of a page with an instance of a new component holding them. */
export function makeComponent(page: Page, ids: string[]) {
  const picked = tops(page, ids);
  if (picked.length === 0) return;
  const parent = parentOf(page, picked[0].id);
  if (picked.some((e) => parentOf(page, e.id) !== parent)) return notify("Pick elements that sit in one frame to make a component of them.", "warn");
  if (!picked.every((e) => literal(e, ["x", "y", "w", "h"]))) return notify("A component is made of elements placed by plain numbers or percents.", "warn");

  const boxes = picked.map((e) => boxOf(e, roomOf(page, e.id)));
  const [left, top] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
  const [right, bottom] = [Math.max(...boxes.map((b) => b.x + b.w)), Math.max(...boxes.map((b) => b.y + b.h))];
  const parts: Element[] = JSON.parse(JSON.stringify(picked));
  // in pixels, since a percent of the page would mean a share of the component instead
  parts.forEach((e, i) => {
    e.props.x = String(boxes[i].x - left);
    e.props.y = String(boxes[i].y - top);
    if (isPercent(e.props.w)) e.props.w = String(boxes[i].w);
    if (isPercent(e.props.h)) e.props.h = String(boxes[i].h);
  });

  // each page name a value reads becomes an input, two way when an input element takes it
  const inputs: Input[] = [];
  const renamed = new Map<string, string>();
  for (const e of each(parts)) {
    for (const [key, value] of Object.entries(e.props)) {
      if (key === "name" || value === undefined) continue;
      e.props[key] = paint(value)
        .map(([text, kind]) => {
          if (kind === null || kind === "kw" || kind === "str" || kind === "com" || text.startsWith("$")) return text;
          let to = renamed.get(text);
          if (!to) {
            to = free(joined(text, (w) => w[0].toLowerCase() + w.slice(1)) || "value", (n) => ["name", "x", "y", "w", "h", "text"].includes(n) || inputs.some((i) => i.name === n));
            renamed.set(text, to);
            inputs.push({ name: to, default: "0", bindable: false });
          }
          return to;
        })
        .join("");
      if (e.tag === "input" && key === "value") {
        const own = inputs.find((i) => i.name === e.props.value?.trim());
        if (own) own.bindable = true;
      }
    }
  }

  // each handler becomes an event the part sends, handled by the instance as it was
  const events: string[] = [];
  const handlers: Element["handlers"] = [];
  for (const e of each(parts)) {
    e.handlers = e.handlers.map((h) => {
      const event = free(joined(`${e.props.name ?? "part"} ${h.event}`, (w) => w.toLowerCase()), (n) => events.includes(n));
      events.push(event);
      handlers.push({ event, code: h.code, ms: "" });
      return { ...h, code: `emit("${event}", p);` };
    });
  }

  const name = free(joined(picked[0].props.name ?? "", (w) => w[0].toUpperCase() + w.slice(1)).replace(/^[^A-Z]+/, "") || "Part", (n) => state.pages.some((p) => p.interface !== null && p.name === n));
  const id = free(slug(name), (n) => state.pages.some((p) => p.id === n));
  const component: Page = { id, name, width: right - left, height: bottom - top, shows: "full", fill: "", interface: { inputs, events, variables: [] }, children: parts };
  const instance: Element = {
    id: "",
    tag: "use",
    component: name,
    props: { name, x: String(left), y: String(top), w: String(right - left), h: String(bottom - top), ...Object.fromEntries([...renamed].map(([from, to]) => [to, from])) },
    handlers,
    children: [],
  };
  // the instance goes where the front most of them stood
  const places = picked.map((e) => childrenOf(page, parent).findIndex((c) => c.id === e.id));
  const index = Math.max(...places) - (picked.length - 1);
  const edits: Edit[] = [
    { kind: "put_page", page: component },
    ...picked.map((e): Edit => ({ kind: "remove_element", page: page.id, id: e.id })),
    { kind: "add_element", page: page.id, parent, index, element: instance },
  ];
  sendEdits(edits);
}

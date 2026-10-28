// A component made from elements on a page: the names their values read become inputs the
// instance binds, and their handlers become events the instance handles, so nothing changes.

import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Input } from "../../protocol/Input";
import type { Page } from "../../protocol/Page";
import { isPercent } from "../../state/bind";
import { freeName, named } from "../../state/names";
import { notify, state } from "../../state/store";
import { type Paint, paint } from "../../ui/highlight";
import { leaves } from "../../page/PageView";
import { boxOf, boxText, childrenOf, literal, parentOf, roomOf, sendEdits, tops } from "./tree";

/** A name's words joined, each after the first with a capital: "Start stop" gives startStop. */
function joined(text: string, first: (w: string) => string): string {
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((w, n) => (n === 0 ? first(w) : w[0].toUpperCase() + w.slice(1))).join("");
}

/** As the backend spells a page's id from its name. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Painted runs with each object, its dot and its member joined, so `Line.Speed` reads as one. */
function keyed(runs: [string, Paint][]): [string, Paint][] {
  const out: [string, Paint][] = [];
  for (const run of runs) {
    const [object, dot] = [out.at(-2), out.at(-1)];
    if (run[1] !== null && dot?.[0] === "." && object && named(object[0])?.of === "object") out.splice(-2, 2, [`${object[0]}.${run[0]}`, run[1]]);
    else out.push(run);
  }
  return out;
}

/** Every element in the trees, outermost first. */
function each(elements: Element[]): Element[] {
  return elements.flatMap((e) => [e, ...each(e.children)]);
}

/** Replaces the selected elements of a page with an instance of a new component holding them. */
export function makeComponent(page: Page, ids: string[]) {
  const chosen = tops(page, ids);
  // a group alone gives what it holds, and its instance takes the group's place
  const group = chosen.length === 1 && chosen[0].tag === "group" ? chosen[0] : undefined;
  const picked = group ? group.children : chosen;
  if (picked.length === 0) return;
  if (picked.some((e) => parentOf(page, e.id) !== parentOf(page, picked[0].id))) return notify("Pick elements that sit in one frame to make a component of them.", "warn");
  const parent = parentOf(page, (group ?? picked[0]).id);
  if (!picked.every((e) => literal(e, ["x", "y", "w", "h"]))) return notify("A component is made of elements placed by plain numbers or percents.", "warn");

  const boxes = picked.map((e) => boxOf(e, roomOf(page, e.id)));
  const [left, top] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
  const [right, bottom] = [Math.max(...boxes.map((b) => b.x + b.w)), Math.max(...boxes.map((b) => b.y + b.h))];
  const parts: Element[] = JSON.parse(JSON.stringify(picked));
  // in pixels, since a percent of the page would mean a share of the component instead
  const room = { w: right - left, h: bottom - top };
  // each part with a place, through the groups, as the copies line up with what they copy
  const own = picked.flatMap(leaves);
  parts.flatMap(leaves).forEach((e, i) => {
    const b = boxOf(own[i], roomOf(page, own[i].id));
    if (isPercent(e.props.w)) e.props.w = String(b.w);
    if (isPercent(e.props.h)) e.props.h = String(b.h);
    if (isPercent(e.props.x)) e.props.x = "0";
    if (isPercent(e.props.y)) e.props.y = "0";
    const there = { ...b, x: b.x - left, y: b.y - top };
    Object.assign(e.props, { x: boxText(e, "x", there, room), y: boxText(e, "y", there, room) });
  });

  // each page name a value reads becomes an input, two way when an input element takes it
  const inputs: Input[] = [];
  const renamed = new Map<string, string>();
  for (const e of each(parts)) {
    for (const [key, value] of Object.entries(e.props)) {
      if (key === "name" || value === undefined) continue;
      e.props[key] = keyed(paint(value))
        .map(([text, kind]) => {
          if (kind === null || kind === "kw" || kind === "str" || kind === "com" || text.startsWith("$")) return text;
          let to = renamed.get(text);
          if (!to) {
            // a member's input is named for the member alone
            to = freeName(joined(text.split(".").at(-1) ?? text, (w) => w[0].toLowerCase() + w.slice(1)) || "value", (n) => ["name", "repeat", "x", "y", "w", "h", "origin", "rotate", "text"].includes(n) || inputs.some((i) => i.name === n));
            renamed.set(text, to);
            inputs.push({ name: to, default: "0", bindable: false, type: "" });
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
      const event = freeName(joined(`${e.props.name ?? "part"} ${h.event}`, (w) => w.toLowerCase()), (n) => events.includes(n));
      events.push(event);
      handlers.push({ event, code: h.code, attrs: {}, filter: {} });
      return { ...h, code: `emit("${event}", p);` };
    });
  }

  const name = freeName(joined((group ?? picked[0]).props.name ?? "", (w) => w[0].toUpperCase() + w.slice(1)).replace(/^[^A-Z]+/, "") || "Part", (n) => state.pages.some((p) => p.interface !== null && p.name === n));
  const id = freeName(slug(name), (n) => state.pages.some((p) => p.id === n));
  const component: Page = { id, name, width: right - left, height: bottom - top, shows: "full", fill: "", interface: { inputs, events, variables: [], sizing: "scale" }, state: [], children: parts };
  const instance: Element = {
    id: "",
    tag: "use",
    component: name,
    props: { name, w: String(right - left), h: String(bottom - top), ...Object.fromEntries([...renamed].map(([from, to]) => [to, from])) },
    handlers,
    state: [],
    children: [],
  };
  // where they stood, counted from the origin of their frame
  const box = { x: left, y: top, w: right - left, h: bottom - top };
  const frame = roomOf(page, picked[0].id);
  Object.assign(instance.props, { x: boxText(instance, "x", box, frame), y: boxText(instance, "y", box, frame) });
  // the instance goes where the group or the front most of them stood
  const gone = group ? [group] : picked;
  const places = gone.map((e) => childrenOf(page, parent).findIndex((c) => c.id === e.id));
  const index = Math.max(...places) - (gone.length - 1);
  const edits: Edit[] = [
    { kind: "put_page", page: component },
    ...gone.map((e): Edit => ({ kind: "remove_element", page: page.id, id: e.id })),
    { kind: "add_element", page: page.id, parent, index, element: instance },
  ];
  sendEdits(edits);
}

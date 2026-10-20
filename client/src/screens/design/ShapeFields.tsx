// What the inspector shows of a drawing's shapes: each kind's geometry, the paint they share,
// and adding a shape sized to the drawing it goes in.

import { createSignal, For, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { number, resolve } from "../../state/bind";
import { Plus } from "../../ui/icons";
import { Popover } from "../../ui/Popover";
import type { FieldProps } from "./Field";
import { TagIcon } from "./TagIcon";
import { find, parentOf } from "./tree";

type Spec = [string, string, Partial<FieldProps>];

const n = (placeholder: string): Partial<FieldProps> => ({ kind: "number", placeholder });

/** Each shape's own attributes, as the inspector names them. */
export const GEOMETRY: Partial<Record<Tag, Spec[]>> = {
  circle: [["Centre x", "cx", n("0")], ["Centre y", "cy", n("0")], ["Radius", "r", { ...n("0"), min: 0 }]],
  ellipse: [["Centre x", "cx", n("0")], ["Centre y", "cy", n("0")], ["Radius x", "rx", { ...n("0"), min: 0 }], ["Radius y", "ry", { ...n("0"), min: 0 }]],
  rect: [["x", "x", n("0")], ["y", "y", n("0")], ["Width", "width", { ...n("0"), min: 0 }], ["Height", "height", { ...n("0"), min: 0 }], ["Round", "rx", { ...n("0"), min: 0 }]],
  line: [["From x", "x1", n("0")], ["From y", "y1", n("0")], ["To x", "x2", n("0")], ["To y", "y2", n("0")]],
  polyline: [["Points", "points", { placeholder: '"0,0 50,20 100,0"' }]],
  polygon: [["Points", "points", { placeholder: '"0,0 50,20 100,0"' }]],
  path: [["Path", "d", { placeholder: '"M 0 0 L 100 100"' }]],
  text: [["Text", "text", { kind: "text", placeholder: '"Text"' }], ["x", "x", n("0")], ["y", "y", n("0")], ["Size", "font-size", { ...n("16"), min: 1 }], ["Anchor", "text-anchor", { kind: "choice", options: ['"start"', '"middle"', '"end"'], placeholder: '"start"' }]],
  g: [["Transform", "transform", { placeholder: '`rotate(${angle} 50 50)`' }]],
};

/** What every shape may be painted with. A group's transform is its geometry. */
export const PAINT: Spec[] = [
  ["Fill", "fill", { kind: "colour", placeholder: "#000000" }],
  ["Stroke", "stroke", { kind: "colour", placeholder: '"none"' }],
  ["Thickness", "stroke-width", { ...n("1"), min: 0, step: 0.5 }],
  ["Opacity", "opacity", { ...n("1"), min: 0, max: 1, step: 0.01 }],
  ["Dashes", "stroke-dasharray", { placeholder: '"4 4"' }],
  ["Ends", "stroke-linecap", { kind: "choice", options: ['"butt"', '"round"', '"square"'], placeholder: '"butt"' }],
  ["Transform", "transform", { placeholder: '`rotate(${angle} 50 50)`' }],
];

/** The attributes a shape's fields name, so the rest show as more attributes. */
/** How any element turns: by degrees, clockwise, about a point of its own box. */
export const TURN: Spec[] = [
  ["Rotate", "rotate", n("0")],
  ["Turns about", "transform-origin", { kind: "choice", options: ['"50% 50%"', '"50% 100%"', '"50% 0%"', '"0% 50%"', '"100% 50%"', '"0% 0%"'], placeholder: '"50% 50%"' }],
];

export function shapeKeys(tag: Tag): Set<string> {
  return new Set([...(GEOMETRY[tag] ?? []), ...PAINT, ...TURN].map(([, key]) => key));
}

/** The shapes the inspector adds, in the order its menu lists them. */
const KINDS: Tag[] = ["circle", "rect", "line", "path", "polyline", "polygon", "ellipse", "text", "g"];

/** The drawing's own units: its view box, else its box in pixels. */
function units(drawing: Element): [number, number, number, number] {
  const r = resolve(drawing.props.viewbox);
  const box = r.ok ? String(r.value ?? "").trim().split(/[\s,]+/).map(Number) : [];
  if (box.length === 4 && box.every(Number.isFinite)) return box as [number, number, number, number];
  return [0, 0, number(drawing.props.w) || 100, number(drawing.props.h) || 100];
}

/** What a new shape starts as: in the middle of its drawing, sized to it, and visible. */
function start(tag: Tag, [x, y, w, h]: [number, number, number, number]): Record<string, string> {
  const v = (k: number) => String(Math.round(k * 10) / 10);
  const [cx, cy, s] = [x + w / 2, y + h / 2, Math.min(w, h)];
  const line = { fill: '"none"', stroke: "#e4e6e8", "stroke-width": v(Math.max(1, s / 40)), "stroke-linecap": '"round"' };
  const pts = (ps: [number, number][]) => `"${ps.map(([a, b]) => `${v(x + a * w)},${v(y + b * h)}`).join(" ")}"`;
  switch (tag) {
    case "circle":
      return { name: "Circle", cx: v(cx), cy: v(cy), r: v(s / 3), fill: "#4a8fd6" };
    case "ellipse":
      return { name: "Ellipse", cx: v(cx), cy: v(cy), rx: v(w / 3), ry: v(h / 4), fill: "#4a8fd6" };
    case "rect":
      return { name: "Rect", x: v(x + w / 4), y: v(y + h / 4), width: v(w / 2), height: v(h / 2), fill: "#4a8fd6" };
    case "line":
      return { name: "Line", x1: v(x + w / 4), y1: v(cy), x2: v(x + (3 * w) / 4), y2: v(cy), ...line };
    case "path":
      return { name: "Path", d: `"M ${v(x + w * 0.1)} ${v(y + h * 0.8)} Q ${v(cx)} ${v(y + h * 0.1)} ${v(x + w * 0.9)} ${v(y + h * 0.8)}"`, ...line };
    case "polyline":
      return { name: "Line", points: pts([[0.1, 0.7], [0.3, 0.4], [0.5, 0.55], [0.7, 0.25], [0.9, 0.35]]), ...line };
    case "polygon":
      return { name: "Polygon", points: pts([[0.5, 0.2], [0.8, 0.75], [0.2, 0.75]]), fill: "#4a8fd6" };
    case "text":
      return { name: "Label", x: v(cx), y: v(cy), text: '"Text"', fill: "#e4e6e8", "font-size": v(Math.max(8, s / 8)), "text-anchor": '"middle"', "dominant-baseline": '"middle"' };
    default:
      return { name: "Group" };
  }
}

/** Adds a shape into the drawing or group picked, or beside the shape picked. */
export function AddShape(p: { page: Page; element: Element }) {
  const [open, setOpen] = createSignal(false);
  let ghost!: HTMLButtonElement;
  // the drawing or group a new shape goes in, and the drawing whose units size it
  const holder = () => (p.element.tag === "svg" || p.element.tag === "g" ? p.element.id : parentOf(p.page, p.element.id));
  const drawing = () => {
    let id = holder();
    while (id && find(p.page.children, id)?.tag !== "svg") id = parentOf(p.page, id);
    return id ? find(p.page.children, id) : undefined;
  };
  const add = (tag: Tag) => {
    setOpen(false);
    const d = drawing();
    if (!d) return;
    const element: Element = { id: "", tag, component: null, props: start(tag, units(d)), handlers: [], children: [] };
    send({ type: "edit", edit: { kind: "add_element", page: p.page.id, parent: holder(), index: null, element } });
  };
  return (
    <>
      <div class="section">Shapes</div>
      <button ref={ghost} class="ghost" classList={{ on: open() }} onClick={() => setOpen(!open())}>
        <Plus size={13} />
        Add shape
        <span class="ghost-trail">{KINDS.slice(0, 5).join(", ")}</span>
      </button>
      <Show when={open()}>
        <Popover anchor={ghost} onClose={() => setOpen(false)} class="choice-list">
          <For each={KINDS}>
            {(tag) => (
              <button class="menu-item" onClick={() => add(tag)}>
                <TagIcon tag={tag} size={13} />
                <span>{tag === "g" ? "group" : tag}</span>
              </button>
            )}
          </For>
        </Popover>
      </Show>
    </>
  );
}

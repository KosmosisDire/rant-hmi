// Adding elements: what each kind starts as, and where a new one lands.

import { CAMERA } from "../../page/parts";
import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Handler } from "../../protocol/Handler";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import type { Value } from "../../protocol/Value";
import { edit } from "../../state/change";
import { number, resolve } from "../../state/bind";
import { freeName } from "../../state/names";
import { GRID } from "./Artboard";
import { childrenOf } from "./tree";

/** What a new element starts as: visible, on the grid, plainly named, in units, and in the
 *  theme's tokens. A diagram starts empty, its shapes added from the inspector. */
export const STARTS: Record<"div" | "span" | "input" | "media" | "svg" | "markup" | "canvas" | "scene", Record<string, string>> = {
  div: { name: "Frame", w: "16", h: "8", background: "$panel", "border-radius": "$radius" },
  span: { name: "Text", w: "16", h: "4", text: '"Text"', color: "$text", "font-size": "$textSize" },
  input: {
    name: "Input",
    w: "16",
    h: "4",
    background: "$surface",
    "border-width": "0.1",
    "border-style": '"solid"',
    "border-color": "$border2",
    "border-radius": "$radius",
    padding: "$space",
    color: "$text",
    "font-size": "$textSize",
  },
  media: { name: "Media", w: "32", h: "24", fit: '"meet"' },
  svg: { name: "Diagram", w: "16", h: "16" },
  markup: { name: "SVG", w: "16", h: "16", markup: '`<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="${$accent}"/></svg>`' },
  canvas: { name: "Canvas", w: "16", h: "16", draw: ["ctx.fillStyle = $accent;", "ctx.beginPath();", "ctx.arc(width / 2, height / 2, min(width, height) * 0.4, 0, 2 * PI);", "ctx.fill();"].join("\n") },
  scene: { name: "Scene", w: "32", h: "24", background: "$panel", "border-radius": "$radius" },
};

/** What a new element holds from the start: a scene a floor and the axes of its origin, so it
 *  shows which way it looks. */
const HOLDS: Partial<Record<Tag, Pick<Element, "tag" | "props">[]>> = {
  scene: [
    { tag: "floor", props: { name: "Floor" } },
    { tag: "axes", props: { name: "Origin" } },
  ],
};

/** The kinds a person adds, in the order the layers bar and the menu offer them. */
export const KINDS: [keyof typeof STARTS, string][] = [
  ["div", "Frame"],
  ["span", "Text"],
  ["input", "Input"],
  ["media", "Media"],
  ["svg", "Diagram"],
  ["markup", "SVG"],
  ["canvas", "Canvas"],
  ["scene", "Scene"],
];

/** Adds an element to `parent`, the page for null: at `at` in it, on the grid, else at the
 *  first step from its corner where nothing sits, so it never hides behind an old one. */
export function addElement(page: Page, parent: string | null, tag: Tag, props: Record<string, string>, component: string | null = null, at?: { x: number; y: number }) {
  let spot: { x: number; y: number };
  if (at) {
    spot = { x: Math.round(at.x / GRID) * GRID, y: Math.round(at.y / GRID) * GRID };
  } else {
    let n = parent ? GRID : 4 * GRID;
    while (childrenOf(page, parent).some((e) => number(e.props.x) === n && number(e.props.y) === n)) n += 2 * GRID;
    spot = { x: n, y: n };
  }
  const children = (HOLDS[tag] ?? []).map((c): Element => ({ id: "", component: null, handlers: [], state: [], children: [], tag: c.tag, props: { ...c.props } }));
  const element: Element = { id: "", tag, component, props: { ...props, x: String(spot.x), y: String(spot.y) }, handlers: [], state: [], children };
  if (tag === "scene") return addScene(page, element, { kind: "add_element", page: page.id, parent, index: null, element });
  edit({ kind: "add_element", page: page.id, parent, index: null, element });
}

/** Adds a scene with a view of its own, which a page keeps as state for each screen and a
 *  component as its own variable, and the handlers that move it, both as one edit. */
function addScene(page: Page, scene: Element, add: Edit) {
  const own = page.interface;
  const base = `${(scene.props.name ?? "scene").replace(/^./, (c) => c.toLowerCase()).replace(/\W/g, "")}View`;
  const view = own ? freeName(base, (n) => own.variables.some((v) => v.name === n) || own.inputs.some((i) => i.name === n)) : freeName(base, (n) => page.state.some((v) => v.name === n));
  const start = `{ ${Object.entries(CAMERA).map(([k, v]) => `${k}: ${v}`).join(", ")} }`;
  Object.assign(scene.props, Object.fromEntries(Object.keys(CAMERA).map((k) => [k, `${view}.${k}`])));
  scene.handlers = moves(view);
  if (own) return edit({ kind: "batch", edits: [{ kind: "set_local", page: page.id, name: view, local: { name: view, start } }, add] });
  const r = resolve(start);
  if (!r.ok) return edit(add);
  edit({ kind: "batch", edits: [{ kind: "set_state", page: page.id, id: null, name: view, var: { name: view, start: r.value as Value, per: "screen" } }, add] });
}

/** The handlers that move a scene's `view`: a left drag or a finger turns round what it looks
 *  at, another button, Shift or two fingers slide it across, and a wheel or a pinch brings it
 *  nearer. Each is the scene's own to change. */
function moves(view: string): Handler[] {
  const slide = (indent: string) =>
    [
      "// as far as the pointer went, at the distance it looks at",
      `const m = ${view}.distance * 2 * tan(PI / 8) / p.h;`,
      `const cy = cos(${view}.yaw), sy = sin(${view}.yaw), cp = cos(${view}.pitch), sp = sin(${view}.pitch);`,
      `const t = ${view}.target;`,
      `${view} = { ...${view}, target: vec(t.x + (sy * p.dx - sp * cy * p.dy) * m, t.y - (cy * p.dx + sp * sy * p.dy) * m, t.z + cp * p.dy * m) };`,
    ]
      .map((line) => indent + line)
      .join("\n");
  const turn = [
    "// a left drag turns round what it looks at, another button or Shift slides it",
    `if (p.button === "left" && !p.shift) {`,
    `  ${view} = { ...${view}, yaw: ${view}.yaw - (p.dx / p.w) * 2 * PI, pitch: clamp(${view}.pitch + (p.dy / p.h) * PI, -1.5, 1.5) };`,
    "} else {",
    slide("  "),
    "}",
  ].join("\n");
  const zoom = [`// nearer as a wheel turns up or fingers spread`, `${view} = { ...${view}, distance: clamp(${view}.distance / p.factor, 0.1, 500) };`].join("\n");
  return [
    { event: "drag", filter: { button: "any" }, attrs: {}, code: turn },
    { event: "scroll", filter: { from: "fingers" }, attrs: {}, code: slide("") },
    { event: "zoom", filter: {}, attrs: {}, code: zoom },
  ];
}

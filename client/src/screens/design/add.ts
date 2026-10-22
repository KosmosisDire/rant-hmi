// Adding elements: what each kind starts as, and where a new one lands.

import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { edit } from "../../state/change";
import { number } from "../../state/bind";
import { GRID } from "./Artboard";
import { childrenOf } from "./tree";

/** What a new element starts as: visible, on the grid, plainly named, in units, and in the
 *  theme's tokens. A diagram starts empty, its shapes added from the inspector. */
export const STARTS: Record<"div" | "span" | "input" | "media" | "svg" | "markup" | "canvas", Record<string, string>> = {
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
  const element = { id: "", tag, component, props: { ...props, x: String(spot.x), y: String(spot.y) }, handlers: [], children: [] };
  edit({ kind: "add_element", page: page.id, parent, index: null, element });
}

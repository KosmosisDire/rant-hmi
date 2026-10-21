// Adding elements: what each kind starts as, and where a new one lands.

import { send } from "../../net/connection";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { number } from "../../state/bind";
import { GRID } from "./Artboard";
import { childrenOf } from "./tree";

/** What a new element starts as: visible, on the grid, and plainly named, in units. A drawing
 *  starts empty, its shapes added from the inspector. */
export const STARTS: Record<"div" | "span" | "input" | "media" | "svg" | "markup", Record<string, string>> = {
  div: { name: "Frame", w: "16", h: "8", background: "#2a2f35", "border-radius": "0.8" },
  span: { name: "Text", w: "16", h: "4", text: '"Text"', color: "#e4e6e8", "font-size": "1.8" },
  input: {
    name: "Input",
    w: "16",
    h: "4",
    background: "#1e2125",
    "border-width": "0.1",
    "border-style": '"solid"',
    "border-color": "#3a4046",
    "border-radius": "0.6",
    padding: '"0 10px"',
    color: "#e4e6e8",
    "font-size": "1.8",
  },
  media: { name: "Media", w: "32", h: "24", fit: '"meet"' },
  svg: { name: "Drawing", w: "16", h: "16" },
  markup: { name: "SVG", w: "16", h: "16", markup: '`<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#4a8fd6"/></svg>`' },
};

/** The kinds a person adds, in the order the layers bar and the menu offer them. */
export const KINDS: [keyof typeof STARTS, string][] = [
  ["div", "Frame"],
  ["span", "Text"],
  ["input", "Input"],
  ["media", "Media"],
  ["svg", "Drawing"],
  ["markup", "SVG"],
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
  send({ type: "edit", edit: { kind: "add_element", page: page.id, parent, index: null, element } });
}

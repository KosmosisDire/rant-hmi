// Finding an element in a page's tree, and where each kind of element goes.

import { isPart } from "../page/parts";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import { component } from "./store";

/** What a diagram holds: SVG shapes, whose every property but the name is an attribute. */
export const SHAPES = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "g"]);

/** Where an element goes, as the backend has it: a shape in a diagram, a 3D part or a 3D
 *  component's instance in a scene, the rest on a page. */
export type Home = "page" | "diagram" | "scene";
export const homeOf = (e: { tag: string; component?: string | null }): Home =>
  e.tag === "use" ? spaceHome(component(e.component ?? "")) : SHAPES.has(e.tag) ? "diagram" : isPart(e.tag) ? "scene" : "page";

/** Where what a page holds goes, and so where a component's instances go: a 3D component's in a
 *  scene, any other's on a page. */
export const spaceHome = (page: Page | undefined): Home => (page?.interface?.space === "3d" ? "scene" : "page");

/** The element and every frame around it, outermost first. */
export function chain(elements: Element[], id: string): Element[] | undefined {
  for (const e of elements) {
    if (e.id === id) return [e];
    const inner = chain(e.children, id);
    if (inner) return [e, ...inner];
  }
  return undefined;
}

export function find(elements: Element[], id: string): Element | undefined {
  return chain(elements, id)?.at(-1);
}

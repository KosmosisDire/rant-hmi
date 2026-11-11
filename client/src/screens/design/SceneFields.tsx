// What the inspector shows of a scene and its 3D parts: the camera a scene orbits with, each
// part's own properties as the table of parts gives them, and adding a part.

import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import { edit } from "../../state/change";
import { find, spaceHome } from "../../state/elements";
import { CAMERA, type Part, PARTS, POSE } from "../../page/parts";
import { kindOf } from "./Field";
import type { Spec } from "./ShapeFields";
import { parentOf } from "./tree";

/** The parts the inspector and the menu add, in the order they list them. */
export const PART_KINDS: Part[] = ["box", "sphere", "cylinder", "points", "mesh", "grid", "arrow", "axes", "floor", "model", "anchor"];

/** How far one pixel of scrub moves each length, angle or share. */
const STEPS: Record<string, number> = { size: 0.05, radius: 0.05, length: 0.05, step: 0.1, opacity: 0.01, yaw: 0.02, pitch: 0.02, distance: 0.1 };

const LABELS: Record<string, string> = { color: "Colour", src: "Source" };

/** The properties that take one of a few words, offered as a choice. */
const CHOICES: Record<string, string[]> = { shape: ['"dot"', '"square"', '"sphere"', '"box"'] };

/** A field for each of `defaults`, its kind and its placeholder the code it takes when left out. */
const fields = (defaults: Record<string, string>): Spec[] =>
  Object.entries(defaults).map(([key, code]) => [
    LABELS[key] ?? key[0].toUpperCase() + key.slice(1),
    key,
    CHOICES[key]
      ? { kind: "choice", options: CHOICES[key], placeholder: code }
      : { kind: kindOf(code), placeholder: code, step: STEPS[key], ...(key === "opacity" ? { min: 0, max: 1 } : {}) },
  ]);

/** The camera's fields on a scene. */
export const cameraFields = () => fields(CAMERA);

/** Where a part or a 3D instance sits in what holds it. */
export const POSE_FIELD: Spec = ["Pose", POSE, { placeholder: "{ position: vec(0, 0, 0) }" }];

/** A part's fields: its pose, then its own. */
export const partFields = (tag: Part): Spec[] => [POSE_FIELD, ...fields(PARTS[tag])];

/** The properties a part's fields name. */
export const partKeys = (tag: Part) => new Set([POSE, ...Object.keys(PARTS[tag])]);

// a solid stands on the floor, and points start as a short line to see
const STANDS = "{ position: vec(0, 0, 0.5) }";
export const PART_STARTS: Record<Part, Record<string, string>> = {
  anchor: { name: "Anchor" },
  axes: { name: "Axes" },
  box: { name: "Box", pose: STANDS },
  sphere: { name: "Sphere", pose: STANDS },
  cylinder: { name: "Cylinder", pose: STANDS },
  points: { name: "Points", points: "[vec(-1, 0, 0.5), vec(0, 0, 1), vec(1, 0, 0.5)]", size: "0.1" },
  mesh: { name: "Mesh" },
  grid: { name: "Grid" },
  floor: { name: "Floor" },
  arrow: { name: "Arrow", vector: "vec(0, 0, 1)" },
  model: { name: "Model" },
};

/** Adds a part, or an instance of the 3D component `component` for "use", into the scene or
 *  anchor `at` is, beside it when it is a part, or at the top of a 3D component for none. */
export function addPart(page: Page, at: Element | undefined, tag: Part | "use", props: Record<string, string> = tag === "use" ? {} : PART_STARTS[tag], component: string | null = null) {
  const holder = !at ? null : at.tag === "scene" || at.tag === "anchor" ? at.id : parentOf(page, at.id);
  if (holder === null ? spaceHome(page) !== "scene" : !find(page.children, holder)) return;
  const element: Element = { id: "", tag, component, props: { ...props }, handlers: [], state: [], children: [] };
  edit({ kind: "add_element", page: page.id, parent: holder, index: null, element });
}

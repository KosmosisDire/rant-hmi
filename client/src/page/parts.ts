// The 3D parts a scene holds, as the scene draws them and the editor offers them: each one's own
// properties and the code each takes when left out. three.js stays out of this file, so only a
// screen showing a scene loads it.

import type { Tag } from "../protocol/Tag";

/** Where a part sits and how it turns, counted from what holds it. Every part takes one. */
export const POSE = "pose";

/** Each part's own properties and the code each takes when left out. Lengths are metres. */
export const PARTS = {
  anchor: {},
  axes: { size: "1" },
  box: { size: "vec(1, 1, 1)", color: "$accent", opacity: "1" },
  sphere: { radius: "0.5", color: "$accent", opacity: "1" },
  cylinder: { radius: "0.5", length: "1", color: "$accent", opacity: "1" },
  points: { points: "[]", size: "0.05", joined: "false", color: "$accent" },
  grid: { size: "10", step: "1", color: "$border" },
} satisfies Partial<Record<Tag, Record<string, string>>>;

export type Part = keyof typeof PARTS;

export const isPart = (tag: string): tag is Part => Object.hasOwn(PARTS, tag);

/** How a scene's camera sees it when its own properties are left out: it orbits `target`,
 *  `yaw` round from x, `pitch` up, `distance` away. Angles are radians. */
export const CAMERA = { target: "vec(0, 0, 0)", yaw: "-2", pitch: "0.5", distance: "5" };

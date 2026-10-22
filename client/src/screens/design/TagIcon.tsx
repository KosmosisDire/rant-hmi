// The icon and the word for what an element is, as the layers and the inspector show it.

import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Tag } from "../../protocol/Tag";
import {
  Anchor,
  Axis3d,
  Box,
  Brush,
  ChartScatter,
  ChartSpline,
  Circle,
  CodeXml,
  Component,
  Cylinder,
  FileBox,
  Folder,
  Globe,
  Grid3x3,
  ImagePlay,
  Minus,
  MoveUpRight,
  Pentagon,
  RectangleHorizontal,
  Rotate3d,
  Shapes,
  Spline,
  Square,
  TextCursorInput,
  Type,
} from "../../ui/icons";

/** What each tag is called in the editor. */
export const TAG_WORDS: Record<Tag, string> = {
  div: "frame",
  span: "text",
  use: "instance",
  input: "input",
  media: "media",
  svg: "diagram",
  markup: "SVG",
  canvas: "canvas",
  path: "path",
  circle: "circle",
  ellipse: "ellipse",
  rect: "rect",
  line: "line",
  polyline: "polyline",
  polygon: "polygon",
  text: "text",
  g: "group",
  group: "group",
  scene: "scene",
  anchor: "anchor",
  axes: "axes",
  box: "box",
  sphere: "sphere",
  cylinder: "cylinder",
  points: "points",
  grid: "grid",
  arrow: "arrow",
  model: "model",
};

/** Each tag's icon, a frame's the square the rest fall back to. */
const ICONS: Partial<Record<Tag, (p: { size: number }) => JSX.Element>> = {
  span: Type,
  text: Type,
  use: Component,
  input: TextCursorInput,
  svg: Shapes,
  markup: CodeXml,
  canvas: Brush,
  media: ImagePlay,
  path: Spline,
  circle: Circle,
  ellipse: Circle,
  rect: RectangleHorizontal,
  line: Minus,
  polyline: ChartSpline,
  polygon: Pentagon,
  g: Folder,
  group: Folder,
  scene: Rotate3d,
  anchor: Anchor,
  axes: Axis3d,
  box: Box,
  sphere: Globe,
  cylinder: Cylinder,
  points: ChartScatter,
  grid: Grid3x3,
  arrow: MoveUpRight,
  model: FileBox,
};

export function TagIcon(p: { tag: Tag; size: number }) {
  return <Dynamic component={ICONS[p.tag] ?? Square} size={p.size} />;
}

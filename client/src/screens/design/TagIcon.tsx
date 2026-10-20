// The icon and the word for what an element is, as the layers and the inspector show it.

import { Match, Switch } from "solid-js";
import type { Tag } from "../../protocol/Tag";
import { ChartSpline, Circle, Component, Group, Minus, Pentagon, RectangleHorizontal, Shapes, Spline, Square, TextCursorInput, Type } from "../../ui/icons";

/** What each tag is called in the editor. */
export const TAG_WORDS: Record<Tag, string> = {
  div: "frame",
  span: "text",
  use: "instance",
  input: "input",
  svg: "drawing",
  path: "path",
  circle: "circle",
  ellipse: "ellipse",
  rect: "rect",
  line: "line",
  polyline: "polyline",
  polygon: "polygon",
  text: "text",
  g: "group",
};

export function TagIcon(p: { tag: Tag; size: number }) {
  return (
    <Switch fallback={<Square size={p.size} />}>
      <Match when={p.tag === "span" || p.tag === "text"}>
        <Type size={p.size} />
      </Match>
      <Match when={p.tag === "use"}>
        <Component size={p.size} />
      </Match>
      <Match when={p.tag === "input"}>
        <TextCursorInput size={p.size} />
      </Match>
      <Match when={p.tag === "svg"}>
        <Shapes size={p.size} />
      </Match>
      <Match when={p.tag === "path"}>
        <Spline size={p.size} />
      </Match>
      <Match when={p.tag === "circle" || p.tag === "ellipse"}>
        <Circle size={p.size} />
      </Match>
      <Match when={p.tag === "rect"}>
        <RectangleHorizontal size={p.size} />
      </Match>
      <Match when={p.tag === "line"}>
        <Minus size={p.size} />
      </Match>
      <Match when={p.tag === "polyline"}>
        <ChartSpline size={p.size} />
      </Match>
      <Match when={p.tag === "polygon"}>
        <Pentagon size={p.size} />
      </Match>
      <Match when={p.tag === "g"}>
        <Group size={p.size} />
      </Match>
    </Switch>
  );
}

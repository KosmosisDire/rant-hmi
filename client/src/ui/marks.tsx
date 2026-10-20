// Small marks shared by every screen: the logo and the Rant kind glyphs.

import { CircleDot, ListClock, Rss, SquareFunction, Variable } from "./icons";
import { Dynamic } from "solid-js/web";
import type { Kind } from "../protocol/Kind";

const KIND_ICONS = { topic: Rss, function: SquareFunction, variable: Variable, task: ListClock };

/** A Rant kind's glyph in its colour, as the explorer draws it. */
export function KindIcon(p: { kind: Kind; size?: number }) {
  return (
    <span class={`kind kind-${p.kind}`} title={p.kind}>
      <Dynamic component={KIND_ICONS[p.kind]} size={p.size ?? 14} />
    </span>
  );
}

/** The HMI's own things are blue, apart from the mesh's colours. */
export function LocalIcon(p: { size?: number }) {
  return (
    <span class="kind kind-local" title="variable">
      <CircleDot size={p.size ?? 14} />
    </span>
  );
}

export function Logo() {
  return (
    <span class="logo" aria-label="Rant">
      <svg viewBox="-3.2 18.3 440 440" fill="none" stroke="currentColor" stroke-width="27" stroke-linecap="round" stroke-linejoin="round">
        <path d="M44.11,35.5H236.28C283.42,35.49 319.97,47.19 345.93,70.56C374.86,96.71 389.32,129.1 389.32,170.11C389.32,211.12 366.3,261.18 330.45,289.31L398.18,424.53C401.47,432.44 395.66,441.14 387.1,441.14H44.11C37.48,441.14 32.11,435.77 32.11,429.14V217.76C32.11,211.13 37.48,205.76 44.11,205.76H229.55C254.91,205.76 267.49,195.18 267.49,173.38C267.49,154.16 252.83,144.55 223.51,144.55H44.11C37.48,144.55 32.11,139.18 32.11,132.55V47.5C32.11,40.87 37.48,35.5 44.11,35.5Z" />
        <path d="M44.11,310.07H214.94L275.31,434.04C277.24,438.36 281.53,441.14 286.26,441.14" />
      </svg>
    </span>
  );
}

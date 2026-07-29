/* Inline text markup, understood by EVERY rendered text (a widget's text slot, a
 * title, a tick label): `**bold**`, `*italic*`, and `:icon-name:` for any Lucide
 * icon (lucide.ts), and nothing more. A marker with no closer, and a `:name:` that
 * names no icon, stay literal text, so plain strings never change meaning.
 *
 * Rendering keeps the renderer's estimated-width idiom (labels are already sized by
 * 0.58 x size x chars everywhere): a line measures in average-char UNITS, an icon
 * costing a fixed unit width. A line with no icons renders as ONE <text> whose
 * tspans flow with the browser's real glyph advances; icons force estimated
 * positioning at their boundaries. Bold applies to icons as a heavier stroke. */

import { LUCIDE } from "./lucide.js";

export interface RichSeg {
  text: string; /* literal run ("" for an icon) */
  icon: string; /* Lucide name ("" for text) */
  bold: boolean;
  italic: boolean;
}

/* an icon's advance in average-char units (drawn as a size x size square, plus air) */
const ICON_UNITS = 1.9;
/* bold glyphs run a little wide; the same estimate spirit as the 0.58 factor */
const BOLD_UNITS = 1.06;

const ICON_RE = /:([a-z0-9]+(?:-[a-z0-9]+)*):/g;

/* Parse one LINE (never a newline inside). Returns null when the line carries no
 * markup at all, so callers keep their plain single-element fast path. */
export function parseRich(line: string): RichSeg[] | null {
  if (!line.includes("*") && !line.includes(":")) return null;
  const segs: RichSeg[] = [];
  let bold = false;
  let italic = false;
  let buf = "";
  const flush = () => {
    if (!buf) return;
    ICON_RE.lastIndex = 0;
    let at = 0;
    let m: RegExpExecArray | null;
    while ((m = ICON_RE.exec(buf))) {
      if (typeof LUCIDE[m[1]] !== "string") {
        /* not an icon: re-scan from just past the opening colon, so `12:30:45`
           and `:nope::zap:` both resolve every REAL token and nothing else */
        ICON_RE.lastIndex = m.index + 1;
        continue;
      }
      if (m.index > at) segs.push({ text: buf.slice(at, m.index), icon: "", bold, italic });
      segs.push({ text: "", icon: m[1], bold, italic });
      at = m.index + m[0].length;
    }
    if (at < buf.length) segs.push({ text: buf.slice(at), icon: "", bold, italic });
    buf = "";
  };
  for (let i = 0; i < line.length; ) {
    /* a marker only opens when a closer exists ahead; it always closes */
    if (line.startsWith("**", i)) {
      if (bold || line.indexOf("**", i + 2) >= 0) {
        flush();
        bold = !bold;
      } else buf += "**"; /* no closer: the pair stays literal, never split */
      i += 2;
    } else if (line[i] === "*" && (italic || line.indexOf("*", i + 1) >= 0)) {
      flush();
      italic = !italic;
      i += 1;
    } else {
      buf += line[i];
      i += 1;
    }
  }
  flush();
  if (!segs.length) return null;
  if (segs.length === 1 && !segs[0].bold && !segs[0].italic && !segs[0].icon &&
      segs[0].text === line)
    return null;
  return segs;
}

/* the line's width in average-char units (multiply by 0.58 x size for pixels) */
export function richUnits(segs: RichSeg[]): number {
  let units = 0;
  for (const s of segs) units += s.icon ? ICON_UNITS : s.text.length * (s.bold ? BOLD_UNITS : 1);
  return units;
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

const n = (value: number): string => value.toFixed(2);

/* Emit one line at (x, y): y is the line's vertical CENTER (dominant-baseline
 * central, like every plain emit). `baseWeight` 0 inherits the surrounding weight
 * (tick labels); a nonzero base is stamped on every span (the text part's 450/650).
 * `extra` is appended to every element (the unknown-value opacity). */
export function richMarkup(
  segs: RichSeg[],
  x: number,
  y: number,
  size: number,
  anchor: "start" | "middle" | "end",
  fill: string,
  baseWeight = 0,
  extra = "",
): string {
  const charW = 0.58 * size;
  const weightAttr = (b: boolean) =>
    b ? ` font-weight="${baseWeight >= 650 ? 800 : 700}"`
      : baseWeight ? ` font-weight="${baseWeight}"` : "";
  const spanOf = (s: RichSeg) =>
    `<tspan${weightAttr(s.bold)}${s.italic ? ' font-style="italic"' : ""}>` +
    `${escapeXml(s.text)}</tspan>`;
  const textOpen = (atX: number, a: string) =>
    `<text x="${n(atX)}" y="${n(y)}" fill="${fill}" font-size="${n(size)}" ` +
    `text-anchor="${a}" dominant-baseline="central"${extra}>`;

  if (!segs.some((s) => s.icon))
    return textOpen(x, anchor) + segs.map(spanOf).join("") + `</text>`;

  const total = richUnits(segs) * charW;
  let at = anchor === "middle" ? x - total / 2 : anchor === "end" ? x - total : x;
  const out: string[] = [];
  let island: RichSeg[] = [];
  let islandUnits = 0;
  const flushIsland = () => {
    if (!island.length) return;
    out.push(textOpen(at, "start") + island.map(spanOf).join("") + `</text>`);
    at += islandUnits * charW;
    island = [];
    islandUnits = 0;
  };
  for (const s of segs) {
    if (!s.icon) {
      island.push(s);
      islandUnits += s.text.length * (s.bold ? BOLD_UNITS : 1);
      continue;
    }
    flushIsland();
    const advance = ICON_UNITS * charW;
    const box = size; /* the icon's em square, vertically centered on the line */
    out.push(
      `<g transform="translate(${n(at + (advance - box) / 2)} ${n(y - box / 2)}) ` +
        `scale(${n(box / 24)})" fill="none" stroke="${fill}" ` +
        `stroke-width="${s.bold ? 2.8 : 2}" stroke-linecap="round" ` +
        `stroke-linejoin="round"${extra}>${LUCIDE[s.icon]}</g>`,
    );
    at += advance;
  }
  flushIsland();
  return out.join("");
}

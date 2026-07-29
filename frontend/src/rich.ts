/* Inline text markup, understood by EVERY rendered text (a widget's text slot, a
 * title, a tick label): `**bold**`, `*italic*`, `_muted_`, `__fainter__`, and
 * `:icon-name:` for any Lucide icon (lucide.ts), and nothing more. A marker with no
 * closer, and a `:name:` that names no icon, stay literal text, so plain strings never
 * change meaning.
 *
 * The underscore pair is where this differs from markdown: instead of italics it is
 * the SECONDARY scale, a smaller and dimmer run for a unit, a suffix, a qualifier
 * ("12.3 _bar_"). `__` is the same smaller size, dimmer still. As in markdown an
 * underscore only marks when it flanks the run like a word boundary, so `feed_name`
 * and `motor_1_speed` keep every underscore literal.
 *
 * Rendering keeps the renderer's estimated-width idiom (labels are already sized by
 * 0.58 x size x chars everywhere): a line measures in average-char UNITS, an icon
 * costing a fixed unit width. A line with no icons renders as ONE <text> whose
 * tspans flow with the browser's real glyph advances; icons force estimated
 * positioning at their boundaries. Bold applies to icons as a heavier stroke, and the
 * secondary scale shrinks and dims them like text. */

import { LUCIDE } from "./lucide.js";

export interface RichSeg {
  text: string; /* literal run ("" for an icon) */
  icon: string; /* Lucide name ("" for text) */
  bold: boolean;
  italic: boolean;
  mute: number; /* 0 normal, 1 `_smaller and muted_`, 2 `__dimmer still__` */
}

/* an icon's advance in average-char units (drawn as a size x size square, plus air) */
const ICON_UNITS = 1.9;
/* bold glyphs run a little wide; the same estimate spirit as the 0.58 factor */
const BOLD_UNITS = 1.06;
/* the secondary scale: one size factor for both mute levels, which differ only in dim */
const MUTE_SCALE = 0.6;
const MUTE_OPACITY = [1, 0.55, 0.35];

const ICON_RE = /:([a-z0-9]+(?:-[a-z0-9]+)*):/g;

const isWord = (c: string | undefined) => c !== undefined && /[0-9A-Za-z]/.test(c);

/* the underscore run at `at` (1 or 2 marks), as the parse loop sees it */
const muteRun = (line: string, at: number) => (line.startsWith("__", at) ? 2 : 1);
/* a run closes where it does not split a word and does not follow a space */
const muteCloses = (line: string, at: number, run: number) =>
  !isWord(line[at + run]) && line[at - 1] !== " ";
/* ...and opens on the mirror of that, with a closer of the same length ahead */
function muteOpens(line: string, at: number, run: number): boolean {
  const before = line[at - 1];
  const after = line[at + run];
  if (isWord(before) || before === "_" || after === undefined || after === " ") return false;
  for (let j = at + run; j < line.length; j++) {
    if (line[j] !== "_") continue;
    const jrun = muteRun(line, j);
    if (jrun === run && muteCloses(line, j, run)) return true;
    j += jrun - 1;
  }
  return false;
}

/* Parse one LINE (never a newline inside). Returns null when the line carries no
 * markup at all, so callers keep their plain single-element fast path. */
export function parseRich(line: string): RichSeg[] | null {
  if (!line.includes("*") && !line.includes(":") && !line.includes("_")) return null;
  const segs: RichSeg[] = [];
  let bold = false;
  let italic = false;
  let muted = false; /* `_` */
  let fainter = false; /* `__` */
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const mute = fainter ? 2 : muted ? 1 : 0;
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
      if (m.index > at)
        segs.push({ text: buf.slice(at, m.index), icon: "", bold, italic, mute });
      segs.push({ text: "", icon: m[1], bold, italic, mute });
      at = m.index + m[0].length;
    }
    if (at < buf.length) segs.push({ text: buf.slice(at), icon: "", bold, italic, mute });
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
    } else if (line[i] === "_") {
      const run = muteRun(line, i);
      const open = run === 2 ? fainter : muted;
      if (open ? muteCloses(line, i, run) : muteOpens(line, i, run)) {
        flush();
        if (run === 2) fainter = !fainter;
        else muted = !muted;
      } else buf += line.slice(i, i + run); /* an ordinary underscore in a word */
      i += run;
    } else {
      buf += line[i];
      i += 1;
    }
  }
  flush();
  if (!segs.length) return null;
  if (segs.length === 1 && !segs[0].bold && !segs[0].italic && !segs[0].icon &&
      !segs[0].mute && segs[0].text === line)
    return null;
  return segs;
}

/* a segment's width in average-char units */
const segUnits = (s: RichSeg) =>
  (s.mute ? MUTE_SCALE : 1) * (s.icon ? ICON_UNITS : s.text.length * (s.bold ? BOLD_UNITS : 1));

/* the line's width in average-char units (multiply by 0.58 x size for pixels) */
export function richUnits(segs: RichSeg[]): number {
  let units = 0;
  for (const s of segs) units += segUnits(s);
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
  /* a muted run only changes size and opacity; the smaller glyphs stay centered on
     the line (the parent's central baseline), never dropped to a shared baseline */
  const muteAttr = (s: RichSeg) =>
    s.mute
      ? ` font-size="${n(size * MUTE_SCALE)}" fill-opacity="${MUTE_OPACITY[s.mute]}"`
      : "";
  const spanOf = (s: RichSeg) =>
    `<tspan${weightAttr(s.bold)}${s.italic ? ' font-style="italic"' : ""}${muteAttr(s)}>` +
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
      islandUnits += segUnits(s);
      continue;
    }
    flushIsland();
    const advance = segUnits(s) * charW;
    /* the icon's em square, vertically centered on the line (shrunk with the run) */
    const box = size * (s.mute ? MUTE_SCALE : 1);
    out.push(
      `<g transform="translate(${n(at + (advance - box) / 2)} ${n(y - box / 2)}) ` +
        `scale(${n(box / 24)})" fill="none" stroke="${fill}" ` +
        (s.mute ? `stroke-opacity="${MUTE_OPACITY[s.mute]}" ` : "") +
        `stroke-width="${s.bold ? 2.8 : 2}" stroke-linecap="round" ` +
        `stroke-linejoin="round"${extra}>${LUCIDE[s.icon]}</g>`,
    );
    at += advance;
  }
  flushIsland();
  return out.join("");
}

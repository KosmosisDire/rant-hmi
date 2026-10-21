// Code split into coloured runs: keywords, strings, comments, and names in the colour of what
// they name, an import by its kind and the HMI's own things blue. It never needs the code to parse.

import type { Kind } from "../protocol/Kind";
import { named } from "../state/names";

export type Paint = "kw" | "str" | "com" | Kind | "local" | "prop" | null;

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "const", "continue", "default", "do", "else", "false", "finally", "for", "function", "if",
  "in", "instanceof", "let", "new", "null", "of", "return", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "while",
]);

const WORD = /[A-Za-z_$][\w$]*/y;
const NUMBER = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w$])/iy;

/** A name's colour: an import's kind, else the HMI's own, else none. */
function colour(word: string): Paint {
  const n = named(word);
  return !n ? null : (n.kind ?? "local");
}

/** The source as runs of text and how to colour each. */
export function paint(src: string): [string, Paint][] {
  const out: [string, Paint][] = [];
  const push = (text: string, p: Paint) => {
    const last = out.at(-1);
    if (last && last[1] === p) last[0] += text;
    else out.push([text, p]);
  };
  const at = (re: RegExp, i: number) => {
    re.lastIndex = i;
    return re.exec(src)?.[0];
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    let j = i + 1;
    let p: Paint = null;
    if (c === "/" && src[i + 1] === "/") {
      j = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
      p = "com";
    } else if (c === "/" && src[i + 1] === "*") {
      j = src.indexOf("*/", i + 2) < 0 ? src.length : src.indexOf("*/", i + 2) + 2;
      p = "com";
    } else if (c === '"' || c === "'" || c === "`") {
      while (j < src.length && src[j] !== c && (c === "`" || src[j] !== "\n")) j += src[j] === "\\" ? 2 : 1;
      j = Math.min(src.length, j + 1);
      p = "str";
    } else if (/\d/.test(c) && !/[\w$.]/.test(src[i - 1] ?? "")) {
      j = i + (at(NUMBER, i)?.length ?? 1);
    } else if (c === "#" && at(HEX, i)) {
      j = i + at(HEX, i)!.length;
      p = "str";
    } else if (at(WORD, i)) {
      const word = at(WORD, i)!;
      j = i + word.length;
      // a field after a dot is the value's own, whatever its name
      const dotted = /\.\s*$/.test(src.slice(0, i));
      p = dotted ? null : KEYWORDS.has(word) ? "kw" : colour(word);
    }
    push(src.slice(i, j), p);
    i = j;
  }
  return out;
}

/** Lines of CSS as a box of them holds it, `key: value`: each key a property, each value code. */
export function paintCss(src: string): [string, Paint][] {
  return src.split(/(?<=\n)/).flatMap((line): [string, Paint][] => {
    const colon = line.indexOf(":");
    if (colon < 0) return [[line, "prop"]];
    return [[line.slice(0, colon), "prop"], [":", null], ...paint(line.slice(colon + 1))];
  });
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** The coloured runs as HTML for a `pre`, code's unless another painter is given. */
export function painted(src: string, by: (src: string) => [string, Paint][] = paint): string {
  return by(src)
    .map(([text, p]) => {
      const safe = text.replace(/[&<>]/g, (ch) => ESCAPES[ch]);
      return p ? `<span class="hl-${p}">${safe}</span>` : safe;
    })
    .join("");
}

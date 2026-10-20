// Code split into coloured runs: keywords, strings, comments, and names in the colour of what
// they name, an import by its kind and the HMI's own things blue. It never needs the code to parse.

import type { Kind } from "../protocol/Kind";
import { state } from "../state/store";

export type Paint = "kw" | "str" | "com" | Kind | "local" | null;

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "const", "continue", "default", "do", "else", "false", "finally", "for", "function", "if",
  "in", "instanceof", "let", "new", "null", "of", "return", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "while",
]);

const WORD = /[A-Za-z_$][\w$]*/y;
const NUMBER = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w$])/iy;

/** What a name is: an import's kind, the HMI's own, else nothing to colour. */
function named(word: string): Paint {
  if (word.startsWith("$")) return state.tokens.some((t) => `$${t.name}` === word) ? "local" : null;
  const imp = state.imports.find((i) => i.alias === word);
  if (imp) return imp.kind;
  return state.variables.some((v) => v.name === word) ? "local" : null;
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
      p = dotted ? null : KEYWORDS.has(word) ? "kw" : named(word);
    }
    push(src.slice(i, j), p);
    i = j;
  }
  return out;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** The coloured runs as HTML for a `pre`. */
export function painted(src: string): string {
  return paint(src)
    .map(([text, p]) => {
      const safe = text.replace(/[&<>]/g, (ch) => ESCAPES[ch]);
      return p ? `<span class="hl-${p}">${safe}</span>` : safe;
    })
    .join("");
}

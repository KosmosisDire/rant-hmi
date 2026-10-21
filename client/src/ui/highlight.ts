// Code split into coloured runs: keywords, strings, comments, and names in the colour of what
// they name, an import by its kind and the HMI's own things blue. It never needs the code to parse.

import { isHex, property, tokens } from "../lang/lex";
import type { Kind } from "../protocol/Kind";
import { named } from "../state/names";

export type Paint = "kw" | "str" | "com" | Kind | "local" | "prop" | null;

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "const", "continue", "default", "do", "else", "false", "finally", "for", "function", "if",
  "in", "instanceof", "let", "new", "null", "of", "return", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "while",
]);


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
  const all = tokens(src);
  let at = 0;
  all.forEach((t, n) => {
    if (t.start > at) push(src.slice(at, t.start), null);
    const text = src.slice(t.start, t.end);
    if (t.kind === "comment") push(text, "com");
    else if (t.kind === "text" || (t.kind === "literal" && isHex(text))) push(text, "str");
    // a field after a dot is the value's own, whatever its name
    else if (t.kind === "word" && !property(src, all, n)) push(text, KEYWORDS.has(text) ? "kw" : colour(text));
    else push(text, null);
    at = t.end;
  });
  if (at < src.length) push(src.slice(at), null);
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

// Code split into coloured runs: keywords, strings, comments, and names in the colour of what
// they name, an import by its kind and the HMI's own things blue. It never needs the code to parse.

import { isHex, property, type Token, tokens } from "../lang/lex";
import type { Kind } from "../protocol/Kind";
import { key, named } from "../state/names";

export type Paint = "kw" | "str" | "com" | Kind | "local" | "prop" | null;

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "const", "continue", "default", "do", "else", "false", "finally", "for", "function", "if",
  "in", "instanceof", "let", "new", "null", "of", "return", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "while",
]);


/** A name's colour: an import's kind, a function's, else the HMI's own, else none. Code of the
 *  object `own` names its members bare. */
function colour(word: string, own?: string): Paint {
  const n = (own !== undefined ? named(key(own, word)) : undefined) ?? named(word);
  return !n ? null : (n.kind ?? (n.of === "function" ? "function" : "local"));
}

/** The source as runs of text and how to colour each. Code of the object `own` names its
 *  members bare. */
export function paint(src: string, own?: string): [string, Paint][] {
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
    else if (t.kind === "word" && !property(src, all, n)) push(text, KEYWORDS.has(text) ? "kw" : colour(text, own));
    // after a dot an object's member, else the value's own field whatever its name
    else if (t.kind === "word" && objectAt(src, all, n - 2, own)) push(text, colour(key(src.slice(all[n - 2].start, all[n - 2].end), text)));
    else push(text, null);
    at = t.end;
  });
  if (at < src.length) push(src.slice(at), null);
  return out;
}

/** Whether the token at `n` names an object as code reads it there, not as a field. */
function objectAt(src: string, all: Token[], n: number, own?: string): boolean {
  const t = all[n];
  if (t?.kind !== "word" || property(src, all, n)) return false;
  const word = src.slice(t.start, t.end);
  return named(word)?.of === "object" && !(own !== undefined && named(key(own, word)));
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

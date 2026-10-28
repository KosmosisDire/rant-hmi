// Just enough JS reading for colouring, completion and colour literals: one tolerant tokenizer
// that knows where names, strings, template literals and comments start and end, without
// parsing. The backend's pages/js.rs reads code the same way.

/** A name, a number or #hex colour, a string or a template's own text, a comment, or any other
 *  character but white space. */
export type Kind = "word" | "literal" | "text" | "comment" | "mark";

export interface Token {
  kind: Kind;
  start: number;
  end: number;
  /** Inside a template literal's `${ }`. */
  nested: boolean;
  /** A string or comment the code ends inside. */
  open: boolean;
}

const WORD = /[\w$]/;

/** The tokens of `src` in order, white space left out. A quote never closed ends at its line's
 *  end, a template or block comment never closed at the end. */
export function tokens(src: string): Token[] {
  const out: Token[] = [];
  lex(src, 0, false, out);
  return out;
}

/** Reads code from `i` to its end, or when `nested` to the brace closing a template's `${`,
 *  where it stops. */
function lex(s: string, i: number, nested: boolean, out: Token[]): number {
  let depth = 0;
  while (i < s.length) {
    const [start, c] = [i, s[i]];
    let kind: Kind = "mark";
    let open = false;
    if (c === "}" && nested && depth === 0) return i;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "`") {
      i = template(s, i, nested, out);
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const end = s.indexOf("\n", i);
      [i, kind, open] = [end < 0 ? s.length : end, "comment", end < 0];
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      [i, kind, open] = [end < 0 ? s.length : end + 2, "comment", end < 0];
    } else if (c === '"' || c === "'") {
      i++;
      while (i < s.length && s[i] !== c && s[i] !== "\n") i += s[i] === "\\" ? 2 : 1;
      [kind, open] = ["text", s[i] !== c];
      i = Math.min(s.length, s[i] === c ? i + 1 : i);
    } else if (/\d/.test(c) || (c === "#" && WORD.test(s[i + 1] ?? ""))) {
      // a #hex colour stops before a dot, which calls one of its methods
      i++;
      while (i < s.length && (WORD.test(s[i]) || (c !== "#" && s[i] === "."))) i++;
      kind = "literal";
    } else if (WORD.test(c)) {
      while (i < s.length && WORD.test(s[i])) i++;
      kind = "word";
    } else {
      if (c === "{") depth++;
      else if (c === "}") depth = Math.max(0, depth - 1);
      i++;
    }
    out.push({ kind, start, end: i, nested, open });
  }
  return i;
}

/** Reads the template literal at `i`: its own text as text tokens, the code in each `${ }` as
 *  nested tokens. Gives where it ends. */
function template(s: string, i: number, nested: boolean, out: Token[]): number {
  let start = i++;
  while (i < s.length) {
    if (s[i] === "\\") i += 2;
    else if (s[i] === "`") {
      out.push({ kind: "text", start, end: i + 1, nested, open: false });
      return i + 1;
    } else if (s[i] === "$" && s[i + 1] === "{") {
      out.push({ kind: "text", start, end: i + 2, nested, open: false });
      i = lex(s, i + 2, true, out);
      // the closing brace starts the text after it
      start = i++;
    } else i++;
  }
  const end = Math.min(i, s.length);
  if (start < end) out.push({ kind: "text", start, end, nested, open: true });
  return end;
}

/** True when the word at `all[n]` follows a single dot, as a property does. A spread's three
 *  dots do not count. */
export function property(src: string, all: Token[], n: number): boolean {
  const dot = (t: Token | undefined) => t?.kind === "mark" && src[t.start] === ".";
  return dot(all[n - 1]) && !(dot(all[n - 2]) && all[n - 2].end === all[n - 1].start);
}

/** The names code reads, each once: no property after a dot, nothing quoted or in a comment. */
export function names(src: string): Set<string> {
  const all = tokens(src);
  return new Set(all.flatMap((t, n) => (t.kind === "word" && !property(src, all, n) ? [src.slice(t.start, t.end)] : [])));
}

/** The names code reads, each with the name a dot after it gives, as `Line.Speed` gives Line
 *  and Speed, and Line alone where no name follows. */
export function heads(src: string): [string, string | undefined][] {
  const all = tokens(src);
  const word = (t: Token | undefined) => (t?.kind === "word" ? src.slice(t.start, t.end) : undefined);
  return all.flatMap((t, n): [string, string | undefined][] => {
    if (t.kind !== "word" || property(src, all, n)) return [];
    const next = all[n + 2] && property(src, all, n + 2) ? word(all[n + 2]) : undefined;
    return [[src.slice(t.start, t.end), next]];
  });
}

/** Whether a literal's text is a #hex colour. */
export const isHex = (text: string) => /^#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})$/i.test(text);

/** `src` split at each `sep` outside brackets, strings and comments, each part trimmed and
 *  empty ones dropped. */
export function splitOutside(src: string, sep: string): string[] {
  const parts: string[] = [];
  let [from, depth] = [0, 0];
  for (const t of tokens(src)) {
    if (t.kind !== "mark" || t.nested) continue;
    const c = src[t.start];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      parts.push(src.slice(from, t.start));
      from = t.end;
    }
  }
  parts.push(src.slice(from));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

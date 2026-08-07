/* THE CONDITIONAL CHAIN, as text (design decision D3). A slot expression of the form
 * `when1 ? then1 : when2 ? then2 : else` round-trips through this scanner into the
 * cases-disclosure editor and back. The scanner is a small tokenizer over the same
 * character classes the highlight underlay lexes — quotes with escapes, balanced
 * () [] {} — splitting ONLY on top-level `?` and `:`; everything between the marks
 * stays a verbatim substring, so printing reproduces the input modulo whitespace.
 *
 * The gate is honest by construction and checked anyway: the editor arms itself only
 * when parse→print reproduces the text (stripped of whitespace outside quotes), and
 * it never rewrites anything it did not parse round-trip-clean. Text with a top-level
 * `?` or `:` it cannot pair — or unbalanced brackets, or an unterminated string — is
 * DIRTY: the box alone is the editor there. */

export type ChainScan =
  | { kind: "plain" }   /* no top-level ?: — an ordinary expression */
  | { kind: "dirty" }   /* ?: present but not a recognizable chain */
  | { kind: "chain"; cases: ChainCase[]; last: string };

export interface ChainCase {
  when: string;
  then: string;
}

/* every top-level `?` and `:`, or null when the text is unbalanced / unterminated */
function topMarks(text: string): { ch: string; at: number }[] | null {
  const marks: { ch: string; at: number }[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
      if (i >= text.length) return null;   /* unterminated string */
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth < 0) return null;
    } else if (depth === 0 && (c === "?" || c === ":")) marks.push({ ch: c, at: i });
  }
  return depth === 0 ? marks : null;
}

export function scanChain(text: string): ChainScan {
  const marks = topMarks(text);
  if (marks === null) return { kind: "dirty" };
  if (!marks.length) return { kind: "plain" };
  if (marks[0].ch !== "?") return { kind: "dirty" };   /* a stray top-level colon */

  /* the matching colon: nested top-level ?: pairs inside the then-branch stay inside
     their piece, counted through rather than split on */
  let nested = 0;
  let colon = -1;
  for (let m = 1; m < marks.length; m++) {
    if (marks[m].ch === "?") nested++;
    else if (nested === 0) {
      colon = m;
      break;
    } else nested--;
  }
  if (colon < 0) return { kind: "dirty" };

  const when = text.slice(0, marks[0].at);
  const then = text.slice(marks[0].at + 1, marks[colon].at);
  const rest = text.slice(marks[colon].at + 1);
  if (!when.trim() || !then.trim() || !rest.trim()) return { kind: "dirty" };

  const tail = scanChain(rest);
  if (tail.kind === "dirty") return { kind: "dirty" };
  if (tail.kind === "plain") return { kind: "chain", cases: [{ when, then }], last: rest };
  return { kind: "chain", cases: [{ when, then }, ...tail.cases], last: tail.last };
}

/* the exact chain shape back as text, pieces trimmed, one spelling of the separators */
export function printChain(chain: { cases: ChainCase[]; last: string }): string {
  return (
    chain.cases.map((c) => c.when.trim() + " ? " + c.then.trim() + " : ").join("") +
    chain.last.trim()
  );
}

/* the text with whitespace outside quotes removed: the round-trip comparison that
 * ignores spacing without ever touching a string literal's insides */
function stripWs(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < text.length && text[i] !== quote) {
        out += text[i];
        if (text[i] === "\\" && i + 1 < text.length) {
          out += text[i + 1];
          i++;
        }
        i++;
      }
      if (i < text.length) out += quote;
      continue;
    }
    if (!/\s/.test(c)) out += c;
  }
  return out;
}

/* a chain the editor may ARM on: scanned as one, and printing it back reproduces the
 * authored text modulo whitespace — the never-rewrite-what-you-didn't-parse gate */
export function chainClean(text: string): ChainScan & { kind: "chain" } | null {
  const scan = scanChain(text);
  if (scan.kind !== "chain") return null;
  return stripWs(printChain(scan)) === stripWs(text) ? scan : null;
}

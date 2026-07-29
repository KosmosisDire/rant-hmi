/* Syntax highlighting for expression fields: a colored underlay behind an input whose
 * own text is transparent, so the caret, selection, scrolling and every input behavior
 * stay the browser's. The underlay re-renders whenever the value it last painted stops
 * matching the input (typing, a document echo, a programmatic accept), checked on one
 * shared animation frame loop, and tracks the input's own horizontal scroll.
 *
 * The token classes are META, not the compiler's truth: a string, a number, a color
 * literal, a word operator, a call, a dotted tail. A mistake still reads as text; the
 * compiler's findings are the authority on wrongness. */

import { el } from "./dom.js";

const KEYWORDS = new Set(["and", "or", "not", "true", "false", "else"]);

interface Site {
  input: HTMLInputElement;
  under: HTMLElement;
  painted: string | null;
  scrolled: number;
}

const sites: Site[] = [];
let looping = false;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* one pass, longest-first alternatives; anything unmatched passes through unpainted */
const TOKEN = new RegExp(
  [
    /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/.source,          /* strings, maybe unclosed */
    /#[0-9a-fA-F]+/.source,                                  /* color literals */
    /\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.source,                 /* numbers */
    /\.[A-Za-z_][A-Za-z0-9_]*/.source,                       /* dotted tail / variant */
    /[A-Za-z_][A-Za-z0-9_]*/.source,                         /* names */
    /==|!=|<=|>=|&&|\|\||->|[-+*/%<>!?:()\[\],]/.source,     /* operators */
  ].join("|"),
  "g",
);

function paint(text: string): string {
  let out = "";
  let at = 0;
  TOKEN.lastIndex = 0;
  for (let hit = TOKEN.exec(text); hit; hit = TOKEN.exec(text)) {
    out += escapeHtml(text.slice(at, hit.index));
    const token = hit[0];
    at = hit.index + token.length;
    const head = token[0];
    let cls = "";
    if (head === '"' || head === "'") cls = "tk-str";
    else if (head === "#") cls = "tk-color";
    else if (head >= "0" && head <= "9") cls = "tk-num";
    else if (head === ".") cls = "tk-dot";
    else if (/[A-Za-z_]/.test(head)) {
      if (KEYWORDS.has(token)) cls = "tk-kw";
      else if (text[at] === "(") cls = "tk-fn";
      else cls = "tk-id";
    } else cls = "tk-op";
    out += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
  }
  out += escapeHtml(text.slice(at));
  return out;
}

function tick(): void {
  for (let i = sites.length - 1; i >= 0; --i) {
    const site = sites[i];
    if (!site.input.isConnected) {
      sites.splice(i, 1);
      continue;
    }
    if (site.painted !== site.input.value) {
      site.painted = site.input.value;
      site.under.innerHTML = paint(site.painted);
    }
    if (site.scrolled !== site.input.scrollLeft) {
      site.scrolled = site.input.scrollLeft;
      site.under.style.transform = "translateX(" + -site.scrolled + "px)";
    }
  }
  if (sites.length) requestAnimationFrame(tick);
  else looping = false;
}

/* Wrap an expression input in its highlighting shell and return the wrapper; callers
 * place the WRAPPER where the input would have gone (extra classes ride along), while
 * every binding and listener keeps targeting the input itself. */
export function highlighted(input: HTMLInputElement, wrapClass = ""): HTMLElement {
  const under = el("span", { class: "hl-under" });
  const wrap = el("span", { class: "hl-wrap " + wrapClass }, [under, input]);
  input.classList.add("hl-input");
  sites.push({ input, under, painted: null, scrolled: 0 });
  if (!looping) {
    looping = true;
    requestAnimationFrame(tick);
  }
  return wrap;
}

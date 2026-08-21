/* Expression autocomplete, driven entirely by the SERVED language tables:
 * the backend exports the same builtin/method rows its parser compiles with, so what
 * this offers and what compiles can never disagree. Context-aware in the spec's order:
 * after `.` exactly the receiver shape's vocabulary; otherwise x, the instance's slots,
 * variables in scope, then the general helpers. The tier filters the display-only
 * vocabulary out of wire positions, so the boundary is discovered rather than
 * explained.
 *
 * One shared dropdown on the body (the diag-pop idiom): a sidebar rebuild can never
 * strand it, and rows insert on mousedown so the input's blur cannot race the pick. */

import { el } from "../dom.js";
import { placeBox } from "../popover.js";
import { shownValue } from "../reconcile.js";
import { LangEntry, MeshField } from "../types.js";
import { Scope } from "./scope.js";

interface Row {
  insert: string;      /* text placed at the prefix */
  label: string;
  signature: string;   /* "(num, num)" or "" */
  result: string;      /* result shape chip, "" for names without one */
  note: string;
}

let pop: HTMLElement | null = null;
let popFor: HTMLInputElement | null = null;
let rows: Row[] = [];
let active = 0;
let prefixStart = 0;
/* path pickers replace the whole value; expression completion splices at the prefix */
let wholeValue = false;

/* remove the dropdown; the row list survives (render re-reads it after closing the
 * previous popup, so clearing it here would blank every refresh) */
function close(): void {
  pop?.remove();
  pop = null;
  popFor = null;
}

/* accepting must LOOK LIKE TYPING to everyone else: the reconciler holds a field's
 * uncommitted text back from the document sync only when an input event told it the
 * user is editing, so a silent .value assignment would be overwritten by the next
 * live frame. The dispatch is muted so it does not re-trigger our own refresh.
 * Exported: the value box's scrub and browse-insert write text the same way, so the
 * reconciler treats those too as typing. (InputEvent is guarded for the test shim,
 * whose elements carry no event machinery at all.) */
let muted = false;

/* A PROGRAMMATIC EDIT SETS NO BROWSER DIRTY FLAG: without a real keystroke after it,
 * blur fires no native `change`, and a browse-inserted pick followed by a bare Enter
 * would be silently lost (the closing drive caught exactly this). So every announced
 * edit that leaves the field differing from the document arms a ONE-SHOT commit on
 * blur — disarmed by the native change real typing brings, and by Escape, whose
 * revert must stay a revert. */
const armed = new WeakSet<HTMLInputElement>();
const guarded = new WeakSet<HTMLInputElement>();

export function announceInput(input: HTMLInputElement): void {
  muted = true;
  if (typeof input.dispatchEvent === "function")
    input.dispatchEvent(typeof InputEvent !== "undefined"
      ? new InputEvent("input", { bubbles: true })
      : new Event("input", { bubbles: true }));
  muted = false;
  if (typeof input.dispatchEvent !== "function") return;   /* the test shim's fields */
  /* back at the document's own text (a cancelled scrub): nothing to commit */
  if (shownValue(input) === input.value) {
    armed.delete(input);
    return;
  }
  armed.add(input);
  if (guarded.has(input)) return;
  guarded.add(input);
  input.addEventListener("change", () => armed.delete(input));
  input.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Escape") armed.delete(input);
  });
  input.addEventListener("blur", () => {
    /* a rebuild's teardown blurs the field it is removing: that text is pending, kept
       by key, and must NOT commit over whatever the rebuild is delivering */
    if (!input.isConnected) return;
    if (!armed.delete(input)) return;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const announce = announceInput;

function accept(input: HTMLInputElement, row: Row): void {
  if (wholeValue) {
    input.value = row.insert;
    input.setSelectionRange(row.insert.length, row.insert.length);
    announce(input);
    close();
    input.focus();
    return;
  }
  const caret = input.selectionStart ?? input.value.length;
  const value = input.value;
  input.value = value.slice(0, prefixStart) + row.insert + value.slice(caret);
  const at = prefixStart + row.insert.length;
  input.setSelectionRange(at, at);
  announce(input);
  close();
  input.focus();
  /* arguments may still be wanted: re-offer immediately after an opening paren */
  if (row.insert.endsWith("(")) refresh(input, contexts.get(input)!);
}

/* shared keyboard handling while a menu is open: arrows move, Tab accepts, Enter
 * SUBMITS the text as typed (it is the commit key everywhere else, so the menu only
 * gets out of its way), Escape only closes (capture phase, so commitInput's
 * Enter-blur and Escape-revert stand once the menu is gone) */
function menuKeydown(input: HTMLInputElement) {
  return (ev: KeyboardEvent) => {
    if (!pop || popFor !== input) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const shown = Math.min(rows.length, 14);
      active = (active + (ev.key === "ArrowDown" ? 1 : shown - 1)) % shown;
      render(input);
    } else if (ev.key === "Tab") {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      accept(input, rows[active]);
    } else if (ev.key === "Enter") {
      close();
    } else if (ev.key === "Escape") {
      ev.stopImmediatePropagation();
      close();
    }
  };
}

function render(input: HTMLInputElement): void {
  close();
  if (!rows.length) return;
  popFor = input;
  pop = el(
    "div",
    { class: "ac-pop" },
    rows.slice(0, 14).map((row, i) =>
      el("div", { class: "ac-row" + (i === active ? " on" : "") }, [
        el("span", { class: "ac-name", text: row.label }),
        row.signature ? el("span", { class: "ac-sig", text: row.signature }) : null,
        row.note ? el("span", { class: "ac-note", text: row.note }) : null,
        row.result ? el("span", { class: "ac-result", text: row.result }) : null,
      ]),
    ),
  );
  pop.querySelectorAll(".ac-row").forEach((node, i) => {
    node.addEventListener("mousedown", (ev) => {
      ev.preventDefault();   /* keep focus in the input */
      accept(input, rows[i]);
    });
  });
  document.body.appendChild(pop);
  placeBox(pop, input.getBoundingClientRect(), { exact: true });
}

/* ---- receiver shape resolution over the served tables ---- */

interface Resolved {
  shape: string;
  elem?: string;
  /* nested aggregates: what one ROW holds, so indexing a row resolves one level down */
  leaf?: string;
  fields?: MeshField[];   /* struct receivers: what the dot reaches */
}

/* find where the primary CHAIN before `at` starts: walk back over identifiers, dots,
 * balanced () and [], literals; stop at an operator or an unbalanced open */
function chainStart(text: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i > 0) {
    const c = text[i - 1];
    if (c === ")" || c === "]") depth++;
    else if (c === "(" || c === "[") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && !/[A-Za-z0-9_."'# ]/.test(c)) {
      break;
    } else if (depth === 0 && c === " ") {
      /* a space ends a chain unless it sits inside brackets */
      break;
    }
    i--;
  }
  return i;
}

/* walk one primary chain ("x.sort()[0]", "this.value", "\"a,b\".split(\",\")") and
 * report the shape it yields; null when it cannot be known here */
function resolveChain(chain: string, ctx: Scope): Resolved | null {
  const lang = ctx.lang();
  chain = chain.trim();
  if (!chain) return null;
  let i = 0;
  let current: Resolved | null = null;

  const skipBalanced = (open: string, closeCh: string) => {
    let depth = 0;
    while (i < chain.length) {
      const c = chain[i++];
      if (c === '"' || c === "'") {
        const quote = c;
        while (i < chain.length && chain[i] !== quote) i += chain[i] === "\\" ? 2 : 1;
        i++;
      } else if (c === open) depth++;
      else if (c === closeCh && --depth === 0) return;
    }
  };

  /* the first unit */
  if (chain[0] === '"' || chain[0] === "'") {
    const quote = chain[0];
    i = 1;
    while (i < chain.length && chain[i] !== quote) i += chain[i] === "\\" ? 2 : 1;
    i++;
    current = { shape: "text" };
  } else if (chain[0] === "#") {
    i = 1;
    while (i < chain.length && /[0-9a-fA-F]/.test(chain[i])) i++;
    current = { shape: "color" };
  } else if (/[0-9]/.test(chain[0])) {
    while (i < chain.length && /[0-9.eE+-]/.test(chain[i])) i++;
    current = { shape: "num" };
  } else {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(chain);
    if (!m) return null;
    i = m[0].length;
    const name = m[0];
    if (chain[i] === "(") {
      /* a builtin call */
      const entry = lang?.builtins.find((b) => b.name === name);
      skipBalanced("(", ")");
      current = entry ? { shape: entry.result } : null;
      if (entry?.name === "keys") current = { shape: "list", elem: "text" };
    } else if (name === "x") {
      current = ctx.x?.() ?? null;
    } else if (name === "this" && chain[i] === ".") {
      const m2 = /^\.[A-Za-z_][A-Za-z0-9_]*/.exec(chain.slice(i));
      if (!m2) return null;
      i += m2[0].length;
      const row = ctx.names().find((n) => n.label === "this" + m2[0]);
      current = row?.shape ? { shape: row.shape, elem: row.elem, leaf: row.leaf } : null;
    } else {
      const row = ctx.names().find((n) => n.label === name);
      current = row?.shape
        ? { shape: row.shape, elem: row.elem, leaf: row.leaf, fields: row.fields }
        : null;
    }
  }

  /* the postfix chain */
  while (current && i < chain.length) {
    if (chain[i] === "[") {
      skipBalanced("[", "]");
      /* indexing a NESTED aggregate lands on a row, which is an aggregate of the leaf */
      current = current.elem ? { shape: current.elem, elem: current.leaf } : null;
      continue;
    }
    if (chain[i] !== ".") return current;
    i++;
    /* a FIELDED receiver's dot (a struct, a timer) reaches its FIELDS (flat dotted
       paths): consume the longest field path the text spells, and continue from
       that field's shape */
    if (current.fields?.length) {
      const run =
        /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(chain.slice(i));
      if (!run) return current;
      let best: MeshField | null = null;
      for (const field of current.fields)
        if ((run[0] === field.path || run[0].startsWith(field.path + ".")) &&
            (!best || field.path.length > best.path.length))
          best = field;
      if (!best) {
        /* a partial path ("x.head."): the tail fields become the receiver */
        const tail = current.fields
          .filter((field) => field.path.startsWith(run[0] + "."))
          .map((field) => ({ ...field, path: field.path.slice(run[0].length + 1) }));
        if (!tail.length) return null;
        i += run[0].length;
        current = { shape: "struct", fields: tail };
        continue;
      }
      i += best.path.length;
      current = { shape: best.variants?.length ? "enum" : best.shape, elem: best.elem };
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(chain.slice(i));
    if (!m) return current;
    const method = m[0];
    i += m[0].length;
    /* every method is CALLED -- plain after a dot is a field, and fields were
       consumed above, so an uncalled trailing name resolves to nothing */
    const called = chain[i] === "(";
    if (called) skipBalanced("(", ")");
    if (!called) return null;
    const entry = lang?.methods.find(
      (row) => row.receiver === current!.shape && row.name === method,
    );
    if (!entry) return null;
    if (entry.result === "elem") {
      current = current.elem ? { shape: current.elem, elem: current.leaf } : null;
    } else if (entry.result === "list") {
      /* sort/reverse/slice/values keep the element shape (and its rows); split, keys
         and variants build a fresh list of text */
      const kept = method !== "split" && method !== "keys" && method !== "variants";
      current = { shape: "list",
                  elem: kept ? current.elem : "text",
                  leaf: kept ? current.leaf : undefined };
    } else if (entry.result === "any") {
      current = null;
    } else {
      current = { shape: entry.result };
    }
  }
  return current;
}

/* ---- suggestion assembly ---- */

function signature(entry: LangEntry): string {
  if (!entry.args.length) return "";
  const args = entry.args.slice(0, entry.args.length);
  const parts = args.map((a, i) => (i >= entry.min_args ? a + "?" : a));
  return "(" + parts.join(", ") + ")";
}

function methodRows(ctx: Scope, receiver: Resolved | null, prefix: string): Row[] {
  const lang = ctx.lang();
  if (!lang) return [];
  const wire = ctx.tier === "wire";
  const out: Row[] = [];
  for (const entry of lang.methods) {
    if (receiver && entry.receiver !== receiver.shape) continue;
    if (wire && entry.tier === "display") continue;
    if (ctx.tier === "attr" && !entry.view) continue;
    if (prefix && !entry.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    /* a method is always called, so even a no-arg one completes with its
       parentheses in place */
    out.push({
      insert: entry.name + (entry.args.length ? "(" : "()"),
      label: entry.name,
      signature: signature(entry) || "()",
      result:
        entry.result === "elem" && receiver?.elem ? receiver.elem : entry.result,
      note: receiver ? "" : entry.receiver ?? "",
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function fieldRows(fields: MeshField[], prefix: string): Row[] {
  const lower = prefix.toLowerCase();
  return fields
    .filter((field) => !prefix || field.path.toLowerCase().startsWith(lower))
    .map((field) => ({
      insert: field.path,
      label: field.path,
      signature: "",
      result: field.variants?.length ? "enum" : field.shape,
      note: "field",
    }));
}

function nameRows(ctx: Scope, prefix: string): Row[] {
  const lang = ctx.lang();
  const wire = ctx.tier === "wire";
  const out: Row[] = [];
  const lower = prefix.toLowerCase();
  /* x exists only where the surface HAS a pipeline register (feed and flow rows) */
  if (ctx.x && (!prefix || "x".startsWith(lower)))
    out.push({ insert: "x", label: "x", signature: "", result: ctx.x()?.shape ?? "", note: "the value here" });
  for (const name of ctx.names()) {
    if (prefix && !name.label.toLowerCase().startsWith(lower)) continue;
    out.push({
      insert: name.label,
      label: name.label,
      signature: "",
      result: name.shape ?? "",
      note: name.note ?? "",
    });
  }
  for (const entry of lang?.builtins ?? []) {
    if (wire && entry.tier === "display") continue;
    if (ctx.tier === "attr" && !entry.view) continue;
    if (prefix && !entry.name.toLowerCase().startsWith(lower)) continue;
    out.push({
      insert: entry.name + "(",
      label: entry.name,
      signature: signature(entry),
      result: entry.result,
      note: "",
    });
  }
  return out;
}

function refresh(input: HTMLInputElement, ctx: Scope): void {
  const caret = input.selectionStart ?? input.value.length;
  const text = input.value.slice(0, caret);
  /* an '@' opens a mesh reference and consumes the path-spelled entity name (slashes
     included), so `@pla` completes to `@plant/temp` — the same spelling browse inserts */
  const prefixMatch = /(@[A-Za-z0-9_/]*|[A-Za-z_][A-Za-z0-9_]*)?$/.exec(text)!;
  const prefix = prefixMatch[1] ?? "";
  prefixStart = caret - prefix.length;
  const beforePrefix = text.slice(0, prefixStart);

  if (beforePrefix.endsWith(".")) {
    /* a numeric literal's decimal point is not a method position */
    const chainEnd = beforePrefix.length - 1;
    if (/[0-9]\.$/.test(beforePrefix) && !/[A-Za-z_)\]"']\s*\.$/.test(beforePrefix)) {
      const start = chainStart(text, chainEnd);
      if (/^[0-9]/.test(text.slice(start).trim())) {
        close();
        return;
      }
    }
    const start = chainStart(text, chainEnd);
    const receiver = resolveChain(text.slice(start, chainEnd), ctx);
    /* a fielded receiver's dot offers its FIELDS; methods belong to the scalars
       they land on */
    rows = receiver?.fields?.length
      ? fieldRows(receiver.fields, prefix)
      : methodRows(ctx, receiver, prefix);
  } else {
    /* offer names only once something was typed, or on explicit focus in an empty box */
    rows = nameRows(ctx, prefix);
    if (!prefix && input.value.trim() !== "" && !/[(,[+\-*/%<>=!&| ]$/.test(beforePrefix)) {
      close();
      return;
    }
  }
  active = 0;
  wholeValue = false;
  render(input);
}

const contexts = new WeakMap<HTMLInputElement, Scope>();

/* Attach completion to an expression input. The Scope comes from scope.ts — one of its
 * factories, picked by the call site. Keyboard: arrows move, Tab accepts,
 * Enter commits the typed text (the menu closes and commitInput's Enter stands),
 * Escape closes (and only closes: the input's own Escape-revert fires when no menu
 * is open). */
export function attachAutocomplete(input: HTMLInputElement, ctx: Scope): void {
  contexts.set(input, ctx);
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener("input", () => {
    if (!muted) refresh(input, ctx);
  });
  input.addEventListener("focus", () => refresh(input, ctx));
  input.addEventListener("blur", () => {
    close();
    rows = [];
  });
  input.addEventListener("keydown", menuKeydown(input), { capture: true });
}


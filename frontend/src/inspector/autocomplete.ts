/* Expression autocomplete (spec 3.7), driven entirely by the SERVED language tables:
 * the backend exports the same builtin/method rows its parser compiles with, so what
 * this offers and what compiles can never disagree. Context-aware in the spec's order:
 * after `.` exactly the receiver shape's vocabulary; otherwise x, the widget's slots,
 * variables in scope, then the general helpers. The tier filters the display-only
 * vocabulary out of wire positions, so the boundary is discovered rather than
 * explained.
 *
 * One shared dropdown on the body (the diag-pop idiom): a sidebar rebuild can never
 * strand it, and rows insert on mousedown so the input's blur cannot race the pick. */

import { el } from "../dom.js";
import { Editor, variablesInScope } from "../editor.js";
import { Feed, Flow, Lang, LangEntry, MeshField, Widget } from "../types.js";
import { localAt, scopeAt } from "./flowscope.js";

export interface NameRow {
  label: string;   /* what inserting places: "setpoint", "widget.value", "x" */
  shape?: string;  /* its shape, when known: "num" "bool" "text" "list" ... */
  note?: string;   /* a short origin tag: "local", "global", "slot" */
  elem?: string;   /* aggregate names: the element shape */
  fields?: MeshField[];   /* struct names: the field table behind the dot */
}

export interface ExprContext {
  /* "display" (a feed's transform) and "wire" (a flow guard/source) are the two
     SCALAR positions (spec 6); "attr" is a template attribute, compiled by a
     different compiler (template_expr.cpp) with a smaller vocabulary again -- a row
     can be legal on "display" and still have no view encoding (rgb was, until the
     two tiers gained a shared vocabulary), so this needs its own filter rather than
     reusing "display"'s. */
  tier: "display" | "wire" | "attr";
  lang(): Lang | null;
  /* the shape of x at this position, or null when unknown; a struct x carries its
     field table so the dot offers FIELDS, not methods */
  x(): { shape: string; elem?: string; fields?: MeshField[] } | null;
  /* every other name legal here (widget.<slot>, variables) */
  names(): NameRow[];
}

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
 * live frame. The dispatch is muted so it does not re-trigger our own refresh. */
let muted = false;

function announce(input: HTMLInputElement): void {
  muted = true;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  muted = false;
}

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
  const at = input.getBoundingClientRect();
  const box = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(at.left, window.innerWidth - box.width - 8));
  const top =
    at.bottom + box.height + 8 > window.innerHeight ? at.top - box.height - 4 : at.bottom + 4;
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}

/* ---- receiver shape resolution over the served tables ---- */

interface Resolved {
  shape: string;
  elem?: string;
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

/* walk one primary chain ("x.sort()[0]", "widget.value", "\"a,b\".split(\",\")") and
 * report the shape it yields; null when it cannot be known here */
function resolveChain(chain: string, ctx: ExprContext): Resolved | null {
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
      current = ctx.x();
    } else if (name === "widget" && chain[i] === ".") {
      const m2 = /^\.[A-Za-z_][A-Za-z0-9_]*/.exec(chain.slice(i));
      if (!m2) return null;
      i += m2[0].length;
      const row = ctx.names().find((n) => n.label === "widget" + m2[0]);
      current = row?.shape ? { shape: row.shape, elem: row.elem } : null;
    } else {
      const row = ctx.names().find((n) => n.label === name);
      current = row?.shape ? { shape: row.shape, elem: row.elem, fields: row.fields }
                           : null;
    }
  }

  /* the postfix chain */
  while (current && i < chain.length) {
    if (chain[i] === "[") {
      skipBalanced("[", "]");
      current = current.elem ? { shape: current.elem } : null;
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
    /* plain is a property, parens is a method: resolve in the matching class only */
    const called = chain[i] === "(";
    if (called) skipBalanced("(", ")");
    const entry = lang?.methods.find(
      (row) => row.receiver === current!.shape && row.name === method &&
               !!row.property === !called,
    );
    if (!entry) return null;
    if (entry.result === "elem") {
      current = current.elem ? { shape: current.elem } : null;
    } else if (entry.result === "list") {
      const elem =
        method === "split" || method === "keys"
          ? "text"
          : current.elem;   /* sort/reverse/slice/values keep the element shape */
      current = { shape: "list", elem };
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

function methodRows(ctx: ExprContext, receiver: Resolved | null, prefix: string): Row[] {
  const lang = ctx.lang();
  if (!lang) return [];
  const wire = ctx.tier === "wire";
  const out: Row[] = [];
  for (const entry of lang.methods) {
    if (receiver && entry.receiver !== receiver.shape) continue;
    if (wire && entry.tier === "display") continue;
    if (ctx.tier === "attr" && !entry.view) continue;
    if (prefix && !entry.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    /* a property inserts bare; a METHOD is always called, so even a no-arg one
       completes with its parentheses in place */
    out.push({
      insert: entry.property ? entry.name
            : entry.name + (entry.args.length ? "(" : "()"),
      label: entry.name,
      signature: entry.property ? "" : signature(entry) || "()",
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

function nameRows(ctx: ExprContext, prefix: string): Row[] {
  const lang = ctx.lang();
  const wire = ctx.tier === "wire";
  const out: Row[] = [];
  const lower = prefix.toLowerCase();
  const x = ctx.x();
  if (!prefix || "x".startsWith(lower))
    out.push({ insert: "x", label: "x", signature: "", result: x?.shape ?? "", note: "the value here" });
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

function refresh(input: HTMLInputElement, ctx: ExprContext): void {
  const caret = input.selectionStart ?? input.value.length;
  const text = input.value.slice(0, caret);
  const prefixMatch = /([A-Za-z_][A-Za-z0-9_]*)?$/.exec(text)!;
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

const contexts = new WeakMap<HTMLInputElement, ExprContext>();

const VAR_SHAPE: Record<string, string> = { f64: "num", bool: "bool", str: "text" };

/* a timer reads by field: what the dot offers on one */
const TIMER_FIELDS: MeshField[] = [
  { path: "running", shape: "bool" },
  { path: "remaining", shape: "num" },
  { path: "duration", shape: "num" },
  { path: "progress", shape: "num" },
];

/* the standing name vocabulary at a widget: its slots as widget.<name>, then every
 * variable in scope */
function scopeNames(editor: Editor, widget: Widget | null): NameRow[] {
  const rows: NameRow[] = [];
  const type = editor.registry?.types.find((t) => t.name === widget?.type) ?? null;
  for (const slot of type?.slots ?? [])
    rows.push({
      label: "widget." + slot.name,
      shape: slot.shape === "enum" ? "text" : slot.shape,
      note: "slot",
    });
  const locals = new Set((widget?.locals ?? []).map((v) => v.id));
  for (const variable of variablesInScope(editor, widget)) {
    if (variable.type === "timer") {
      rows.push({
        label: variable.name,
        shape: "timer",
        note: locals.has(variable.id) ? "local" : "global",
        fields: TIMER_FIELDS,
      });
      continue;
    }
    /* beyond the scalars, a variable's type is a TypeRef (spec 2.7): a dotted ref is
       an enum, a root name a struct carrying its field table */
    const scalar = VAR_SHAPE[variable.type];
    const isEnum = !scalar && variable.type.includes(".");
    const fields = scalar || isEnum
      ? undefined
      : editor.mesh.types.find((t) => t.name === variable.type)?.fields;
    rows.push({
      label: variable.name,
      shape: scalar ?? (isEnum ? "enum" : "struct"),
      note: locals.has(variable.id) ? "local" : "global",
      fields,
    });
  }
  return rows;
}

/* what x IS in a feed's transform: the source field's shape, from reflection (mesh
 * sources) or the variable's declared type (HMI sources); a WHOLE-entity source makes
 * x the message, its field table riding along so the dot completes fields */
export function feedX(editor: Editor, widget: Widget | null, feed: () => Feed) {
  return (): { shape: string; elem?: string; fields?: MeshField[] } | null => {
    const at = feed();
    if (!at.src) return null;
    if (at.src.kind === "L") {
      const row = scopeNames(editor, widget).find((n) => n.label === at.src.name);
      return row?.shape ? { shape: row.shape, fields: row.fields } : null;
    }
    const entity = editor.mesh.entities.find(
      (e) => e.kind === at.src.kind && e.name === at.src.name,
    );
    if (!entity) return null;
    const fields = entity.kind === "F" ? entity.returns ?? [] : entity.fields;
    if (!(at.path ?? "") && fields.length > 1)
      return { shape: "struct", fields };
    const field =
      fields.find((f) => f.path === (at.path ?? "")) ??
      (fields.length === 1 ? fields[0] : null);
    if (!field) return null;
    return { shape: field.variants?.length ? "enum" : field.shape, elem: field.elem };
  };
}

/* what x IS at one row of a flow: the trigger's proposal, retyped by every `set x = ...`
 * above this row (spec 2.6). An earlier row can change it, so the row matters. */
export function flowX(editor: Editor, widget: Widget | null, flow: () => Flow, stepId = 0) {
  return (): { shape: string; elem?: string; fields?: MeshField[] } | null =>
    scopeAt(editor, widget, flow(), stepId).x;
}

/* The names a FLOW ROW may write: the standing scope plus this flow's own locals,
 * declared above this row only, and struct ones expanded to their fields so one field
 * can be computed from another (spec 3.7). */
export function flowNames(editor: Editor, widget: Widget | null, flow: () => Flow, stepId: number) {
  return (): NameRow[] => {
    const rows = scopeNames(editor, widget);
    const declared = new Set(rows.map((r) => r.label));
    for (const local of scopeAt(editor, widget, flow(), stepId).locals) {
      if (!declared.has(local.name))
        rows.push({
          label: local.name,
          shape: local.shape,
          elem: local.elem,
          note: local.note,
          fields: local.fields,
        });
      for (const field of local.fields ?? [])
        rows.push({
          label: local.name + "." + field.path,
          shape: field.shape,
          elem: field.elem,
          note: local.type || "field",
        });
    }
    return rows;
  };
}

export function exprContext(
  editor: Editor,
  widget: Widget | null,
  tier: "display" | "wire",
  x: () => { shape: string; elem?: string } | null,
  names?: () => NameRow[],
): ExprContext {
  return {
    tier,
    lang: () => editor.lang,
    x,
    names: names ?? (() => scopeNames(editor, widget)),
  };
}

/* Attach completion to an expression input. Keyboard: arrows move, Tab accepts,
 * Enter commits the typed text (the menu closes and commitInput's Enter stands),
 * Escape closes (and only closes: the input's own Escape-revert fires when no menu
 * is open). */
export function attachAutocomplete(input: HTMLInputElement, ctx: ExprContext): void {
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

/* ---- the path picker (spec 3.7): the chosen entity's field paths, with shapes ---- */

export interface PathOption {
  path: string;
  shape: string;
  elem?: string;
}

/* Complete a dotted-path field against a fixed option list: typing filters (prefix
 * first, then contains), picking replaces the WHOLE value. This is "autocomplete on
 * msg": the options are exactly the fields the source message carries. */
export function attachPathAutocomplete(
  input: HTMLInputElement,
  options: () => PathOption[],
): void {
  const refreshPaths = () => {
    const all = options();
    const typed = input.value.trim().toLowerCase();
    const starts = all.filter((o) => o.path.toLowerCase().startsWith(typed));
    const rest = all.filter(
      (o) => !starts.includes(o) && o.path.toLowerCase().includes(typed),
    );
    rows = starts.concat(rest).map((o) => ({
      insert: o.path,
      label: o.path,
      signature: "",
      result: o.elem ? o.shape + " of " + o.elem : o.shape,
      note: "",
    }));
    active = 0;
    wholeValue = true;
    render(input);
  };
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener("input", () => {
    if (!muted) refreshPaths();
  });
  input.addEventListener("focus", refreshPaths);
  input.addEventListener("blur", () => {
    close();
    rows = [];
  });
  input.addEventListener("keydown", menuKeydown(input), { capture: true });
}

/* what a FEED's path may name: the source entity's readable fields (the response
 * side for a function); an HMI variable has no paths */
export function feedPaths(editor: Editor, feed: () => Feed) {
  return (): PathOption[] => {
    const at = feed();
    if (!at.src || at.src.kind === "L") return [];
    const entity = editor.mesh.entities.find(
      (e) => e.kind === at.src.kind && e.name === at.src.name,
    );
    const fields = entity?.kind === "F" ? entity.returns ?? [] : entity?.fields ?? [];
    return fields.map((f) => ({ path: f.path, shape: f.shape, elem: f.elem }));
  };
}

/* What a move's `to.path` may name when the destination is a LOCAL: the fields of the
 * struct that local holds at this row (spec 2.6). Aggregates stay out, because the write
 * side cannot set them. */
export function localPaths(
  editor: Editor,
  widget: Widget | null,
  flow: () => Flow,
  stepId: number,
  local: () => string,
) {
  return (): PathOption[] => {
    const held = localAt(editor, widget, flow(), stepId, local());
    return (held?.fields ?? [])
      .filter((f) => f.shape !== "list" && f.shape !== "map")
      .map((f) => ({ path: f.path, shape: f.shape }));
  };
}


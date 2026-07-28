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
import { Feed, Flow, Lang, LangEntry, Widget } from "../types.js";

export interface NameRow {
  label: string;   /* what inserting places: "setpoint", "widget.value", "x" */
  shape?: string;  /* its shape, when known: "num" "bool" "text" "list" ... */
  note?: string;   /* a short origin tag: "local", "global", "slot" */
  elem?: string;   /* aggregate names: the element shape */
}

export interface ExprContext {
  tier: "display" | "wire";
  lang(): Lang | null;
  /* the shape of x at this position, or null when unknown */
  x(): { shape: string; elem?: string } | null;
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

/* shared keyboard handling while a menu is open: arrows move, Enter/Tab accept,
 * Escape only closes (capture phase, so commitInput's Enter-blur and Escape-revert
 * stand once the menu is gone) */
function menuKeydown(input: HTMLInputElement) {
  return (ev: KeyboardEvent) => {
    if (!pop || popFor !== input) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const shown = Math.min(rows.length, 14);
      active = (active + (ev.key === "ArrowDown" ? 1 : shown - 1)) % shown;
      render(input);
    } else if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      accept(input, rows[active]);
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
      current = row?.shape ? { shape: row.shape, elem: row.elem } : null;
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
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(chain.slice(i));
    if (!m) return current;
    const method = m[0];
    i += m[0].length;
    if (chain[i] === "(") skipBalanced("(", ")");
    const entry = lang?.methods.find(
      (row) => row.receiver === current!.shape && row.name === method,
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
    if (prefix && !entry.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    out.push({
      insert: entry.name + (entry.args.length ? "(" : ""),
      label: entry.name,
      signature: signature(entry),
      result:
        entry.result === "elem" && receiver?.elem ? receiver.elem : entry.result,
      note: receiver ? "" : entry.receiver ?? "",
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
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
    rows = methodRows(ctx, receiver, prefix);
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

/* the standing name vocabulary at a widget: its slots as widget.<name>, then every
 * variable in scope (timers excluded: expressions cannot read one yet) */
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
    if (variable.type === "timer") continue;
    rows.push({
      label: variable.name,
      shape: VAR_SHAPE[variable.type] ?? "num",
      note: locals.has(variable.id) ? "local" : "global",
    });
  }
  return rows;
}

/* what x IS in a feed's transform: the source field's shape, from reflection (mesh
 * sources) or the variable's declared type (HMI sources) */
export function feedX(editor: Editor, widget: Widget | null, feed: () => Feed) {
  return (): { shape: string; elem?: string } | null => {
    const at = feed();
    if (!at.src) return null;
    if (at.src.kind === "L") {
      const row = scopeNames(editor, widget).find((n) => n.label === at.src.name);
      return row?.shape ? { shape: row.shape } : null;
    }
    const entity = editor.mesh.entities.find(
      (e) => e.kind === at.src.kind && e.name === at.src.name,
    );
    if (!entity) return null;
    const fields = entity.kind === "F" ? entity.returns ?? [] : entity.fields;
    const field =
      fields.find((f) => f.path === (at.path ?? "")) ??
      (fields.length === 1 ? fields[0] : null);
    return field ? { shape: field.shape, elem: field.elem } : null;
  };
}

/* what x IS at a flow's steps: the trigger event's declared shape (a transform ahead
 * of this step may change it; then the receiver resolves as unknown, which just
 * widens the offer) */
export function flowX(editor: Editor, widget: Widget | null, flow: () => Flow) {
  return (): { shape: string; elem?: string } | null => {
    const type = editor.registry?.types.find((t) => t.name === widget?.type) ?? null;
    const trigger = (flow().when ?? []).find((w: any) => w.kind === "event") as any;
    if (!trigger || !type) return null;
    const event = type.events.find((e) => e.name === trigger.name);
    return event?.x ? { shape: event.x } : null;
  };
}

export function exprContext(
  editor: Editor,
  widget: Widget | null,
  tier: "display" | "wire",
  x: () => { shape: string; elem?: string } | null,
): ExprContext {
  return {
    tier,
    lang: () => editor.lang,
    x,
    names: () => scopeNames(editor, widget),
  };
}

/* Attach completion to an expression input. Keyboard: arrows move, Enter/Tab accept,
 * Escape closes (and only closes: the input's own Escape-revert fires when no menu is
 * open). The commit-on-Enter behavior of commitInput still stands once the menu is
 * closed. */
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

/* what a SETF's path may name: the open message's target fields, i.e. the last build
 * step before this one. Aggregates stay out: the write side cannot set them. */
export function buildTargetPaths(editor: Editor, flow: () => Flow, stepId: number) {
  return (): PathOption[] => {
    let target: { kind: string; name: string } | null = null;
    for (const step of (flow().do ?? []) as any[]) {
      if (step.id === stepId) break;
      if (step.kind === "build" && step.target?.name) target = step.target;
      if (step.kind === "send" && !step.buf) target = null;
    }
    if (!target) return [];
    const entity = editor.mesh.entities.find(
      (e) => e.kind === target!.kind && e.name === target!.name,
    );
    return (entity?.fields ?? [])
      .filter((f) => f.shape !== "list" && f.shape !== "map")
      .map((f) => ({ path: f.path, shape: f.shape }));
  };
}

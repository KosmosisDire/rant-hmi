/* Slot resolution: what a slot IS, read from the document and the runtime.
 *
 * There used to be two readers here, because the canvas and the inspector wanted different
 * things from a slot. The CANVAS's half — `resolveSlot`, plus the theme-aware, option-
 * expanding and cell-space readers layered on it — went with the renderer that was its only
 * caller; the rebuild re-adds its own consumers against real DOM rather than inheriting a
 * shape drawn for SVG. What is left is the INSPECTOR's, and what it shows depends on who
 * OWNS the slot:
 *
 *   nobody writes it   the document IS the value, so the field shows the document. Reading
 *                      the runtime's compiled copy back would fight what the user typed.
 *   something writes it (a feed, an authored flow, or the type's own default behavior)
 *                      the document is only where the runtime STARTED. The field shows the
 *                      live value, because that is the thing the user is reasoning about
 *                     , and editing it restates where the runtime starts. */

import { Json, Live, Mesh, MeshField, MeshType, Registry, SlotSpec, Token, WidgetType, Node } from "./types.js";

/* ---- the slot value ENCODING (spec D1) ----
 *
 * A slot value is number | bool (degenerate literals) or a STRING, which is a
 * wire-tier expression the backend compiles. The native editors keep speaking
 * literals through the two helpers below: `spellSlotLiteral` writes the canonical
 * spelling a picker's literal commits as, `unspellSlotLiteral` reads it back for
 * display. A string neither recognises is a real expression — a BOUND slot. */

/* is this string one of the literal spellings, and which kind */
function literalKind(text: string): "text" | "color" | "token" | "num" | "bool" |
                                     "agg" | "variants" | "empty" | null {
  const at = text.trim();
  if (at === "") return "empty";
  if (/^'(?:\\.|[^'\\])*'$/.test(at) || /^"(?:\\.|[^"\\])*"$/.test(at)) return "text";
  if (/^#[0-9a-fA-F]{3,8}$/.test(at)) return "color";
  if (/^\$[A-Za-z0-9_-]+$/.test(at)) return "token";
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(at)) return "num";
  if (at === "true" || at === "false") return "bool";
  if (at.startsWith("[") || at.startsWith("{")) return "agg";
  if (at.startsWith("variants(") && at.endsWith(")")) return "variants";
  return null;
}

/* the expression a native editor's literal commits as: text-ish shapes quote, the
 * rest already ARE literal spellings (hex colors, $tokens, JSON aggregates) */
export function spellSlotLiteral(shape: string, value: Json): Json {
  if (typeof value !== "string") return value;   /* number | bool ride raw */
  if (shape === "text" || shape === "enum" || shape === "align")
    return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  return value;
}

/* the literal a stored value displays as: quoted text unquotes, every other literal
 * spelling (and every live/raw value) passes through as itself */
export function unspellSlotLiteral(value: Json): Json {
  if (typeof value !== "string") return value;
  const at = value.trim();
  if (/^'(?:\\.|[^'\\])*'$/.test(at) || /^"(?:\\.|[^"\\])*"$/.test(at))
    return at.slice(1, -1).replace(/\\(.)/g, "$1");
  return value;
}

/* is this authored slot value a real EXPRESSION (a bound slot), rather than one of
 * the literal spellings? */
export function slotExpression(value: Json): boolean {
  return typeof value === "string" && literalKind(value) === null;
}

/* ---- theme tokens ---- */

type ThemeMode = "dark" | "light";

/* "$<name>" -> the token's value in this mode; a literal passes through untouched; an
 * unknown token is transparent, matching the backend's compile-time fallback */
export function resolveColor(value: Json, tokens: Token[], mode: ThemeMode): Json {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const token = tokens.find((t) => t.name === value.slice(1));
  if (!token) return "#00000000";
  return mode === "light" ? token.light : token.dark;
}

/* What a TypeRef lands on, from the served table: the same resolution the compiler runs
 * (find_type_ref), so what the view expands and what compiles can never disagree. Lives
 * here, in the pure slot layer, and the type tree re-exports it for Data and Vars. */
export function resolveTypeRef(
  mesh: Mesh,
  ref: string,
): { kind: "struct" | "enum"; type: MeshType; field?: MeshField } | null {
  if (!ref) return null;
  const dot = ref.indexOf(".");
  const root = mesh.types.find((t) => t.name && t.name === (dot < 0 ? ref : ref.slice(0, dot)));
  if (!root) return null;
  if (dot < 0) return { kind: "struct", type: root };
  const field = root.fields.find((f) => f.path === ref.slice(dot + 1));
  return field?.variants?.length ? { kind: "enum", type: root, field } : null;
}

/* the variant names a TypeRef expands to (a Dropdown's options) */
export function variantNames(mesh: Mesh, ref: string): string[] {
  const found = resolveTypeRef(mesh, ref);
  return found?.field?.variants?.map((v) => v.name) ?? [];
}

export function typeOf(registry: Registry | null, name: string): WidgetType | null {
  if (!registry) return null;
  return registry.types.find((t) => t.name === name) ?? null;
}

function slotSpec(type: WidgetType | null, name: string): SlotSpec | null {
  if (!type) return null;
  return type.slots.find((s) => s.name === name) ?? null;
}

/* every authored slot value on this widget, visited at its dotted address */
export function eachAuthoredSlot(
  widget: Node,
  visit: (address: string, value: Json) => void,
): void {
  const walk = (level: Json, prefix: string) => {
    if (!level || typeof level !== "object" || Array.isArray(level)) return;
    for (const [key, held] of Object.entries(level)) {
      const address = prefix ? prefix + "." + key : key;
      if (held && typeof held === "object" && !Array.isArray(held)) walk(held, address);
      else visit(address, held);
    }
  };
  walk(widget.slots ?? {}, "");
}

/* which slots this instance BINDS: the authored value is an expression, so the
 * backend evaluates it standing and the cell is the runtime's to write (what the
 * `feeds` list used to say, spelled in the value itself) */
export function boundSlots(widget: Node): Set<string> {
  const out = new Set<string>();
  eachAuthoredSlot(widget, (address, value) => {
    if (slotExpression(value)) out.add(address);
  });
  return out;
}

/* Which slots the RUNTIME owns: a feed, an authored flow whose move writes the slot, or
 * the type's default behavior. This is a union, not a decision: WHICH of them wins is the
 * backend's precedence rule and is not restated here. Whether the slot is
 * written at all does not depend on that, and it is all a view needs to know. */
export function runtimeSlots(widget: Node, type: WidgetType | null): Set<string> {
  const out = boundSlots(widget);
  const written = (flows: Json[]) => {
    for (const flow of flows ?? [])
      for (const step of flow?.do ?? [])
        if (step?.kind === "move" && typeof step.to?.slot === "string" && step.to.slot)
          out.add(step.to.slot);
  };
  written(widget.flows ?? []);
  written((type?.behavior ?? []) as Json[]);
  return out;
}

/* Would a gesture on this widget DO anything? An authored flow on an event answers yes.
 * So does the type's default behavior — but only where a slot that default writes is
 * NOT fed: a fed control is a pure view of the machine and the compiler drops its
 * default, so pressing it runs nothing. Outside edit mode a widget that answers no is
 * INERT PASS-THROUGH (the stage gives it pointer-events none): a picture must never
 * swallow the press aimed at what it overlays. */
export function operable(widget: Node | null, type: WidgetType | null): boolean {
  if (!widget) return false;
  /* a trigger with a name and no kind IS an event — the backend reads it the same
     tolerant way, and the two must agree or a widget goes inert while its flow runs */
  const onEvent = (flow: Json) =>
    ((flow?.when ?? []) as Json[]).some((t: Json) =>
      t?.kind === "event" || (!t?.kind && typeof t?.name === "string" && t.name));
  if ((widget.flows ?? []).some(onEvent)) return true;
  const fed = boundSlots(widget);
  for (const flow of (type?.behavior ?? []) as Json[]) {
    if (!onEvent(flow)) continue;
    for (const step of (flow?.do ?? []) as Json[])
      if (step?.kind === "move" && typeof step.to?.slot === "string" && step.to.slot &&
          !fed.has(step.to.slot))
        return true;
  }
  return false;
}

/* the live cell key for a widget slot; the backend owns this naming */
export function slotCell(widget: Node, slot: string): string {
  return widget.id + "." + slot;
}

/* ---- nested slot values ----
 *
 * A slot's NAME is its address: bare for the widget's own properties, prefixed by the
 * owning part's path for the ones a part declares (`bar.fill_color`). An instance
 * stores them the same way it reads them — nested, one object per part — so the shape
 * of a widget's `slots` mirrors the shape of its type. */

/* what the document authors at one address, or undefined when it authors nothing there
   (including when the path runs into a non-object: a stale value is not a value) */
function slotValue(slots: Json, address: string): Json {
  let at: Json = slots;
  for (const segment of address.split(".")) {
    if (!at || typeof at !== "object" || Array.isArray(at)) return undefined;
    at = at[segment];
  }
  return at;
}

/* the same object with one address set, copied down the path it touches: op application
   replaces the widget's whole `slots` value, and nothing else may be disturbed */
export function withSlot(slots: Json, address: string, value: Json): Json {
  const segments = address.split(".");
  const root: Json = { ...((slots ?? {}) as Record<string, Json>) };
  let at = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const held = at[segments[i]];
    at[segments[i]] =
      held && typeof held === "object" && !Array.isArray(held) ? { ...held } : {};
    at = at[segments[i]];
  }
  at[segments[segments.length - 1]] = value;
  return root;
}

/* what the DOCUMENT says a slot is: the instance value, else the type default */
export function authoredSlot(widget: Node, type: WidgetType | null, name: string): Json {
  const instance = slotValue(widget.slots, name);
  if (instance !== undefined) return instance;
  const spec = slotSpec(type, name);
  return spec ? spec.default : null;
}

/* What an INSPECTOR field shows. `runtime` is the set of slots something writes
 * (runtimeSlots): for those the field is a live view of the cell, and its authored value is
 * only where that cell started. For the rest the document IS the value and the field shows
 * it, so typing is never fought by a compiled copy of the old one. */
export function editedSlot(
  widget: Node,
  type: WidgetType | null,
  live: Live | null,
  runtime: Set<string>,
  name: string,
): Json {
  if (!runtime.has(name)) return authoredSlot(widget, type, name);
  const value = live?.values?.[slotCell(widget, name)];
  return value === undefined ? null : value;
}

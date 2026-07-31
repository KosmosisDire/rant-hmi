/* Slot resolution (spec 2.3): a slot WITH a feed resolves to the live value or UNKNOWN,
 * never to a fallback; a slot without one resolves to the instance value, else the type
 * default.
 *
 * There are two readers, because the canvas and the inspector want different things from a
 * slot. `resolveSlot` is the canvas's: it DRAWS the runtime, so the runtime's cell wins
 * wherever it has one. `editedSlot` is the inspector's, and what it shows depends on who
 * OWNS the slot:
 *
 *   nobody writes it   the document IS the value, so the field shows the document. Reading
 *                      the runtime's compiled copy back would fight what the user typed.
 *   something writes it (a feed, an authored flow, or the type's own default behavior)
 *                      the document is only where the runtime STARTED. The field shows the
 *                      live value, because that is the thing the user is reasoning about
 *                      (spec 3.10), and editing it restates where the runtime starts. */

import { Cells } from "./program.js";
import { HistView, Json, Live, Mesh, MeshField, MeshType, Registry, SlotSpec, Token, WidgetType, Widget } from "./types.js";

/* ---- theme tokens (spec 2.10) ---- */

export type ThemeMode = "dark" | "light";

/* the document's tokens plus this view's mode: everything token resolution needs */
export interface Theme {
  tokens: Token[];
  mode: ThemeMode;
}

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
 * here (the pure slot layer) because the canvas resolves option lists too; the type
 * tree re-exports it. */
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

/* the variant names a TypeRef expands to (a Dropdown's options; spec 6.2) */
export function variantNames(mesh: Mesh, ref: string): string[] {
  const found = resolveTypeRef(mesh, ref);
  return found?.field?.variants?.map((v) => v.name) ?? [];
}

/* an options slot resolves to a name list: a literal array, or a TypeRef expanded
 * against the served type table */
export function optionNames(mesh: Mesh | null, raw: Json): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw && mesh) return variantNames(mesh, raw);
  return [];
}

/* The option list a widget OFFERS: the options slot resolved, then filtered by its
 * `shown_options` slot where the type declares one (comma or space separated variant
 * names; empty = all). The filter is a WHITELIST in the listed order, so it can also
 * reorder; names outside the enum are dropped. Every consumer (the pick tray, the
 * drag detents, the pointer angle, the tick marks and their labels) resolves through
 * here, so the offered list can never disagree with the drawn one. */
export function widgetOptions(
  widget: Widget,
  type: WidgetType | null,
  live: Live | null,
  fed: Set<string>,
  mesh: Mesh | null,
  raw: Json,
): string[] {
  const names = optionNames(mesh, raw);
  if (!type?.slots.some((s) => s.name === "shown_options")) return names;
  const filter = String(resolveSlot(widget, type, live, fed, "shown_options") ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!filter.length) return names;
  return filter.filter((name) => names.indexOf(name) >= 0);
}

export function typeOf(registry: Registry | null, name: string): WidgetType | null {
  if (!registry) return null;
  return registry.types.find((t) => t.name === name) ?? null;
}

export function slotSpec(type: WidgetType | null, name: string): SlotSpec | null {
  if (!type) return null;
  return type.slots.find((s) => s.name === name) ?? null;
}

/* which slots this widget instance feeds from the mesh (at most one feed per slot) */
export function fedSlots(widget: Widget): Set<string> {
  return new Set((widget.feeds ?? []).map((feed) => feed.slot));
}

/* Which slots the RUNTIME owns: a feed, an authored flow whose move writes the slot, or
 * the type's default behavior. This is a union, not a decision: WHICH of them wins is the
 * backend's precedence rule (spec 2.3) and is not restated here. Whether the slot is
 * written at all does not depend on that, and it is all a view needs to know. */
export function runtimeSlots(widget: Widget, type: WidgetType | null): Set<string> {
  const out = fedSlots(widget);
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

/* the live cell key for a widget slot; the backend owns this naming */
export function slotCell(widget: Widget, slot: string): string {
  return widget.id + "." + slot;
}

/* ---- nested slot values (spec 2.3) ----
 *
 * A slot's NAME is its address: bare for the widget's own properties, prefixed by the
 * owning part's path for the ones a part declares (`bar.fill_color`). An instance
 * stores them the same way it reads them — nested, one object per part — so the shape
 * of a widget's `slots` mirrors the shape of its type. */

/* what the document authors at one address, or undefined when it authors nothing there
   (including when the path runs into a non-object: a stale value is not a value) */
export function slotValue(slots: Json, address: string): Json {
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

export function resolveSlot(
  widget: Widget,
  type: WidgetType | null,
  live: Live | null,
  fed: Set<string>,
  name: string,
): Json {
  const value = live?.values?.[slotCell(widget, name)];
  if (value !== undefined) return value;
  if (fed.has(name)) return null; /* fed but nothing delivered yet: UNKNOWN */
  return authoredSlot(widget, type, name);
}

/* what the DOCUMENT says a slot is: the instance value, else the type default */
export function authoredSlot(widget: Widget, type: WidgetType | null, name: string): Json {
  const instance = slotValue(widget.slots, name);
  if (instance !== undefined) return instance;
  const spec = slotSpec(type, name);
  return spec ? spec.default : null;
}

/* A COLOR slot, resolved theme-aware. The live frame echoes the backend's compiled copy
 * of every slot cell — resolved in the canonical DARK mode — which would defeat per-view
 * theming for a slot the user merely authored. So a color slot nothing writes resolves
 * from the DOCUMENT (token-aware, in this view's mode); a fed or flow-written one keeps
 * live precedence (dynamic data wins: the backend computed it, and it is mode-agnostic).
 * For literals the document value and the live echo are identical, so this changes
 * nothing until a token is involved. Every paint site resolves through here. */
export function themedSlot(
  widget: Widget,
  type: WidgetType | null,
  live: Live | null,
  fed: Set<string>,
  runtime: Set<string>,
  theme: Theme,
  name: string,
): Json {
  const spec = slotSpec(type, name);
  if (spec?.shape !== "color") return resolveSlot(widget, type, live, fed, name);
  const raw = runtime.has(name)
    ? resolveSlot(widget, type, live, fed, name)
    : authoredSlot(widget, type, name);
  return resolveColor(raw, theme.tokens, theme.mode);
}

/* What an INSPECTOR field shows. `runtime` is the set of slots something writes
 * (runtimeSlots): for those the field is a live view of the cell, and its authored value is
 * only where that cell started. For the rest the document IS the value and the field shows
 * it, so typing is never fought by a compiled copy of the old one. */
export function editedSlot(
  widget: Widget,
  type: WidgetType | null,
  live: Live | null,
  runtime: Set<string>,
  name: string,
): Json {
  if (!runtime.has(name)) return authoredSlot(widget, type, name);
  const value = live?.values?.[slotCell(widget, name)];
  return value === undefined ? null : value;
}

/* the cell space a template program reads: slots, this view's interaction state, the
 * tile's own metrics, and the theme's tokens */
export function cellsFor(
  widget: Widget,
  type: WidgetType | null,
  live: Live | null,
  state: Record<string, Json>,
  mesh: Mesh | null = null,
  hists: Record<string, HistView> | null = null,
  theme: Theme | null = null,
): Cells {
  const fed = fedSlots(widget);
  const runtime = theme ? runtimeSlots(widget, type) : fed;
  return (cell: string): Json => {
    const colon = cell.indexOf(":");
    const kind = colon < 0 ? "" : cell.slice(0, colon);
    const name = colon < 0 ? cell : cell.slice(colon + 1);
    switch (kind) {
      case "slot":
        return theme
          ? themedSlot(widget, type, live, fed, runtime, theme, name)
          : resolveSlot(widget, type, live, fed, name);
      case "theme":
        /* "theme:<name>": a token straight from the theme, for template colors no slot
           names (scale marks); UNKNOWN without a theme rather than a wrong pixel */
        return theme ? resolveColor("$" + name, theme.tokens, theme.mode) : null;
      case "state":
        /* per-view, animation only; interaction lands with the scheduler stage */
        return state[name] ?? false;
      case "tile":
        /* "tile:w|h|aspect": the widget's own box. It used to be read straight off the
           authored geom, which no longer exists — a widget's box is now whatever its
           frame gives it, which only the browser knows. Until the rebuild measures it,
           the honest answer is UNKNOWN: Nil poisons the expression that asked, which is
           exactly right, because a fabricated size would silently draw the wrong picture.
           This is the one place the strip leaves a live expression unanswered, and it is
           the first thing the DOM renderer must reconnect. */
        if (name === "w" || name === "h" || name === "aspect") return null;
        return null;
      case "hist":
        /* "hist:<slot>": the slot's accumulated history view (a Trend's plot data) */
        return (hists?.[widget.id + "." + name] as unknown as Json) ?? null;
      case "optcount": {
        /* "optcount:<options slot>": how many OFFERED options resolve (a Selector's
           detent marks); null when the list is unresolvable or trivially small */
        const count = widgetOptions(widget, type, live, fed, mesh,
                                    resolveSlot(widget, type, live, fed, name)).length;
        return count >= 2 ? count : null;
      }
      case "optnames": {
        /* "optnames:<options slot>": the OFFERED option names themselves (a
           Selector's per-tick labels); null when unresolvable */
        const names = widgetOptions(widget, type, live, fed, mesh,
                                    resolveSlot(widget, type, live, fed, name));
        return names.length >= 2 ? names : null;
      }
      case "optfrac": {
        /* "optfrac:<value slot>@<options slot>": where the value slot's NAME sits in
           the OFFERED options (resolved, shown_options-filtered), as a 0..1 fraction
           (a Selector's pointer angle). Unknown value, unknown options or a name
           outside the offered list resolve to null, and the pointer part draws
           nothing: never an invented position. */
        const at = name.indexOf("@");
        if (at < 0) return null;
        const value = resolveSlot(widget, type, live, fed, name.slice(0, at));
        const options = widgetOptions(widget, type, live, fed, mesh,
                                      resolveSlot(widget, type, live, fed, name.slice(at + 1)));
        if (typeof value !== "string" || options.length < 2) return null;
        const index = options.indexOf(value);
        return index < 0 ? null : index / (options.length - 1);
      }
      default:
        return null;
    }
  };
}

/* "#rrggbb00" and friends are not painted: transparent is a real, common default */
export function opaqueEnough(color: Json): string | null {
  if (typeof color !== "string" || !color.startsWith("#")) return null;
  if (color.length === 9 && color.slice(7).toLowerCase() === "00") return null;
  return color;
}

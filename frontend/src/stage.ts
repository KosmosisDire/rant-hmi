/* The stage: a page, rendered as real DOM.
 *
 * A page is a tree of frames, and a frame is a div with flex on it. There is no
 * coordinate space here and no camera: the page IS the pane it sits in, so resizing the
 * window or dragging a sidebar re-solves the whole layout, which is the point of the
 * model. The browser owns layout AND hit testing; what this module owns is the mapping
 * from document props to style, and the selection ring drawn over the result.
 *
 * A WIDGET IS A PLACEHOLDER LEAF here. Its internals become DOM in a later milestone; what
 * it already does is paint its frame-group slots, LIVE VALUE FIRST — which is the whole of
 * a lamp: a Panel with a bound surface lights up today.
 *
 * Re-render policy: the page is rebuilt wholesale when the document version moves (cheap
 * at this scale, and reconciliation would buy nothing while nothing here holds state). A
 * live frame at 30 Hz must NOT do that, so each render records the live cells it actually
 * read, and a live frame rebuilds only when one of those moved. */

import { Editor } from "./editor.js";
import { Frame, Json, Live, Page, Token, Widget, WidgetType } from "./types.js";
import { typeOf } from "./slots.js";

/* -1 is the frame group's "auto" (registry.cpp): the radius that used to nest inside an
   island's corner, and the padding the island's inset implied. Islands are gone and the
   component renderer will settle both properly; until it does, auto is one provisional
   constant each. */
const AUTO_RADIUS = 8;
const AUTO_PAD = 0;

interface StageState {
  page: HTMLElement | null;
  /* what the last render was OF: a change here rebuilds unconditionally */
  signature: string;
  /* the live cells that render actually read, and what they read — a live frame that
     touches none of them changes nothing on screen */
  consumed: Map<string, string>;
  rings: HTMLElement[];
  wired: boolean;
}

const states = new WeakMap<HTMLElement, StageState>();

function stateOf(host: HTMLElement): StageState {
  let state = states.get(host);
  if (!state) {
    state = { page: null, signature: "", consumed: new Map(), rings: [], wired: false };
    states.set(host, state);
  }
  return state;
}

/* ---- the pure core: document values -> style ---- */

/* a colour value as CSS: "$name" reads the token custom property the page carries, and
   anything else is used verbatim (the view never resolves a token itself) */
function cssColor(value: Json): string {
  const text = typeof value === "string" ? value : "";
  return text.startsWith("$") ? "var(--t-" + text.slice(1) + ")" : text;
}

/* Is there a colour here to paint at all? "" means the author asked for no surface, and a
 * fully transparent literal is the same picture with more work. A token reference is
 * always painted: what it resolves to is the page's business, not this function's. */
function paints(value: Json): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text === "transparent" || text === "none") return false;
  return !/^#[0-9a-fA-F]{6}00$/.test(text);
}

const ALIGN_ITEMS: Record<string, string> = {
  start: "flex-start", center: "center", end: "flex-end", stretch: "stretch",
};
const JUSTIFY_CONTENT: Record<string, string> = {
  start: "flex-start", center: "center", end: "flex-end", between: "space-between",
};

/* The CROSS component of a widget's 3x3 align slot, as an align-self. A row's cross axis
 * is vertical and a column's is horizontal, so the same slot value reads differently in
 * each — which is why this asks the PARENT. Only the cross half is honoured: placing an
 * aspect-locked box on both axes belongs to the component renderer, with the box. */
function crossSelf(align: Json, parent: string): string {
  const value = typeof align === "string" ? align : "";
  if (parent === "row") {
    if (value.startsWith("top")) return "flex-start";
    if (value.startsWith("bottom")) return "flex-end";
    return "center";
  }
  if (value.endsWith("left")) return "flex-start";
  if (value.endsWith("right")) return "flex-end";
  return "center";
}

/* How a container gives one child room. `basis 0` is what makes grow a WEIGHT rather than
 * a tiebreak: two grow-1 children split a row evenly however much CONTENT each holds. A
 * child's own `pad` is not content, though — a flex basis is a content-box size, so a
 * padded child's share is its weight PLUS its padding, which is the browser's arithmetic
 * and is left alone. The two zero minimums are the flex overflow gotcha: without them a
 * long word or a wide child refuses to shrink and pushes its siblings out of the box. */
function place(node: HTMLElement, child: Frame | Widget, parent: string): void {
  const grow = typeof child.grow === "number" ? child.grow : 1;
  const min = typeof child.min === "number" ? child.min : 0;
  if (parent === "stack") {
    /* every child of a stack occupies the same cell and fills it; a stack has no main
       axis, so `min` has no axis to apply to and is deliberately not read here */
    node.style.gridArea = "1 / 1";
    node.style.minWidth = "0";
    node.style.minHeight = "0";
    return;
  }
  node.style.flex = grow + " 1 0";
  node.style.minWidth = "0";
  node.style.minHeight = "0";
  if (min > 0) {
    if (parent === "row") node.style.minWidth = min + "px";
    else node.style.minHeight = min + "px";
  }
}

/* the container half: what a frame does to the children inside it */
function container(node: HTMLElement, layout: string, gap: number, pad: number,
                   align: string, justify: string): void {
  if (layout === "stack") {
    node.style.display = "grid";
  } else {
    node.style.display = "flex";
    node.style.flexDirection = layout === "row" ? "row" : "column";
    node.style.alignItems = ALIGN_ITEMS[align] ?? "stretch";
    node.style.justifyContent = JUSTIFY_CONTENT[justify] ?? "flex-start";
  }
  if (gap) node.style.gap = gap + "px";
  if (pad) node.style.padding = pad + "px";
}

/* ---- slot resolution for a placeholder leaf ----
 *
 * LIVE FIRST: the cell the runtime publishes, else what this instance authors, else the
 * type's default. That order is what makes a bound surface a working lamp — the general
 * resolver the renderer used to share went with it, and this is the small local rule the
 * leaf needs, nothing more. Every key looked up is recorded, so the re-render policy
 * knows exactly which live cells this picture depends on. */
function leafSlot(state: StageState, live: Live | null, widget: Widget,
                  type: WidgetType | null, name: string): Json {
  const cell = widget.id + "." + name;
  const value = live?.values?.[cell];
  state.consumed.set(cell, JSON.stringify(value ?? null));
  if (value !== undefined && value !== null) return value;
  let at: Json = widget.slots;
  for (const segment of name.split(".")) {
    if (!at || typeof at !== "object" || Array.isArray(at)) { at = undefined; break; }
    at = at[segment];
  }
  if (at !== undefined) return at;
  return type?.slots.find((s) => s.name === name)?.default ?? null;
}

/* ---- building ---- */

function buildLeaf(state: StageState, editor: Editor, widget: Widget,
                   parent: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "leaf";
  node.setAttribute("data-id", String(widget.id));
  place(node, widget, parent);

  const type = typeOf(editor.registry, widget.type);
  const slot = (name: string) => leafSlot(state, editor.live, widget, type, name);

  const surface = slot("surface");
  if (paints(surface)) node.style.background = cssColor(surface);
  const border = slot("border");
  if (paints(border)) node.style.border = "1px solid " + cssColor(border);
  const radius = slot("radius");
  if (typeof radius === "number")
    node.style.borderRadius = (radius < 0 ? AUTO_RADIUS : radius) + "px";
  const pad = slot("pad");
  if (typeof pad === "number") node.style.padding = (pad < 0 ? AUTO_PAD : pad) + "px";

  /* an aspect-locked box cannot also stretch, or the lock is a lie: the cross axis stops
     stretching and the align slot says where the box sits along it */
  const aspect = slot("aspect");
  if (typeof aspect === "string" && aspect.trim()) {
    node.style.aspectRatio = aspect.trim().replace("/", " / ");
    node.style.alignSelf = crossSelf(slot("align"), parent);
  }

  const tag = document.createElement("span");
  tag.className = "leaf-tag";
  tag.textContent = widget.label || widget.type;
  node.appendChild(tag);
  return node;
}

function buildFrame(state: StageState, editor: Editor, frame: Frame,
                    parent: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "frame";
  node.setAttribute("data-id", String(frame.id));
  place(node, frame, parent);
  container(node, frame.layout, frame.gap, frame.pad, frame.align, frame.justify);
  if (paints(frame.surface)) node.style.background = cssColor(frame.surface);
  if (paints(frame.border))
    node.style.border = (frame.border_w ?? 1) + "px solid " + cssColor(frame.border);
  if (frame.radius) node.style.borderRadius = frame.radius + "px";
  for (const child of frame.children ?? [])
    node.appendChild(buildChild(state, editor, child, frame.layout));
  return node;
}

function buildChild(state: StageState, editor: Editor, child: Frame | Widget,
                    parent: string): HTMLElement {
  return child.kind === "frame"
    ? buildFrame(state, editor, child, parent)
    : buildLeaf(state, editor, child, parent);
}

/* Theme tokens become CSS custom properties on the page, so a "$name" value is an
 * ordinary var() the browser resolves — no view-side colour resolution anywhere below
 * this line. One mode for now (the editor is dark); a light/dark switch is one more
 * argument here and nothing else. */
function emitTokens(page: HTMLElement, tokens: Token[]): void {
  for (const token of tokens)
    if (token?.name) page.style.setProperty("--t-" + token.name, token.dark);
}

function buildPage(state: StageState, editor: Editor, page: Page): HTMLElement {
  const node = document.createElement("div");
  node.className = "page";
  emitTokens(node, editor.store.tokens());
  /* The page is the ROOT frame, and it is the one frame the document does not describe:
     it has no layout prop of its own, so it takes the same default a fresh frame does —
     a column, filling the pane. Its own display/direction live in stage.css. */
  for (const child of page.children ?? [])
    node.appendChild(buildChild(state, editor, child, "col"));
  return node;
}

/* ---- the selection ring ---- */

/* One absolutely positioned div per selected node, over the element it rings and outside
 * the layout entirely: nothing about a selection may move what is selected. Frames are
 * ringed too — they have real DOM now — even though they are selectable only from the
 * Layers tree. */
function positionRings(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  const selection = editor.view.selection ?? [];
  /* keep exactly as many rings as there are selected nodes */
  while (state.rings.length > selection.length) state.rings.pop()?.remove();
  while (state.rings.length < selection.length) {
    const ring = document.createElement("div");
    ring.className = "ring";
    host.appendChild(ring);
    state.rings.push(ring);
  }
  const box = host.getBoundingClientRect();
  selection.forEach((id, i) => {
    const ring = state.rings[i];
    const target = state.page?.querySelector('[data-id="' + id + '"]') as HTMLElement | null;
    if (!target) {
      ring.style.display = "none";
      return;
    }
    const at = target.getBoundingClientRect();
    ring.style.display = "";
    ring.style.left = at.left - box.left - 2 + "px";
    ring.style.top = at.top - box.top - 2 + "px";
    ring.style.width = at.width + 4 + "px";
    ring.style.height = at.height + 4 + "px";
    /* follow the shape it is ringing, one breath wider */
    const own = typeof getComputedStyle === "function"
      ? parseFloat(getComputedStyle(target).borderRadius) || 0
      : 0;
    ring.style.borderRadius = own + 2 + "px";
  });
}

/* ---- the one entry point ---- */

export function renderStage(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  wire(host, editor);

  const page = editor.page();
  if (!page) {
    state.page?.remove();
    state.page = null;
    state.signature = "";
    positionRings(host, editor);
    return;
  }

  const signature = page.id + ":" + editor.store.version();
  let rebuild = !state.page || signature !== state.signature;
  if (!rebuild)
    for (const [cell, was] of state.consumed)
      if (JSON.stringify(editor.live?.values?.[cell] ?? null) !== was) {
        rebuild = true;
        break;
      }

  if (rebuild) {
    state.consumed = new Map();
    const next = buildPage(state, editor, page);
    state.page?.remove();
    /* the rings are children of the host too, and the page must sit under them */
    host.insertBefore(next, host.firstChild);
    state.page = next;
    state.signature = signature;
  }
  positionRings(host, editor);
}

/* Listeners are attached once per host. A click SELECTS, and only a widget: a frame is
 * selected from the Layers tree alone, because a click landing on a frame is nearly
 * always a click at a gap between its children and would steal the selection from what
 * the author meant. Clicking the page background clears. */
function wire(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  if (state.wired) return;
  state.wired = true;
  host.addEventListener("click", (ev) => {
    if (editor.view.mode !== "edit") return;
    const target = (ev.target as HTMLElement | null)?.closest?.("[data-id]") as HTMLElement | null;
    const id = target ? Number(target.getAttribute("data-id")) : 0;
    editor.select(id && editor.store.widget(id) ? [id] : []);
  });
  /* the pane resizes when a sidebar is dragged or the window changes: the layout re-solves
     itself, and the ring has to be told where everything landed */
  if (typeof ResizeObserver === "function")
    new ResizeObserver(() => positionRings(host, editor)).observe(host);
}

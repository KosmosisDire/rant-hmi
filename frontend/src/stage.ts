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

import { DropPlan, seatOf } from "./arrange.js";
import { Editor } from "./editor.js";
import { armStage, stageBusy } from "./manipulate.js";
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
  /* the one ring that follows the pointer rather than the selection */
  hover: HTMLElement | null;
  /* the arrangement being SHOWN instead of the document's, while a drag is live */
  preview: Preview | null;
  wired: boolean;
}

/* A drop preview is held against the document version it was spliced from, and that is what
 * retires it: the echo of its own drop bumps the version and replaces it with the identical
 * arrangement (so there is nothing to see), and an edit arriving from another window replaces
 * it with the truth (the live drag re-reads on its next move). */
interface Preview {
  node: number;
  plan: DropPlan;
  version: number;
}

const states = new WeakMap<HTMLElement, StageState>();

function stateOf(host: HTMLElement): StageState {
  let state = states.get(host);
  if (!state) {
    state = { page: null, signature: "", consumed: new Map(), rings: [],
              hover: null, preview: null, wired: false };
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

/* How a container gives one child room. `basis 0` is what makes grow a WEIGHT rather than
 * a tiebreak: two grow-1 children split a row evenly however much CONTENT each holds. A
 * child's own `pad` is not content, though — a flex basis is a content-box size, so a
 * padded child's share is its weight PLUS its padding, which is the browser's arithmetic
 * and is left alone. The two zero minimums are the flex overflow gotcha: without them a
 * long word or a wide child refuses to shrink and pushes its siblings out of the box. */
function place(node: HTMLElement, child: Frame | Widget, parent: string, scale = 1): void {
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
  node.style.flex = grow * scale + " 1 0";
  node.style.minWidth = "0";
  node.style.minHeight = "0";
  if (min > 0) {
    if (parent === "row") node.style.minWidth = min + "px";
    else node.style.minHeight = min + "px";
  }
}

/* THE SUB-ONE SUM RULE: when a container's grow factors sum below 1, flexbox hands its
 * children only that FRACTION of the free space — weights quietly become "fractions of
 * the pane" and the container shows through the remainder. The document means grow as a
 * pure weight (types.ts, Place), so a sub-one sum is scaled back up to one; at or above
 * one the authored numbers ride through untouched, which keeps devtools legible. This is
 * not hypothetical: a boundary drag conserves a PAIR's sum, so a later remove, dissolve
 * or drag-away can leave a lone 0.77 behind — without the scale that is a hole in the
 * page, and a drag preview reading the hole as "the document's own arrangement". */
function growScale(children: (Frame | Widget)[]): number {
  let sum = 0;
  for (const child of children)
    sum += Math.max(0, typeof child.grow === "number" ? child.grow : 1);
  return sum > 0 && sum < 1 ? 1 / sum : 1;
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
                   parent: string, scale: number): HTMLElement {
  const node = document.createElement("div");
  node.className = "leaf";
  node.setAttribute("data-id", String(widget.id));
  place(node, widget, parent, scale);

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

  /* AN ASPECT-LOCKED BOX IS OUT OF THE WEIGHT SYSTEM. A flex share hands it a definite
     main size and leaves the ratio only the cross axis to bend — the lock overridden by
     layout. Anchoring it on a non-stretch align is no better: with neither axis definite
     it collapses to its content about the chosen edge. So the CROSS axis is the anchor —
     the box stretches to what the container gives, the ratio derives the main size from
     that, and it takes no share and no min floor. Cross positioning of an under-sized
     aspect box returns with the component renderer, which owns the align slot. A stack's
     cell is definite on both axes, so inside one the lock stays overridden: a stack
     means "fill the cell". */
  const aspect = slot("aspect");
  if (typeof aspect === "string" && aspect.trim() && parent !== "stack") {
    node.style.aspectRatio = aspect.trim().replace("/", " / ");
    node.style.flex = "0 0 auto";
    node.style.alignSelf = "stretch";
    if (parent === "row") node.style.minWidth = "0";
    else node.style.minHeight = "0";
  }

  const tag = document.createElement("span");
  tag.className = "leaf-tag";
  tag.textContent = widget.label || widget.type;
  node.appendChild(tag);
  return node;
}

function buildFrame(state: StageState, editor: Editor, frame: Frame,
                    parent: string, scale: number): HTMLElement {
  const node = document.createElement("div");
  node.className = "frame";
  node.setAttribute("data-id", String(frame.id));
  place(node, frame, parent, scale);
  container(node, frame.layout, frame.gap, frame.pad, frame.align, frame.justify);
  if (paints(frame.surface)) node.style.background = cssColor(frame.surface);
  if (paints(frame.border))
    node.style.border = (frame.border_w ?? 1) + "px solid " + cssColor(frame.border);
  if (frame.radius) node.style.borderRadius = frame.radius + "px";
  const inner = growScale(frame.children ?? []);
  for (const child of frame.children ?? [])
    node.appendChild(buildChild(state, editor, child, frame.layout, inner));
  return node;
}

function buildChild(state: StageState, editor: Editor, child: Frame | Widget,
                    parent: string, scale: number): HTMLElement {
  return child.kind === "frame"
    ? buildFrame(state, editor, child, parent, scale)
    : buildLeaf(state, editor, child, parent, scale);
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
  const scale = growScale(page.children ?? []);
  for (const child of page.children ?? [])
    node.appendChild(buildChild(state, editor, child, "col", scale));
  return node;
}

/* ---- the rings ---- */

/* the node one ring is drawn over, or null when there is nothing there to ring */
function nodeElement(host: HTMLElement, id: number): HTMLElement | null {
  const state = stateOf(host);
  if (!id || !state.page) return null;
  return state.page.querySelector('[data-id="' + id + '"]') as HTMLElement | null;
}

/* one breath wider than the thing it rings, and following its corners */
function ringOver(host: HTMLElement, ring: HTMLElement, target: HTMLElement | null): void {
  if (!target) {
    ring.style.display = "none";
    return;
  }
  const box = host.getBoundingClientRect();
  const at = target.getBoundingClientRect();
  ring.style.display = "";
  ring.style.left = at.left - box.left - 2 + "px";
  ring.style.top = at.top - box.top - 2 + "px";
  ring.style.width = at.width + 4 + "px";
  ring.style.height = at.height + 4 + "px";
  const own = typeof getComputedStyle === "function"
    ? parseFloat(getComputedStyle(target).borderRadius) || 0
    : 0;
  ring.style.borderRadius = own + 2 + "px";
}

/* One absolutely positioned div per selected node, over the element it rings and outside
 * the layout entirely: nothing about a selection may move what is selected. Frames are
 * ringed too — they have real DOM now — even though they are selectable only from the
 * Layers tree.
 *
 * The hover ring is the same idea over view.hover, and the two never double up: a node that
 * is already selected is not ringed twice for being pointed at as well. */
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
  selection.forEach((id, i) => ringOver(host, state.rings[i], nodeElement(host, id)));

  if (!state.hover) {
    state.hover = document.createElement("div");
    state.hover.className = "ring hover";
    host.appendChild(state.hover);
  }
  const hovered = editor.view.hover;
  const shown = hovered && selection.indexOf(hovered) < 0 && editor.view.mode === "edit";
  ringOver(host, state.hover, shown ? nodeElement(host, hovered) : null);
}

/* ---- the drop preview ----
 *
 * While a node is being dragged — from the stage or from the Layers tree — the page is drawn
 * AS IF it were already in the candidate slot. That reflow IS the preview: there is no ghost
 * rectangle to keep in step with the layout, because the layout is the answer to the question
 * the drag is asking.
 *
 * It is a rendering and never an edit. The store is untouched and no op is in flight, so an
 * abandoned drag costs nothing, and a drag that lands sends exactly one op whose echo draws
 * the same picture that is already on screen. */

/* the page with one node lifted out of its seat and put down at the plan's, on a copy: the
 * document is not touched, and the ERASE-THEN-INSERT order is the one the plan's index was
 * already counted against (arrange.ts) */
function arrangedPage(page: Page, node: number, plan: DropPlan): Page | null {
  const clone: Page = JSON.parse(JSON.stringify(page));
  const seat = seatOf(clone, node);
  if (!seat) return null;
  seat.siblings.splice(seat.index, 1);
  const holder: Page | Frame | Widget | null =
    plan.parent === clone.id ? clone : seatOf(clone, plan.parent)?.node ?? null;
  if (!holder || (holder !== clone && (holder as Frame).kind !== "frame")) return null;
  const list = (holder as Page | Frame).children ?? ((holder as Frame).children = []);
  list.splice(Math.max(0, Math.min(plan.index, list.length)), 0, seat.node);
  return clone;
}

/* what is being carried, and where it would land: both wear a mark, because a reflow alone
 * does not say which of the two things that moved is the one in your hand */
function markPreview(host: HTMLElement, preview: Preview | null): void {
  const state = stateOf(host);
  if (!state.page || !preview) return;
  nodeElement(host, preview.node)?.classList.add("preview-moving");
  /* the page is the one frame with no id of its own on it (buildPage), so a parent with no
     element IS the page */
  (nodeElement(host, preview.plan.parent) ?? state.page).classList.add("drop-target");
}

/* The one preview mechanism, driven from wherever the drag lives: the stage's own pointer
 * gestures (manipulate.ts) and the Layers tree's (inspector/panel.ts) both arrive here, so a
 * drop looks the same however it was aimed. A null plan puts the document back — which is
 * also how a cancelled resize drops the inline styles it was writing. */
export function previewArrangement(
  host: HTMLElement,
  editor: Editor,
  node: number,
  plan: DropPlan | null,
): void {
  const state = stateOf(host);
  if (node && plan) state.preview = { node, plan, version: editor.store.version() };
  else {
    state.preview = null;
    /* whatever is on screen, it is not the document: rebuild rather than reposition */
    state.signature = "";
  }
  renderStage(host, editor);
}

/* ---- the one entry point ---- */

export function renderStage(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  wire(host, editor);

  const doc = editor.page();
  if (state.preview && state.preview.version !== editor.store.version()) state.preview = null;
  const page = doc && state.preview
    ? arrangedPage(doc, state.preview.node, state.preview.plan) ?? doc
    : doc;
  if (!page) {
    state.page?.remove();
    state.page = null;
    state.signature = "";
    positionRings(host, editor);
    return;
  }

  const preview = state.preview;
  const signature = page.id + ":" + editor.store.version() +
    (preview ? ":" + preview.node + ">" + preview.plan.parent + "@" + preview.plan.index : "");
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
  markPreview(host, preview);
  positionRings(host, editor);
}

/* the node the browser's own hit test named: the deepest one under the pointer, frame or
 * widget, 0 where the event landed on the page background */
export function idUnder(target: EventTarget | null): number {
  const at = (target as HTMLElement | null)?.closest?.("[data-id]") as HTMLElement | null;
  return at ? Number(at.getAttribute("data-id")) : 0;
}

/* Listeners are attached once per host. A click SELECTS whatever the hit test named — a
 * widget from its own pixels, a frame from ITS own pixels (its padding, the gap between
 * its children, its empty room). No kind is special-cased: the hover ring has already
 * announced exactly which node those pixels belong to, so the click confirms what is
 * shown rather than guessing what was meant. Clicking the page background clears. */
function wire(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  if (state.wired) return;
  state.wired = true;
  host.addEventListener("click", (ev) => {
    if (editor.view.mode !== "edit") return;
    const id = idUnder(ev.target);
    editor.select(id ? [id] : []);
  });
  /* HOVER, the other direction of the Layers tree's own: the pointer names a node here and
     the row standing for it lights up, out of the same one piece of state. mouseover, not
     mouseenter, because it bubbles — one listener covers every node the page ever builds.
     A manipulation under way owns the pointer and takes the highlight with it. */
  host.addEventListener("mouseover", (ev) => {
    if (editor.view.mode !== "edit" || stageBusy()) return;
    editor.setHover(idUnder(ev.target));
  });
  host.addEventListener("mouseout", () => {
    if (editor.view.mode === "edit") editor.setHover(0);
  });
  /* the press gestures: dragging a node through the layout, and dragging the boundary
     between two children (manipulate.ts, which owns their precedence) */
  armStage(host, editor);
  /* the pane resizes when a sidebar is dragged or the window changes: the layout re-solves
     itself, and the ring has to be told where everything landed */
  if (typeof ResizeObserver === "function")
    new ResizeObserver(() => positionRings(host, editor)).observe(host);
}

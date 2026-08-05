/* DIRECT MANIPULATION ON THE ARTBOARD: grab a box's body to move it, grab a selection
 * handle to resize it. That is the whole gesture vocabulary now — order is z-order, so
 * there is no slot to carry a node to and no boundary to trade weight across; structure
 * (reparent, reorder) is the Layers tree's business.
 *
 * Pointer events over the page's own DOM, never the HTML5 drag API: what moves is painted
 * live in place()'s own vocabulary and committed as constants on release. None of the
 * arithmetic is here — which fields a handle may write, what snaps where, the origin
 * algebra — that is arrange.ts (freePlan), measured ONCE at the press, so the gesture
 * never chases its own output. What IS here is the pointer's own business: precedence
 * (a grip beats a body), slop, capture, Escape, and the screen-to-canvas conversion the
 * camera makes necessary.
 *
 * State is module-level and the listeners are on the window, because a render replaces
 * every element mid-drag: nothing below holds an element between events, and every move
 * re-reads what is under the pointer. */

import {
  fmtFraction, fmtPx, freeBoxOf, FreeHandle, freePlan, FreePlan, FreeWrite, seatOf,
} from "./arrange.js";
import { Editor } from "./editor.js";
import { handleCursor } from "./handles.js";

/* a press travels this far (screen px) before it is a drag rather than a click */
const SLOP = 4;

interface Armed {
  host: HTMLElement;
  editor: Editor;
  id: number;
  x: number;
  y: number;
  pointer: number;
}

/* a live gesture: moving a box by its body, or resizing it by a handle. One shape for
 * both — the handle decides which fields the plan writes. */
interface FreeGesture {
  host: HTMLElement;
  editor: Editor;
  id: number;
  pointer: number;
  handle: FreeHandle;
  plan: FreePlan;
  /* screen px per canvas px at the press: the camera's scale, measured once */
  k: number;
  /* WHAT THE COMMIT DIVIDES BY, per axis: inside a component the plan's px become
     fractions of the parent's box on release; 0 means page space, where px are written
     as they are. Measured once, with everything else. */
  sx: number;
  sy: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  snap: boolean;
}

let armed: Armed | null = null;
let free: FreeGesture | null = null;
/* a press and a release on one node fire a click even when a drag happened in between */
let swallow = false;

/* how a gesture asks the stage for its services without importing it (stage imports this
 * module): `refresh` repositions the overlay, `restore` puts the document's own picture
 * back after a cancelled or no-op gesture */
const overlayRefresh = new WeakMap<HTMLElement, () => void>();
const documentRestore = new WeakMap<HTMLElement, () => void>();

function refreshOverlay(host: HTMLElement): void {
  overlayRefresh.get(host)?.();
}

/* is the pointer in the middle of something? The hover highlight steps aside for it: a
 * second highlight following the pointer through a gesture is noise, not information. */
export function stageBusy(): boolean {
  return free !== null;
}

function idOf(node: Element | null): number {
  const id = node?.getAttribute?.("data-id") ?? "";
  return id ? Number(id) : 0;
}

/* the element one id is drawn as, re-read every time rather than held: a render between
 * two pointer events replaces it */
function nodeIn(host: HTMLElement, id: number): HTMLElement | null {
  return host.querySelector('.page [data-id="' + id + '"]') as HTMLElement | null;
}

export function armStage(host: HTMLElement, editor: Editor,
                         refresh: () => void, restore: () => void): void {
  overlayRefresh.set(host, refresh);
  documentRestore.set(host, restore);
  host.addEventListener("pointerdown", (ev) => onDown(host, editor, ev as PointerEvent));
  /* the click that closes a real drag, eaten before the node it lands on can select */
  host.addEventListener("click", (ev) => {
    if (!swallow) return;
    swallow = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);
}

function onDown(host: HTMLElement, editor: Editor, ev: PointerEvent): void {
  swallow = false;
  if (editor.view.mode !== "edit" || ev.button !== 0) return;
  /* PRECEDENCE: an explicit grip beats the body under it — it only exists over the
     selection, and pressing it can only mean the resize it names */
  const hit = (ev.target as Element | null)?.closest?.(".sel-hit");
  if (hit) {
    beginResize(host, editor, hit, ev);
    return;
  }
  /* A GRAB TAKES THE DEEPEST NODE, the same one a click would select and the hover ring
     is already showing: a press on a widget moves the widget, a press on a box's own
     pixels (its surface, its empty room) moves the box and everything riding it. The
     artboard background belongs to no node and arms nothing. */
  const grip = (ev.target as HTMLElement | null)?.closest?.("[data-id]") as HTMLElement | null;
  if (!grip || !host.contains(grip) || !idOf(grip)) return;
  armed = { host, editor, id: idOf(grip), x: ev.clientX, y: ev.clientY, pointer: ev.pointerId };
  listen();
}

/* ---- measuring: the one look at the screen a gesture takes ---- */

/* The box and its writability, in ARTBOARD px. clientWidth/clientLeft report layout px —
 * which under the camera's transform ARE artboard px — while getBoundingClientRect
 * reports screen px; dividing by the page's own rendered scale converts between them.
 * `base` is the parent's origin on the artboard, which is what lets a nested box snap to
 * the one global grid.
 *
 * INSIDE A COMPONENT the document holds fractions, and the whole plan still runs in px:
 * `scale` blows the doc's literals up to px going in (freeBoxOf), and `sx`/`sy` — the
 * parent's own px size — divide the commit back down on the way out. The seam is exactly
 * at the read and the write; every rule between them is unit-blind. */
function measure(host: HTMLElement, editor: Editor, id: number):
    { plan: (handle: FreeHandle) => FreePlan | null; k: number;
      sx: number; sy: number } | null {
  const root = editor.root();
  const seat = root ? seatOf(root, id) : null;
  const pageEl = host.querySelector(".page") as HTMLElement | null;
  const el = nodeIn(host, id);
  if (!root || !seat || !pageEl || !el) return null;
  const pageAt = pageEl.getBoundingClientRect();
  const k = pageAt.width / editor.artboard().w;
  if (!(k > 0)) return null;
  const pel = seat.parent === root.id ? pageEl : nodeIn(host, seat.parent);
  if (!pel) return null;
  const pat = pel.getBoundingClientRect();
  const at = el.getBoundingClientRect();
  const base = {
    x: (pat.left - pageAt.left) / k + pel.clientLeft,
    y: (pat.top - pageAt.top) / k + pel.clientTop,
  };
  const frac = editor.contexts.length > 0;
  const scale = frac ? { x: pel.clientWidth, y: pel.clientHeight } : { x: 1, y: 1 };
  if (frac && !(scale.x > 0 && scale.y > 0)) return null;
  const box = freeBoxOf(editor.store.nodeAt(id), {
    left: (at.left - pat.left) / k - pel.clientLeft,
    top: (at.top - pat.top) / k - pel.clientTop,
    w: at.width / k,
    h: at.height / k,
  }, scale);
  return { plan: (handle) => freePlan(handle, box, base), k,
           sx: frac ? scale.x : 0, sy: frac ? scale.y : 0 };
}

/* ---- the gestures ---- */

function beginMove(): void {
  if (!armed) return;
  const { host, editor, id, pointer, x, y } = armed;
  armed = null;
  const found = measure(host, editor, id);
  const plan = found?.plan("move") ?? null;
  /* every position holds authored logic: the press stays a click, and the inspector is
     where that logic is edited */
  if (!found || !plan) return;
  /* a new grab of a node whose commit is still settling takes over from the overlay */
  if (standing?.id === id) clearStanding();
  free = { host, editor, id, pointer, handle: "move", plan, k: found.k,
           sx: found.sx, sy: found.sy, startX: x, startY: y, dx: 0, dy: 0, snap: true };
  host.setPointerCapture?.(pointer);
  editor.setHover(0);
  host.classList.add("freemoving");
  refreshOverlay(host);
}

function beginResize(host: HTMLElement, editor: Editor, hit: Element, ev: PointerEvent): void {
  /* even a press that never becomes a drag must not click through the overlay and
     deselect the node whose handles were pressed */
  swallow = true;
  const handle = (hit.getAttribute("data-handle") ?? "") as FreeHandle;
  const id = Number(hit.closest(".handles")?.getAttribute("data-for") ?? "");
  if (!handle || !id) return;
  const found = measure(host, editor, id);
  const plan = found?.plan(handle) ?? null;
  if (!found || !plan) return;   /* a disabled grip has no hit rect; belt and braces */
  if (standing?.id === id) clearStanding();
  free = { host, editor, id, pointer: ev.pointerId, handle, plan, k: found.k,
           sx: found.sx, sy: found.sy,
           startX: ev.clientX, startY: ev.clientY, dx: 0, dy: 0, snap: !ev.altKey };
  host.setPointerCapture?.(ev.pointerId);
  editor.setHover(0);
  host.classList.add("freemoving");
  /* the cursor keeps naming the handle for the length of the drag, wherever the pointer
     has wandered off the grip by then */
  host.style.cursor = handleCursor(handle);
  refreshOverlay(host);
  listen();
}

function onMove(ev: PointerEvent): void {
  if (armed) {
    if (Math.abs(ev.clientX - armed.x) < SLOP && Math.abs(ev.clientY - armed.y) < SLOP) return;
    beginMove();
  }
  if (!free) return;
  ev.preventDefault();
  /* the pointer travels in screen px; the plan thinks in canvas px */
  free.dx = (ev.clientX - free.startX) / free.k;
  free.dy = (ev.clientY - free.startY) / free.k;
  /* Alt suspends the grid for exactly as long as it is held */
  free.snap = !ev.altKey;
  repaintFree();
}

/* A COMMITTED GESTURE'S PICTURE STANDS UNTIL ITS ECHO SETTLES. The commit is an edit
 * like any other: the document holds the OLD numbers until the backend echoes the op, and
 * the recompiled programs ride the snapshot AFTER that — so a render pass inside that
 * window would paint the box back where the drag began (the flash-back). The committed
 * numbers are re-asserted after every pass instead, until the written fields' attr text
 * has moved off its pre-commit values AND the compile epoch has moved — our own echo
 * settling, or someone else's write winning, and either way the document is then the
 * honest picture. A REFUSED edit changes nothing, ever: the timeout puts the document
 * back beside the refusal banner. This is view-side optimism only — the document store
 * is never written ahead of its echo. */
interface StandingWrite {
  host: HTMLElement;
  editor: Editor;
  id: number;
  /* the committed numbers, in place()'s own px vocabulary — what keeps being painted */
  styles: FreeWrite;
  /* each written field's attr text BEFORE the commit: any change means an echo landed */
  before: Record<string, string>;
  epoch: number;
  timer: number;
}

let standing: StandingWrite | null = null;

function clearStanding(): void {
  if (!standing) return;
  window.clearTimeout(standing.timer);
  standing = null;
}

function standingCheck(): void {
  const held = standing;
  if (!held) return;
  const doc = held.editor.store.nodeAt(held.id);
  if (!doc) {
    clearStanding();
    return;
  }
  const attrs = doc.attrs ?? {};
  const landed = Object.keys(held.before)
    .some((key) => (attrs[key] ?? "") !== held.before[key]);
  const epoch = held.editor.live?.epoch ?? 0;
  if (landed && epoch !== held.epoch) {
    clearStanding();
    return;
  }
  const el = nodeIn(held.host, held.id);
  if (!el) return;
  const to = held.styles;
  if (to.x !== undefined) el.style.left = to.x + "px";
  if (to.y !== undefined) el.style.top = to.y + "px";
  if (to.w !== undefined) el.style.width = to.w + "px";
  if (to.h !== undefined) el.style.height = to.h + "px";
}

/* the numbers on screen, in place()'s own vocabulary — and the same re-assertion after a
 * render pass repaints the element the gesture (or a still-settling commit) is holding.
 * Called by stage.ts after every pass, and by the pointer move that caused one. */
export function repaintFree(): void {
  if (free) {
    const el = nodeIn(free.host, free.id);
    if (el) {
      const to = free.plan.apply(free.dx, free.dy, free.snap);
      if (to.x !== undefined) el.style.left = to.x + "px";
      if (to.y !== undefined) el.style.top = to.y + "px";
      if (to.w !== undefined) el.style.width = to.w + "px";
      if (to.h !== undefined) el.style.height = to.h + "px";
    }
    /* the handles ride the box they ring */
    refreshOverlay(free.host);
  }
  standingCheck();
}

function onUp(ev: PointerEvent): void {
  const held = free;
  end();
  if (!held) return;
  swallow = true;
  const to = held.plan.commit((ev.clientX - held.startX) / held.k,
                              (ev.clientY - held.startY) / held.k, !ev.altKey);
  const node = held.editor.store.nodeAt(held.id);
  const moved = Object.keys(to) as (keyof FreeWrite)[];
  if (!node || !moved.length) {
    /* it ended where it began: put the document's own picture back */
    documentRestore.get(held.host)?.();
    return;
  }
  /* one op of the whole attr map, each field the TEXT of the constant the gesture
     reached — the same edit the inspector would have made, landing in the same fields.
     On a page that text is whole px; inside a component the px divide back to a
     fraction of the parent's box (the divisors were measured with everything else). */
  const attrs: Record<string, string> = { ...(node.attrs ?? {}) };
  const before: Record<string, string> = {};
  for (const key of moved) {
    before[key] = node.attrs?.[key] ?? "";
    const value = to[key] as number;
    const divisor = key === "x" || key === "w" ? held.sx : held.sy;
    attrs[key] = divisor ? fmtFraction(value / divisor) : fmtPx(value);
  }
  held.editor.apply([{ op: "set_prop", node: held.id, key: "attrs", value: attrs }]);
  clearStanding();
  const next: StandingWrite = { host: held.host, editor: held.editor, id: held.id,
                                styles: to, before,
                                epoch: held.editor.live?.epoch ?? 0, timer: 0 };
  next.timer = window.setTimeout(() => {
    if (standing !== next) return;
    clearStanding();
    documentRestore.get(next.host)?.();
  }, 2500);
  standing = next;
  held.editor.select([held.id]);
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === "Escape") cancel();
}

/* Escape drops the manipulation: what is on screen is not the document, so the document
 * is drawn again */
function cancel(): void {
  const host = free?.host ?? null;
  end();
  if (host) documentRestore.get(host)?.();
}

/* Every end path comes through here, unconditionally: a cursor, a class or a window
 * listener left behind by an abandoned gesture is a stuck editor. */
function end(): void {
  armed = null;
  if (free) {
    if (free.host.hasPointerCapture?.(free.pointer)) free.host.releasePointerCapture(free.pointer);
    free.host.classList.remove("freemoving");
    free.host.style.cursor = "";
    const host = free.host;
    free = null;
    refreshOverlay(host);
  }
  unlisten();
}

function listen(): void {
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", onKey);
}

function unlisten(): void {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", cancel);
  window.removeEventListener("keydown", onKey);
}

/* DIRECT MANIPULATION ON THE STAGE: dragging a widget to another place in the layout, and
 * dragging the boundary between two children to change how their container's room is split.
 *
 * Pointer events over the page's own DOM, never the HTML5 drag API — what this needs is the
 * opposite of what that one offers. There is no drag image to carry, because the page itself
 * reflows into the candidate arrangement and THAT is the preview; and the drop target is
 * computed here rather than nominated by the browser, because the answer is a slot between
 * two children, which is not a thing the browser can hand back.
 *
 * None of the arithmetic is here. Which gap the pointer names, whether the drop is legal, what
 * index the op carries, which boundary the pointer is on and what moving it does to grow and
 * min are all arrange.ts — the same rules the Layers tree drag goes through; this half reads
 * geometry off the DOM, hands it over, and shows the answer. What IS here is precedence, which
 * only a pointer can settle: a boundary beats a drag, and a drag beats a click.
 *
 * State is module-level and the listeners are on the window, because a render replaces every
 * element mid-drag: nothing below holds an element between events, and every move re-reads
 * what is under the pointer. */

import {
  boundaryAt, DropPlan, Extent, gapIndex, ResizePlan, ResizeSide, resizeAt, seatOf, settle,
  SideWrite, withoutHeld,
} from "./arrange.js";
import { Editor } from "./editor.js";
import { Op } from "./types.js";

/* a press travels this far before it is a drag rather than a click */
const SLOP = 4;
/* half the strip that grabs a boundary: a ~10px band centred on the gap-line */
const GRAB = 5;

interface Armed {
  host: HTMLElement;
  editor: Editor;
  id: number;
  x: number;
  y: number;
  pointer: number;
}

interface Drag {
  host: HTMLElement;
  editor: Editor;
  id: number;
  pointer: number;
  /* where the DOCUMENT has it, so a drag back to the start is recognised as no move */
  home: DropPlan;
  /* where the PREVIEW currently has it: the reading every candidate is normalised against */
  parent: number;
  index: number;
  /* the last LEGAL plan, which is what a release would send */
  plan: DropPlan | null;
}

/* the boundary between two adjacent children, which is what a resize actually grabs */
interface Boundary {
  container: HTMLElement;
  dir: "row" | "col";
  a: number;
  b: number;
  /* where the gap-line sits, and the cross extent the pair shares, in client pixels */
  line: number;
  from: number;
  to: number;
}

interface Resize {
  host: HTMLElement;
  editor: Editor;
  dir: "row" | "col";
  a: number;
  b: number;
  pointer: number;
  plan: ResizePlan;
  /* the pointer's main coordinate at the press, and how far it has travelled since */
  start: number;
  delta: number;
}

let armed: Armed | null = null;
let drag: Drag | null = null;
let resize: Resize | null = null;
/* the boundary the pointer is resting on, which owns the pointer while it is there */
let hot: Boundary | null = null;
/* a press and a release on one node fire a click even when a drag happened in between */
let swallow = false;

/* is the pointer in the middle of something, or about to be? The hover highlight steps aside
 * for it: a second highlight following the pointer through a drag is noise, not information,
 * and a lit boundary is already telling you what the press would do. */
export function stageBusy(): boolean {
  return drag !== null || resize !== null || hot !== null;
}

function idOf(node: Element | null): number {
  const id = node?.getAttribute?.("data-id") ?? "";
  return id ? Number(id) : 0;
}

/* a container's direct children, in the order they are laid out */
function kidsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter((c) => c.hasAttribute("data-id")) as HTMLElement[];
}

/* the page is the root frame and the one frame the document does not describe, so it takes
 * the same default a fresh frame does: a column */
function dirOf(editor: Editor, container: HTMLElement): "row" | "col" | "stack" {
  const frame = editor.store.frame(idOf(container));
  return frame ? frame.layout : "col";
}

/* the element one id is drawn as, re-read every time rather than held: a render between two
 * pointer events replaces it */
function nodeIn(host: HTMLElement, id: number): HTMLElement | null {
  return host.querySelector('.page [data-id="' + id + '"]') as HTMLElement | null;
}

/* ---- which boundary, if any ---- */

function boundaryIn(editor: Editor, container: HTMLElement, x: number, y: number): Boundary | null {
  const dir = dirOf(editor, container);
  if (dir === "stack") return null;   /* one cell, every child in it: no boundaries */
  const kids = kidsOf(container);
  if (kids.length < 2) return null;
  const row = dir === "row";
  const rects = kids.map((kid) => kid.getBoundingClientRect());
  const extents: Extent[] = rects.map((at) =>
    row ? { start: at.left, end: at.right, from: at.top, to: at.bottom }
        : { start: at.top, end: at.bottom, from: at.left, to: at.right });
  const index = boundaryAt(extents, row ? x : y, row ? y : x, GRAB);
  if (index === null) return null;
  return {
    container,
    dir: row ? "row" : "col",
    a: idOf(kids[index]),
    b: idOf(kids[index + 1]),
    line: (extents[index].end + extents[index + 1].start) / 2,
    from: Math.max(extents[index].from, extents[index + 1].from),
    to: Math.min(extents[index].to, extents[index + 1].to),
  };
}

/* DEEPEST FIRST: the innermost container under the pointer owns it, and the question only
 * goes up to that container's own parent where the inner one has no boundary there. Without
 * that order a pane's edge would always answer for the widget edges inside it. */
function boundaryUnder(host: HTMLElement, editor: Editor, x: number, y: number): Boundary | null {
  let at = (document.elementFromPoint(x, y) as HTMLElement | null)
    ?.closest?.(".frame, .page") as HTMLElement | null;
  while (at && host.contains(at)) {
    const found = boundaryIn(editor, at, x, y);
    if (found) return found;
    at = at.parentElement?.closest?.(".frame, .page") as HTMLElement | null;
  }
  return null;
}

/* THE AFFORDANCE: a line drawn where the boundary is, so it can be seen and not just felt
 * through a cursor. One absolutely positioned element over the page, like the rings. */
let mark: HTMLElement | null = null;

function markLine(host: HTMLElement, at: Boundary | null): void {
  host.classList.toggle("resize-x", at?.dir === "row");
  host.classList.toggle("resize-y", at?.dir === "col");
  if (!at) {
    mark?.remove();
    mark = null;
    return;
  }
  if (!mark) mark = document.createElement("div");
  mark.className = "boundary";
  if (mark.parentElement !== host) host.appendChild(mark);
  const box = host.getBoundingClientRect();
  const row = at.dir === "row";
  mark.style.left = (row ? at.line - 1 : at.from) - box.left + "px";
  mark.style.top = (row ? at.from : at.line - 1) - box.top + "px";
  mark.style.width = (row ? 2 : at.to - at.from) + "px";
  mark.style.height = (row ? at.to - at.from : 2) + "px";
}

/* the line follows the edge it is dragging, which is the same edge re-measured */
function remark(): void {
  if (!resize) return;
  const a = nodeIn(resize.host, resize.a);
  const b = nodeIn(resize.host, resize.b);
  if (!a || !b) return;
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  const row = resize.dir === "row";
  markLine(resize.host, {
    container: resize.host,
    dir: resize.dir,
    a: resize.a,
    b: resize.b,
    line: row ? (ra.right + rb.left) / 2 : (ra.bottom + rb.top) / 2,
    from: row ? Math.max(ra.top, rb.top) : Math.max(ra.left, rb.left),
    to: row ? Math.min(ra.bottom, rb.bottom) : Math.min(ra.right, rb.right),
  });
}

export function armStage(host: HTMLElement, editor: Editor): void {
  host.addEventListener("pointerdown", (ev) => onDown(host, editor, ev as PointerEvent));
  /* the boundary under the pointer, hunted on every move so the affordance is there before
     the press rather than after it */
  host.addEventListener("mousemove", (ev) => onHover(host, editor, ev as MouseEvent));
  host.addEventListener("mouseleave", () => {
    if (drag || resize) return;
    hot = null;
    markLine(host, null);
  });
  /* the click that closes a real drag, eaten before the node it lands on can select */
  host.addEventListener("click", (ev) => {
    if (!swallow) return;
    swallow = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);
}

function onHover(host: HTMLElement, editor: Editor, ev: MouseEvent): void {
  if (armed || drag || resize) return;
  if (editor.view.mode !== "edit") {
    markLine(host, null);
    return;
  }
  hot = boundaryUnder(host, editor, ev.clientX, ev.clientY);
  markLine(host, hot);
  /* the boundary owns the pointer while it is under it: the node's own highlight steps
     aside, and comes back the moment the pointer leaves the strip */
  const on = (ev.target as HTMLElement | null)?.closest?.("[data-id]") as HTMLElement | null;
  editor.setHover(hot ? 0 : idOf(on));
}

function onDown(host: HTMLElement, editor: Editor, ev: PointerEvent): void {
  swallow = false;
  if (editor.view.mode !== "edit" || ev.button !== 0) return;
  /* PRECEDENCE: a boundary is a thinner target than the children either side of it, so it
     wins the press it is under; everything else about the node stays a press on the node. */
  const edge = boundaryUnder(host, editor, ev.clientX, ev.clientY);
  if (edge) {
    beginResize(host, editor, edge, ev);
    return;
  }
  /* A GRAB TAKES THE DEEPEST WIDGET. A frame's own children cover every pixel of it, so a
     press inside one means the child that was pressed; frames are dragged from the Layers
     tree, where they have a row of their own. */
  const leaf = (ev.target as HTMLElement | null)?.closest?.(".leaf") as HTMLElement | null;
  if (!leaf || !host.contains(leaf) || !idOf(leaf)) return;
  armed = { host, editor, id: idOf(leaf), x: ev.clientX, y: ev.clientY, pointer: ev.pointerId };
  listen();
}

function begin(): void {
  if (!armed) return;
  const { host, editor, id, pointer } = armed;
  const page = editor.page();
  const seat = page ? seatOf(page, id) : null;
  armed = null;
  if (!seat) return;
  drag = {
    host,
    editor,
    id,
    pointer,
    home: { parent: seat.parent, index: seat.index },
    parent: seat.parent,
    index: seat.index,
    plan: null,
  };
  /* Capture from HERE, not from the press: a captured pointer retargets the click that
     closes it onto the capturing element, and a press that never became a drag has to stay
     an ordinary click on the node it landed on. Once it is a drag, the release ends the
     gesture wherever it happens, including outside the window. */
  host.setPointerCapture?.(pointer);
  editor.setHover(0);
  host.classList.add("dragging");
}

function onMove(ev: PointerEvent): void {
  if (resize) {
    onResizeMove(ev);
    return;
  }
  if (armed) {
    if (Math.abs(ev.clientX - armed.x) < SLOP && Math.abs(ev.clientY - armed.y) < SLOP) return;
    begin();
  }
  if (!drag) return;
  ev.preventDefault();
  const { host, editor } = drag;
  const page = editor.page();
  if (!page) return;

  /* HIT-TEST THE PREVIEW, which is what is on screen: hovering a leaf resolves to the
     container holding it, and that leaf takes part in the midpoint rule below like any
     other. Off the page entirely, the last legal preview stands. */
  const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
  const container = under?.closest?.(".frame, .page") as HTMLElement | null;
  if (!container || !host.contains(container)) return;
  const holder = idOf(container) || page.id;
  const kids = kidsOf(container);
  const dir = dirOf(editor, container);

  /* THE MIDPOINT RULE along the container's main axis. A stack has no main axis to read, so
     it accepts at the end and nothing more. */
  let raw = kids.length;
  if (dir !== "stack") {
    const row = dir === "row";
    const mids = kids.map((kid) => {
      const at = kid.getBoundingClientRect();
      return row ? at.left + at.width / 2 : at.top + at.height / 2;
    });
    raw = gapIndex(mids, row ? ev.clientX : ev.clientY);
  }
  /* the DOM being read already holds the dragged node, so every slot past it is one too far:
     this is what makes the pointer resting over its own preview mean where it already is */
  const index = withoutHeld(raw, kids.findIndex((kid) => idOf(kid) === drag!.id));
  if (holder === drag.parent && index === drag.index) return;   /* already showing exactly this */

  const plan = settle(page, drag.id, { parent: holder, index });
  if (plan) {
    drag.parent = holder;
    drag.index = index;
    drag.plan = plan;
    host.classList.remove("no-drop");
    editor.previewMove(drag.id, plan);
    return;
  }
  /* Back where it started is not a move, and the arrangement to show for it is the document
     itself. Anything else the rules refuse says so, and the last legal preview stands. */
  if (holder === drag.home.parent && index === drag.home.index) {
    drag.parent = holder;
    drag.index = index;
    drag.plan = null;
    host.classList.remove("no-drop");
    editor.previewMove(0, null);
  } else {
    host.classList.add("no-drop");
  }
}

function onUp(): void {
  if (resize) {
    finishResize();
    return;
  }
  const held = drag;
  end();
  if (!held) return;
  swallow = true;
  if (!held.plan) {
    held.editor.previewMove(0, null);
    return;
  }
  /* the client always sends the whole placement, reparent or reorder: the same op the tree
     sends, through the same rules */
  held.editor.apply([
    { op: "move", node: held.id, parent: held.plan.parent, list: "children", index: held.plan.index },
  ]);
  held.editor.select([held.id]);
  /* the preview STAYS until the echo retires it. It and the applied arrangement are the same
     picture, so there is nothing to see; rebuilding from the document here would flick the
     page back to where the node was for the length of a round trip. */
}

/* ---- dragging the boundary ----
 *
 * The two sides are measured ONCE, at the press: what they are worth in pixels now, and what
 * the document says they are worth in grow and min. Everything after that is the pointer's
 * travel through arrange.ts, so the drag never chases its own output. */

function measure(editor: Editor, host: HTMLElement, id: number, row: boolean): ResizeSide | null {
  const node = editor.store.node(id);
  const element = nodeIn(host, id);
  if (!node || !element) return null;
  const at = element.getBoundingClientRect();
  const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
  const px = (value: string | undefined) => parseFloat(value ?? "") || 0;
  /* the part of the outer size that is NOT the flex share: a basis of 0 means a side is its
     own padding and border plus what it is paid */
  const chrome = style
    ? row
      ? px(style.paddingLeft) + px(style.paddingRight) +
        px(style.borderLeftWidth) + px(style.borderRightWidth)
      : px(style.paddingTop) + px(style.paddingBottom) +
        px(style.borderTopWidth) + px(style.borderBottomWidth)
    : 0;
  return {
    grow: typeof node.grow === "number" ? node.grow : 1,
    min: typeof node.min === "number" ? node.min : 0,
    outer: row ? at.width : at.height,
    chrome,
  };
}

function beginResize(host: HTMLElement, editor: Editor, edge: Boundary, ev: PointerEvent): void {
  const row = edge.dir === "row";
  const a = measure(editor, host, edge.a, row);
  const b = measure(editor, host, edge.b, row);
  const plan = a && b ? resizeAt(a, b) : null;
  if (!plan) return;   /* an inert boundary is not a gesture: the press stays a press */
  resize = {
    host, editor, dir: edge.dir, a: edge.a, b: edge.b, pointer: ev.pointerId, plan,
    start: row ? ev.clientX : ev.clientY,
    delta: 0,
  };
  host.setPointerCapture?.(ev.pointerId);
  host.classList.add("resizing");
  editor.setHover(0);
  markLine(host, edge);
  listen();
}

/* the same vocabulary place() emits, written inline for the length of the drag: the browser
 * re-solves the layout on every move with no op in flight and nothing to undo */
function paint(host: HTMLElement, id: number, write: SideWrite | null, row: boolean): void {
  const element = write ? nodeIn(host, id) : null;
  if (!element || !write) return;
  if (write.grow !== undefined) element.style.flex = write.grow + " 1 0";
  if (write.min !== undefined) {
    if (row) element.style.minWidth = write.min + "px";
    else element.style.minHeight = write.min + "px";
  }
}

function onResizeMove(ev: PointerEvent): void {
  if (!resize) return;
  ev.preventDefault();
  const row = resize.dir === "row";
  resize.delta = (row ? ev.clientX : ev.clientY) - resize.start;
  const move = resize.plan.apply(resize.delta);
  paint(resize.host, resize.a, move.a, row);
  paint(resize.host, resize.b, move.b, row);
  remark();
}

/* One batch on release, of the one or two props that actually moved. The echo rebuilds the
 * page into the picture the inline styles are already showing, so there is nothing to see —
 * and the inspector's own Place rows pick the new numbers up the ordinary way. */
function finishResize(): void {
  const held = resize;
  end();
  if (!held) return;
  swallow = true;
  const move = held.plan.commit(held.delta);
  const ops: Op[] = [];
  const write = (id: number, side: SideWrite | null) => {
    const node = side ? held.editor.store.node(id) : null;
    if (!side || !node) return;
    const grow = typeof node.grow === "number" ? node.grow : 1;
    const min = typeof node.min === "number" ? node.min : 0;
    if (side.grow !== undefined && side.grow !== grow)
      ops.push({ op: "set_prop", node: id, key: "grow", value: side.grow });
    if (side.min !== undefined && side.min !== min)
      ops.push({ op: "set_prop", node: id, key: "min", value: side.min });
  };
  write(held.a, move.a);
  write(held.b, move.b);
  /* the boundary ended where it started: drop the inline styles rather than sending a move
     of nothing, by rebuilding the page from the document */
  if (!ops.length) {
    held.editor.previewMove(0, null);
    return;
  }
  held.editor.apply(ops);
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === "Escape") cancel();
}

/* Escape drops whichever manipulation is live, and both are undone the same way: what is on
 * screen is not the document, so the document is drawn again. */
function cancel(): void {
  const editor = drag?.editor ?? resize?.editor ?? null;
  end();
  editor?.previewMove(0, null);
}

/* Every end path comes through here, unconditionally: a cursor, a class or a window listener
 * left behind by an abandoned gesture is a stuck editor. */
function end(): void {
  armed = null;
  hot = null;
  if (drag) {
    if (drag.host.hasPointerCapture?.(drag.pointer)) drag.host.releasePointerCapture(drag.pointer);
    drag.host.classList.remove("dragging", "no-drop");
    drag = null;
  }
  if (resize) {
    if (resize.host.hasPointerCapture?.(resize.pointer))
      resize.host.releasePointerCapture(resize.pointer);
    resize.host.classList.remove("resizing");
    markLine(resize.host, null);
    resize = null;
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

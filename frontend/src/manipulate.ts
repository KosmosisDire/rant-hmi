/* DIRECT MANIPULATION ON THE STAGE: dragging a widget to another place in the layout.
 *
 * Pointer events over the page's own DOM, never the HTML5 drag API — what this needs is the
 * opposite of what that one offers. There is no drag image to carry, because the page itself
 * reflows into the candidate arrangement and THAT is the preview; and the drop target is
 * computed here rather than nominated by the browser, because the answer is a slot between
 * two children, which is not a thing the browser can hand back.
 *
 * None of the arithmetic is here. Which gap the pointer names, whether the drop is legal and
 * what index the op carries are all arrange.ts, the same rules the Layers tree drag goes
 * through; this half reads geometry off the DOM, hands it over, and shows the answer. What IS
 * here is precedence, which only a pointer can settle: a drag beats a click.
 *
 * State is module-level and the listeners are on the window, because a render replaces every
 * element mid-drag: nothing below holds an element between events, and every move re-reads
 * what is under the pointer. */

import { DropPlan, gapIndex, seatOf, settle, withoutHeld } from "./arrange.js";
import { Editor } from "./editor.js";

/* a press travels this far before it is a drag rather than a click */
const SLOP = 4;

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

let armed: Armed | null = null;
let drag: Drag | null = null;
/* a press and a release on one node fire a click even when a drag happened in between */
let swallow = false;

/* is the pointer in the middle of something? The hover highlight steps aside for it: a
 * second highlight following the pointer through a drag is noise, not information. */
export function stageBusy(): boolean {
  return drag !== null;
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

export function armStage(host: HTMLElement, editor: Editor): void {
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

function onKey(ev: KeyboardEvent): void {
  if (ev.key === "Escape") cancel();
}

function cancel(): void {
  const held = drag;
  end();
  if (held) held.editor.previewMove(0, null);
}

/* Every end path comes through here, unconditionally: a cursor, a class or a window listener
 * left behind by an abandoned gesture is a stuck editor. */
function end(): void {
  armed = null;
  if (drag) {
    if (drag.host.hasPointerCapture?.(drag.pointer)) drag.host.releasePointerCapture(drag.pointer);
    drag.host.classList.remove("dragging", "no-drop");
    drag = null;
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

/* The stage: a page, rendered as real DOM — and, inside every instance, the component it
 * names, rendered the same way.
 *
 * ONE RENDERER, because there is one tree. A page's frames and a component's internals are
 * the same four kinds (frame, text, icon, path) with the same fields, so this walks a
 * VIEW NODE — kind, layout, compiled attrs, children — and never asks where it came from.
 * A page node's programs ride the snapshot (`node_attrs`), a component's ride its served
 * template, and both are run by the same interpreter over the same cells.
 *
 * WHAT THE BROWSER OWNS: layout, hit testing and scaling. A row is `display: flex`, a free
 * frame is `position: relative` with absolutely-placed children, ink is an `<svg>` leaf.
 * There is no coordinate space here and no camera: the page IS the pane it sits in, so
 * resizing the window re-solves the whole layout, which is the point of the model.
 *
 * WHAT EXPRESSIONS OWN: values. Every field is a program over cells — a slot's live value,
 * a theme token, this view's gesture state, which copy of a `repeat` this is — and what
 * comes out is a colour, a fraction, a string. Expressions compute; CSS lays out.
 *
 * Re-render policy: the page is rebuilt wholesale when the document version moves (cheap
 * at this scale, and reconciliation would buy nothing while nothing here holds state). A
 * live frame at 30 Hz must NOT do that, so each render records the live cells it actually
 * read, and a live frame rebuilds only when one of those moved. */

import { DropPlan, seatOf } from "./arrange.js";
import { Editor } from "./editor.js";
import { iconMarkup } from "./icons.js";
import { armStage, stageBusy } from "./manipulate.js";
import { attrText, Cells, run } from "./program.js";
import { typeOf } from "./slots.js";
import {
  Attrs, CompiledAnchor, isInstance, Json, Layout, Node, Page, Program, TemplateNode,
  Token, WidgetType,
} from "./types.js";

/* a `repeat` may not run away with the page: the same ceiling the backend names */
const REPEAT_CAP = 512;

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

/* ---- what one node looks like to the renderer ----
 *
 * The document half (what it IS and what it holds) and the compiled half (what its fields
 * evaluate to) meet here. A page node brings its own id, so it can be selected, ringed and
 * dragged; a component's node has none, because what you select on the page is the
 * instance, and what you would edit inside it is the component's own node in its own
 * tree. */
interface ViewNode {
  id: number;                 /* 0 inside a component: not addressable from the page */
  /* this node IS an instance's box (already resolved to its component's root): the drag
     and select rules mark it, and nothing else about it is special */
  instance: boolean;
  kind: string;
  name: string;
  layout: Layout;
  attrs: Attrs;
  anchors: CompiledAnchor[];
  closed: boolean;
  children: ViewNode[];
  /* the instance this node's cells belong to, and the type it is rendering: an instance
     switches both for everything below it */
  owner: number;
  type: WidgetType | null;
  /* the address prefix inside the component ("" at its root): a slot's own address is
     this plus the node's name, which is exactly how the backend built the slot table */
  path: string;
}

/* One page node, with its compiled attrs found by id.
 *
 * AN INSTANCE RESOLVES HERE, once: the component's root node IS the instance's box, so
 * this returns that root wearing the instance's id — the component's layout, attrs and
 * children, with the instance's own attrs overriding per key (that is how one placement
 * is dressed and placed). There is no wrapper box and no second node, which is also why
 * nothing downstream has to know an instance from a frame. */
function pageNode(editor: Editor, node: Node): ViewNode {
  const compiled = editor.nodeAttrs?.[String(node.id)];
  if (isInstance(node)) {
    const type = typeOf(editor.registry, node.type ?? "");
    const root = type?.template
      ? templateNode(type.template, node.id, type, "")
      : null;
    return {
      id: node.id,
      instance: true,
      kind: root?.kind ?? "frame",
      name: node.name || (node.type ?? ""),
      layout: root?.layout ?? "free",
      attrs: { ...(root?.attrs ?? {}), ...(compiled?.attrs ?? {}) },
      anchors: root?.anchors ?? [],
      closed: root?.closed ?? false,
      children: root?.children ?? [],
      owner: node.id,
      type,
      path: "",
    };
  }
  return {
    id: node.id,
    instance: false,
    kind: node.kind,
    name: node.name ?? "",
    layout: (node.layout ?? "free") as Layout,
    attrs: compiled?.attrs ?? {},
    anchors: compiled?.anchors ?? [],
    closed: node.closed ?? false,
    children: (node.children ?? []).map((c) => pageNode(editor, c)),
    owner: 0,
    type: null,
    path: "",
  };
}

/* one node of a component's served template, under the instance whose cells it reads */
function templateNode(node: TemplateNode, owner: number, type: WidgetType | null,
                      path: string): ViewNode {
  const name = node.name ?? "";
  return {
    id: 0,
    instance: false,
    kind: node.kind,
    name,
    layout: (node.layout ?? "free") as Layout,
    attrs: node.attrs ?? {},
    anchors: node.anchors ?? [],
    closed: node.closed ?? false,
    children: (node.children ?? []).map((c) =>
      templateNode(c, owner, type, path ? path + "." + name : name)),
    owner,
    type,
    path,
  };
}

/* ---- the pure core: a value -> style ---- */

/* a colour value as CSS: "$name" reads the token custom property the page carries, and
   anything else is used verbatim (the view never resolves a token itself) */
function cssColor(value: Json): string {
  const text = typeof value === "string" ? value : "";
  return text.startsWith("$") ? "var(--t-" + text.slice(1) + ")" : text;
}

/* Is there a colour here to paint at all? Absent means the author asked for no surface,
 * and a fully transparent literal is the same picture with more work. A token reference is
 * always painted: what it resolves to is the page's business, not this function's. */
function paints(value: Json): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text === "transparent" || text === "none") return false;
  return !/^#[0-9a-fA-F]{6}00$/.test(text);
}

function num(value: Json): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truthy(value: Json): boolean {
  return value === true || (typeof value === "number" && value !== 0) ||
         (typeof value === "string" && value.length > 0);
}

const ALIGN_ITEMS: Record<string, string> = {
  start: "flex-start", center: "center", end: "flex-end", stretch: "stretch",
};
const JUSTIFY_CONTENT: Record<string, string> = {
  start: "flex-start", center: "center", end: "flex-end", between: "space-between",
};
const TEXT_ALIGN: Record<string, string> = {
  start: "left", center: "center", end: "right",
};

/* a percentage from a FRACTION of the containing box: the coordinate system every
   measured field works in, so a component is right at every size the page gives it */
function pct(value: number): string {
  return value * 100 + "%";
}

/* ---- reading a node's fields ---- */

/* The cells one node's programs read. `slot:` is the instance's own value — LIVE FIRST:
 * the cell the runtime publishes, else what this placement authors, else the type's
 * default, which is the whole of what makes a bound surface a working lamp. Every live key
 * looked up is recorded, so the re-render policy knows exactly which cells this picture
 * depends on. */
function cellsFor(state: StageState, editor: Editor, node: ViewNode,
                  repeat: { index: number; count: number } | null): Cells {
  return (cell: string): Json => {
    const colon = cell.indexOf(":");
    const kind = colon < 0 ? "" : cell.slice(0, colon);
    const name = colon < 0 ? cell : cell.slice(colon + 1);
    switch (kind) {
      case "slot": {
        if (!node.owner) return null;
        const key = node.owner + "." + name;
        const live = editor.live?.values?.[key];
        state.consumed.set(key, JSON.stringify(live ?? null));
        if (live !== undefined && live !== null) return live;
        const widget = editor.store.nodeAt(node.owner);
        let at: Json = widget?.slots;
        for (const segment of name.split(".")) {
          if (!at || typeof at !== "object" || Array.isArray(at)) { at = undefined; break; }
          at = at[segment];
        }
        if (at !== undefined) return at;
        return node.type?.slots.find((s) => s.name === name)?.default ?? null;
      }
      /* a token is a CSS custom property, not a colour this view resolves: the page root
         carries the values and the browser swaps them with the theme */
      case "theme":
        return "$" + name;
      /* this view's own gesture state. Nothing drives it in edit mode — gestures on DOM
         events are their own milestone — so it reads false rather than inventing a
         pressed-looking widget nobody is pressing. */
      case "state":
        return editor.view.state?.[node.owner]?.[name] ?? false;
      case "repeat": {
        if (!repeat) return null;
        if (name === "index") return repeat.index;
        if (name === "count") return repeat.count;
        /* the FRACTION of the way through: 0 at the first copy, 1 at the last, which is
           what places a tick at its own value rather than a step past it */
        return repeat.count > 1 ? repeat.index / (repeat.count - 1) : 0;
      }
      case "hist": {
        if (!node.owner) return null;
        const key = node.owner + "." + name;
        const series = editor.live?.hist?.[key];
        state.consumed.set("hist:" + key, JSON.stringify(series ?? null));
        return series ?? null;
      }
      /* optcount/optnames/optfrac: an option list is a mesh TYPE's variants, and the
         resolver that expanded them went with the SVG renderer. Nil until it returns,
         which draws no detents rather than the wrong ones. Nothing else reaches here —
         `tile` is refused at compile now, since a node cannot measure itself. */
      default:
        return null;
    }
  };
}

function attrOf(node: ViewNode, name: string, cells: Cells): Json {
  const program = node.attrs?.[name] as Program | undefined;
  return program ? run(program, cells) : undefined;
}

/* ---- placing and painting ---- */

/* How a node sits in what holds it. TWO SPACES, one rule each:
 *
 *   ARRANGEMENT (row, col, grid) — `grow` is a WEIGHT and `basis 0` is what makes it one:
 *   two grow-1 children split a row evenly however much content each holds. The two zero
 *   minimums are the flex overflow gotcha; without them a long word refuses to shrink and
 *   pushes its siblings out of the box.
 *
 *   MEASUREMENT (free) — the node places itself, in fractions of this box. Both edges pin
 *   when neither x nor w is set, which is why an overlay needs nothing said about it: that
 *   is what "stack" used to mean, and it falls out of the general rule rather than being
 *   a mode of its own. */
function place(el: HTMLElement, node: ViewNode, parent: Layout, cells: Cells,
               scale: number): void {
  const aspect = num(attrOf(node, "aspect", cells));

  if (parent === "free") {
    el.style.position = "absolute";
    const x = num(attrOf(node, "x", cells));
    const y = num(attrOf(node, "y", cells));
    const w = num(attrOf(node, "w", cells));
    const h = num(attrOf(node, "h", cells));
    const ox = num(attrOf(node, "origin_x", cells)) ?? 0;
    const oy = num(attrOf(node, "origin_y", cells)) ?? 0;
    if (w === null && x === null) { el.style.left = "0"; el.style.right = "0"; }
    else { el.style.left = pct(x ?? 0); if (w !== null) el.style.width = pct(w); }
    if (h === null && y === null) { el.style.top = "0"; el.style.bottom = "0"; }
    else { el.style.top = pct(y ?? 0); if (h !== null) el.style.height = pct(h); }
    if (aspect !== null && aspect > 0) el.style.aspectRatio = String(aspect);

    /* ONE REFERENCE POINT serves both jobs: the point `x`/`y` places, and the pivot
       `rotate` turns about. A needle authored with its origin at its hub therefore
       rotates about the dial's centre with nothing else said. */
    const rotate = num(attrOf(node, "rotate", cells));
    const parts: string[] = [];
    if (ox || oy) parts.push("translate(" + pct(-ox) + ", " + pct(-oy) + ")");
    if (rotate !== null) parts.push("rotate(" + rotate + "deg)");
    if (parts.length) {
      el.style.transform = parts.join(" ");
      el.style.transformOrigin = pct(ox) + " " + pct(oy);
    }
    return;
  }

  const grow = num(attrOf(node, "grow", cells)) ?? 1;
  const min = num(attrOf(node, "min", cells)) ?? 0;
  if (parent === "grid") {
    el.style.minWidth = "0";
    el.style.minHeight = "0";
    if (aspect !== null && aspect > 0) el.style.aspectRatio = String(aspect);
    return;
  }

  /* AN ASPECT-LOCKED CHILD IS OUT OF THE WEIGHT SYSTEM. A flex share hands it a definite
     main size and leaves the ratio only the cross axis to bend — the lock overridden by
     layout. Anchoring it on a non-stretch align is no better: with neither axis definite
     it collapses to its content. So the CROSS axis is the anchor: it stretches to what the
     container gives, and the ratio derives the main size from that. */
  if (aspect !== null && aspect > 0) {
    el.style.aspectRatio = String(aspect);
    el.style.flex = "0 0 auto";
    el.style.alignSelf = "stretch";
    /* the cell can REFUSE the ratio: clamped rather than allowed to overflow into a
       sibling, because a shape that spills is a worse lie than one that squares up. A cell
       that cannot hold the ratio is really a finding about the size the component was
       given, which is what the envelope contract will say properly. */
    el.style.maxWidth = "100%";
    el.style.maxHeight = "100%";
    if (parent === "row") el.style.minWidth = "0";
    else el.style.minHeight = "0";
    return;
  }
  /* GROW 0 MEANS "TAKE NO SHARE", NOT "TAKE NOTHING": with a zero basis it would also
     give up its content's own size, and a caption asking for no share of the row would
     vanish rather than sit at its natural width. So a weighted child gets basis 0 (which
     is what makes grow a weight) and an unweighted one gets its content. */
  el.style.flex = grow > 0 ? grow * scale + " 1 0" : "0 0 auto";
  el.style.minWidth = "0";
  el.style.minHeight = "0";
  if (min > 0) {
    if (parent === "row") el.style.minWidth = min + "px";
    else el.style.minHeight = min + "px";
  }
}

/* THE SUB-ONE SUM RULE: when a container's grow factors sum below 1, flexbox hands its
 * children only that FRACTION of the free space — weights quietly become "fractions of the
 * pane" and the container shows through the remainder. The document means grow as a pure
 * weight, so a sub-one sum is scaled back up to one; at or above one the authored numbers
 * ride through untouched, which keeps devtools legible. */
function growScale(children: ViewNode[], cells: (node: ViewNode) => Cells): number {
  let sum = 0;
  for (const child of children)
    sum += Math.max(0, num(attrOf(child, "grow", cells(child))) ?? 1);
  return sum > 0 && sum < 1 ? 1 / sum : 1;
}

/* the container half: what a frame does to what is inside it */
function container(el: HTMLElement, node: ViewNode, cells: Cells): void {
  const gap = num(attrOf(node, "gap", cells)) ?? 0;
  const pad = num(attrOf(node, "pad", cells)) ?? 0;
  if (node.layout === "free") {
    /* free children are absolute, so the box only has to be their origin */
    el.style.position = el.style.position || "relative";
    if (!el.style.position) el.style.position = "relative";
  } else if (node.layout === "grid") {
    const cols = Math.max(1, Math.round(num(attrOf(node, "cols", cells)) ?? 2));
    const rows = Math.round(num(attrOf(node, "rows", cells)) ?? 0);
    el.style.display = "grid";
    el.style.gridTemplateColumns = "repeat(" + cols + ", minmax(0, 1fr))";
    if (rows > 0) el.style.gridTemplateRows = "repeat(" + rows + ", minmax(0, 1fr))";
  } else {
    const align = attrText(attrOf(node, "align", cells)) ?? "stretch";
    const justify = attrText(attrOf(node, "justify", cells)) ?? "start";
    el.style.display = "flex";
    el.style.flexDirection = node.layout === "row" ? "row" : "column";
    el.style.alignItems = ALIGN_ITEMS[align] ?? "stretch";
    el.style.justifyContent = JUSTIFY_CONTENT[justify] ?? "flex-start";
  }
  if (gap) el.style.gap = gap + "px";
  if (pad) el.style.padding = pad + "px";
}

/* the dressing every box wears, whatever holds it */
function dress(el: HTMLElement, node: ViewNode, cells: Cells): void {
  const surface = attrOf(node, "surface", cells);
  if (paints(surface)) el.style.background = cssColor(surface);
  const border = attrOf(node, "border", cells);
  if (paints(border))
    el.style.border = (num(attrOf(node, "border_w", cells)) ?? 1) + "px solid " +
                      cssColor(border);
  const radius = num(attrOf(node, "radius", cells));
  if (radius !== null) el.style.borderRadius = radius + "px";
  const clip = attrOf(node, "clip", cells);
  if (clip !== undefined && clip !== null && truthy(clip)) {
    el.style.overflow = "hidden";
    const rounded = num(clip);
    if (rounded !== null && rounded > 0) el.style.borderRadius = rounded + "px";
  }
}

/* ---- the ink ----
 *
 * A path is an <svg> filling the node's box with a 0..1 viewBox, so every anchor is a
 * FRACTION and the shape scales with whatever room it is given. `preserveAspectRatio:
 * none` is deliberate — the box is the coordinate system — and a shape that must stay
 * round (a dial) says so with `aspect: 1` rather than by hoping. The stroke is exempted
 * from that scaling (`non-scaling-stroke`), because a line's weight is a pixel fact. */
function anchorPoint(anchor: CompiledAnchor, cells: Cells): { x: number; y: number } | null {
  const x = num(anchor.x ? run(anchor.x, cells) : null);
  const y = num(anchor.y ? run(anchor.y, cells) : null);
  return x === null || y === null ? null : { x, y };
}

function pathData(node: ViewNode, cells: Cells): string {
  /* DATA-DRIVEN ANCHORS: a series plotted across the box, left to right. This is the one
     shape the language cannot fold into anchors itself yet; when it can, the attr becomes
     sugar for that fold and this branch goes away. */
  const points = attrOf(node, "points", cells);
  if (Array.isArray(points)) {
    const lo = num(attrOf(node, "y_min", cells)) ?? 0;
    const hi = num(attrOf(node, "y_max", cells)) ?? 1;
    const span = hi - lo || 1;
    const parts: string[] = [];
    points.forEach((value: Json, i: number) => {
      const v = num(value);
      if (v === null) return;   /* an honest gap: no capture, no point */
      const x = points.length > 1 ? i / (points.length - 1) : 0;
      const y = 1 - (v - lo) / span;
      parts.push((parts.length ? "L" : "M") + x + " " + y);
    });
    return parts.join(" ");
  }

  const parts: string[] = [];
  for (const anchor of node.anchors ?? []) {
    const at = anchorPoint(anchor, cells);
    if (!at) continue;
    if (!parts.length) { parts.push("M" + at.x + " " + at.y); continue; }
    if (anchor.arc) {
      const rx = num(run(anchor.arc.rx, cells)) ?? 0;
      const ry = num(run(anchor.arc.ry, cells)) ?? rx;
      const large = truthy(anchor.arc.large ? run(anchor.arc.large, cells) : false) ? 1 : 0;
      const sweep = truthy(anchor.arc.sweep ? run(anchor.arc.sweep, cells) : false) ? 1 : 0;
      parts.push("A" + rx + " " + ry + " 0 " + large + " " + sweep + " " + at.x + " " + at.y);
      continue;
    }
    parts.push("L" + at.x + " " + at.y);
  }
  if (parts.length && node.closed) parts.push("Z");
  return parts.join(" ");
}

function buildPath(node: ViewNode, cells: Cells): HTMLElement {
  const host = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1 1");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";
  svg.style.overflow = "visible";
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData(node, cells));
  const fill = attrOf(node, "fill", cells);
  path.setAttribute("fill", paints(fill) ? cssColor(fill) : "none");
  const stroke = attrOf(node, "stroke", cells);
  if (paints(stroke)) {
    path.setAttribute("stroke", cssColor(stroke));
    path.setAttribute("stroke-width", String(num(attrOf(node, "stroke_w", cells)) ?? 1));
    path.setAttribute("vector-effect", "non-scaling-stroke");
    const cap = attrText(attrOf(node, "cap", cells));
    if (cap) path.setAttribute("stroke-linecap", cap);
    path.setAttribute("stroke-linejoin", "round");
  }
  svg.appendChild(path);
  host.appendChild(svg);
  return host;
}

function buildText(node: ViewNode, cells: Cells): HTMLElement {
  const el = document.createElement("div");
  const value = attrOf(node, "text", cells);
  /* UNKNOWN renders the unknown treatment, never a fabricated value */
  const text = attrText(value);
  el.className = "ink-text" + (text === null ? " unknown" : "");
  el.textContent = text === null ? "--" : text;
  const color = attrOf(node, "color", cells);
  if (paints(color)) el.style.color = cssColor(color);
  const size = num(attrOf(node, "size", cells));
  if (size !== null) el.style.fontSize = size + "px";
  const align = attrText(attrOf(node, "align", cells)) ?? "start";
  el.style.textAlign = TEXT_ALIGN[align] ?? "left";
  if (truthy(attrOf(node, "bold", cells))) el.style.fontWeight = "600";
  if (!truthy(attrOf(node, "wrap", cells))) {
    el.style.whiteSpace = "nowrap";
    el.style.overflow = "hidden";
    el.style.textOverflow = "ellipsis";
  }
  return el;
}

function buildIcon(node: ViewNode, cells: Cells): HTMLElement {
  const el = document.createElement("div");
  el.className = "ink-icon";
  const name = attrText(attrOf(node, "name", cells)) ?? "";
  const stroke = num(attrOf(node, "stroke_w", cells)) ?? 1.5;
  /* the glyph fills the box the layout gave it (stage.css sizes the svg to 100%), so the
     markup's own size argument is irrelevant here and the box is the only lever */
  el.innerHTML = name ? iconMarkup(name, 24, stroke) : "";
  const color = attrOf(node, "color", cells);
  if (paints(color)) el.style.color = cssColor(color);
  return el;
}

/* ---- building ---- */

function buildNode(state: StageState, editor: Editor, node: ViewNode, parent: Layout,
                   scale: number, repeat: { index: number; count: number } | null): HTMLElement | null {
  const cells = cellsFor(state, editor, node, repeat);

  /* `show` false hides the node AND everything under it, and it is not emitted at all, so
     it takes no room either — the honest reading of "not shown" in a layout */
  const show = attrOf(node, "show", cells);
  if (show !== undefined && !truthy(show)) return null;

  const el = node.kind === "path" ? buildPath(node, cells)
           : node.kind === "text" ? buildText(node, cells)
           : node.kind === "icon" ? buildIcon(node, cells)
           : document.createElement("div");
  if (node.kind === "frame") el.className = "frame";
  if (node.instance) el.classList.add("leaf");

  /* FAIL-SAFE, and only in a mode that operates: a disabled control is dimmed everywhere,
     and inert only where a pointer would be operating it. In EDIT mode it still takes the
     pointer, because a control you cannot operate is not a control you cannot select. */
  const enabled = attrOf(node, "enabled", cells);
  if (enabled !== undefined && !truthy(enabled)) {
    el.classList.add("disabled");
    if (editor.view.mode !== "edit") el.style.pointerEvents = "none";
  }
  if (node.id) el.setAttribute("data-id", String(node.id));
  place(el, node, parent, cells, scale);

  if (node.kind !== "frame") return el;

  dress(el, node, cells);
  container(el, node, cells);
  const inner = growScale(node.children, (child) => cellsFor(state, editor, child, repeat));
  for (const child of node.children)
    for (const copy of expand(state, editor, child, node.layout, inner, repeat))
      el.appendChild(copy);
  return el;
}

/* `repeat` N copies of one node, each seeing which copy it is. In a row, col or grid the
 * copies are real siblings; in a free frame each places itself, which is how a scale's
 * ticks and an option ring are authored — one node, N answers. */
function expand(state: StageState, editor: Editor, node: ViewNode, parent: Layout,
                scale: number,
                outer: { index: number; count: number } | null): HTMLElement[] {
  const cells = cellsFor(state, editor, node, outer);
  const declared = node.attrs?.repeat ? num(attrOf(node, "repeat", cells)) : null;
  if (declared === null) {
    const one = buildNode(state, editor, node, parent, scale, outer);
    return one ? [one] : [];
  }
  const count = Math.max(0, Math.min(REPEAT_CAP, Math.round(declared)));
  const out: HTMLElement[] = [];
  for (let index = 0; index < count; index++) {
    const copy = buildNode(state, editor, node, parent, scale, { index, count });
    if (copy) out.push(copy);
  }
  return out;
}

/* Theme tokens become CSS custom properties on the page, so a "$name" value is an ordinary
 * var() the browser resolves — no view-side colour resolution anywhere below this line. */
function emitTokens(page: HTMLElement, tokens: Token[]): void {
  for (const token of tokens)
    if (token?.name) page.style.setProperty("--t-" + token.name, token.dark);
}

function buildPage(state: StageState, editor: Editor, page: Page): HTMLElement {
  const el = document.createElement("div");
  el.className = "page";
  emitTokens(el, editor.store.tokens());
  /* The page is the ROOT frame, and the one frame the document does not describe: it has
     no layout of its own, so it takes the same default a fresh frame does — a column,
     filling the pane. Its own display/direction live in stage.css. */
  const children = (page.children ?? []).map((child) => pageNode(editor, child));
  const scale = growScale(children, (child) => cellsFor(state, editor, child, null));
  for (const child of children)
    for (const copy of expand(state, editor, child, "col", scale, null))
      el.appendChild(copy);
  return el;
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
 * the layout entirely: nothing about a selection may move what is selected.
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
  const holder: Page | Node | null =
    plan.parent === clone.id ? clone : seatOf(clone, plan.parent)?.node ?? null;
  if (!holder) return null;
  const list = (holder as Page | Node).children ?? ((holder as Node).children = []);
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

  /* WHAT THE PICTURE IS OF: the page, the document version — and the COMPILE EPOCH, which
     is the one that catches an edit changing what a field evaluates to rather than what the
     tree holds. A page node's attrs are programs; editing one leaves the tree identical and
     the version moved, and the new programs arrive in the snapshot that follows. Without the
     epoch here a boundary drag would commit its number and then redraw the old one. */
  const preview = state.preview;
  const signature = page.id + ":" + editor.store.version() + ":" + (editor.live?.epoch ?? 0) +
    (preview ? ":" + preview.node + ">" + preview.plan.parent + "@" + preview.plan.index : "");
  let rebuild = !state.page || signature !== state.signature;
  if (!rebuild)
    for (const [cell, was] of state.consumed) {
      const now = cell.startsWith("hist:")
        ? editor.live?.hist?.[cell.slice(5)]
        : editor.live?.values?.[cell];
      if (JSON.stringify(now ?? null) !== was) {
        rebuild = true;
        break;
      }
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

/* the node the browser's own hit test named: the deepest one under the pointer, 0 where
 * the event landed on the page background. Only PAGE nodes carry an id, so a component's
 * internals answer with the instance that holds them — which is what you select. */
export function idUnder(target: EventTarget | null): number {
  const at = (target as HTMLElement | null)?.closest?.("[data-id]") as HTMLElement | null;
  return at ? Number(at.getAttribute("data-id")) : 0;
}

/* Listeners are attached once per host. A click SELECTS whatever the hit test named — an
 * instance from its own pixels, a frame from ITS own pixels (its padding, the gap between
 * its children, its empty room). No kind is special-cased: the hover ring has already
 * announced exactly which node those pixels belong to, so the click confirms what is shown
 * rather than guessing what was meant. Clicking the page background clears. */
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

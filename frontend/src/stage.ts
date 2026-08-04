/* The stage: the ARTBOARD, rendered as real DOM — and, inside every instance, the
 * component it names, rendered the same way.
 *
 * ONE RENDERER, because there is one tree. A page's boxes and a component's internals are
 * the same four kinds (frame, text, icon, path) with the same fields, so this walks a
 * VIEW NODE — kind, compiled attrs, children — and never asks where it came from. A page
 * node's programs ride the snapshot (`node_attrs`), a component's ride its served
 * template, and both are run by the same interpreter over the same cells.
 *
 * TWO SPACES, one rule each. A PAGE NODE is canvas px of the 1408x792 artboard, relative
 * to its parent's origin: what is written is what renders, and the whole artboard scales
 * into the pane as ONE picture (the camera below). A COMPONENT'S INTERNALS are fractions
 * of their parent, because a component must fill whatever box an instance gives it — its
 * design frame is its natural size, not a coordinate space. Which space a node is in is
 * a fact the tree already states: page nodes carry ids, template nodes do not.
 *
 * THE CAMERA: scale-to-fit letterbox by default, wheel pans, ctrl+wheel zooms at the
 * pointer, middle-drag pans. One transform on the .page element; everything drawn OVER
 * the page (rings, handles) reads post-transform rects and never knows the camera exists.
 *
 * WHAT EXPRESSIONS OWN: values. Every field is a program over cells — a slot's live value,
 * a theme token, this view's gesture state, which copy of a `repeat` this is — and what
 * comes out is a colour, a number, a string. Expressions compute; CSS places.
 *
 * Re-render policy: the page is rebuilt wholesale when the document version moves (cheap
 * at this scale, and reconciliation would buy nothing while nothing here holds state). A
 * live frame at 30 Hz must NOT do that, so each render records the live cells it actually
 * read, and a live frame rebuilds only when one of those moved. */

import { DropPlan, freeAllowed, freeBoxOf, snapPx } from "./arrange.js";
import { Editor, HistRing } from "./editor.js";
import { armInteract } from "./gestures.js";
import { HANDLE_MARGIN, handleMarkup, handlesOff } from "./handles.js";
import { iconMarkup } from "./icons.js";
import { armStage, repaintFree, stageBusy } from "./manipulate.js";
import { attrText, Cells, run } from "./program.js";
import { operable, typeOf } from "./slots.js";
import {
  Attrs, CANVAS_H, CANVAS_W, CompiledAnchor, Interact, isInstance, Json, Node, Page,
  Program, TemplateNode, Token, WidgetType,
} from "./types.js";

/* a `repeat` may not run away with the page: the same ceiling the backend names */
const REPEAT_CAP = 512;

/* the camera: where the artboard sits in the pane, and at what scale */
interface Camera {
  x: number;
  y: number;
  k: number;
  /* the user has taken the camera: a pane resize stops re-fitting over their head */
  manual: boolean;
}

interface StageState {
  page: HTMLElement | null;
  /* what the last render was OF: a change here rebuilds unconditionally */
  signature: string;
  /* the live cells that render actually read, and what they read — a live frame that
     touches none of them changes nothing on screen */
  consumed: Map<string, string>;
  /* the state: cells the render read ("<owner>:<name>"): a gesture writing one of these
     repaints; writing any other is invisible and costs nothing */
  consumedState: Set<string>;
  /* rebuild and re-render this host: what a gesture's state write calls when it landed
     on a consumed cell (set by renderStage, which knows the host) */
  repaint: () => void;
  rings: HTMLElement[];
  /* the one ring that follows the pointer rather than the selection */
  hover: HTMLElement | null;
  /* the selection handles over a lone selected node: ring, pills, brackets (handles.ts) */
  handles: SVGSVGElement | null;
  cam: Camera;
  /* THE ARTBOARD'S OWN SIZE: the fixed canvas on a page, the context's preview box
     inside an entered widget — what the camera fits and the gestures divide by */
  art: { w: number; h: number };
  /* which page or entered-widget chain the picture is of (preview size excluded): a
     step in or out refits the camera, a preview resize deliberately does not */
  ctxPath: string;
  /* the preview-resize grips on the artboard's edge, up only inside a context */
  artGrips: HTMLElement[];
  /* every built plot: the path element and what redraws its `d`. A STREAMING RING MUST
     NOT REBUILD THE PAGE — a trend appends samples many times a second forever, and a
     full rebuild per sample replaces the DOM a press is holding — so a change that is
     ONLY hist-cells redraws these in place and touches nothing else. */
  plots: { el: SVGPathElement; node: ViewNode; cells: Cells }[];
  /* a program is reading hist cells inside a plot's own `points`: what lets cellsFor
     tell a plot's consumption from a loose one (a label showing hist(value).avg), which
     still needs the full rebuild */
  inPlot: boolean;
  histLoose: boolean;
  wired: boolean;
}

const states = new WeakMap<HTMLElement, StageState>();

function stateOf(host: HTMLElement): StageState {
  let state = states.get(host);
  if (!state) {
    state = { page: null, signature: "", consumed: new Map(),
              consumedState: new Set(), repaint: () => undefined, rings: [],
              hover: null, handles: null, cam: { x: 0, y: 0, k: 1, manual: false },
              art: { w: CANVAS_W, h: CANVAS_H }, ctxPath: "", artGrips: [],
              plots: [], inPlot: false, histLoose: false,
              wired: false };
    states.set(host, state);
  }
  return state;
}

/* ---- the camera ---- */

/* the artboard, scaled to sit whole in the pane with a breath of margin around it */
function fitCamera(host: HTMLElement, state: StageState): void {
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (!(w > 0) || !(h > 0)) return;
  const cam = state.cam;
  cam.k = Math.min(w / state.art.w, h / state.art.h) * 0.96;
  cam.x = (w - state.art.w * cam.k) / 2;
  cam.y = (h - state.art.h * cam.k) / 2;
}

function applyCamera(state: StageState): void {
  if (!state.page) return;
  state.page.style.transform =
    "translate(" + state.cam.x + "px, " + state.cam.y + "px) scale(" + state.cam.k + ")";
}

/* THE SCALE between screen px and artboard px, which is what the gestures divide by: read
 * off the rendered page rather than the camera, so a caller needs no camera at all */
export function stageScale(host: HTMLElement): number {
  const state = stateOf(host);
  if (!state.page) return 1;
  const at = state.page.getBoundingClientRect();
  return at.width > 0 ? at.width / state.art.w : 1;
}

/* ---- what one node looks like to the renderer ----
 *
 * The document half (what it IS and what it holds) and the compiled half (what its fields
 * evaluate to) meet here. A page node brings its own id, so it can be selected, ringed and
 * dragged; a component's node has none, because what you select on the page is the
 * instance, and what you would edit inside it is the component's own node in its own
 * tree. */
interface ViewNode {
  id: number;                 /* 0 where the node is nobody's to address: a template's */
  /* this node IS an instance's box (already resolved to its component's root): the drag
     and select rules mark it, and nothing else about it is special */
  instance: boolean;
  kind: string;
  name: string;
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
  /* which unit system this node's numbers are in: FRACTIONS of the parent inside a
     component (a template's nodes, and the doc nodes of an entered one), canvas px on a
     page. A fact set where the node is built, not inferred — an entered component's
     nodes carry ids AND fractions. */
  frac: boolean;
  /* the gesture riding this node, COMPILED (params are programs): the served template is
     the one compiled source of interact rows, so only template-built nodes — and the
     instance box wearing its component root — carry one. An entered component's doc
     nodes hold interact as authored text and stay unarmed here. */
  interact: Interact | null;
}

/* One document node, with its compiled attrs found by id — a page's, or an entered
 * component's: `owner`, `type` and `frac` say whose cells its programs read and which
 * space its numbers live in, and both callers pass their own.
 *
 * AN INSTANCE RESOLVES HERE, once: the component's root node IS the instance's box, so
 * this returns that root wearing the instance's id — the component's layout, attrs and
 * children, with the instance's own attrs overriding per key (that is how one placement
 * is dressed and placed). There is no wrapper box and no second node, which is also why
 * nothing downstream has to know an instance from a frame. */
function pageNode(editor: Editor, node: Node, owner = 0,
                  type: WidgetType | null = null, frac = false): ViewNode {
  const compiled = editor.nodeAttrs?.[String(node.id)];
  if (isInstance(node)) {
    const instType = typeOf(editor.registry, node.type ?? "");
    const root = instType?.template
      ? templateNode(instType.template, node.id, instType, "")
      : null;
    return {
      id: node.id,
      instance: true,
      kind: root?.kind ?? "frame",
      name: node.name || (node.type ?? ""),
      attrs: { ...(root?.attrs ?? {}), ...(compiled?.attrs ?? {}) },
      anchors: root?.anchors ?? [],
      closed: root?.closed ?? false,
      children: root?.children ?? [],
      owner: node.id,
      type: instType,
      path: "",
      frac,
      interact: root?.interact ?? null,
    };
  }
  return {
    id: node.id,
    instance: false,
    kind: node.kind,
    name: node.name ?? "",
    attrs: compiled?.attrs ?? {},
    anchors: compiled?.anchors ?? [],
    closed: node.closed ?? false,
    children: (node.children ?? []).map((c) => pageNode(editor, c, owner, type, frac)),
    owner,
    type,
    path: "",
    frac,
    interact: null,
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
    attrs: node.attrs ?? {},
    anchors: node.anchors ?? [],
    closed: node.closed ?? false,
    children: (node.children ?? []).map((c) =>
      templateNode(c, owner, type, path ? path + "." + name : name)),
    owner,
    type,
    path,
    frac: true,
    interact: node.interact ?? null,
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

const TEXT_ALIGN: Record<string, string> = {
  start: "left", center: "center", end: "right",
};

/* a percentage from a FRACTION of the containing box: the coordinate system a
   component's internals work in, so one authoring is right at every instance size */
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
      /* this view's own gesture state (gestures.ts writes it outside edit mode). The
         read is RECORDED so a write repaints exactly the pictures that bind it; in edit
         mode nothing writes, and it honestly reads false — never a pressed-looking
         widget nobody is pressing. */
      case "state": {
        state.consumedState.add(node.owner + ":" + name);
        return editor.view.state?.[node.owner]?.[name] ?? false;
      }
      case "repeat": {
        if (!repeat) return null;
        if (name === "index") return repeat.index;
        if (name === "count") return repeat.count;
        /* the FRACTION of the way through: 0 at the first copy, 1 at the last, which is
           what places a tick at its own value rather than a step past it */
        return repeat.count > 1 ? repeat.index / (repeat.count - 1) : 0;
      }
      /* A TREND CELL IS A LIST: the shell's standing ring (editor.ts), not the frame's
         delta. One series reads as the samples themselves -- programs load a cell as often
         as they like, and a copy per load is a copy per frame for nothing -- and a wider
         one as a list of samples, each its own list of series (histRows caches that). What
         is RECORDED is the ring's version: comparing thousands of samples per frame to
         find out whether a plot moved is the cost this counter exists to remove. */
      case "hist": {
        if (!node.owner) return null;
        const key = node.owner + "." + name;
        const ring = editor.hist?.(key) ?? null;
        state.consumed.set("hist:" + key, histMark(ring));
        /* a hist read OUTSIDE a plot's `points` (a label showing hist(value).avg) keeps
           the full rebuild honest: the in-place redraw below only repaints plots */
        if (!state.inPlot) state.histLoose = true;
        if (!ring) return null;
        return ring.series === 1 ? ring.values : histRows(ring);
      }
      /* optcount/optnames/optfrac: an option list is a value now -- the `options` param
         evaluates to a real list -- so nothing needs a cell of its own to expand one.
         Nothing else reaches here: `tile` is refused at compile, since a node cannot
         measure itself. */
      default:
        return null;
    }
  };
}

/* what a hist cell's dependency is worth comparing: the ring's version, or one mark for
   "nothing has arrived", which a first frame moves off */
function histMark(ring: HistRing | null): string {
  return ring ? String(ring.version) : "-";
}

/* a multi-series ring as one list per SAMPLE, cached on the ring and thrown away the
   moment its version moves: a map body may load the cell once per element, and chunking
   per load would make a plot quadratic in its own sample count */
function histRows(ring: HistRing): (number | null)[][] {
  if (ring.chunks && ring.chunks.version === ring.version) return ring.chunks.rows;
  const rows: (number | null)[][] = [];
  for (let at = 0; at + ring.series <= ring.values.length; at += ring.series)
    rows.push(ring.values.slice(at, at + ring.series));
  ring.chunks = { version: ring.version, rows };
  return rows;
}

function attrOf(node: ViewNode, name: string, cells: Cells): Json {
  const program = node.attrs?.[name] as Program | undefined;
  return program ? run(program, cells) : undefined;
}

/* A gesture's view-local look (state.pressed / dragging / open) lands here. The write is
 * free; the REPAINT happens only when some rendered program actually read that cell —
 * which the build recorded — so a widget that never binds its state costs nothing to
 * press. */
function gestureStateWriter(state: StageState, editor: Editor) {
  return (owner: number, name: string, value: Json): void => {
    const bucket = (editor.view.state[owner] ??= {});
    if (bucket[name] === value) return;
    bucket[name] = value;
    if (state.consumedState.has(owner + ":" + name)) state.repaint();
  };
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
function place(el: HTMLElement, node: ViewNode, cells: Cells): void {
  el.style.position = "absolute";
  /* which unit system this node's numbers are in: page nodes are canvas px, a
     component's internals are fractions of their parent (the builder said which) */
  const px = !node.frac;
  const unit = (value: number) => (px ? value + "px" : pct(value));
  const aspect = num(attrOf(node, "aspect", cells));
  const x = num(attrOf(node, "x", cells));
  const y = num(attrOf(node, "y", cells));
  const w = num(attrOf(node, "w", cells));
  const h = num(attrOf(node, "h", cells));
  const ox = num(attrOf(node, "origin_x", cells)) ?? 0;
  const oy = num(attrOf(node, "origin_y", cells)) ?? 0;
  if (w === null && x === null) { el.style.left = "0"; el.style.right = "0"; }
  else { el.style.left = unit(x ?? 0); if (w !== null) el.style.width = unit(w); }
  if (h === null && y === null) { el.style.top = "0"; el.style.bottom = "0"; }
  else { el.style.top = unit(y ?? 0); if (h !== null) el.style.height = unit(h); }
  if (aspect !== null && aspect > 0) el.style.aspectRatio = String(aspect);

  /* ONE REFERENCE POINT serves both jobs: the point `x`/`y` places, and the pivot
     `rotate` turns about — a fraction of the node's OWN box in either unit system, so a
     needle authored with its origin at its hub rotates about the dial's centre with
     nothing else said. */
  const rotate = num(attrOf(node, "rotate", cells));
  const parts: string[] = [];
  if (ox || oy) parts.push("translate(" + pct(-ox) + ", " + pct(-oy) + ")");
  if (rotate !== null) parts.push("rotate(" + rotate + "deg)");
  if (parts.length) {
    el.style.transform = parts.join(" ");
    el.style.transformOrigin = pct(ox) + " " + pct(oy);
  }
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
  /* COMPUTED ANCHORS: `points` is a LIST OF POINTS the expression folded itself -- a map
     over a trend cell, scaled by whatever the author wrote -- so the shape of a plot is
     ordinary language work rather than a privileged attr the renderer knows the meaning
     of. Every point is fractions of the box, exactly like an authored anchor.
     A GAP BREAKS THE LINE: an element that is not a point (a Nil sample, anything
     malformed) ends the subpath, and the next valid point opens a new one with M. The
     flat-number branch this replaced drew straight through such a hole, which is a line
     through samples nobody took. */
  const points = attrOf(node, "points", cells);
  if (Array.isArray(points)) {
    const parts: string[] = [];
    let drawing = false;
    for (const point of points) {
      const x = point && typeof point === "object" ? num((point as Json).x) : null;
      const y = point && typeof point === "object" ? num((point as Json).y) : null;
      if (x === null || y === null) {
        drawing = false;
        continue;
      }
      parts.push((drawing ? "L" : "M") + x + " " + y);
      drawing = true;
    }
    if (parts.length && node.closed) parts.push("Z");
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

function buildPath(state: StageState, node: ViewNode, cells: Cells): HTMLElement {
  const host = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1 1");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";
  svg.style.overflow = "visible";
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  state.inPlot = true;
  path.setAttribute("d", pathData(node, cells));
  state.inPlot = false;
  state.plots.push({ el: path, node, cells });
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

function buildNode(state: StageState, editor: Editor, node: ViewNode,
                   repeat: { index: number; count: number } | null): HTMLElement | null {
  const cells = cellsFor(state, editor, node, repeat);

  /* `show` false hides the node AND everything under it, and it is not emitted at all —
     the honest reading of "not shown" */
  const show = attrOf(node, "show", cells);
  if (show !== undefined && !truthy(show)) return null;

  const el = node.kind === "path" ? buildPath(state, node, cells)
           : node.kind === "text" ? buildText(node, cells)
           : node.kind === "icon" ? buildIcon(node, cells)
           : document.createElement("div");
  /* `.frame` MEANS "CAN HOLD A CHILD", and an instance cannot: what is inside it belongs
     to the component it names. The class is what every container search reads — the drop's
     candidate hunt — so an instance wearing it would let a drop aim into a widget's
     internals. It is a leaf here, which is exactly what it is to this page. */
  if (node.kind === "frame") el.className = node.instance ? "leaf" : "frame";

  /* OUTSIDE EDIT MODE THE POINTER OPERATES THE MACHINE. An instance takes it only where
     a gesture would RUN something (INERT PASS-THROUGH: a widget with no event-triggered
     flow and no live default is a picture, and a picture must never swallow the press
     aimed at what it overlays); a bare page node never takes it at all. pointer-events
     inherits, so the instance root's answer covers its internals — and the gesture the
     component put on a node (the pill, the track, the dial) arms on that very node, so
     the pressable area is the painted control, hit-tested by the browser. */
  if (editor.view.mode !== "edit") {
    if (node.instance)
      el.style.pointerEvents =
        operable(editor.store.widget(node.id), node.type) ? "auto" : "none";
    else if (!node.owner) el.style.pointerEvents = "none";
    if (node.interact && node.owner)
      armInteract(el, { editor, owner: node.owner, type: node.type,
                        interact: node.interact, cells,
                        setState: gestureStateWriter(state, editor) });
  }

  /* FAIL-SAFE, and only in a mode that operates: a disabled control is dimmed everywhere,
     and inert only where a pointer would be operating it. In EDIT mode it still takes the
     pointer, because a control you cannot operate is not a control you cannot select. */
  const enabled = attrOf(node, "enabled", cells);
  if (enabled !== undefined && !truthy(enabled)) {
    el.classList.add("disabled");
    if (editor.view.mode !== "edit") el.style.pointerEvents = "none";
  }
  if (node.id) el.setAttribute("data-id", String(node.id));
  place(el, node, cells);

  if (node.kind !== "frame") return el;

  dress(el, node, cells);
  for (const child of node.children)
    for (const copy of expand(state, editor, child, repeat))
      el.appendChild(copy);
  return el;
}

/* `repeat` N copies of one node, each seeing which copy it is and placing itself, which
 * is how a scale's ticks and an option ring are authored — one node, N answers */
function expand(state: StageState, editor: Editor, node: ViewNode,
                outer: { index: number; count: number } | null): HTMLElement[] {
  const cells = cellsFor(state, editor, node, outer);
  const declared = node.attrs?.repeat ? num(attrOf(node, "repeat", cells)) : null;
  if (declared === null) {
    const one = buildNode(state, editor, node, outer);
    return one ? [one] : [];
  }
  const count = Math.max(0, Math.min(REPEAT_CAP, Math.round(declared)));
  const out: HTMLElement[] = [];
  for (let index = 0; index < count; index++) {
    const copy = buildNode(state, editor, node, { index, count });
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

/* THE ARTBOARD: a fixed px surface the camera scales into the pane. On a page it is the
 * system's 1408 x 792 and its children are page nodes in canvas px. Inside an ENTERED
 * WIDGET it is the component's design frame at the context's preview size, its children
 * the component's OWN nodes in fractions — the same nodes with their ids, which is what
 * lets selection and the gestures work on them — reading the entered instance's cells,
 * so the component behaves as that placement does while it is edited. An unforked
 * BUILT-IN renders from its served template instead: no ids anywhere, and that absence
 * IS the read-only. */
function buildPage(state: StageState, editor: Editor, page: Page | null): HTMLElement {
  const el = document.createElement("div");
  el.className = "page";
  el.style.width = state.art.w + "px";
  el.style.height = state.art.h + "px";
  emitTokens(el, editor.store.tokens());

  const ctx = editor.contexts[editor.contexts.length - 1] ?? null;
  let kids: ViewNode[] = [];
  let rootAttrs: Attrs | null = null;
  let owner = 0;
  let type: WidgetType | null = null;
  if (!ctx) {
    kids = (page?.children ?? []).map((c) => pageNode(editor, c));
  } else {
    type = typeOf(editor.registry,
                  editor.store.nodeAt(ctx.from)?.type ?? ctx.builtin);
    owner = ctx.from;
    if (ctx.component) {
      const comp = editor.store.node(ctx.component);
      kids = ((comp?.children ?? []) as Node[]).map((c) =>
        pageNode(editor, c, owner, type, true));
      rootAttrs = editor.nodeAttrs?.[String(ctx.component)]?.attrs ?? null;
    } else if (type) {
      kids = (type.template.children ?? []).map((c) => templateNode(c, owner, type, ""));
      rootAttrs = type.template.attrs ?? null;
    }
  }

  /* the design frame wears the component ROOT's own dressing — an instance's box IS
     this node — over the artboard surface the page style gives it */
  if (rootAttrs) {
    const root: ViewNode = { id: 0, instance: false, kind: "frame", name: "",
                             attrs: rootAttrs, anchors: [], closed: false, children: [],
                             owner, type, path: "", frac: true, interact: null };
    dress(el, root, cellsFor(state, editor, root, null));
  }

  for (const child of kids)
    for (const copy of expand(state, editor, child, null))
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

  /* THE HANDLES: a lone selected node wears the old designer's selection box — a ring on
     its own line, four edge pills, four corner brackets (handles.ts) — in place of the
     plain ring. Everything on the artboard is in measurement space now, so every node
     qualifies; a grip whose fields hold expressions is drawn disarmed, because direct
     manipulation writes constants, never over authored logic (arrange.ts). */
  const lone = selection.length === 1 ? selection[0] : 0;
  const target = lone ? nodeElement(host, lone) : null;
  const dressed = !!target && editor.view.mode === "edit";
  if (!dressed) {
    state.handles?.remove();
    state.handles = null;
  } else {
    if (!state.handles) {
      state.handles = document.createElementNS("http://www.w3.org/2000/svg", "svg") as
        SVGSVGElement;
      state.handles.setAttribute("class", "handles");
      host.appendChild(state.handles);
    }
    const svg = state.handles;
    const box = host.getBoundingClientRect();
    const at = target!.getBoundingClientRect();
    /* legality reads only the document's own flags, so the measured half can be zeros */
    const shape = freeBoxOf(editor.store.nodeAt(lone), { left: 0, top: 0, w: 0, h: 0 });
    const off = handlesOff((handle) => freeAllowed(shape, handle));
    /* redrawn only when what it says changes; repositioned every time */
    const signature = [lone, at.width.toFixed(1), at.height.toFixed(1),
                       Array.from(off).join(",")].join("|");
    if (svg.getAttribute("data-sig") !== signature) {
      svg.setAttribute("data-sig", signature);
      svg.setAttribute("data-for", String(lone));
      const w = at.width + 2 * HANDLE_MARGIN;
      const h = at.height + 2 * HANDLE_MARGIN;
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
      svg.setAttribute("viewBox", "0 0 " + w + " " + h);
      svg.innerHTML = handleMarkup(at.width, at.height, off);
    }
    svg.style.left = at.left - box.left - HANDLE_MARGIN + "px";
    svg.style.top = at.top - box.top - HANDLE_MARGIN + "px";
    /* the plain ring under the overlay would double the line: it draws its own */
    if (state.rings[0]) state.rings[0].style.display = "none";
  }

  /* THE GRID: the artboard's own cells, up whenever the page is being edited. The
     lines live in canvas space (stage.css) and scale with the camera, so the picture and
     the numbers always agree. */
  state.page?.classList.toggle("gridded", editor.view.mode === "edit");
  positionArtGrips(host, editor);
}

/* ---- the preview-resize grips: trying the component at another size ----
 *
 * Only inside a context, and deliberately NOT the selection handles: these resize the
 * SESSION'S preview box — nothing is written anywhere — so they sit on the artboard's
 * own edge (E, S and the corner, the frame grips) and talk to the context directly.
 * Alt slips the grid here exactly as it does in a real resize. */
function positionArtGrips(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  const on = editor.contexts.length > 0 && !!state.page && editor.view.mode === "edit";
  if (!on) {
    for (const grip of state.artGrips) grip.remove();
    state.artGrips = [];
    return;
  }
  if (!state.artGrips.length) {
    for (const edge of ["e", "s", "se"]) {
      const grip = document.createElement("div");
      grip.className = "art-grip";
      grip.setAttribute("data-edge", edge);
      grip.addEventListener("pointerdown", (ev) =>
        beginArtResize(host, editor, edge, ev as PointerEvent));
      host.appendChild(grip);
      state.artGrips.push(grip);
    }
  }
  const box = host.getBoundingClientRect();
  const at = state.page!.getBoundingClientRect();
  const [e, s, se] = state.artGrips;
  e.style.left = at.right - box.left + "px";
  e.style.top = at.top - box.top + at.height / 2 + "px";
  s.style.left = at.left - box.left + at.width / 2 + "px";
  s.style.top = at.bottom - box.top + "px";
  se.style.left = at.right - box.left + "px";
  se.style.top = at.bottom - box.top + "px";
}

function beginArtResize(host: HTMLElement, editor: Editor, edge: string,
                        ev: PointerEvent): void {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  const ctx = editor.contexts[editor.contexts.length - 1];
  if (!ctx) return;
  const k = stageScale(host);
  const start = { x: ev.clientX, y: ev.clientY, w: ctx.w, h: ctx.h };
  const move = (mv: PointerEvent) => {
    const snap = !mv.altKey;
    const size = (raw: number) => Math.max(44, snap ? snapPx(raw) : Math.round(raw));
    editor.resizePreview(
      edge.includes("e") ? size(start.w + (mv.clientX - start.x) / k) : start.w,
      edge.includes("s") ? size(start.h + (mv.clientY - start.y) / k) : start.h);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/* ---- where a tree drop would land ----
 *
 * THE PAGE DOES NOT MOVE WHILE YOU DRAG a Layers row: the node in hand dims where it
 * still sits, and the box that would receive it wears a mark. There is no insertion line
 * any more — order is Z-ORDER on the artboard, not a place on an axis, so a line between
 * two children would promise a position that order does not decide. */
export function previewArrangement(
  host: HTMLElement,
  _editor: Editor,
  node: number,
  plan: DropPlan | null,
): void {
  const state = stateOf(host);
  for (const el of Array.from(host.querySelectorAll(".carrying, .drop-target")))
    el.classList.remove("carrying", "drop-target");
  if (!node || !plan) return;
  const target = nodeElement(host, plan.parent) ?? state.page;
  if (!target) return;
  nodeElement(host, node)?.classList.add("carrying");
  target.classList.add("drop-target");
}

/* the document's own picture, forced back on screen: what a cancelled or no-op gesture
 * calls, since the inline styles it painted are exactly what a plain render would keep */
export function repaintDocument(host: HTMLElement, editor: Editor): void {
  stateOf(host).signature = "";
  renderStage(host, editor);
}

/* ---- the one entry point ---- */

export function renderStage(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  wire(host, editor);

  const ctx = editor.contexts[editor.contexts.length - 1] ?? null;
  const page = editor.page();
  if (!page && !ctx) {
    state.page?.remove();
    state.page = null;
    state.signature = "";
    positionRings(host, editor);
    return;
  }

  /* the picture's own size, and the chain it is of: a step in or out of a widget refits
     the camera; a preview RESIZE deliberately does not (the artboard grows under the
     author's pointer, and yanking the camera mid-drag would fight them) */
  state.art = ctx ? { w: ctx.w, h: ctx.h } : { w: CANVAS_W, h: CANVAS_H };
  const ctxPath = (page ? page.id : 0) + "|" +
    editor.contexts.map((c) => (c.component ? "c" + c.component : "b" + c.builtin) +
                               ":" + c.from).join("/");
  if (state.ctxPath !== ctxPath) {
    state.ctxPath = ctxPath;
    state.cam.manual = false;
  }

  /* WHAT THE PICTURE IS OF: the MODE (edit and test build different pointer regimes, so
     flipping the segment must rebuild), the context, its size, the document version —
     and the COMPILE EPOCH, which is the one that catches an edit changing what a field
     evaluates to rather than what the tree holds. A node's attrs are programs; editing
     one leaves the tree identical and the version moved, and the new programs arrive in
     the snapshot that follows. Without the epoch here a resize would commit its number
     and then redraw the old one. */
  state.repaint = () => {
    state.signature = "";
    renderStage(host, editor);
  };
  const signature = editor.view.mode + ":" + ctxPath + ":" +
    state.art.w + "x" + state.art.h + ":" +
    editor.store.version() + ":" + (editor.live?.epoch ?? 0);
  let rebuild = !state.page || signature !== state.signature;
  let histOnly = !rebuild;
  if (!rebuild) {
    let moved = false;
    for (const [cell, was] of state.consumed) {
      /* a trend compares by its ring's VERSION -- an append moves it, and nothing else
         has to be looked at -- while an ordinary cell compares by its value */
      const now = cell.startsWith("hist:")
        ? histMark(editor.hist?.(cell.slice(5)) ?? null)
        : JSON.stringify(editor.live?.values?.[cell] ?? null);
      if (now === was) continue;
      moved = true;
      if (!cell.startsWith("hist:")) {
        histOnly = false;
        break;
      }
    }
    rebuild = moved && (!histOnly || state.histLoose || !state.plots.length);
    /* A STREAMING RING REDRAWS ITS PLOTS IN PLACE. A trend appends samples many times a
       second forever, and a full rebuild per sample replaces the DOM under a press —
       killing the click it was part of — to change one path's `d`. When everything that
       moved is hist cells and every reader is a plot, redraw exactly those: pathData
       re-reads the rings through the same cells, which re-marks the consumed entries. */
    if (moved && !rebuild) {
      for (const plot of state.plots) {
        state.inPlot = true;
        plot.el.setAttribute("d", pathData(plot.node, plot.cells));
        state.inPlot = false;
      }
    }
  }

  if (rebuild) {
    state.consumed = new Map();
    state.consumedState = new Set();
    state.plots = [];
    state.histLoose = false;
    const next = buildPage(state, editor, page);
    state.page?.remove();
    /* the rings are children of the host too, and the page must sit under them */
    host.insertBefore(next, host.firstChild);
    state.page = next;
    state.signature = signature;
    if (!state.cam.manual) fitCamera(host, state);
    applyCamera(state);
    /* A REBUILD MUST NOT TAKE A GESTURE WITH IT. What a live frame moved is a value, not
       an arrangement, and the box in your hand is holding numbers that are deliberately
       not in the document until you let go — so the gesture puts them back on the fresh
       elements (manipulate.ts owns them; this only says when). */
    repaintFree();
  }
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
 * rather than guessing what was meant. Clicking the page background clears.
 *
 * SELECTION RIDES THE POINTER PAIR, NOT THE NATIVE CLICK. A live rebuild replaces the
 * page's elements, and a press whose element is detached before release never fires a
 * usable click — the browser retargets it to the host, which reads as "clicked past
 * everything" and CLEARS the selection instead of making one. A streaming trend rebuilds
 * many times a second, so any human-speed press straddles one. The id is taken at the
 * press (the node the user aimed at) and the release only asks "did it stay a click"
 * (slop), holding no element in between — the same discipline the drags and the tree's
 * own double-click already follow. Double-click is the manual two-press detection from
 * the Layers tree, for the same reason: a rebuild between the presses resets the
 * browser's counter. */
function wire(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  if (state.wired) return;
  state.wired = true;
  let press: { id: number; x: number; y: number } | null = null;
  let last = { id: 0, x: 0, y: 0, at: 0 };
  host.addEventListener("pointerdown", (ev) => {
    press = null;
    if (editor.view.mode !== "edit" || ev.button !== 0) return;
    const at = ev.target as HTMLElement | null;
    /* grips belong to their own gestures: the selection handles to manipulate.ts, the
       preview-resize grips to the artboard — neither press may read as a click here */
    if (at?.closest?.(".sel-hit") || at?.closest?.(".art-grip")) return;
    press = { id: idUnder(ev.target), x: ev.clientX, y: ev.clientY };
  });
  host.addEventListener("pointerup", (ev) => {
    const held = press;
    press = null;
    if (!held || editor.view.mode !== "edit" || ev.button !== 0) return;
    /* past the slop it was a drag, and manipulate.ts owns what a drag selects */
    if (Math.abs(ev.clientX - held.x) > 4 || Math.abs(ev.clientY - held.y) > 4) return;
    /* ENTER A WIDGET: two clicks on one instance within the tree rows' own window */
    const again = held.id !== 0 && held.id === last.id && ev.timeStamp - last.at < 450 &&
                  Math.abs(ev.clientX - last.x) < 6 && Math.abs(ev.clientY - last.y) < 6;
    last = again ? { id: 0, x: 0, y: 0, at: 0 }
                 : { id: held.id, x: ev.clientX, y: ev.clientY, at: ev.timeStamp };
    if (again && editor.store.widget(held.id)) {
      editor.enterWidget(held.id);
      return;
    }
    editor.select(held.id ? [held.id] : []);
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
  /* the press gestures: moving a box, resizing it by a handle (manipulate.ts, which owns
     their precedence) — handed the overlay so a gesture can keep it on the box it rings,
     and the document repaint a cancelled gesture puts back */
  armStage(host, editor, () => positionRings(host, editor),
           () => repaintDocument(host, editor));

  /* THE CAMERA: wheel pans, ctrl+wheel (a pinch, on most trackpads) zooms at the pointer,
     middle-drag pans. Taking any of them marks the camera the user's: a pane resize stops
     re-fitting over their head. Everything after a change is one transform + the overlay
     told where things landed — the page itself never rebuilds for a camera move. */
  host.addEventListener("wheel", (ev) => {
    const state2 = stateOf(host);
    const cam = state2.cam;
    ev.preventDefault();
    if (ev.ctrlKey) {
      const at = host.getBoundingClientRect();
      const px = ev.clientX - at.left;
      const py = ev.clientY - at.top;
      const next = Math.min(8, Math.max(0.1, cam.k * Math.exp(-ev.deltaY * 0.0015)));
      cam.x = px - ((px - cam.x) / cam.k) * next;
      cam.y = py - ((py - cam.y) / cam.k) * next;
      cam.k = next;
    } else {
      cam.x -= ev.deltaX;
      cam.y -= ev.deltaY;
    }
    cam.manual = true;
    applyCamera(state2);
    positionRings(host, editor);
  }, { passive: false });
  host.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 1) return;
    ev.preventDefault();
    const state2 = stateOf(host);
    const start = { x: ev.clientX, y: ev.clientY, cx: state2.cam.x, cy: state2.cam.y };
    const move = (mv: PointerEvent) => {
      state2.cam.x = start.cx + (mv.clientX - start.x);
      state2.cam.y = start.cy + (mv.clientY - start.y);
      state2.cam.manual = true;
      applyCamera(state2);
      positionRings(host, editor);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  /* the pane resizes when a sidebar is dragged or the window changes: an untouched camera
     re-fits the artboard, and the rings are told where everything landed either way */
  if (typeof ResizeObserver === "function")
    new ResizeObserver(() => {
      const state2 = stateOf(host);
      if (!state2.cam.manual) {
        fitCamera(host, state2);
        applyCamera(state2);
      }
      positionRings(host, editor);
    }).observe(host);
}

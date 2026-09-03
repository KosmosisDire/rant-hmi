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
 * THE IDENTITY-STABLE RENDERER: NO ELEMENT IS CREATED OR DELETED AT RUNTIME. An element
 * is a thing the user is holding — a press, a hover, a text selection, a gesture's own
 * captured box — so replacing it to change a colour breaks the interaction that was
 * already under way. Instead every rendered node is a BIND: one persistent element, the
 * view node it is currently of, and the cells its appliers read. Three passes, and only
 * three:
 *
 *   FRESH — first paint, a page switch, stepping into or out of a component. Keys change
 *   wholesale there and the camera re-fits anyway, so the tree is built from nothing.
 *
 *   RECONCILE — the document version, the compile epoch, the mode or the artboard size
 *   moved. Every node is re-keyed (by id where ids exist, by index-path inside a
 *   component's template, plus the repeat copy) and every element whose key survives is
 *   REUSED with its appliers re-run. Same cost as the old wholesale rebuild; identity
 *   preserved.
 *
 *   LIVE PATCH — a live frame. Each bind recorded which cells its appliers read and each
 *   parent recorded which cells its child list read; a frame re-runs exactly the binds
 *   whose cells moved and touches no structure at all. A `show` that flipped or a
 *   data-driven `repeat` whose count moved reconciles that ONE parent's children.
 *
 * Every applier is TOTAL: it writes or clears every property it owns, because the element
 * it is writing to already carries the last pass's answer. */

import { DropPlan, freeAllowed, freeBoxOf, snapPx } from "./arrange.js";
import { Editor } from "./editor.js";
import { armInteract } from "./gestures.js";
import { HANDLE_MARGIN, handleMarkup, handlesOff } from "./handles.js";
import { iconMarkup } from "./icons.js";
import { armStage, repaintFree, stageBusy } from "./manipulate.js";
import { attrText, ViewHost, run } from "./program.js";
import { operable, typeOf } from "./slots.js";
import {
  Attrs, CANVAS_H, CANVAS_W, CompiledAnchor, CompiledTransitionMap, Interact, isInstance,
  Json, Node, Page, Program, RepeatCopy, TemplateNode, ComponentType,
} from "./types.js";

/* a `repeat` may not run away with the page: the same ceiling the backend names */
const REPEAT_CAP = 512;

/* the .page element's own key: the artboard is a bind like any other, dressed by the
   component root's attrs inside a context and holding the top-level children */
const ROOT_KEY = "#root";

/* the camera: where the artboard sits in the pane, and at what scale */
interface Camera {
  x: number;
  y: number;
  k: number;
  /* the user has taken the camera: a pane resize stops re-fitting over their head */
  manual: boolean;
}

/* ONE RENDERED NODE, standing. The element is created once and lives until its key leaves
 * the tree; everything else here is what the engine needs to patch it in place. */
interface Bind {
  key: string;
  el: HTMLElement;
  /* the view node this element is currently OF — REFRESHED on every reconcile, because
     the ViewNode tree is rebuilt from the document each time and a held one goes stale */
  node: ViewNode;
  /* the bind that holds this one, null at the root. The tree is walked parent-first, so
     this is set wherever a child is placed — including when a key is ADOPTED by a new
     parent. It exists for one reader: a shadow, which has to know every rotation between
     this node and the artboard to keep its offset still (`turnOf` below). */
  parent: Bind | null;
  /* the enclosing repeat copy this element is, or null outside a repeat */
  repeat: RepeatCopy | null;
  /* the cells the APPLIERS read: a live frame moving one of these re-runs them */
  deps: Set<string>;
  /* the cells the CHILD LIST read (the children's `show` and `repeat`): a live frame
     moving one of these reconciles this parent's children, and nothing else */
  kidDeps: Set<string>;
  /* the child keys this bind managed on the last pass, in order */
  kidKeys: string[];
  /* kind "path": the <path> inside the svg scaffolding, patched rather than rebuilt */
  path: SVGPathElement | null;
  /* kind "icon": the name+weight last rendered to innerHTML, so a patch that changes
     neither leaves the glyph's own DOM alone */
  iconSig: string;
  /* the id of this bind's own INSET-shadow filter, "" until it needs one. Ink cannot turn
     a shadow inward with any CSS shorthand, so it borrows an SVG filter — one per node,
     because the offsets and the colour are this node's (shadowDefs below) */
  shadowId: string;
  /* what kind of element this IS: a key whose node changed kind cannot reuse it */
  shape: string;
  /* has a gesture seat been fitted? The listeners outlive every reconcile, so this is
     what keeps a re-arm (an element that GAINS an interact) from doubling them. */
  armed: boolean;
  /* the pass that last ran these appliers: what keeps one live frame from running a
     bind twice when both its own cell and its parent's child list moved */
  pass: number;
}

interface StageState {
  /* the pane this picture is of: the state is keyed by it anyway, and the shadow filters
     need somewhere outside the page to hang */
  host: HTMLElement;
  page: HTMLElement | null;
  /* the pseudo-bind for the .page element itself */
  root: Bind | null;
  /* every standing element, by key */
  binds: Map<string, Bind>;
  /* cell -> the binds whose appliers read it */
  byDep: Map<string, Set<Bind>>;
  /* cell -> the parent binds whose CHILD LIST read it */
  byKid: Map<string, Set<Bind>>;
  /* cell -> what it was worth when a recorded read last saw it: the whole of the live
     diff, and the reason a frame that moved nothing this picture reads costs nothing */
  marks: Map<string, string>;
  /* the set a read is being recorded into, or null OUTSIDE an engine pass — a gesture
     reading its params through a captured seat must never mask a pending live diff.
     `structural` marks a CHILD-LIST pass: show/repeat decisions read TRUE values, never
     an eased one (a picture may sweep; which elements exist may not). */
  recording: { deps: Set<string>; structural?: boolean } | null;
  pass: number;
  /* ---- transitions (the sweep engine below) ---- */
  /* every standing sweep, keyed "c:<cell>" for a slot's declared transition and
     "a:<bind key>:<attr>" for an attribute's own .smooth() */
  tweens: Map<string, Tween>;
  /* THE PASS'S CLOCK, stamped once per pass: every sweep in one pass reads one instant,
     so two attrs eased by one value can never disagree within a frame */
  now: number;
  /* a frame is already scheduled to advance the live sweeps */
  ticking: boolean;
  /* advance the sweeps and patch exactly their readers (set by renderStage, which
     knows the editor — the flushState pattern) */
  tick: () => void;
  /* the elements with a `transform` TRANSITION in flight (transitionstart/end): while
     any exist, the turn ticker re-runs the shadow-bearing binds off sampled matrices */
  turning: Set<Element>;
  /* every bind currently casting a shadow — what the turn ticker re-runs */
  shadowed: Set<Bind>;
  turnTicking: boolean;
  /* a frame is already scheduled to advance the time cells (the clock ticker) */
  timeTicking: boolean;
  /* what a RECONCILE is keyed on: mode, artboard size, document version, compile epoch */
  docSig: string;
  /* the theme vars last emitted on the page, so a token that left is removed */
  /* and the tokens themselves, to seed a filter host created after them */
  /* a gesture's state write landed: patch exactly what binds it (set by renderStage,
     which knows the host) */
  flushState: (key: string) => void;
  rings: HTMLElement[];
  /* the one ring that follows the pointer rather than the selection */
  hover: HTMLElement | null;
  /* the selection handles over a lone selected node: ring, pills, brackets (handles.ts) */
  handles: SVGSVGElement | null;
  cam: Camera;
  /* THE ARTBOARD'S OWN SIZE: the fixed canvas on a page, the context's preview box
     inside an entered component — what the camera fits and the gestures divide by */
  art: { w: number; h: number };
  /* which page or entered-component chain the picture is of (preview size excluded): a
     step in or out builds FRESH and refits the camera, a preview resize does neither */
  ctxPath: string;
  /* the preview-resize grips on the artboard's edge, up only inside a context */
  artGrips: HTMLElement[];
  /* the hidden <svg> holding the inset-shadow filters. It hangs off the HOST rather than
     the page, because a fresh build replaces the page element and these outlive one — and
     it carries a copy of the theme vars so a filter's flood-color can be a $token like
     every other colour in the picture. */
  defs: SVGSVGElement | null;
  wired: boolean;
}

const states = new WeakMap<HTMLElement, StageState>();

function stateOf(host: HTMLElement): StageState {
  let state = states.get(host);
  if (!state) {
    state = { host, page: null, root: null, binds: new Map(), byDep: new Map(),
              byKid: new Map(), marks: new Map(), recording: null, pass: 0,
              tweens: new Map(), now: 0, ticking: false, tick: () => undefined,
              turning: new Set(), shadowed: new Set(), turnTicking: false,
              timeTicking: false,
              docSig: "", flushState: () => undefined, rings: [],
              hover: null, handles: null, cam: { x: 0, y: 0, k: 1, manual: false },
              art: { w: CANVAS_W, h: CANVAS_H }, ctxPath: "", artGrips: [],
              defs: null, wired: false };
    states.set(host, state);
  }
  return state;
}

/* ---- the camera ---- */

/* the artboard, scaled to sit whole in the pane with a breath of margin around it — and
 * with NONE in the deployed view: operate's pane is the machine's whole screen, so the
 * page fills it edge to edge, letterboxed only where the aspects disagree */
function fitCamera(host: HTMLElement, state: StageState, editor: Editor): void {
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (!(w > 0) || !(h > 0)) return;
  const cam = state.cam;
  cam.k = Math.min(w / state.art.w, h / state.art.h) *
          (editor.view.mode === "operate" ? 1 : 0.96);
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
  /* WHOSE GESTURE AND WHOSE `state` THIS IS — the owner where one encloses this node, its
     own id where nothing does (an element on a page). Different from `owner` because a
     page element holds no cells but does hold a press: conflating them made every bare
     element claim the pointer and broke inert pass-through. */
  channel: number;
  type: ComponentType | null;
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
  /* the ELEMENT CHANNEL this node's gestures post on: its own dotted name chain from the
     template root ("" = the root, i.e. the instance-level channel) */
  element: string;
  /* the node's compiled per-attr transitions ({attr: {ms, profile?}} as programs),
     merged into the element's native CSS `transition` by runAppliers; null = none */
  transitions: CompiledTransitionMap | null;
}

/* One document node, with its compiled attrs found by id — a page's, or an entered
 * component's: `owner`, `type` and `frac` say whose cells its programs read and which
 * space its numbers live in, and both callers pass their own.
 *
 * AN INSTANCE RESOLVES HERE, once: the component's root node IS the instance's box, so
 * this returns that root wearing the instance's id — the component's children and its
 * DRESSING from the root, its BOX and STATE from the instance node (the owner split,
 * registry/attrs.h AttrOwner: that is how one placement is dressed and placed). There is
 * no wrapper box and no second node, which is also why nothing downstream has to know
 * an instance from a frame. */
function pageNode(editor: Editor, node: Node, owner = 0,
                  type: ComponentType | null = null, frac = false): ViewNode {
  const compiled = editor.nodeAttrs?.[String(node.id)];
  if (isInstance(node)) {
    const instType = typeOf(editor.registry, node.type ?? "");
    const root = instType?.template
      ? templateNode(instType.template, node.id, instType, "")
      : null;
    /* THE OWNER SPLIT: the root brings the component's half — its dressing — and the
       instance node the placement's — its box, show, enabled, repeat — and neither is
       let near the other's. The compiler refuses each on the wrong node already, so
       with a served table the merge IS the split; filtering here as well makes the rule
       the view's own. A transition rides its attr's owner. */
    const placed = placementSet(editor);
    const attrs = splitByOwner(root?.attrs ?? {}, compiled?.attrs ?? {}, placed);
    const transitions =
      splitByOwner(root?.transitions ?? {}, compiled?.transitions ?? {}, placed);
    return {
      id: node.id,
      instance: true,
      kind: root?.kind ?? "frame",
      name: node.name || (node.type ?? ""),
      attrs,
      anchors: root?.anchors ?? [],
      closed: root?.closed ?? false,
      children: root?.children ?? [],
      owner: node.id,
      channel: node.id,
      type: instType,
      path: "",
      element: "",
      frac,
      interact: root?.interact ?? null,
      transitions: Object.keys(transitions).length ? transitions : null,
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
    /* AN ELEMENT ON A PAGE SPEAKS FOR ITSELF: nothing encloses it that holds cells, so its
       gestures post as itself and its `state` is its own. Inside a component's context the
       entered instance is the channel — that is whose cells these nodes read and whose
       press they are part of. */
    channel: owner || node.id,
    type,
    path: "",
    element: "",
    frac,
    interact: compiled?.interact ?? null,
    transitions: compiled?.transitions ?? null,
  };
}

/* the placement's half of the attr vocabulary, read off the served table once per table
   object (a snapshot serves a new one); null with no table — an offline view — in which
   case nothing is filtered and the merge stands as served */
const placementSets = new WeakMap<object, Set<string>>();
function placementSet(editor: Editor): Set<string> | null {
  const table = editor.attrTable;
  if (!table) return null;
  let held = placementSets.get(table);
  if (!held) {
    held = new Set(table.common.filter((d) => d.owner === "placement").map((d) => d.name));
    placementSets.set(table, held);
  }
  return held;
}

/* the component's keys from the root, the placement's from the instance node */
function splitByOwner<T>(component: Record<string, T>, placement: Record<string, T>,
                         placed: Set<string> | null): Record<string, T> {
  if (!placed) return { ...component, ...placement };
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(component)) if (!placed.has(key)) out[key] = value;
  for (const [key, value] of Object.entries(placement)) if (placed.has(key)) out[key] = value;
  return out;
}

/* one node of a component's served template, under the instance whose cells it reads.
 * `path` is the SCOPE chain (ancestors, addressing); `element` is the node's OWN dotted
 * name from the root — the CHANNEL identity a gesture posts, "" for the root itself.
 * They are DIFFERENT things: conflating them was a real bug. */
function templateNode(node: TemplateNode, owner: number, type: ComponentType | null,
                      path: string, element = ""): ViewNode {
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
      templateNode(c, owner, type, path ? path + "." + name : name,
                   element ? element + "." + String(c.name ?? "") : String(c.name ?? ""))),
    owner,
    channel: owner,
    type,
    path,
    element,
    frac: true,
    interact: node.interact ?? null,
    transitions: node.transitions ?? null,
  };
}

/* THE ARTBOARD'S OWN NODE: what the .page element is dressed by and what hangs off it. On
 * a page that is the page's children in canvas px. Inside an ENTERED COMPONENT it is the
 * component's design frame at the context's preview size, its children the component's
 * OWN nodes in fractions — the same nodes with their ids, which is what lets selection and
 * the gestures work on them — reading the entered instance's cells, so the component
 * behaves as that placement does while it is edited. An unforked BUILT-IN renders from its
 * served template instead: no ids anywhere, and that absence IS the read-only. */
function rootView(editor: Editor, page: Page | null): ViewNode {
  const ctx = editor.contexts[editor.contexts.length - 1] ?? null;
  let kids: ViewNode[] = [];
  let rootAttrs: Attrs | null = null;
  let owner = 0;
  let type: ComponentType | null = null;
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
      kids = (type.template.children ?? []).map((c) =>
        templateNode(c, owner, type, "", String(c.name ?? "")));
      rootAttrs = type.template.attrs ?? null;
    }
  }
  /* the design frame wears the component ROOT's own dressing — an instance's box IS this
     node — over the artboard surface the page style gives it. No context: an empty attr
     map, which the (total) dress applier reads as "nothing authored" and clears. */
  const rootTransitions = ctx
    ? (ctx.component
        ? editor.nodeAttrs?.[String(ctx.component)]?.transitions ?? null
        : type?.template.transitions ?? null)
    : null;
  return { id: 0, instance: false, kind: "frame", name: "", attrs: rootAttrs ?? {},
           anchors: [], closed: false, children: kids, owner, channel: owner, type,
           path: "", element: "",
           frac: true, interact: null, transitions: rootTransitions };
}

/* ---- the pure core: a value -> style ---- */

/* a colour value as CSS: a "$name" is this view's hex for the token (recorded as a
   dependency), anything else is used verbatim */
function cssColor(value: Json): string {
  const text = typeof value === "string" ? value : "";
  return text.startsWith("$") ? themeColor(text.slice(1)) : text;
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

/* ---- transitions: THE VIEW EASES WHAT IT DRAWS ----
 *
 * A TRANSITION IS RENDERING. The true value — what behavior reads, what the wire
 * carries, what a gesture proposes — is never eased anywhere; what sweeps is this view's
 * own picture of it, approaching the truth over an authored time. Two surfaces, one
 * mechanism each:
 *
 *   AN ATTRIBUTE'S TRANSITION IS METADATA, never part of its expression: the node's
 *   `transitions` map ({attr: {ms, profile?}}, validated by the compiler against the
 *   attr table's css column) merges into the element's native CSS `transition`
 *   (transitionCss below), and the BROWSER owns every blend — colours through var()
 *   tokens, geometry, transforms, even a path's `d` where its structure holds. Per
 *   property, per rate, one comma-joined list.
 *
 *   A PROPERTY'S DECLARED TRANSITION TWEENS THE VALUE, here, in the view's own loop:
 *   every applier-pass read of that slot eases, so the needle, the arc and the readout
 *   all follow one eased number — including readers CSS can never animate (text).
 *
 * WHAT NEVER SWEEPS: structural decisions (`show`, `repeat` — which elements exist),
 * gesture-time reads (a proposal over an eased value would send a value that never
 * existed), and anything that is not a number — Nil ENDS a sweep and snaps, because
 * inventing frames between a value and UNKNOWN would draw values nobody produced.
 * A first sight also snaps: there is no sweep from nothing. */
interface Tween {
  /* what the picture currently shows */
  value: number;
  from: number;
  to: number;
  start: number;
  ms: number;
  profile: string;
  done: boolean;
  /* the slot cell this sweep is of: advance re-runs whatever binds read it */
  cell: string;
}

/* the CSS named curves, reproduced exactly so the numeric mechanism and the browser's
   cross-fade agree on what "ease-out" means; linear (and any name this view does not
   know) is the identity */
const EASING: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

/* cubic-bezier(x1, y1, x2, y2) sampled at time-fraction x: Newton first, bisection where
   the derivative gives out — the standard solve, small and total */
function bezierY(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  let u = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(u) - x;
    if (Math.abs(err) < 1e-6) return sampleY(u);
    const d = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(d) < 1e-6) break;
    u -= err / d;
  }
  let lo = 0;
  let hi = 1;
  u = x;
  while (hi - lo > 1e-6) {
    u = (lo + hi) / 2;
    if (sampleX(u) < x) lo = u;
    else hi = u;
  }
  return sampleY(u);
}

function easeAt(profile: string, t: number): number {
  const curve = EASING[profile];
  return curve ? bezierY(curve[0], curve[1], curve[2], curve[3], t) : t;
}

/* the sweep clock; REPLACEABLE so a test can drive time by hand (a replaced clock also
   stops the frame loop — the test steps explicitly instead) */
let manualClock = false;
let clock = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export function setTransitionClock(fn: (() => number) | null): void {
  manualClock = fn !== null;
  clock = fn ?? (() =>
    typeof performance !== "undefined" ? performance.now() : Date.now());
}

/* ---- the time cells ----
 *
 * `time` is the display tier's clock, read by field ("time:<field>" cells, the vocabulary
 * in lang/ir.h kClockFields). `time.now` is seconds since this view loaded — the
 * animation clock, ticking per frame; the rest is the viewer's wall clock, moving once a
 * second. Rendering, not truth: the backend's own tiers read the backend's clock, and
 * nothing here rides the wire. A replaced wall clock (tests) pins the civil fields the
 * way setTransitionClock pins the sweeps. */
let wallClock: (() => number) | null = null;

export function setWallClock(fn: (() => number) | null): void {
  wallClock = fn;
}

function timeField(name: string): Json {
  if (name === "now") return clock() / 1000;
  const at = new Date(wallClock ? wallClock() : Date.now());
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (name) {
    case "unix": return Math.floor(at.getTime() / 1000);
    case "year": return at.getFullYear();
    case "month": return at.getMonth() + 1;
    case "day": return at.getDate();
    case "weekday": return at.getDay();
    case "hour": return at.getHours();
    case "minute": return at.getMinutes();
    case "second": return at.getSeconds();
    case "text":
      return pad(at.getHours()) + ":" + pad(at.getMinutes()) + ":" + pad(at.getSeconds());
    case "date":
      return at.getFullYear() + "-" + pad(at.getMonth() + 1) + "-" + pad(at.getDate());
    default: return null;
  }
}

/* ---- the timer cells ----
 *
 * A TIMER'S FACE, derived per frame from the served record: the backend publishes
 * {running, deadline (wall ms), duration (s)} under the timer's own `v<id>` value —
 * a record that only changes when the timer starts, cancels or expires — and the
 * countdown is arithmetic over the deadline at this view's frame rate ("tmr:<id>:
 * <field>" cells, the descriptor vocabulary in registry/objects.h). Rendering, not
 * truth: expiry is the backend's one comparison; a viewer's clock skew can tilt the
 * picture's countdown, never when the timer actually fires. The derivations match
 * the scalar tier's TmrRead exactly — idle reads remaining 0 and progress 1. */
function timerField(editor: Editor, spec: string): Json {
  const colon = spec.indexOf(":");
  if (colon < 0) return null;
  const rec = editor.live?.values?.["v" + spec.slice(0, colon)];
  if (!rec || typeof rec !== "object") return null;
  const field = spec.slice(colon + 1);
  const running = (rec as Json).running === true;
  const duration = typeof (rec as Json).duration === "number"
    ? (rec as Json).duration : null;
  if (field === "running") return running;
  if (field === "duration") return duration;
  const deadline = typeof (rec as Json).deadline === "number" ? (rec as Json).deadline : 0;
  const wall = wallClock ? wallClock() : Date.now();
  const left = running ? Math.max(0, deadline - wall) / 1000 : 0;
  if (field === "remaining") return left;
  if (field === "progress")
    return duration === null ? null : duration ? 1 - left / duration : 0;
  return null;
}

function advanceTween(t: Tween, now: number): void {
  if (t.done) return;
  const at = t.ms > 0 ? (now - t.start) / t.ms : 1;
  if (at >= 1) {
    t.value = t.to;
    t.done = true;
    return;
  }
  t.value = t.from + (t.to - t.from) * easeAt(t.profile, at < 0 ? 0 : at);
}

/* ONE EASED READ. The target moving retunes the sweep FROM WHAT IS CURRENTLY SHOWN — a
 * mid-flight retarget never jumps — and a non-number target (Nil included) ends the
 * sweep and passes through untouched. */
function tweenTo(state: StageState, key: string, target: Json, ms: number,
                 profile: string, cell: string): Json {
  if (typeof target !== "number" || !Number.isFinite(target)) {
    state.tweens.delete(key);
    return target;
  }
  let t = state.tweens.get(key);
  if (!t) {
    /* first sight: the picture starts AT the value — no sweep from nothing */
    t = { value: target, from: target, to: target, start: 0, ms, profile, done: true,
          cell };
    state.tweens.set(key, t);
  } else if (target !== t.to) {
    t.from = t.value;
    t.to = target;
    t.start = state.now;
    t.ms = ms;
    t.profile = profile;
    t.done = false;
  }
  advanceTween(t, state.now);
  return t.value;
}

function tweensLive(state: StageState): boolean {
  for (const t of state.tweens.values()) if (!t.done) return true;
  return false;
}

/* one frame at a time, and only while something is actually in flight */
function scheduleTweens(state: StageState): void {
  if (state.ticking || manualClock || !tweensLive(state)) return;
  state.ticking = true;
  const frame = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (fn: () => void) => setTimeout(fn, 16);
  frame(() => {
    state.ticking = false;
    state.tick();
  });
}

/* the sweep pass: advance every live tween, then re-run EXACTLY the binds indexed under
 * its cell. Exported for tests, which replace the clock and step this by hand. */
export function stepTransitions(host: HTMLElement, editor: Editor, now?: number): void {
  const state = stateOf(host);
  state.now = now ?? clock();
  const binds = new Set<Bind>();
  let moved = false;
  for (const t of state.tweens.values()) {
    if (t.done) continue;
    advanceTween(t, state.now);
    moved = true;
    for (const bind of state.byDep.get(t.cell) ?? []) binds.add(bind);
  }
  if (moved && binds.size) {
    state.pass++;
    for (const bind of binds)
      if (state.binds.get(bind.key) === bind && bind.pass !== state.pass)
        runAppliers(state, editor, bind);
    repaintFree();
    positionRings(host, editor);
  }
  scheduleTweens(state);
}

/* ---- the clock ticker ----
 *
 * The time cells move on their own — no wire frame, no gesture — so they get their own
 * frame loop, scoped exactly like the sweeps': scheduled only while some bind reads a
 * time cell, and stopped by a manual clock so tests step by hand. Each frame diffs every
 * read time cell against its mark and patches exactly the readers whose cell moved —
 * `time.now` moves every frame, the wall fields once a second, and a picture reading
 * only `time.hour` repaints once an hour. */
function timeLive(state: StageState): boolean {
  /* a timer's cells ride the same frame loop: the countdown derives per frame from
     the served deadline, exactly as time.now derives from the frame clock */
  const ticking = (key: string) => key.startsWith("time:") || key.startsWith("tmr:");
  for (const key of state.byDep.keys()) if (ticking(key)) return true;
  for (const key of state.byKid.keys()) if (ticking(key)) return true;
  return false;
}

/* one clock step: diff, patch the readers, reschedule. Exported for tests, which pin
 * the clocks and step this by hand. */
export function stepTime(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  const moved = new Map<string, string>();
  const look = (key: string) => {
    if (moved.has(key)) return;
    const value = key.startsWith("time:") ? timeField(key.slice(5))
                : key.startsWith("tmr:") ? timerField(editor, key.slice(4))
                : undefined;
    if (value === undefined) return;
    const mark = JSON.stringify(value);
    if (mark !== state.marks.get(key)) moved.set(key, mark);
  };
  for (const key of state.byDep.keys()) look(key);
  for (const key of state.byKid.keys()) look(key);
  if (moved.size) {
    state.now = clock();
    state.pass++;
    const parents = new Set<Bind>();
    const binds = new Set<Bind>();
    for (const [key, mark] of moved) {
      state.marks.set(key, mark);
      for (const parent of state.byKid.get(key) ?? []) parents.add(parent);
      for (const bind of state.byDep.get(key) ?? []) binds.add(bind);
    }
    for (const parent of parents)
      if (state.binds.get(parent.key) === parent)
        reconcileChildren(state, editor, parent, parent.node.children, parent.repeat);
    for (const bind of binds)
      if (state.binds.get(bind.key) === bind && bind.pass !== state.pass)
        runAppliers(state, editor, bind);
    repaintFree();
    positionRings(host, editor);
  }
  scheduleTime(host, editor);
}

function scheduleTime(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  if (state.timeTicking || manualClock || !timeLive(state)) return;
  state.timeTicking = true;
  const frame = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (fn: () => void) => setTimeout(fn, 16);
  frame(() => {
    state.timeTicking = false;
    stepTime(host, editor);
  });
}

/* ---- evaluating a transition's OWN values ----
 *
 * A transition's ms and profile are served as view programs (a literal is the
 * degenerate CONST), evaluated here over TRUE values: the guard flips the recording
 * structural for the duration of the run, so a slot's declared sweep can never ease —
 * or recurse into — the duration that times it. Deps still record, so a duration over
 * `rate` re-runs its bind when rate moves (the NEXT sweep uses the new time; a sweep
 * in flight keeps the duration it started with). Plain numbers/names pass through for
 * leniency (old fixtures, hand-built rows). */
function specValue(state: StageState, program: Program | number | string | undefined,
                  cells: ViewHost): Json {
  if (program === undefined || program === null) return null;
  if (typeof program === "number" || typeof program === "string") return program;
  const rec = state.recording;
  const held = rec?.structural;
  if (rec) rec.structural = true;
  try {
    return run(program, cells);
  } finally {
    if (rec) rec.structural = held;
  }
}

/* the evaluated time: a finite number of ms in (0, 600000], else null = no transition */
function specMs(state: StageState, program: Program | number | string | undefined,
                cells: ViewHost): number | null {
  const value = specValue(state, program, cells);
  const ms = typeof value === "number" && Number.isFinite(value) ? value : null;
  return ms !== null && ms > 0 ? Math.min(ms, 600000) : null;
}

const EASING_NAMES = new Set(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]);

/* the evaluated profile: a known easing name, else the default — a wrong profile is a
   cosmetic miss and falls back rather than killing the sweep (the align precedent) */
function specProfile(state: StageState, program: Program | string | undefined,
                     cells: ViewHost): string {
  const value = specValue(state, program, cells);
  return typeof value === "string" && EASING_NAMES.has(value) ? value : "ease";
}

/* the DECLARED transition of one slot, off the served type — cached per type row,
   because this is asked on every slot read of every applier pass */
const sweepSpecs = new WeakMap<ComponentType,
  Map<string, { ms: Program | number; profile?: Program | string }>>();

function slotSweep(type: ComponentType | null,
                   name: string): { ms: Program | number; profile?: Program | string } | null {
  if (!type) return null;
  let map = sweepSpecs.get(type);
  if (!map) {
    map = new Map();
    for (const slot of type.slots)
      if (slot.smooth !== undefined && slot.smooth !== null)
        map.set(slot.name, { ms: slot.smooth, profile: slot.profile });
    sweepSpecs.set(type, map);
  }
  return map.get(name) ?? null;
}

/* ---- the attr mechanism: metadata -> the element's native `transition` ----
 *
 * THE MAPPING TABLE, hand-paired with the appliers below exactly as the attr vocabulary
 * itself is (attrs.h's rule: every row must have a reader here). The backend's css
 * column decides WHAT may transition; this decides WHERE each entry lands — which CSS
 * property, and on which element (a path's paint rides the <path>, not the box). An ink
 * shadow lands on `filter`, not box-shadow, which is why the served name is nominal. */
const TRANSITION_COMMON: Record<string, string> = {
  left: "left", top: "top", right: "right", bottom: "bottom",
  w: "width", h: "height",
  minW: "min-width", maxW: "max-width", minH: "min-height", maxH: "max-height",
  rotate: "transform", originX: "transform-origin", originY: "transform-origin",
  shadow: "box-shadow", shadowX: "box-shadow", shadowY: "box-shadow",
  shadowBlur: "box-shadow",
};
const TRANSITION_KIND: Record<string, Record<string, string>> = {
  frame: { surface: "background-color", border: "border-color",
           borderW: "border-width", radius: "border-radius",
           shadowSpread: "box-shadow" },
  text: { color: "color", size: "font-size" },
  icon: { color: "color" },
  path: { fill: "fill", stroke: "stroke", strokeW: "stroke-width", points: "d" },
};
/* the entries that ride the inner <path> element rather than the node's own box */
const TRANSITION_ON_PATH = new Set(["fill", "stroke", "strokeW", "points"]);

/* the node's transition metadata as two CSS `transition` values: the element's own and
 * its <path>'s. The ms and profile are PROGRAMS evaluated over true values (specMs /
 * specProfile above — a duration that comes out wrong renders NO entry, the honest
 * snap). Deduped per CSS property (first declared wins — shadowX and shadowY both
 * land on box-shadow); ink turns a box-shadow entry into a filter one, except the
 * INSET ink shadow, whose url(#) filter has nothing the browser can blend. */
function transitionCss(state: StageState, node: ViewNode, inkInset: boolean,
                       cells: ViewHost): { el: string; path: string } {
  const rows = node.transitions;
  if (!rows) return { el: "", path: "" };
  const ink = node.kind !== "frame" && !node.instance;
  const elSeen = new Set<string>();
  const pathSeen = new Set<string>();
  const el: string[] = [];
  const path: string[] = [];
  for (const attr of Object.keys(rows)) {
    const spec = rows[attr];
    if (!spec) continue;
    let css = TRANSITION_KIND[node.kind]?.[attr] ?? TRANSITION_COMMON[attr] ?? "";
    if (!css) continue;
    if (css === "box-shadow" && ink) {
      if (inkInset) continue;
      css = "filter";
    }
    const onPath = node.kind === "path" && TRANSITION_ON_PATH.has(attr);
    const seen = onPath ? pathSeen : elSeen;
    if (seen.has(css)) continue;
    const ms = specMs(state, spec.ms, cells);
    if (ms === null) continue;
    seen.add(css);
    (onPath ? path : el).push(css + " " + ms + "ms " +
                              specProfile(state, spec.profile, cells));
  }
  return { el: el.join(", "), path: path.join(", ") };
}

/* ---- the sampled turn: what the shadow un-turn reads while a rotation ANIMATES ----
 *
 * At rest the authored rotate chain is the truth and stays the source (read through the
 * cells, so a live rotation is a recorded dependency). But while a `transform`
 * TRANSITION is running, the browser owns the intermediate rotations — so the elements
 * with one in flight are tracked (transitionstart/end/cancel, wired per host) and the
 * turn is read off the COMPUTED matrix instead: atan2 of the linear part, which
 * translation and the camera's pure scale never disturb. A ticker re-runs the
 * shadow-bearing binds each frame while anything is turning, so the shadow lands
 * correctly at every angle the browser paints, not just the endpoints. */
function styleTurn(el: HTMLElement): number | null {
  if (typeof getComputedStyle !== "function") return null;
  const text = getComputedStyle(el).transform;
  if (!text || text === "none") return 0;
  const matrix = /^matrix\(([^)]+)\)$/.exec(text);
  if (!matrix) return null;
  const parts = matrix[1].split(",").map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1]))
    return null;
  return (Math.atan2(parts[1], parts[0]) * 180) / Math.PI;
}

/* one pass over exactly the shadow-bearing binds: what a turning frame re-runs, and
   what a finished turn runs once more so the shadow lands on the exact endpoint */
function repaintShadows(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  if (!state.shadowed.size) return;
  state.pass++;
  for (const bind of Array.from(state.shadowed))
    if (state.binds.get(bind.key) === bind && bind.pass !== state.pass)
      runAppliers(state, editor, bind);
  repaintFree();
}

function scheduleTurn(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  if (state.turnTicking || !state.turning.size || !state.shadowed.size) return;
  state.turnTicking = true;
  const frame = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (fn: () => void) => setTimeout(fn, 16);
  frame(() => {
    state.turnTicking = false;
    /* an element that left without its transitionend firing must not spin this forever */
    for (const el of Array.from(state.turning))
      if (!(el as HTMLElement).isConnected) state.turning.delete(el);
    if (!state.turning.size) return;
    repaintShadows(host, editor);
    scheduleTurn(host, editor);
  });
}

/* ---- reading a node's fields ---- */

/* ONE RECORDED READ. What a cell was worth is remembered against its key, so the live
 * diff is a string compare per cell and nothing else, and the bind that read it is
 * indexed against it by whoever is recording.
 *
 * OUTSIDE A PASS NOTHING IS RECORDED. A gesture reads its params through the seat it was
 * armed with (gestures.ts), and marking a cell there would hide a change the next live
 * frame is supposed to patch. */
function sawCell(state: StageState, key: string, mark: string): void {
  if (!state.recording) return;
  state.recording.deps.add(key);
  state.marks.set(key, mark);
}

/* ---- THEME TOKENS ARE RESOLVED BY THE VIEW, AS COLOURS ----
 *
 * A "$name" reaching any colour — a `theme:` load in an attr program, a cell the wire
 * published by reference, a token authored in a slot — becomes THIS view's hex for the
 * token in its own mode (the mode is per view: a preview toggle, never a truth). The read
 * is RECORDED under "theme:<name>", so a mode flip or a token edit re-runs exactly the
 * binds that painted it (markNow answers the key). One representation of a token in the
 * view — a colour — which is what lets `$accent.Alpha(0.5)` mix in an attr. */
let theme: { state: StageState | null; hex: (name: string) => string } =
  { state: null, hex: () => "#00000000" };

function armTheme(state: StageState, editor: Editor): void {
  const tokens = editor.store.tokens();
  const mode = editor.view.themeMode ?? "dark";
  theme = {
    state,
    hex: (name) => {
      const token = tokens.find((t) => t.name === name);
      /* an unknown token paints nothing, matching the compiler's own warning */
      return token ? (mode === "light" ? token.light : token.dark) : "#00000000";
    },
  };
}

function themeColor(name: string): string {
  const hex = theme.hex(name);
  if (theme.state) sawCell(theme.state, "theme:" + name, hex);
  return hex;
}

/* ONE PUBLISHED CELL, read by key the way every published cell is read: an AGGREGATE
 * lives in the standing copies the shell folds the delta lane into, and what gets
 * recorded is that copy's VERSION — comparing a thousand-element list per frame to learn
 * whether a plot moved is the cost the counter exists to remove. A scalar lives in
 * `values`. An absent key is Nil, honestly: nothing has published it yet. */
function liveCell(state: StageState, editor: Editor, key: string): Json {
  const held = editor.agg?.(key) ?? null;
  if (held) {
    sawCell(state, key, "a" + held.version);
    return held.values;
  }
  const live = editor.live?.values?.[key];
  sawCell(state, key, JSON.stringify(live ?? null));
  return live === undefined ? null : live;
}

/* The cells one node's programs read. `slot:` is the instance's own value — LIVE FIRST:
 * the cell the runtime publishes, else what this placement authors, else the type's
 * default, which is the whole of what makes a bound surface a working lamp. */
function cellsFor(state: StageState, editor: Editor, node: ViewNode,
                  repeat: RepeatCopy | null): ViewHost {
  /* NAMED, because it reads through itself: a slot's declared sweep evaluates its ms
     and profile programs over these same cells (specValue's guard keeps those reads
     un-eased, which is also what makes the recursion bottom out) */
  const read = (cell: string): Json => {
    const colon = cell.indexOf(":");
    const kind = colon < 0 ? "" : cell.slice(0, colon);
    const name = colon < 0 ? cell : cell.slice(colon + 1);
    switch (kind) {
      case "slot": {
        if (!node.owner) return null;
        const key = node.owner + "." + name;
        /* A PER-COPY PROPERTY (THE PLACEMENT RULE). Its expression named `state` or
           `repeat`, so the backend built no standing program and published no cell — it
           served the program here instead, and this view runs it over THIS copy's cells.
           Through `read`, so everything the expression can name resolves exactly as it
           does in an attr, and every cell it touches is recorded against this element. */
        const perCopy = editor.nodeAttrs?.[String(node.owner)]?.slots?.[name];
        /* an aggregate cell (a list, a map, a history ring) lives in the standing
           copies, not in `values`: the wire sends deltas and the shell folds them
           (editor.ts). What is RECORDED is the copy's version — comparing thousands
           of elements per frame to learn whether a plot moved is the cost that
           counter exists to remove. A Nil copy falls through to the authored value,
           exactly as a Nil scalar's omitted key does. */
        const resolve = (): Json => {
          const held = editor.agg?.(key) ?? null;
          if (held) {
            sawCell(state, key, "a" + held.version);
            if (held.values !== null) return held.values;
          } else {
            const live = editor.live?.values?.[key];
            sawCell(state, key, JSON.stringify(live ?? null));
            if (live !== undefined && live !== null) return live;
          }
          /* the authored value: the instance's `slots` is FLAT, keyed by the input */
          const slots = editor.store.nodeAt(node.owner)?.slots;
          const at: Json = slots && typeof slots === "object" && !Array.isArray(slots)
            ? (slots as Record<string, Json>)[name] : undefined;
          if (at !== undefined) return at;
          return node.type?.slots.find((s) => s.name === name)?.default ?? null;
        };
        const out = perCopy ? run(perCopy, read) : resolve();
        /* THE PROPERTY'S DECLARED TRANSITION, applied to what an APPLIER pass reads —
           and only there: a structural pass (which elements exist) and a gesture's seat
           (recording null) always see the true value. The mark above records TRUTH, so
           a live frame still retunes the sweep the moment the real value moves. The ms
           and profile are programs over these same cells, read un-eased. */
        if (state.recording && !state.recording.structural) {
          const spec = slotSweep(node.type, name);
          if (spec) {
            /* ONE SWEEP PER VALUE. A shared slot is one published cell every copy draws,
               so one tween is right; a PER-COPY one is a different number per picture and
               needs a tween of its own, or five copies would fight over one flight. */
            const flight = "c:" + key + (perCopy && repeat ? "@" + repeat.index : "");
            const ms = specMs(state, spec.ms, read);
            if (ms === null) {
              /* the duration came out wrong: no sweep, and none left standing */
              state.tweens.delete(flight);
              return out;
            }
            return tweenTo(state, flight, out, ms,
                           specProfile(state, spec.profile, read), key);
          }
        }
        return out;
      }
      /* A VARIABLE and A MESH FIELD, on a page element's attrs. Both are ONE published
         value read by key, which is the whole of what the display tier needed to name the
         same universe a flow does — a variable's key is its own `v<id>` (the cell the
         runtime already published long before an attr could load it), a mesh field's is
         the served spelling itself. Aggregates ride the standing copies exactly as a list
         slot does; scalars ride `values`, and an absent key is honestly Nil. */
      case "var":
      case "mesh":
        return liveCell(state, editor, kind === "var" ? "v" + name : cell);
      /* a token is a COLOUR here: this view's hex for it, recorded so a mode flip
         re-runs the program (which is what lets an attr mix it) */
      case "theme":
        return themeColor(name);
      /* this view's own gesture state (gestures.ts writes it outside edit mode). The
         read is RECORDED so a write patches exactly the pictures that bind it; in edit
         mode nothing writes, and it honestly reads false — never a pressed-looking
         instance nobody is pressing. */
      case "state": {
        const seat = stateSeat(node, repeat);
        const value = editor.view.state?.[seat]?.[name] ?? false;
        sawCell(state, "state:" + seat + ":" + name, JSON.stringify(value));
        return value;
      }
      case "repeat": {
        if (!repeat) return null;
        if (name === "index") return repeat.index;
        if (name === "count") return repeat.count;
        /* the FRACTION of the way through: 0 at the first copy, 1 at the last, which is
           what places a tick at its own value rather than a step past it */
        return repeat.count > 1 ? repeat.index / (repeat.count - 1) : 0;
      }
      /* the clock (timeField above): recorded like any cell, ticked by its own frame
         loop — stepTime re-runs exactly the binds whose time cell moved */
      case "time": {
        const value = timeField(name);
        sawCell(state, "time:" + name, JSON.stringify(value));
        return value;
      }
      /* a timer's face (timerField above): derived per frame from the served
         deadline record, recorded and ticked exactly like a time cell */
      case "tmr": {
        const value = timerField(editor, name);
        sawCell(state, "tmr:" + name, JSON.stringify(value));
        return value;
      }
      /* optcount/optnames/optfrac: an option list is a value now -- the `options` param
         evaluates to a real list -- so nothing needs a cell of its own to expand one.
         hist() left the language with the privileged rings (a history is a list slot or
         a list variable now). Nothing else reaches here: `tile` is refused at compile,
         since a node cannot measure itself. */
      default:
        return null;
    }
  };
  return read;
}

/* what one cell is worth NOW, in the same spelling a recorded read wrote */
function markNow(editor: Editor, key: string): string {
  /* a token's mark is its hex in this view's mode: a mode flip moves every one */
  if (key.startsWith("theme:")) return theme.hex(key.slice(6));
  const held = editor.agg?.(key) ?? null;
  if (held) return "a" + held.version;
  return JSON.stringify(editor.live?.values?.[key] ?? null);
}

function attrOf(node: ViewNode, name: string, cells: ViewHost): Json {
  const program = node.attrs?.[name] as Program | undefined;
  return program ? run(program, cells) : undefined;
}

/* WHOSE LOOK THIS IS. The CHANNEL groups an instance's own anatomy — the knob presses and
 * the lamp lights, because they are one control seen twice — and the COPY separates the
 * pictures of a repeated one, which are as separate as two controls. Keying on the channel
 * alone lit every copy of a repeated Toggle from one press. `@index` is the same spelling
 * the reconcile keys copies by, so one convention describes both halves.
 *
 * Nested repeats are NOT addressed here, deliberately: `repeat` is one slot in every tier
 * (a copy inside a copy already has only its innermost index to be), so this is exactly as
 * precise as the language it serves. */
function stateSeat(node: ViewNode, repeat: RepeatCopy | null): string {
  return repeat ? node.channel + "@" + repeat.index : String(node.channel);
}

/* A gesture's view-local look (state.pressed / dragging / open) lands here. The write is
 * free; the PATCH happens only where some rendered program actually read that cell —
 * which the pass recorded — so an instance that never binds its state costs nothing to
 * press. The seat is computed at WRITE time off the live bind: a reconcile moves a copy's
 * index under a listener that was armed once and outlives it. */
function gestureStateWriter(state: StageState, editor: Editor, bind: Bind) {
  return (name: string, value: Json): void => {
    const seat = stateSeat(bind.node, bind.repeat);
    const bucket = (editor.view.state[seat] ??= {});
    if (bucket[name] === value) return;
    bucket[name] = value;
    state.flushState("state:" + seat + ":" + name);
  };
}

/* ---- the appliers ----
 *
 * EVERY ONE IS TOTAL. The element already carries the last pass's answer, so an applier
 * that only writes what is authored would leave a surface standing after it was cleared.
 * A style property clears with "", an SVG attribute with removeAttribute. */

/* How a node sits in what holds it: the node places itself, in canvas px on a page and in
 * fractions of its parent inside a component. AN AXIS IS AUTHORED FROM EITHER END: `left`
 * places the near edge (the origin point, exactly the old `x`), and `right`, once set,
 * pins the FAR edge as an inset from the parent's — with both set the width follows the
 * edges and `w` goes inert; with `right` alone the box anchors right at `w`. The browser
 * itself derives the edge-pinned size, which is why this is all plain CSS writes. Both
 * edges pin when nothing on the axis is set, which is why an overlay needs nothing said
 * about it. `minW`/`maxW`/`minH`/`maxH` clamp whatever the axis derives — an authored
 * size, pinned edges, or an aspect ratio. */
function place(el: HTMLElement, node: ViewNode, cells: ViewHost): void {
  el.style.position = "absolute";
  /* which unit system this node's numbers are in: page nodes are canvas px, a
     component's internals are fractions of their parent (the builder said which) */
  const px = !node.frac;
  const unit = (value: number) => (px ? value + "px" : pct(value));
  const aspect = num(attrOf(node, "aspect", cells));
  const left = num(attrOf(node, "left", cells));
  const top = num(attrOf(node, "top", cells));
  const right = num(attrOf(node, "right", cells));
  const bottom = num(attrOf(node, "bottom", cells));
  const w = num(attrOf(node, "w", cells));
  const h = num(attrOf(node, "h", cells));
  const ox = num(attrOf(node, "originX", cells)) ?? 0;
  const oy = num(attrOf(node, "originY", cells)) ?? 0;
  /* A STRETCHED AXIS HAS NO PLACEMENT POINT: both edges are pinned, so there is no `left`
     for the origin to be the reference OF, and the offset below must not apply to it. Only
     the rotation half of `originX`/`originY` survives on such an axis. A pinned FAR edge
     takes the placement point away the same way: `left` and `right` are then both plain
     edges, and the width is theirs to decide. */
  const spanX = w === null && left === null && right === null;
  const spanY = h === null && top === null && bottom === null;
  const minW = num(attrOf(node, "minW", cells));
  const maxW = num(attrOf(node, "maxW", cells));
  const minH = num(attrOf(node, "minH", cells));
  const maxH = num(attrOf(node, "maxH", cells));

  /* CLAMPS TRANSFER THROUGH THE RATIO. CSS derives an aspect axis one way only: a clamp
     on the DERIVED axis clips it in place and lets the ratio break (only a replaced
     element re-resolves the other axis). So where `aspect` is deriving one axis, the
     derived axis's clamps fold into the AUTHORED axis's emitted size as min()/max()
     terms — converted through the ratio — and the ratio holds through every clamp. The
     cross-axis measure is cqw/cqh (every box is a size container, stage.css): a height
     bounded by the parent's width is exactly what those units say. On a page the terms
     are plain px and no container is consulted. */
  const ratioed = aspect !== null && aspect > 0;
  const derivesW = ratioed && h !== null && w === null && !spanX &&
    !(left !== null && right !== null);
  const derivesH = ratioed && w !== null && h === null && !spanY &&
    !(top !== null && bottom !== null);
  const fold = (base: string, upper: string | null, lower: string | null) => {
    let out = base;
    if (upper !== null) out = "min(" + out + ", " + upper + ")";
    if (lower !== null) out = "max(" + out + ", " + lower + ")";
    return out;
  };
  const crossW = (value: number) =>
    px ? value / (aspect as number) + "px" : (100 * value) / (aspect as number) + "cqw";
  const crossH = (value: number) =>
    px ? value * (aspect as number) + "px" : 100 * value * (aspect as number) + "cqh";
  const hText = h === null ? "" : derivesW
    ? fold(unit(h), maxW !== null ? crossW(maxW) : null,
                    minW !== null ? crossW(minW) : null)
    : unit(h);
  const wText = w === null ? "" : derivesH
    ? fold(unit(w), maxH !== null ? crossH(maxH) : null,
                    minH !== null ? crossH(minH) : null)
    : unit(w);

  if (spanX) {
    el.style.left = "0";
    el.style.right = "0";
    el.style.width = "";
  } else {
    /* absent `left` pins to 0 only while the axis is left-authored; with `right` set the
       absence means anchored-right, and left stays free */
    el.style.left = left !== null ? unit(left) : right !== null ? "" : unit(0);
    el.style.right = right !== null ? unit(right) : "";
    el.style.width =
      w !== null && !(left !== null && right !== null) ? wText : "";
  }
  if (spanY) {
    el.style.top = "0";
    el.style.bottom = "0";
    el.style.height = "";
  } else {
    el.style.top = top !== null ? unit(top) : bottom !== null ? "" : unit(0);
    el.style.bottom = bottom !== null ? unit(bottom) : "";
    el.style.height =
      h !== null && !(top !== null && bottom !== null) ? hText : "";
  }
  el.style.minWidth = minW !== null ? unit(minW) : "";
  el.style.maxWidth = maxW !== null ? unit(maxW) : "";
  el.style.minHeight = minH !== null ? unit(minH) : "";
  el.style.maxHeight = maxH !== null ? unit(maxH) : "";
  el.style.aspectRatio = ratioed ? String(aspect) : "";

  /* ONE REFERENCE POINT serves both jobs: the point `left`/`top` places, and the pivot
     `rotate` turns about — a fraction of the node's OWN box in either unit system, so a
     needle authored with its origin at its hub rotates about the dial's centre with
     nothing else said. The two jobs SEPARATE on a stretched axis, which is exactly what a
     needle is: it fills its dial and only turns, so it takes the pivot and not the shift.
     (It took the shift too until 2026-08-05, which put every needle half a dial up and to
     the left of where it belonged — invisible only because the box above it clipped.) */
  const rotate = num(attrOf(node, "rotate", cells));
  const shiftX = spanX || right !== null ? 0 : ox;
  const shiftY = spanY || bottom !== null ? 0 : oy;
  const parts: string[] = [];
  if (shiftX || shiftY)
    parts.push("translate(" + pct(-shiftX) + ", " + pct(-shiftY) + ")");
  if (rotate !== null) parts.push("rotate(" + rotate + "deg)");
  el.style.transform = parts.length ? parts.join(" ") : "";
  el.style.transformOrigin = parts.length ? pct(ox) + " " + pct(oy) : "";
}

/* WHAT `clip` SAYS, read once for every kind that honours it. Absent (or Nil, which is
 * "unknown" and must not invent a picture) leaves the kind's own default standing; any
 * other value decides, `true` clipping to the box and a number also rounding it. The
 * `authored` half is what lets an explicit `clip: false` turn OFF a clip the kind applies
 * by itself — a text's ellipsis is the only one there is. */
function clipOf(node: ViewNode, cells: ViewHost): {
  authored: boolean; on: boolean; radius: number | null;
} {
  const value = attrOf(node, "clip", cells);
  if (value === undefined || value === null) return { authored: false, on: false, radius: null };
  const on = truthy(value);
  return { authored: true, on, radius: on ? num(value) : null };
}

/* ---- A BOX THAT SCROLLS ITS CHILDREN ----
 *
 * WHICH AXES `scroll` OPENS, and nothing about the bar (that is `scrollbar`'s half, below).
 * Absent, Nil or false is a box that does not scroll — Nil counts as absent for the same
 * reason it does in `clip`: an unknown must not invent a picture. A bare `true` is the
 * VERTICAL case, because a list of rows is what asks for this; a word the vocabulary does
 * not know falls the same way rather than rendering nothing, exactly as a text's `align`
 * does with its own. */
function scrollOf(node: ViewNode, cells: ViewHost):
  { axes: string; x: boolean; y: boolean } | null {
  const value = attrOf(node, "scroll", cells);
  if (value === undefined || value === null || !truthy(value)) return null;
  const word = (attrText(value) ?? "").trim().toLowerCase();
  const x = word === "x" || word === "both";
  const y = !x || word === "both";
  return { axes: x ? (y ? "both" : "x") : "y", x, y };
}

/* THE BAR — the one part of the picture no applier can write directly: a scrollbar is drawn
 * by pseudo-elements (::-webkit-scrollbar and friends) that no element's style attribute
 * can reach. So the VALUES still come from the attrs, as custom properties the box's own
 * pseudo-elements inherit, and stage.css holds the mechanism they feed. `data-scroll` marks
 * the box for those rules, for the touch allowance (input-floor.css grants a scroll box the
 * pan its axis needs) and for the wheel, which asks the elements under the pointer whether
 * one of them takes it.
 *
 * TOTAL, like every applier: a box that stopped scrolling loses the attribute, the
 * properties AND its scroll offsets — an offset on an axis that no longer scrolls is a
 * displaced picture with nothing left to put it back (overflow: hidden keeps whatever
 * scrollTop it was left holding). */
function scrollbar(el: HTMLElement, node: ViewNode, cells: ViewHost,
                   scroll: { axes: string; x: boolean; y: boolean } | null): void {
  const setVar = (name: string, value: string | null) => {
    if (value === null) el.style.removeProperty(name);
    else el.style.setProperty(name, value);
  };
  if (!scroll) {
    el.removeAttribute("data-scroll");
    el.removeAttribute("data-scrollbar");
    setVar("--sb-w", null);
    setVar("--sb-thumb", null);
    setVar("--sb-track", null);
  } else {
    el.setAttribute("data-scroll", scroll.axes);
    const bar = attrOf(node, "scrollbar", cells);
    /* absent (or Nil) = drawn, the default the served table shows: a bar is how a box says
       it has more to show, and losing it to an unknown would be losing that sentence */
    if (bar === undefined || bar === null || truthy(bar)) el.removeAttribute("data-scrollbar");
    else el.setAttribute("data-scrollbar", "off");
    setVar("--sb-w", (num(attrOf(node, "scrollbarW", cells)) ?? 8) + "px");
    const thumb = attrOf(node, "scrollbarColor", cells);
    setVar("--sb-thumb", paints(thumb) ? cssColor(thumb) : null);
    const track = attrOf(node, "scrollbarTrack", cells);
    setVar("--sb-track", paints(track) ? cssColor(track) : null);
  }
  if (!scroll?.x && el.scrollLeft) el.scrollLeft = 0;
  if (!scroll?.y && el.scrollTop) el.scrollTop = 0;
}

/* ---- THE SHADOW: one authored intent, three mechanisms ----
 *
 * The author writes a PICTURE — a colour, an offset, a softness, in or out — and the view
 * picks whatever the element it is drawing can actually cast:
 *
 *   a BOX (frame, and an instance wearing its component's root box) → `box-shadow`, which
 *   follows the border radius, takes a spread and turns inward on its own;
 *   INK (text, icon, path) → a `filter`, so the shadow follows the GLYPH or the STROKE
 *   rather than the rectangle around it. Outward that is `drop-shadow()`; inward there is
 *   no shorthand at all, so it is a real SVG inner-shadow filter (shadowDefs below).
 *
 * THE OFFSET DOES NOT TURN. `rotate` turns the element and everything it draws, a shadow
 * included — which is wrong for a shadow, because light does not orbit the thing it falls
 * on. So the offset is authored in the ARTBOARD's axes and un-turned here by the total
 * rotation between this node and the root: a needle sweeping its dial keeps one still
 * shadow instead of swinging one around with it. */
interface Shadow {
  color: string;
  /* already un-turned: what to hand the mechanism, in the node's own turned axes */
  dx: number;
  dy: number;
  blur: number;
  spread: number;
  inset: boolean;
}

/* every rotation between this node and the artboard, summed. Read THROUGH each ancestor's
 * own cells while the pass is recording, so an ancestor whose `rotate` is live becomes a
 * dependency of this node's shadow and a frame that moves it re-runs exactly this bind. */
function turnOf(state: StageState, editor: Editor, bind: Bind | null): number {
  let sum = 0;
  for (let at = bind; at; at = at.parent) {
    /* the authored value is read THROUGH the cells even where the sample wins below:
       the read is what records the dependency that re-runs this shadow when a live
       rotation moves */
    const turn = num(attrOf(at.node, "rotate", cellsFor(state, editor, at.node, at.repeat)));
    /* while this ancestor's transform TRANSITION is in flight, the browser owns the
       angle: read it off the painted matrix so the shadow lands right mid-sweep too */
    if (state.turning.size && state.turning.has(at.el)) {
      const sampled = styleTurn(at.el);
      if (sampled !== null) {
        sum += sampled;
        continue;
      }
    }
    if (turn !== null) sum += turn;
  }
  return sum;
}

function shadowOf(state: StageState, editor: Editor, bind: Bind, node: ViewNode,
                  cells: ViewHost): Shadow | null {
  const color = attrOf(node, "shadow", cells);
  /* THE COLOUR IS THE SWITCH, the same rule `surface` and `border` follow */
  if (!paints(color)) return null;
  const dx = num(attrOf(node, "shadowX", cells)) ?? 0;
  const dy = num(attrOf(node, "shadowY", cells)) ?? 0;
  /* R(-turn) applied to the authored offset: what the element draws in its own turned
     axes so that what LANDS on the artboard is the vector the author wrote */
  const rad = (turnOf(state, editor, bind) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    color: cssColor(color),
    dx: dx * cos + dy * sin,
    dy: -dx * sin + dy * cos,
    blur: Math.max(0, num(attrOf(node, "shadowBlur", cells)) ?? 0),
    spread: num(attrOf(node, "shadowSpread", cells)) ?? 0,
    inset: truthy(attrOf(node, "shadowInset", cells)),
  };
}

/* a length as CSS, rounded off the floating-point dust the un-turning leaves behind */
function shadowPx(value: number): string {
  return Math.round(value * 1000) / 1000 + "px";
}

/* ---- the ink half: a filter, and for `inset` a real one ----
 *
 * The filters hang off the host in one hidden <svg>. Creating an element at runtime is
 * exactly what this renderer does not do — but a filter is not a rendered node: nothing
 * can be selected in it, pressed in it or hold a caret in it, and it lives and dies with
 * the bind that references it. */
const SVG_NS = "http://www.w3.org/2000/svg";
let filterSeq = 0;

function shadowDefs(state: StageState): SVGSVGElement {
  if (!state.defs) {
    const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    svg.setAttribute("class", "shadow-defs");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    state.host.appendChild(svg);
    state.defs = svg;
  }
  return state.defs;
}

/* THE INNER SHADOW, in six primitives: offset the shape's own alpha, blur it, subtract it
 * FROM the shape (what is left is the band along the edge the offset came from), flood
 * that band with the colour and lay it over the shape. An offset down-right therefore
 * darkens the top-left inside, which is what an inset box-shadow does too. */
function inkFilter(state: StageState, bind: Bind, shadow: Shadow): string {
  const defs = shadowDefs(state);
  if (!bind.shadowId) bind.shadowId = "hmi-shadow-" + ++filterSeq;
  let filter = defs.querySelector("#" + bind.shadowId) as SVGElement | null;
  if (!filter) {
    filter = document.createElementNS(SVG_NS, "filter") as SVGElement;
    filter.setAttribute("id", bind.shadowId);
    /* room for a blur that reaches past the shape's own box */
    filter.setAttribute("x", "-50%");
    filter.setAttribute("y", "-50%");
    filter.setAttribute("width", "200%");
    filter.setAttribute("height", "200%");
    for (const spec of [
      ["feOffset", { in: "SourceAlpha", result: "off" }],
      ["feGaussianBlur", { in: "off", result: "soft" }],
      ["feComposite", { in: "SourceAlpha", in2: "soft", operator: "out", result: "band" }],
      ["feFlood", { result: "ink" }],
      ["feComposite", { in: "ink", in2: "band", operator: "in", result: "shade" }],
      ["feComposite", { in: "shade", in2: "SourceGraphic", operator: "over" }],
    ] as [string, Record<string, string>][]) {
      const node = document.createElementNS(SVG_NS, spec[0]);
      for (const [key, value] of Object.entries(spec[1])) node.setAttribute(key, value);
      filter.appendChild(node);
    }
    defs.appendChild(filter);
  }
  const kids = filter.childNodes as unknown as SVGElement[];
  kids[0].setAttribute("dx", String(shadow.dx));
  kids[0].setAttribute("dy", String(shadow.dy));
  /* CSS blur radius is twice the deviation an SVG blur wants */
  kids[1].setAttribute("stdDeviation", String(shadow.blur / 2));
  /* as a STYLE, not an attribute: a presentation attribute cannot hold a var() */
  (kids[3] as unknown as HTMLElement).style.floodColor = shadow.color;
  (kids[3] as unknown as HTMLElement).style.floodOpacity = "1";
  return "url(#" + bind.shadowId + ")";
}

function dropFilter(state: StageState, bind: Bind): void {
  if (!bind.shadowId) return;
  const held = state.defs?.querySelector("#" + bind.shadowId);
  held?.remove();
  bind.shadowId = "";
}

/* TOTAL, like every applier: ink with no shadow carries no filter at all */
function inkShadow(state: StageState, bind: Bind, shadow: Shadow | null): void {
  if (!shadow) {
    dropFilter(state, bind);
    bind.el.style.filter = "";
    return;
  }
  if (!shadow.inset) {
    dropFilter(state, bind);
    bind.el.style.filter = "drop-shadow(" + shadowPx(shadow.dx) + " " +
      shadowPx(shadow.dy) + " " + shadowPx(shadow.blur) + " " + shadow.color + ")";
    return;
  }
  bind.el.style.filter = inkFilter(state, bind, shadow);
}

/* the dressing every box wears, whatever holds it */
function dress(el: HTMLElement, node: ViewNode, cells: ViewHost,
               shadow: Shadow | null): void {
  const surface = attrOf(node, "surface", cells);
  el.style.background = paints(surface) ? cssColor(surface) : "";
  const border = attrOf(node, "border", cells);
  el.style.border = paints(border)
    ? (num(attrOf(node, "borderW", cells)) ?? 1) + "px solid " + cssColor(border)
    : "";
  const radius = num(attrOf(node, "radius", cells));
  const clip = clipOf(node, cells);
  const scroll = scrollOf(node, cells);
  /* WRITTEN, never cleared: "" would hand the answer back to the stylesheet, and a
     stylesheet that clipped boxes is exactly what made this attr do nothing. A box that
     does not clip lets its children paint outside it and is otherwise untouched — nothing
     here is layout, so nothing moves.
     A SCROLLING AXIS IS A WINDOW onto the content, so it clips whatever `clip` said and
     hands the strip past its edge to the browser instead. The other axis clips too where
     one of them scrolls: `visible` beside a scrolling axis is not a picture CSS has (the
     browser turns it into a second scrollbar), and a box asking to scroll one way has not
     asked to spill the other. Two values are x then y, one serves both. */
  const rest = clip.on ? "hidden" : "visible";
  const overflowX = scroll ? (scroll.x ? "auto" : "hidden") : rest;
  const overflowY = scroll ? (scroll.y ? "auto" : "hidden") : rest;
  el.style.overflow =
    overflowX === overflowY ? overflowX : overflowX + " " + overflowY;
  scrollbar(el, node, cells, scroll);
  el.style.borderRadius = clip.radius !== null && clip.radius > 0 ? clip.radius + "px"
                        : radius !== null ? radius + "px" : "";
  /* A BOX CASTS box-shadow: it follows the radius set just above, takes a spread and does
     its own `inset`. CLEARED with "", not "none" — the artboard's own drop shadow is a
     stylesheet rule on `.page`, and this same applier dresses that element. */
  el.style.boxShadow = shadow
    ? (shadow.inset ? "inset " : "") + shadowPx(shadow.dx) + " " + shadowPx(shadow.dy) +
      " " + shadowPx(shadow.blur) + " " + shadowPx(shadow.spread) + " " + shadow.color
    : "";
}

function applyText(el: HTMLElement, node: ViewNode, cells: ViewHost): void {
  const value = attrOf(node, "text", cells);
  /* UNKNOWN renders the unknown treatment, never a fabricated value */
  const text = attrText(value);
  el.classList.toggle("unknown", text === null);
  const shown = text === null ? "--" : text;
  /* ASSIGNED ONLY WHEN IT MOVED: writing textContent replaces the text node, which drops
     a native selection the user is holding inside it */
  if (el.textContent !== shown) el.textContent = shown;
  const color = attrOf(node, "color", cells);
  el.style.color = paints(color) ? cssColor(color) : "";
  const size = num(attrOf(node, "size", cells));
  el.style.fontSize = size !== null ? size + "px" : "";
  const align = attrText(attrOf(node, "align", cells)) ?? "start";
  el.style.textAlign = TEXT_ALIGN[align] ?? "left";
  el.style.fontWeight = truthy(attrOf(node, "bold", cells)) ? "600" : "";
  const wrap = truthy(attrOf(node, "wrap", cells));
  /* THE ELLIPSIS IS A CLIP, and `clip` is the one word that turns a clip off: a one-line
     text fits itself by default (ellipsis needs overflow hidden to show at all), and an
     explicit `clip: false` lets the line run past its box instead. Absent leaves the
     kind's own default — the ellipsis — exactly where it was. */
  const clip = clipOf(node, cells);
  const clipped = clip.authored ? clip.on : !wrap;
  el.style.whiteSpace = wrap ? "" : "nowrap";
  el.style.overflow = clipped ? "hidden" : "visible";
  el.style.textOverflow = clipped && !wrap ? "ellipsis" : "";
}

function applyIcon(bind: Bind, node: ViewNode, cells: ViewHost): void {
  const el = bind.el;
  const name = attrText(attrOf(node, "name", cells)) ?? "";
  const stroke = num(attrOf(node, "strokeW", cells)) ?? 1.5;
  /* the glyph fills the box the layout gave it (stage.css sizes the svg to 100%), so the
     markup's own size argument is irrelevant here and the box is the only lever. The
     markup is rewritten only when it would differ: an icon's svg is a subtree like any
     other, and re-parsing it per live frame is exactly the churn this renderer removed. */
  const sig = name + "|" + stroke;
  if (sig !== bind.iconSig) {
    bind.iconSig = sig;
    el.innerHTML = name ? iconMarkup(name, 24, stroke) : "";
  }
  const color = attrOf(node, "color", cells);
  el.style.color = paints(color) ? cssColor(color) : "";
}

/* ---- the ink ----
 *
 * A path is an <svg> filling the node's box with a 0..1 viewBox, so every anchor is a
 * FRACTION and the shape scales with whatever room it is given. `preserveAspectRatio:
 * none` is deliberate — the box is the coordinate system — and a shape that must stay
 * round (a dial) says so with `aspect: 1` rather than by hoping. The stroke is exempted
 * from that scaling (`non-scaling-stroke`), because a line's weight is a pixel fact. */
function anchorPoint(anchor: CompiledAnchor, cells: ViewHost): { x: number; y: number } | null {
  const x = num(anchor.x ? run(anchor.x, cells) : null);
  const y = num(anchor.y ? run(anchor.y, cells) : null);
  return x === null || y === null ? null : { x, y };
}

function pathData(node: ViewNode, cells: ViewHost): string {
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

/* A PLOT IS AN ORDINARY BIND. A path whose `points` reads a trend cell records that cell
 * like any other program, and a live frame re-runs exactly this — one `d` rewritten, no
 * element touched. There is no plot list and no hist-only branch any more. */
function applyPath(path: SVGPathElement, node: ViewNode, cells: ViewHost): void {
  const d = pathData(node, cells);
  path.setAttribute("d", d);
  /* a TRANSITIONED outline rides the CSS `d` property (a style, so the browser sees a
     property change to blend; the attribute alone does not reliably trigger one). The
     browser interpolates it only while the segment structure holds — a changed point
     count or a new gap snaps, which is the honest degradation. */
  if (node.transitions?.points && d) path.style.setProperty("d", 'path("' + d + '")');
  else path.style.removeProperty("d");
  const fill = attrOf(node, "fill", cells);
  path.setAttribute("fill", paints(fill) ? cssColor(fill) : "none");
  const stroke = attrOf(node, "stroke", cells);
  if (paints(stroke)) {
    path.setAttribute("stroke", cssColor(stroke));
    path.setAttribute("stroke-width", String(num(attrOf(node, "strokeW", cells)) ?? 1));
    path.setAttribute("vector-effect", "non-scaling-stroke");
    const cap = attrText(attrOf(node, "cap", cells));
    if (cap) path.setAttribute("stroke-linecap", cap);
    else path.removeAttribute("stroke-linecap");
    path.setAttribute("stroke-linejoin", "round");
  } else {
    path.removeAttribute("stroke");
    path.removeAttribute("stroke-width");
    path.removeAttribute("vector-effect");
    path.removeAttribute("stroke-linecap");
    path.removeAttribute("stroke-linejoin");
  }
}

/* WHO TAKES THE POINTER, patched rather than rebuilt: the elements and their listeners
 * persist across a mode flip now, so the regime is a property like any other and the
 * gesture handlers gate on the mode at event time (gestures.ts).
 *
 * OUTSIDE EDIT MODE THE POINTER OPERATES THE MACHINE. An instance takes it only where a
 * gesture would RUN something (INERT PASS-THROUGH: an instance with no event-triggered flow
 * and no live default is a picture, and a picture must never swallow the press aimed at
 * what it overlays); a bare page node never takes it at all. pointer-events inherits, so
 * the instance root's answer covers its internals — and the gesture the component put on
 * a node (the pill, the track, the dial) arms on that very node, so the pressable area is
 * the painted control, hit-tested by the browser.
 *
 * FAIL-SAFE, and only in a mode that operates: a disabled control is dimmed everywhere,
 * and inert only where a pointer would be operating it. In EDIT mode it still takes the
 * pointer, because a control you cannot operate is not a control you cannot select. */
function regime(el: HTMLElement, node: ViewNode, editor: Editor, cells: ViewHost): void {
  const enabled = attrOf(node, "enabled", cells);
  const disabled = enabled !== undefined && !truthy(enabled);
  el.classList.toggle("disabled", disabled);
  if (editor.view.mode === "edit") el.style.pointerEvents = "";
  else if (disabled) el.style.pointerEvents = "none";
  /* A BOX THAT SCROLLS HAS SOMETHING TO DO WITH THE POINTER, which is the whole test every
     other line here applies: the wheel and a touch drag are aimed at the element the browser
     hit-tested, so an inert box would hand its own scroll to whatever is behind it. This
     wins over inert pass-through AND over an enclosing instance's answer — pointer-events
     is inherited, and a child may take back what its parent gave up, so a scrolling node
     inside a picture-only widget still scrolls. */
  else if (scrollOf(node, cells)) el.style.pointerEvents = "auto";
  else if (node.instance)
    el.style.pointerEvents =
      operable(editor.store.instance(node.id), node.type) ? "auto" : "none";
  /* a PAGE ELEMENT that carries its own gesture takes the pointer on the same terms an
     instance does: something has to run, or it stays inert and presses pass through */
  else if (!node.owner && node.id && node.interact)
    el.style.pointerEvents =
      operable(editor.store.nodeAt(node.id), null) ? "auto" : "none";
  else if (!node.owner) el.style.pointerEvents = "none";
  else el.style.pointerEvents = "";
}

/* ---- the elements: created once, never again ---- */

/* what kind of element a node needs. A key whose node changed kind cannot reuse the
   element standing under it: a text applier on a path's svg scaffolding is a wrong
   picture, so the bind is dropped and rebuilt. */
function shapeOf(node: ViewNode): string {
  return node.kind + (node.instance ? "!" : "");
}

function createElement(node: ViewNode): { el: HTMLElement; path: SVGPathElement | null } {
  if (node.kind === "path") {
    const el = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 1 1");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.display = "block";
    svg.style.overflow = "visible";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path") as
      SVGPathElement;
    svg.appendChild(path);
    el.appendChild(svg);
    return { el, path };
  }
  const el = document.createElement("div");
  if (node.kind === "text") el.className = "ink-text";
  else if (node.kind === "icon") el.className = "ink-icon";
  /* `.frame` MEANS "CAN HOLD A CHILD", and an instance cannot: what is inside it belongs
     to the component it names. The class is what every container search reads — the drop's
     candidate hunt — so an instance wearing it would let a drop aim into a component's
     internals. It is a leaf here, which is exactly what it is to this page.
     NEVER ASSIGNED AGAIN: previewArrangement parks `carrying`/`drop-target` on these
     elements and positionRings toggles `gridded`, so everything after this is classList. */
  else if (node.kind === "frame") el.className = node.instance ? "leaf" : "frame";
  return { el, path: null };
}

/* ---- the dependency index ---- */

function indexInto(map: Map<string, Set<Bind>>, keys: Set<string>, bind: Bind): void {
  for (const key of keys) {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(bind);
  }
}

function unindex(map: Map<string, Set<Bind>>, keys: Set<string>, bind: Bind): void {
  for (const key of keys) {
    const set = map.get(key);
    if (!set) continue;
    set.delete(bind);
    if (!set.size) map.delete(key);
  }
}

/* ---- running one bind ---- */

function runAppliers(state: StageState, editor: Editor, bind: Bind): void {
  bind.pass = state.pass;
  unindex(state.byDep, bind.deps, bind);
  const deps = new Set<string>();
  const outer = state.recording;
  state.recording = { deps };
  try {
    const node = bind.node;
    const cells = cellsFor(state, editor, node, bind.repeat);
    /* the artboard is placed by the camera and takes the pointer for the whole pane:
       what it wears of a node is the dressing, and nothing else. PLACE FIRST: the
       shadow's un-turn may sample this very pass's transform (turnOf), so the transform
       is written before anything reads it. */
    if (bind.key !== ROOT_KEY) place(bind.el, node, cells);
    /* read ONCE per pass and handed to whichever mechanism draws it: the reading is the
       same on every kind (that is the point), only the casting differs */
    const shadow = shadowOf(state, editor, bind, node, cells);
    /* what the turn ticker re-runs while a rotation animates: exactly the shadowed */
    if (shadow) state.shadowed.add(bind);
    else state.shadowed.delete(bind);
    if (bind.key === ROOT_KEY) {
      dress(bind.el, node, cells, shadow);
    } else {
      if (node.kind === "frame") dress(bind.el, node, cells, shadow);
      else {
        if (node.kind === "text") applyText(bind.el, node, cells);
        else if (node.kind === "icon") applyIcon(bind, node, cells);
        else if (node.kind === "path" && bind.path) applyPath(bind.path, node, cells);
        inkShadow(state, bind, shadow);
      }
      regime(bind.el, node, editor, cells);
    }
    /* THE ATTR TRANSITIONS, metadata -> the element's native `transition`. TOTAL like
       every applier: a node whose transitions left carries none. */
    const trans = transitionCss(state, node, !!shadow?.inset, cells);
    bind.el.style.transition = trans.el;
    if (bind.path) bind.path.style.transition = trans.path;
  } finally {
    state.recording = outer;
  }
  bind.deps = deps;
  indexInto(state.byDep, deps, bind);
}

/* THE SEAT A GESTURE RIDES, read THROUGH the bind. Every node carrying an interact is
 * armed ONCE, at creation, and the listener outlives every reconcile — so it must never
 * close over the view node it was armed with (that one goes stale the moment the document
 * moves). `cells` is built fresh per read, which also means the read happens with nothing
 * recording, exactly as a gesture-time read should.
 *
 * DELIBERATE SCOPE CUT: which of the four primitives is armed is decided here, once. A
 * recompile that changes a node's PRIMITIVE takes effect at the next fresh build (a page
 * switch or stepping into the component), not at the reconcile that delivered it. */
function armSeat(state: StageState, editor: Editor, bind: Bind): void {
  const armed = bind.node.interact;
  /* ONCE PER ELEMENT: the listener outlives every reconcile, so arming again would
     double every gesture it reports */
  if (!armed || !bind.node.channel || bind.armed) return;
  bind.armed = true;
  armInteract(bind.el, {
    editor,
    get owner() { return bind.node.channel; },
    /* the node's OWN dotted name chain is the element identity the backend's channels use */
    get element() { return bind.node.element; },
    /* LIVE, like everything else on this seat: `bind.repeat` is rewritten by every
       reconcile, and the listener was armed once and outlives all of them */
    get repeat() { return bind.repeat; },
    get type() { return bind.node.type; },
    get interact() { return bind.node.interact ?? armed; },
    cells: (cell: string) => cellsFor(state, editor, bind.node, bind.repeat)(cell),
    setState: gestureStateWriter(state, editor, bind),
  });
}

/* ---- the keyed reconcile: the ONE structural algorithm ----
 *
 * Used by the fresh build (against an empty registry), by a document reconcile (from the
 * root, the whole tree), and — scoped to one parent — by a `show` that flipped, a `repeat`
 * whose count moved, and a gesture's state write. Every element whose key survives is
 * reused where it stands. */

function childKey(parentKey: string, node: ViewNode, at: number): string {
  return node.id ? "n" + node.id : parentKey + "/" + at;
}

function insertAt(parentEl: HTMLElement, el: HTMLElement, at: number): void {
  const before = (parentEl.children[at] ?? null) as Element | null;
  if (before === el) return;
  parentEl.insertBefore(el, before);
}

function dropBind(state: StageState, key: string): void {
  const bind = state.binds.get(key);
  if (!bind) return;
  state.binds.delete(key);
  for (const kid of bind.kidKeys) sweepBind(state, kid);
  bind.kidKeys = [];
  bind.el.remove();
  dropFilter(state, bind);
  unindex(state.byDep, bind.deps, bind);
  unindex(state.byKid, bind.kidDeps, bind);
  state.shadowed.delete(bind);
}

/* a key its parent no longer wants. It stays only if ANOTHER parent claimed it this pass
   — a node that moved between frames keeps its element, and the old parent must not take
   the new parent's child away with it. */
function sweepBind(state: StageState, key: string): void {
  const bind = state.binds.get(key);
  if (!bind || bind.pass === state.pass) return;
  dropBind(state, key);
}

interface Desired {
  key: string;
  node: ViewNode;
  repeat: RepeatCopy | null;
}

/* is this copy emitted at all? `show` false hides the node AND everything under it, and
   it is not emitted — the honest reading of "not shown". It is the PARENT's question,
   because what it decides is which children exist. */
function visible(state: StageState, editor: Editor, node: ViewNode,
                 repeat: RepeatCopy | null): boolean {
  if (!node.attrs?.show) return true;
  const show = attrOf(node, "show", cellsFor(state, editor, node, repeat));
  return show === undefined || truthy(show);
}

function reconcileChildren(state: StageState, editor: Editor, parent: Bind,
                           children: ViewNode[],
                           outer: RepeatCopy | null): void {
  /* WHAT THE CHILD LIST READS is recorded against the parent: a `repeat` count or a
     `show` fed by a live cell reconciles this one parent when it moves, and nothing else
     on the page hears about it. STRUCTURAL: which elements exist is decided over TRUE
     values — a sweeping value must never flicker a node in and out mid-flight. */
  const deps = new Set<string>();
  const held = state.recording;
  state.recording = { deps, structural: true };
  const want: Desired[] = [];
  try {
    children.forEach((child, at) => {
      const base = childKey(parent.key, child, at);
      /* `repeat` N copies of one node, each seeing which copy it is and placing itself,
         which is how a scale's ticks and an option ring are authored — one node, N
         answers. The count is evaluated in the OUTER copy's context, exactly as it was
         when this was a build. */
      const declared = child.attrs?.repeat
        ? num(attrOf(child, "repeat", cellsFor(state, editor, child, outer)))
        : null;
      if (declared === null) {
        if (visible(state, editor, child, outer))
          want.push({ key: base, node: child, repeat: outer });
        return;
      }
      const count = Math.max(0, Math.min(REPEAT_CAP, Math.round(declared)));
      for (let index = 0; index < count; index++) {
        const repeat = { index, count };
        if (visible(state, editor, child, repeat))
          want.push({ key: base + "@" + index, node: child, repeat });
      }
    });
  } finally {
    state.recording = held;
  }
  unindex(state.byKid, parent.kidDeps, parent);
  parent.kidDeps = deps;
  indexInto(state.byKid, deps, parent);

  const parentEl = parent.el;
  const kept = new Set<string>();
  want.forEach((entry, at) => {
    let bind = state.binds.get(entry.key) ?? null;
    if (bind && bind.shape !== shapeOf(entry.node)) {
      dropBind(state, entry.key);
      bind = null;
    }
    if (bind) {
      /* THE VIEW NODES ARE REBUILT EVERY PASS: a held one is last version's document */
      bind.node = entry.node;
      /* and so is the parent, for a key that was ADOPTED: whoever placed it this pass is
         whose rotation its shadow now stands under */
      bind.parent = parent;
      bind.repeat = entry.repeat;
      insertAt(parentEl, bind.el, at);
      runAppliers(state, editor, bind);
      /* AN ELEMENT THAT GAINS A GESTURE ARMS AT ONCE. The scope cut below is about
         SWAPPING one primitive for another mid-life; going from nothing to something is
         not that, and making it wait for a fresh build would mean "give this element a
         gesture" quietly did nothing until the page was switched. The node is inserted
         and its compiled interact arrives on the snapshot that follows, which is a
         reconcile — exactly this path. */
      armSeat(state, editor, bind);
      if (entry.node.kind === "frame")
        reconcileChildren(state, editor, bind, entry.node.children, entry.repeat);
    } else {
      bind = createBind(state, entry, parent);
      runAppliers(state, editor, bind);
      if (entry.node.kind === "frame")
        reconcileChildren(state, editor, bind, entry.node.children, entry.repeat);
      insertAt(parentEl, bind.el, at);
      armSeat(state, editor, bind);
    }
    kept.add(entry.key);
  });
  for (const key of parent.kidKeys) if (!kept.has(key)) sweepBind(state, key);
  parent.kidKeys = want.map((entry) => entry.key);
}

function createBind(state: StageState, entry: Desired, parent: Bind | null): Bind {
  const made = createElement(entry.node);
  if (entry.node.id) made.el.setAttribute("data-id", String(entry.node.id));
  const bind: Bind = {
    key: entry.key, el: made.el, node: entry.node, parent, repeat: entry.repeat,
    deps: new Set(), kidDeps: new Set(), kidKeys: [], path: made.path, iconSig: "",
    shadowId: "", shape: shapeOf(entry.node), pass: 0, armed: false,
  };
  state.binds.set(entry.key, bind);
  return bind;
}

/* the artboard's own properties: its size and its dressing (its tokens are not
   properties of anything: the view resolves each read to a colour) */
function dressPage(state: StageState, editor: Editor, root: Bind): void {
  root.el.style.width = state.art.w + "px";
  root.el.style.height = state.art.h + "px";
  runAppliers(state, editor, root);
}

/* ---- the three passes ---- */

function forget(state: StageState): void {
  state.binds.clear();
  state.byDep.clear();
  state.byKid.clear();
  state.marks.clear();
  /* a fresh picture starts AT its values: no sweep bridges a page switch */
  state.tweens.clear();
  state.shadowed.clear();
  state.turning.clear();
  state.root = null;
  /* every bind is gone, so every filter one of them referenced is too */
  state.defs?.remove();
  state.defs = null;
}

/* FIRST PAINT, a page switch, a step into or out of a component: every key changes, so
   nothing is worth keeping and the camera re-fits over the new picture anyway */
function buildFresh(host: HTMLElement, editor: Editor, page: Page | null): void {
  const state = stateOf(host);
  forget(state);
  state.page?.remove();
  const el = document.createElement("div");
  el.className = "page";
  state.page = el;
  const root: Bind = {
    key: ROOT_KEY, el, node: rootView(editor, page), parent: null, repeat: null,
    deps: new Set(), kidDeps: new Set(), kidKeys: [], path: null, iconSig: "",
    shadowId: "", shape: "root", pass: 0, armed: false,
  };
  state.binds.set(ROOT_KEY, root);
  state.root = root;
  dressPage(state, editor, root);
  reconcileChildren(state, editor, root, root.node.children, null);
  /* the rings are children of the host too, and the page must sit under them */
  host.insertBefore(el, host.firstChild);
}

/* THE DOCUMENT MOVED (or the mode, or the artboard's size, or the compile epoch — which
   is the one that catches an edit changing what a field EVALUATES to rather than what the
   tree holds). Every node is re-keyed and every element whose key survives is reused. */
function reconcile(host: HTMLElement, editor: Editor, page: Page | null): void {
  const state = stateOf(host);
  const root = state.root!;
  root.node = rootView(editor, page);
  dressPage(state, editor, root);
  reconcileChildren(state, editor, root, root.node.children, null);
}

/* A LIVE FRAME. Nothing structural happens here unless a `show` or a `repeat` count moved,
   and then only under the one parent that read it. */
function livePatch(host: HTMLElement, editor: Editor): boolean {
  const state = stateOf(host);
  const moved = new Map<string, string>();
  const look = (key: string) => {
    /* a state cell is WRITER-DRIVEN (gestureStateWriter patches it the moment it lands)
       and a time cell is TICKER-DRIVEN (stepTime's own frame loop): neither is the
       wire's to move */
    if (moved.has(key) || key.startsWith("state:") || key.startsWith("time:")) return;
    const now = markNow(editor, key);
    if (now !== state.marks.get(key)) moved.set(key, now);
  };
  for (const key of state.byDep.keys()) look(key);
  for (const key of state.byKid.keys()) look(key);
  if (!moved.size) return false;

  /* the marks move FIRST: a cell whose readers all leave the tree in this same pass must
     not be reported as moved forever after */
  const parents = new Set<Bind>();
  const binds = new Set<Bind>();
  for (const [key, mark] of moved) {
    state.marks.set(key, mark);
    for (const parent of state.byKid.get(key) ?? []) parents.add(parent);
    for (const bind of state.byDep.get(key) ?? []) binds.add(bind);
  }
  /* STRUCTURE FIRST, and only where it was read. The parent's own view nodes are
     fresh enough: a live frame never changes the document, so the children it holds are
     the ones the last reconcile built. */
  for (const parent of parents)
    if (state.binds.get(parent.key) === parent)
      reconcileChildren(state, editor, parent, parent.node.children, parent.repeat);
  for (const bind of binds)
    if (state.binds.get(bind.key) === bind && bind.pass !== state.pass)
      runAppliers(state, editor, bind);
  return true;
}

/* A GESTURE'S STATE WRITE. Not a live cell and not a document edit: one key, patched into
   exactly what binds it, and nothing at all where nothing does. */
function flushCell(host: HTMLElement, editor: Editor, key: string): void {
  const state = stateOf(host);
  const parents = Array.from(state.byKid.get(key) ?? []);
  const binds = Array.from(state.byDep.get(key) ?? []);
  if (!parents.length && !binds.length) return;
  state.now = clock();
  state.pass++;
  for (const parent of parents)
    if (state.binds.get(parent.key) === parent)
      reconcileChildren(state, editor, parent, parent.node.children, parent.repeat);
  for (const bind of binds)
    if (state.binds.get(bind.key) === bind && bind.pass !== state.pass)
      runAppliers(state, editor, bind);
  repaintFree();
  positionRings(host, editor);
  scheduleTweens(state);
  scheduleTime(host, editor);
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
 * calls, since the inline styles it painted are exactly what a plain render would keep.
 * A RECONCILE, not a fresh build: what is wanted is the document's own numbers re-asserted
 * onto the very elements the gesture was holding. */
function repaintDocument(host: HTMLElement, editor: Editor): void {
  stateOf(host).docSig = "";
  renderStage(host, editor);
}

/* ---- the one entry point ---- */

export function renderStage(host: HTMLElement, editor: Editor): void {
  const state = stateOf(host);
  wire(host, editor);
  armTheme(state, editor);

  const ctx = editor.contexts[editor.contexts.length - 1] ?? null;
  const page = editor.page();
  if (!page && !ctx) {
    state.page?.remove();
    state.page = null;
    forget(state);
    state.docSig = "";
    positionRings(host, editor);
    return;
  }

  /* the picture's own size, and the chain it is of: a step in or out of a component builds
     fresh and refits the camera; a preview RESIZE deliberately does neither (the artboard
     grows under the author's pointer, and yanking the camera mid-drag would fight them) */
  state.art = ctx ? { w: ctx.w, h: ctx.h } : { w: CANVAS_W, h: CANVAS_H };
  const ctxPath = (page ? page.id : 0) + "|" +
    editor.contexts.map((c) => (c.component ? "c" + c.component : "b" + c.builtin) +
                               ":" + c.from).join("/");
  let fresh = !state.page || !state.root;
  if (state.ctxPath !== ctxPath) {
    state.ctxPath = ctxPath;
    state.cam.manual = false;
    fresh = true;
  }
  state.flushState = (key: string) => flushCell(host, editor, key);
  state.tick = () => stepTransitions(host, editor);

  /* WHAT A RECONCILE IS OF: the MODE (edit and test wear different pointer regimes), the
     artboard's size, the document version — and the COMPILE EPOCH, which catches an edit
     changing what a field evaluates to rather than what the tree holds. A node's attrs are
     programs; editing one leaves the tree identical and the version moved, and the new
     programs arrive in the snapshot that follows. Without the epoch here a resize would
     commit its number and then redraw the old one. (The context path is not in it: a step
     in or out is a FRESH build, above.) */
  const docSig = editor.view.mode + ":" + state.art.w + "x" + state.art.h + ":" +
    editor.store.version() + ":" + (editor.live?.epoch ?? 0);
  state.now = clock();
  state.pass++;

  if (fresh || docSig !== state.docSig) {
    if (fresh) buildFresh(host, editor, page);
    else reconcile(host, editor, page);
    state.docSig = docSig;
    if (!state.cam.manual) fitCamera(host, state, editor);
    applyCamera(state);
    /* A PASS MUST NOT TAKE A GESTURE WITH IT. What a live frame moved is a value, not an
       arrangement, and the box in your hand is holding numbers that are deliberately not
       in the document until you let go — so the gesture puts them back over whatever the
       appliers just asserted (manipulate.ts owns them; this only says when). */
    repaintFree();
  } else if (livePatch(host, editor)) {
    repaintFree();
  }
  positionRings(host, editor);
  /* a pass may have set sweeps in flight: keep them advancing until they settle */
  scheduleTweens(state);
  /* and it may have bound time cells: the clock ticker runs while any are read */
  scheduleTime(host, editor);
}

/* the node the browser's own hit test named: the deepest one under the pointer, 0 where
 * the event landed on the page background. Only PAGE nodes carry an id, so a component's
 * internals answer with the instance that holds them — which is what you select. */
function idUnder(target: EventTarget | null): number {
  const at = (target as HTMLElement | null)?.closest?.("[data-id]") as HTMLElement | null;
  return at ? Number(at.getAttribute("data-id")) : 0;
}

/* IS THIS WHEEL A SCROLL BOX'S RATHER THAN THE CAMERA'S? The boxes `scroll` opened are
 * marked `data-scroll` with their axes (the scrollbar applier), so this asks the elements
 * between the pointer and the pane, deepest first — no getComputedStyle anywhere: the
 * answer is ours and it is written down.
 *
 * ONLY WHILE IT CAN STILL MOVE that way. At the end of a list the wheel goes back to the
 * camera, which is what a nested scroller does everywhere else (the browser calls it
 * chaining; here the outer scroller is a camera, so it has to be asked in JS). A box that
 * scrolls ONLY sideways takes a plain vertical wheel too — a mouse with one wheel must be
 * able to reach a horizontal list, and that is the mapping the browser itself makes. */
function wheelScrolls(host: HTMLElement, ev: WheelEvent): boolean {
  /* a fractional scrollHeight (a scaled box, a sub-pixel row) must not read as room */
  const SLACK = 1;
  for (let el = ev.target as HTMLElement | null; el && el !== host; el = el.parentElement) {
    const axes = el.getAttribute?.("data-scroll");
    if (!axes) continue;
    const scrollsY = axes === "y" || axes === "both";
    const scrollsX = axes === "x" || axes === "both";
    if (scrollsY && ev.deltaY &&
        (ev.deltaY > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - SLACK
                       : el.scrollTop > 0))
      return true;
    const across = scrollsX ? (ev.deltaX || (scrollsY ? 0 : ev.deltaY)) : 0;
    if (across &&
        (across > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - SLACK
                    : el.scrollLeft > 0))
      return true;
  }
  return false;
}

/* Listeners are attached once per host. A click SELECTS whatever the hit test named — an
 * instance from its own pixels, a frame from ITS own pixels (its padding, the gap between
 * its children, its empty room). No kind is special-cased: the hover ring has already
 * announced exactly which node those pixels belong to, so the click confirms what is shown
 * rather than guessing what was meant. Clicking the page background clears.
 *
 * SELECTION RIDES THE POINTER PAIR, NOT THE NATIVE CLICK. The elements stand still under a
 * live frame now, so a press no longer loses its element mid-gesture — but the pair is
 * still the honest reading: the id is taken at the press (the node the user aimed at) and
 * the release only asks "did it stay a click" (slop), holding no element in between, which
 * is the same discipline the drags and the tree's own double-click already follow. */
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
    /* ENTER A COMPONENT: two clicks on one instance within the tree rows' own window */
    const again = held.id !== 0 && held.id === last.id && ev.timeStamp - last.at < 450 &&
                  Math.abs(ev.clientX - last.x) < 6 && Math.abs(ev.clientY - last.y) < 6;
    last = again ? { id: 0, x: 0, y: 0, at: 0 }
                 : { id: held.id, x: ev.clientX, y: ev.clientY, at: ev.timeStamp };
    if (again && editor.store.instance(held.id)) {
      editor.enterComponent(held.id);
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
  /* THE TURNING WATCH: while any element's `transform` transition is in flight the
     browser owns the intermediate rotations, so the shadow un-turn samples matrices
     per frame (turnOf) — these delegated listeners are what tell it when. The END of a
     turn runs the shadows once more over the authored values, so they land on the
     exact endpoint rather than the last sampled frame. */
  const onTurn = (ev: Event) => {
    const turn = ev as TransitionEvent;
    if (turn.propertyName !== "transform") return;
    const target = ev.target as Element | null;
    if (!target) return;
    const state2 = stateOf(host);
    if (ev.type === "transitionstart") {
      state2.turning.add(target);
      scheduleTurn(host, editor);
    } else if (state2.turning.delete(target) && !state2.turning.size) {
      repaintShadows(host, editor);
    }
  };
  host.addEventListener("transitionstart", onTurn);
  host.addEventListener("transitionend", onTurn);
  host.addEventListener("transitioncancel", onTurn);

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
    /* A SCROLL BOX UNDER THE POINTER TAKES THE WHEEL FIRST, wherever the page operates:
       the thing under the pointer scrolling is what a wheel means everywhere else, and
       cancelling the default here is what would stop it. In EDIT mode the wheel stays the
       camera's — scrolling is an interaction, and interactions belong to the modes that
       operate (gestures.ts draws that same line on the four primitives). */
    if (editor.view.mode !== "edit" && wheelScrolls(host, ev)) return;
    ev.preventDefault();
    /* the deployed view has no camera to take: the page IS the screen (fitCamera fills
       it), and a stray wheel or pinch must not shove it off — the default stays
       cancelled above, or ctrl+wheel would zoom the browser instead */
    if (editor.view.mode === "operate") return;
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
    if (ev.button !== 1 || editor.view.mode === "operate") return;
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
        fitCamera(host, state2, editor);
        applyCamera(state2);
      }
      positionRings(host, editor);
    }).observe(host);
}

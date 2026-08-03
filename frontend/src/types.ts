/* The wire vocabulary, mirrored from the backend. Nothing here holds behaviour: these
 * are the shapes of frames, document nodes and registry rows that the backend serves. */

export type Json = any;

export const PROTO = 9;

/* THE ARTBOARD: one static px space, 16:9, with one static grid — a system constant,
 * not document data. Every page-node x/y/w/h is a px of this space; the stage scales the
 * whole picture into the pane and pan/zoom navigate it. 1408 x 792 is 128 x 72 cells of
 * 11px — twice the old designer's 22px resolution, so its coarser placements all still
 * sit on the lines. */
export const CANVAS_W = 1408;
export const CANVAS_H = 792;
export const CELL = 11;

/* ---- the reflected mesh (the "dart" root of the source picker tree) ---- */

export interface MeshField {
  path: string;
  shape: string;
  elem?: string; /* aggregate fields: the element shape (a map's value shape) */
  variants?: { name: string; value: number }[];
}

export interface MeshEntity {
  kind: "V" | "T" | "F" | "S";
  name: string;
  /* the schema's ROOT type name, "" where the schema names none. DART names only the
     root, so this is the whole of what an entity says about its type. */
  type: string;
  writable: boolean;
  forceable: boolean;
  fields: MeshField[];
  returns?: MeshField[]; /* functions: the response fields a feed reads */
}

/* One entry of the served type table: one per SCHEMA, not per entity, so a type shared
 * by ten valves is offered once. `entities` are the ones carrying it, which is how an
 * unfamiliar type name is identified in the picker. An empty name is an unnamed root:
 * listed, marked, and not pickable by name. */
export interface MeshType {
  name: string;
  fields: MeshField[];
  entities: { kind: string; name: string }[];
}

export interface Mesh {
  entities: MeshEntity[];
  types: MeshType[];
}

/* ---- the expression language, as served tables ---- */

export interface LangEntry {
  name: string;
  args: string[];      /* shape names; "any" = unchecked; entries past min_args optional */
  min_args: number;
  result: string;      /* result shape; "elem" = the receiver's element shape */
  tier: "display" | "both";
  /* does the VIEW (a template attribute) have an encoding for this row at all -- a
     different question from `tier`, which is about the two SCALAR positions (feed vs.
     flow). An attribute field's autocomplete must offer exactly the rows where this is
     true; offering one where it is false and then refusing it at compile is the bug
     this field exists to close. */
  view: boolean;
  receiver?: string;   /* method rows only */
  property?: boolean;  /* method rows: reads bare (x.length) vs called (x.trim()) */
}

export interface Lang {
  builtins: LangEntry[];
  methods: LangEntry[];
}

/* ---- the closed attr vocabulary, as a served table ----
 *
 * The DECLARATION of every attr name a node's `attrs` may carry, mirrored from
 * backend/src/registry/attrs.h — that header is the source of truth and carries the full
 * reasoning, including which half of the table applies (arrangement vs measurement) and
 * what each attr lands as in CSS or SVG. Snapshot-only, like `builtins`: it never changes
 * at runtime. */
export interface AttrDef {
  name: string;
  shape: "num" | "bool" | "text" | "color" | "series" | "any";
  /* absent = no computed default: the attr is structural (show, repeat, clip, x, y, w, h,
     rotate, a colour that is simply not painted) and `note` explains what absence means */
  default?: Json;
  note: string;
}

export interface AttrTable {
  /* the four node kinds: frame, text, icon, path */
  kinds: string[];
  /* honoured on every kind */
  common: AttrDef[];
  /* one kind's own attrs, on top of the common set */
  perKind: Record<string, AttrDef[]>;
}

/* ---- document ---- */

export interface Var {
  id: number;
  name: string;
  /* "f64" | "bool" | "str" | "timer", or any TypeRef from the mesh */
  type: string;
  init: Json;
  persist: boolean;
}

/* a theme token: a named color role with one value per theme mode; a
   color slot value "$<name>" resolves through it in the view's own mode */
export interface Token {
  id: number;
  name: string;
  group: string;
  light: string;
  dark: string;
}

export interface Feed {
  id: number;
  slot: string;
  src: { kind: string; name: string };
  path: string;
  /* with `cases`, the ELSE arm; alone, the whole transform */
  xf: string;
  /* conditional arms over x: first match wins, any boolean condition */
  cases?: { test?: string; xf: string }[];
  poll_hz: number | null;
  stale_ms: number | null;
}

export interface Flow {
  id: number;
  when: Json[];
  when_mode: "first" | "any";
  do: Json[];
}

/* ---- THE NODE: one kind, four variants, one field model ----
 *
 * A page's frames, a component's internals and a widget instance are the same thing.
 * `kind` says what a node draws; everything a node LOOKS like is expression text in
 * `attrs`, checked against the served vocabulary (AttrTable) and compiled to view
 * programs by the backend. Only what is structural stays a field of its own: `kind`,
 * `name`, and a path's anchors.
 *
 * A FRAME IS A BOX and a box is all a frame is: it can hold children (grouping), it can
 * wear a surface (a pane), and sibling ORDER is z-order. There is no layout mode — the
 * arrangement vocabulary was deliberately removed; everything sits at its own x/y.
 *
 * A FRAME WITH A `type` IS AN INSTANCE: it names a component, that component's children
 * are its subtree (hidden here, entered to edit), and `slots`/`feeds`/`flows`/`locals`
 * are how this one placement is wired. */
export type NodeKind = "frame" | "text" | "icon" | "path";

/* one anchor of a path, in the DOCUMENT form: every coordinate is expression text, and
   `arc` (an elliptical segment ending at this anchor) is a row of the same */
export interface Anchor {
  x?: string;
  y?: string;
  arc?: Record<string, string>;
}

export interface Node {
  id: number;
  kind: NodeKind;
  /* the label the tree shows — and, where something under it declares a property, the
     segment that property's address is built from */
  name: string;
  attrs: Record<string, string>;   /* attr -> expression text */
  props?: PropDef[];
  /* frame only */
  type?: string;                   /* "" = a plain frame; a component name = an instance */
  /* per-instance slot values, NESTED like the component's own nodes: a top-level property
     is a key here, a nested node's property a key inside an object named for that node, so
     {"bar": {"fill_color": "#fff"}} is the slot addressed "bar.fill_color" */
  slots?: Record<string, Json>;
  interact?: Json;
  children?: Node[];
  locals?: Var[];
  feeds?: Feed[];
  flows?: Flow[];
  /* path only */
  anchors?: Anchor[];
  closed?: boolean;
}

/* a PAGE: one screen, and one of the two documents-of-nodes (the other is a component).
   Not a node itself — nothing places it and nothing sizes it. */
export interface Page {
  id: number;
  name: string;
  children: Node[];
}

/* is this node an instance of a component, rather than a plain frame? */
export function isInstance(node: Node | null | undefined): boolean {
  return !!node && typeof node.type === "string" && node.type !== "";
}

/* ---- components: a frame someone already made ----
 *
 * The document form the backend compiles into the served registry: a PropDef row
 * round-trips to a SlotSpec, a node's attrs hold EXPRESSION TEXT (compiled to view
 * programs server-side), and a component with a built-in's name shadows it. The record IS
 * the root node — its `layout`, `attrs` and `interact` describe the box an instance
 * renders as — so there is no wrapper between a type and its content. */

export interface PropDef {
  id: number;
  name: string;
  shape: "num" | "bool" | "text" | "color" | "enum" | "series";
  default: Json;
  group: "value" | "appearance" | "config" | "frame";
  editor: string;
  variants: string[];
  step: number | null;
  min: number | null;
  max: number | null;
  history: boolean;
}

export interface ComponentDef {
  id: number;
  name: string;
  events: EventSpec[];
  props: PropDef[];
  /* the ROOT BOX: the same fields the frame variant carries, because the record IS
     the root node */
  attrs: Record<string, string>;
  interact?: Json;
  children: Node[];
  behavior: Flow[];
  /* the DESIGN FRAME: the component's NATURAL SIZE in canvas px — the size it is
     authored against, previewed at, and dropped onto a page at. Not a coordinate space:
     the internals place themselves in FRACTIONS of their parent, which is what lets one
     authoring fill every box an instance is given. */
  design_w: number;
  design_h: number;
}

/* A built-in component as the snapshot serves it: exactly the ComponentDef document
 * form, minus every id (nothing in the document carries it). Forking one is inserting
 * it into doc.components as-is; the backend issues ids recursively through prepare. */
export type BuiltinDef = Json;

export interface Doc {
  version: number;
  next_id: number;
  globals: Var[];
  tokens: Token[];
  components: ComponentDef[];
  pages: Page[];
}

/* ---- registry ---- */

export type Program = { code: Instr[] };
export type Instr = { op: string; v?: Json; cell?: string };

export interface SlotSpec {
  /* the slot's ADDRESS: a widget-level property is a bare name, a part's is its owning
     part's path plus the name (`bar.fill_color`). It is what a feed's `slot`, a move's
     destination, a live cell key and an instance's nesting all use. */
  name: string;
  shape: string;
  default: Json;
  group: "value" | "appearance" | "config" | "frame";
  editor?: string;
  variants?: string[]; /* enum slots carry their own picker */
  step?: number;       /* num slots: the caret step (fractions step fine, not by 1) */
  min?: number;        /* num slots: a BOUNDED slot edits as a slider beside the */
  max?: number;        /* field (the Unity treatment) and clamps typed values */
}

export interface EventSpec {
  name: string;
  x: string;
  /* where `x` comes from, when the type derives it rather than the gesture carrying it
    . The backend evaluates it; a view only reports the gesture. */
  value?: string;
}

export type Attrs = Record<string, Program>;

export interface Interact {
  primitive: "press" | "drag1d" | "drag_radial" | "pick";
  params: Attrs;
  emits: Record<string, string>;
}

/* one anchor, COMPILED: every coordinate is a program the view runs, which is what makes
   a plot's ink data and an arc's corner arithmetic */
export interface CompiledAnchor {
  x?: Program;
  y?: Program;
  arc?: Record<string, Program>;
}

/* The served template: the SAME four kinds the document holds, with every attr compiled.
   `name` is unique among siblings, and the names joined with "." from the root are the
   node's address. A frame is the only kind that holds children or a gesture. */
export interface TemplateNode {
  kind: NodeKind;
  name?: string;
  attrs: Attrs;
  children?: TemplateNode[];
  interact?: Interact;
  anchors?: CompiledAnchor[];
  closed?: boolean;
}

/* one PAGE node's compiled fields, keyed by node id in the snapshot's `node_attrs`: the
   document says what the tree is, this says what each node's fields evaluate to, and the
   renderer needs both. A page node and a template node meet here — same programs, same
   interpreter, one renderer. */
export interface NodeAttrs {
  attrs: Attrs;
  anchors?: CompiledAnchor[];
}

export interface WidgetType {
  name: string;
  slots: SlotSpec[];
  events: EventSpec[];
  template: TemplateNode;
  /* the design frame, served with the type: the natural size an instance is dropped at */
  design_w: number;
  design_h: number;
  /* the type's default flows: ordinary flow rows the backend compiles per instance and
     drops where a feed or an authored flow already writes the slot. The view never runs
     them, it only shows them, so this is document-shaped data like everything else. */
  behavior?: Flow[];
}

export interface Registry {
  version: number;
  types: WidgetType[];
}

/* ---- document ops ---- */

/* A MOVE is a reorder where it stands, or — with `parent` — a reparent into that node's
   `children`. A request may leave both out; an ECHO always carries the whole resolved
   placement, so the mirror splices out of one list and into another by one rule.
   A GROUP never reaches the mirror: it is a request only, and comes back as the insert
   and moves the backend performed (its box's id is the backend's to issue). The box's
   geometry rides the request as ordinary attr text, computed by the client — it is the
   one that knows where the children render. */
export type Op =
  | { op: "set_prop"; node: number; key: string; value: Json }
  | { op: "insert"; parent: number; list: string; index?: number; node: Json }
  | { op: "remove"; node: number }
  | { op: "move"; node: number; index: number; parent?: number; list?: string }
  | { op: "group"; nodes: number[]; attrs?: Record<string, string> }
  | { op: "rename"; node: number; name: string };

/* ---- live state ---- */

export interface Live {
  epoch: number;
  values: Record<string, Json>;
  /* trend history deltas, keyed "<widget>.<slot>". The backend still computes and sends
     them; no view accumulates them at present — the standing views and the plot that read
     them both went with the SVG renderer, and the rebuild folds them again for whatever
     draws a trend next. Declared here because the frame carries the field. */
  hist?: Record<string, Json>;
}

/* ---- diagnostics ---- */

/* One compile finding, addressed to the document node it is about. `node` may
 * be any node, so a view maps it to the widget that owns it before marking the canvas.
 * `where` narrows it to a field within that node (a slot name, "init") so the sidebars can
 * pin it on the exact row; empty when the node itself is the line. */
export interface Diag {
  node: number;
  grade: "error" | "warning" | "info";
  code: string;
  message: string;
  where?: string;
}

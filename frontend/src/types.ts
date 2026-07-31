/* The wire vocabulary, mirrored from the backend. Nothing here holds behaviour: these
 * are the shapes of frames, document nodes and registry rows that the backend serves. */

export type Json = any;

export const PROTO = 6;

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
     root (spec 2.2), so this is the whole of what an entity says about its type. */
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

/* ---- the expression language, as served tables (spec 3.7) ---- */

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
     this field exists to close (spec 3.7). */
  view: boolean;
  receiver?: string;   /* method rows only */
  property?: boolean;  /* method rows: reads bare (x.length) vs called (x.trim()) */
}

export interface Lang {
  builtins: LangEntry[];
  methods: LangEntry[];
}

/* ---- the closed attr vocabulary, as a served table (spec 2.3) ----
 *
 * The DECLARATION of every attr name a template node's `attrs` may carry, mirrored from
 * backend/src/registry/attrs.h — that header is the source of truth and carries the full
 * reasoning, including why it currently describes an intent rather than a renderer. Snapshot-
 * only, like `builtins`: it never changes at runtime. `perKind.code` is always empty —
 * `code` is the one open kind, its attrs read by whatever names the author's own JS
 * body chose, so it keeps the free-form attrs UI instead of this table. */
export interface AttrDef {
  name: string;
  shape: "num" | "bool" | "text" | "color" | "series";
  /* absent = no computed default: the attr is structural (show, repeat, clip, zoom,
     rotate, at, fit) and `note` explains what absence means instead */
  default?: Json;
  note: string;
}

export interface AttrTable {
  /* the single declared list of part kinds: box, the draw kinds, and code */
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
  /* "f64" | "bool" | "str" | "timer", or any TypeRef from the mesh (spec 2.7) */
  type: string;
  init: Json;
  persist: boolean;
}

/* a theme token (spec 2.10): a named color role with one value per theme mode; a
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
  /* conditional arms over x (spec 2.4): first match wins, any boolean condition */
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

/* How the containing frame gives a child room, carried by a frame and a widget alike
   (a container is a child of its own container): `grow` is the share of the free space
   this child takes, `min` a floor in CSS pixels on the container's MAIN axis. */
export interface Place {
  grow: number;
  min: number;
}

export interface Widget extends Place {
  id: number;
  /* the discriminator a page or frame's `children` reads to tell a widget from a
     frame sitting in the same ordered list (spec 2.8); always "widget" */
  kind: "widget";
  type: string;
  label: string;
  /* per-instance slot values, NESTED like the type's parts: a widget-level slot is a
     key here, a part's slot a key inside an object named for the part, so
     {"bar": {"fill_color": "#fff"}} is the slot addressed "bar.fill_color" */
  slots: Record<string, Json>;
  locals: Var[];
  feeds: Feed[];
  flows: Flow[];
}

/* A FRAME: a page-level container grouping widgets and other frames in ONE ordered
   list. Nothing here is a coordinate — order, layout, gap, pad, align and justify are
   the whole vocabulary, and where a child lands follows from them. `surface`, `border`
   and `radius` are deliberately the same names a widget's frame group uses: one surface
   vocabulary at both tiers. A colour is a literal or a "$name" token reference. */
export interface Frame extends Place {
  id: number;
  kind: "frame";
  name: string;
  layout: "row" | "col" | "stack";
  gap: number;
  pad: number;
  align: "start" | "center" | "end" | "stretch";
  justify: "start" | "center" | "end" | "between";
  surface: string;     /* "" = no surface at all, not a transparent one */
  border: string;
  border_w: number;
  radius: number;
  children: (Frame | Widget)[];
}

export interface Page {
  id: number;
  name: string;
  children: (Frame | Widget)[];
}

/* ---- components: widget types as document data (spec 2.3) ----
 *
 * The document form the backend compiles into the served registry: a PropDef row
 * round-trips to a SlotSpec, a PartNode's attrs hold EXPRESSION TEXT (compiled to
 * view programs server-side), and a component with a built-in's name shadows it. */

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

export interface PartNode {
  id: number;
  kind: "box" | "rect" | "bar" | "text" | "icon" | "arc" | "needle" | "plot" | "path" | "code";
  name: string;
  dir?: "row" | "col" | "stack" | "auto"; /* box only */
  /* the properties this part OWNS: addressed under its path, edited only while it is
     selected, and in scope for its own attrs and its children's (spec 2.3) */
  props: PropDef[];
  attrs: Record<string, string>;          /* attr -> expression text */
  interact: { primitive: string; params: Record<string, string>;
              emits: Record<string, string> } | null;
  /* `code` kind only: the user-authored JavaScript body, never compiled as an
     expression (spec 2.3) */
  code?: string;
  children: PartNode[];
}

export interface ComponentDef {
  id: number;
  name: string;
  events: EventSpec[];
  props: PropDef[];
  parts: PartNode[]; /* the template's one root node */
  behavior: Flow[];
  /* the DESIGN FRAME: the size this component is AUTHORED at — its natural size. NOT an
     instance size: an instance takes whatever box its frame gives it. A built-in carries
     neither field, and the fallback is 240 x 120. */
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
     destination, a live cell key and an instance's nesting all use (spec 2.3). */
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
     (spec 2.3). The backend evaluates it; a view only reports the gesture. */
  value?: string;
}

export type Attrs = Record<string, Program>;

export interface Interact {
  primitive: "press" | "drag1d" | "drag_radial" | "pick";
  params: Attrs;
  emits: Record<string, string>;
}

/* `name` is unique among siblings; the names joined with "/" from the template root
   are the node's part path, its stable address (spec 2.3). Built-ins always carry
   one; the renderer tolerates its absence (the node just has no path). */
export type TemplateNode =
  | { kind: "box"; name?: string; dir: "row" | "col" | "stack" | "auto"; attrs: Attrs; children: TemplateNode[]; interact?: Interact }
  /* a draw part paints its own shape AND holds children (spec 2.3): they render into
     the SAME area, over it, inheriting its transform — stack semantics with no `dir`
     of its own, because a leaf's children are never laid out beside it, only atop it.
     `code`/`scope` ride ONLY on a `draw: "code"` node: the user-authored JS source,
     verbatim, and its part's lexical scope (bare name -> slot address) so the view can
     build `props` by bare name (spec 2.3). */
  | { kind: "part"; name?: string; draw: "rect" | "bar" | "text" | "icon" | "arc" | "needle" | "plot" | "path" | "code"; attrs: Attrs; children: TemplateNode[]; code?: string; scope?: Record<string, string> };

export interface WidgetType {
  name: string;
  slots: SlotSpec[];
  events: EventSpec[];
  template: TemplateNode;
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

export type Op =
  | { op: "set_prop"; node: number; key: string; value: Json }
  | { op: "insert"; parent: number; list: string; index?: number; node: Json }
  | { op: "remove"; node: number }
  | { op: "move"; node: number; index: number }
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

/* One compile finding, addressed to the document node it is about (spec 3.8). `node` may
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

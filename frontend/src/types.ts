/* The wire vocabulary, mirrored from the backend. Nothing here holds behaviour: these
 * are the shapes of frames, document nodes and registry rows that the backend serves. */

export type Json = any;

export const PROTO = 2;

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
  receiver?: string;   /* method rows only */
  property?: boolean;  /* method rows: reads bare (x.length) vs called (x.trim()) */
}

export interface Lang {
  builtins: LangEntry[];
  methods: LangEntry[];
}

/* ---- document ---- */

export interface Canvas {
  unit_w: number;
  unit_h: number;
  cols: number;
  rows: number;
}

export interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Var {
  id: number;
  name: string;
  /* "f64" | "bool" | "str" | "timer", or any TypeRef from the mesh (spec 2.7) */
  type: string;
  init: Json;
  persist: boolean;
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

export interface Widget {
  id: number;
  type: string;
  label: string;
  geom: Geom;
  slots: Record<string, Json>;
  locals: Var[];
  feeds: Feed[];
  flows: Flow[];
}

export interface Page {
  id: number;
  name: string;
  widgets: Widget[];
}

export interface Doc {
  version: number;
  next_id: number;
  canvas: Canvas;
  globals: Var[];
  pages: Page[];
}

/* ---- registry ---- */

export type Program = { code: Instr[] };
export type Instr = { op: string; v?: Json; cell?: string };

export interface SlotSpec {
  name: string;
  shape: string;
  default: Json;
  group: "value" | "appearance" | "config" | "frame";
  editor?: string;
  variants?: string[]; /* enum slots carry their own picker */
  step?: number;       /* num slots: the caret step (fractions step fine, not by 1) */
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

export type TemplateNode =
  | { kind: "box"; dir: "row" | "col" | "stack" | "auto"; attrs: Attrs; children: TemplateNode[]; interact?: Interact }
  | { kind: "part"; draw: "rect" | "bar" | "text" | "icon" | "arc" | "needle" | "mark" | "ticks" | "plot"; attrs: Attrs };

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
  /* trend history deltas, keyed "<widget>.<slot>" (shell.ts folds them into HistViews) */
  hist?: Record<string, Json>;
}

/* one widget slot's accumulated history, rebuilt from the wire's from/values deltas */
export interface HistView {
  rate: number;
  series: number;
  cap: number;
  total: number;                    /* absolute index one past the newest sample */
  samples: (number | null)[][];     /* oldest first; null = unknown */
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

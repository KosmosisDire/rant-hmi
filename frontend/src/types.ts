/* The wire vocabulary, mirrored from the backend. Nothing here holds behaviour: these
 * are the shapes of frames, document nodes and registry rows that the backend serves. */

export type Json = any;

export const PROTO = 1;

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
  type: "f64" | "bool" | "str" | "timer";
  init: Json;
  persist: boolean;
}

export interface Feed {
  id: number;
  slot: string;
  src: { kind: string; name: string };
  path: string;
  xf: string;
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
  group: "value" | "appearance" | "config";
  editor?: string;
  variants?: string[]; /* enum slots carry their own picker */
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
  primitive: "press" | "drag1d" | "pick";
  params: Attrs;
  emits: Record<string, string>;
}

export type TemplateNode =
  | { kind: "box"; dir: "row" | "col" | "stack" | "auto"; attrs: Attrs; children: TemplateNode[]; interact?: Interact }
  | { kind: "part"; draw: "rect" | "bar" | "text" | "icon"; attrs: Attrs };

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
}

/* ---- diagnostics ---- */

/* One compile finding, addressed to the document node it is about (spec 3.8). `node` may
 * be any node, so a view maps it to the widget that owns it before marking the canvas. */
export interface Diag {
  node: number;
  grade: "error" | "warning" | "info";
  code: string;
  message: string;
}

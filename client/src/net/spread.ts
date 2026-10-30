// What a scene draws from Rant's standard types, read in the data worker: where the GPU finds
// the points of a PointCloud, a LaserScan, a list, a Path or a Polyline in their bytes, a Mesh's
// triangles, a Grid's cells, the number a field gives each, and the colour a ramp gives that
// number. three.js stays out, so any way of drawing can read them.

import type { Column } from "./packed";

export type Numbers = Exclude<Column, Fields>;
interface Fields {
  readonly [field: string]: Column;
}

const isNumbers = (c: unknown): c is Numbers => ArrayBuffer.isView(c) && !(c instanceof DataView);
const isFields = (c: unknown): c is Fields => typeof c === "object" && c !== null && !ArrayBuffer.isView(c);

/** A pose as Rant's types give it. */
export interface PoseValue {
  position?: { x: number; y: number; z?: number };
  orientation?: { x: number; y: number; z: number; w: number };
}

/** Arrays a part keeps from one value to the next, grown as one needs and never shrunk, so a
 *  stream of voxels makes no garbage. Each holds whole items of its width. */
export class Pool {
  private kept = new Map<string, Float32Array | Uint8Array>();
  floats(key: string, items: number, width = 1): Float32Array {
    return this.get(key, items, width, Float32Array) as Float32Array;
  }
  bytes(key: string, items: number, width = 1): Uint8Array {
    return this.get(key, items, width, Uint8Array) as Uint8Array;
  }
  private get(key: string, items: number, width: number, Kind: typeof Float32Array | typeof Uint8Array) {
    const had = this.kept.get(key);
    if (had && had.length >= items * width) return had;
    const made = new Kind(Math.ceil(items * 1.25) * width);
    this.kept.set(key, made);
    return made;
  }
}

const AXES = ["x", "y", "z"];
/** The axis `field` takes the values of, or -1. */
const axisOf = (field: string | undefined) => (field ? AXES.indexOf(field) : -1);

/** How many bytes a number of each ScalarKind takes. */
export const WIDTH: Record<string, number> = { I8: 1, U8: 1, I16: 2, U16: 2, I32: 4, U32: 4, F32: 4, F64: 8, I64: 8, U64: 8 };

/** The typed arrays that read each ScalarKind in place, little endian as every browser's
 *  machine is. */
const VIEWS: Record<string, { new (buffer: ArrayBufferLike, offset: number, length: number): ArrayLike<number>; BYTES_PER_ELEMENT: number }> = {
  I8: Int8Array,
  U8: Uint8Array,
  I16: Int16Array,
  U16: Uint16Array,
  I32: Int32Array,
  U32: Uint32Array,
  F32: Float32Array,
  F64: Float64Array,
};

/** A reader of the number of `kind` at a byte of `dv`, little endian as PCL writes it. */
function reading(dv: DataView, kind: string): ((at: number) => number) | undefined {
  switch (kind) {
    case "I8": return (at) => dv.getInt8(at);
    case "U8": return (at) => dv.getUint8(at);
    case "I16": return (at) => dv.getInt16(at, true);
    case "U16": return (at) => dv.getUint16(at, true);
    case "I32": return (at) => dv.getInt32(at, true);
    case "U32": return (at) => dv.getUint32(at, true);
    case "F32": return (at) => dv.getFloat32(at, true);
    case "F64": return (at) => dv.getFloat64(at, true);
    case "I64": return (at) => Number(dv.getBigInt64(at, true));
    case "U64": return (at) => Number(dv.getBigUint64(at, true));
  }
  return undefined;
}

interface CloudField {
  name: string;
  offset: number;
  kind: string;
}

/** A PointCloud's point_step, its origin, and its field of a name whose number fits in a point. */
function layoutOf(value: unknown) {
  const v = (value ?? {}) as { fields?: unknown; point_step?: unknown; origin?: { pose?: PoseValue } };
  const fields = (Array.isArray(v.fields) ? v.fields : []) as CloudField[];
  const step = typeof v.point_step === "number" ? v.point_step : 0;
  const named = (name: string) => fields.find((f) => f.name === name && WIDTH[f.kind] !== undefined && f.offset + WIDTH[f.kind] <= step);
  return { step, named, origin: v.origin?.pose };
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Where the GPU reads a number of each point: in `bytes`, of `kind`, the first `offset` bytes
 *  in and each next `stride` on. A colour's kind is its bytes' order, RGBA, or PCL's BGRA or BGR. */
export interface Input {
  bytes: Uint8Array;
  kind: string;
  offset: number;
  stride: number;
}

/** A LaserScan's beams: the first one's angle and the turn to each next, the ranges a return
 *  lies within, and how many echoes each beam has. */
export interface Beams {
  start: number;
  turn: number;
  low: number;
  high: number;
  echoes: number;
}

/** `n` points as the GPU reads them: x, y and maybe z, or a scan's ranges in `x` and its beams,
 *  the number `field` gives each or the axis it is, a colour each, their origin, and a mesh's
 *  normals when its vertices have them. */
export interface Source {
  n: number;
  x: Input;
  y?: Input;
  z?: Input;
  beams?: Beams;
  value?: Input;
  axis?: number;
  colour?: Input;
  origin?: PoseValue;
  normals?: Input[];
}

// a list as bytes, the same each time it is read, so a value drawn again is not sent again
const asBytes = new WeakMap<Numbers, Uint8Array>();
const bytesOf = (list: Numbers): Uint8Array => {
  if (list instanceof Uint8Array) return list;
  let bytes = asBytes.get(list);
  if (!bytes) asBytes.set(list, (bytes = new Uint8Array(list.buffer, list.byteOffset, list.byteLength)));
  return bytes;
};

const KIND_OF = new Map<unknown, string>(Object.entries(VIEWS).map(([kind, View]) => [View, kind]));

/** A list's numbers, one after another, where the GPU reads them. */
export const inputOf = (list: Numbers): Input => ({ bytes: bytesOf(list), kind: KIND_OF.get(list.constructor)!, offset: 0, stride: list.BYTES_PER_ELEMENT });

/** A PointCloud's points where they sit in its bytes: x, y and z, the number `field` names, and
 *  its `rgb` or `rgba` field's colours when `own` asks for them. A mesh's vertices have their
 *  normal_x, normal_y and normal_z fields too, as PCL names them. */
export function cloudSource(value: unknown, bytes: Uint8Array, field: string | undefined, own: boolean, faults: string[], mesh = false): Source | undefined {
  const { step, named, origin } = layoutOf(value);
  const [fx, fy, fz] = AXES.map(named);
  if (!fx || !fy || !fz || step <= 0) return void faults.push(mesh ? "mesh: the vertices have no x, y and z fields that fit their point_step" : "points: the cloud has no x, y and z fields that fit its point_step");
  // as far apart as WebGL reads a vertex's numbers
  if (step > 255) return void faults.push(mesh ? `mesh: the vertices are ${step} bytes each, over the 255 a GPU reads` : `points: the cloud's points are ${step} bytes each, over the 255 a GPU reads`);
  const at = (f: CloudField, kind = f.kind): Input => ({ bytes, kind, offset: f.offset, stride: step });
  const s: Source = { n: Math.floor(bytes.length / step), x: at(fx), y: at(fy), z: at(fz), origin };
  const axis = axisOf(field);
  if (axis >= 0) s.axis = axis;
  else if (field) {
    const f = named(field);
    if (f) s.value = at(f);
    else faults.push(`field: the cloud has no number field ${field}`);
  }
  const colour = own && !field ? (named("rgba") ?? named("rgb")) : undefined;
  if (colour && WIDTH[colour.kind] === 4) s.colour = at(colour, colour.name === "rgba" ? "BGRA" : "BGR");
  const normals = ["normal_x", "normal_y", "normal_z"].map(named);
  if (mesh && normals.every((f) => f)) s.normals = normals.map((f) => at(f!));
  return s;
}

/** A Mesh's triangles as the GPU takes them, three vertex numbers each, and how many of them make
 *  whole triangles. One past its `n` vertices says so, as the GPU would draw nothing. */
export function trianglesOf(list: unknown, n: number, faults: string[]): [Uint32Array, number] | undefined {
  if (!isNumbers(list)) return void faults.push("mesh: the triangles are not numbers");
  const index = list instanceof Uint32Array ? list : Uint32Array.from(list);
  const m = index.length - (index.length % 3);
  if (m !== index.length) faults.push(`mesh: ${index.length} vertex numbers, not three for each triangle`);
  let top = 0;
  for (let i = 0; i < m; i++) if (index[i] > top) top = index[i];
  if (m > 0 && top >= n) return void faults.push(`mesh: a triangle has vertex ${top}, past the last of its ${n} vertices`);
  return [index, m];
}

/** A LaserScan's returns, placed by their beams' angles on the GPU, with a `range` and an
 *  `intensity` each for `field`. */
export function scanSource(value: unknown, ranges: Numbers, intensities: Numbers | undefined, field: string | undefined, faults: string[]): Source {
  const v = (value ?? {}) as Record<string, unknown>;
  const num = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : 0);
  const beams = { start: num("angle_min"), turn: num("angle_step"), low: num("range_min"), high: num("range_max"), echoes: Math.max(1, num("echoes")) };
  const s: Source = { n: ranges.length, x: inputOf(ranges), beams };
  const axis = axisOf(field);
  if (field === "range") s.value = s.x;
  else if (field === "intensity") {
    if (intensities && intensities.length === ranges.length) s.value = inputOf(intensities);
    else faults.push("field: the scan has no intensity for each range");
  } else if (axis >= 0) s.axis = axis;
  else if (field) faults.push(`field: a scan's points have x, y, z, range and intensity, not ${field}`);
  return s;
}

/** A list's points, of records with numbers x and y and maybe z, or with such a `position`, as
 *  Poses, Pose2Ds and Double2s have, and the numbers `field` names of each. */
export function listSource(c: Column, field: string | undefined, faults: string[]): Source | undefined {
  const not = "points: the value is not a list of points, each with numbers x, y and z";
  if (!isFields(c)) return void faults.push(not);
  const at = isFields(c.position) ? c.position : c;
  const [x, y, z] = [at.x, at.y, at.z];
  if (!isNumbers(x) || !isNumbers(y)) return void faults.push(not);
  const s: Source = { n: x.length, x: inputOf(x), y: inputOf(y), z: isNumbers(z) ? inputOf(z) : undefined };
  const axis = axisOf(field);
  if (axis >= 0) s.axis = axis;
  else if (field) {
    const own = isNumbers(c[field]) ? c[field] : at[field];
    if (isNumbers(own)) s.value = inputOf(own);
    else faults.push(`field: ${field} is not a number each point has`);
  }
  return s;
}

/** Points laid out on the page, each one's x, y and z after the one before, and the numbers the
 *  page read for `field` when it is not an axis. */
export function laidSource(xyz: Float32Array, field: string | undefined, values: Float32Array | undefined): Source {
  const bytes = bytesOf(xyz);
  const at = (offset: number): Input => ({ bytes, kind: "F32", offset, stride: 12 });
  const s: Source = { n: Math.floor(xyz.length / 3), x: at(0), y: at(4), z: at(8) };
  const axis = axisOf(field);
  if (axis >= 0) s.axis = axis;
  // a field the page could not read it said so of
  else if (field && values?.length === s.n) s.value = inputOf(values);
  return s;
}

// the typed array last made over some bytes, so a cloud's fields are all read through one
const over = new WeakMap<Uint8Array, ArrayLike<number>>();

/** The numbers `input` gives `n` points: a typed array over its bytes where they sit on their own
 *  width, with the step from one to the next and where the first is, else copied out. */
function spaced({ bytes, kind, offset, stride }: Input, n: number): [ArrayLike<number>, number, number] {
  const [View, width] = [VIEWS[kind], WIDTH[kind]];
  if (View && bytes.byteOffset % width === 0 && offset % width === 0 && stride % width === 0) {
    let list = over.get(bytes);
    if (!(list instanceof View)) over.set(bytes, (list = new View(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / width))));
    return [list, stride / width, offset / width];
  }
  const read = reading(viewOf(bytes), kind)!;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = read(i * stride + offset);
  return [out, 1, 0];
}

/** The low and high of the numbers a source's points give for its field, leaving out the points
 *  the GPU leaves out: one not finite, or a scan's return outside its ranges. */
export function spanOf(s: Source): [number, number] {
  const n = s.n;
  const x = spaced(s.x, n);
  let [lo, hi] = [Infinity, -Infinity];
  const b = s.beams;
  if (b) {
    const [r, sr, ar] = x;
    const [v, sv, av] = s.value ? spaced(s.value, n) : x;
    for (let i = 0; i < n; i++) {
      const range = r[i * sr + ar];
      if (range - range !== 0 || range < b.low || (b.high > 0 && range > b.high)) continue;
      const a = b.start + Math.floor(i / b.echoes) * b.turn;
      const k = s.value ? v[i * sv + av] : s.axis === 0 ? range * Math.cos(a) : s.axis === 1 ? range * Math.sin(a) : 0;
      if (k - k !== 0) continue;
      if (k < lo) lo = k;
      if (k > hi) hi = k;
    }
    return [lo, hi];
  }
  // no z reads as one 0 for every point
  const axes = [x, spaced(s.y!, n), s.z ? spaced(s.z, n) : ([new Float32Array(1), 0, 0] as const)];
  const [[px, sx, ax], [py, sy, ay], [pz, sz, az]] = axes;
  const [v, sv, av] = s.value ? spaced(s.value, n) : axes[s.axis ?? 0];
  // one loop for every field, with no branch in it but the points left out
  for (let i = 0; i < n; i++) {
    const a = px[i * sx + ax];
    const c = py[i * sy + ay];
    const d = pz[i * sz + az];
    // NaN and infinities alike, as a cloud that is not dense marks a missing point
    if (a - a !== 0 || c - c !== 0 || d - d !== 0) continue;
    const k = v[i * sv + av];
    if (k - k !== 0) continue;
    if (k < lo) lo = k;
    if (k > hi) hi = k;
  }
  return [lo, hi];
}

/** Whether any of the first `n` colours `c` gives is see through. */
export function seeThrough(c: Input, n: number): boolean {
  if (c.kind === "BGR") return false;
  for (let i = 0, at = c.offset + 3; i < n; i++, at += c.stride) if (c.bytes[at] < 255) return true;
  return false;
}

/** Turbo, as robotics tools colour intensity and height: 256 colours from low to high, a byte
 *  each of red, green and blue, Anton Mikhailov's polynomial fit. Only its tenth to ninth tenth,
 *  blue to dark red, as its ends are near black and vanish on a dark scene. */
export const RAMP = (() => {
  const out = new Uint8Array(256 * 3);
  const poly = (t: number, c: number[]) => c.reduceRight((acc, k) => acc * t + k, 0);
  const R = [0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396, 59.28637943];
  const G = [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604];
  const B = [0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973];
  for (let i = 0; i < 256; i++) {
    const t = 0.1 + (0.8 * i) / 255;
    [R, G, B].forEach((c, k) => (out[3 * i + k] = Math.round(255 * Math.min(1, Math.max(0, poly(t, c))))));
  }
  return out;
})();

/** Writes the ramp's colour for `v`, `scale` steps a unit up from `lo`, opaque at `rgba[k]`. */
function inked(rgba: Uint8Array, k: number, v: number, lo: number, scale: number) {
  const at = 3 * (((v - lo) * scale + 0.5) | 0);
  rgba[k] = RAMP[at];
  rgba[k + 1] = RAMP[at + 1];
  rgba[k + 2] = RAMP[at + 2];
  rgba[k + 3] = 255;
}

/** A Grid's cells along x, y and z, a cell's side, the pose of its first cell's outer corner, and
 *  where the GPU reads the number of the field drawn of each, x fastest. */
export interface Cells {
  cells: [number, number, number];
  side: number;
  origin?: PoseValue;
  values: Input;
  n: number;
}

/** A Grid's cells by the numbers of one of its fields, of `kind`, in `bytes`. */
export function gridSource(value: unknown, kind: string, bytes: Uint8Array, faults: string[]): Cells | undefined {
  const v = (value ?? {}) as { origin?: { pose?: PoseValue }; resolution?: unknown; cells_x?: unknown; cells_y?: unknown; cells_z?: unknown };
  const cells = [v.cells_x, v.cells_y, v.cells_z].map((c) => (Number.isInteger(c) && (c as number) >= 0 ? (c as number) : NaN)) as Cells["cells"];
  const side = v.resolution;
  if (!cells.every(Number.isFinite) || typeof side !== "number" || !(side > 0)) return void faults.push("grid: the grid has no cells_x, cells_y and cells_z, or no resolution above 0");
  const width = WIDTH[kind];
  if (width === undefined) return void faults.push(`grid: the field's kind ${kind} is not a number`);
  const n = cells[0] * cells[1] * cells[2];
  if (bytes.length < n * width) return void faults.push(`grid: the field has ${bytes.length} bytes, not ${n * width} for ${n} cells of ${kind}`);
  return { cells, side, origin: v.origin?.pose, values: { bytes, kind, offset: 0, stride: width }, n };
}

/** The low and high of the first `n` numbers `v` gives, leaving out those not finite. */
export function spanOfNumbers(v: Input, n: number): [number, number] {
  const [list, step, first] = spaced(v, n);
  let [lo, hi] = [Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const k = list[i * step + first];
    if (k - k !== 0) continue;
    if (k < lo) lo = k;
    if (k > hi) hi = k;
  }
  return [lo, hi];
}

/** A deep grid's `n` cells from `lo` to `hi` as cubes: the middle of each from the corner, and its
 *  colour along the ramp. */
export function cubesOf(g: Cells, lo: number, hi: number, pool: Pool): { xyz: Float32Array; rgba: Uint8Array; n: number } {
  const [values, step, first] = spaced(g.values, g.n);
  const [[cx, cy, cz], side] = [g.cells, g.side];
  const scale = 255 / (hi - lo || 1);
  let n = 0;
  for (let i = 0; i < g.n; i++) if (values[i * step + first] >= lo && values[i * step + first] <= hi) n++;
  const xyz = pool.floats("xyz", n, 3);
  const rgba = pool.bytes("cells", n, 4);
  let [i, j] = [0, 0];
  for (let c = 0; c < cz; c++)
    for (let b = 0; b < cy; b++)
      for (let a = 0; a < cx; a++, i++) {
        const x = values[i * step + first];
        if (!(x >= lo && x <= hi)) continue;
        xyz[3 * j] = (a + 0.5) * side;
        xyz[3 * j + 1] = (b + 0.5) * side;
        xyz[3 * j + 2] = (c + 0.5) * side;
        inked(rgba, 4 * j, x, lo, scale);
        j++;
      }
  return { xyz, rgba, n };
}

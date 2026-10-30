// Lists of numbers, and lists of records whose fields are all numbers, come from the system as
// typed arrays: RFC 8746's tags, and under tag 41000 a map of a column a field. Each reads as a
// frozen list over its columns, so a cloud of thousands of points costs nothing until something
// walks it, and the scene draws straight from the columns.

import { addExtension, type Extension } from "cbor-x";

type Numbers = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/** What a packed list is over: its numbers, or for records a column a field. */
export type Column = Numbers | Fields;
interface Fields {
  readonly [field: string]: Column;
}

type Kind = { new (buffer: ArrayBuffer): Numbers; readonly BYTES_PER_ELEMENT: number };

/** RFC 8746's little endian typed arrays, by tag. */
const KINDS: Record<number, Kind> = {
  64: Uint8Array,
  72: Int8Array,
  69: Uint16Array,
  77: Int16Array,
  70: Uint32Array,
  78: Int32Array,
  85: Float32Array,
  86: Float64Array,
};
const RECORDS_TAG = 41000;
/** Numbers shuffled then LZ4 compressed: their typed array's tag, then the block, its size first. */
const COMPRESSED_TAG = 41001;
/** A list as the change from the one the screen holds: its length, the ops, its new rows. */
const CHANGE_TAG = 41002;

const behind = new WeakMap<object, Column>();

const isNumbers = (c: Column): c is Numbers => ArrayBuffer.isView(c);

/** Reads the system's typed arrays as packed lists, in every CBOR decoder on the page. */
export function readPacked() {
  // cbor-x takes an extension with no class as one that only decodes, though its types ask for one
  const decodes = <R>(tag: number, decode: (item: R) => unknown) => addExtension({ tag, decode } as unknown as Extension<unknown, R>);
  // a copy, so the message it came in is let go
  for (const [tag, Kind] of Object.entries(KINDS)) decodes(Number(tag), (bytes: Uint8Array) => list(new Kind(bytes.slice().buffer)));
  decodes(COMPRESSED_TAG, ([tag, block]: [number, Uint8Array]) => list(unpack(KINDS[tag], block)));
  // each column was read as a packed list first
  decodes(RECORDS_TAG, (columns: Record<string, unknown>) => list(Object.fromEntries(Object.entries(columns).map(([k, c]) => [k, behind.get(c as object)!]))));
}

/** A column as the data worker reads it, which can cross to the main thread, where `revive`
 *  makes it a packed list. */
interface Marked {
  packed: Column;
}

/** Reads the system's typed arrays as their columns marked `packed`, in the data worker, and a
 *  list sent as a change as one. */
export function readPackedPlain() {
  const decodes = <R>(tag: number, decode: (item: R) => unknown) => addExtension({ tag, decode } as unknown as Extension<unknown, R>);
  for (const [tag, Kind] of Object.entries(KINDS)) decodes(Number(tag), (bytes: Uint8Array): Marked => ({ packed: new Kind(bytes.slice().buffer) }));
  decodes(COMPRESSED_TAG, ([tag, block]: [number, Uint8Array]): Marked => ({ packed: unpack(KINDS[tag], block) }));
  decodes(RECORDS_TAG, (columns: Record<string, Marked>): Marked => ({ packed: Object.fromEntries(Object.entries(columns).map(([k, c]) => [k, c.packed])) }));
  decodes(CHANGE_TAG, ([rows, code, fresh]: [number, Uint8Array, Fresh]) => new Change(rows, code, fresh));
}

/** The new rows of a changed list, each column's as compressed numbers, a map for records. */
type Fresh = Uint8Array | { readonly [field: string]: Fresh };

/** A list sent as the change from one the data worker holds (the backend's delta.rs). */
export class Change {
  constructor(
    readonly rows: number,
    readonly code: Uint8Array,
    readonly fresh: Fresh,
  ) {}
}

/** List `base` changed by `c`: in turn new rows, then a run of `base`'s rows. Throws when `c`
 *  does not fit `base`. */
export function changed(base: Column, c: Change): Column {
  const ops = varints(lz4(c.code, new Uint8Array(sizeOf(c.code))));
  // each column of the list with its new rows and the column made
  const columns: [Numbers, Numbers, Numbers][] = [];
  const made = (b: Column, f: Fresh | undefined): Column => {
    if (isNumbers(b)) {
      if (!(f instanceof Uint8Array)) throw new Error("a change that does not fit its list");
      const Kind = b.constructor as Kind;
      const out = new Kind(new ArrayBuffer(c.rows * Kind.BYTES_PER_ELEMENT));
      columns.push([b, unpack(Kind, f), out]);
      return out;
    }
    if (f === undefined || f instanceof Uint8Array) throw new Error("a change that does not fit its list");
    return Object.fromEntries(Object.entries(b).map(([k, x]) => [k, made(x, f[k])]));
  };
  const out = made(base, c.fresh);
  let [at, taken, next] = [0, 0, 0];
  for (let n = ops[0], i = 1; n > 0; n--, i += 3) {
    const [fresh, z, len] = [ops[i], ops[i + 1], ops[i + 2]];
    const from = next + (z % 2 ? -(z + 1) / 2 : z / 2);
    for (const [b, f, o] of columns) {
      o.set(f.subarray(taken, taken + fresh), at);
      if (len) o.set(b.subarray(from, from + len), at + fresh);
    }
    taken += fresh;
    at += fresh + len;
    next = from + len;
  }
  if (at !== c.rows) throw new Error("a change that does not fit its list");
  return out;
}

/** The varints in `b`, unsigned. */
function varints(b: Uint8Array): number[] {
  const out: number[] = [];
  let [v, scale] = [0, 1];
  for (const x of b) {
    v += (x & 0x7f) * scale;
    if (x & 0x80) scale *= 128;
    else {
      out.push(v);
      [v, scale] = [0, 1];
    }
  }
  return out;
}

/** The buffers of the marked columns in `v`, to hand over rather than copy. */
export function buffers(v: unknown, out = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (ArrayBuffer.isView(v)) out.add(v.buffer as ArrayBuffer);
  else if (Array.isArray(v)) for (const x of v) buffers(x, out);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) buffers(x, out);
  return [...out];
}

/** `v` as the data worker hands it on, each column it marked with its ref a packed list again,
 *  and each it kept a far list. */
export function revive(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revive);
  if (typeof v !== "object" || v === null || ArrayBuffer.isView(v)) return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join();
  if (keys === "packed,ref" && typeof o.packed === "object" && typeof o.ref === "string") {
    const p = list(o.packed as Column);
    refs.set(p, o.ref);
    return p;
  }
  if (keys === "far,length" && typeof o.far === "string" && typeof o.length === "number") return farList(o.far, o.length);
  if (keys === "bytes,ref" && o.bytes instanceof Uint8Array && typeof o.ref === "string") {
    refs.set(o.bytes, o.ref);
    return o.bytes;
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revive(x)]));
}

/** The ref of each list and bytes the data worker keeps, which a scene's points follow there. */
const refs = new WeakMap<object, string>();

/** The ref of a list the data worker keeps, or undefined. */
export function refOf(v: unknown): string | undefined {
  return typeof v === "object" && v !== null ? refs.get(v) : undefined;
}

/** Thrown by reading an item of a far list, which counts as reading a value not known. */
export class Far extends Error {
  constructor(readonly alias: string) {
    super(`${alias} is drawn without the page`);
  }
}

/** A list of `length` items the data worker keeps, whose items the page cannot read, which a
 *  scene's points follow by its ref. */
function farList(ref: string, length: number): unknown[] {
  const p = new Proxy<unknown[]>([], {
    get: (t, key, receiver) => {
      if (index(key, length) >= 0) throw new Far(ref.split("/")[0]);
      return key === "length" ? length : Reflect.get(t, key, receiver);
    },
    has: (t, key) => index(key, length) >= 0 || Reflect.has(t, key),
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });
  refs.set(p, ref);
  fars.add(p);
  return p;
}
const fars = new WeakSet<object>();

/** LZ4's output for numbers wider than a byte, kept, as it is copied out at once. */
let unpacked = new Uint8Array(0);

/** Numbers of kind `Kind` from LZ4 block `block`, whose bytes were shuffled: every number's
 *  first byte, then every second byte and so on. */
function unpack(Kind: Kind, block: Uint8Array): Numbers {
  const size = sizeOf(block);
  const w = Kind.BYTES_PER_ELEMENT;
  if (w === 1) return new Kind(lz4(block, new Uint8Array(size)).buffer);
  if (unpacked.length < size) unpacked = new Uint8Array(size);
  const bytes = lz4(block, unpacked);
  // a word at a time is far faster than a byte, low byte first as the page is little endian
  const n = size / w;
  if (w === 2) {
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = bytes[i] | (bytes[n + i] << 8);
    return new Kind(out.buffer);
  }
  const words = w / 4;
  const out = new Uint32Array(n * words);
  for (let k = 0; k < words; k++) {
    const [a, b, c, d] = [4 * k, 4 * k + 1, 4 * k + 2, 4 * k + 3].map((j) => j * n);
    for (let i = 0; i < n; i++) out[i * words + k] = bytes[a + i] | (bytes[b + i] << 8) | (bytes[c + i] << 16) | (bytes[d + i] << 24);
  }
  return new Kind(out.buffer);
}

/** The size lz4_flex writes before its block. */
const sizeOf = (block: Uint8Array) => (block[0] | (block[1] << 8) | (block[2] << 16) | (block[3] << 24)) >>> 0;

/** LZ4 block `src`, after the size lz4_flex writes first, unpacked into `out`. */
function lz4<T extends Uint8Array>(src: Uint8Array, out: T): T {
  let i = 4;
  let o = 0;
  // a sequence is a token, literals, then a match unless the block ends with the literals
  while (i < src.length) {
    const token = src[i++];
    let literals = token >> 4;
    if (literals === 15) do literals += src[i]; while (src[i++] === 255);
    if (literals < 16) for (let k = 0; k < literals; k++) out[o++] = src[i++];
    else {
      out.set(src.subarray(i, i + literals), o);
      i += literals;
      o += literals;
    }
    if (i >= src.length) break;
    const offset = src[i] | (src[i + 1] << 8);
    // else the copy below would never end
    if (offset === 0) throw new Error("not an LZ4 block");
    i += 2;
    let length = token & 15;
    if (length === 15) do length += src[i]; while (src[i++] === 255);
    length += 4;
    const end = o + length;
    const from = o - offset;
    if (length < 16) for (let f = from; o < end; ) out[o++] = out[f++];
    // a match that overlaps what it writes repeats its pattern, so copy in chunks that double
    else
      while (o < end) {
        const n = Math.min(o - from, end - o);
        out.copyWithin(o, from, from + n);
        o += n;
      }
  }
  return out;
}

/** Whether `v` is a packed list, or a far one. */
export function packed(v: unknown): boolean {
  return typeof v === "object" && v !== null && (behind.has(v) || fars.has(v));
}

/** Field `field`'s numbers in packed records `v`, or undefined. They are the list's own, so
 *  never written. */
export function column(v: unknown, field: string): Numbers | undefined {
  const c = typeof v === "object" && v !== null ? behind.get(v) : undefined;
  return c && !isNumbers(c) && c[field] && isNumbers(c[field]) ? c[field] : undefined;
}

/** The columns behind packed records `v`, a column a field, or undefined. They are the list's
 *  own, so never written. */
export function fieldsOf(v: unknown): Fields | undefined {
  const c = typeof v === "object" && v !== null ? behind.get(v) : undefined;
  return c && !isNumbers(c) ? c : undefined;
}

/** The numbers a packed list of numbers holds, or undefined for any other value. */
export function numbers(v: unknown): Numbers | undefined {
  const c = typeof v === "object" && v !== null ? behind.get(v) : undefined;
  return c && isNumbers(c) ? c : undefined;
}

/** Whether packed lists `a` and `b` hold the same numbers, byte for byte. */
export function samePacked(a: unknown, b: unknown): boolean {
  const [x, y] = [a, b].map((v) => (typeof v === "object" && v !== null ? behind.get(v) : undefined));
  return x !== undefined && y !== undefined && same(x, y);
}

function same(a: Column, b: Column): boolean {
  if (isNumbers(a) || isNumbers(b)) {
    if (!isNumbers(a) || !isNumbers(b) || a.constructor !== b.constructor || a.length !== b.length) return false;
    const [x, y] = [new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => b[k] !== undefined && same(a[k], b[k]));
}

/** How many items `c` holds, as every column of records holds as many. */
function size(c: Column): number {
  if (isNumbers(c)) return c.length;
  for (const k in c) return size(c[k]);
  return 0;
}

/** Record `i` of `fields`, frozen. */
function row(fields: Fields, i: number): unknown {
  const r: Record<string, unknown> = {};
  for (const k in fields) {
    const c = fields[k];
    r[k] = isNumbers(c) ? c[i] : row(c, i);
  }
  return Object.freeze(r);
}

/** The item `key` names in a list this long, or -1. */
function index(key: string | symbol, length: number): number {
  if (typeof key !== "string") return -1;
  const i = Number(key);
  return Number.isInteger(i) && i >= 0 && i < length && String(i) === key ? i : -1;
}

/** A frozen list over `c`, each item read from it when asked for. A record is made once, so it
 *  is the same one each time. */
function list(c: Column): unknown[] {
  const length = size(c);
  let rows: unknown[] | undefined;
  const item = isNumbers(c) ? (i: number) => c[i] : (i: number) => ((rows ??= new Array(length))[i] ??= row(c, i));
  // the target stays an empty array, so it takes nothing and Array.isArray holds
  const p = new Proxy<unknown[]>([], {
    get: (t, key, receiver) => {
      const i = index(key, length);
      return i >= 0 ? item(i) : key === "length" ? length : Reflect.get(t, key, receiver);
    },
    has: (t, key) => index(key, length) >= 0 || Reflect.has(t, key),
    ownKeys: (t) => [...Array.from({ length }, (_, i) => String(i)), ...Reflect.ownKeys(t)],
    getOwnPropertyDescriptor: (t, key) => {
      const i = index(key, length);
      if (i >= 0) return { value: item(i), writable: false, enumerable: true, configurable: true };
      const d = Reflect.getOwnPropertyDescriptor(t, key);
      return key === "length" && d ? { ...d, value: length } : d;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });
  behind.set(p, c);
  return p;
}

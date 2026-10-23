// Lists of numbers, and lists of records whose fields are all numbers, come from the system as
// typed arrays: RFC 8746's tags, and under tag 41000 a map of a column a field. Each reads as a
// frozen list over its columns, so a cloud of thousands of points costs nothing until something
// walks it, and the scene draws straight from the columns.

import { addExtension, type Extension } from "cbor-x";

type Numbers = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/** What a packed list is over: its numbers, or for records a column a field. */
type Column = Numbers | Fields;
interface Fields {
  readonly [field: string]: Column;
}

/** RFC 8746's little endian typed arrays, by tag. */
const KINDS: Record<number, new (buffer: ArrayBuffer) => Numbers> = {
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

const behind = new WeakMap<object, Column>();

const isNumbers = (c: Column): c is Numbers => ArrayBuffer.isView(c);

/** Reads the system's typed arrays as packed lists, in every CBOR decoder on the page. */
export function readPacked() {
  // cbor-x takes an extension with no class as one that only decodes, though its types ask for one
  const decodes = <R>(tag: number, decode: (item: R) => unknown) => addExtension({ tag, decode } as unknown as Extension<unknown, R>);
  // a copy, so the message it came in is let go
  for (const [tag, Kind] of Object.entries(KINDS)) decodes(Number(tag), (bytes: Uint8Array) => list(new Kind(bytes.slice().buffer)));
  // each column was read as a packed list first
  decodes(RECORDS_TAG, (columns: Record<string, unknown>) => list(Object.fromEntries(Object.entries(columns).map(([k, c]) => [k, behind.get(c as object)!]))));
}

/** Whether `v` is a packed list. */
export function packed(v: unknown): boolean {
  return typeof v === "object" && v !== null && behind.has(v);
}

/** Field `field`'s numbers in packed records `v`, or undefined. They are the list's own, so
 *  never written. */
export function column(v: unknown, field: string): Numbers | undefined {
  const c = typeof v === "object" && v !== null ? behind.get(v) : undefined;
  return c && !isNumbers(c) && c[field] && isNumbers(c[field]) ? c[field] : undefined;
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

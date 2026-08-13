/* The attribute interpreter: a small stack machine over the programs the backend ships
 * in the registry. This is the one place a view computes anything, and it is rendering,
 * not truth: inputs are backend-authoritative slot values plus this view's own
 * interaction state, outputs are visual attributes only.
 *
 * Every operation is total. Nil (null) poisons: any operation on it yields Nil, and a
 * Nil attribute renders the UNKNOWN treatment rather than a fabricated value. */

import { Instr, Json, Program } from "./types.js";

export type Cells = (cell: string) => Json;

const NIL: Json = null;

/* degrees, both ways: every trig opcode takes and returns degrees, the project-wide angle
 * convention (degrees, 0 = up, clockwise). These are the ordinary trig functions
 * (sin(0) == 0, cos(0) == 1), with the polar half of that convention left to whoever calls
 * them, exactly as on the scalar tier (backend/src/vm/vm.cpp) */
const DEG = Math.PI / 180;

function nil(v: Json): boolean {
  return v === null || v === undefined;
}

function num(v: Json): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

function truthy(v: Json): boolean | null {
  if (nil(v)) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  return true;
}

/* ---- color arithmetic ----
 *
 * A DELIBERATE PORT of backend/src/lang/value.cpp's pack_rgba/mix_rgba: the view works
 * in "#rrggbbaa" strings (an SVG fill/stroke attribute takes one directly) while the
 * scalar VM works in a packed uint32, so the two representations cannot share code --
 * only the rounding rule can, and this keeps it byte-for-byte the same (round to
 * nearest, clamp to 0..255) so a color built the same way on both tiers comes out the
 * same on both. */

function channelByte(value: number): number {
  if (!(value > 0)) return 0; // NaN lands here too
  if (value >= 255) return 255;
  return Math.round(value);
}

function hex2(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

/* format_color's own rule: alpha 255 (fully opaque) drops to the 6-digit form, so a
 * color nobody made transparent round-trips as the shorter, more familiar spelling */
function formatRgba(r: number, g: number, b: number, a: number): string {
  return a === 255
    ? "#" + hex2(r) + hex2(g) + hex2(b)
    : "#" + hex2(r) + hex2(g) + hex2(b) + hex2(a);
}

function packRgba(r: number, g: number, b: number, a: number): string {
  return formatRgba(channelByte(r), channelByte(g), channelByte(b), channelByte(a * 255));
}

function mixRgba(from: number[], to: number[], t: number): string {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  return formatRgba(
    channelByte(from[0] + (to[0] - from[0]) * tt),
    channelByte(from[1] + (to[1] - from[1]) * tt),
    channelByte(from[2] + (to[2] - from[2]) * tt),
    channelByte(from[3] + (to[3] - from[3]) * tt),
  );
}

/* hsv -> rgb, ported from the same switch vm.cpp's Builtin::Hsv runs -- h wraps at
 * 360 (negative wraps positive), s/v saturate to 0..1, a passes through unclamped
 * here since the caller (HSV below) already clamped it via channelByte */
function hsvToRgba(hDeg: number, s: number, v: number, a: number): string {
  let h = hDeg % 360;
  if (h < 0) h += 360;
  const ss = s < 0 ? 0 : s > 1 ? 1 : s;
  const vv = v < 0 ? 0 : v > 1 ? 1 : v;
  const c = vv * ss;
  const m = vv - c;
  const f = h / 60 - Math.floor(h / 120) * 2;
  const x = c * (1 - Math.abs(f - 1));
  let r = 0, g = 0, b = 0;
  switch (Math.floor(h / 60)) {
    case 0: r = c; g = x; break;
    case 1: r = x; g = c; break;
    case 2: g = c; b = x; break;
    case 3: g = x; b = c; break;
    case 4: r = x; b = c; break;
    default: r = c; b = x; break;
  }
  return packRgba((r + m) * 255, (g + m) * 255, (b + m) * 255, a);
}

/* the CSS shorthand-doubling rule (#rgb / #rgba / #rrggbb / #rrggbbaa), matching
 * value.cpp's parse_color for the 6/8-digit forms and extending it to the 4-digit
 * alpha shorthand template_expr.cpp's lexer already accepts as a COLOR LITERAL --
 * that tier never had to compute with one before this, only pass it through to CSS,
 * which parses all four forms natively */
function parseColorBytes(text: Json): number[] | null {
  if (typeof text !== "string" || text[0] !== "#") return null;
  const hex = text.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length === 3 || hex.length === 4) {
    const r = parseInt(hex[0], 16) * 17;
    const g = parseInt(hex[1], 16) * 17;
    const b = parseInt(hex[2], 16) * 17;
    const a = hex.length === 4 ? parseInt(hex[3], 16) * 17 : 255;
    return [r, g, b, a];
  }
  if (hex.length === 6 || hex.length === 8) {
    const pair = (at: number) => parseInt(hex.slice(at, at + 2), 16);
    const a = hex.length === 8 ? pair(6) : 255;
    return [pair(0), pair(2), pair(4), a];
  }
  return null;
}

/* MEASURE's estimator: 0.58 x size per character, the constant the SVG renderer used to
 * fit text into a box. It is a guess and always was — it cannot see the font, so it cannot
 * be right — and it is PROVISIONAL here: the whole reason a declarative renderer needed an
 * estimator is that it could not ask the browser. Once text is real DOM the browser
 * measures it, and this collapses into asking. It stays meanwhile so an expression using
 * measure() keeps computing something rather than failing. (It used to discount rich.ts's
 * underscore markup, which went with the SVG text renderer that drew it.) */
function measureText(text: string, size: number): number {
  if (!text.length) return 0;
  let longest = 0;
  for (const line of text.split("\n")) if (line.length > longest) longest = line.length;
  return 0.58 * size * longest;
}

/* ---- lists ----
 *
 * A DISPLAY-TIER LIST is an ordinary JS array on the stack, and a Nil ELEMENT is a value
 * the list holds rather than a poison: a plot's missing sample is a gap in the picture,
 * not an unknown picture. Nil still poisons everything ABOUT a list -- a non-array receiver,
 * an index off the end, an aggregate over a gap -- because those are questions with no
 * honest answer.
 *
 * THE AGGREGATES ARE PINNED TO THE SCALAR VM (backend/src/vm/vm.cpp, MethodId::ListSum /
 * ListAvg / ListMax / ListMin): an EMPTY list sums to 0 and avg/max/min to Nil, and ANY
 * element that is not a number takes the whole aggregate to Nil -- a gap does not average
 * over the samples around it. The one thing this tier is stricter about is a non-finite
 * number, which the view's own num() has never accepted as a number at all. */

/* how many elements one ITERATE will walk. The view's ring is larger than the scalar
 * tier's 512-element ceiling (a trend keeps thousands of samples), so this is its own
 * number; past it the loop simply stops, which is bounded work and a short answer rather
 * than a hung frame. It is FAR above what a screen can show — a path with this many points
 * is already more than the renderer wants — because a cell's own bound is bytes now, and a
 * frame budget is the only thing this one was ever really about. */
const ITERATE_CAP = 65536;

/* nothing outside an ITERATE body has arguments to read, so ARG there is Nil */
const NO_ARGS: Json[] = [];

/* a MAP value in this tier is a plain object (the aggs lane delivers it as one). The
   other objects this tier passes around -- anchors, timer records -- never legally meet
   the list vocabulary; the compiler is what keeps them apart, so this only has to tell
   a map from a scalar and a list. */
function isMapValue(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* what ITERATE can be asked to do with the values its body returned */
const ITERATE_MODES = new Set(["MAP", "FILTER", "ANY", "ALL", "SORT_BY", "REDUCE"]);

/* the ordering SORT_BY imposes on the keys a body produced: numbers first and ascending,
 * then text lexicographically, then everything a key has no order in (Nil, an object, a
 * bool) in the order it already stood. Nil LAST is vm.cpp's sorts_before rule -- an UNKNOWN
 * never quietly leads the list. */
function keyRank(key: Json): number {
  if (typeof key === "number" && Number.isFinite(key)) return 0;
  if (typeof key === "string") return 1;
  return 2;
}

function keysBefore(a: Json, b: Json): number {
  const ra = keyRank(a);
  const rb = keyRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (a as number) - (b as number);
  if (ra === 1) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  return 0;
}

export function run(program: Program | undefined, cells: Cells): Json {
  if (!program || !Array.isArray(program.code)) return NIL;
  return exec(program.code, cells, NO_ARGS);
}

/* One run of one instruction list. The body of an ITERATE is a list like any other, so it
 * runs here too, on its own stack, with the loop's per-element values in `args` (what ARG
 * reads). */
function exec(code: Instr[], cells: Cells, args: Json[]): Json {
  const stack: Json[] = [];
  const pop = (): Json => (stack.length ? stack.pop() : NIL);

  /* ADD is handled above this function's one caller (text concatenation needs the raw,
     un-num()'d operands to tell a string apart from a number), so it never reaches here */
  const arith = (op: string): Json => {
    const b = num(pop());
    const a = num(pop());
    if (a === null || b === null) return NIL;
    switch (op) {
      case "SUB": return a - b;
      case "MUL": return a * b;
      case "DIV": return b === 0 ? NIL : a / b;
      case "LT": return a < b;
      case "LE": return a <= b;
      case "GT": return a > b;
      case "GE": return a >= b;
    }
    return NIL;
  };

  for (const instr of code) {
    switch (instr.op) {
      case "CONST":
        stack.push(instr.v === undefined ? NIL : instr.v);
        break;
      case "LOAD":
        stack.push(cells(instr.cell ?? ""));
        break;
      case "PICK": {
        const b = pop();
        const a = pop();
        const c = truthy(pop());
        stack.push(c === null ? NIL : c ? a : b);
        break;
      }
      case "ADD": {
        /* `+` CONCATENATES when either side is text — the language's own rule on both
         * tiers, not a view convenience — rendering the other operand the way
         * str()/attrText() renders it -- a number as its plain string, a bool as
         * true/false -- so the two spellings can never disagree.
         * Numeric addition is unchanged: neither side being a string is the ordinary
         * case and falls straight through to the existing arith() path below. */
        const b = pop();
        const a = pop();
        if (typeof a === "string" || typeof b === "string") {
          const ta = attrText(a);
          const tb = attrText(b);
          stack.push(ta === null || tb === null ? NIL : ta + tb);
        } else {
          const an = num(a);
          const bn = num(b);
          stack.push(an === null || bn === null ? NIL : an + bn);
        }
        break;
      }
      case "SUB": case "MUL": case "DIV":
      case "LT": case "LE": case "GT": case "GE":
        stack.push(arith(instr.op));
        break;
      case "NEG": {
        const a = num(pop());
        stack.push(a === null ? NIL : -a);
        break;
      }
      case "EQ": case "NE": {
        const b = pop();
        const a = pop();
        if (nil(a) || nil(b)) { stack.push(NIL); break; }
        const equal = a === b;
        stack.push(instr.op === "EQ" ? equal : !equal);
        break;
      }
      case "NOT": {
        const a = truthy(pop());
        stack.push(a === null ? NIL : !a);
        break;
      }
      case "CLAMP01": {
        const a = num(pop());
        stack.push(a === null ? NIL : a < 0 ? 0 : a > 1 ? 1 : a);
        break;
      }
      case "ABS": case "ROUND": case "FLOOR": case "CEIL": case "SQRT": case "INT":
      case "SIGN": case "SIN": case "COS": case "TAN": case "ASIN": case "ACOS": {
        const a = num(pop());
        if (a === null) { stack.push(NIL); break; }
        if (instr.op === "ABS") stack.push(Math.abs(a));
        else if (instr.op === "ROUND") stack.push(Math.round(a));
        else if (instr.op === "FLOOR") stack.push(Math.floor(a));
        else if (instr.op === "CEIL") stack.push(Math.ceil(a));
        else if (instr.op === "SQRT") stack.push(a < 0 ? NIL : Math.sqrt(a));
        else if (instr.op === "INT") stack.push(Math.trunc(a));
        else if (instr.op === "SIGN") stack.push(Math.sign(a));
        /* ordinary trig, degrees in and out (see DEG above): sin(0) === 0, cos(0) === 1 */
        else if (instr.op === "SIN") stack.push(Math.sin(a * DEG));
        else if (instr.op === "COS") stack.push(Math.cos(a * DEG));
        else if (instr.op === "TAN") stack.push(Math.tan(a * DEG));
        else if (instr.op === "ASIN") stack.push(a < -1 || a > 1 ? NIL : Math.asin(a) / DEG);
        else stack.push(a < -1 || a > 1 ? NIL : Math.acos(a) / DEG);
        break;
      }
      case "POW": case "MIN": case "MAX": case "MOD": case "ATAN2": {
        const b = num(pop());
        const a = num(pop());
        if (a === null || b === null) { stack.push(NIL); break; }
        if (instr.op === "POW") stack.push(Math.pow(a, b));
        else if (instr.op === "MIN") stack.push(Math.min(a, b));
        else if (instr.op === "MAX") stack.push(Math.max(a, b));
        else if (instr.op === "MOD") stack.push(b === 0 ? NIL : a % b);
        /* atan2(y, x): a is the first argument (y), b the second (x) -- the same
           argument order the scalar tier's Builtin::Atan2 takes */
        else stack.push(Math.atan2(a, b) / DEG);
        break;
      }
      case "TO_FIXED": {
        const dp = num(pop());
        const a = num(pop());
        stack.push(a === null ? NIL : a.toFixed(Math.max(0, Math.min(12, dp ?? 0))));
        break;
      }
      case "STR": {
        const t = attrText(pop());
        stack.push(t === null ? NIL : t);
        break;
      }
      case "MEASURE": {
        const size = num(pop());
        const text = attrText(pop());
        stack.push(size === null || text === null ? NIL : measureText(text, size));
        break;
      }
      case "RGB": {
        /* every channel FRACTIONAL 0..1 — the convention rgb()/hsv() take on both tiers,
           never 0..255 — pushed r, g, b, a in that order (template_expr.cpp defaults the
           4th to 1 when a call omits it) */
        const a = num(pop());
        const b = num(pop());
        const g = num(pop());
        const r = num(pop());
        stack.push(
          r === null || g === null || b === null || a === null
            ? NIL
            : packRgba(r * 255, g * 255, b * 255, a),
        );
        break;
      }
      case "HSV": {
        const a = num(pop());
        const v = num(pop());
        const s = num(pop());
        const h = num(pop());
        stack.push(
          h === null || s === null || v === null || a === null
            ? NIL
            : hsvToRgba(h, s, v, a),
        );
        break;
      }
      case "COLOR_R": case "COLOR_G": case "COLOR_B": case "COLOR_A": {
        const bytes = parseColorBytes(pop());
        if (!bytes) { stack.push(NIL); break; }
        const channel = instr.op === "COLOR_R" ? bytes[0]
                       : instr.op === "COLOR_G" ? bytes[1]
                       : instr.op === "COLOR_B" ? bytes[2] : bytes[3] / 255;
        stack.push(channel);
        break;
      }
      case "COLOR_ALPHA": {
        const a = num(pop());
        const bytes = parseColorBytes(pop());
        if (!bytes || a === null) { stack.push(NIL); break; }
        const aa = a < 0 ? 0 : a > 1 ? 1 : a;
        stack.push(formatRgba(bytes[0], bytes[1], bytes[2], channelByte(aa * 255)));
        break;
      }
      case "COLOR_MIX": {
        const t = num(pop());
        const to = parseColorBytes(pop());
        const from = parseColorBytes(pop());
        stack.push(!from || !to || t === null ? NIL : mixRgba(from, to, t));
        break;
      }
      /* the elements were pushed left to right, so the tail of the stack IS the list in
         order; a Nil among them stays exactly where it was pushed */
      case "MAKE_LIST": {
        const want = typeof instr.n === "number" && Number.isFinite(instr.n)
          ? Math.max(0, Math.trunc(instr.n)) : 0;
        const take = Math.min(want, stack.length);
        stack.push(stack.splice(stack.length - take, take));
        break;
      }
      case "INDEX": {
        const at = pop();
        const list = pop();
        /* a MAP indexes by its text key; an absent key is Nil, the same honest miss an
           out-of-range list index answers */
        if (isMapValue(list)) {
          stack.push(typeof at === "string" && at in (list as Record<string, Json>)
            ? (list as Record<string, Json>)[at] ?? NIL
            : NIL);
          break;
        }
        stack.push(
          !Array.isArray(list) || typeof at !== "number" || !Number.isInteger(at) ||
          at < 0 || at >= list.length
            ? NIL
            : list[at],
        );
        break;
      }
      case "LENGTH": {
        const value = pop();
        if (isMapValue(value)) {
          stack.push(Object.keys(value as Record<string, Json>).length);
          break;
        }
        stack.push(typeof value === "string" || Array.isArray(value) ? value.length : NIL);
        break;
      }
      /* -1 for "not in the list" is the scalar VM's own answer (MethodId::ListIndexOf), so
         the two tiers spell a miss the same way. A Nil NEEDLE misses everything, including
         a gap in the list: the scalar tier's same_value calls two Nils identical, but a
         value that is not known is not a value to search for. */
      case "INDEX_OF": {
        const needle = pop();
        const list = pop();
        if (!Array.isArray(list)) { stack.push(NIL); break; }
        stack.push(nil(needle) ? -1 : list.findIndex((elem) => elem === needle));
        break;
      }
      case "LIST_SUM": case "LIST_AVG": case "LIST_MAX": case "LIST_MIN": {
        const list = pop();
        if (!Array.isArray(list)) { stack.push(NIL); break; }
        if (!list.length) { stack.push(instr.op === "LIST_SUM" ? 0 : NIL); break; }
        let sum = 0;
        let low = 0;
        let high = 0;
        let ok = true;
        for (let at = 0; at < list.length && ok; at++) {
          const v = list[at];
          if (typeof v !== "number" || !Number.isFinite(v)) { ok = false; break; }
          sum += v;
          if (at === 0 || v < low) low = v;
          if (at === 0 || v > high) high = v;
        }
        stack.push(!ok ? NIL
                 : instr.op === "LIST_SUM" ? sum
                 : instr.op === "LIST_AVG" ? sum / list.length
                 : instr.op === "LIST_MAX" ? high : low);
        break;
      }
      /* a point of a path, in the fractions of the box the renderer draws in. Either
         coordinate missing makes the whole anchor Nil, which is the GAP a plot draws as a
         break in the line rather than as a point at zero (stage.ts). */
      case "ANCHOR": {
        const y = num(pop());
        const x = num(pop());
        stack.push(x === null || y === null ? NIL : { x, y });
        break;
      }
      case "ARG":
        stack.push(typeof instr.i === "number" ? args[instr.i] ?? NIL : NIL);
        break;
      /* THE ONE LOOP, over one list, running `body` per element. REDUCE takes its seed on
         top of the list (the emitter pushes the list, then the init); every other mode
         takes the list alone. What the body sees is `args`: [element, index], and for
         REDUCE [acc, element, index]. */
      case "ITERATE": {
        const mode = instr.mode ?? "";
        const seed = mode === "REDUCE" ? pop() : NIL;
        const list = pop();
        const body = Array.isArray(instr.body) ? instr.body : [];
        /* a mode this view does not know: fail as UNKNOWN before running a single body,
           never as a wrong picture */
        if (!ITERATE_MODES.has(mode)) return NIL;
        /* REDUCE is the one loop a MAP takes, per sorted key so the answer is the same
           on every view: the body sees [acc, key, value]. The other modes have no
           settled result shape over a map and the compiler refuses them. */
        if (mode === "REDUCE" && isMapValue(list)) {
          const keys = Object.keys(list).sort();
          const pairs = Math.min(keys.length, ITERATE_CAP);
          let acc = seed;
          for (let at = 0; at < pairs; at++)
            acc = exec(body, cells, [acc, keys[at], list[keys[at]] ?? NIL]);
          stack.push(acc);
          break;
        }
        if (!Array.isArray(list)) { stack.push(NIL); break; }
        const count = Math.min(list.length, ITERATE_CAP);
        if (mode === "REDUCE") {
          let acc = seed;
          for (let at = 0; at < count; at++) acc = exec(body, cells, [acc, list[at], at]);
          stack.push(acc);
          break;
        }
        const results: Json[] = [];
        for (let at = 0; at < count; at++) results.push(exec(body, cells, [list[at], at]));
        if (mode === "MAP") stack.push(results);
        else if (mode === "FILTER")
          stack.push(list.slice(0, count).filter((_, at) => truthy(results[at]) === true));
        else if (mode === "ANY") stack.push(results.some((r) => truthy(r) === true));
        else if (mode === "ALL") stack.push(results.every((r) => truthy(r) === true));
        else {
          /* SORT_BY: the ELEMENTS travel, ordered by the keys the body made, and the sort
             is stable -- equal keys leave the list in the order it arrived */
          const order = results.map((key, at) => ({ key, at }));
          order.sort((a, b) => keysBefore(a.key, b.key));
          stack.push(order.map((row) => list[row.at]));
        }
        break;
      }
      default:
        /* an opcode this view does not know: fail as UNKNOWN, never as a wrong pixel */
        return NIL;
    }
  }
  return stack.length ? stack[stack.length - 1] : NIL;
}

/* An attribute read as TEXT, or null where it is Nil. The num/bool/color coercers that
 * stood beside this went with the renderer that took their fallbacks; this one stays
 * because the interpreter itself needs it — STR, MEASURE and text-side ADD all render an
 * operand through it, so the two spellings of "make this a string" cannot disagree. */
export function attrText(value: Json): string | null {
  if (nil(value)) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

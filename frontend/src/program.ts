/* The attribute interpreter: a small stack machine over the programs the backend ships
 * in the registry. This is the one place a view computes anything, and it is rendering,
 * not truth: inputs are backend-authoritative slot values plus this view's own
 * interaction state, outputs are visual attributes only.
 *
 * Every operation is total. Nil (null) poisons: any operation on it yields Nil, and a
 * Nil attribute renders the UNKNOWN treatment rather than a fabricated value. */

import { Instr, Json, Program } from "./types.js";
import { parseRich, richUnits } from "./rich.js";

export type Cells = (cell: string) => Json;

const NIL: Json = null;

/* degrees, both ways: every trig opcode takes and returns degrees (docs/spec.md 6.2),
 * matching template.ts's polar() -- the ordinary trig functions themselves (sin(0) ==
 * 0, cos(0) == 1), with the "0 = up, clockwise" polar convention left to whoever calls
 * them, exactly as it is on the scalar tier (backend/src/vm/vm.cpp) */
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

/* draw.measure's estimator (template.ts's codeMeasure), ported rather than shared: the
 * constant (0.58 x size per average-char unit) is the SAME one drawText and richUnits
 * already use to fit rendered text, and the `code` part API's own draw.measure, so an
 * author's own layout arithmetic agrees with what actually renders. Splitting on "\n"
 * matches codeMeasure even though a template attribute rarely carries one. */
function measureText(text: string, size: number): number {
  if (!text.length) return 0;
  let longest = 0;
  for (const line of text.split("\n")) {
    const rich = parseRich(line);
    const units = rich ? richUnits(rich) : line.length;
    if (units > longest) longest = units;
  }
  return 0.58 * size * longest;
}

export function run(program: Program | undefined, cells: Cells): Json {
  if (!program || !Array.isArray(program.code)) return NIL;
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

  for (const instr of program.code as Instr[]) {
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
        /* `+` CONCATENATES when either side is text (docs/spec.md 6.2), rendering the
         * other operand the way str()/attrText() renders it -- a number as its plain
         * string, a bool as true/false -- so the two spellings can never disagree.
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
        /* every channel FRACTIONAL 0..1 (docs/spec.md 6.2), pushed r, g, b, a in that
           order (template_expr.cpp defaults the 4th to 1 when a call omits it) */
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
      default:
        /* an opcode this view does not know: fail as UNKNOWN, never as a wrong pixel */
        return NIL;
    }
  }
  return stack.length ? stack[stack.length - 1] : NIL;
}

/* typed reads of one attribute, with the fallback a renderer wants when it is Nil */
export function attrNum(value: Json, fallback: number): number {
  const n = num(value);
  return n === null ? fallback : n;
}

export function attrText(value: Json): string | null {
  if (nil(value)) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

export function attrBool(value: Json, fallback: boolean): boolean {
  const t = truthy(value);
  return t === null ? fallback : t;
}

export function attrColor(value: Json): string | null {
  return typeof value === "string" && value.startsWith("#") ? value : null;
}

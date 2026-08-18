/* THE SECOND INTERPRETER. The backend ships view programs as the language's one
 * instruction form, packed (types.ts Program): four plain words per instruction whose
 * ordinals are the generated vocabulary in ir.ts — the same table the backend's own
 * enums are emitted from — so there is no dialect to translate, only the IR to run.
 * This is the one place a view computes anything, and it is rendering, not truth:
 * inputs are backend-authoritative slot values plus this view's own interaction
 * state, outputs are visual attributes only.
 *
 * THE VIEW HOST is the one verb a program runs over: `load` answers a symbolic cell
 * by its address-table spelling ("slot:...", "var:<id>", "time:now", ...). What the
 * host does BESIDE answering is its own business — the renderer's host records every
 * key it answers (the deps/marks that make a live delta re-run exactly the binds
 * that read it), the conformance runner's is a plain map. The interpreter stays
 * semantics-only, which is what lets one fixture suite pin it against the backend VM
 * (the first interpreter, backend/src/vm/vm.cpp) forever.
 *
 * A view program never stores, sends or faults — the placement rule keeps effects on
 * the backend — so `load` plus the pure ops IS the complete implementation, and
 * every operation is total. Nil (null) poisons: any operation on it yields Nil, and
 * a Nil attribute renders the UNKNOWN treatment rather than a fabricated value. An
 * instruction this view has no case for — a Store a bug routed here, an ordinal from
 * a future table — fails the whole program as UNKNOWN, never as a wrong pixel. */

import { BuiltinId, IterateMode, LoadPlace, MethodId, Op } from "./ir.js";
import { Json, Program } from "./types.js";

/* the ViewHost's one verb: answer a cell by its served spelling */
export type ViewHost = (cell: string) => Json;

const NIL: Json = null;

/* degrees, both ways: every trig id takes and returns degrees, the project-wide angle
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
 * here since the caller (Hsv below) already clamped it via channelByte */
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

/* Measure's estimator: 0.58 x size per character, the constant the SVG renderer used to
 * fit text into a box. It is a guess and always was — it cannot see the font, so it cannot
 * be right — and it is PROVISIONAL here: the whole reason a declarative renderer needed an
 * estimator is that it could not ask the browser. Once text is real DOM the browser
 * measures it, and this collapses into asking. It stays meanwhile so an expression using
 * measure() keeps computing something rather than failing. */
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

/* nothing outside an Iterate body has bindings to read, so LoadX there is Nil */
const NO_ARGS: Json[] = [];

/* a MAP value in this tier is a plain object (the aggs lane delivers it as one). The
   other objects this tier passes around -- anchors, timer records -- never legally meet
   the list vocabulary; the compiler is what keeps them apart, so this only has to tell
   a map from a scalar and a list. */
function isMapValue(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* the ordering SortBy imposes on the keys a body produced: numbers first and ascending,
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

export function run(program: Program | undefined, load: ViewHost): Json {
  if (!program || !Array.isArray(program.i)) return NIL;
  return exec(program, program.i, load, NO_ARGS);
}

/* the whole-program poison: what exec returns through when an instruction has no
 * case here, so a malformed or future program fails as UNKNOWN, never as a wrong
 * pixel. A unique object so no legal Json can collide with it. */
const POISONED: Json = Symbol("poisoned");

/* One run of one instruction list. The body of an Iterate is a sub-program sharing
 * this program's pools, so it runs here too, on its own stack, with the loop's
 * per-element bindings in `args` (what LoadX reads — the same registers the scalar
 * VM's Iterate seeds). */
function exec(program: Program, code: number[], load: ViewHost, args: Json[]): Json {
  const stack: Json[] = [];
  const pop = (): Json => (stack.length ? stack.pop() : NIL);
  const consts = program.k ?? [];
  const cells = program.c ?? [];

  /* Add is handled in its own case (text concatenation needs the raw, un-num()'d
     operands to tell a string apart from a number); these are the numeric pairs */
  const arith = (op: number): Json => {
    const b = num(pop());
    const a = num(pop());
    if (a === null || b === null) return NIL;
    switch (op) {
      case Op.Sub: return a - b;
      case Op.Mul: return a * b;
      case Op.Div: return b === 0 ? NIL : a / b;
      case Op.Mod: return b === 0 ? NIL : a % b;
      case Op.Lt: return a < b;
      case Op.Le: return a <= b;
      case Op.Gt: return a > b;
      case Op.Ge: return a >= b;
    }
    return NIL;
  };

  const end = code.length - (code.length % 4);
  for (let pc = 0; pc < end; ) {
    const op = code[pc];
    const small = code[pc + 1];
    const a = code[pc + 2];
    const b = code[pc + 3];
    pc += 4;
    switch (op) {
      case Op.Const:
        stack.push(consts[a] === undefined ? NIL : consts[a]);
        break;
      case Op.Load:
        /* the one place a value enters: the host answers the address-table cell
           (and records the read, if answering is not all it does) */
        stack.push(small === LoadPlace.Cell ? load(cells[a] ?? "") : NIL);
        break;
      /* a lambda binding, by declaration order — [element, index] for the plain
         modes, [acc, element, index] for reduce */
      case Op.LoadX:
        stack.push(args[a] ?? NIL);
        break;
      /* the two jumps `??` lowers to, FORWARD ONLY here as in the verifier: a
         backward target would be a hung frame, so it poisons instead */
      case Op.Jmp:
        if (a * 4 < pc) return NIL;
        pc = a * 4;
        break;
      /* the unknown test: when the top is Nil, pop it and jump (to the default's
         start); otherwise keep it and fall through (past the default) */
      case Op.JmpNil:
        if (stack.length && nil(stack[stack.length - 1])) {
          if (a * 4 < pc) return NIL;
          stack.pop();
          pc = a * 4;
        }
        break;
      case Op.Add: {
        /* `+` CONCATENATES when either side is text — the language's own rule on both
         * tiers, not a view convenience — rendering the other operand the way
         * str()/attrText() renders it -- a number as its plain string, a bool as
         * true/false -- so the two spellings can never disagree.
         * Numeric addition is unchanged: neither side being a string is the ordinary
         * case and falls straight through to the arith path. */
        const right = pop();
        const left = pop();
        if (typeof left === "string" || typeof right === "string") {
          const tl = attrText(left);
          const tr = attrText(right);
          stack.push(tl === null || tr === null ? NIL : tl + tr);
        } else {
          const ln = num(left);
          const rn = num(right);
          stack.push(ln === null || rn === null ? NIL : ln + rn);
        }
        break;
      }
      case Op.Sub: case Op.Mul: case Op.Div: case Op.Mod:
      case Op.Lt: case Op.Le: case Op.Gt: case Op.Ge:
        stack.push(arith(op));
        break;
      case Op.Neg: {
        const value = num(pop());
        stack.push(value === null ? NIL : -value);
        break;
      }
      case Op.Eq: case Op.Ne: {
        const right = pop();
        const left = pop();
        if (nil(left) || nil(right)) { stack.push(NIL); break; }
        const equal = left === right;
        stack.push(op === Op.Eq ? equal : !equal);
        break;
      }
      case Op.Not: {
        const value = truthy(pop());
        stack.push(value === null ? NIL : !value);
        break;
      }
      /* the elements were pushed left to right, so the tail of the stack IS the list in
         order; a Nil among them stays exactly where it was pushed */
      case Op.MakeList: {
        const take = Math.min(b, stack.length);
        stack.push(stack.splice(stack.length - take, take));
        break;
      }
      case Op.Index: {
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
      case Op.Call: {
        const value = call(small, b, stack);
        if (value === POISONED) return NIL;
        stack.push(value);
        break;
      }
      case Op.Method: {
        const value = method(small, b, stack);
        if (value === POISONED) return NIL;
        stack.push(value);
        break;
      }
      case Op.Iterate: {
        const value = iterate(program, small, a, b, load, stack);
        if (value === POISONED) return NIL;
        stack.push(value);
        break;
      }
      default:
        /* an instruction this view has no case for: fail as UNKNOWN, never as a
           wrong pixel */
        return NIL;
    }
  }
  return stack.length ? stack[stack.length - 1] : NIL;
}

/* one Call: `id` from the shared table, `argc` popped above nothing else (a builtin
 * has no receiver). An id with no case here is the whole-program poison. */
function call(id: number, argc: number, stack: Json[]): Json {
  const args = stack.splice(Math.max(0, stack.length - argc), argc);
  while (args.length < argc) args.unshift(NIL);
  const one = (): number | null => num(args[0]);
  const pair = (): [number, number] | null => {
    const a = num(args[0]);
    const b = num(args[1]);
    return a === null || b === null ? null : [a, b];
  };
  switch (id) {
    case BuiltinId.Abs: { const a = one(); return a === null ? NIL : Math.abs(a); }
    case BuiltinId.Round: { const a = one(); return a === null ? NIL : Math.round(a); }
    case BuiltinId.Floor: { const a = one(); return a === null ? NIL : Math.floor(a); }
    case BuiltinId.Ceil: { const a = one(); return a === null ? NIL : Math.ceil(a); }
    case BuiltinId.Int: { const a = one(); return a === null ? NIL : Math.trunc(a); }
    case BuiltinId.Sqrt: {
      const a = one();
      return a === null || a < 0 ? NIL : Math.sqrt(a);
    }
    /* ordinary trig, degrees in and out (see DEG above): sin(0) === 0, cos(0) === 1 */
    case BuiltinId.Sin: { const a = one(); return a === null ? NIL : Math.sin(a * DEG); }
    case BuiltinId.Cos: { const a = one(); return a === null ? NIL : Math.cos(a * DEG); }
    case BuiltinId.Tan: { const a = one(); return a === null ? NIL : Math.tan(a * DEG); }
    case BuiltinId.Asin: {
      const a = one();
      return a === null || a < -1 || a > 1 ? NIL : Math.asin(a) / DEG;
    }
    case BuiltinId.Acos: {
      const a = one();
      return a === null || a < -1 || a > 1 ? NIL : Math.acos(a) / DEG;
    }
    case BuiltinId.Pow: { const p = pair(); return p === null ? NIL : Math.pow(p[0], p[1]); }
    case BuiltinId.Min: { const p = pair(); return p === null ? NIL : Math.min(p[0], p[1]); }
    case BuiltinId.Max: { const p = pair(); return p === null ? NIL : Math.max(p[0], p[1]); }
    case BuiltinId.Atan2: {
      /* atan2(y, x) -- the same argument order the scalar tier's Builtin::Atan2 takes */
      const p = pair();
      return p === null ? NIL : Math.atan2(p[0], p[1]) / DEG;
    }
    case BuiltinId.Rgb: case BuiltinId.Hsv: {
      /* every channel FRACTIONAL 0..1 — the convention rgb()/hsv() take on both
         tiers, never 0..255 — with the alpha argument optional (argc 3), defaulting
         to fully opaque, exactly as the scalar builtin accepts it */
      const c1 = num(args[0]);
      const c2 = num(args[1]);
      const c3 = num(args[2]);
      const alpha = argc === 4 ? num(args[3]) : 1;
      if (c1 === null || c2 === null || c3 === null || alpha === null) return NIL;
      return id === BuiltinId.Rgb
        ? packRgba(c1 * 255, c2 * 255, c3 * 255, alpha)
        : hsvToRgba(c1, c2, c3, alpha);
    }
    case BuiltinId.Str: {
      const text = attrText(args[0]);
      return text === null ? NIL : text;
    }
    /* the unknown test: the one operation that ASKS about Nil */
    case BuiltinId.Known:
      return !nil(args[0]);
    case BuiltinId.Measure: {
      const text = attrText(args[0]);
      const size = num(args[1]);
      return text === null || size === null ? NIL : measureText(text, size);
    }
    /* a point of a path, in the fractions of the box the renderer draws in. Either
       coordinate missing makes the whole anchor Nil, which is the GAP a plot draws as
       a break in the line rather than as a point at zero (stage.ts). */
    case BuiltinId.Anchor: {
      const x = num(args[0]);
      const y = num(args[1]);
      return x === null || y === null ? NIL : { x, y };
    }
    default:
      return POISONED;
  }
}

/* one Method: the receiver sits below `argc` arguments. The length family is
 * receiver-blind — the untyped emitter picks whichever namesake id comes first, and
 * text, list and map all answer under any of the three. */
function method(id: number, argc: number, stack: Json[]): Json {
  const args = stack.splice(Math.max(0, stack.length - argc), argc);
  while (args.length < argc) args.unshift(NIL);
  const receiver = stack.length ? stack.pop() : NIL;
  switch (id) {
    case MethodId.BoolPick: {
      const c = truthy(receiver);
      return c === null ? NIL : c ? args[0] : args[1];
    }
    case MethodId.NumSign: {
      const a = num(receiver);
      return a === null ? NIL : Math.sign(a);
    }
    case MethodId.NumToFixed: {
      const a = num(receiver);
      const dp = num(args[0]);
      return a === null ? NIL : a.toFixed(Math.max(0, Math.min(12, dp ?? 0)));
    }
    case MethodId.ColorR: case MethodId.ColorG:
    case MethodId.ColorB: case MethodId.ColorA: {
      const bytes = parseColorBytes(receiver);
      if (!bytes) return NIL;
      return id === MethodId.ColorR ? bytes[0]
           : id === MethodId.ColorG ? bytes[1]
           : id === MethodId.ColorB ? bytes[2] : bytes[3] / 255;
    }
    case MethodId.ColorAlpha: {
      const bytes = parseColorBytes(receiver);
      const alpha = num(args[0]);
      if (!bytes || alpha === null) return NIL;
      const aa = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
      return formatRgba(bytes[0], bytes[1], bytes[2], channelByte(aa * 255));
    }
    case MethodId.ColorMix: {
      const from = parseColorBytes(receiver);
      const to = parseColorBytes(args[0]);
      const t = num(args[1]);
      return !from || !to || t === null ? NIL : mixRgba(from, to, t);
    }
    case MethodId.TextLength: case MethodId.ListLength: case MethodId.MapLength: {
      if (isMapValue(receiver)) return Object.keys(receiver).length;
      return typeof receiver === "string" || Array.isArray(receiver)
        ? receiver.length
        : NIL;
    }
    /* -1 for "not in the list" is the scalar VM's own answer (MethodId::ListIndexOf), so
       the two tiers spell a miss the same way. A Nil NEEDLE misses everything, including
       a gap in the list: the scalar tier's same_value calls two Nils identical, but a
       value that is not known is not a value to search for. */
    case MethodId.ListIndexOf: {
      if (!Array.isArray(receiver)) return NIL;
      const needle = args[0];
      return nil(needle) ? -1 : receiver.findIndex((elem) => elem === needle);
    }
    case MethodId.ListSum: case MethodId.ListAvg:
    case MethodId.ListMax: case MethodId.ListMin: {
      if (!Array.isArray(receiver)) return NIL;
      if (!receiver.length) return id === MethodId.ListSum ? 0 : NIL;
      let sum = 0;
      let low = 0;
      let high = 0;
      for (let at = 0; at < receiver.length; at++) {
        const v = receiver[at];
        if (typeof v !== "number" || !Number.isFinite(v)) return NIL;
        sum += v;
        if (at === 0 || v < low) low = v;
        if (at === 0 || v > high) high = v;
      }
      return id === MethodId.ListSum ? sum
           : id === MethodId.ListAvg ? sum / receiver.length
           : id === MethodId.ListMax ? high : low;
    }
    default:
      return POISONED;
  }
}

/* THE ONE LOOP, over one list, running sub-program `sub` once per element. Reduce
 * takes its seed on top of the list (the emitter pushes the list, then the init);
 * every other mode takes the list alone. What the body sees is its LoadX bindings:
 * [element, index], and for reduce [acc, element, index] — over a map, reduce reads
 * [acc, key, value], per sorted key so the answer is the same on every view. `bound`
 * is the trip bound the emitter served: past it the loop simply stops, bounded work
 * and a short answer rather than a hung frame. */
function iterate(program: Program, mode: number, sub: number, bound: number,
                 load: ViewHost, stack: Json[]): Json {
  const body = program.s?.[sub];
  if (!Array.isArray(body)) return POISONED;
  const seed = mode === IterateMode.Reduce ? (stack.length ? stack.pop() : NIL) : NIL;
  const list = stack.length ? stack.pop() : NIL;
  /* Reduce is the one loop a MAP takes: the body sees [acc, key, value]. The other
     modes have no settled result shape over a map and the compiler refuses them. */
  if (mode === IterateMode.Reduce && isMapValue(list)) {
    const keys = Object.keys(list).sort();
    const pairs = Math.min(keys.length, bound);
    let acc = seed;
    for (let at = 0; at < pairs; at++)
      acc = exec(program, body, load, [acc, keys[at], list[keys[at]] ?? NIL]);
    return acc;
  }
  if (!Array.isArray(list)) return NIL;
  const count = Math.min(list.length, bound);
  if (mode === IterateMode.Reduce) {
    let acc = seed;
    for (let at = 0; at < count; at++) acc = exec(program, body, load, [acc, list[at], at]);
    return acc;
  }
  if (mode !== IterateMode.Map && mode !== IterateMode.Filter &&
      mode !== IterateMode.Any && mode !== IterateMode.All &&
      mode !== IterateMode.SortBy)
    return POISONED;
  const results: Json[] = [];
  for (let at = 0; at < count; at++) results.push(exec(program, body, load, [list[at], at]));
  /* the CONDITION modes hold the one unknown rule: a Nil body result poisons
     the whole answer instead of quietly reading as false — the scalar VM's
     exact behavior, pinned by the shared fixtures */
  if ((mode === IterateMode.Filter || mode === IterateMode.Any ||
       mode === IterateMode.All) &&
      results.some((r) => nil(r)))
    return NIL;
  if (mode === IterateMode.Map) return results;
  if (mode === IterateMode.Filter)
    return list.slice(0, count).filter((_, at) => truthy(results[at]) === true);
  if (mode === IterateMode.Any) return results.some((r) => truthy(r) === true);
  if (mode === IterateMode.All) return results.every((r) => truthy(r) === true);
  /* SortBy: the ELEMENTS travel, ordered by the keys the body made, and the sort
     is stable -- equal keys leave the list in the order it arrived */
  const order = results.map((key, at) => ({ key, at }));
  order.sort((a, b) => keysBefore(a.key, b.key));
  return order.map((row) => list[row.at]);
}

/* An attribute read as TEXT, or null where it is Nil. The num/bool/color coercers that
 * stood beside this went with the renderer that took their fallbacks; this one stays
 * because the interpreter itself needs it — Str, Measure and text-side Add all render an
 * operand through it, so the two spellings of "make this a string" cannot disagree. */
export function attrText(value: Json): string | null {
  if (nil(value)) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

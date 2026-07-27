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

export function run(program: Program | undefined, cells: Cells): Json {
  if (!program || !Array.isArray(program.code)) return NIL;
  const stack: Json[] = [];
  const pop = (): Json => (stack.length ? stack.pop() : NIL);

  const arith = (op: string): Json => {
    const b = num(pop());
    const a = num(pop());
    if (a === null || b === null) return NIL;
    switch (op) {
      case "ADD": return a + b;
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
      case "ADD": case "SUB": case "MUL": case "DIV":
      case "LT": case "LE": case "GT": case "GE":
        stack.push(arith(instr.op));
        break;
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
      case "TO_FIXED": {
        const dp = num(pop());
        const a = num(pop());
        stack.push(a === null ? NIL : a.toFixed(Math.max(0, Math.min(12, dp ?? 0))));
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

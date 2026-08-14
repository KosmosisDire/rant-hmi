#!/usr/bin/env node
/* THE IR TABLE — the one authority for the language's opcode, clock-field,
 * iterate-mode, builtin and method vocabularies.
 *
 * Emits, from the tables below:
 *   backend/src/lang/ir_ops.h   the C++ enums and the name tables beside them
 *   frontend/src/ir.ts          the view's copy of the shared vocabulary
 *
 * Run with no arguments to regenerate both files in place; run with --check to
 * verify the checked-in files match what the tables emit, byte for byte (the
 * `ir_gen` ctest). The old contract — "appended only: the frontend mirrors these
 * ids by hand" — is dead: both sides are emitted from this one table, and a
 * hand edit to either generated file fails the check.
 *
 * Spellings are derived mechanically: an entry named LoadX disassembles as
 * LOAD_X, an iterate mode SortBy rides the wire as SORT_BY. A `c` field is the
 * entry's comment, emitted verbatim above it. */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------------------------------------------------------------- the tables */

/* One wart, named rather than hidden: OpCode carries both banks (spec 5.4) — the
 * expression opcodes the language emits, and the EFFECT opcodes (MoveOut, CallEnt,
 * TmrStart, Suspend, Fault, Halt) that only the DO-list lowering in compile/ emits and
 * only the VM executes. Splitting the enum means touching the VM's dispatch switch and
 * Instruction's encoding for no behavioural gain, so the language declares opcodes it
 * never emits. */
const OPS = [
  { name: "Const" },
  { name: "LoadX" },
  { name: "Load" },
  { name: "LoadField" },
  { name: "Add" },
  { name: "Sub" },
  { name: "Mul" },
  { name: "Div" },
  { name: "Mod" },
  { name: "Neg" },
  { name: "Eq" },
  { name: "Ne" },
  { name: "Lt" },
  { name: "Le" },
  { name: "Gt" },
  { name: "Ge" },
  { name: "Not" },
  { name: "Jmp" },
  { name: "JmpFalse" },
  { name: "Call" },
  { name: "Method" },
  { name: "StoreX" },
  { name: "Gate" },
  { name: "Deadband" },
  { name: "Throttle" },
  { name: "Suspend" },
  {
    name: "New",
    c: `the move step's four forms (spec 5.4). New and ReadEnt fill a struct cell;
StoreField sets one field of one; MoveOut emits the effect. A move into a scalar
cell is an ordinary expression plus Store, so it needs no opcode of its own.`,
  },
  { name: "ReadEnt" },
  { name: "LoadEnt" },
  { name: "StoreField" },
  { name: "MoveOut" },
  { name: "Store" },
  { name: "TmrStart" },
  { name: "TmrCancel" },
  { name: "Fault" },
  { name: "Halt" },
  { name: "Index" },
  {
    name: "EnumFromName",
    c: `text -> the enum value whose variant name it is, over the type table entry in
\`b\`: the compile-inserted coercion at a move into an enum-typed field, so a
Dropdown's selected name writes back with no authored transform (spec 6.2)`,
  },
  {
    name: "JmpNil",
    c: `pop; jump to \`a\` when it was Nil: a cased feed's bail-out, so an UNKNOWN input
stores UNKNOWN instead of faulting its way down the arms (spec 2.4)`,
  },
  {
    name: "TmrRead",
    c: `push one FIELD of timer \`a\` from the timer table (\`b\`: 0 running, 1 remaining
seconds, 2 duration seconds): expressions read a timer only by field, the way
\`myTimer.remaining\` spells it; the state lives beside the cells, not in one`,
  },
  {
    name: "MakeList",
    c: `pop \`b\` values (pushed left to right) into a fresh element run and push the
list: the \`[a, b, c]\` array literal, how an expression builds a list without
reading one. A Nil element stays Nil (a gap is a value), it does not poison the
whole list.`,
  },
  {
    name: "Iterate",
    c: `The ONE iterating opcode (spec 6.4): pop a list, run sub-program \`a\` once per
element with that element bound as the body's parameter, and push the result the
mode in \`small\` asks for. \`b\` is the TRIP BOUND taken from the schema at compile,
so the worst-case step count of the whole program stays computable and this is
still not a loop in any sense the determinism checklist (5.10) forbids.

One opcode rather than five because the modes differ only in what they do with
each body result, and a single VM case keeps the sub-program plumbing -- the
stack frame, the trip bound, the element window -- written once.`,
  },
  {
    name: "Append",
    c: `APPEND ONE ELEMENT to list cell \`a\` (\`b\`: the fault site). The stack reads
[value, keep] -- keep comes off first, having been pushed last. A non-Nil keep
trims the front to that many elements, which is what makes a history ring one
authored step instead of a privileged machine; a Nil keep means unbounded, and
the append REFUSES at the retained ceiling rather than growing forever. The one
verb that changes a list without replacing it.`,
  },
  {
    name: "StoreKey",
    c: `WRITE ONE KEY of map cell \`a\` (\`b\`: the fault site). The stack reads [value, key]
-- key comes off first. A Nil value ERASES the key: a map has no other removal
verb, and "this key holds UNKNOWN" and "this key is absent" would otherwise be two
spellings of one thing. Keys stay sorted, so iteration is replay-deterministic.`,
  },
  {
    name: "LoadArg",
    c: `push EVENT PARAMETER \`a\` (state.args): what the triggering event passed in, bound
by the parameter's declared name at compile. State-resident rather than a run_code
register so a lambda body can read it without colliding with its own x2/x3.`,
  },
  {
    name: "Raise",
    c: `RAISE the event in Program.raises[\`a\`] (\`b\`: 1 = pop one argument value off the
stack, 0 = nullary; \`c\`: the fault site for a full raise buffer). The record is
queued on the state and the scheduler dispatches it AFTER this run halts — a raise
never re-enters the VM under the raising flow.`,
  },
  {
    name: "ClockRead",
    c: `push CLOCK FIELD \`a\` (a ClockField below): \`time.now\` is seconds since the program
started (the tick counter, so replay stays deterministic), everything else is the
wall clock the scheduler stamped at the top of this tick — one sample per tick, so
a run can never see the second flip under it. The two TEXT fields render into the
fixed slot \`b\` reserved at compile, like any text-producing site.`,
  },
  {
    name: "RepeatRead",
    c: `push REPEAT FIELD \`a\` (0 = index, 1 = count, 2 = fraction) of the copy the running
event arrived on, or Nil where no copy is behind this run. A repeated element is
ONE element the backend holds one set of cells for, so the copy is an index that
rides the input frame rather than storage — which is what makes
\`@arr[repeat.index] = x\` write the pressed copy's own element. Shaped exactly like
ClockRead: a field read off the state with no operand of its own.`,
  },
  {
    name: "Notify",
    c: `NOTIFY every connected view (\`b\`: 1 = pop an explicit ms duration first, 0 =
the view derives one from the message's length; \`c\`: the fault site). Pops the
message, renders it as str() renders any scalar, and queues a NoticeRecord the
App drains after the tick and broadcasts — the VM never sees a session.`,
  },
  {
    name: "StoreIndex",
    c: `WRITE ONE INDEX of list cell \`a\` (\`b\`: the fault site). The stack reads
[value, index] -- the index was pushed last, so it comes off first. The index
must land inside the list (0..count-1): an element write EDITS, it never grows —
growth is Append's verb — so a miss is a fault, not a silent extension. A Nil
value STORES as Nil (a gap is a value; a list has no positional erase). To the
wire an in-place edit is a discontinuity: the aggs lane speaks appends, so the
generation moves and the window resends whole.`,
  },
  {
    name: "MoveOutElem",
    c: `WRITE ONE ELEMENT of a mesh entity's array field: entity \`a\`, field \`b\`,
verb in \`small\`, fault site in \`c\`. The stack reads [value, index], index off
first, exactly as StoreIndex. The effect carries the element position and the
encode side rewrites that one element over the owner's own bytes (RMW), so the
rest of the array is preserved untouched; an index past the owner's live count
is refused at the encode, never a grow.`,
  },
  {
    name: "MarkField",
    c: `MARK FIELD \`b\` of struct cell \`a\` as SET and refresh its handle. Emitted after
every write that lands in a struct value's aggregate-field DERIVED CELL: the
field's storage is that cell (Program.struct_field_cells maps it), but the
struct's own set-bit — what decides whether a move out carries our elements or
the RMW base keeps the owner's — lives on the StructState, and the Store family
has no operand room to reach it. Pops nothing.`,
  },
];

/* the fields `time` reads by — ONE table, so the scalar tier's bindings, the template
 * tier's vocabulary, the VM's dispatch and the view's scope offering can never drift */
const CLOCK_FIELDS = [
  { name: "Now", field: "now", shape: "Num", c: "seconds since the HMI started, fractional: the animation clock" },
  { name: "Unix", field: "unix", shape: "Num", c: "whole seconds since the epoch" },
  { name: "Year", field: "year", shape: "Num" },
  { name: "Month", field: "month", shape: "Num", c: "1..12" },
  { name: "Day", field: "day", shape: "Num", c: "1..31" },
  { name: "Weekday", field: "weekday", shape: "Num", c: "0 = Sunday .. 6 = Saturday" },
  { name: "Hour", field: "hour", shape: "Num", c: "0..23" },
  { name: "Minute", field: "minute", shape: "Num" },
  { name: "Second", field: "second", shape: "Num" },
  { name: "Text", field: "text", shape: "Text", c: '"HH:MM:SS", local time' },
  { name: "Date", field: "date", shape: "Text", c: '"YYYY-MM-DD", local time' },
];

/* what Iterate does with each element's body result (rides Instruction::small);
 * `call` is the method name both surface grammars spell it by */
const ITERATE_MODES = [
  { name: "Map", call: "map", c: "the body result becomes the element        -> list" },
  { name: "Filter", call: "filter", c: "keep the element where the body is true    -> list" },
  { name: "Any", call: "any", c: "true if the body is true for any element   -> bool" },
  { name: "All", call: "all", c: "true if the body is true for every element -> bool" },
  { name: "SortBy", call: "sortBy", c: "order the elements by the body's value     -> list" },
  {
    name: "Reduce",
    call: "reduce",
    c: `fold: the body takes the accumulator and the element and returns the next
accumulator, starting from the initial value the call's second argument pushed.
The one mode that consumes TWO stack operands (list then init) and the one whose
result shape is the body's rather than the receiver's.`,
  },
];

const BUILTINS = [
  { name: "Clamp" },
  { name: "MapRange" },
  { name: "RoundTo" },
  { name: "Lerp" },
  { name: "Abs" },
  { name: "Round" },
  { name: "Floor" },
  { name: "Ceil" },
  { name: "Sqrt" },
  { name: "Pow" },
  { name: "Min" },
  { name: "Max" },
  { name: "Int" },
  { name: "Num" },
  { name: "Rgb" },
  { name: "Hsv" },
  { name: "Str" },
  { name: "Name" },
  { name: "FmtTime" },
  { name: "FmtDuration" },
  { name: "Color" },
  { name: "Jet" },
  { name: "Hot" },
  { name: "CoolWarm" },
  { name: "Viridis" },
  { name: "Grayscale" },
  { name: "Values" },
  { name: "Keys" },
  { name: "Invert" },
  {
    name: "Sin",
    c: `ordinary trigonometry, degrees in and out (the project-wide angle convention):
both tiers gain these together, which is the piece that unblocks authoring a
needle's capsule or an arc's annular sector as arithmetic instead of a hard-coded
draw kind`,
  },
  { name: "Cos" },
  { name: "Tan" },
  { name: "Asin" },
  { name: "Acos" },
  { name: "Atan2" },
];

const METHODS = [
  { name: "NumRound" },
  { name: "NumFloor" },
  { name: "NumCeil" },
  { name: "NumAbs" },
  { name: "NumClamp" },
  { name: "NumMapRange" },
  { name: "NumSign" },
  { name: "BoolInt" },
  { name: "BoolNot" },
  { name: "BoolPick" },
  { name: "ColorR" },
  { name: "ColorG" },
  { name: "ColorB" },
  { name: "ColorA" },
  { name: "ColorAlpha" },
  { name: "ColorMix" },
  { name: "NumToFixed" },
  { name: "TextLength" },
  { name: "TextUpper" },
  { name: "TextLower" },
  { name: "TextTitle" },
  { name: "TextTrim" },
  { name: "TextSlice" },
  { name: "TextStartsWith" },
  { name: "TextEndsWith" },
  { name: "TextContains" },
  { name: "TextReplace" },
  { name: "TextPadStart" },
  { name: "EnumInt" },
  { name: "EnumName" },
  { name: "TextSplit" },
  { name: "ListLength" },
  { name: "ListFirst" },
  { name: "ListLast" },
  { name: "ListSum" },
  { name: "ListAvg" },
  { name: "ListMax" },
  { name: "ListMin" },
  { name: "ListJoin" },
  { name: "ListSort" },
  { name: "ListReverse" },
  { name: "ListSlice" },
  { name: "ListContains" },
  { name: "ListIndexOf" },
  { name: "MapLength" },
  { name: "MapKeys" },
  { name: "MapValues" },
  { name: "MapHas" },
  { name: "MapGet" },
  {
    name: "TextConcat",
    c: `\`a + b\` with a text operand (display tier): both sides rendered as str() would
render them, joined into the site's own slot`,
  },
  {
    name: "ColorScale",
    c: `color channel arithmetic: \`color * n\` / \`color / n\` scale r,g,b (alpha kept),
\`.invert()\` flips them`,
  },
  { name: "ColorDiv" },
  { name: "ColorInvert" },
];

/* ------------------------------------------------------------- the emitters */

/* LoadX -> LOAD_X, SortBy -> SORT_BY, Atan2 -> ATAN2 */
function snake(name) {
  return name.replace(/(?<=.)[A-Z]/g, "_$&").toUpperCase();
}

/* an entry comment as C, at the given indent */
function cComment(text, indent) {
  const lines = text.split("\n");
  if (lines.length === 1) return `${indent}/* ${lines[0]} */\n`;
  let out = `${indent}/* ${lines[0]}\n`;
  for (const line of lines.slice(1))
    out += line === "" ? `${indent} *\n` : `${indent} * ${line}\n`;
  return out + `${indent} */\n`;
}

function cEnum(name, base, rows) {
  let out = `enum class ${name} : ${base} {\n`;
  for (const row of rows) {
    if (row.c) out += cComment(row.c, "    ");
    out += `    ${row.name},\n`;
  }
  return out + `};\n`;
}

function emitOpsH() {
  let out = `/* GENERATED by tools/gen_ir.mjs — DO NOT EDIT. Edit the tables there and
 * regenerate; the ir_gen ctest fails on any drift between this file and them.
 *
 * The enums and name tables of the language's instruction form. ir.h wraps this
 * with the ceilings and the Instruction struct; the frontend's copy of the same
 * vocabulary (frontend/src/ir.ts) is emitted from the same tables. */
#pragma once

#include "lang/value.h"

#include <cstdint>

namespace hmi {

`;
  out += cEnum("OpCode", "uint8_t", OPS);
  out += `
/* the disassembly spelling of every opcode, derived from the enum names */
constexpr const char* kOpNames[] = {
`;
  for (const op of OPS) out += `    "${snake(op.name)}",\n`;
  out += `};

inline const char* op_name(OpCode op) {
    const auto index = static_cast<size_t>(op);
    return index < sizeof(kOpNames) / sizeof(kOpNames[0]) ? kOpNames[index] : "?";
}

/* the fields \`time\` reads by — ONE table, so the scalar tier's bindings, the template
 * tier's vocabulary, the VM's dispatch and the view's scope offering can never drift */
`;
  out += cEnum(
    "ClockField",
    "uint16_t",
    CLOCK_FIELDS.map((f) => ({ name: f.name, c: f.c })),
  );
  out += `
struct ClockFieldDef {
    const char* name;
    Shape shape;
};

constexpr ClockFieldDef kClockFields[] = {
`;
  for (const f of CLOCK_FIELDS) out += `    {"${f.field}", Shape::${f.shape}},\n`;
  out += `};

/* what Iterate does with each element's body result (rides Instruction::small) */
`;
  out += cEnum(
    "IterateMode",
    "uint16_t",
    ITERATE_MODES.map((m) => ({ name: m.name, c: m.c })),
  );
  out += `
/* the iterating methods by the name both surface grammars spell them, each with
 * its wire spelling (the view dialect's ITERATE mode) */
struct IterateModeDef {
    const char* call;
    const char* wire;
};

constexpr IterateModeDef kIterateModes[] = {
`;
  for (const m of ITERATE_MODES) out += `    {"${m.call}", "${snake(m.name)}"},\n`;
  out += `};

`;
  out += cEnum("Builtin", "uint16_t", BUILTINS);
  out += `
`;
  out += cEnum("MethodId", "uint16_t", METHODS);
  out += `
} // namespace hmi
`;
  return out;
}

function emitIrTs() {
  let out = `/* GENERATED by tools/gen_ir.mjs — DO NOT EDIT. Edit the tables there and
 * regenerate; the ir_gen ctest fails on any drift between this file and them.
 *
 * The view's copy of the shared vocabulary: what the backend can emit is what
 * these tables say, from the same source its own enums are emitted from. */

/* the ITERATE modes the view dialect can carry (program.ts) */
export const ITERATE_MODES = new Set<string>([
`;
  for (const m of ITERATE_MODES) out += `  "${snake(m.name)}",\n`;
  out += `]);

/* the fields \`time\` reads by (lang/ir.h kClockFields) */
export const TIME_FIELDS: { path: string; shape: string }[] = [
`;
  for (const f of CLOCK_FIELDS)
    out += `  { path: "${f.field}", shape: "${f.shape.toLowerCase()}" },\n`;
  out += `];
`;
  return out;
}

/* ------------------------------------------------------------------ driving */

const FILES = [
  { path: join(ROOT, "backend", "src", "lang", "ir_ops.h"), emit: emitOpsH },
  { path: join(ROOT, "frontend", "src", "ir.ts"), emit: emitIrTs },
];

const check = process.argv.includes("--check");
let drifted = false;
for (const file of FILES) {
  const wanted = file.emit();
  if (check) {
    let current = "";
    try {
      current = readFileSync(file.path, "utf8").replace(/\r\n/g, "\n");
    } catch {
      /* missing counts as drift */
    }
    if (current !== wanted) {
      console.error(`ir_gen: ${file.path} does not match the table`);
      drifted = true;
    }
  } else {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, wanted);
    console.log(`wrote ${file.path}`);
  }
}
if (check && drifted) process.exit(1);
if (check) console.log("ir_gen: generated files match the table");

#!/usr/bin/env node
/* THE IR TABLE — the one authority for the language's opcode, clock-field,
 * iterate-mode, builtin and method vocabularies.
 *
 * Emits, from the tables below:
 *   backend/src/lang/ir_ops.h      the C++ enums and the name tables beside them
 *   backend/src/lang/tables.inc    the builtin/method SIGNATURE rows tables.cpp
 *                                  builds its vocabulary tables from
 *   backend/src/registry/objects.h the host-object descriptors (the ambient
 *                                  by-field vocabularies, outside lang/)
 *   frontend/src/ir.ts             the view's copy of the shared vocabulary
 *
 * Run with no arguments to regenerate both files in place; run with --check to
 * verify the checked-in files match what the tables emit, byte for byte (the
 * `ir_gen` ctest). The old contract — "appended only: the frontend mirrors these
 * ids by hand" — is dead: both sides are emitted from this one table, and a
 * hand edit to either generated file fails the check.
 *
 * Spellings are derived mechanically: an entry named LoadX disassembles as
 * LOAD_X; everything crosses the wire as its plain ordinal. A `c` field is the
 * entry's comment, emitted verbatim above it. */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------------------------------------------------------------- the tables */

/* One wart, named rather than hidden: OpCode carries both banks (spec 5.4) — the
 * expression opcodes the language emits, and the EFFECT opcodes (Send, Park,
 * Fault, Halt) that only the DO-list lowering in compile/ emits and only the VM
 * executes. Splitting the enum means touching the VM's dispatch switch and
 * Instruction's encoding for no behavioural gain, so the language declares opcodes it
 * never emits. */
const OPS = [
  { name: "Const" },
  { name: "LoadX" },
  {
    name: "Load",
    c: `THE ONE LOAD (stage 6c): push what a PLACE holds, the place riding \`small\`
(a LoadPlace). Cell reads cell \`a\` whole; Field reads field \`b\` of struct
cell \`a\`; Entity reads field \`b\` of mesh entity \`a\`'s last-value cache (Nil
until the mesh has delivered once). The reads with tables of their own — a
timer's fields, the clock, the invocation's arguments — keep their own
opcodes until their owners become host objects at stage 7.`,
  },
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
  {
    name: "Park",
    c: `THE ONE ASYNC PRIMITIVE (stage 6d): park this run at pending site \`a\` and wake
it \`b\` ticks from now, the invocation policy riding \`small\` (a ParkPolicy).
The frame swaps into the site WHOLE — arena, arguments, temporaries — and
swaps back at the wake, so held scratch survives by ownership. Replace
re-parks an occupied site with THIS run and resets the clock (debounce: the
last arrival speaks); Keep leaves the parked run its wake and simply ends
this one (delay: the first arrival's continuation is not cancelled by a
second). Parked frames die at recompile — cells migrate by name,
continuations never.`,
  },
  {
    name: "New",
    c: `the move step's forms (spec 5.4): New and ReadEnt fill a struct cell, Store
lands a value at a place, Send emits the effect.`,
  },
  { name: "ReadEnt" },
  {
    name: "Send",
    c: `THE ONE SEND (stage 6d): every outbound effect is one verb spoken AT a host
object, the object family and the verb riding \`small\` (the low byte a
SendTarget, the high byte the verb in that family's own vocabulary — a mesh
target's is Verb, a timer's is 0 start / 1 cancel, raise and notify have one
verb each). \`a\` names the object in its family's table, \`b\` carries the
target's detail (see each target), and \`c\` is the fault site. Whatever the
message needs was pushed before it and pops here; the record queues on the
state's mailbox and the host flushes it after the run — an effect never
re-enters the VM under the run that spoke it.`,
  },
  {
    name: "Store",
    c: `THE ONE STORE (stage 6c): land the value at a PLACE with a MODE, both riding
\`small\` (the low byte a StorePlace, the high byte a StoreMode). The root is
always cell \`a\`; Field names struct field \`b\`; every other step the place
needs — an element index, a map key, the append's keep bound — was pushed
ABOVE the value and pops first. \`c\` is the fault site: a place that refuses
the value (a foreign element, a miss, a full buffer) faults loudly rather
than dropping the write. A store that lands in a struct's aggregate-field
storage refreshes the owner's field handle as part of the write, so no
separate instruction follows a store anywhere.`,
  },
  { name: "Fault" },
  {
    name: "Halt",
    c: `end the run — and SAY WHY when \`small\` is 1: fault site \`a\` counts into the
log without the run being a fault, which is how a lowered gate on an UNKNOWN
condition reports that the flow did not run. A bare Halt is every flow's
silent ending, and what a gate's untaken branch jumps to.`,
  },
  { name: "Index" },
  {
    name: "JmpNil",
    c: `THE UNKNOWN TEST (spec 2.4): when the top of stack is Nil, pop it and jump to
\`a\`; otherwise leave it and fall through. What \`??\` compiles to, and how && / ||
propagate an unknown condition instead of faulting on it.`,
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
    name: "ToEnum",
    c: `text -> the enum value whose variant name it is, over the type table entry in
\`b\`: the IMPLICIT conversion at an enum-typed DESTINATION, so a Dropdown's
selected name (or any dynamic text) writes back with no authored transform. The
corrected contract (user's call, 2026-08-14): a CONSTANT name never reaches here
(the compiler resolves or refuses it), and a runtime name outside the vocabulary
converts to Nil and PROPAGATES (the one unknown rule) — the old opcode faulted,
which is why it is dead and this one is not it.`,
  },
  {
    name: "Arg",
    c: `push INVOCATION ARGUMENT \`a\` off the frame's argument slots: the context a run
was CALLED with, as opposed to state it reads. \`0\` is the triggering event's
declared parameter, bound by the parameter's name at compile; \`1\`..\`3\` are the
repeat copy the event arrived on (index, count, fraction — Nil where no copy is
behind the run, exactly as the view's \`repeat:\` cells read outside a repeat).
Frame-resident rather than a run_code register so a lambda body reads them
without colliding with its own x2/x3 — and so a park keeps them by keeping the
frame.`,
  },
  {
    name: "ClockRead",
    c: `push CLOCK FIELD \`a\` (a ClockField below): \`time.now\` is seconds since the program
started (the tick counter, so replay stays deterministic), everything else is the
wall clock the scheduler stamped at the top of this tick — one sample per tick, so
a run can never see the second flip under it. The two TEXT fields render into the
fixed slot \`b\` reserved at compile, like any text-producing site.`,
  },
];

/* Where a Send SPEAKS: the low byte of its \`small\` names the object family, and
 * the high byte the verb in that family's own vocabulary. One opcode covers every
 * outbound effect because dispatching the mailbox is the state's one concern, not
 * an opcode family's — the families become served host-object descriptors at
 * stage 7. */
const SEND_TARGETS = [
  {
    name: "Entity",
    c: `a mesh entity: \`a\` the entity, the verb a Verb (write / force / publish /
call / emit / unforce). \`b\` names the field a bare send fills; UINT32_MAX
sends the message whole — a struct handle pops as the message, or nothing
pops at all for a parameterless call/emit and for unforce`,
  },
  {
    name: "Elem",
    c: `one element of mesh entity \`a\`'s array field \`b\`: [value, index] pop, index
off first, and the encode rewrites that one element over the owner's own
bytes (RMW) — an index past the owner's live count is refused at the encode,
never a grow`,
  },
  {
    name: "Self",
    c: `raise the event in raises[\`a\`] on the speaking instance (\`b\`: 1 = pop the
argument, 0 = nullary). The record queues and the scheduler dispatches it
AFTER this run halts`,
  },
  {
    name: "System",
    c: `notify every connected view: pops the message, renders it as str() renders
any scalar (\`b\`: 1 = pop an explicit ms duration first, 0 = the view scales
the time with the message's length)`,
  },
  {
    name: "Timer",
    c: `timer \`a\`: verb 0 starts it at its declared duration, 1 cancels it — and
either one re-arms the first-of groups the timer's own firing gates`,
  },
];

/* Where a Load READS: its \`small\`, whole. The three storage roots one opcode
 * covers; reads with tables of their own (timers, the clock, the arguments) keep
 * their own opcodes until stage 7 makes their owners host objects. */
const LOAD_PLACES = [
  { name: "Cell", c: "the whole cell `a`" },
  { name: "Field", c: "field `b` of struct cell `a`" },
  { name: "Entity", c: "field `b` of mesh entity `a`'s last-value cache" },
];

/* Where a Store LANDS and HOW: the two halves of its \`small\` (place low byte, mode
 * high byte). One opcode covers every write a program makes because the storage
 * dispatch is the state's one concern, not an opcode family's. The Leaf place — one
 * row of a nested cell, addressed [outer][inner] with both steps popped — is storage
 * the state serves and tests drive; no compiled surface emits it yet. */
const STORE_PLACES = [
  { name: "Cell", c: "the whole cell `a`" },
  { name: "Field", c: "field `b` of struct cell `a`" },
  { name: "Elem", c: "one position of list cell `a`; the index pops above the value" },
  {
    name: "Key",
    c: `one key of map cell \`a\`; the key pops above the value. A Nil value ERASES the
key — a map has no other removal verb, and "this key holds UNKNOWN" and "this
key is absent" would otherwise be two spellings of one thing.`,
  },
  { name: "Leaf", c: "inside one row of nested cell `a`: outer then inner, both popped" },
];
/* how a Park treats an OCCUPIED site — the whole of the debounce/delay
 * distinction, restored as data after the runtime lost it (the old opcode
 * stamped the kind and nothing read it: both behaved as debounce) */
const PARK_POLICIES = [
  {
    name: "Replace",
    c: "re-park the site with THIS run; the wake clock resets (debounce)",
  },
  {
    name: "Keep",
    c: "the parked run keeps the site and its wake; this run just ends (delay)",
  },
];

const STORE_MODES = [
  { name: "Assign", c: "replace what the place holds; an element edit never grows" },
  {
    name: "Append",
    c: `grow the place by ONE element, trimmed to the keep bound popped above the
value: a non-Nil keep is what makes a history ring one authored step instead
of a privileged machine, and a Nil keep means unbounded — the append REFUSES
at the retained ceiling rather than growing forever.`,
  },
];

/* ---- THE HOST-OBJECT DESCRIPTORS (registry/objects.h) ----
 *
 * The ambient values every expression surface reads BY FIELD: the clock, the view's
 * own inputs (state, repeat) and a timer's face. One table per object; the scalar
 * tier's bindings, the template tier's checks, the VM's clock dispatch, the served
 * roster (lang_json) and the refusal texts that teach the vocabulary are ALL read
 * off these rows, so adding an ambient value is a row here and zero lang/ edits. */

/* the fields `time` reads by */
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

/* this view's gesture state, per element (the renderer answers "state:" cells) */
const STATE_FIELDS = [
  { field: "pressed", shape: "Bool" },
  { field: "dragging", shape: "Bool" },
  { field: "open", shape: "Bool" },
  { field: "hover", shape: "Bool" },
];

/* which copy of a `repeat` — an attr reads it per copy, an event-triggered flow
 * reads the copy that raised it (frame.args[1..3], in this order) */
const REPEAT_FIELDS = [
  { field: "index", shape: "Num", c: "0-based" },
  { field: "count", shape: "Num" },
  { field: "fraction", shape: "Num", c: "index / (count - 1); 0 when count < 2" },
];

/* a timer's face, in TmrRead's own operand order (`b` is the row index) */
const TIMER_FIELDS = [
  { field: "running", shape: "Bool" },
  { field: "remaining", shape: "Num", c: "seconds; derives from the deadline" },
  { field: "duration", shape: "Num", c: "seconds, as declared" },
  { field: "progress", shape: "Num", c: "1 - remaining/duration; 1.0 while idle" },
];

/* what Iterate does with each element's body result (rides Instruction::small);
 * `call` is the method name both surface grammars spell it by */
const ITERATE_ROWS = [
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

/* One row per BUILTIN: the enum id (`name`, emitted in this order), the surface
 * spelling (`fn`), the signature (min/max arity, parameter shapes, result shape),
 * `display` (display vocabulary, refused on the wire), and the VIEW column — how
 * the template emitter lowers the row: "=" a Call of the row's own enum id, "@" a
 * bespoke fold over other opcodes (template_expr.cpp owns the recipe), "" no view
 * encoding at all. A row with no `name` is VIEW-ONLY: it never reaches the scalar
 * dispatcher, so its table row carries Builtin::None — the honest "no scalar id",
 * which answers Nil if a bug ever routes one to the VM instead of silently
 * computing a borrowed builtin. `c` comments the enum entry, `rc` the table row. */
const BUILTINS = [
  { name: "Clamp", fn: "clamp", min: 3, max: 3, params: ["Num", "Num", "Num"], result: "Num", view: "@" },
  {
    name: "MapRange", fn: "mapRange", min: 5, max: 5, params: ["Num", "Num", "Num", "Num", "Num"], result: "Num", view: "@",
    rc: `mapRange/roundTo/lerp: pure arithmetic, so the view emitter folds each onto
the existing Add/Sub/Mul/Div and the Pow/Round calls (template_expr.cpp)
rather than gaining an id of its own -- "@" is the same bespoke marker
\`clamp\` uses`,
  },
  { name: "RoundTo", fn: "roundTo", min: 2, max: 2, params: ["Num", "Num"], result: "Num", view: "@" },
  { name: "Lerp", fn: "lerp", min: 3, max: 3, params: ["Num", "Num", "Num"], result: "Num", view: "@" },
  { name: "Abs", fn: "abs", min: 1, max: 1, params: ["Num"], result: "Num", view: "=" },
  { name: "Round", fn: "round", min: 1, max: 1, params: ["Num"], result: "Num", view: "=" },
  { name: "Floor", fn: "floor", min: 1, max: 1, params: ["Num"], result: "Num", view: "=" },
  { name: "Ceil", fn: "ceil", min: 1, max: 1, params: ["Num"], result: "Num", view: "=" },
  { name: "Sqrt", fn: "sqrt", min: 1, max: 1, params: ["Num"], result: "Num", view: "=" },
  { name: "Pow", fn: "pow", min: 2, max: 2, params: ["Num", "Num"], result: "Num", view: "=" },
  { name: "Min", fn: "min", min: 2, max: 2, params: ["Num", "Num"], result: "Num", view: "=" },
  { name: "Max", fn: "max", min: 2, max: 2, params: ["Num", "Num"], result: "Num", view: "=" },
  { name: "Int", fn: "int", min: 1, max: 1, params: ["Unknown"], result: "Num", view: "=" },
  { name: "Num", fn: "num", min: 1, max: 1, params: ["Unknown"], result: "Num" },
  {
    fn: "clamp01", min: 1, max: 1, params: ["Num"], result: "Num", view: "@", viewOnly: true,
    rc: `view-only: the template tier's saturating 0..1 fold, which the scalar language
spells clamp(x, 0, 1) -- the emitter folds it onto Max/Min the same way`,
  },
  { name: "Rgb", fn: "rgb", min: 3, max: 4, params: ["Num", "Num", "Num", "Num"], result: "Color", display: true, view: "=" },
  { name: "Hsv", fn: "hsv", min: 3, max: 4, params: ["Num", "Num", "Num", "Num"], result: "Color", display: true, view: "=" },
  { name: "Str", fn: "str", min: 1, max: 1, params: ["Unknown"], result: "Text", view: "=" },
  { name: "Name", fn: "name", min: 1, max: 1, params: ["Unknown"], result: "Text" },
  { name: "FmtTime", fn: "fmtTime", min: 1, max: 1, params: ["Num"], result: "Text", display: true },
  { name: "FmtDuration", fn: "fmtDuration", min: 1, max: 1, params: ["Num"], result: "Text", display: true },
  { name: "Color", fn: "color", min: 1, max: 1, params: ["Text"], result: "Color", display: true },
  { name: "Jet", fn: "jet", min: 1, max: 1, params: ["Num"], result: "Color", display: true },
  { name: "Hot", fn: "hot", min: 1, max: 1, params: ["Num"], result: "Color", display: true },
  { name: "CoolWarm", fn: "coolWarm", min: 1, max: 1, params: ["Num"], result: "Color", display: true },
  { name: "Viridis", fn: "viridis", min: 1, max: 1, params: ["Num"], result: "Color", display: true },
  { name: "Grayscale", fn: "grayscale", min: 1, max: 1, params: ["Num"], result: "Color", display: true },
  { name: "Values", fn: "values", min: 1, max: 1, params: ["Unknown"], result: "List" },
  { name: "Keys", fn: "keys", min: 1, max: 1, params: ["Unknown"], result: "List" },
  { name: "Invert", fn: "invert", min: 1, max: 1, params: ["Color"], result: "Color", display: true },
  {
    name: "Sin", fn: "sin", min: 1, max: 1, params: ["Num"], result: "Num", view: "=",
    c: `ordinary trigonometry, degrees in and out (the project-wide angle convention):
both tiers gain these together, which is the piece that unblocks authoring a
needle's capsule or an arc's annular sector as arithmetic instead of a hard-coded
draw kind`,
    rc: `ordinary trigonometry: degrees in and out on BOTH tiers, matching the
project-wide angle convention (degrees, 0 = up, clockwise) rather than
inventing a radians dialect nothing else in the document uses`,
  },
  { name: "Cos", fn: "cos", min: 1, max: 1, params: ["Num"], result: "Num", view: "=" },
  { name: "Tan", fn: "tan", min: 1, max: 1, params: ["Num"], result: "Num", view: "=" },
  { name: "Asin", fn: "asin", min: 1, max: 1, params: ["Num"], result: "Num", view: "=" },
  { name: "Acos", fn: "acos", min: 1, max: 1, params: ["Num"], result: "Num", view: "=" },
  { name: "Atan2", fn: "atan2", min: 2, max: 2, params: ["Num", "Num"], result: "Num", view: "=" },
  {
    fn: "sign", min: 1, max: 1, params: ["Num"], result: "Num", view: "@", viewOnly: true,
    rc: `view-only free-function spellings the surface grammar offers beside the
methods: sign folds onto the NumSign method, mod onto the Mod opcode, hypot
onto Mul/Add and the Sqrt call -- each a bespoke lowering over ids that
already exist, so none needs a scalar Builtin. Builtin::None marks each
view-only bespoke row: no scalar id exists, and view_only rows never reach
the dispatcher that would want one.`,
  },
  { fn: "mod", min: 2, max: 2, params: ["Num", "Num"], result: "Num", view: "@", viewOnly: true },
  { fn: "hypot", min: 2, max: 2, params: ["Num", "Num"], result: "Num", view: "@", viewOnly: true },
  {
    name: "Known", fn: "known", min: 1, max: 1, params: ["Unknown"], result: "Bool", view: "=",
    rc: `THE UNKNOWN TEST (spec 2.4): true when the value is not UNKNOWN. The one
place the language ASKS about Nil instead of propagating it — == cannot test
for it (an unknown comparison is unknown), so this is the honest spelling,
beside \`??\` for the default-value case. Wire-legal: a gate may guard on it.`,
  },
  {
    name: "Measure", fn: "measure", min: 2, max: 2, params: ["Text", "Num"], result: "Num", display: true, view: "=", viewOnly: true,
    c: `view-only, id'd at the table's end so naming it renumbered nothing: the
estimated rendered width the view answers (no VM case dispatches it)`,
    rc: `view-only WITH an id: the estimated rendered width of TEXT at SIZE, in
artboard units -- the same estimator the text renderer uses, so an author's
own layout maths agrees with what actually renders. No wire meaning and no
VM case (a machine does not care how wide a label draws): only the view
interpreter dispatches the id, and view_only keeps it out of the scalar
compiler, so a bug that routes it to the VM answers Nil.`,
  },
  {
    name: "Anchor", fn: "anchor", min: 2, max: 2, params: ["Num", "Num"], result: "Struct", display: true, view: "=", viewOnly: true,
    rc: `view-only WITH an id, like measure: one point of a computed path, in
fractions of the node's box — what a \`points\` attr's map produces per
sample. No wire meaning and no VM case (a machine has no boxes).`,
  },
];

/* One row per METHOD: the enum id (`name`, emitted in this order), the receiver
 * shape (`recv`), the surface spelling (`m`), the signature, `display` and the
 * VIEW column ("=" a Method of the row's own enum id, "@" a bespoke fold, "" no
 * view encoding). Every method is CALLED — plain after a dot is a field, parens
 * is work — so there is no bare-reading column. A row with no `recv` is
 * enum-only: an id the emitter uses directly (TextConcat, the color arithmetic)
 * with no surface method behind it. */
const METHODS = [
  { name: "NumRound", recv: "Num", m: "round", args: 1, params: ["Num"], result: "Num" },
  { name: "NumFloor", recv: "Num", m: "floor", args: 0, params: [], result: "Num" },
  { name: "NumCeil", recv: "Num", m: "ceil", args: 0, params: [], result: "Num" },
  { name: "NumAbs", recv: "Num", m: "abs", args: 0, params: [], result: "Num" },
  { name: "NumClamp", recv: "Num", m: "clamp", args: 2, params: ["Num", "Num"], result: "Num", view: "@" },
  { name: "NumMapRange", recv: "Num", m: "mapRange", args: 4, params: ["Num", "Num", "Num", "Num"], result: "Num" },
  { name: "NumSign", recv: "Num", m: "sign", args: 0, params: [], result: "Num" },
  { name: "BoolInt", recv: "Bool", m: "int", args: 0, params: [], result: "Num" },
  { name: "BoolNot", recv: "Bool", m: "not", args: 0, params: [], result: "Bool" },
  { name: "BoolPick", recv: "Bool", m: "pick", args: 2, params: ["Unknown", "Unknown"], result: "Unknown", view: "=" },
  { name: "ColorR", recv: "Color", m: "r", args: 0, params: [], result: "Num", view: "=" },
  { name: "ColorG", recv: "Color", m: "g", args: 0, params: [], result: "Num", view: "=" },
  { name: "ColorB", recv: "Color", m: "b", args: 0, params: [], result: "Num", view: "=" },
  { name: "ColorA", recv: "Color", m: "a", args: 0, params: [], result: "Num", view: "=" },
  { name: "ColorAlpha", recv: "Color", m: "alpha", args: 1, params: ["Num"], result: "Color", display: true, view: "=" },
  { name: "ColorMix", recv: "Color", m: "mix", args: 2, params: ["Color", "Num"], result: "Color", display: true, view: "=" },
  { name: "NumToFixed", recv: "Num", m: "toFixed", args: 1, params: ["Num"], result: "Text", display: true, view: "=" },
  {
    name: "TextLength", recv: "Text", m: "length", args: 0, params: [], result: "Num", view: "=",
    rc: `text: the predicates and length are wire-legal (a gate may test an alarm
code); everything text-PRODUCING is formatting and stays display-side`,
  },
  { name: "TextUpper", recv: "Text", m: "upper", args: 0, params: [], result: "Text", display: true },
  { name: "TextLower", recv: "Text", m: "lower", args: 0, params: [], result: "Text", display: true },
  { name: "TextTitle", recv: "Text", m: "title", args: 0, params: [], result: "Text", display: true },
  { name: "TextTrim", recv: "Text", m: "trim", args: 0, params: [], result: "Text", display: true },
  { name: "TextSlice", recv: "Text", m: "slice", args: 2, params: ["Num", "Num"], result: "Text", display: true },
  { name: "TextStartsWith", recv: "Text", m: "startsWith", args: 1, params: ["Text"], result: "Bool" },
  { name: "TextEndsWith", recv: "Text", m: "endsWith", args: 1, params: ["Text"], result: "Bool" },
  { name: "TextContains", recv: "Text", m: "contains", args: 1, params: ["Text"], result: "Bool" },
  { name: "TextReplace", recv: "Text", m: "replace", args: 2, params: ["Text", "Text"], result: "Text", display: true },
  { name: "TextPadStart", recv: "Text", m: "padStart", args: 2, params: ["Num", "Text"], result: "Text", display: true },
  { name: "EnumInt", recv: "Enum", m: "int", args: 0, params: [], result: "Num" },
  { name: "EnumName", recv: "Enum", m: "name", args: 0, params: [], result: "Text" },
  {
    name: "EnumVariants", recv: "Enum", m: "variants", args: 0, params: [], result: "List",
    rc: `the VOCABULARY as a value: list(text) of the receiver's variant names. The
receiver's TYPE answers at COMPILE, so this folds to a constant list (no VM
case, the receiver's value is never read) and can never drift from the schema.
The options spelling — myMode.variants(), filterable like any list.`,
  },
  { name: "TextSplit", recv: "Text", m: "split", args: 1, params: ["Text"], result: "List", display: true },
  {
    name: "ListLength", recv: "List", m: "length", args: 0, params: [], result: "Num", view: "=",
    rc: `aggregates ride mid-expression on either tier (max over a list is a wire
value); the wire-result rule alone keeps a LIST from going to a machine.
length is receiver-blind in the view: the untyped emitter picks the first
namesake row's id and the view interpreter answers text, list and map alike
under any of the three, so all three rows carry "=".`,
  },
  { name: "ListFirst", recv: "List", m: "first", args: 0, params: [], result: "Unknown" },
  { name: "ListLast", recv: "List", m: "last", args: 0, params: [], result: "Unknown" },
  { name: "ListSum", recv: "List", m: "sum", args: 0, params: [], result: "Num", view: "=" },
  { name: "ListAvg", recv: "List", m: "avg", args: 0, params: [], result: "Num", view: "=" },
  { name: "ListMax", recv: "List", m: "max", args: 0, params: [], result: "Num", view: "=" },
  { name: "ListMin", recv: "List", m: "min", args: 0, params: [], result: "Num", view: "=" },
  { name: "ListJoin", recv: "List", m: "join", args: 1, params: ["Text"], result: "Text", display: true },
  { name: "ListSort", recv: "List", m: "sort", args: 0, params: [], result: "List" },
  { name: "ListReverse", recv: "List", m: "reverse", args: 0, params: [], result: "List" },
  { name: "ListSlice", recv: "List", m: "slice", args: 2, params: ["Num", "Num"], result: "List" },
  { name: "ListContains", recv: "List", m: "contains", args: 1, params: ["Unknown"], result: "Bool" },
  { name: "ListIndexOf", recv: "List", m: "indexOf", args: 1, params: ["Unknown"], result: "Num", view: "=" },
  { name: "MapLength", recv: "Map", m: "length", args: 0, params: [], result: "Num", view: "=" },
  { name: "MapKeys", recv: "Map", m: "keys", args: 0, params: [], result: "List" },
  { name: "MapValues", recv: "Map", m: "values", args: 0, params: [], result: "List" },
  { name: "MapHas", recv: "Map", m: "has", args: 1, params: ["Text"], result: "Bool" },
  { name: "MapGet", recv: "Map", m: "get", args: 1, params: ["Text"], result: "Unknown" },
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
  { name: "ColorInvert", recv: "Color", m: "invert", args: 0, params: [], result: "Color", display: true },
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

/* where a Load READS: its \`small\`, whole */
`;
  out += cEnum(
    "LoadPlace",
    "uint16_t",
    LOAD_PLACES.map((p) => ({ name: p.name, c: p.c })),
  );
  out += `
/* where a Store LANDS and HOW: the two halves of its \`small\` (place low byte,
 * mode high byte) */
`;
  out += cEnum(
    "StorePlace",
    "uint8_t",
    STORE_PLACES.map((p) => ({ name: p.name, c: p.c })),
  );
  out += `
`;
  out += cEnum(
    "StoreMode",
    "uint8_t",
    STORE_MODES.map((m) => ({ name: m.name, c: m.c })),
  );
  out += `
/* the one Store's \`small\`, assembled */
constexpr uint16_t store_small(StorePlace place, StoreMode mode) {
    return static_cast<uint16_t>(static_cast<uint16_t>(place) |
                                 (static_cast<uint16_t>(mode) << 8));
}

/* where a Send SPEAKS: the low byte of its \`small\` names the object family,
 * the high byte the verb in that family's own vocabulary */
`;
  out += cEnum(
    "SendTarget",
    "uint8_t",
    SEND_TARGETS.map((t) => ({ name: t.name, c: t.c })),
  );
  out += `
/* the one Send's \`small\`, assembled — the verb in the target's own vocabulary
 * (a mesh target's is Verb, a timer's 0 start / 1 cancel) */
constexpr uint16_t send_small(SendTarget target, uint8_t verb) {
    return static_cast<uint16_t>(static_cast<uint16_t>(target) |
                                 (static_cast<uint16_t>(verb) << 8));
}

/* how a Park treats an occupied pending site: its \`small\`, whole */
`;
  out += cEnum(
    "ParkPolicy",
    "uint16_t",
    PARK_POLICIES.map((p) => ({ name: p.name, c: p.c })),
  );
  out += `
/* what Iterate does with each element's body result (rides Instruction::small) */
`;
  out += cEnum(
    "IterateMode",
    "uint16_t",
    ITERATE_ROWS.map((m) => ({ name: m.name, c: m.c })),
  );
  out += `
/* the iterating methods by the name both surface grammars spell them, each with
 * the mode its Iterate carries */
struct IterateModeDef {
    const char* call;
    IterateMode mode;
};

constexpr IterateModeDef kIterateModes[] = {
`;
  for (const m of ITERATE_ROWS) out += `    {"${m.call}", IterateMode::${m.name}},\n`;
  out += `};

`;
  const builtinRows = [
    ...BUILTINS.filter((b) => b.name),
    {
      name: "None",
      c: `the no-scalar-id marker bespoke VIEW-ONLY table rows carry: no VM case
dispatches it, so a bug that routes one to the scalar dispatcher answers Nil
instead of silently computing some borrowed builtin`,
    },
  ];
  out += cEnum("Builtin", "uint16_t", builtinRows);
  out += `
`;
  out += cEnum("MethodId", "uint16_t", METHODS);
  out += `
/* the disassembly spelling of every id, derived from the enum names like kOpNames */
constexpr const char* kBuiltinNames[] = {
`;
  for (const b of builtinRows) out += `    "${snake(b.name)}",\n`;
  out += `};

inline const char* builtin_name(Builtin id) {
    const auto index = static_cast<size_t>(id);
    return index < sizeof(kBuiltinNames) / sizeof(kBuiltinNames[0])
               ? kBuiltinNames[index]
               : "?";
}

constexpr const char* kMethodNames[] = {
`;
  for (const m of METHODS) out += `    "${snake(m.name)}",\n`;
  out += `};

inline const char* method_name(MethodId id) {
    const auto index = static_cast<size_t>(id);
    return index < sizeof(kMethodNames) / sizeof(kMethodNames[0]) ? kMethodNames[index]
                                                                  : "?";
}

constexpr const char* kIterateModeNames[] = {
`;
  for (const m of ITERATE_ROWS) out += `    "${snake(m.name)}",\n`;
  out += `};

inline const char* iterate_mode_name(IterateMode mode) {
    const auto index = static_cast<size_t>(mode);
    return index < sizeof(kIterateModeNames) / sizeof(kIterateModeNames[0])
               ? kIterateModeNames[index]
               : "?";
}

} // namespace hmi
`;
  return out;
}

/* the signature rows lang/tables.cpp builds its two vocabulary tables from — the
 * X-macro include, so the enum id and the spec come from ONE row here */
function emitTablesInc() {
  const shapes = (params) => params.map((p) => `Shape::${p}`).join(", ");
  let out = `/* GENERATED by tools/gen_ir.mjs — DO NOT EDIT. Edit the tables there and
 * regenerate; the ir_gen ctest fails on any drift between this file and them.
 *
 * One row per builtin and per method: the enum id, the surface spelling, the
 * signature, the tier and the view encoding. lang/tables.cpp includes this file
 * once per table with HMI_BUILTIN_ROW / HMI_METHOD_ROW defined — adding to a
 * vocabulary is one row in gen_ir.mjs, nowhere else. Parameter lists ride inside
 * parentheses so their commas survive the preprocessor. */

#ifdef HMI_BUILTIN_ROW
/* fn, enum id, min args, max args, (params), result, display_only, view, view_only */
`;
  for (const b of BUILTINS) {
    if (!b.fn) continue;
    if (b.rc) out += cComment(b.rc, "");
    out += `HMI_BUILTIN_ROW("${b.fn}", ${b.name ?? "None"}, ${b.min}, ${b.max}, ` +
           `(${shapes(b.params)}), ${b.result}, ${b.display ? "true" : "false"}, ` +
           `"${b.view ?? ""}", ${b.viewOnly ? "true" : "false"})\n`;
  }
  out += `#endif

#ifdef HMI_METHOD_ROW
/* receiver, name, enum id, args, (params), result, display_only, view */
`;
  for (const m of METHODS) {
    if (!m.recv) continue;
    if (m.rc) out += cComment(m.rc, "");
    out += `HMI_METHOD_ROW(${m.recv}, "${m.m}", ${m.name}, ${m.args}, ` +
           `(${shapes(m.params)}), ${m.result}, ${m.display ? "true" : "false"}, ` +
           `"${m.view ?? ""}")\n`;
  }
  out += `#endif
`;
  return out;
}

/* THE HOST-OBJECT DESCRIPTOR HEADER: the ambient by-field vocabularies, outside
 * lang/ — the language's own tables (ir_ops.h) carry no HMI object, and adding an
 * ambient value is a row in this file's tables and zero lang/ edits. */
function emitObjectsH() {
  let out = `/* GENERATED by tools/gen_ir.mjs — DO NOT EDIT. Edit the tables there and
 * regenerate; the ir_gen ctest fails on any drift between this file and them.
 *
 * THE HOST-OBJECT DESCRIPTORS: the ambient values every expression surface reads
 * BY FIELD — the clock, the view's own inputs (state, repeat) and a timer's face.
 * The scalar tier's bindings (compile/compiler.cpp), the template tier's checks
 * (lang/template_expr.cpp), the VM's clock dispatch, the served roster
 * (App::lang_json — what the frontend's scope offering READS instead of
 * mirroring) and the refusal texts that teach each vocabulary are all read off
 * these tables, so none of them can drift. */
#pragma once

#include "lang/value.h"

#include <cstdint>
#include <string>

namespace hmi {

struct ObjectFieldDef {
    const char* name;
    Shape shape;
};

/* the teaching spelling of a by-field vocabulary: "time.now / time.unix / ..." */
template <size_t N>
std::string object_field_list(const char* object, const ObjectFieldDef (&fields)[N]) {
    std::string out;
    for (size_t i = 0; i < N; ++i)
        out += std::string(i ? " / " : "") + object + "." + fields[i].name;
    return out;
}

/* the fields \`time\` reads by; ClockRead's \`a\` is the row's ordinal */
`;
  out += cEnum(
    "ClockField",
    "uint16_t",
    CLOCK_FIELDS.map((f) => ({ name: f.name, c: f.c })),
  );
  out += `
constexpr ObjectFieldDef kClockFields[] = {
`;
  for (const f of CLOCK_FIELDS) out += `    {"${f.field}", Shape::${f.shape}},\n`;
  out += `};

/* this view's gesture state, per element (the renderer answers "state:" cells) */
constexpr ObjectFieldDef kStateFields[] = {
`;
  for (const f of STATE_FIELDS) out += `    {"${f.field}", Shape::${f.shape}},\n`;
  out += `};

/* which copy of a \`repeat\`: an attr reads it per copy, an event-triggered flow
 * reads the copy that raised it (frame.args[1..3], in this order) */
constexpr ObjectFieldDef kRepeatFields[] = {
`;
  for (const f of REPEAT_FIELDS) out += `    {"${f.field}", Shape::${f.shape}},\n`;
  out += `};

/* a timer's face, in TmrRead's own operand order (\`b\` is the row index) */
constexpr ObjectFieldDef kTimerFields[] = {
`;
  for (const f of TIMER_FIELDS) out += `    {"${f.field}", Shape::${f.shape}},\n`;
  out += `};

} // namespace hmi
`;
  return out;
}

/* one TS numeric-id table: { Name: ordinal } in row order, mirroring the C++ enum */
function tsIds(name, rows, comment) {
  let out = `/* ${comment} */\nexport const ${name} = {\n`;
  rows.forEach((row, i) => (out += `  ${row}: ${i},\n`));
  return out + `} as const;\n`;
}

function emitIrTs() {
  let out = `/* GENERATED by tools/gen_ir.mjs — DO NOT EDIT. Edit the tables there and
 * regenerate; the ir_gen ctest fails on any drift between this file and them.
 *
 * The view's copy of the shared NUMERIC vocabulary — the same ordinals the C++
 * enums (lang/ir_ops.h) carry, from the same table, which is what lets a served
 * program be plain packed numbers with nothing to translate at either end. The
 * view interpreter (program.ts) dispatches on these; the ids it has no case for
 * simply answer Nil there, so the mirror carries the WHOLE table rather than a
 * curated subset. */

`;
  out += tsIds("Op", OPS.map((o) => o.name),
               "the opcodes (OpCode): a packed instruction's first word");
  out += "\n";
  out += tsIds("LoadPlace", LOAD_PLACES.map((p) => p.name),
               "where a Load reads: its `small`, whole");
  out += "\n";
  out += tsIds("IterateMode", ITERATE_ROWS.map((m) => m.name),
               "what Iterate does with each body result: its `small`");
  out += "\n";
  out += tsIds("BuiltinId",
               [...BUILTINS.filter((b) => b.name).map((b) => b.name), "None"],
               "a Call's `small`: the builtin ids (Builtin)");
  out += "\n";
  out += tsIds("MethodId", METHODS.map((m) => m.name),
               "a Method's `small`: the method ids (MethodId)");
  return out;
}

/* ------------------------------------------------------------------ driving */

const FILES = [
  { path: join(ROOT, "backend", "src", "lang", "ir_ops.h"), emit: emitOpsH },
  { path: join(ROOT, "backend", "src", "lang", "tables.inc"), emit: emitTablesInc },
  { path: join(ROOT, "backend", "src", "registry", "objects.h"), emit: emitObjectsH },
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

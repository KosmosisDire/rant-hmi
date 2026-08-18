/* The language's INSTRUCTION FORM: the ceilings, the instruction struct every tier is
 * lowered to, and (through ir_ops.h, GENERATED from tools/gen_ir.mjs) the opcode,
 * iterate-mode, builtin and method vocabularies. The ambient by-field vocabularies
 * (the clock, the view inputs, a timer's face) are HOST descriptors and live outside
 * the language, in registry/objects.h — adding an ambient value is a descriptor row
 * and zero lang/ edits.
 *
 * This lives with the language rather than with the VM because the language DEFINES the
 * IR and the VM merely executes it — so the dependency runs vm/ -> lang/ and never the
 * reverse, which is what keeps EntityDef, CellDef and the feed/flow tables out of the
 * compiler's headers. */
#pragma once

#include "lang/ir_ops.h"
#include "lang/value.h"

#include <cstdint>

namespace hmi {

/* safety ceilings on genuinely unbounded inputs (PLAN.md: computed bounds, not
 * configured ceilings): an uncapped varr or map truncates here with a fault, and a
 * split can yield at most one piece per input byte */
constexpr uint32_t kVarrCeiling = 512;
constexpr uint32_t kSplitCeiling = 256;
/* the widest ARRAY FIELD one mesh delivery may carry into the run's scratch pool. A
 * schema's own bound decides the size the pool is built for; this only clamps a bound big
 * enough to be a mistake, because the pool is preallocated per run and a retained cell's
 * budget (kBufferBytes below) says nothing about what one delivery should cost. */
constexpr uint32_t kDeliveryCeiling = 4096;
/* THE ONE LIMIT ON WHAT A CELL KEEPS ACROSS TICKS: a retained buffer's BYTES.
 *
 * Not a count. A count was a number rather than a bound, and counting made a list of ROWS
 * hold ceiling/width of them — which is not what "a list of 4096" means to anyone who
 * declared one. What actually has to be bounded is memory, so that is what is bounded;
 * how many elements that buys is arithmetic over the element's own cost (buffer_capacity
 * in state.h), and a text element costs its text slot as well as its Value.
 *
 * EVERY BUFFER GETS ITS OWN. A nested cell's rows are elements of the outer buffer and
 * their leaves live in an arena of its own, so the two never spend each other's room: a
 * list declared to hold 4096 rows holds 4096 rows, however wide a row is.
 *
 * The limit still exists, and it is why a keep-less append that would grow forever stays
 * a loud diagnostic instead of an out-of-memory. kVarrCeiling below is a different thing
 * and stays small: it bounds what one RUN builds in the scratch pool, which is rebuilt
 * every run, not kept. */
constexpr uint64_t kBufferBytes = 100ull * 1024 * 1024;

/* THE STEP BUDGET (stage 6d; rule 14 — a claimed bound is an enforced bound): the
 * dispatch loop counts every instruction, lambda bodies included, and FAULTS a run
 * past this ceiling. Forward-only jumps (the verifier at compile) and the
 * schema-bounded Iterate trips already make every legitimate run finite; this is
 * the backstop that turns a malformed program into a loud fault instead of a hung
 * tick, set orders of magnitude above any real run's count. */
constexpr uint32_t kStepCeiling = 1u << 27;

struct Instruction {
    OpCode op = OpCode::Halt;
    uint8_t flags = 0;
    uint16_t small = 0;
    uint32_t a = 0;
    uint32_t b = 0;
    uint32_t c = 0;
};

static_assert(sizeof(Instruction) == 16, "Instruction must stay compact");

} // namespace hmi

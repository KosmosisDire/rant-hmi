/* THE MODULE: what a compile PRODUCES — a VALUE, not an interface (the rewrite's
 * rule 4: exactly two boundary artifacts, the Module a compile returns and the Host a
 * run consumes; an interface is a coupling, a value is a boundary). The expression
 * pipeline interns straight into these tables, and the document compiler owns ONE for
 * the whole program, so the pools, the lambda bodies and the fault sites are shared by
 * construction rather than through a callback seam.
 *
 * This lives with the language because the language fills it and the VM merely reads
 * it — the same direction lang/ir.h already runs. */
#pragma once

#include "diag.h"
#include "lang/ir.h"
#include "lang/value.h"

#include <cstdint>
#include <string>
#include <vector>

namespace hmi {

/* What a procedure's own instructions READ and WRITE — its signature (rule 7:
 * every runnable thing has one, inferred, never authored). Every WHEN/WHERE
 * decision is a query over this rather than a fact stamped somewhere else: the
 * scheduler asks `every_tick` for the re-evaluation class, the mesh asks `reads`/
 * `writes` for what to consume and which accessors to stand up. As much of the
 * plan's {reads, writes, effects, sites} as today's queries ask for — place-path
 * granularity arrives with the machine stages. */
struct Signature {
    /* reads a cell, the clock or a timer: the value can move on any tick */
    bool every_tick = false;
    /* the entities read (LoadEnt / ReadEnt), in first-encounter order */
    std::vector<uint32_t> reads;
    /* the entities written (MoveOut: write, call, emit) */
    std::vector<uint32_t> writes;

    bool reads_entity(uint32_t entity) const {
        for (uint32_t e : reads)
            if (e == entity) return true;
        return false;
    }
};

/* One runnable body. A lambda is a NESTED procedure (spec 6.4): a plain instruction
 * run that executes on a stack frame ABOVE its caller's and reads its parameter where
 * a flow reads `x`. `max_stack` is its own frame's depth, which the layout adds on top
 * of the enclosing run's so the two never overlap. */
struct Procedure {
    std::vector<Instruction> code;
    uint32_t max_stack = 0;
    Signature sig;
};

/* THE FRAME'S EXTENT (stage 6a): how much in-flight storage ONE run needs — the
 * operand stack, the fixed result slot every text-producing site owns, and the
 * element pool aggregate-producing sites build into — counted by the compiler as
 * the code lowers. Values AT REST live in cell storage; values IN FLIGHT live in
 * the frame this record sizes. `stack` carries the deepest run plus the deepest
 * lambda body (`deepest_sub` is the high-water mark that keeps the sum honest as
 * bodies intern). `elems` includes the delivery-staging slack the store verbs
 * lean on (settled_row copies a self-sourced row through the pool). */
struct FrameExtent {
    uint32_t stack = 1;
    uint32_t deepest_sub = 0;
    uint32_t texts = 0;
    uint32_t elems = 0;
    uint32_t elem_texts = 0;
};

struct Module {
    /* the shared pools every procedure indexes into */
    std::vector<Value> constants;
    std::vector<std::string> texts;
    /* lambda bodies, indexed by Iterate's `a` operand */
    std::vector<Procedure> subs;
    /* THE FAULT-SITE TABLE (rule 13: a fault names its own site): every runtime
     * finding an instruction can fault to, indexed by its `c` operand. One table for
     * the whole compile — the language's own sites and the document compiler's
     * node-pinned ones interleave in it. */
    std::vector<Diag> runtime_faults;

    /* the frame's extent (above): the one record of what a run's in-flight storage
     * costs. Cell text lives apart (the host layout's cell_texts) — a cell's
     * storage and a run's scratch never share an index space. */
    FrameExtent frame;

    /* infer `code`'s signature off its own instructions, lambda bodies included
     * (an Iterate's sub can read the mesh too) */
    Signature infer_signature(const std::vector<Instruction>& code) const;

    /* intern a constant / a text literal, returning its pool index */
    uint32_t add_text(const std::string& text);
    uint32_t add_constant(Value value);
    /* intern a compiled lambda body, returning the index Iterate names */
    uint32_t add_sub(std::vector<Instruction> code, uint32_t max_stack);
    /* register a runtime finding an instruction can fault to (site index = c) */
    uint32_t add_fault_site(const std::string& code, const std::string& message);
};

} // namespace hmi

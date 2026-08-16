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

/* One runnable body. A lambda is a NESTED procedure (spec 6.4): a plain instruction
 * run that executes on a stack frame ABOVE its caller's and reads its parameter where
 * a flow reads `x`. `max_stack` is its own frame's depth, which the layout adds on top
 * of the enclosing run's so the two never overlap. */
struct Procedure {
    std::vector<Instruction> code;
    uint32_t max_stack = 0;
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

    /* WHAT THE COMPILED CODE NEEDS OF STORAGE, counted as it lowers: a text-producing
     * site's fixed result slot, a list-producing site's worst case in the run's
     * element pool, and the one stack tall enough for the deepest run PLUS the deepest
     * lambda body. The text-slot counter is also the cell allocator's — cells and
     * expression sites share one index space into the run's text table. All of this
     * dies at stage 6a, when the frame arena replaces compile-time slot allocation. */
    uint32_t text_slots = 0;
    uint32_t elem_values = 0;
    uint32_t elem_texts = 0;
    uint32_t stack_values = 1;
    uint32_t sub_stack = 0;

    /* intern a constant / a text literal, returning its pool index */
    uint32_t add_text(const std::string& text);
    uint32_t add_constant(Value value);
    /* intern a compiled lambda body, returning the index Iterate names */
    uint32_t add_sub(std::vector<Instruction> code, uint32_t max_stack);
    /* register a runtime finding an instruction can fault to (site index = c) */
    uint32_t add_fault_site(const std::string& code, const std::string& message);
};

} // namespace hmi

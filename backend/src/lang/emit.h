/* What the expression compiler needs from whatever it is compiling INTO.
 *
 * The scalar compiler used to take a `Program&` and reach into it, which put the whole
 * runtime model — entities, cells, feeds, flows, timers — inside the language's headers
 * for the sake of a handful of operations. This is those operations, and it is the
 * entire coupling between lang/ and vm/: a constant pool, a text pool, the enum
 * vocabulary shape checking reads, the two allocation counters a text- or list-producing
 * site bumps, the lambda-body table, and the one runtime finding an iteration can hit.
 *
 * Virtual rather than a template because the implementation is 965 lines that have no
 * business in a header, and because this is compile-time work: nothing here is ever
 * called on the tick. */
#pragma once

#include "lang/ir.h"
#include "lang/value.h"

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace hmi {

/* an enum type's vocabulary: variant name -> backing integer, in declaration order */
using EnumVariants = std::vector<std::pair<std::string, int64_t>>;

struct EmitSink {
    virtual ~EmitSink() = default;

    /* intern a constant / a text literal, returning its pool index */
    virtual uint32_t add_constant(Value value) = 0;
    virtual uint32_t add_text(const std::string& text) = 0;

    /* the vocabulary behind a type-table id, null when that id names no enum. Read-only:
     * the language checks variant names against it and never adds a type. */
    virtual const EnumVariants* enum_variants(uint16_t type_id) const = 0;

    /* a text-producing site owns one fixed slot for its result, so runtime text costs no
     * allocation and no cursor */
    virtual uint32_t alloc_text_slot() = 0;

    /* a list-producing site reserves its worst case in the run's element pool */
    virtual void reserve_elems(uint32_t values, uint32_t texts) = 0;

    /* intern a compiled lambda body (spec 6.4), returning the index Iterate names in its
     * `a` operand. `max_stack` is the body's own frame depth: the sink reports it upward
     * so the layout can size one stack tall enough for a run plus a body on top of it. */
    virtual uint32_t add_sub(std::vector<Instruction> code, uint32_t max_stack) = 0;

    /* register a RUNTIME FINDING an instruction can fault to, returning its site index.
     * The language needs exactly one: an iteration whose source outran its trip bound
     * must say so by name rather than quietly fold the portion of the list it reached. */
    virtual uint32_t add_fault_site(const std::string& code,
                                    const std::string& message) = 0;
};

} // namespace hmi

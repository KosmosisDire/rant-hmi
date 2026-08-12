/* The scalar expression compiler: the authored language of feeds, flow guards and move
 * sources (spec 6), lowered to the instruction form in lang/ir.h.
 *
 * It knows nothing about instances, entities, cells or flows. Names arrive already
 * resolved as Bindings — the CALLER decided what `setpoint` addresses — and everything
 * emitted lands through an EmitSink (lang/emit.h). That is what lets the same compiler
 * serve the backend's Program and anything else that can hold a constant pool. */
#pragma once

#include "lang/emit.h"
#include "lang/ir.h"

#include <string>
#include <unordered_map>
#include <vector>

namespace hmi {

enum class ExprTier : uint8_t { Display, Wire };

struct Binding {
    Shape shape = Shape::Unknown;
    OpCode load = OpCode::Load;
    uint32_t a = 0;
    uint32_t b = 0;
    uint16_t enum_type = 0;   /* Enum-shaped bindings: the Program.enum_types id */
    /* List/Map-shaped bindings: the ELEMENT shape, so `@plant.names.map(v =>
       v.upper())` types its lambda parameter the way the old feed x did */
    Shape elem = Shape::Unknown;
};

struct ExpressionScope {
    /* true where the surface HAS no pipeline register (a slot expression): `x` is
       refused by name instead of silently reading Nil */
    bool no_x = false;
    Shape x_shape = Shape::Unknown;
    uint16_t x_enum = 0;      /* when x_shape is Enum: its Program.enum_types id */
    Shape x_elem = Shape::Unknown;   /* when x_shape is List/Map: the element shape */
    /* when x_shape is Timer (the feed's source IS a timer variable): which timer,
       so x.running / x.remaining / x.duration compile to timer-table reads */
    uint32_t x_timer = UINT32_MAX;
    std::unordered_map<std::string, Binding> names;
    std::unordered_map<std::string, Binding> qualified;
    /* WHY A NAME IS NOT HERE, in the caller's words: appended to every unknown-name and
     * unknown-entity refusal. A deliberately narrow scope (a component's insides, which
     * see their own properties and nothing of the page) is not a typo, and the author
     * needs the way in — not a shorter list. Empty = the plain refusal. */
    std::string unknown_help;
    /* WORDS THAT MEAN SOMETHING IN THE LANGUAGE BUT NOTHING HERE, each with the reason
     * (`repeat` in a flow no copy can trigger). "Unknown name" would send the author
     * hunting for a typo in a word that is spelled right; the whole message is the
     * caller's, because only the caller knows why this surface is the wrong one. A name
     * the scope really BINDS still wins — a variable called `repeat` is that author's
     * variable — so this answers only where nothing else does. */
    std::unordered_map<std::string, std::string> refused;
};

struct ExpressionResult {
    Shape shape = Shape::Unknown;
    uint16_t enum_type = 0;   /* when shape is Enum: the id, so a chain can keep it */
    uint32_t max_stack = 0;
};

/* `allow_agg` says the DESTINATION is an HMI aggregate — a list/map variable or slot,
 * or one element of one — so an aggregate RESULT is legal here and the CALLER checks
 * the shape, against what that destination declares it holds. Everywhere else the wire
 * tier's one-scalar rule stands: a machine write is one scalar. The flag rather than a
 * shape, because the caller's check is the better one: it can name the destination, what
 * one element of it is, and the declaration that would accept what the author wrote. */
bool compile_expression(const std::string& text, ExprTier tier,
                        const ExpressionScope& scope, EmitSink& sink,
                        std::vector<Instruction>& code, ExpressionResult& result,
                        std::string& error, bool allow_agg = false);

/* The language, as data (spec 3.7 / "everything is data"): one row per builtin and
 * method, straight from the tables the parser compiles with, so autocomplete can
 * never disagree with what compiles. args entries are shape names ("any" = unchecked);
 * result "elem" marks the element-shape passthroughs (first/last/get/pick). */
struct LangRow {
    const char* kind;       /* "builtin" | "method" */
    const char* receiver;   /* method rows: the receiver shape name; builtins: "" */
    const char* name;
    uint32_t min_args = 0;
    uint32_t max_args = 0;
    const char* args[5] = {};
    const char* result = "";
    bool display_only = false;
    /* method rows: a property reads bare (x.length); a method is called (x.trim()) */
    bool property = false;
    /* does the VIEW tier (template_expr.cpp) have an encoding for this row at all --
     * NOT the same question `display_only` answers. A row can be scalar-both-tier and
     * still have no view opcode (mapRange did, until this was added), and a row can be
     * display-only and still be perfectly view-legal (rgb). Autocomplete in an
     * ATTRIBUTE field must offer exactly the rows where this is true; offering a
     * display-tier row that the view then refuses at compile is the lie spec 3.7
     * promises never happens. */
    bool view = false;
};

const std::vector<LangRow>& language_reference();

/* What the VIEW tier may do with a builtin name, read off the same table the scalar
 * compiler parses with (lang/expression.cpp). The template-expression compiler used to
 * carry its own unary/binary opcode arrays plus a hand-written refusal list; three
 * copies of one fact, and adding a builtin meant remembering all of them. */
struct ViewBuiltin {
    bool known = false;        /* names a builtin at all (else "unknown function") */
    const char* op = "";       /* the view opcode; "" = no view encoding */
    bool bespoke = false;      /* the template compiler folds this one itself (clamp) */
    uint32_t min_args = 0;
    uint32_t max_args = 0;
};

ViewBuiltin view_builtin(const std::string& name);

/* The method-table twin of view_builtin(). parse_postfix (template_expr.cpp) is
 * hand-rolled rather than table-driven -- unlike free functions, a dotted call also has
 * to decide property-vs-called and, for a receiver like `x[i]`, the view carries no
 * shape to check a receiver against -- so this is keyed on the NAME alone. Safe today
 * because every view-encoded method (pick, toFixed, clamp, the color accessors,
 * alpha, mix) is a name unique across the whole table; a future name that gained a
 * namesake on another receiver would need this widened to take the receiver the
 * caller does not actually have. */
struct ViewMethod {
    bool known = false;
    const char* op = "";
    bool bespoke = false;
    bool property = false;
    uint32_t args = 0;
};

ViewMethod view_method(const std::string& name);

} // namespace hmi

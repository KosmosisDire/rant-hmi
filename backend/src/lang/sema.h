/* Phase three of the expression pipeline: Ast + Env -> a CHECKED tree. The checker
 * answers every question of meaning — what a name is, what a dot does, what type each
 * node yields, which table row a call names — and writes the answers as Notes beside
 * the nodes. The emitter (lower.h) reads Notes and never decides anything.
 *
 * It accepts and rejects EXACTLY what the old single-pass shape tracker did (the
 * rewrite plan, stage 2): every rule here is a port, including the ones stage 4
 * replaces. It writes nothing — checking is pure. */
#pragma once

#include "lang/ast.h"
#include "lang/env.h"
#include "lang/expression.h"
#include "lang/tables.h"

#include <string>
#include <vector>

namespace hmi {

struct Note {
    Type type;   /* what the node yields */
    enum class Op : uint8_t {
        None,         /* structure the emitter reads off ExprKind alone */
        Load,         /* a resolved place read (a name head, members consumed) */
        BuiltinCall,
        MethodCall,
        IsVariant,    /* enum .is(v): a constant compare */
        Iterate,      /* the lambda-taking methods */
        TextJoin,     /* `+` with a text side */
        ColorScale,
        ColorDiv,
        VariantConst, /* `.variant` resolved against the enum its context expects */
        VariantsOf,   /* enum .variants(): the vocabulary as a constant list */
    } op = Op::None;
    Place place;
    const BuiltinSpec* builtin = nullptr;
    const MethodSpec* method = nullptr;
    /* VariantsOf: the receiver's vocabulary, resolved from its TYPE at check —
       what the emitter spells out as constants (the receiver's value is unused
       and, expressions being pure, never evaluated) */
    const EnumVariants* vocabulary = nullptr;
    IterateMode mode = IterateMode::Map;
    bool over_map = false;
    int64_t variant = 0;        /* IsVariant / VariantConst: the backing value */
    uint16_t variant_type = 0;  /* ...and its enum type id */
    uint32_t rgba = 0;          /* ColorLit */
};

/* On success `notes` holds one Note per Ast node and `result` the root's type; on
 * refusal `out` holds EVERY independent finding as DATA (expression.h Refusal) —
 * depth-first, left-to-right, so the first entry is the error the surface always
 * led with; a broken subtree suppresses whatever DEPENDED on it, never its
 * siblings: every independent subtree is checked, and `notes` keeps every
 * resolution the walk reached even when the whole refuses — a rename reads its
 * references off exactly these notes. `dest` is
 * the DESTINATION as data: its type is what a `.variant` literal at the root (or
 * in a ternary arm on the way there) resolves its vocabulary against, and whether
 * it takes an aggregate is what the wire tier's one-scalar rule reads. */
bool check_expression(const Ast& ast, ExprTier tier, const Env& env,
                      std::vector<Note>& notes, Type& result,
                      std::vector<Refusal>& out, const Dest& dest = Dest());

} // namespace hmi

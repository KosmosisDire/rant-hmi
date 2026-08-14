/* Phase three of the expression pipeline: Ast + Env -> a CHECKED tree. The checker
 * answers every question of meaning — what a name is, what a dot does, what type each
 * node yields, which table row a call names — and writes the answers as Notes beside
 * the nodes. The emitter (lower.h) reads Notes and never decides anything.
 *
 * It accepts and rejects EXACTLY what the old single-pass shape tracker did (the
 * rewrite plan, stage 2): every rule here is a port, including the ones stage 4
 * replaces. It touches no sink — checking is pure. */
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
        VariantConst, /* `.variant` on the right of an equality */
    } op = Op::None;
    Place place;
    const BuiltinSpec* builtin = nullptr;
    const MethodSpec* method = nullptr;
    IterateMode mode = IterateMode::Map;
    bool over_map = false;
    int64_t variant = 0;        /* IsVariant / VariantConst: the backing value */
    uint16_t variant_type = 0;  /* ...and its enum type id */
    uint32_t rgba = 0;          /* ColorLit */
};

/* On success `notes` holds one Note per Ast node and `result` the root's type; on
 * refusal `error` reads "<what> at column <n>" (or, for the wire tier's one-scalar
 * rule, the columnless teaching the surface always gave). */
bool check_expression(const Ast& ast, ExprTier tier, const Env& env, bool allow_agg,
                      std::vector<Note>& notes, Type& result, std::string& error);

} // namespace hmi

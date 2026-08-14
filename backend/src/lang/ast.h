/* The expression AST: what the parser produces and the only thing the checker and the
 * emitter ever walk. Pure syntax — no scope, no tier, no types — which is what keeps
 * the phases separate and ordered (lex, parse, check, emit) with no phase reaching
 * backwards. Nodes live in one flat arena and name each other by index, so the whole
 * tree is a printable value. */
#pragma once

#include "lang/lexer.h"

#include <cstdint>
#include <string>
#include <vector>

namespace hmi {

constexpr uint32_t kNoExpr = UINT32_MAX;

enum class ExprKind : uint8_t {
    Number,
    Text,
    ColorLit,
    BoolLit,
    ListLit,    /* [a, b, c] — elements in args */
    Name,       /* an identifier head; what it means is the checker's question */
    EntityRef,  /* @path */
    ThemeRef,   /* $name — a theme token literal (view vocabulary; the scalar
                   checker refuses it the way its grammar always did) */
    Variant,    /* .name — legal only as the right side of == / != */
    Lambda,     /* params => body (a), legal only as an iterating method's argument */
    Prefix,     /* op(a): - ! not */
    Binary,     /* a op b */
    Ternary,    /* a ? b : c */
    Member,     /* a.text, called with args when `called` */
    Index,      /* a[b] */
    Call,       /* text(args) — a free function */
};

struct Expr {
    ExprKind kind = ExprKind::Number;
    TokenKind op = TokenKind::End;    /* Prefix/Binary: the operator */
    double number = 0;                /* Number/BoolLit(0/1) */
    std::string text;                 /* names, member names, text/color payloads */
    uint32_t a = kNoExpr;             /* first child (receiver, condition, operand) */
    uint32_t b = kNoExpr;             /* second child */
    uint32_t c = kNoExpr;             /* third child (a ternary's false arm) */
    std::vector<uint32_t> args;       /* Call/Member arguments, ListLit elements */
    std::vector<std::string> params;  /* Lambda parameter names */
    bool called = false;              /* Member: written with parentheses */
    /* a call argument shaped like `expr => expr`: the head was an expression rather
     * than a parameter list. The checker owns the refusal, because what it says
     * depends on what the receiver turns out to be. */
    bool malformed = false;
    size_t at = 0, length = 0;        /* the span in the source */
    /* Where the token AFTER this node starts — the position the old single-pass
     * compiler anchored its refusals to, kept so every diagnostic column survives
     * the rewrite byte for byte. For a Member, `name_after` anchors refusals about
     * the NAME itself (a method read without its parentheses). */
    size_t after = 0;
    size_t name_after = 0;
    /* Member: where the name token itself starts — the anchor for refusals about
     * an unknown FIELD, which the view tier points at the word, not past it. */
    size_t name_at = 0;
};

struct Ast {
    std::vector<Expr> nodes;
    uint32_t root = kNoExpr;

    const Expr& at(uint32_t index) const { return nodes[index]; }
};

} // namespace hmi

/* The expression lexer: one spelling of every token for the one parser (parser.h).
 * Both emitters — the scalar tier's (lower.h, VM instructions) and the view tier's
 * (template_expr.h, view programs) — read the same AST, so the two dialects cannot
 * drift at any level below emission. */
#pragma once

#include <string>

namespace hmi {

enum class TokenKind {
    End,
    Invalid,
    Number,
    String,
    Color,
    Ident,
    Theme,     /* $<name>: a theme token literal. The parser carries it for the view
                  emitter; the scalar checker refuses it the way its grammar always
                  did. */
    Entity,    /* @<path>: a MESH ENTITY reference (`@cage/plc/gSafety`). The `@`
                  consumes identifier characters plus '/', because RANT names are
                  path-spelled and '/' is otherwise division; the dot that follows is
                  ordinary field access. Only scopes that BIND entities (a slot
                  expression's) resolve it; everywhere else it is an unknown name. */
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Dot,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Bang,
    EqEq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    AndAnd,
    OrOr,
    /* the word spellings of the boolean operators (spec 6.2), as REAL KEYWORD
     * tokens rather than a lexer rewrite into the symbol kinds: `a and not b`
     * reads the way an operator writes it, and a parser that meets one after a
     * dot still has the word — a method named `not` stays a name. */
    KwAnd,
    KwOr,
    KwNot,
    /* `nil` (spec 2.4): the UNKNOWN literal, a keyword like the word operators so a
     * field or method named nil still reads after a dot */
    KwNil,
    /* the conditional operator, `c ? a : b` (spec 6.2). Both tiers lower it to the same
     * thing `.pick()` already lowers to, so it is surface sugar over machinery that was
     * always there -- no opcode, no VM case, no view-interpreter case. */
    Question,
    Colon,
    /* `a ?? b` (spec 2.4): b where a is UNKNOWN, a everywhere else — the language's
     * one way to give an unknown a default instead of letting it propagate */
    Coalesce,
    /* `=>`: the lambda arrow (spec 6.4). One parameter, one expression body, legal only
     * as a direct argument to an iterating method -- the parser refuses it anywhere
     * else, so the token being lexable everywhere costs nothing. */
    Arrow,
};

struct Token {
    TokenKind kind = TokenKind::End;
    std::string text;
    double number = 0;
    /* the SPAN in the source: [at, at + length). `length` counts source
     * characters (a string token spans its quotes and escapes), so a diagnostic
     * can underline exactly what was written. */
    size_t at = 0;
    size_t length = 0;
};

class Lexer {
  public:
    explicit Lexer(const std::string& source) : source_(source) {}

    Token next();

  private:
    Token scan();
    Token number();
    Token ident();
    Token theme();
    Token entity();
    Token string(char quote);
    Token color();

    const std::string& source_;
    size_t at_ = 0;
};

} // namespace hmi

/* The expression lexer, shared by the two compilers that read the same surface
 * grammar: the scalar compiler (expression.cpp, lowering to VM instructions) and the
 * template-expression compiler (template_expr.cpp, lowering to view programs). One
 * lexer means one spelling of every token, so the two dialects can never drift at the
 * character level. */
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
    Theme,     /* $<name>: a theme token literal (template expressions only; the
                  scalar parser refuses it as an unexpected token) */
    Entity,    /* @<path>: a MESH ENTITY reference (`@cage/plc/gSafety`). The `@`
                  consumes identifier characters plus '/', because DART names are
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
    /* the conditional operator, `c ? a : b` (spec 6.2). Both tiers lower it to the same
     * thing `.pick()` already lowers to, so it is surface sugar over machinery that was
     * always there -- no opcode, no VM case, no view-interpreter case. */
    Question,
    Colon,
    /* `=>`: the lambda arrow (spec 6.4). One parameter, one expression body, legal only
     * as a direct argument to an iterating method -- the parser refuses it anywhere
     * else, so the token being lexable everywhere costs nothing. */
    Arrow,
};

struct Token {
    TokenKind kind = TokenKind::End;
    std::string text;
    double number = 0;
    size_t at = 0;
};

class Lexer {
  public:
    explicit Lexer(const std::string& source) : source_(source) {}

    Token next();

  private:
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

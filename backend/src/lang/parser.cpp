#include "lang/parser.h"

#include "lang/lexer.h"
#include "lang/value.h"

namespace hmi {
namespace {

class Parser {
  public:
    Parser(const std::string& source, Ast& out, std::string& error)
        : out_(out), error_(error) {
        Lexer lexer(source);
        for (;;) {
            tokens_.push_back(lexer.next());
            if (tokens_.back().kind == TokenKind::End) break;
        }
    }

    bool parse() {
        out_.root = ternary();
        if (!error_.empty()) return false;
        if (token().kind != TokenKind::End)
            return fail("unexpected '" + token().text + "'");
        return true;
    }

  private:
    const Token& token(size_t ahead = 0) const {
        const size_t at = std::min(at_ + ahead, tokens_.size() - 1);
        return tokens_[at];
    }

    void advance() {
        if (at_ + 1 < tokens_.size()) ++at_;
    }

    bool fail(const std::string& message) {
        if (error_.empty())
            error_ = message + " at column " + std::to_string(token().at + 1);
        return false;
    }

    /* a fresh node spanning from `start`; `after` is stamped when the node closes */
    uint32_t node(ExprKind kind, size_t start) {
        Expr expr;
        expr.kind = kind;
        expr.at = start;
        out_.nodes.push_back(std::move(expr));
        return static_cast<uint32_t>(out_.nodes.size() - 1);
    }

    uint32_t close(uint32_t index) {
        Expr& expr = out_.nodes[index];
        expr.length = token().at > expr.at ? token().at - expr.at : 0;
        expr.after = token().at;
        return index;
    }

    /* is the token run at `from` a lambda head — `name =>` or `(name, ...) =>`? */
    bool lambda_ahead() const {
        if (token().kind == TokenKind::Ident)
            return token(1).kind == TokenKind::Arrow;
        if (token().kind != TokenKind::LParen) return false;
        size_t ahead = 1;
        if (token(ahead).kind != TokenKind::Ident) return false;
        for (;;) {
            ++ahead;
            if (token(ahead).kind == TokenKind::Comma) {
                if (token(++ahead).kind != TokenKind::Ident) return false;
                continue;
            }
            break;
        }
        return token(ahead).kind == TokenKind::RParen &&
               token(ahead + 1).kind == TokenKind::Arrow;
    }

    uint32_t lambda() {
        const uint32_t made = node(ExprKind::Lambda, token().at);
        if (token().kind == TokenKind::LParen) {
            advance();
            for (;;) {
                out_.nodes[made].params.push_back(token().text);
                advance();
                if (token().kind != TokenKind::Comma) break;
                advance();
            }
            advance();   /* the ')' the lookahead proved */
        } else {
            out_.nodes[made].params.push_back(token().text);
            advance();
        }
        out_.nodes[made].name_after = token().at;   /* the arrow */
        advance();   /* the '=>' */
        const uint32_t body = ternary();
        out_.nodes[made].a = body;
        return close(made);
    }

    uint32_t ternary() {
        uint32_t cond = coalesce();
        if (!error_.empty() || token().kind != TokenKind::Question) return cond;
        const uint32_t made = node(ExprKind::Ternary, out_.nodes[cond].at);
        advance();
        const uint32_t yes = ternary();
        if (token().kind != TokenKind::Colon) {
            fail("expected ':' to complete the conditional");
            return kNoExpr;
        }
        advance();
        const uint32_t no = ternary();
        if (!error_.empty()) return kNoExpr;
        Expr& expr = out_.nodes[made];
        expr.a = cond;
        expr.b = yes;
        expr.c = no;
        return close(made);
    }

    uint32_t binary_chain(uint32_t (Parser::*next)(),
                          bool (*wants)(TokenKind)) {
        uint32_t left = (this->*next)();
        while (error_.empty() && wants(token().kind)) {
            const uint32_t made = node(ExprKind::Binary, out_.nodes[left].at);
            out_.nodes[made].op = token().kind;
            advance();
            const uint32_t right = (this->*next)();
            if (!error_.empty()) return kNoExpr;
            out_.nodes[made].a = left;
            out_.nodes[made].b = right;
            left = close(made);
        }
        return left;
    }

    /* `a ?? b` binds looser than || so a whole condition can take a default, and
     * tighter than ?: so a ternary arm can carry one */
    uint32_t coalesce() {
        return binary_chain(&Parser::or_chain, [](TokenKind k) {
            return k == TokenKind::Coalesce;
        });
    }

    uint32_t or_chain() {
        return binary_chain(&Parser::and_chain, [](TokenKind k) {
            return k == TokenKind::OrOr || k == TokenKind::KwOr;
        });
    }

    uint32_t and_chain() {
        return binary_chain(&Parser::compare, [](TokenKind k) {
            return k == TokenKind::AndAnd || k == TokenKind::KwAnd;
        });
    }

    /* one comparison, not a chain — `a < b < c` has never parsed */
    uint32_t compare() {
        uint32_t left = sum();
        const TokenKind op = token().kind;
        if (error_.empty() &&
            (op == TokenKind::EqEq || op == TokenKind::Ne || op == TokenKind::Lt ||
             op == TokenKind::Le || op == TokenKind::Gt || op == TokenKind::Ge)) {
            const uint32_t made = node(ExprKind::Binary, out_.nodes[left].at);
            out_.nodes[made].op = op;
            advance();
            const uint32_t right = sum();
            if (!error_.empty()) return kNoExpr;
            out_.nodes[made].a = left;
            out_.nodes[made].b = right;
            left = close(made);
        }
        return left;
    }

    uint32_t sum() {
        return binary_chain(&Parser::product, [](TokenKind k) {
            return k == TokenKind::Plus || k == TokenKind::Minus;
        });
    }

    uint32_t product() {
        return binary_chain(&Parser::unary, [](TokenKind k) {
            return k == TokenKind::Star || k == TokenKind::Slash ||
                   k == TokenKind::Percent;
        });
    }

    uint32_t unary() {
        const TokenKind op = token().kind;
        if (op == TokenKind::Minus || op == TokenKind::Bang ||
            op == TokenKind::KwNot) {
            const uint32_t made = node(ExprKind::Prefix, token().at);
            out_.nodes[made].op = op;
            advance();
            const uint32_t inner = unary();
            if (!error_.empty()) return kNoExpr;
            out_.nodes[made].a = inner;
            return close(made);
        }
        return postfix();
    }

    /* is the postfix chain under `index` a plain dotted name — a Name or entity head
     * reached only through uncalled members? Those dots read as FIELD access (the
     * field-tree walk); everything else's read as a method. */
    bool plain_names(uint32_t index) const {
        const Expr& expr = out_.nodes[index];
        if (expr.kind == ExprKind::Name || expr.kind == ExprKind::EntityRef)
            return true;
        return expr.kind == ExprKind::Member && !expr.called && plain_names(expr.a);
    }

    uint32_t postfix() {
        uint32_t receiver = primary();
        while (error_.empty() && (token().kind == TokenKind::Dot ||
                                  token().kind == TokenKind::LBracket)) {
            if (token().kind == TokenKind::LBracket) {
                const uint32_t made = node(ExprKind::Index, out_.nodes[receiver].at);
                advance();
                const uint32_t key = ternary();
                if (token().kind != TokenKind::RBracket) {
                    fail("expected ']'");
                    return kNoExpr;
                }
                advance();
                out_.nodes[made].a = receiver;
                out_.nodes[made].b = key;
                receiver = close(made);
                continue;
            }
            const uint32_t made = node(ExprKind::Member, out_.nodes[receiver].at);
            advance();
            /* a keyword after a dot is just a name: `x.not()` stands */
            if (token().kind != TokenKind::Ident && token().kind != TokenKind::KwAnd &&
                token().kind != TokenKind::KwOr && token().kind != TokenKind::KwNot &&
                token().kind != TokenKind::KwNil) {
                fail(plain_names(receiver) ? "expected a field after '.'"
                                           : "expected a method after '.'");
                return kNoExpr;
            }
            out_.nodes[made].name_at = token().at;
            out_.nodes[made].text = token().text;
            advance();
            out_.nodes[made].name_after = token().at;
            if (token().kind == TokenKind::LParen) {
                out_.nodes[made].called = true;
                advance();
                if (!arguments(made, "expected ')' after method arguments"))
                    return kNoExpr;
            }
            out_.nodes[made].a = receiver;
            receiver = close(made);
        }
        return receiver;
    }

    /* a call's argument list, ')' already expected; `made` collects the nodes. An
     * argument may be a lambda; `expr => expr` parses as a MALFORMED one, because
     * what to say about it depends on what the receiver turns out to be. */
    bool arguments(uint32_t made, const char* closing) {
        if (token().kind != TokenKind::RParen) {
            for (;;) {
                uint32_t arg;
                if (lambda_ahead()) {
                    arg = lambda();
                } else {
                    arg = ternary();
                    if (error_.empty() && token().kind == TokenKind::Arrow) {
                        const uint32_t bad =
                            node(ExprKind::Lambda, out_.nodes[arg].at);
                        out_.nodes[bad].malformed = true;
                        out_.nodes[bad].b = arg;
                        advance();
                        out_.nodes[bad].a = ternary();
                        arg = close(bad);
                    }
                }
                if (!error_.empty()) return false;
                out_.nodes[made].args.push_back(arg);
                if (token().kind != TokenKind::Comma) break;
                advance();
            }
        }
        if (token().kind != TokenKind::RParen) return fail(closing);
        advance();
        return true;
    }

    uint32_t primary() {
        const Token& t = token();
        if (lambda_ahead()) return lambda();
        switch (t.kind) {
            case TokenKind::Dot: {
                /* `.Variant` (spec 6.2): a leading-dot variant literal — an
                   expression anywhere one is; the checker resolves it against
                   the enum its CONTEXT expects (the other side of an equality,
                   the destination being written, a ternary arm's expectation) */
                advance();
                if (token().kind != TokenKind::Ident) {
                    fail("expected a variant name after '.'");
                    return kNoExpr;
                }
                const uint32_t made = node(ExprKind::Variant, t.at);
                out_.nodes[made].text = token().text;
                advance();
                return close(made);
            }
            case TokenKind::Number: {
                const uint32_t made = node(ExprKind::Number, t.at);
                out_.nodes[made].number = t.number;
                advance();
                return close(made);
            }
            case TokenKind::KwNil: {
                const uint32_t made = node(ExprKind::NilLit, t.at);
                advance();
                return close(made);
            }
            case TokenKind::String: {
                const uint32_t made = node(ExprKind::Text, t.at);
                out_.nodes[made].text = t.text;
                advance();
                return close(made);
            }
            case TokenKind::Color: {
                /* validity is lexical — a five-digit run is wrong before any scope
                   exists — so the refusal lands here, not in the checker */
                bool ok = false;
                parse_color(t.text, ok);
                if (!ok) {
                    fail("invalid color literal");
                    return kNoExpr;
                }
                const uint32_t made = node(ExprKind::ColorLit, t.at);
                out_.nodes[made].text = t.text;
                advance();
                return close(made);
            }
            case TokenKind::LParen: {
                advance();
                const uint32_t inner = ternary();
                if (!error_.empty()) return kNoExpr;
                if (token().kind != TokenKind::RParen) {
                    fail("expected ')'");
                    return kNoExpr;
                }
                advance();
                /* the parens leave no node; the span stays the inner expression's */
                return inner;
            }
            case TokenKind::LBracket: {
                /* an ARRAY literal: [a, b, c] gathers scattered values into a list */
                const uint32_t made = node(ExprKind::ListLit, t.at);
                advance();
                if (token().kind != TokenKind::RBracket) {
                    for (;;) {
                        const uint32_t element = ternary();
                        if (!error_.empty()) return kNoExpr;
                        out_.nodes[made].args.push_back(element);
                        if (token().kind != TokenKind::Comma) break;
                        advance();
                    }
                }
                if (token().kind != TokenKind::RBracket) {
                    fail("expected ']'");
                    return kNoExpr;
                }
                advance();
                return close(made);
            }
            case TokenKind::Entity: {
                const uint32_t made = node(ExprKind::EntityRef, t.at);
                out_.nodes[made].text = "@" + t.text;
                advance();
                return close(made);
            }
            case TokenKind::Theme: {
                const uint32_t made = node(ExprKind::ThemeRef, t.at);
                out_.nodes[made].text = t.text;
                advance();
                return close(made);
            }
            case TokenKind::Ident: {
                if (t.text == "true" || t.text == "false") {
                    const uint32_t made = node(ExprKind::BoolLit, t.at);
                    out_.nodes[made].number = t.text == "true" ? 1 : 0;
                    advance();
                    return close(made);
                }
                if (token(1).kind == TokenKind::LParen) {
                    const uint32_t made = node(ExprKind::Call, t.at);
                    out_.nodes[made].text = t.text;
                    advance();
                    out_.nodes[made].name_after = token().at;   /* the '(' */
                    advance();
                    if (!arguments(made, "expected ')' after arguments"))
                        return kNoExpr;
                    return close(made);
                }
                const uint32_t made = node(ExprKind::Name, t.at);
                out_.nodes[made].text = t.text;
                advance();
                return close(made);
            }
            default:
                fail("expected an expression");
                return kNoExpr;
        }
    }

    Ast& out_;
    std::string& error_;
    std::vector<Token> tokens_;
    size_t at_ = 0;
};

} // namespace

bool parse_expression(const std::string& source, Ast& out, std::string& error) {
    Parser parser(source, out, error);
    return parser.parse();
}

} // namespace hmi

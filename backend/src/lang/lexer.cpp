#include "lang/lexer.h"

#include <cctype>
#include <cstdlib>

namespace hmi {

/* every sub-lexer leaves at_ one past its token, so the span is closed here once */
Token Lexer::next() {
    Token token = scan();
    token.length = at_ - token.at;
    return token;
}

Token Lexer::scan() {
    while (at_ < source_.size() && std::isspace(static_cast<unsigned char>(source_[at_])))
        ++at_;
    Token token;
    token.at = at_;
    if (at_ >= source_.size()) return token;
    const char c = source_[at_++];
    token.text.assign(1, c);
    auto two = [&](char wanted, TokenKind yes, TokenKind no) {
        if (at_ < source_.size() && source_[at_] == wanted) {
            ++at_;
            token.kind = yes;
        } else {
            token.kind = no;
        }
    };
    switch (c) {
        case '(': token.kind = TokenKind::LParen; return token;
        case ')': token.kind = TokenKind::RParen; return token;
        case '[': token.kind = TokenKind::LBracket; return token;
        case ']': token.kind = TokenKind::RBracket; return token;
        case ',': token.kind = TokenKind::Comma; return token;
        case '.':
            if (at_ < source_.size() && std::isdigit(static_cast<unsigned char>(source_[at_]))) {
                --at_;
                return number();
            }
            token.kind = TokenKind::Dot;
            return token;
        case '+': token.kind = TokenKind::Plus; return token;
        case '-': token.kind = TokenKind::Minus; return token;
        case '*': token.kind = TokenKind::Star; return token;
        case '/': token.kind = TokenKind::Slash; return token;
        case '%': token.kind = TokenKind::Percent; return token;
        case '?': token.kind = TokenKind::Question; return token;
        case ':': token.kind = TokenKind::Colon; return token;
        case '!': two('=', TokenKind::Ne, TokenKind::Bang); return token;
        case '=':
            if (at_ < source_.size() && source_[at_] == '=') {
                ++at_;
                token.kind = TokenKind::EqEq;
            } else if (at_ < source_.size() && source_[at_] == '>') {
                ++at_;
                token.kind = TokenKind::Arrow;
            } else {
                token.kind = TokenKind::Invalid;
            }
            return token;
        case '<': two('=', TokenKind::Le, TokenKind::Lt); return token;
        case '>': two('=', TokenKind::Ge, TokenKind::Gt); return token;
        case '&':
            if (at_ < source_.size() && source_[at_] == '&') {
                ++at_;
                token.kind = TokenKind::AndAnd;
            } else {
                token.kind = TokenKind::Invalid;
            }
            return token;
        case '|':
            if (at_ < source_.size() && source_[at_] == '|') {
                ++at_;
                token.kind = TokenKind::OrOr;
            } else {
                token.kind = TokenKind::Invalid;
            }
            return token;
        case '"':
        case '\'':
            return string(c);
        case '#':
            return color();
        case '$':
            return theme();
        case '@':
            return entity();
        default:
            if (std::isdigit(static_cast<unsigned char>(c))) {
                --at_;
                return number();
            }
            if (std::isalpha(static_cast<unsigned char>(c)) || c == '_') {
                --at_;
                return ident();
            }
            token.kind = TokenKind::Invalid;
            return token;
    }
}

Token Lexer::number() {
    Token token;
    token.kind = TokenKind::Number;
    token.at = at_;
    const char* start = source_.c_str() + at_;
    char* end = nullptr;
    token.number = std::strtod(start, &end);
    at_ += static_cast<size_t>(end - start);
    token.text.assign(start, static_cast<size_t>(end - start));
    return token;
}

Token Lexer::ident() {
    Token token;
    token.kind = TokenKind::Ident;
    token.at = at_;
    const size_t start = at_++;
    while (at_ < source_.size()) {
        const char c = source_[at_];
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_') break;
        ++at_;
    }
    token.text = source_.substr(start, at_ - start);
    if (token.text == "and") token.kind = TokenKind::KwAnd;
    else if (token.text == "or") token.kind = TokenKind::KwOr;
    else if (token.text == "not") token.kind = TokenKind::KwNot;
    return token;
}

/* a theme token reference: `$` consumes identifier characters INCLUDING hyphens
 * ($ink-muted), because token names are spelled the CSS way */
Token Lexer::theme() {
    Token token;
    token.kind = TokenKind::Theme;
    token.at = at_ - 1;
    const size_t start = at_;
    while (at_ < source_.size()) {
        const char c = source_[at_];
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '-') break;
        ++at_;
    }
    token.text = source_.substr(start, at_ - start);
    if (token.text.empty()) {
        token.kind = TokenKind::Invalid;
        token.text = "$";
    }
    return token;
}

/* A mesh entity reference: `@` consumes identifier characters INCLUDING slashes
 * (@cage/plc/IO/wDistanceSensorD), because DART entity names are path-spelled and a
 * bare '/' is division. It stops at '.', which stays ordinary field access — an
 * entity's name never contains a dot, its fields are reached through one. */
Token Lexer::entity() {
    Token token;
    token.kind = TokenKind::Entity;
    token.at = at_ - 1;
    const size_t start = at_;
    while (at_ < source_.size()) {
        const char c = source_[at_];
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '/') break;
        ++at_;
    }
    token.text = source_.substr(start, at_ - start);
    if (token.text.empty()) {
        token.kind = TokenKind::Invalid;
        token.text = "@";
    }
    return token;
}

Token Lexer::string(char quote) {
    Token token;
    token.kind = TokenKind::String;
    token.at = at_ - 1;
    while (at_ < source_.size()) {
        char c = source_[at_++];
        if (c == quote) return token;
        if (c == '\\' && at_ < source_.size()) {
            const char escaped = source_[at_++];
            switch (escaped) {
                case 'n': token.text.push_back('\n'); break;
                case 'r': token.text.push_back('\r'); break;
                case 't': token.text.push_back('\t'); break;
                default: token.text.push_back(escaped); break;
            }
        } else {
            token.text.push_back(c);
        }
    }
    token.kind = TokenKind::Invalid;
    token.text = "unterminated string";
    return token;
}

Token Lexer::color() {
    Token token;
    token.kind = TokenKind::Color;
    token.at = at_ - 1;
    token.text = "#";
    while (at_ < source_.size() &&
           std::isxdigit(static_cast<unsigned char>(source_[at_])))
        token.text.push_back(source_[at_++]);
    return token;
}

} // namespace hmi

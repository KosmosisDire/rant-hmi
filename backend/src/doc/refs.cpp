#include "refs.h"

/* for easing_profile(): whether a transition's `profile` is a BARE EASING NAME (a
 * literal) or expression text is the language's own rule, and the rename has to read it
 * from the same table the compiler does — "ease-out" lexes as two identifiers, so a
 * rename that guessed would corrupt it the day a variable is called `ease`. */
#include "lang/lexer.h"
#include "lang/template_expr.h"

#include <functional>

namespace hmi {
namespace {

bool ident_start(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; }
bool ident_char(char c) { return ident_start(c) || (c >= '0' && c <= '9'); }

/* Call fn(start, len) for every bare identifier — THE LEXER's identifiers (spans and
 * all), never a private spelling of them: a name after '.' is a field or method, a
 * name followed by '(' is a call, and what the lexer owns whole (strings, numbers,
 * colors, `@entity` paths, `$tokens`, the word operators) is no identifier at all.
 * The hand scan this replaced disagreed on exactly those — it saw an identifier
 * inside `@motor.speed`, `1e5` and `#f00`, so a rename could corrupt an entity
 * reference or a literal that happened to spell the variable's name. */
void scan_idents(const std::string& s, const std::function<void(size_t, size_t)>& fn) {
    Lexer lexer(s);
    TokenKind before = TokenKind::End;
    for (Token token = lexer.next(); token.kind != TokenKind::End;) {
        const Token after = lexer.next();
        if (token.kind == TokenKind::Ident && before != TokenKind::Dot &&
            after.kind != TokenKind::LParen)
            fn(token.at, token.length);
        before = token.kind;
        token = after;
    }
}

/* (owner node id, prop key, role, the value to inspect or rewrite) */
using Site = std::function<void(uint64_t, const std::string&, Role, Json&)>;

/* Visit every reference-carrying prop value THIS ELEMENT OWNS, tagged with its role —
 * its attrs, its gestures, its locals' initialisers, its flows and their steps — never
 * the elements nested inside it. Stopping at the element boundary is what lets the
 * caller (scoped_pass) apply the LEXICAL SCOPE rule, which no walk over a flat subtree
 * could: a child that redeclares the name owns everything below it. Only `children`
 * holds elements, so only a Node list is pruned; a flow's steps and a variable's
 * initialiser belong to this element and always ride along. */
void walk_refs(Kind kind, Json& node, const Site& visit) {
    if (!node.is_object()) return;
    const NodeSpec& spec = node_spec(kind);
    const std::string variant = node_variant(spec, node);
    uint64_t id = 0;
    if (auto it = node.find("id"); it != node.end()) id = json_u64_or(*it, 0);
    for (const Prop* p : node_props(spec, variant)) {
        if (p->role == Role::Plain) continue;
        auto it = node.find(p->key);
        if (it == node.end()) continue;
        visit(id, p->key, p->role, *it);
    }
    for (const ChildList* l : node_lists(spec, variant)) {
        if (l->kind == Kind::Node) continue;
        auto it = node.find(l->key);
        if (it == node.end() || !it->is_array()) continue;
        for (Json& child : *it) walk_refs(l->kind, child, visit);
    }
}

/* does this element declare a variable of its own by this name? The one question the
 * scope rule turns on: below such an element the word means something else. */
bool declares_var(const Json& element, const std::string& name) {
    auto it = element.find("locals");
    if (it == element.end() || !it->is_array()) return false;
    for (const Json& var : *it)
        if (var.is_object() && var.value("name", "") == name) return true;
    return false;
}

/* one reference site, reduced to "does it name this variable" plus "rename it" */
void visit_site(Role role, Json& value, const std::string& from, const std::string& to,
                int& hits) {
    switch (role) {
        case Role::VarName:
            if (value.is_string() && value.get<std::string>() == from) {
                ++hits;
                if (!to.empty()) value = to;
            }
            return;
        case Role::EntityRef: {
            if (!value.is_object()) return;
            auto kind = value.find("kind");
            auto name = value.find("name");
            if (kind == value.end() || name == value.end()) return;
            if (!kind->is_string() || kind->get<std::string>() != "L") return;
            if (!name->is_string() || name->get<std::string>() != from) return;
            ++hits;
            if (!to.empty()) *name = to;
            return;
        }
        case Role::Expr: {
            if (!value.is_string()) return;
            const std::string expr = value.get<std::string>();
            if (!expr_uses(expr, from)) return;
            ++hits;
            if (!to.empty()) value = rewrite_ident(expr, from, to);
            return;
        }
        case Role::Triggers: {
            if (!value.is_array()) return;
            for (Json& trigger : value) {
                if (!trigger.is_object()) continue;
                auto kind = trigger.find("kind");
                if (kind == trigger.end() || !kind->is_string() ||
                    kind->get<std::string>() != "timer")
                    continue;
                auto var = trigger.find("var");
                if (var == trigger.end() || !var->is_string()) continue;
                if (var->get<std::string>() != from) continue;
                ++hits;
                if (!to.empty()) *var = to;
            }
            return;
        }
        /* A move's `from` / `to` is one object carrying whichever form it is (spec 2.6),
           so the site dispatches on the key present and reuses the three roles above:
           there is no fourth kind of reference, only a fourth place to find one. */
        case Role::MoveRef: {
            if (!value.is_object()) return;
            if (auto expr = value.find("expr"); expr != value.end())
                visit_site(Role::Expr, *expr, from, to, hits);
            if (auto local = value.find("local"); local != value.end())
                visit_site(Role::VarName, *local, from, to, hits);
            if (value.contains("kind")) visit_site(Role::EntityRef, value, from, to, hits);
            return;
        }
        /* every STRING LEAF is an expression (a number or a bool is a degenerate literal
           with nothing to rename), through objects and arrays alike: an instance's
           `slots` nests one object per element, a node's `attrs` is flat, a path's
           `anchors` is an array of coordinate rows with an `arc` object inside. One
           traversal, because they are one thing — a tree of code. */
        case Role::ExprTree: {
            if (value.is_string()) {
                visit_site(Role::Expr, value, from, to, hits);
                return;
            }
            if (!value.is_object() && !value.is_array()) return;
            for (auto& item : value.items())
                visit_site(Role::ExprTree, item.value(), from, to, hits);
            return;
        }
        /* {attr: {ms, profile?}}: the TIME is an expression whenever it is text (a plain
           number is the button's own spelling), and the PROFILE is an expression unless
           it is one of the bare easing names — those lex as identifiers ("ease-out" is
           two), so blind rewriting would break one the day a variable is called `ease`. */
        case Role::Transitions: {
            if (!value.is_object()) return;
            for (auto& row : value.items()) {
                if (!row.value().is_object()) continue;
                if (auto ms = row.value().find("ms"); ms != row.value().end())
                    visit_site(Role::Expr, *ms, from, to, hits);
                auto profile = row.value().find("profile");
                if (profile == row.value().end() || !profile->is_string()) continue;
                if (easing_profile(profile->get<std::string>())) continue;
                visit_site(Role::Expr, *profile, from, to, hits);
            }
            return;
        }
        /* {primitive, params?, bubbles?}: a gesture's PARAMS are expressions over the
           element's own scope, exactly as its attrs are. `primitive` is a closed
           vocabulary and would otherwise rename like a variable. */
        case Role::Interact: {
            if (!value.is_object()) return;
            if (auto params = value.find("params"); params != value.end())
                visit_site(Role::ExprTree, *params, from, to, hits);
            return;
        }
        case Role::Plain:
            return;
    }
}

} // namespace

bool expr_uses(const std::string& expr, const std::string& name) {
    bool found = false;
    scan_idents(expr, [&](size_t start, size_t len) {
        if (!found && expr.compare(start, len, name) == 0 && len == name.size()) found = true;
    });
    return found;
}

std::string rewrite_ident(const std::string& expr, const std::string& from,
                          const std::string& to) {
    std::string out;
    size_t copied = 0;
    scan_idents(expr, [&](size_t start, size_t len) {
        if (len != from.size() || expr.compare(start, len, from) != 0) return;
        out.append(expr, copied, start - copied);
        out.append(to);
        copied = start + len;
    });
    out.append(expr, copied, std::string::npos);
    return out;
}

namespace {

/* ONE ELEMENT AND EVERYTHING IT LEXICALLY OWNS. `declared_here` marks the element that
 * declares the variable being renamed — its own declaration is not a shadow of itself.
 * `capture` names a second word to watch for: where an element declares THAT, everything
 * below it would be swallowed by the rename, and the first such element is reported.
 *
 * The pruning is the whole point. A rename is a scope operation, and a flat walk over a
 * subtree rewrites references that belong to somebody else's variable of the same name. */
void scoped_pass(Json& element, const std::string& from, const std::string& to,
                 std::vector<RefEdit>* edits, const std::string& capture,
                 bool shadowed, bool declared_here, int& hits, uint64_t& captured_by) {
    if (!element.is_object()) return;
    if (!declared_here && declares_var(element, from)) return;   /* not our variable */
    const bool swallows =
        shadowed || (!capture.empty() && !declared_here && declares_var(element, capture));
    const int before = hits;
    walk_refs(Kind::Node, element,
              [&](uint64_t owner, const std::string& key, Role role, Json& value) {
                  const int at = hits;
                  visit_site(role, value, from, to, hits);
                  if (hits != at && edits) edits->push_back(RefEdit{owner, key, value});
              });
    if (hits != before && swallows && !captured_by)
        captured_by = json_u64_or(element.value("id", Json(0)), 0);
    auto children = element.find("children");
    if (children == element.end() || !children->is_array()) return;
    for (Json& child : *children)
        scoped_pass(child, from, to, edits, capture, swallows, false, hits, captured_by);
}

} // namespace

int rename_scoped(Json& element, const std::string& from, const std::string& to,
                  std::vector<RefEdit>* edits, bool declared_here) {
    int hits = 0;
    uint64_t captured_by = 0;
    scoped_pass(element, from, to, edits, "", false, declared_here, hits, captured_by);
    return hits;
}

uint64_t capture_site(Json& element, const std::string& from, const std::string& name,
                      bool declared_here) {
    int hits = 0;
    uint64_t captured_by = 0;
    scoped_pass(element, from, "", nullptr, name, false, declared_here, hits, captured_by);
    return captured_by;
}

bool valid_name(const std::string& name) {
    if (name.empty() || !ident_start(name[0])) return false;
    for (char c : name)
        if (!ident_char(c)) return false;
    return true;
}

bool valid_token_name(const std::string& name) {
    if (name.empty() || !ident_start(name[0])) return false;
    for (char c : name)
        if (!ident_char(c) && c != '-') return false;
    return true;
}

} // namespace hmi

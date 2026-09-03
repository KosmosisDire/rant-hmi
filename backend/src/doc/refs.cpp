#include "refs.h"

/* for easing_profile(): whether a transition's `profile` is a BARE EASING NAME (a
 * literal) or expression text is the language's own rule, and the rename has to read it
 * from the same table the compiler does — "ease-out" lexes as two identifiers, so a
 * rename that guessed would corrupt it the day a variable is called `ease`. */
#include "lang/lexer.h"
#include "lang/template_expr.h"

#include <algorithm>
#include <functional>

namespace hmi {
namespace {

bool ident_start(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; }
bool ident_char(char c) { return ident_start(c) || (c >= '0' && c <= '9'); }

/* Call fn(start, len) for every bare identifier — THE LEXER's identifiers (spans and
 * all), never a private spelling of them: a name after '.' is a field or method, a
 * name followed by '(' is a call, and what the lexer owns whole (strings, numbers,
 * colors, `@entity` paths, `$tokens`, the word operators) is no identifier at all. */
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
 * its attrs, its gestures, its flows and their steps — never the elements nested inside
 * it. Only `children` holds elements, so only a Node list is pruned; a flow's steps
 * belong to this element and always ride along. The element boundary matters to the
 * caller's EDIT granularity (one set_prop per prop) and to nothing else now: what a
 * name inside a value means is the index's to say, not the walk's. */
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

/* ---- THE MEMBERSHIP PASS: one site at a time, the index deciding everything ---- */

struct Pass {
    const RenamePlan* plan = nullptr;
    RenameOutcome* out = nullptr;
    std::string* err = nullptr;
    bool refused = false;

    void refuse(uint64_t node) {
        if (refused) return;
        refused = true;
        *err = "node " + std::to_string(node) + " does not fully compile where it "
               "names '" + plan->from + "'; fix it before renaming";
    }

    /* the renamed variable's own occurrences in this site: rows resolving to the
     * declaration AND spelling the old name — a `this.value` read resolves to the
     * variable but spells `this`, and the rename must leave that span alone */
    std::vector<size_t> member_spans(uint64_t node, const std::string& text) const {
        std::vector<size_t> spans;
        const std::string& from = plan->from;
        for (const RefRow& row : *plan->rows) {
            if (row.node != node || row.decl != plan->decl || row.text != text) continue;
            if (row.length != from.size() || text.compare(row.at, row.length, from) != 0)
                continue;
            spans.push_back(row.at);
        }
        std::sort(spans.begin(), spans.end());
        spans.erase(std::unique(spans.begin(), spans.end()), spans.end());
        return spans;
    }

    bool blind_site(uint64_t node, const std::string& text) const {
        for (const RefSite& gap : *plan->blind)
            if (gap.node == node && gap.text == text) return true;
        return false;
    }

    /* empty text = the compile abandoned the node whole (a failing step) */
    bool blind_node(uint64_t node) const { return blind_site(node, ""); }
};

/* the rewritten text: every span replaced, everything between kept byte for byte */
std::string splice(const std::string& text, const std::vector<size_t>& spans,
                   size_t length, const std::string& to) {
    std::string out;
    size_t copied = 0;
    for (size_t at : spans) {
        out.append(text, copied, at - copied);
        out.append(to);
        copied = at + length;
    }
    out.append(text, copied, std::string::npos);
    return out;
}

/* one EXPRESSION site: the rows say exactly which occurrences are the variable's (a
 * lambda parameter spelling the same word has no row and keeps its name); a site with
 * no rows refuses only where nothing vouched for it, and skips where the analysis DID
 * run — then the word is somebody else's (a shadow, a parameter). A site the index
 * marked blind by TEXT is partially analyzed at best, so its rows may lie by omission
 * and the name inside it refuses outright. */
void rename_expr(Pass& pass, uint64_t node, Json& value) {
    if (!value.is_string()) return;
    const std::string text = value.get<std::string>();
    pass.out->visited.insert({node, text});
    if (!expr_uses(text, pass.plan->from)) return;
    if (pass.blind_site(node, text)) {
        pass.refuse(node);
        return;
    }
    const std::vector<size_t> spans = pass.member_spans(node, text);
    if (spans.empty()) {
        if (pass.blind_node(node)) pass.refuse(node);
        return;
    }
    const std::string after = splice(text, spans, pass.plan->from.size(), pass.plan->to);
    value = after;
    ++pass.out->hits;
    pass.out->rewrites.push_back(RewrittenSite{node, text, after, spans});
}

/* one WHOLE-WORD site (a move's `local`, a timer's name): atomic, so a row means the
 * whole site resolved and rows outrank a node-level blind mark */
void rename_word(Pass& pass, uint64_t node, Json& value) {
    if (!value.is_string()) return;
    const std::string word = value.get<std::string>();
    pass.out->visited.insert({node, word});
    if (word != pass.plan->from) return;
    if (!pass.member_spans(node, word).empty()) {
        value = pass.plan->to;
        ++pass.out->hits;
        pass.out->rewrites.push_back(
            RewrittenSite{node, word, pass.plan->to, {0}});
        return;
    }
    if (pass.blind_site(node, word) || pass.blind_node(node)) pass.refuse(node);
}

void rename_site(Pass& pass, uint64_t node, Role role, Json& value) {
    switch (role) {
        case Role::VarName:
            rename_word(pass, node, value);
            return;
        case Role::EntityRef: {
            /* {kind:"L", name}: a variable spelled as an entity target — a form the
               compiler refuses outright, so no row can ever vouch for it; where it
               names the variable, the site is exactly the blind case */
            if (!value.is_object()) return;
            auto kind = value.find("kind");
            auto name = value.find("name");
            if (kind == value.end() || name == value.end()) return;
            if (!kind->is_string() || kind->get<std::string>() != "L") return;
            if (!name->is_string()) return;
            pass.out->visited.insert({node, name->get<std::string>()});
            if (name->get<std::string>() == pass.plan->from) pass.refuse(node);
            return;
        }
        case Role::Expr:
            rename_expr(pass, node, value);
            return;
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
                rename_word(pass, node, *var);
            }
            return;
        }
        /* A move's `from` / `to` is one object carrying whichever form it is (spec 2.6),
           so the site dispatches on the key present and reuses the roles above: there is
           no fourth kind of reference, only a fourth place to find one. */
        case Role::MoveRef: {
            if (!value.is_object()) return;
            if (auto expr = value.find("expr"); expr != value.end())
                rename_expr(pass, node, *expr);
            if (auto local = value.find("local"); local != value.end())
                rename_word(pass, node, *local);
            if (value.contains("kind")) rename_site(pass, node, Role::EntityRef, value);
            return;
        }
        /* every STRING LEAF is an expression (a number or a bool is a degenerate literal
           with nothing to rename), through objects and arrays alike: an instance's
           `slots` and a node's `attrs` are flat, a path's `anchors` is an array of
           coordinate rows with an `arc` object inside. */
        case Role::ExprTree: {
            if (value.is_string()) {
                rename_expr(pass, node, value);
                return;
            }
            if (!value.is_object() && !value.is_array()) return;
            for (auto& item : value.items())
                rename_site(pass, node, Role::ExprTree, item.value());
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
                    rename_expr(pass, node, *ms);
                auto profile = row.value().find("profile");
                if (profile == row.value().end() || !profile->is_string()) continue;
                if (easing_profile(profile->get<std::string>())) continue;
                rename_expr(pass, node, *profile);
            }
            return;
        }
        /* {primitive, params?, bubbles?}: a gesture's PARAMS are expressions over the
           element's own scope, exactly as its attrs are. `primitive` is a closed
           vocabulary and would otherwise rename like a variable. */
        case Role::Interact: {
            if (!value.is_object()) return;
            if (auto params = value.find("params"); params != value.end())
                rename_site(pass, node, Role::ExprTree, *params);
            return;
        }
        case Role::Plain:
            return;
    }
}

void rename_tree(Kind kind, Json& element, Pass& pass, std::vector<RefEdit>* edits) {
    if (!element.is_object()) return;
    walk_refs(kind, element,
              [&](uint64_t owner, const std::string& key, Role role, Json& value) {
                  const int before = pass.out->hits;
                  rename_site(pass, owner, role, value);
                  if (pass.out->hits != before && edits)
                      edits->push_back(RefEdit{owner, key, value});
              });
    auto children = element.find("children");
    if (children == element.end() || !children->is_array()) return;
    for (Json& child : *children) rename_tree(Kind::Node, child, pass, edits);
}

} // namespace

bool expr_uses(const std::string& expr, const std::string& name) {
    bool found = false;
    scan_idents(expr, [&](size_t start, size_t len) {
        if (!found && expr.compare(start, len, name) == 0 && len == name.size()) found = true;
    });
    return found;
}

bool rename_pass(Kind kind, Json& element, const RenamePlan& plan,
                 std::vector<RefEdit>* edits, RenameOutcome& outcome, std::string& err) {
    Pass pass;
    pass.plan = &plan;
    pass.out = &outcome;
    pass.err = &err;
    rename_tree(kind, element, pass, edits);
    return !pass.refused;
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

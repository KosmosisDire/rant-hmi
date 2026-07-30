#include "refs.h"

#include <functional>

namespace hmi {
namespace {

bool ident_start(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; }
bool ident_char(char c) { return ident_start(c) || (c >= '0' && c <= '9'); }

/* Call fn(start, len) for every bare identifier: skips string literals, skips a name
 * after '.' (a field or method), and skips a name followed by '(' (a builtin). */
void scan_idents(const std::string& s, const std::function<void(size_t, size_t)>& fn) {
    size_t i = 0;
    while (i < s.size()) {
        const char c = s[i];
        if (c == '"' || c == '\'') {
            const char quote = c;
            ++i;
            while (i < s.size() && s[i] != quote) i += (s[i] == '\\' ? 2 : 1);
            ++i;
            continue;
        }
        if (!ident_start(c)) { ++i; continue; }
        const size_t start = i;
        while (i < s.size() && ident_char(s[i])) ++i;
        size_t after = i;
        while (after < s.size() && (s[after] == ' ' || s[after] == '\t')) ++after;
        const bool is_call = after < s.size() && s[after] == '(';
        const bool is_member = start > 0 && s[start - 1] == '.';
        if (!is_call && !is_member) fn(start, i - start);
    }
}

/* (owner node id, prop key, role, the value to inspect or rewrite) */
using Site = std::function<void(uint64_t, const std::string&, Role, Json&)>;

/* Visit every reference-carrying prop value in the subtree, tagged with its role. */
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
    for (const ChildList& l : spec.lists) {
        auto it = node.find(l.key);
        if (it == node.end() || !it->is_array()) continue;
        for (Json& child : *it) walk_refs(l.child, child, visit);
    }
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
        /* a feed's case arms: the expression and any predicate are ordinary Expr sites */
        case Role::Cases: {
            if (!value.is_array()) return;
            for (Json& entry : value) {
                if (!entry.is_object()) continue;
                if (auto xf = entry.find("xf"); xf != entry.end())
                    visit_site(Role::Expr, *xf, from, to, hits);
                if (auto test = entry.find("test"); test != entry.end())
                    visit_site(Role::Expr, *test, from, to, hits);
            }
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

int rename_refs(Kind kind, Json& node, const std::string& from, const std::string& to,
                std::vector<RefEdit>* edits) {
    int hits = 0;
    walk_refs(kind, node, [&](uint64_t owner, const std::string& key, Role role, Json& value) {
        const int before = hits;
        visit_site(role, value, from, to, hits);
        if (hits != before && edits) edits->push_back(RefEdit{owner, key, value});
    });
    return hits;
}

int count_refs(Kind kind, Json& node, const std::string& name) {
    int hits = 0;
    walk_refs(kind, node, [&](uint64_t, const std::string&, Role role, Json& value) {
        visit_site(role, value, name, "", hits);
    });
    return hits;
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

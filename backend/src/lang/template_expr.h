/* The template-expression compiler: the same surface grammar as the scalar language
 * (spec 6.2), lowered to VIEW PROGRAMS — the Json {"code":[{"op":...}...]} form the
 * frontend's stack interpreter (frontend/src/program.ts) executes over symbolic cells.
 * This is how a component's template attrs are authored as text ("value.pick(fill_color,
 * track_color)") and served compiled, with the view still never parsing anything.
 *
 * The vocabulary is exactly what that interpreter can run: scalar literals, property /
 * tile / state / theme loads, arithmetic, comparisons, and/or/not, pick, toFixed, and
 * the numeric builtins with a view opcode. Everything else in the scalar language
 * (colors-as-math, text methods, aggregates, timing) has no view encoding and is
 * refused at compile time with an error that says so. Shape discipline is deliberately
 * light: this is display-tier styling code, and the view's Nil-poisoning renders a
 * wrong shape as UNKNOWN rather than a wrong pixel. */
#pragma once

#include "doc/schema.h"

#include <memory>
#include <set>
#include <string>
#include <vector>

namespace hmi {

/* What identifiers mean inside ONE PART's attrs.
 *
 * A BARE name is a property this part declares, or inherits from an enclosing one, and
 * it resolves to that property's ADDRESS — the declaring part's path plus the name
 * (spec 2.3). So `fill_color` inside the `bar` part loads the cell `slot:bar.fill_color`,
 * and the same word under a different part means a different cell. A component's own
 * properties declare at the top, where the path is empty and the address is the name.
 *
 * A DOTTED name is an ADDRESS, read from the template root: `arc.thickness` is the
 * thickness the arc owns, wherever it is read from. This is what lets a property live
 * on the part it AFFECTS rather than on the lowest part that happens to enclose every
 * reader — a knob's face sizes itself from `arc.thickness` and the arc still owns it.
 *
 * The lexical chain is FLATTENED as the compiler descends (one map per part, nearest
 * declaration already resolved); `addresses` is the whole component's table, which is
 * why attrs compile in a second pass, after every part's properties are known. */
struct TemplateScope {
    /* property name -> its slot address, in declaration order per part */
    std::vector<std::pair<std::string, std::string>> props;
    /* every property address in the component, for dotted reads */
    std::shared_ptr<const std::set<std::string>> addresses;

    bool addressed(const std::string& address) const {
        return addresses && addresses->count(address) != 0;
    }

    const std::string* find(const std::string& name) const {
        for (const auto& p : props)
            if (p.first == name) return &p.second;
        return nullptr;
    }

    bool has_prop(const std::string& name) const { return find(name) != nullptr; }

    /* the cell a bare name loads; the name itself when nothing declares it (the parser
     * refuses that case before asking) */
    const std::string& address(const std::string& name) const {
        const std::string* found = find(name);
        return found ? *found : name;
    }

    /* the enclosing scope plus one part's own declarations: a name declared here
     * REPLACES the inherited one in place, keeping the outer position */
    TemplateScope extend(const std::string& path,
                         const std::vector<std::string>& own) const {
        TemplateScope out = *this;
        for (const std::string& name : own) {
            const std::string address = path.empty() ? name : path + "." + name;
            bool replaced = false;
            for (auto& p : out.props) {
                if (p.first != name) continue;
                p.second = address;
                replaced = true;
                break;
            }
            if (!replaced) out.props.push_back({name, address});
        }
        return out;
    }
};

struct TemplateExprResult {
    bool ok = false;
    Json program;        /* {"code": [...]} on success */
    std::string error;   /* what refused to compile, with a column */
};

TemplateExprResult compile_template_expr(const std::string& text,
                                         const TemplateScope& scope);

} // namespace hmi

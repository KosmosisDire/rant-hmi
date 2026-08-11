/* The template-expression compiler: the same surface grammar as the scalar language
 * (spec 6.2), lowered to VIEW PROGRAMS — the Json {"code":[{"op":...}...]} form the
 * frontend's stack interpreter (frontend/src/program.ts) executes over symbolic cells.
 * This is how a component's template attrs are authored as text ("value.pick(fill_color,
 * track_color)") and served compiled, with the view still never parsing anything.
 *
 * The vocabulary is exactly what that interpreter can run: scalar and list literals,
 * property / state / theme loads, arithmetic, comparisons, and/or/not, pick, toFixed,
 * the numeric builtins with a view opcode, and the list vocabulary — indexing, length /
 * indexOf / sum / avg / max / min, anchor(), and the iterating methods (map / filter /
 * any / all / sortBy / reduce) whose lambda bodies ride inside the ITERATE instruction.
 * Everything else in the scalar language (text methods, timing) has no view encoding
 * and is refused at compile time with an error that says so. Shape discipline is
 * deliberately light: this is display-tier styling code, and the view's Nil-poisoning
 * renders a wrong shape as UNKNOWN rather than a wrong pixel. */
#pragma once

#include <nlohmann/json.hpp>

#include <memory>
#include <set>
#include <string>
#include <vector>

namespace hmi {

/* The alias doc/schema.h also declares, repeated rather than included: this is the one
 * language header that names a JSON value (a view program is served as one), and
 * including the document's node schema to get it would put the whole document model
 * above lang/ back inside it. Identical aliases may coexist. */
using Json = nlohmann::json;

/* What identifiers mean inside ONE ELEMENT's attrs.
 *
 * A BARE name is a property this element declares, or inherits from an enclosing one,
 * and it resolves to that property's ADDRESS — the declaring element's path plus the
 * name (spec 2.3). So `fill_color` inside the `bar` element loads the cell
 * `slot:bar.fill_color`, and the same word under a different element means a different
 * cell. A component's own properties declare at the top, where the path is empty and the
 * address is the name.
 *
 * A DOTTED name is an ADDRESS, read from the template root: `arc.thickness` is the
 * thickness the arc owns, wherever it is read from. This is what lets a property live
 * on the element it AFFECTS rather than on the lowest one that happens to enclose every
 * reader — a knob's face sizes itself from `arc.thickness` and the arc still owns it.
 *
 * The lexical chain is FLATTENED as the compiler descends (one map per element, nearest
 * declaration already resolved); `addresses` is the whole component's table, which is
 * why attrs compile in a second pass, after every element's properties are known. */
struct TemplateScope {
    /* property name -> its slot address, in declaration order per element */
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

    /* the enclosing scope plus one element's own declarations: a name declared here
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

/* is `name` an easing profile smooth() (and a property's `profile` field) accepts?
 * One vocabulary — the CSS names — shared by the parser and the property validation. */
bool easing_profile(const std::string& name);

} // namespace hmi

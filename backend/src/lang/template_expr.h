/* The view emitter: the one surface grammar (spec 6.2), parsed by THE parser
 * (lang/parser.h) and lowered from its AST to VIEW PROGRAMS — the Json
 * {"code":[{"op":...}...]} form the frontend's stack interpreter
 * (frontend/src/program.ts) executes over symbolic cells. This is how a component's
 * template attrs are authored as text ("value.pick(fill_color, track_color)") and
 * served compiled, with the view still never parsing anything.
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

#include <map>
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

/* ---- THE PAGE UNIVERSE: what an element on a PAGE may name beyond its properties ----
 *
 * Both halves below are EMPTY inside a component, and that emptiness is the isolation
 * rule itself: a component sees its own properties and nothing of the page it sits on,
 * so that it works wherever it is placed. On a page they are filled, and a display-tier
 * expression names exactly what a wire-tier one does. */

/* One variable a bare name may mean. The cell is `v<id>` — the variable's DOCUMENT id,
 * which is what the runtime already publishes under, so nothing of the program compile
 * has to be threaded into the attr compiler to know the key. */
struct TemplateVar {
    std::string name;
    uint64_t id = 0;
    /* the declared type, verbatim ("num" "bool" "text" "color" "icon" "list" "map"
     * "timer", or a TypeRef). Carried so a type with NO display-tier reading is refused
     * by name rather than compiled into a cell that reads Nil forever. */
    std::string type;
};

/* one readable mesh field, by its '@' spelling */
struct TemplateMeshField {
    std::string cell;     /* "mesh:<entity>[.<path>]", the cell the view loads */
    std::string entity;
    std::string path;
};

/* THE CELL ONE MESH FIELD RIDES IN. One spelling, shared by the compiler that emits the
 * load and the live frame that fills it — two concatenations in two files agreeing by
 * luck is exactly how a picture comes to read UNKNOWN with nothing to explain it. A
 * field with no path (a bare-scalar entity) is the entity's own name. */
inline std::string mesh_cell(const std::string& entity, const std::string& path) {
    return path.empty() ? "mesh:" + entity : "mesh:" + entity + "." + path;
}

struct TemplateMesh {
    /* "@name" — a single-field entity reads whole — and "@name.path" alike, both
     * landing on the SAME cell so one key serves either spelling */
    std::map<std::string, TemplateMeshField> fields;
    /* entities with more than one readable field: a bare `@name` there is a whole
     * message, refused with "pick a field" rather than "unknown entity" */
    std::set<std::string> fielded;
    /* WHERE THE READS ARE RECORDED, gathered across every attr in the document as
     * "<entity>\n<path>". The document compiler stamps these entities so the mesh
     * consumes them and live() publishes their mirrors — an attr read nobody consumed
     * would draw UNKNOWN forever. Null where nothing is collecting. */
    std::set<std::string>* reads = nullptr;
};

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
    /* the variables in lexical scope here, OUTERMOST FIRST — the globals, then each
     * enclosing element's locals, then this element's own. Nearest wins, so the lookup
     * runs backwards. Empty inside a component. */
    std::vector<TemplateVar> vars;
    /* the mesh, shared by every scope of one compile. Null inside a component. */
    std::shared_ptr<const TemplateMesh> mesh;
    /* appended to every unknown-name refusal: what this surface's emptiness MEANS (the
     * scalar tier's Env carries the same field, with the same text) */
    std::string unknown_help;

    bool addressed(const std::string& address) const {
        return addresses && addresses->count(address) != 0;
    }

    const std::string* find(const std::string& name) const {
        for (const auto& p : props)
            if (p.first == name) return &p.second;
        return nullptr;
    }

    bool has_prop(const std::string& name) const { return find(name) != nullptr; }

    /* the variable a bare name means — nearest declaration wins, so the search runs
     * from the inside out over a list built from the outside in */
    const TemplateVar* variable(const std::string& name) const {
        for (size_t i = vars.size(); i-- > 0;)
            if (vars[i].name == name) return &vars[i];
        return nullptr;
    }

    const TemplateMeshField* mesh_field(const std::string& spelling) const {
        if (!mesh) return nullptr;
        auto found = mesh->fields.find(spelling);
        return found == mesh->fields.end() ? nullptr : &found->second;
    }

    bool mesh_fielded(const std::string& spelling) const {
        return mesh && mesh->fielded.count(spelling) != 0;
    }

    /* one compiled read, recorded for the mesh to consume and the wire to carry */
    void read_mesh(const TemplateMeshField& field) const {
        if (mesh && mesh->reads) mesh->reads->insert(field.entity + "\n" + field.path);
    }

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

/* THE PLACEMENT RULE (spec: the author never chooses where an expression runs).
 *
 * A slot expression naming `state` or `repeat` cannot be a standing backend program: the
 * backend keeps ONE cell where the view draws N copies, and a press belongs to one copy.
 * So it is compiled as a VIEW program and served with the instance's own node row, and
 * every other slot expression stays a standing program with a published cell that a flow
 * can read. Which it is falls out of the text, and this is the ONE place that question is
 * answered — the display compiler builds the view program from it and the wire compiler
 * skips the standing one, and a disagreement would leave a slot with two truths or none.
 *
 * Read with the real lexer, so a "repeat" inside a string literal and an `x.repeat` field
 * access are not it — the same words the parser would refuse to treat as the view input. */
bool per_copy_expression(const std::string& text);

} // namespace hmi

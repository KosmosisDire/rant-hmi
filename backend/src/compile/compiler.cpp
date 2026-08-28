#include "compiler.h"

/* for authored_slot(): one instance-slot address walked one way by both compilers */
#include "compile/components.h"
#include "doc/decode.h"
#include "lang/expression.h"
#include "lang/parser.h"
#include "lang/template_expr.h"
#include "registry/objects.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <set>
#include <unordered_map>

namespace hmi {
namespace {

bool entity_kind(const std::string& text, EntityKind& out) {
    if (text == "V") out = EntityKind::Variable;
    else if (text == "T") out = EntityKind::Topic;
    else if (text == "F") out = EntityKind::Function;
    else if (text == "K") out = EntityKind::Task;
    else return false;
    return true;
}

/* THE VERB IS DERIVED (spec 2.1): the destination's kind decides the mechanic, and the
 * author's only choice is the mode on a variable. There is nothing to validate here
 * because there is nothing to disagree with. */
Verb verb_for(EntityKind kind, const std::string& mode) {
    switch (kind) {
        case EntityKind::Variable:
            if (mode == "force") return Verb::Force;
            if (mode == "unforce") return Verb::Unforce;
            return Verb::Write;
        case EntityKind::Topic: return Verb::Publish;
        case EntityKind::Function: return Verb::Call;
        case EntityKind::Task:
            return mode == "cancel" ? Verb::Cancel : Verb::Call;
    }
    return Verb::Write;
}

/* An authored literal as a runtime value. `ok` is false when the JSON cannot BE that shape,
 * which is a mistake worth a diagnostic: the result would otherwise be Nil, and Nil is also
 * the legitimate "no value yet", so the two are indistinguishable on screen and the mistake
 * is invisible. A null is not a mistake: it is a deliberate UNKNOWN. */
Value json_value(Program& program, Shape shape, const Json& value, bool& ok) {
    ok = true;
    if (value.is_null()) return Value::nil();
    ok = false;
    switch (shape) {
        case Shape::Num:
            if (!value.is_number()) return Value::nil();
            ok = true;
            return Value::number(value.get<double>());
        case Shape::Bool:
            if (!value.is_boolean()) return Value::nil();
            ok = true;
            return Value::boolean(value.get<bool>());
        case Shape::Text:
            if (!value.is_string()) return Value::nil();
            ok = true;
            return Value::text(program.add_text(value.get<std::string>()));
        case Shape::Color: {
            if (!value.is_string()) return Value::nil();
            const uint32_t color = parse_color(value.get<std::string>(), ok);
            return ok ? Value::color(color) : Value::nil();
        }
        case Shape::Enum:
            if (!value.is_number_integer()) return Value::nil();
            ok = true;
            return Value::enumeration(value.get<int64_t>(), 0);
        default:
            /* a shape with no literal form (list, map, struct): an authored value cannot
               be checked here, so it is not called a mistake */
            ok = true;
            return Value::nil();
    }
}

/* what a JSON literal looks like in a message, for a diagnostic that names the mistake */
std::string json_brief(const Json& value) {
    const std::string text = value.dump();
    return text.size() > 32 ? text.substr(0, 29) + "..." : text;
}

/* the trimmed text when it is exactly one bare identifier (a local's name and nothing
 * else), "" otherwise: the degenerate expression the whole-struct paths recognize */
std::string bare_name(const std::string& text);

std::string trimmed(const std::string& text) {
    size_t from = 0, to = text.size();
    while (from < to && std::isspace(static_cast<unsigned char>(text[from]))) ++from;
    while (to > from && std::isspace(static_cast<unsigned char>(text[to - 1]))) --to;
    return text.substr(from, to - from);
}

std::string bare_name(const std::string& text) {
    const std::string t = trimmed(text);
    if (t.empty()) return {};
    if (!std::isalpha(static_cast<unsigned char>(t[0])) && t[0] != '_') return {};
    for (const char c : t)
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_') return {};
    return t;
}

/* the locals a flow has declared so far, by name. `x` is not in here: it is the flow's
 * first local by the spec's reckoning (2.6) but the VM keeps it in a register, so a move
 * naming it lowers to StoreX and nothing else changes. */
using FlowLocals = std::unordered_map<std::string, uint32_t>;

/* one armed element of a component's template: where a gesture rides, compiled once so
 * trigger validation and the dispatch topology read the same facts */
struct ArmedInfo {
    std::string element;     /* dotted node names under the root; "" = the root itself */
    std::string primitive;
    bool bubbles = true;
};

/* what a refusal inside a component adds, so the narrow scope reads as a design and not
 * as a missing name. Appended to every unknown-name refusal there. */
constexpr const char* kIsolatedHelp =
    " — a component sees its own properties and nothing of the page it sits on, so that "
    "it works wherever it is placed. Declare a property here and let each instance's own "
    "value bring the variable or the mesh field in";

/* ONE RECORD PER ELEMENT ON A PAGE — every node in the tree, not only the ones naming a
 * component. What an element declares (locals, timers, flows) it declares wherever it
 * sits, and `parent` is what makes that a SCOPE: names resolve up the chain to the page
 * and then to the globals, nearest declaration winning. `type` and `slots` are filled
 * only where the element places a component. */
struct ElementInfo {
    uint64_t id = 0;
    uint64_t page = 0;
    const NodeDecl* node = nullptr;
    const ComponentSpec* type = nullptr;
    /* index into elements_ of the enclosing element, UINT32_MAX at the page */
    uint32_t parent = UINT32_MAX;
    std::unordered_map<std::string, uint32_t> locals;
    std::unordered_map<std::string, uint32_t> slots;
    std::unordered_map<std::string, uint32_t> timers;
    std::vector<ArmedInfo> armed;
};

/* ---- the GESTURE VOCABULARY, closed on both sides (mirrors frontend types.ts) ----
 *
 * A gesture event is never DECLARED: picking a primitive for an element IS the declaration,
 * and the whole family arrives with fixed signatures. tap/press/release/held/open are
 * MOMENTS and carry nothing — which event fired is the information; pressrelease alone
 * carries the edge, the drags carry the value in motion, the picks carry the option. */
struct EventParam {
    std::string name;
    Shape shape = Shape::Unknown;
};

bool gesture_event(const std::string& name) {
    return name == "tap" || name == "press" || name == "release" || name == "held" ||
           name == "pressrelease" || name == "input" || name == "commit" ||
           name == "select" || name == "open";
}

/* the fixed signature; false = nullary */
bool gesture_param(const std::string& name, EventParam& out) {
    if (name == "pressrelease") { out = {"down", Shape::Bool}; return true; }
    if (name == "input" || name == "commit") { out = {"value", Shape::Num}; return true; }
    if (name == "select") { out = {"option", Shape::Text}; return true; }
    return false;
}

/* which primitives raise it (the availability check reads the armed elements) */
bool gesture_from(const std::string& event, const std::string& primitive) {
    if (event == "tap" || event == "press" || event == "release" || event == "held" ||
        event == "pressrelease")
        return primitive == "press";
    if (event == "input" || event == "commit")
        return primitive == "drag1d" || primitive == "drag_radial";
    if (event == "select") return primitive == "drag_radial" || primitive == "pick";
    if (event == "open") return primitive == "pick";
    return false;
}

class Compiler {
  public:
    Compiler(const Document& document, const MeshPort& mesh)
        : doc_(decode_document(document)), specs_(derive_specs(doc_.components)),
          mesh_(mesh) {
        program_.document_version = doc_.version;
        program_.add_text("");
        /* The theme tokens (spec 2.10), name -> DARK value: the backend has no view and
         * therefore no theme mode, so dark is the canonical runtime resolution; light is
         * a per-view rendering the frontend applies. */
        for (const TokenDecl& token : doc_.tokens)
            if (!token.name.empty()) tokens_[token.name] = token.dark;
    }

    CompileResult run() {
        copy_entities();
        build_cells();
        build_armed_elements();
        build_slot_programs();
        /* The type's defaults are compiled FIRST, so they run first: by the time an
         * authored flow on the same event runs, the instance's own state already reflects
         * the gesture and `this.<slot>` agrees with what the event passed. */
        build_type_behavior();
        build_flows();
        /* every flow's signature, off its finished body (a failed flow's Fault stub
           reads nothing, exactly as its steps stamped nothing before) — what the mesh
           queries for subscriptions and accessors instead of stamped entity flags */
        for (FlowProgram& flow : program_.flows)
            flow.body.sig = program_.infer_signature(flow.body.code);
        /* PARK PINNING: each park may copy x and the event parameter into the
           frame arena so nothing can move a held value while the run sleeps (a
           temporary's fields are frame-owned already); every pending site may
           park once per run */
        program_.frame.elem_texts += program_.layout.pending_slots * 2;
        program_.frame.stack = std::max<uint32_t>(program_.frame.stack, 1);
        program_.layout.effect_capacity = std::max<uint32_t>(program_.layout.effect_capacity, 1);
        /* THE VERIFIER (rule 14): every jump in every finished body lands strictly
           FORWARD. The emitters only produce forward jumps, so a hit is an internal
           error — the document refuses rather than trusting a malformed body to
           the runtime's step budget. */
        verify_jumps();
        CompileResult out;
        out.ok = !has_errors_;
        out.program = std::move(program_);
        return out;
    }

    void verify_jumps() {
        auto check_body = [&](const std::vector<Instruction>& code, const char* what) {
            const int at = Module::bad_jump(code);
            if (at < 0) return;
            diag(0, "verifier",
                 std::string("internal: ") + what + " jumps backward at instruction " +
                     std::to_string(at) + "; the document is refused");
        };
        for (const FlowProgram& flow : program_.flows)
            check_body(flow.body.code, "a flow body");
        for (const SlotProgram& slot : program_.slot_programs)
            check_body(slot.body.code, "a slot expression");
        for (const Procedure& sub : program_.subs)
            check_body(sub.code, "a lambda body");
    }

    /* THE STANDALONE DEFINITION CHECK: a component's behavior is checked off the
     * DEFINITION, so its author hears about a broken flow before any instance
     * exists. Components the document places somewhere are skipped — their
     * per-instance compile already reports on these same definition ids, and one
     * finding must not double. This runs INSTEAD of run(), on a scratch Compiler:
     * the cells, sites and groups allocated here never serve, and only the
     * findings travel. Inner elements' flows are not checked because nothing runs
     * them — the behavior list is a component's one wire surface. */
    std::vector<Diag> check_definitions(std::vector<RefRow>* refs = nullptr,
                                        std::vector<RefSite>* gaps = nullptr) {
        copy_entities();
        /* the schema copy above may re-report what the real compile already said;
           only what the DEFINITIONS say is this pass's product */
        const size_t said = program_.diagnostics.size();
        const std::set<std::string> placed = placed_types();
        for (const ComponentDecl& component : doc_.components) {
            if (component.name.empty() || placed.count(component.name)) continue;
            if (component.behavior_decls.empty()) continue;
            const ComponentSpec* spec = type_named(component.name);
            if (!spec) continue;
            ElementInfo info;
            info.id = component.root.id;
            info.node = &component.root;
            info.type = spec;
            /* the slots exist so `this.<slot>` reads with its declared shape —
               scratch cells, exactly what bind_own_props reads off an instance */
            for (const SlotSpec& slot : spec->slots) {
                const Shape shape = var_shape(slot.shape);
                const uint32_t cell = add_cell(CellKind::Slot, info.id, info.id,
                                               slot.name, shape, Json(), false);
                program_.cells[cell].decl = slot.id;
                if (shape == Shape::List || shape == Shape::Map) {
                    program_.cells[cell].elem = var_shape(slot.elem);
                    program_.cells[cell].leaf = var_shape(slot.leaf);
                }
                info.slots[slot.name] = cell;
            }
            const uint32_t index = static_cast<uint32_t>(elements_.size());
            elements_.push_back(std::move(info));
            ElementInfo& element = elements_[index];
            /* armed the way an instance is, so a behavior trigger validates the
               same way it would validate placed */
            collect_armed(spec->tmpl, "", element);
            for (const FlowDecl& node : component.behavior_decls) {
                bool stepped = false;   /* any trigger reached compile_steps */
                for (const TriggerDecl& trigger : node.when) {
                    FlowProgram flow;
                    flow.node_id = element.id;
                    flow.flow_id = element.id;
                    flow.group = program_.layout.fired_groups++;
                    EventParam param;
                    bool has_param = false;
                    std::string copyless;
                    if (trigger.kind == "every") {
                        if (!cadence_trigger(element, trigger, element.id, flow))
                            continue;
                        copyless = "an `every` trigger";
                    } else {
                        flow.event = trigger.name;
                        flow.element = trigger.element;
                        if (!event_signature(element, flow.event, flow.element,
                                             element.id, /*in_behavior=*/true, param,
                                             has_param))
                            continue;
                    }
                    stepped = true;
                    compile_steps(element, node, flow, has_param ? &param : nullptr,
                                  nullptr, /*in_component=*/true, copyless);
                }
                if (!stepped)
                    for (const StepDecl& step : node.steps)
                        program_.reference_gaps.push_back(RefSite{step.id, ""});
            }
        }
        program_.diagnostics.erase(program_.diagnostics.begin(),
                                   program_.diagnostics.begin() + said);
        /* the scratch program never serves; its index rows travel out the same way
           its findings do — an unplaced component's references live nowhere else */
        if (refs)
            for (RefRow& row : program_.references) refs->push_back(std::move(row));
        if (gaps)
            for (RefSite& gap : program_.reference_gaps) gaps->push_back(std::move(gap));
        return std::move(program_.diagnostics);
    }

  private:
    /* an authored slot EXPRESSION, held from build_cells (where the cell is made) to
     * build_slot_programs (when every cell the expression could read exists) */
    struct PendingSlot {
        uint64_t node_id = 0;
        std::string name;
        std::string text;
        uint32_t cell = 0;
        /* the registry slot row (stable in specs_): variants for the constrained-text
           check */
        const SlotSpec* spec = nullptr;
    };

    void diag(uint64_t node, const std::string& code, const std::string& message,
              DiagGrade grade = DiagGrade::Error, const std::string& where = "") {
        program_.diagnostics.push_back(Diag{node, grade, code, message, where});
        if (grade == DiagGrade::Error) has_errors_ = true;
    }

    /* an expression finding: the same row plus its SPAN in the field's source */
    void diag_span(uint64_t node, const std::string& code, const std::string& message,
                   DiagGrade grade, const std::string& where, size_t at,
                   size_t length) {
        program_.diagnostics.push_back(Diag{node, grade, code, message, where, at,
                                            length});
        if (grade == DiagGrade::Error) has_errors_ = true;
    }

    uint32_t fault_site(uint64_t node, const std::string& code, const std::string& message) {
        program_.runtime_faults.push_back(Diag{node, DiagGrade::Error, code, message});
        return static_cast<uint32_t>(program_.runtime_faults.size() - 1);
    }

    /* ONE STRUCTURAL REFERENCE for the index: a variable name a step or trigger
     * carries as DATA rather than inside expression text (a move's `local`, a timer's
     * name). The row's text is the word itself, spanned whole. `decl` 0 (a temp, the
     * pipeline register) still records: the verify reads binding stability off it. */
    void reference(uint64_t node, const std::string& word, uint64_t decl) {
        program_.references.push_back(RefRow{node, word, 0, word.size(), decl});
    }

    const ComponentSpec* type_named(const std::string& name) const {
        for (const ComponentSpec& spec : specs_)
            if (spec.name == name) return &spec;
        return nullptr;
    }

    /* THE TYPE TABLE (spec 2.2). Entry 0 is the untyped placeholder. A struct type is
     * keyed by its schema hash where the mesh gives one and by its field signature
     * otherwise, so two entities carrying the same schema are ONE type and `ValveCmd`
     * exists once however many valves there are. An enum type is keyed by its variant
     * list, which is what makes equality between values from different entities with the
     * same vocabulary hold. */
    uint16_t intern_enum(const std::vector<std::pair<std::string, int64_t>>& variants) {
        for (uint32_t i = 1; i < program_.types.size(); ++i)
            if (program_.types[i].kind == TypeKind::Enum && program_.types[i].variants == variants)
                return static_cast<uint16_t>(i);
        TypeDef def;
        def.kind = TypeKind::Enum;
        def.variants = variants;
        program_.types.push_back(std::move(def));
        return static_cast<uint16_t>(program_.types.size() - 1);
    }

    static std::string field_signature(const std::vector<FieldDef>& fields) {
        std::string out;
        for (const FieldDef& field : fields)
            out += field.path + ":" + shape_name(field.shape) + ";";
        return out;
    }

    uint16_t intern_struct(const EntityDef& entity, uint32_t entity_index) {
        const std::string key = entity.schema_hash
                                    ? "#" + std::to_string(entity.schema_hash)
                                    : "@" + field_signature(entity.fields);
        auto found = struct_keys_.find(key);
        if (found != struct_keys_.end()) return found->second;
        TypeDef def;
        def.kind = TypeKind::Struct;
        /* a schema with no root name is not pickable by name; it stays addressable
         * through its entity, which is what the entity index is for */
        def.name = entity.type_name;
        def.fields = entity.fields;
        def.entity = entity_index;
        program_.types.push_back(std::move(def));
        const uint16_t id = static_cast<uint16_t>(program_.types.size() - 1);
        struct_keys_[key] = id;
        /* a root name carried by two different schemas is AMBIGUOUS: reported once, and
         * left pickable only through an entity */
        if (!entity.type_name.empty()) {
            auto named = struct_names_.find(entity.type_name);
            if (named == struct_names_.end()) struct_names_[entity.type_name] = id;
            else if (named->second != id && ambiguous_.insert(entity.type_name).second)
                diag(0, "type_ambiguous",
                     "two different schemas are both called '" + entity.type_name +
                         "'; pick this type through an entity",
                     DiagGrade::Warning);
        }
        return id;
    }

    void copy_entities() {
        program_.entities = mesh_.reflection();
        program_.types.assign(1, TypeDef{});
        auto assign_enum = [&](FieldDef& field) {
            if (field.variants.empty()) return;
            field.type_id = intern_enum(field.variants);
        };
        /* the frame arena's SLACK, sized as the largest single entity's aggregate
         * payload: deliveries decode in the mesh's own scratch now, but the arena
         * still leans on this headroom for what no site charges itself — a store
         * verb staging a self-sourced row through the pool (settled_row), and
         * sortBy's second key block beside the one run its site reserved */
        uint32_t intake_values = 0, intake_texts = 0;
        auto measure = [&](const std::vector<FieldDef>& fields) {
            uint32_t values = 0, texts = 0;
            for (const FieldDef& field : fields) {
                if (field.shape != Shape::List && field.shape != Shape::Map) continue;
                const uint32_t bound = field.bound ? field.bound : kVarrCeiling;
                if (field.shape == Shape::Map) {
                    values += bound * 2;
                    texts += bound * 2;   /* keys, plus text values worst case */
                } else {
                    values += bound;
                    if (field.elem == Shape::Text) texts += bound;
                }
            }
            intake_values = std::max(intake_values, values);
            intake_texts = std::max(intake_texts, texts);
        };
        for (uint32_t e = 0; e < program_.entities.size(); ++e) {
            EntityDef& entity = program_.entities[e];
            for (FieldDef& field : entity.fields) assign_enum(field);
            for (FieldDef& field : entity.rsp_fields) assign_enum(field);
            measure(entity.fields);
            measure(entity.rsp_fields);
            program_.layout.max_entity_fields =
                std::max<uint32_t>(program_.layout.max_entity_fields,
                                   static_cast<uint32_t>(entity.fields.size()));
            /* a BARE-schema entity (`bool`, `f64`, `string`: one anonymous field) IS
               its scalar — no struct type, so a whole-entity move meets the variable
               as the same primitive rather than a one-field struct */
            const bool bare_scalar =
                entity.fields.size() == 1 && entity.fields[0].path.empty() &&
                entity.fields[0].shape != Shape::List &&
                entity.fields[0].shape != Shape::Map;
            if (!entity.fields.empty() && !bare_scalar)
                entity.type_id = intern_struct(entity, e);
        }
        program_.frame.elems += intake_values;
        program_.frame.elem_texts += intake_texts;
    }

    uint32_t add_cell(CellKind kind, uint64_t owner_node, uint64_t node_id,
                      const std::string& name, Shape shape, const Json& initial,
                      bool persistent) {
        CellDef cell;
        cell.kind = kind;
        cell.owner_node = owner_node;
        cell.name = name;
        cell.node_id = node_id;
        /* a slot cell's node_id is the PLACEMENT; its declaration is the component's
           variable, and the slot loop overrides `decl` with that var's id after this */
        cell.decl = node_id;
        cell.shape = shape;
        bool ok = true;
        cell.initial = json_value(program_, shape, initial, ok);
        if (!ok)
            diag(node_id, "value_shape",
                 std::string(kind == CellKind::Slot ? "slot '" : "variable '") + name +
                     "' is " + shape_name(shape) + ", but its value is " + json_brief(initial) +
                     ": it starts UNKNOWN",
                 DiagGrade::Error, kind == CellKind::Slot ? name : "init");
        cell.persistent = persistent;
        if (shape == Shape::Text) {
            cell.text_slot = program_.layout.cell_texts++;
            cell.text_cap = 256;
        }
        /* an aggregate cell owns retained storage: the run's element pool resets every
           run, so a cell that holds a list or a map needs a slot that does not */
        if (shape == Shape::List || shape == Shape::Map)
            cell.list_slot = program_.layout.list_slots++;
        program_.cells.push_back(std::move(cell));
        return static_cast<uint32_t>(program_.cells.size() - 1);
    }

    uint32_t add_timer(uint64_t owner_node, const VarDecl& var) {
        TimerDef timer;
        timer.owner_node = owner_node;
        timer.node_id = var.id;
        timer.name = var.name;
        timer.event = "timer:" + std::to_string(timer.node_id);
        const double seconds = var.init.is_number() ? var.init.get<double>() : 0.0;
        timer.duration_ticks =
            static_cast<uint32_t>(std::max(1.0, std::round(std::max(0.0, seconds) * 1000.0)));
        program_.timers.push_back(std::move(timer));
        return static_cast<uint32_t>(program_.timers.size() - 1);
    }

    /* One declared variable becomes its cell: a scalar or timer by the four base names,
     * anything else a TypeRef resolved against the type table (spec 2.7). A struct root
     * gives the cell a struct slot, born zeroed; an enum reached by path (`ValveCmd.mode`)
     * gives it the ENUM type, seeded at the first variant, so `.name`/`.int`/`.is` work
     * on it like on any enum value. An unresolved TypeRef is a finding on the variable,
     * never a silent Nil. */
    uint32_t declare_variable(const VarDecl& var, CellKind kind, uint64_t owner) {
        const Shape shape = var_shape(var.type);
        if (shape == Shape::List || shape == Shape::Map) {
            /* an aggregate's start has its own spellings and lands in the cell's
               constant run, not in the scalar initial, which stays Nil */
            const uint32_t cell = add_cell(kind, owner, var.id, var.name, shape, Json(),
                                           var.persist);
            program_.cells[cell].elem = declared_elem(var);
            program_.cells[cell].leaf = declared_leaf(var, program_.cells[cell].elem);
            aggregate_var_initial(var, shape, cell);
            return cell;
        }
        if (shape != Shape::Unknown) {
            Json init = var.init;
            /* a colour variable names a theme token the same way every other authored
               colour does — one spelling for "$accent", wherever a colour is written */
            if (shape == Shape::Color) init = resolve_token(var.id, "init", init);
            return add_cell(kind, owner, var.id, var.name, shape, init, var.persist);
        }
        const int type_id = find_type_ref(var.type);
        if (type_id < 0) {
            diag(var.id, "unresolved_type",
                 var.type.empty()
                     ? "variable '" + var.name + "' has no type"
                     : "variable '" + var.name + "' has type '" + var.type +
                           "', which is not a type in the mesh",
                 DiagGrade::Error, "type");
            return UINT32_MAX;
        }
        const Json& init = var.init;
        if (program_.types[type_id].kind == TypeKind::Enum) {
            const uint32_t cell = add_cell(kind, owner, var.id, var.name, Shape::Enum,
                                           Json(), var.persist);
            const auto& variants = program_.types[type_id].variants;
            program_.cells[cell].type_id = static_cast<uint16_t>(type_id);
            program_.cells[cell].initial = Value::enumeration(
                variants.empty() ? 0 : variants[0].second, static_cast<uint16_t>(type_id));
            /* the default is a variant NAME; a name outside the vocabulary is a
               finding, never a silent first-variant */
            if (init.is_string() && !init.get<std::string>().empty()) {
                const std::string wanted = init.get<std::string>();
                bool matched = false;
                for (const auto& row : variants)
                    if (row.first == wanted) {
                        program_.cells[cell].initial = Value::enumeration(
                            row.second, static_cast<uint16_t>(type_id));
                        matched = true;
                        break;
                    }
                if (!matched)
                    diag(var.id, "enum_name",
                         "'" + wanted + "' is not one of this enum's variants",
                         DiagGrade::Error, "init");
            }
            return cell;
        }
        const uint32_t cell = add_struct_cell(kind, owner, 0, var.id, var.name,
                                              static_cast<uint16_t>(type_id));
        add_field_cells(kind, owner, 0, var.name, cell);
        /* a struct variable's DEFAULTS: an object of field values over the type's
           zero, applied at start and by a reset */
        if (init.is_object()) {
            const std::vector<FieldDef>& fields =
                struct_fields(program_, static_cast<uint16_t>(type_id));
            for (auto it = init.begin(); it != init.end(); ++it) {
                int field = -1;
                for (uint32_t i = 0; i < fields.size(); ++i)
                    if (fields[i].path == it.key()) field = static_cast<int>(i);
                if (field < 0) {
                    diag(var.id, "unresolved_field",
                         "'" + var.type + "' has no field '" + it.key() + "'",
                         DiagGrade::Error, "init");
                    continue;
                }
                Value value = Value::nil();
                bool ok = true;
                if (fields[field].shape == Shape::Enum && it->is_string()) {
                    ok = false;
                    for (const auto& row : fields[field].variants)
                        if (row.first == it->get<std::string>()) {
                            value = Value::enumeration(row.second, fields[field].type_id);
                            ok = true;
                            break;
                        }
                } else {
                    value = json_value(program_, fields[field].shape, *it, ok);
                }
                if (!ok || value.tag == ValueTag::Nil) {
                    if (!it->is_null())
                        diag(var.id, "value_shape",
                             "field '" + it.key() + "' is " +
                                 shape_name(fields[field].shape) + ", but its default is " +
                                 json_brief(*it),
                             DiagGrade::Error, "init");
                    continue;
                }
                program_.cells[cell].struct_init.push_back(
                    {static_cast<uint32_t>(field), value});
            }
        }
        return cell;
    }

    void build_cells() {
        for (const VarDecl& var : doc_.globals) {
            const uint32_t cell = declare_variable(var, CellKind::Global, 0);
            if (cell == UINT32_MAX) continue;
            globals_[var.name] = cell;
            if (program_.cells[cell].shape == Shape::Timer)
                global_timers_[var.name] = add_timer(0, var);
        }

        for (const PageDecl& page : doc_.pages) {
            const uint64_t page_id = page.id;
            /* A page is one tree of elements nesting to any depth, and EVERY ONE of them
             * gets a record: what an element declares does not depend on whether it
             * happens to name a component. The walk is pre-order and pushes before it
             * descends, so `elements_` is in document order (which is the order the
             * scheduler runs flows in) and a child's `parent` index always exists.
             * `info.page` is always the PAGE's id, never an enclosing frame's: page
             * identity is what gates mesh polling, so an element three frames deep must
             * still resolve to its page. */
            std::function<void(const std::vector<NodeDecl>&, uint32_t)> walk_children =
                [&](const std::vector<NodeDecl>& children, uint32_t parent) {
                for (const NodeDecl& instance : children) {
                    const std::string& type_name = instance.type;

                    ElementInfo info;
                    info.id = instance.id;
                    info.page = page_id;
                    info.node = &instance;
                    info.parent = parent;
                    info.type = type_name.empty() ? nullptr : type_named(type_name);
                    if (!type_name.empty() && !info.type)
                        diag(info.id, "component_type",
                             "component '" + type_name + "' is not registered");

                    for (const VarDecl& var : instance.locals) {
                        const uint32_t cell = declare_variable(var, CellKind::Local, info.id);
                        if (cell == UINT32_MAX) continue;
                        info.locals[var.name] = cell;
                        if (program_.cells[cell].shape == Shape::Timer)
                            info.timers[var.name] = add_timer(info.id, var);
                    }

                    if (info.type) {
                        const Json& authored = instance.slots;
                        for (const SlotSpec& slot : info.type->slots) {
                            const std::string& name = slot.name;
                            const Shape shape = var_shape(slot.shape);
                            const bool aggregate =
                                shape == Shape::List || shape == Shape::Map;
                            /* PUBLIC IS WHAT A PLACEMENT MAY SET. A component's private
                               variable is its own business: it gets a cell here like any
                               other (the pictures inside read it), but a value authored
                               against it on the instance is not consulted — encapsulation
                               is a rule the compiler keeps, not one the inspector merely
                               declines to offer. */
                            const bool is_public = slot.is_public;
                            /* the declared DEFAULT is a raw literal (the component's own
                               spelling); only an AUTHORED value speaks the expression
                               encoding (spec D1) */
                            Json initial = slot.initial;
                            std::string expr_text;
                            /* the row's NAME is its address: an element's variable is
                               stored nested under it, so the lookup walks the dots */
                            const Json* override =
                                is_public ? authored_slot(authored, name) : nullptr;
                            if (override) {
                                if (override->is_string()) {
                                    const std::string text =
                                        trimmed(override->get<std::string>());
                                    if (text.empty()) {
                                        /* empty = unset: the default stands */
                                    } else if (shape == Shape::Color && text[0] == '$') {
                                        /* a whole-value token reference stays the
                                           authored literal spelling */
                                        initial = Json(text);
                                    } else if (shape == Shape::List && text[0] == '[') {
                                        initial = *override;
                                    } else if (shape == Shape::Map && text[0] == '{') {
                                        initial = *override;
                                    } else {
                                        /* AN EXPRESSION: compiled after every cell of
                                           this instance exists (build_slot_programs); a
                                           constant folds back into the start, anything
                                           live becomes a standing program and the cell
                                           starts UNKNOWN */
                                        expr_text = text;
                                        initial = Json();
                                    }
                                } else {
                                    initial = *override;
                                }
                            }
                            if (shape == Shape::Color)
                                initial = resolve_token(info.id, name, initial);
                            if (expr_text.empty()) check_variants(info.id, name, slot, initial);
                            /* an AGGREGATE slot's authored value has its own accepted
                               spellings and lands in the cell's constant run, not in
                               the scalar initial, which stays Nil */
                            /* A COMPONENT'S LIST DECLARES ITS ELEMENTS like any other
                               variable does; the served string was already checked where
                               it was declared, so a name that means nothing here simply
                               leaves the elements undeclared. Read BEFORE the start is
                               parsed, because a declared element type is what decides
                               how the authored spelling reads — a `color` list's members
                               are hex strings, not text. */
                            const Shape slot_elem =
                                aggregate ? var_shape(slot.elem) : Shape::Unknown;
                            std::vector<Value> list_init;
                            const bool has_list =
                                expr_text.empty() &&
                                (shape == Shape::List
                                     ? list_slot_initial(info.id, name, initial, list_init,
                                                         slot_elem)
                                     : shape == Shape::Map &&
                                           map_slot_initial(info.id, name, initial,
                                                            list_init, slot_elem));
                            info.slots[name] =
                                add_cell(CellKind::Slot, info.id, info.id, name, shape,
                                         aggregate || !expr_text.empty() ? Json() : initial,
                                         false);
                            /* the cell is keyed by the PLACEMENT; the declaration is
                               the component's variable, and that is what a reference
                               to this slot means */
                            program_.cells[info.slots[name]].decl = slot.id;
                            if (aggregate) {
                                CellDef& cell = program_.cells[info.slots[name]];
                                cell.elem = slot_elem;
                                cell.leaf = var_shape(slot.leaf);
                            }
                            if (has_list) {
                                program_.cells[info.slots[name]].has_list = true;
                                program_.cells[info.slots[name]].list_init =
                                    std::move(list_init);
                            }
                            /* A PER-COPY SLOT HAS NO STANDING PROGRAM. The display tier
                               compiled it into a view program the renderer runs once per
                               copy; the cell still exists (it is the slot's declared
                               storage and the migration keys on it) and simply stays
                               UNKNOWN, because there is no one value for it to hold. */
                            if (!expr_text.empty() && !reads_view_input(expr_text))
                                pending_slots_.push_back(PendingSlot{
                                    info.id, name, expr_text, info.slots[name], &slot});
                        }
                    }
                    const uint32_t index = static_cast<uint32_t>(elements_.size());
                    elements_.push_back(std::move(info));
                    /* an INSTANCE's children are its component's, not the document's:
                       the subtree under one is empty, and descending is a no-op */
                    walk_children(instance.children, index);
                }
            };
            walk_children(page.children, UINT32_MAX);
        }
    }

    /* ONE SLOT'S AUTHORED NUMBER, the instance's value first and the type's default
     * otherwise: what a compile-time constant over an instance's own configuration reads
     * (an edit recompiles, so compile time is live enough). */
    bool slot_number(const ElementInfo& element, const std::string& slot, double& out) const {
        if (!element.node || !element.type) return false;
        if (const Json* at = authored_slot(element.node->slots, slot))
            if (at->is_number()) {
                out = at->get<double>();
                return true;
            }
        for (const SlotSpec& row : element.type->slots)
            if (row.name == slot) {
                if (!row.initial.is_number()) return false;
                out = row.initial.get<double>();
                return true;
            }
        return false;
    }

    /* THE CONSTANT FOLD: `+ - * / ( )` over numeric literals and the instance's own
     * slot values, and nothing else. It is what lets a cadence be authored as
     * "1000 / rate" and a keep as "rate * window" — configuration arithmetic, resolved
     * once at compile against values an edit would recompile anyway, rather than a
     * second expression tier the scheduler would have to evaluate per tick.
     *
     * The text goes through THE parser — one grammar, one precedence, one spelling of
     * every token — and this walk answers only what is constant. `this.` is accepted
     * as a prefix so the same text reads in a flow's expressions and here. Anything it
     * cannot resolve fails, and the caller turns that into a finding: a cadence that
     * quietly fell back to a default would be a lie about how often something samples. */
    bool fold_number(const ElementInfo& element, const std::string& text,
                     double& out) const {
        Ast ast;
        Refusal broken;
        if (!parse_expression(text, ast, broken)) return false;
        if (!fold_node(element, ast, ast.root, out)) return false;
        return std::isfinite(out);
    }

    bool fold_node(const ElementInfo& element, const Ast& ast, uint32_t index,
                   double& out) const {
        const Expr& expr = ast.at(index);
        switch (expr.kind) {
            case ExprKind::Number:
                out = expr.number;
                return true;
            case ExprKind::Prefix: {
                if (expr.op != TokenKind::Minus) return false;
                if (!fold_node(element, ast, expr.a, out)) return false;
                out = -out;
                return true;
            }
            case ExprKind::Binary: {
                double left = 0, right = 0;
                if (!fold_node(element, ast, expr.a, left) ||
                    !fold_node(element, ast, expr.b, right))
                    return false;
                switch (expr.op) {
                    case TokenKind::Plus: out = left + right; return true;
                    case TokenKind::Minus: out = left - right; return true;
                    case TokenKind::Star: out = left * right; return true;
                    case TokenKind::Slash:
                        if (right == 0.0) return false;
                        out = left / right;
                        return true;
                    default: return false;
                }
            }
            case ExprKind::Name:
            case ExprKind::Member: {
                /* a plain dotted name, read off the instance's own slots */
                std::string name;
                uint32_t walk = index;
                while (ast.at(walk).kind == ExprKind::Member) {
                    const Expr& member = ast.at(walk);
                    if (member.called) return false;
                    name = member.text + (name.empty() ? "" : "." + name);
                    walk = member.a;
                }
                if (ast.at(walk).kind != ExprKind::Name) return false;
                name = ast.at(walk).text + (name.empty() ? "" : "." + name);
                if (name.compare(0, 5, "this.") == 0) name = name.substr(5);
                return slot_number(element, name, out);
            }
            default:
                return false;
        }
    }

    /* AN `every` TRIGGER: the flow runs on its own clock, with no event behind it. `ms`
     * is a number or the text of a constant expression over the instance's slots; anything
     * unresolvable drops the trigger with a finding rather than picking a rate nobody
     * asked for. Ticks are milliseconds, clamped to something a scheduler can honour. */
    bool cadence_trigger(const ElementInfo& element, const TriggerDecl& trigger,
                         uint64_t flow_id, FlowProgram& flow) {
        double period = 0.0;
        bool ok = false;
        if (trigger.ms.kind == NumOrText::Kind::Num) {
            period = trigger.ms.num;
            ok = std::isfinite(period);
        } else if (trigger.ms.kind == NumOrText::Kind::Text) {
            ok = fold_number(element, trigger.ms.text, period);
        }
        if (!ok || period <= 0.0) {
            diag(flow_id, "trigger",
                 "an 'every' trigger needs `ms`: a number, or constant arithmetic over "
                 "this instance's slots (\"1000 / rate\")");
            return false;
        }
        period = std::min(3600000.0, std::max(10.0, period));
        flow.event = "every:" + std::to_string(flow_id);
        flow.cadence_ticks = static_cast<uint32_t>(std::lround(period));
        return true;
    }

    /* A color slot value may be a token reference, "$<name>" (spec 2.10), authored or a
     * registry default alike. It compiles to the token's DARK value; an unknown token is
     * a finding on the slot and falls back to transparent — a stale reference must never
     * fault, it just paints nothing until the token exists again. A WARNING, not an
     * error: a missing styling name degrades the paint, it does not invalidate the
     * program the way an unresolved entity does. */
    Json resolve_token(uint64_t node_id, const std::string& slot, const Json& value) {
        if (!value.is_string()) return value;
        const std::string text = value.get<std::string>();
        if (text.empty() || text[0] != '$') return value;
        auto found = tokens_.find(text.substr(1));
        if (found != tokens_.end()) return Json(found->second);
        diag(node_id, "unknown_token",
             "unknown token '" + text + "': the slot paints transparent",
             DiagGrade::Warning, slot);
        return Json("#00000000");
    }

    /* WHERE an authored aggregate is being read, so one set of parsers can serve a slot
     * and a declared variable and each finding still names the thing the author is
     * looking at. `teach` is the spelling that would have worked — a refusal that does
     * not end on one is only half a finding. */
    struct AggSite {
        uint64_t node = 0;
        std::string subject;   /* "slot 'options'" / "variable 'log'" */
        std::string where;     /* the inspector field the finding lands on */
        std::string teach;
    };

    bool refuse_agg(const AggSite& site, const std::string& why) {
        diag(site.node, "value_shape", site.subject + ": " + why + ". " + site.teach,
             DiagGrade::Error, site.where);
        return false;
    }

    /* THE AUTHORED VALUE OF A LIST SLOT (a Dropdown's or a Selector's `options`), in
     * exactly two spellings:
     *
     *   ["Off", "Low", "High"]     the list itself, elements scalar
     *   variants(Motor.mode)       every variant NAME of a mesh enum, in declaration
     *                              order, so the options cannot drift from the schema
     *
     * The array may arrive as JSON or as the TEXT of that JSON, because an inspector
     * field commits a string and the document keeps what it was given. Nothing else is
     * accepted: a value that cannot be a list would otherwise compile to Nil, and Nil is
     * also the honest "nothing authored", so the mistake would be invisible.
     *
     * Returns whether an initial was authored at all; the elements land in `out`, text
     * among them as constant-pool refs. */
    bool list_slot_initial(uint64_t node_id, const std::string& slot, const Json& value,
                           std::vector<Value>& out, Shape elem = Shape::Unknown) {
        const AggSite site{node_id, "slot '" + slot + "' is a list", slot,
                           "Write the options as a list ([\"Off\", \"Low\", \"High\"]) "
                           "or bind them through an expression — a variable's name, or "
                           "myMode.variants() for an enum's own vocabulary"};
        if (value.is_null()) return false;
        if (value.is_string()) {
            const std::string text = trimmed(value.get<std::string>());
            if (text.empty()) return false;
            const Json parsed = Json::parse(text, nullptr, false);
            if (!parsed.is_array())
                return refuse_agg(site, "'" + text + "' is not a list");
            return list_elements(site, parsed, out, elem);
        }
        if (!value.is_array())
            return refuse_agg(site, "its value is " + json_brief(value));
        return list_elements(site, value, out, elem);
    }

    /* THE AUTHORED VALUE OF A MAP SLOT: an object of scalars, or the text of one. The
     * same two spellings a list slot takes, for the same reason — an inspector field
     * commits a string and the document keeps what it was given. */
    bool map_slot_initial(uint64_t node_id, const std::string& slot, const Json& value,
                          std::vector<Value>& out, Shape elem = Shape::Unknown) {
        const AggSite site{node_id, "slot '" + slot + "' is a map", slot,
                           "Write it as an object of scalars ({\"a\": 1, \"b\": 2})"};
        Json object = value;
        if (object.is_string()) {
            const std::string text = trimmed(object.get<std::string>());
            if (text.empty()) return false;
            object = Json::parse(text, nullptr, false);
        }
        if (object.is_null()) return false;
        if (!object.is_object())
            return refuse_agg(site, "its value is " + json_brief(value));
        return map_entries(site, object, out, elem);
    }

    bool list_elements(const AggSite& site, const Json& array, std::vector<Value>& out,
                       Shape elem = Shape::Unknown) {
        for (const Json& item : array) {
            Value element = Value::nil();
            if (!scalar_element(site, elem, item, element)) {
                out.clear();
                return refuse_agg(site, "the element " + json_brief(item) + " is not " +
                                            element_spelling(elem));
            }
            out.push_back(element);
        }
        return list_within_bounds(site, out);
    }

    /* what an authored member is allowed to LOOK LIKE, so a refusal ends on the spelling
       that would have worked rather than on the general rule */
    static const char* element_spelling(Shape elem) {
        return elem == Shape::Color ? "a color (\"#rrggbb\", \"#rrggbbaa\" or \"$token\")"
                                    : "a string, a number or a boolean";
    }

    /* ONE MEMBER of an authored aggregate: the three JSON scalars, as themselves. A
     * nested array or object is refused by the caller — nested aggregates do not exist
     * anywhere in this system, so an authored one would be a shape nothing can hold.
     *
     * A declared COLOR element is the one place the JSON spelling and the stored value
     * differ: a color is written as a string everywhere in this document (there is no
     * JSON colour literal), so the declaration is what says a string here means a colour.
     * It takes the same two spellings a scalar colour slot does — a hex literal or a
     * "$token" reference — and resolve_token warns about a stale name exactly once,
     * against the field the author is looking at. */
    bool scalar_element(const AggSite& site, Shape elem, const Json& item, Value& out) {
        if (item.is_string()) {
            if (elem == Shape::Color) {
                const Json resolved = resolve_token(site.node, site.where, item);
                bool ok = false;
                const uint32_t rgba = parse_color(resolved.get<std::string>(), ok);
                if (!ok) return false;
                out = Value::color(rgba);
                return true;
            }
            out = Value::text(program_.add_text(item.get<std::string>()));
        }
        else if (item.is_number()) out = Value::number(item.get<double>());
        else if (item.is_boolean()) out = Value::boolean(item.get<bool>());
        else return false;
        return true;
    }

    /* the element ceiling is a compile-time bound, so a longer literal is a finding
       rather than a truncation nobody sees */
    bool list_within_bounds(const AggSite& site, std::vector<Value>& out) {
        if (out.size() <= kVarrCeiling) return true;
        diag(site.node, "value_shape",
             site.subject + ": " + std::to_string(out.size()) +
                 " elements were authored, and an authored literal holds at most " +
                 std::to_string(kVarrCeiling),
             DiagGrade::Error, site.where);
        out.clear();
        return false;
    }

    /* AN AUTHORED MAP: a JSON object of scalar members, or the TEXT of one (an inspector
     * field commits a string). nlohmann keeps an object's keys sorted, which is exactly
     * the order a retained map holds them in, so the pairs land interleaved and already
     * in place. A non-scalar member names itself in the finding — an aggregate inside an
     * aggregate has no representation anywhere in this system. */
    bool map_entries(const AggSite& site, const Json& object, std::vector<Value>& out,
                     Shape elem = Shape::Unknown) {
        for (auto it = object.begin(); it != object.end(); ++it) {
            Value value = Value::nil();
            if (!it->is_null() && !scalar_element(site, elem, *it, value)) {
                out.clear();
                return refuse_agg(site, "the member '" + it.key() + "' is " +
                                            json_brief(*it) + ", which is not " +
                                            element_spelling(elem));
            }
            out.push_back(Value::text(program_.add_text(it.key())));
            out.push_back(value);
        }
        if (out.size() <= static_cast<size_t>(kVarrCeiling) * 2) return true;
        diag(site.node, "value_shape",
             site.subject + ": " + std::to_string(out.size() / 2) +
                 " keys were authored, and an authored literal holds at most " +
                 std::to_string(kVarrCeiling),
             DiagGrade::Error, site.where);
        out.clear();
        return false;
    }

    /* A DECLARED LIST OR MAP VARIABLE'S START. Absent, null or empty text is an authored
     * EMPTY aggregate rather than UNKNOWN: a declared buffer starts empty, which is what
     * makes a fresh ring appendable with no ceremony. Anything that cannot BE the shape
     * is a finding and the cell still starts empty — the declaration stands, the value
     * was wrong. `variants(...)` is a SLOT spelling and is refused here by name rather
     * than compiling to something surprising. */
    void aggregate_var_initial(const VarDecl& var, Shape shape, uint32_t cell) {
        const bool pairs = shape == Shape::Map;
        const AggSite site{
            var.id,
            std::string("variable '") + var.name + "' is a " + (pairs ? "map" : "list"),
            "init",
            pairs ? "Write its start as an object of scalars ({\"a\": 1, \"b\": 2}), or "
                    "leave it empty"
                  : "Write its start as a list of scalars ([1, 2, 3]), or leave it empty"};
        std::vector<Value> out;
        Json value = var.init;
        if (value.is_string()) {
            const std::string text = trimmed(value.get<std::string>());
            if (text.compare(0, 9, "variants(") == 0)
                refuse_agg(site, "variants(...) is a SLOT's authored value (the enum "
                                 "picker writes it), not a variable's start");
            else if (!text.empty())
                value = Json::parse(text, nullptr, false);
            else
                value = Json();
        }
        const Shape elem = program_.cells[cell].elem;
        if (elem == Shape::List || elem == Shape::Map) {
            nested_var_initial(site, shape, elem, cell, value);
            return;
        }
        if (!value.is_null()) {
            if (pairs && value.is_object()) map_entries(site, value, out, elem);
            else if (!pairs && value.is_array()) list_elements(site, value, out, elem);
            else refuse_agg(site, "its start is " + json_brief(value));
        }
        /* a declared element type holds from the very start: one foreign element in
           the authored literal is a finding and the buffer starts empty instead */
        if (elem != Shape::Unknown) {
            const size_t stride = pairs ? 2 : 1;
            for (size_t i = pairs ? 1 : 0; i < out.size(); i += stride) {
                const Shape held = value_shape(out[i]);
                if (held == elem || held == Shape::Nil) continue;
                refuse_agg(site, "its elements are declared " +
                                     std::string(shape_name(elem)) + ", and the start "
                                     "holds a " + shape_name(held));
                out.clear();
                break;
            }
        }
        program_.cells[cell].has_list = true;
        program_.cells[cell].list_init = std::move(out);
    }

    /* A NESTED VARIABLE'S START: the same JSON one level deeper, and one level only.
     * Every member of the outer container has to BE the declared row shape — a scalar
     * where a row was declared is the finding, never a silent promotion — and every member
     * of a row has to be a scalar, because there is no third level to hold anything else.
     *
     * A nested MAP keeps its KEYS in `list_init`, interleaved with a Nil where the value
     * would sit, so the pairs stay in the order nlohmann already sorted them into and the
     * runtime's own map layout needs no special case. The rows go beside them, one per
     * entry, in `row_init`. */
    void nested_var_initial(const AggSite& outer_site, Shape shape, Shape elem,
                            uint32_t cell, const Json& value) {
        const bool pairs = shape == Shape::Map;
        const bool row_pairs = elem == Shape::Map;
        AggSite site = outer_site;
        site.teach = std::string("Write its start as ") +
                     (pairs ? "an object of " : "a list of ") +
                     (row_pairs ? "objects ({\"a\": {\"x\": 1}})" : "lists ([[1, 2], [3]])") +
                     ", or leave it empty";
        std::vector<Value> keys;
        std::vector<std::vector<Value>> rows;
        bool ok = true;
        auto take_row = [&](const Json& item) {
            std::vector<Value> row;
            if (row_pairs && !item.is_object())
                return refuse_agg(site, "a row is " + json_brief(item) +
                                            ", and its rows are declared maps");
            if (!row_pairs && !item.is_array())
                return refuse_agg(site, "a row is " + json_brief(item) +
                                            ", and its rows are declared lists");
            const Shape leaf = program_.cells[cell].leaf;
            if (row_pairs ? !map_entries(site, item, row, leaf)
                          : !list_elements(site, item, row, leaf))
                return false;
            /* a declared leaf type holds from the very start, exactly as a flat cell's
               declared element type does */
            if (leaf != Shape::Unknown)
                for (size_t i = row_pairs ? 1 : 0; i < row.size(); i += row_pairs ? 2 : 1) {
                    const Shape held = value_shape(row[i]);
                    if (held == leaf || held == Shape::Nil) continue;
                    return refuse_agg(site, "its rows hold " +
                                                std::string(shape_name(leaf)) +
                                                ", and the start holds a " +
                                                shape_name(held));
                }
            rows.push_back(std::move(row));
            return true;
        };
        if (!value.is_null()) {
            if (pairs && value.is_object()) {
                for (auto it = value.begin(); ok && it != value.end(); ++it) {
                    keys.push_back(Value::text(program_.add_text(it.key())));
                    keys.push_back(Value::nil());
                    ok = take_row(*it);
                }
            } else if (!pairs && value.is_array()) {
                for (const Json& item : value) {
                    ok = take_row(item);
                    if (!ok) break;
                }
            } else {
                ok = refuse_agg(site, "its start is " + json_brief(value));
            }
        }
        /* the outer count takes the same authored-literal bound a flat one does: a longer
           start is a finding rather than a truncation nobody sees */
        if (ok && rows.size() > kVarrCeiling) {
            diag(site.node, "value_shape",
                 site.subject + ": " + std::to_string(rows.size()) +
                     " rows were authored, and an authored literal holds at most " +
                     std::to_string(kVarrCeiling),
                 DiagGrade::Error, site.where);
            ok = false;
        }
        if (!ok) {
            keys.clear();
            rows.clear();
        }
        program_.cells[cell].has_list = true;
        program_.cells[cell].list_init = std::move(keys);
        program_.cells[cell].row_init = std::move(rows);
    }

    /* a value outside a slot's declared variant set is a typo, not a new option */
    void check_variants(uint64_t node_id, const std::string& slot, const SlotSpec& spec,
                        const Json& value) {
        if (spec.variants.empty() || !value.is_string()) return;
        const std::string text = value.get<std::string>();
        for (const std::string& variant : spec.variants)
            if (variant == text) return;
        std::string known;
        for (const std::string& variant : spec.variants)
            known += (known.empty() ? "" : ", ") + variant;
        diag(node_id, "slot_variant",
             "slot '" + slot + "' is " + json_brief(value) + ", which is not one of: " + known,
             DiagGrade::Error, slot);
    }

    /* the DECLARED element type of a list or map variable ("" = undeclared, any
     * scalar): spelled with the scalar variable type names, so the vocabulary the
     * type picker already teaches is the one this reads. A wrong spelling is a
     * finding on the variable, never a silent anything-goes. */
    Shape declared_elem(const VarDecl& var) {
        const std::string text = trimmed(var.elem);
        if (text.empty()) return Shape::Unknown;
        const Shape shape = var_shape(text);
        if (shape == Shape::Num || shape == Shape::Bool || shape == Shape::Text ||
            shape == Shape::Color)
            return shape;
        /* list or map here declares a NESTED cell: every element is a row, and `leaf`
           says what the rows hold */
        if (shape == Shape::List || shape == Shape::Map) return shape;
        diag(var.id, "value_shape",
             "variable '" + var.name + "': '" + text +
                 "' is not an element type; elements are num, bool, text, color or icon, "
                 "or list or map for rows",
             DiagGrade::Error, "elem");
        return Shape::Unknown;
    }

    /* THE LEAF TYPE of a nested list or map: what its ROWS hold. It is read only where
     * `elem` declares a row, and only a scalar can be spelled — nesting is ONE level by
     * construction, so there is nothing below a row for a third name to describe. */
    Shape declared_leaf(const VarDecl& var, Shape elem) {
        const std::string text = trimmed(var.leaf);
        if (text.empty()) return Shape::Unknown;
        if (elem != Shape::List && elem != Shape::Map) {
            diag(var.id, "value_shape",
                 "variable '" + var.name +
                     "': a leaf type says what the ROWS hold, and this variable's elements "
                     "are " +
                     (elem == Shape::Unknown ? std::string("undeclared")
                                             : std::string(shape_name(elem))) +
                     "; declare its elements list or map first",
                 DiagGrade::Error, "leaf");
            return Shape::Unknown;
        }
        const Shape shape = var_shape(text);
        if (shape == Shape::Num || shape == Shape::Bool || shape == Shape::Text ||
            shape == Shape::Color)
            return shape;
        diag(var.id, "value_shape",
             "variable '" + var.name + "': '" + text +
                 "' is not a leaf type; a row holds num, bool, text, color or icon — "
                 "nesting is one level, so there is nothing below a row to be a list of",
             DiagGrade::Error, "leaf");
        return Shape::Unknown;
    }

    /* A DECLARED TYPE -> the shape its cell holds. ONE TABLE, because a variable's `type`
     * and a served row's `shape` are one vocabulary now — the props/vars split is what
     * used to make them two, and `f64`/`str` were the last words only one of them spoke.
     *
     * `icon` and `enum` are CONSTRAINED TEXT: the cell holds the glyph's name or the
     * variant's name, and the declared word only earns the editor. The VM's Shape::Enum
     * means something else entirely — a mesh field's backing integer (spec 2.2) — and
     * conflating them left every enum reading Nil. `timer` is the one type a component
     * cannot have, refused where it is declared rather than here. */
    Shape var_shape(const std::string& type) const {
        if (type == "icon" || type == "enum") return Shape::Text;
        if (type == "timer") return Shape::Timer;
        return shape_from_name(type);
    }

    ElementInfo* element_info(uint64_t id) {
        for (ElementInfo& info : elements_)
            if (info.id == id) return &info;
        return nullptr;
    }

    int find_entity(EntityKind kind, const std::string& name) const {
        for (uint32_t i = 0; i < program_.entities.size(); ++i)
            if (program_.entities[i].kind == kind && program_.entities[i].name == name)
                return static_cast<int>(i);
        return -1;
    }

    /* `where` narrows the diag to a field of the node (a feed's "src" / "path" row); a
     * step passes nothing, the step row itself is the line */
    int resolve_entity(const ToDecl& ref, uint64_t node, const std::string& where = "") {
        EntityKind kind;
        const std::string& kind_text = ref.kind;
        const std::string& name = ref.name;
        if (kind_text == "L") {
            diag(node, "local_entity", "an HMI variable is not a mesh target",
                 DiagGrade::Error, where);
            return -1;
        }
        if (!entity_kind(kind_text, kind)) {
            diag(node, "entity_kind", "entity kind '" + kind_text + "' is invalid",
                 DiagGrade::Error, where);
            return -1;
        }
        const int found = find_entity(kind, name);
        if (found < 0)
            diag(node, "unresolved_entity",
                 "mesh entity " + kind_text + ":" + name + " is not reflected",
                 DiagGrade::Error, where);
        return found;
    }

    /* `response` reads a function's response table (what a feed decodes); everything
     * else (a call's build/setf, a bare send) targets the value/request fields */
    int find_field(uint32_t entity, const std::string& path, uint64_t node,
                   const std::string& where = "", bool response = false) {
        const EntityDef& def = program_.entities[entity];
        const std::vector<FieldDef>& fields = response ? feed_fields(def) : def.fields;
        if (path.empty() && fields.size() == 1) return 0;
        for (uint32_t i = 0; i < fields.size(); ++i)
            if (fields[i].path == path) return static_cast<int>(i);
        diag(node, "unresolved_field",
             "entity '" + def.name + "' has no field '" + path + "'",
             DiagGrade::Error, where);
        return -1;
    }

    /* a struct-typed variable also puts each of its fields in scope, dotted, the same
     * way a struct temporary does (ensure_struct_local): `staged.position` reads like
     * any other name. EVERY field reads through the FIELD PLACE — an aggregate field's
     * handle is kept current by the store's owner refresh, so the read through the
     * field sees exactly what the derived storage holds; writes still land in the
     * derived cell, which is where the storage lives. */
    void bind_variable(Env& scope, const std::string& name, uint32_t cell_index) {
        const CellDef& cell = program_.cells[cell_index];
        scope.bind_value(name,
                         Place{Type(cell.shape, cell.type_id), OpCode::Load, cell_index, 0});
        if (cell.shape != Shape::Struct) return;
        const std::vector<FieldDef>& fields = struct_fields(program_, cell.type_id);
        for (uint32_t i = 0; i < fields.size(); ++i)
            scope.bind_field(name, fields[i].path,
                             Place{field_place_type(fields[i]), OpCode::Load, cell_index,
                                   i, static_cast<uint16_t>(LoadPlace::Field)});
    }

    /* a struct field's Type as its place reads it: an aggregate carries its declared
     * element, a scalar its enum id */
    static Type field_place_type(const FieldDef& field) {
        if (field.shape == Shape::List || field.shape == Shape::Map)
            return Type::list_of(field.shape, field.elem);
        return Type(field.shape, field.type_id);
    }

    /* the derived cell holding one aggregate field of a struct cell, else UINT32_MAX.
     * The map is the COMPILER'S working record (the runtime resolves through the
     * derived cells' own field_of backpointers and the owner's field handles). */
    uint32_t field_cell(uint32_t struct_cell, uint32_t field) const {
        const uint32_t slot = program_.cells[struct_cell].struct_slot;
        if (slot >= field_cells_.size()) return UINT32_MAX;
        const std::vector<uint32_t>& row = field_cells_[slot];
        return field < row.size() ? row[field] : UINT32_MAX;
    }

    /* Every aggregate field of a fresh struct cell gets a DERIVED CELL of its own
     * ("jogCmd.v"): an ordinary list/map cell — born empty, element-typed by the
     * field, migrating by name — that IS the field's storage. Writes land in it and
     * refresh the owner's field handle themselves; reads go through the field. The
     * cells never publish (field_of marks them; the struct's key would collide). */
    void add_field_cells(CellKind kind, uint64_t owner, uint64_t flow_id,
                         const std::string& name, uint32_t struct_cell) {
        const uint16_t type_id = program_.cells[struct_cell].type_id;
        const uint32_t slot = program_.cells[struct_cell].struct_slot;
        const std::vector<FieldDef>& fields = struct_fields(program_, type_id);
        if (field_cells_.size() <= slot) field_cells_.resize(slot + 1);
        field_cells_[slot].assign(fields.size(), UINT32_MAX);
        for (uint32_t i = 0; i < fields.size(); ++i) {
            if (fields[i].shape != Shape::List && fields[i].shape != Shape::Map)
                continue;
            const uint32_t cell = add_cell(kind, owner, 0, name + "." + fields[i].path,
                                           fields[i].shape, Json(), false);
            CellDef& def = program_.cells[cell];
            def.has_list = true;   /* born EMPTY storage; the FIELD stays UNKNOWN until
                                      something writes it */
            def.elem = fields[i].elem;
            def.field_of = struct_cell;
            def.field_index = static_cast<uint16_t>(i);
            def.owner_flow = flow_id;
            field_cells_[slot][i] = cell;
        }
    }

    /* the derived cell behind `<name>.<path>` when the holder is a struct and the
     * field is an aggregate; every miss teaches */
    uint32_t resolve_field_cell(uint32_t holder, const std::string& name,
                                const std::string& path, uint64_t step_id) {
        const CellDef& cell = program_.cells[holder];
        if (cell.shape != Shape::Struct) {
            diag(step_id, "move_dest",
                 "'" + name + "' is " + shape_name(cell.shape) + ", which has no fields",
                 DiagGrade::Error, "to");
            return UINT32_MAX;
        }
        const std::vector<FieldDef>& fields = struct_fields(program_, cell.type_id);
        int field = -1;
        for (uint32_t i = 0; i < fields.size(); ++i)
            if (fields[i].path == path) field = static_cast<int>(i);
        if (field < 0) {
            diag(step_id, "unresolved_field",
                 "'" + type_name_of(cell.type_id) + "' has no field '" + path + "'",
                 DiagGrade::Error, "to");
            return UINT32_MAX;
        }
        if (fields[field].shape != Shape::List && fields[field].shape != Shape::Map) {
            diag(step_id, "move_dest",
                 "'" + name + "." + path + "' is " + shape_name(fields[field].shape) +
                     "; an element write addresses a list by index or a map by key",
                 DiagGrade::Error, "to");
            return UINT32_MAX;
        }
        const uint32_t derived = field_cell(holder, static_cast<uint32_t>(field));
        if (derived == UINT32_MAX)
            diag(step_id, "move_dest",
                 "'" + name + "." + path + "' has no storage in this program",
                 DiagGrade::Error, "to");
        return derived;
    }

    /* a timer variable reads by FIELD (`blink.running`, `blink.remaining`): the state
     * lives in the timer table, not the cell, so its bindings load from there — the
     * descriptor's row order IS TmrRead's operand vocabulary */
    void bind_timer(Env& scope, const std::string& name, uint32_t index) {
        constexpr uint32_t count = sizeof(kTimerFields) / sizeof(kTimerFields[0]);
        for (uint32_t i = 0; i < count; ++i)
            scope.bind_field(name, kTimerFields[i].name,
                             Place{Type(kTimerFields[i].shape), OpCode::TmrRead, index, i});
        scope.objects[name].bare_refusal =
            "'" + name + "' is a timer; read a field (" +
            object_field_list(name.c_str(), kTimerFields) + ")";
    }

    /* the system clock, in every scalar scope: `time` reads by field, off the served
       descriptor the VM dispatches on. Bound FIRST-AS-RESERVED: it lands after every
       variable and timer, so `time.*` is always the clock — the same reservation the
       display tier makes by checking `time` before the property scope. */
    void bind_clock(Env& scope) {
        constexpr uint32_t count = sizeof(kClockFields) / sizeof(kClockFields[0]);
        for (uint32_t i = 0; i < count; ++i)
            scope.bind_field("time", kClockFields[i].name,
                             Place{Type(kClockFields[i].shape), OpCode::ClockRead, i, 0});
        scope.objects["time"].bare_refusal =
            "'time' reads by field (" + object_field_list("time", kClockFields) + ")";
    }

    /* WHICH COPY OF A `repeat` RAISED THIS: the same three fields the view answers, off
     * the argument slots the invocation seeded — the descriptor's row order is the
     * frame.args[1..3] order. Bound only where an event can carry one — see
     * refuse_repeat for the other half. Reserved like `time`, by landing last: no
     * variable can shadow it. */
    void bind_repeat(Env& scope) {
        constexpr uint32_t count = sizeof(kRepeatFields) / sizeof(kRepeatFields[0]);
        for (uint32_t i = 0; i < count; ++i)
            scope.bind_field("repeat", kRepeatFields[i].name,
                             Place{Type(kRepeatFields[i].shape), OpCode::Arg, i + 1, 0});
    }

    /* A CADENCE HAS NO COPY. `every` and a timer fire for the ELEMENT — one element, one
     * set of cells, however many times the view drew it — so there is no copy to be, and
     * a run reading Nil here would fault somewhere downstream with the reason a step
     * removed. Refused by name, saying which triggers do carry one. */
    void refuse_repeat(Env& scope, const std::string& what) {
        scope.refuse("repeat",
                     "there is no copy behind " + what + ": `repeat` names the copy an "
                     "EVENT arrived on, so it reads in a flow some event triggers");
    }

    /* every component name the document places somewhere */
    std::set<std::string> placed_types() const {
        std::set<std::string> out;
        std::function<void(const NodeDecl&)> walk = [&](const NodeDecl& node) {
            if (!node.type.empty()) out.insert(node.type);
            for (const NodeDecl& child : node.children) walk(child);
        };
        for (const PageDecl& page : doc_.pages)
            for (const NodeDecl& child : page.children) walk(child);
        return out;
    }

    /* the elements enclosing this one, OUTERMOST FIRST — the page's own children at the
     * front, this element last. Binding in this order is what makes the scope lexical:
     * a nearer declaration simply overwrites the name it shadows. */
    std::vector<const ElementInfo*> lexical_chain(const ElementInfo& element) const {
        std::vector<const ElementInfo*> chain;
        for (const ElementInfo* at = &element; at;
             at = at->parent == UINT32_MAX ? nullptr : &elements_[at->parent])
            chain.push_back(at);
        std::reverse(chain.begin(), chain.end());
        return chain;
    }

    /* WHAT A NAME MEANS AT ONE ELEMENT ON A PAGE (spec: one scope, resolved by position).
     * Widest first so the nearer declaration wins: the globals, then every enclosing
     * element's locals from the page inward, then this element's own, then the clock
     * (reserved), then `this.<prop>` for the component this element places.
     *
     * A component's insides do NOT come through here — see behavior_scope_for. */
    Env scope_for(const ElementInfo& element, Shape x_shape) {
        Env scope;
        bind_enums(scope);
        for (const auto& item : globals_) bind_variable(scope, item.first, item.second);
        for (const auto& item : global_timers_) bind_timer(scope, item.first, item.second);
        for (const ElementInfo* at : lexical_chain(element)) {
            for (const auto& item : at->locals) bind_variable(scope, item.first, item.second);
            for (const auto& item : at->timers) bind_timer(scope, item.first, item.second);
        }
        bind_clock(scope);
        bind_own_props(scope, element);
        bind_x(scope, x_shape);
        return scope;
    }

    /* `x`, the pipeline register, bound LAST: it is the language's word, so no
     * variable may shadow it — a declaration named x is simply dead here, exactly as
     * it always was */
    void bind_x(Env& scope, Shape x_shape, uint16_t x_enum = 0) {
        scope.bind_value("x", Place{Type(x_shape, x_enum), OpCode::LoadX, 0, 0});
    }

    /* the enum vocabulary behind each type id, for `.variant` and `.is()` */
    void bind_enums(Env& scope) {
        scope.enums.clear();
        for (const TypeDef& type : program_.types)
            scope.enums.push_back(type.kind == TypeKind::Enum ? &type.variants : nullptr);
        /* the TYPE ROSTER: every enum field of every named schema type, under the
           spelling find_type_ref reads ("JobCmd.jobName") — what a bare type
           reference's .variants() resolves against */
        scope.enum_types.clear();
        for (const TypeDef& type : program_.types) {
            if (type.name.empty()) continue;
            for (const FieldDef& field : type.fields)
                if (field.type_id && field.type_id < program_.types.size() &&
                    program_.types[field.type_id].kind == TypeKind::Enum)
                    scope.enum_types[type.name + "." + field.path] = field.type_id;
        }
    }

    /* WHAT A NAME MEANS INSIDE A COMPONENT — its own properties, its own locals, the
     * clock, and NOTHING ELSE. A component is a part someone can place anywhere: reaching
     * a global or a mesh entity from inside one would make it a part that only works on
     * the page it was written for. Data enters through properties (whose VALUES are
     * authored on the instance, in the page's own full scope) and leaves through events.
     * The refusal that enforces this teaches the way in — see isolated_name_help. */
    Env behavior_scope_for(const ElementInfo& element, Shape x_shape) {
        Env scope;
        bind_enums(scope);
        /* deliberately no locals and no timers: the instance's are the PAGE's, and the
           component's own are declared on the component (they arrive with per-instance
           component locals; until then a component's behavior holds no variables) */
        bind_clock(scope);
        bind_own_props(scope, element);
        bind_x(scope, x_shape);
        return scope;
    }

    /* did the display tier take this slot over? (THE PLACEMENT RULE — its expression
       names `state` or `repeat`, so it is evaluated per copy in the view). Derived
       from the AUTHORED TEXT by the same function the display tier asks
       (lang/template_expr.h reads_view_input): no record travels between the tiers,
       so they can never disagree. */
    bool per_copy_slot(const ElementInfo& element, const std::string& name) const {
        if (!element.node) return false;
        const Json* authored = authored_slot(element.node->slots, name);
        return authored && authored->is_string() &&
               reads_view_input(authored->get<std::string>());
    }

    /* `this.<prop>` — the properties of the component this element places, by address.
     *
     * A PER-COPY ONE IS REFUSED BY NAME instead of bound. Its cell exists but nothing
     * writes it: the value differs per picture and the backend keeps one of it. Binding it
     * anyway would read UNKNOWN forever — the exact silent wrongness the refusals exist to
     * prevent — so the word is refused with what the author can do instead. */
    void bind_own_props(Env& scope, const ElementInfo& element) {
        for (const auto& item : element.slots) {
            if (per_copy_slot(element, item.first)) {
                scope.refuse(
                    "this." + item.first,
                    "'" + item.first + "' is evaluated PER COPY here — its expression "
                    "names the view's own `state` or `repeat`, so it has one value per "
                    "picture and none for a flow to read; name what it reads from "
                    "directly, or drop `state`/`repeat` out of the property's expression");
                continue;
            }
            const CellDef& cell = program_.cells[item.second];
            scope.bind_field("this", item.first,
                             Place{Type(cell.shape), OpCode::Load, item.second, 0});
        }
    }

    /* ONE expression toward ONE destination: the checking — the shape fit, the
     * element rules, the cross-enum refusal, the implicit conversions, the one-scalar
     * rule — all lives at the pipeline boundary now (lang/compile.cpp), reading the
     * destination as data. This shim only turns refusals into findings: one diag row
     * per independent refusal (rule 16), each carrying its span and code as data. */
    bool expression(uint64_t node, const std::string& text, ExprTier tier,
                    const Env& scope, const Dest& dest,
                    std::vector<Instruction>& code, uint32_t& max_stack,
                    Shape* actual = nullptr, const std::string& where = "",
                    uint16_t* enum_out = nullptr) {
        ExpressionResult result;
        std::vector<Refusal> refusals;
        NameIndex names;
        const bool ok = compile_expression(text, tier, scope, program_, code, result,
                                           refusals, dest, &names);
        /* THE REFERENCE INDEX (Program::references): every name this expression
           resolved, keyed to its declaring node — recorded whether the compile
           held or not, because a rename must see the names beside a break. A
           PARSE break leaves the site blind instead: what never entered the tree
           left no row, and absence must not read as "not this variable". */
        for (const NameRef& name : names.rows) {
            if (name.cell >= program_.cells.size()) continue;
            program_.references.push_back(RefRow{node, text, name.at, name.length,
                                                 program_.cells[name.cell].decl});
        }
        if (!names.complete)
            program_.reference_gaps.push_back(RefSite{node, text});
        if (!ok) {
            for (const Refusal& refusal : refusals)
                diag_span(node, refusal.code, refusal.message, DiagGrade::Error,
                          where, refusal.at, refusal.length);
            return false;
        }
        if (actual) *actual = result.shape;
        if (enum_out) *enum_out = result.enum_type;
        max_stack = std::max(max_stack, result.max_stack);
        return true;
    }

    /* the ARMED ELEMENTS of every instance, off the served template: trigger validation
     * and the runtime's bubbling topology read one compiled truth */
    void build_armed_elements() {
        for (ElementInfo& element : elements_) {
            if (element.type) {
                collect_armed(element.type->tmpl, "", element);
                continue;
            }
            /* A PLAIN ELEMENT CARRIES ITS OWN GESTURE. There is no template under it, so
               its `interact` is the whole story and it rides the element's own channel —
               the same "" path a component root's does. This is what lets a frame drawn
               on the page have behavior without being made into a component first. */
            const InteractDecl& interact = element.node->interact;
            if (interact.present && !interact.primitive.empty())
                element.armed.push_back(ArmedInfo{"", interact.primitive, interact.bubbles});
        }
    }

    /* walks a COMPONENT TEMPLATE, whose nodes are this instance's anatomy. A page
     * element's children are elements in their own right, with their own records and
     * their own channels, so its armed info is read off its own record above. */
    void collect_armed(const ArmedNode& node, const std::string& path,
                       ElementInfo& element) {
        if (!node.primitive.empty()) {
            ArmedInfo info;
            info.element = path;
            info.primitive = node.primitive;
            info.bubbles = node.bubbles;
            element.armed.push_back(info);
            /* the root's own channel IS the instance-level one; only named elements
               enter the bubbling table */
            if (!path.empty())
                program_.armed_elements.push_back(
                    ArmedElement{element.id, path, info.bubbles});
        }
        for (const ArmedNode& child : node.children)
            collect_armed(child, path.empty() ? child.name : path + "." + child.name,
                          element);
    }

    /* Resolve a trigger's SIGNATURE: a gesture event checks that some armed element (or
     * the named one) raises it and takes its fixed parameter; a custom event reads the
     * component's declaration. False = the trigger is invalid (diagnosed here).
     * `channel` is the ELEMENT CHANNEL the trigger listens on — spelled apart from
     * `element` here because that already names the instance being validated. */
    bool event_signature(const ElementInfo& element, const std::string& event,
                         const std::string& channel, uint64_t flow, bool in_behavior,
                         EventParam& param, bool& has_param) {
        has_param = false;
        if (gesture_event(event)) {
            bool available = false;
            for (const ArmedInfo& armed : element.armed) {
                if (!channel.empty() && armed.element != channel) continue;
                if (gesture_from(event, armed.primitive)) { available = true; break; }
            }
            if (!available) {
                diag(flow, "event",
                     !channel.empty()
                         ? "element '" + channel + "' does not raise '" + event + "'"
                     : element.type
                         ? "no element of this component raises '" + event +
                               "'; give an element the gesture that raises it"
                         /* a plain element answers for itself: its own gesture is the
                            only thing that could raise this, and it has none yet */
                         : "this element raises no '" + event +
                               "'; give it a gesture and the whole family comes with it",
                     DiagGrade::Error);
                return false;
            }
            has_param = gesture_param(event, param);
            return true;
        }
        if (!channel.empty()) {
            diag(flow, "event",
                 "an element channel carries gestures; '" + event + "' is raised by the "
                 "component itself and arrives on the instance's own channel",
                 DiagGrade::Error);
            return false;
        }
        (void)in_behavior;
        if (element.type)
            for (const EventDecl& row : element.type->events) {
                if (row.name != event) continue;
                if (row.params.size() > 1) {
                    diag(flow, "event", "'" + event + "' declares " +
                             std::to_string(row.params.size()) +
                             " parameters; an event carries one for now",
                         DiagGrade::Error);
                    return false;
                }
                if (row.params.size() == 1) {
                    param.name = row.params[0].name;
                    param.shape = shape_from_name(row.params[0].shape);
                    has_param = true;
                }
                return true;
            }
        diag(flow, "event",
             element.type ? "this component has no event '" + event + "'"
                          : "an element raises the gestures its own `interact` brings; '" +
                                event + "' is a component's declared event");
        return false;
    }

    /* EVERY READABLE MESH ENTITY, bound under its '@'-prefixed spelling: a bare-scalar
     * entity (or a one-field message) reads bare, a fielded one by `@name.field`. This
     * is what makes a slot expression multi-source — its deps are whatever it reads.
     * Function entities bind their RESPONSE fields; the poll cadence asks for them. */
    void bind_entities(Env& scope) {
        for (uint32_t e = 0; e < program_.entities.size(); ++e) {
            const EntityDef& def = program_.entities[e];
            const std::vector<FieldDef>& fields = feed_fields(def);
            if (fields.empty()) continue;
            const std::string base = "@" + def.name;
            if (fields.size() == 1)
                scope.bind_value(base,
                                 Place{entity_field_type(fields[0]), OpCode::Load, e, 0,
                                       static_cast<uint16_t>(LoadPlace::Entity)});
            if (fields.size() == 1 && fields[0].path.empty()) continue;
            for (uint32_t i = 0; i < fields.size(); ++i)
                scope.bind_field(base, fields[i].path,
                                 Place{entity_field_type(fields[i]), OpCode::Load, e, i,
                                       static_cast<uint16_t>(LoadPlace::Entity)});
        }
    }

    /* an entity field's Type: an aggregate carries its declared element, a scalar its
     * enum id — exactly what the old Binding carried */
    static Type entity_field_type(const FieldDef& field) {
        if (field.shape == Shape::List || field.shape == Shape::Map)
            return Type::list_of(field.shape, field.elem);
        return Type(field.shape, field.type_id);
    }

    /* THE STANDING SLOT PROGRAMS (spec D1): every pending authored expression, compiled
     * against the instance's scope PLUS the mesh. A constant folds into the cell's start
     * and leaves no program; anything live stores into the cell whenever a dep moves —
     * every tick where it reads cells, on delivery where it reads only the mesh. */
    void build_slot_programs() {
        for (const PendingSlot& pending : pending_slots_) {
            ElementInfo* element = element_info(pending.node_id);
            if (!element) continue;
            compile_slot_program(*element, pending);
        }
    }

    void compile_slot_program(ElementInfo& element, const PendingSlot& pending) {
        const Shape wanted = program_.cells[pending.cell].shape;
        const bool aggregate = wanted == Shape::List || wanted == Shape::Map;
        Env scope = scope_for(element, Shape::Unknown);
        /* a slot expression has no pipeline register */
        scope.objects.erase("x");
        scope.refuse("x", "there is no x here: a slot expression names its sources "
                          "directly (a variable, this.<slot>, @entity.<field>)");
        bind_entities(scope);
        SlotProgram sp;
        sp.node_id = element.id;
        sp.page_id = element.page;
        sp.slot = pending.name;
        sp.cell = pending.cell;
        if (!expression(element.id, pending.text, ExprTier::Display, scope,
                        Dest{Type(wanted), "slot '" + pending.name + "'", aggregate},
                        sp.body.code, sp.body.max_stack, nullptr, pending.name))
            return;   /* the finding is already pinned to the instance's slot row */
        /* A CONSTANT is the literal it spells: it folds into the cell's start and no
           standing program exists — a quoted caption costs what the raw literal did. */
        if (sp.body.code.size() == 1 && sp.body.code[0].op == OpCode::Const) {
            const Value value = program_.constants[sp.body.code[0].a];
            program_.cells[pending.cell].initial = value;
            /* a constant text ref wears kConstantRef: strip it to read the pool */
            const uint32_t pool = value.ref & ~kConstantRef;
            if (value.tag == ValueTag::Text && pool < program_.texts.size())
                check_variants(element.id, pending.name, *pending.spec,
                               Json(program_.texts[pool]));
            return;
        }
        Instruction store;
        store.op = OpCode::Store;
        store.a = pending.cell;
        store.c = fault_site(element.id, "slot_store",
                             "slot '" + pending.name + "' could not store its value");
        sp.body.code.push_back(store);
        sp.body.code.push_back(Instruction{OpCode::Halt});
        sp.body.sig = program_.infer_signature(sp.body.code);
        /* a program that reads nothing live (an array literal, arithmetic over
           constants) still has to run once; the seed pass at start covers it, and
           there is nothing to re-run it for */
        for (uint32_t dep : sp.body.sig.reads) {
            if (program_.entities[dep].kind != EntityKind::Function) continue;
            double hz = 2.0;
            auto rate = element.node->poll.find(pending.name);
            if (rate != element.node->poll.end() && rate->second > 0.0)
                hz = rate->second;
            sp.poll_ms = std::max(10u, static_cast<uint32_t>(std::lround(1000.0 / hz)));
            break;
        }
        program_.frame.stack = std::max(program_.frame.stack, sp.body.max_stack);
        program_.slot_programs.push_back(std::move(sp));
    }

    void break_flow(FlowProgram& flow, uint64_t node, const std::string& code,
                    const std::string& message) {
        diag(node, code, message);
        flow.body.code.clear();
        Instruction fault;
        fault.op = OpCode::Fault;
        fault.a = fault_site(node, code, message);
        flow.body.code.push_back(fault);
        flow.body.code.push_back(Instruction{OpCode::Halt});
        flow.body.max_stack = 1;
        flow.worst_steps = 2;
    }

    /* A SITE FILTER'S MEMORY IS ONE HIDDEN CELL (stage 6d): deadband and throttle
     * each keep one Num cell — named by the step, so a recompile carries the site's
     * memory exactly as it carries any cell, and un-authorable (`~` never lexes as a
     * name) so it can shadow nothing. The cell starts UNKNOWN, and unknown-ness IS
     * the "never armed yet" state: the lowered compare yields Nil and the flow runs. */
    uint32_t site_cell(const ElementInfo& element, uint64_t step_id, const char* what) {
        return add_cell(CellKind::Local, element.id, step_id,
                        std::string("~") + what + ":" + std::to_string(step_id),
                        Shape::Num, Json(), false);
    }

    /* A DECLARED name in this instance's scope: its own local variable, else a global.
     * Temporaries are not here; they are declared by the move that writes them. */
    uint32_t declared_cell(const ElementInfo& element, const std::string& name) const {
        auto local = element.locals.find(name);
        if (local != element.locals.end()) return local->second;
        auto global = globals_.find(name);
        return global == globals_.end() ? UINT32_MAX : global->second;
    }

    /* A struct-shaped cell owns one of the run's struct slots: the cell's Value is the
     * handle, the fields live in that slot (spec 5.2). A flow temporary and a declared
     * struct variable differ only in kind and lifetime: a temporary's slot parks with
     * its run's frame, a variable's is stable storage. */
    uint32_t add_struct_cell(CellKind kind, uint64_t owner_node, uint64_t flow_id,
                             uint64_t node_id, const std::string& name, uint16_t type_id) {
        CellDef cell;
        cell.kind = kind;
        cell.owner_node = owner_node;
        cell.owner_flow = flow_id;
        cell.node_id = node_id;
        cell.decl = node_id;
        cell.name = name;
        cell.shape = Shape::Struct;
        cell.type_id = type_id;
        cell.struct_slot = static_cast<uint32_t>(program_.structs.size());
        program_.structs.push_back(type_id);
        /* declared slots all precede the first temporary (cells build before any
           flow compiles), which is what keeps the partition a single boundary */
        if (kind != CellKind::Temp)
            program_.layout.state_structs =
                static_cast<uint32_t>(program_.structs.size());
        program_.layout.max_struct_fields = std::max<uint32_t>(
            program_.layout.max_struct_fields,
            static_cast<uint32_t>(struct_fields(program_, type_id).size()));
        program_.cells.push_back(std::move(cell));
        return static_cast<uint32_t>(program_.cells.size() - 1);
    }

    uint32_t add_temp_cell(uint64_t flow_id, uint64_t node_id, const std::string& name,
                           Shape shape) {
        CellDef cell;
        cell.kind = CellKind::Temp;
        cell.owner_node = node_id;
        cell.owner_flow = flow_id;
        cell.name = name;
        cell.shape = shape;
        if (shape == Shape::Text) {
            cell.text_slot = program_.layout.cell_texts++;
            cell.text_cap = 256;
        }
        program_.cells.push_back(std::move(cell));
        return static_cast<uint32_t>(program_.cells.size() - 1);
    }

    /* A TIMER RESOLVES THE WAY EVERY OTHER NAME DOES: this element's own, then the
     * enclosing elements' from the inside out, then the globals. `tmr_start blink` from a
     * child of the element that declared `blink` has to mean the same timer the child's
     * expressions read as `blink.running`, or the two halves of one variable would
     * disagree about which one it is. */
    int resolve_timer(const ElementInfo& element, const std::string& name,
                      uint64_t node, bool in_component = false) {
        /* inside a component NOTHING of the page is in scope, timers included: a
           component that could start the page's timer would not be portable either */
        if (in_component) {
            diag(node, "timer",
                 "timer '" + name + "' is unresolved" + std::string(kIsolatedHelp));
            return -1;
        }
        const std::vector<const ElementInfo*> chain = lexical_chain(element);
        for (auto at = chain.rbegin(); at != chain.rend(); ++at) {
            auto local = (*at)->timers.find(name);
            if (local != (*at)->timers.end()) return static_cast<int>(local->second);
        }
        auto global = global_timers_.find(name);
        if (global != global_timers_.end()) return static_cast<int>(global->second);
        diag(node, "timer", "timer '" + name + "' is unresolved");
        return -1;
    }

    /* ONE TRANSFER STEP (spec 2.6). The author names a source and a destination; which
     * mechanic that is, and which word the row shows, both follow. The destination is
     * read first because it decides what the source has to produce. */
    /* ONE transfer step: `<lvalue> = <expression>`. The rvalue is always an expression
     * (`{init:true}` the one special form: reset to the destination's own start); the
     * lvalue stays structural. Reading the mesh is naming it — `@entity.field` in the
     * rvalue — so there is no separate "read" form anymore. */
    bool compile_assign(const ElementInfo& element, const StepDecl& step, FlowProgram& flow,
                        Env& scope, FlowLocals& locals) {
        const uint64_t step_id = step.id;
        const FromDecl& from = step.from;
        const ToDecl& to = step.to;
        if (!from.has_any) {
            diag(step_id, "move_source", "this assignment has no value", DiagGrade::Error,
                 "from");
            return false;
        }

        /* THE TWO AGGREGATE WRITES (spec 2.6): `mode: append` puts one element on the
         * end of a list, `key` writes one key of a map. They are separate verbs because
         * they mean separate things — one grows a history, the other addresses a table —
         * and asking for both at once is asking for neither. */
        const std::string keep = trimmed(step.keep);
        const std::string key = trimmed(step.key);
        const bool appends = step.mode == "append";
        if (appends && !key.empty()) {
            diag(step_id, "move_mode",
                 "a move appends to a list OR writes a map by key, not both",
                 DiagGrade::Error, "key");
            return false;
        }
        if (!keep.empty() && !appends) {
            diag(step_id, "move_mode",
                 "keep bounds an APPEND; set mode to append, or clear keep",
                 DiagGrade::Error, "keep");
            return false;
        }

        const std::string& slot = to.slot;
        if (!slot.empty()) {
            auto found = element.slots.find(slot);
            if (found == element.slots.end()) {
                diag(step_id, "move_dest", "this instance has no slot '" + slot + "'",
                     DiagGrade::Error, "to");
                return false;
            }
            if (appends || !key.empty())
                return aggregate_assign(element, step, flow, scope, found->second, appends,
                                      keep, key);
            /* a LIST or MAP slot takes a whole aggregate here: this is an HMI cell,
               not a machine, so the one-scalar rule steps aside for exactly its shape */
            const Shape shape = program_.cells[found->second].shape;
            return push_scalar(element, step, flow, scope, from,
                               Dest{Type(shape), "this row", aggregate_shape(shape)}) &&
                   emit_store(flow, step_id, found->second);
        }

        if (to.has_local) {
            if (appends || !key.empty()) {
                const std::string& name = to.local;
                const std::string& path = to.path;
                uint32_t cell = UINT32_MAX;
                auto found = locals.find(name);
                if (found != locals.end()) cell = found->second;
                else cell = declared_cell(element, name);
                if (cell == UINT32_MAX) {
                    diag(step_id, "move_dest",
                         (appends ? "append writes into a list variable or a list slot; '"
                                  : "an element write needs a list or a map; '") +
                             name + "' is not declared",
                         DiagGrade::Error, "to");
                    return false;
                }
                reference(step_id, name, program_.cells[cell].decl);
                /* a struct value's AGGREGATE FIELD is its derived cell: the same
                   places a list variable takes, and the store itself refreshes the
                   owner's field handle */
                if (!path.empty()) {
                    const uint32_t derived =
                        resolve_field_cell(cell, name, path, step_id);
                    if (derived == UINT32_MAX) return false;
                    return aggregate_assign(element, step, flow, scope, derived, appends,
                                            keep, key);
                }
                return aggregate_assign(element, step, flow, scope, cell, appends, keep, key);
            }
            return assign_into_local(element, step, flow, scope, locals);
        }
        if (to.has_kind) {
            if (appends) {
                diag(step_id, "move_dest",
                     "a mesh entity takes no append; a list variable or a list slot "
                     "grows, and an array field takes one element at an index",
                     DiagGrade::Error, "to");
                return false;
            }
            /* a key on a mesh destination is an ELEMENT write into an array field;
               assign_out owns the field resolution, so the refusals can name it */
            return assign_out(element, step, flow, scope, locals);
        }
        diag(step_id, "move_dest", "this move has no destination", DiagGrade::Error, "to");
        return false;
    }

    /* is this destination an HMI aggregate — the one kind of place a wire expression may
     * yield a whole list or map into? */
    static bool aggregate_shape(Shape shape) {
        return shape == Shape::List || shape == Shape::Map;
    }

    /* APPEND, KEYED or INDEXED WRITE into an aggregate cell. All push the ELEMENT
     * first and the bound (keep) or the address (key / index) after it, because the VM
     * pops what was pushed last: one instruction shape, three verbs. The address rides
     * the step's one `key` field either way — a map addresses an entry by text key, a
     * list a position by number index.
     *
     * THE SOURCE IS ONE ELEMENT: the destination handed to the pipeline is the cell's
     * own element declaration (Dest with `element` set), so the fit refusal names the
     * list, says what it holds, and teaches the declaration that would take what the
     * author wrote. */
    bool aggregate_assign(const ElementInfo& element, const StepDecl& step, FlowProgram& flow,
                        Env& scope, uint32_t cell, bool appends,
                        const std::string& keep, const std::string& key) {
        const uint64_t step_id = step.id;
        const FromDecl& from = step.from;
        const CellDef& def = program_.cells[cell];
        if (appends && def.shape != Shape::List) {
            diag(step_id, "move_dest",
                 "'" + def.name + "' is " + shape_name(def.shape) +
                     "; append writes into a list variable or a list slot",
                 DiagGrade::Error, "to");
            return false;
        }
        if (!appends && def.shape != Shape::Map && def.shape != Shape::List) {
            diag(step_id, "move_dest",
                 "'" + def.name + "' is " + shape_name(def.shape) +
                     "; an element write addresses a list by index or a map by key",
                 DiagGrade::Error, "to");
            return false;
        }
        const bool indexed = !appends && def.shape == Shape::List;
        /* THE ELEMENT is the destination, and what one element IS is the cell's own
         * declaration: a scalar where the elements are scalars, a whole row where
         * they are declared list or map. The destination rides into the pipeline as
         * data, so the fit refusal can name the list, say what it holds, and teach
         * the declaration that would take what the author is holding — an author
         * appending a row wants to hear about `elem`, not that a wire value is one
         * scalar. */
        Dest one;
        one.type = def.elem == Shape::List || def.elem == Shape::Map
                       ? Type::list_of(def.elem, def.leaf)
                       : Type(def.elem);
        one.label = "'" + def.name + "'";
        one.element = true;
        one.append = appends;
        if (!push_scalar(element, step, flow, scope, from, one)) return false;
        if (appends) {
            /* the bound is compiled ON TOP of the element already on the stack, so its
               own depth is one deeper than the expression alone would need */
            uint32_t bound_stack = 1;
            if (keep.empty()) {
                Instruction nothing;
                nothing.op = OpCode::Const;
                nothing.a = program_.add_constant(Value::nil());
                nothing.c = fault_site(step_id, "move_store",
                                       "the append bound could not be read");
                flow.body.code.push_back(nothing);
                flow.body.max_stack = std::max(flow.body.max_stack, 2u);
            } else {
                if (!expression(step_id, keep, ExprTier::Wire, scope,
                                Dest{Type(Shape::Num)}, flow.body.code, bound_stack,
                                nullptr, "keep"))
                    return false;
                flow.body.max_stack = std::max(flow.body.max_stack, bound_stack + 1);
                /* a COURTESY check: a keep the folder can read that is past what a buffer
                   can hold at all is not an error (the list simply holds what fits), but
                   it is not what the author asked for either. The bound is BYTES now, so
                   this speaks in the elements those bytes buy for this cell. */
                double window = 0.0;
                const uint32_t fits = buffer_capacity(def.elem);
                if (fold_number(element, keep, window) &&
                    window > static_cast<double>(fits))
                    diag(step_id, "keep_bound",
                         "keep is " + std::to_string(static_cast<long long>(window)) +
                             "; one buffer holds " + std::to_string(fits) +
                             " elements of this type, so it keeps the last " +
                             std::to_string(fits),
                         DiagGrade::Warning, "keep");
            }
            Instruction ins;
            ins.op = OpCode::Store;
            ins.small = store_small(StorePlace::Cell, StoreMode::Append);
            ins.a = cell;
            ins.c = fault_site(
                step_id, "append",
                keep.empty()
                    ? "list '" + def.name +
                          "' filled its buffer; add keep to bound what it holds"
                    : "'" + def.name +
                          "' could not append: an append takes ONE element that fits the "
                          "list, and a keep that is not a number leaves the list growing "
                          "until its buffer is full");
            flow.body.code.push_back(ins);
            return true;
        }
        /* likewise: the address rides above the value the write is carrying — a map's
           text key, or a list's number index */
        uint32_t key_stack = 1;
        if (!expression(step_id, key, ExprTier::Wire, scope,
                        Dest{Type(indexed ? Shape::Num : Shape::Text)}, flow.body.code,
                        key_stack, nullptr, "key"))
            return false;
        flow.body.max_stack = std::max(flow.body.max_stack, key_stack + 1);
        Instruction ins;
        ins.op = OpCode::Store;
        ins.a = cell;
        if (indexed) {
            ins.small = store_small(StorePlace::Elem, StoreMode::Assign);
            ins.c = fault_site(
                step_id, "store_index",
                "'" + def.name + "' did not take the element: the index must land "
                "inside the list (an element write edits, it never grows), and the "
                "element must fit the list");
        } else {
            ins.small = store_small(StorePlace::Key, StoreMode::Assign);
            ins.c = fault_site(step_id, "store_key",
                               "map '" + def.name +
                                   "' needs a text key, a value that fits it, and room in "
                                   "its buffer (a map has no keep, so it only grows)");
        }
        flow.body.code.push_back(ins);
        return true;
    }

    bool emit_store(FlowProgram& flow, uint64_t step_id, uint32_t cell) {
        Instruction store;
        store.op = OpCode::Store;
        store.a = cell;
        store.c = fault_site(step_id, "move_store", "the value could not be stored");
        flow.body.code.push_back(store);
        return true;
    }

    /* Put ONE value on the stack from an assignment's rvalue. The rvalue is always an
     * EXPRESSION now — a mesh read is `@name` / `@name.field`, bound into the flow's
     * scope by bind_entities — so this is one compile, one vocabulary, one typed
     * destination riding in as data. */
    bool push_scalar(const ElementInfo& element, const StepDecl& step, FlowProgram& flow,
                     Env& scope, const FromDecl& from, const Dest& dest,
                     Shape* actual = nullptr) {
        (void)element;
        if (from.has_expr)
            return expression(step.id, from.expr_text ? from.expr : "x", ExprTier::Wire,
                              scope, dest, flow.body.code, flow.body.max_stack, actual,
                              "from");
        diag(step.id, "move_source", "this assignment has no value", DiagGrade::Error,
             "from");
        return false;
    }

    /* `-> local`: the destination names a variable in scope, or declares a temporary by
     * using it (spec 2.7). A whole-struct destination is filled by New or ReadEnt;
     * everything else is one Store at its place. */
    bool assign_into_local(const ElementInfo& element, const StepDecl& step, FlowProgram& flow,
                         Env& scope, FlowLocals& locals) {
        const uint64_t step_id = step.id;
        const FromDecl& from = step.from;
        const ToDecl& to = step.to;
        const std::string& name = to.local;
        const std::string& path = to.path;
        if (name.empty()) {
            diag(step_id, "move_dest", "this move has no destination", DiagGrade::Error, "to");
            return false;
        }

        /* RESET (spec 2.6): the source `{init}` is the destination's own declared
           start. A struct variable re-runs its New (zero + authored defaults); a
           scalar or enum takes its init constant back. */
        if (from.has_init) {
            uint32_t cell = UINT32_MAX;
            auto found = locals.find(name);
            if (found != locals.end()) cell = found->second;
            else cell = declared_cell(element, name);
            if (name == "x" || cell == UINT32_MAX) {
                diag(step_id, "move_source",
                     "'" + name + "' has no declared start to reset to",
                     DiagGrade::Error, "to");
                return false;
            }
            reference(step_id, name, program_.cells[cell].decl);
            const CellDef& def = program_.cells[cell];
            if (def.shape == Shape::Timer) {
                diag(step_id, "move_source", "a timer is started and cancelled, not reset",
                     DiagGrade::Error, "to");
                return false;
            }
            if (def.shape == Shape::Struct) {
                Instruction zero;
                zero.op = OpCode::New;
                zero.a = cell;
                zero.b = def.type_id;
                zero.c = fault_site(step_id, "move_new", "the value could not be created");
                flow.body.code.push_back(zero);
                return true;
            }
            Instruction constant;
            constant.op = OpCode::Const;
            constant.a = program_.add_constant(def.initial);
            constant.c = fault_site(step_id, "move_source", "the default could not be read");
            flow.body.code.push_back(constant);
            flow.body.max_stack = std::max(flow.body.max_stack, 1u);
            return emit_store(flow, step_id, cell);
        }

        /* A TYPED temporary (spec 2.7): the destination carries a TypeRef, so a FRESH
           name is declared here with that type and zeroed at THIS ROW every run: the
           per-run clean value a persistent variable cannot be. On a name that already
           exists the type is a claim to check, never a redeclaration. */
        const std::string& typed = to.type;
        if (!typed.empty() && name != "x") {
            const int type_id = find_type_ref(typed);
            if (type_id < 0) {
                diag(step_id, "unresolved_type",
                     "type '" + typed + "' is not a type in the mesh",
                     DiagGrade::Error, "to");
                return false;
            }
            const bool fresh = locals.find(name) == locals.end() &&
                               declared_cell(element, name) == UINT32_MAX;
            if (fresh && program_.types[type_id].kind == TypeKind::Enum) {
                const uint32_t cell = add_temp_cell(flow.flow_id, element.id, name,
                                                    Shape::Enum);
                program_.cells[cell].type_id = static_cast<uint16_t>(type_id);
                locals[name] = cell;
                scope.bind_value(name,
                                 Place{Type(Shape::Enum, static_cast<uint16_t>(type_id)),
                                       OpCode::Load, cell, 0});
            } else if (fresh) {
                const uint32_t cell = ensure_struct_local(element, flow, locals, scope,
                                                          name, static_cast<uint16_t>(type_id),
                                                          step_id);
                if (cell == UINT32_MAX) return false;
                Instruction zero;
                zero.op = OpCode::New;
                zero.a = cell;
                zero.b = static_cast<uint32_t>(type_id);
                zero.c = fault_site(step_id, "move_new", "the value could not be created");
                flow.body.code.push_back(zero);
            } else {
                const uint32_t held = locals.count(name) ? locals[name]
                                                         : declared_cell(element, name);
                if (program_.cells[held].type_id != type_id) {
                    diag(step_id, "type_mismatch",
                         "'" + name + "' does not hold a " + type_name_of(
                             static_cast<uint16_t>(type_id)),
                         DiagGrade::Error, "to");
                    return false;
                }
            }
        }

        /* `-> x`: the pipeline register, which the guards read. It is a local in the
           document's vocabulary and a register in the VM's, and the two agree because
           nothing else may name it. */
        if (name == "x" && path.empty()) {
            Shape produced = Shape::Unknown;
            uint16_t produced_type = 0;
            if (!expression(step_id, from.expr_text ? from.expr : "x", ExprTier::Wire,
                            scope, Dest{}, flow.body.code, flow.body.max_stack, &produced,
                            "from", &produced_type)) {
                return false;
            }
            flow.body.code.push_back(Instruction{OpCode::StoreX});
            bind_x(scope, produced, produced_type);
            return true;
        }

        /* A field of a struct value: the holder must already exist (a temporary above
           this row, or a declared struct variable), because a field write says nothing
           about what type the whole value is. */
        if (!path.empty()) {
            uint32_t cell = UINT32_MAX;
            auto found = locals.find(name);
            if (found != locals.end()) cell = found->second;
            else cell = declared_cell(element, name);
            if (cell == UINT32_MAX) {
                diag(step_id, "move_dest",
                     "'" + name + "' has no value yet at this row", DiagGrade::Error, "to");
                return false;
            }
            reference(step_id, name, program_.cells[cell].decl);
            if (program_.cells[cell].shape != Shape::Struct) {
                diag(step_id, "move_dest",
                     "'" + name + "' is " + shape_name(program_.cells[cell].shape) +
                         ", which has no fields",
                     DiagGrade::Error, "to");
                return false;
            }
            const uint16_t type_id = program_.cells[cell].type_id;
            const std::vector<FieldDef>& fields = struct_fields(program_, type_id);
            int field = -1;
            for (uint32_t i = 0; i < fields.size(); ++i)
                if (fields[i].path == path) field = static_cast<int>(i);
            if (field < 0) {
                diag(step_id, "unresolved_field",
                     "'" + type_name_of(type_id) + "' has no field '" + path + "'",
                     DiagGrade::Error, "to");
                return false;
            }
            /* an AGGREGATE field of a struct value is its derived cell: a whole list
               or map lands there exactly as it lands in a declared list variable —
               the one-scalar rule steps aside for a declared HMI aggregate — and the
               store refreshes the field handle a move out reads */
            if (fields[field].shape == Shape::List || fields[field].shape == Shape::Map) {
                const uint32_t derived = field_cell(cell, static_cast<uint32_t>(field));
                if (derived == UINT32_MAX) {
                    diag(step_id, "move_dest",
                         "'" + name + "." + path + "' has no storage in this program",
                         DiagGrade::Error, "to");
                    return false;
                }
                return push_scalar(element, step, flow, scope, from,
                                   Dest{Type(fields[field].shape), "this row",
                                        /*aggregate_ok=*/true}) &&
                       emit_store(flow, step_id, derived);
            }
            if (!push_scalar(element, step, flow, scope, from,
                             Dest{Type(fields[field].shape, fields[field].type_id)}))
                return false;
            Instruction set;
            set.op = OpCode::Store;
            set.small = store_small(StorePlace::Field, StoreMode::Assign);
            set.a = cell;
            set.b = static_cast<uint32_t>(field);
            set.c = fault_site(step_id, "move_field", "the field could not be set");
            flow.body.code.push_back(set);
            return true;
        }

        /* A whole-entity read produces a STRUCT: the local takes that type, which is
           what "a temporary is typed by what is first moved into it" means. The
           spelling is the degenerate expression — the rvalue is EXACTLY `@name` and
           the entity is a fielded one — recognized here because a struct is not a
           stack value the expression VM could carry. (Starting from a zeroed value is
           not a step: declare a variable with the type, and it is born zeroed.) */
        uint16_t struct_type = 0;
        int read_entity = -1;
        {
            const std::string expr = trimmed(from.expr);
            if (expr.size() > 1 && expr[0] == '@' &&
                expr.find('.') == std::string::npos) {
                const std::string ename = expr.substr(1);
                for (uint32_t e = 0; e < program_.entities.size(); ++e) {
                    if (program_.entities[e].name != ename) continue;
                    if (program_.entities[e].fields.size() > 1 ||
                        program_.entities[e].type_id != 0) {
                        read_entity = static_cast<int>(e);
                        struct_type = program_.entities[e].type_id;
                    }
                    break;
                }
            }
        }

        if (struct_type != 0) {
            const uint32_t cell = ensure_struct_local(element, flow, locals, scope, name,
                                                      struct_type, step_id);
            if (cell == UINT32_MAX) return false;
            reference(step_id, name, program_.cells[cell].decl);
            Instruction ins;
            ins.op = OpCode::ReadEnt;
            ins.a = cell;
            ins.b = static_cast<uint32_t>(read_entity);
            ins.c = fault_site(step_id, "move_new", "the value could not be created");
            flow.body.code.push_back(ins);
            /* each AGGREGATE field's copy compiles beside the read: the entity's
               cached mirror, stored whole into the field's derived cell — Nil where
               the cache has never held one, which leaves the field UNKNOWN so a move
               out keeps the owner's bytes rather than zeroing the machine's array */
            const std::vector<FieldDef>& fields = struct_fields(program_, struct_type);
            for (uint32_t i = 0; i < fields.size(); ++i) {
                if (fields[i].shape != Shape::List && fields[i].shape != Shape::Map)
                    continue;
                const uint32_t derived = field_cell(cell, i);
                if (derived == UINT32_MAX) continue;
                Instruction mirror;
                mirror.op = OpCode::Load;
                mirror.small = static_cast<uint16_t>(LoadPlace::Entity);
                mirror.a = static_cast<uint32_t>(read_entity);
                mirror.b = i;
                mirror.c = fault_site(step_id, "move_new",
                                      "the entity's cached elements could not be read");
                flow.body.code.push_back(mirror);
                flow.body.max_stack = std::max(flow.body.max_stack, 1u);
                Instruction land;
                land.op = OpCode::Store;
                land.a = derived;
                land.c = fault_site(
                    step_id, "move_new",
                    "'" + name + "." + fields[i].path +
                        "' could not take the entity's cached elements");
                flow.body.code.push_back(land);
            }
            return true;
        }

        /* a scalar destination: an existing variable keeps its declared shape, a fresh
           temporary takes the source's */
        uint32_t cell = declared_cell(element, name);
        Shape wanted = cell == UINT32_MAX ? Shape::Unknown : program_.cells[cell].shape;
        if (cell == UINT32_MAX) {
            auto found = locals.find(name);
            if (found != locals.end()) {
                cell = found->second;
                wanted = program_.cells[cell].shape;
            }
        }
        /* a DECLARED destination goes through the typed path, so an enum variable
           resolves `.variant` against its own vocabulary and a text variable takes
           an enum (rendered as its name), exactly like the same-shaped fields do. A
           declared LIST or MAP variable takes a whole aggregate — an HMI cell, not a
           machine. */
        if (cell != UINT32_MAX) {
            reference(step_id, name, program_.cells[cell].decl);
            if (!push_scalar(element, step, flow, scope, from,
                             Dest{Type(wanted, program_.cells[cell].type_id), "this row",
                                  aggregate_shape(wanted)}))
                return false;
            return emit_store(flow, step_id, cell);
        }
        Shape produced = Shape::Unknown;
        const size_t mark = flow.body.code.size();
        if (!push_scalar(element, step, flow, scope, from, Dest{}, &produced)) return false;
        if (cell == UINT32_MAX) {
            if (produced == Shape::Unknown || produced == Shape::Nil) {
                diag(step_id, "temp_shape",
                     "'" + name + "' cannot take its type from this source; "
                     "declare it as a variable",
                     DiagGrade::Error, "to");
                flow.body.code.resize(mark);
                return false;
            }
            cell = add_temp_cell(flow.flow_id, element.id, name, produced);
            locals[name] = cell;
            scope.bind_value(name, Place{Type(produced), OpCode::Load, cell, 0});
            /* the declaring write itself: decl 0 (a temp is nobody's variable), so a
               rename never rewrites it — and the verify reads that stability */
            reference(step_id, name, 0);
        }
        return emit_store(flow, step_id, cell);
    }

    /* `-> entity`: the one way a value leaves a flow. The verb comes from the kind. */
    bool assign_out(const ElementInfo& element, const StepDecl& step, FlowProgram& flow,
                  Env& scope, FlowLocals& locals) {
        const uint64_t step_id = step.id;
        const FromDecl& from = step.from;
        const ToDecl& to = step.to;
        const int entity = resolve_entity(to, step_id, "to");
        if (entity < 0) return false;
        const EntityDef& target = program_.entities[entity];
        const Verb verb = verb_for(target.kind, step.mode);
        if (verb == Verb::Unforce && target.kind != EntityKind::Variable) {
            diag(step_id, "move_mode", "only a variable can be unforced", DiagGrade::Error, "to");
            return false;
        }
        if (verb == Verb::Cancel && !target.cancellable) {
            diag(step_id, "move_mode",
                 "task '" + target.name + "' declares no cancel; it runs to completion",
                 DiagGrade::Error, "to");
            return false;
        }

        Instruction out;
        out.op = OpCode::Send;
        out.a = static_cast<uint32_t>(entity);
        out.b = 0;
        out.small = send_small(SendTarget::Entity, static_cast<uint8_t>(verb));
        out.c = fault_site(step_id, "assign_out", "UNKNOWN was not sent");

        /* unforce and cancel address the ENTITY's standing state, not a value: the
           send is the whole of the step, so no field and no source */
        if (verb == Verb::Unforce || verb == Verb::Cancel) {
            out.b = UINT32_MAX;
            flow.body.code.push_back(out);
            ++program_.layout.effect_capacity;
            return true;
        }

        /* a PARAMETERLESS target (a function or task whose request has no fields):
           the send itself is the whole message, so no field and no source are
           required — the schema's default (empty) request goes out.
           b = UINT32_MAX tells the VM to emit without popping a value. */
        if (target.fields.empty() && to.path.empty() &&
            (target.kind == EntityKind::Function || target.kind == EntityKind::Task)) {
            out.b = UINT32_MAX;
            flow.body.code.push_back(out);
            ++program_.layout.effect_capacity;
            return true;
        }

        /* a whole struct goes out as the message; anything else fills one field. The
           holder is a flow temporary or a declared struct variable, spelled as the
           degenerate expression — the rvalue is EXACTLY its bare name (a struct is
           not a stack value, so the whole-value send is recognized here). */
        const std::string source_local = bare_name(from.expr);
        uint32_t held_cell = UINT32_MAX;
        if (!source_local.empty()) {
            auto held = locals.find(source_local);
            if (held != locals.end()) held_cell = held->second;
            else held_cell = declared_cell(element, source_local);
        }
        const bool whole = held_cell != UINT32_MAX &&
                           program_.cells[held_cell].shape == Shape::Struct;
        if (whole)
            /* the degenerate expression never reaches the expression compiler, so its
               one name records here — spanned where it sits in the authored text */
            program_.references.push_back(
                RefRow{step_id, from.expr, from.expr.find(source_local),
                       source_local.size(), program_.cells[held_cell].decl});
        if (whole) {
            if (!trimmed(step.key).empty()) {
                diag(step_id, "move_dest",
                     "a whole value goes out unaddressed; an index addresses one "
                     "array field",
                     DiagGrade::Error, "key");
                return false;
            }
            const uint32_t cell = held_cell;
            if (program_.cells[cell].type_id != target.type_id) {
                diag(step_id, "type_mismatch",
                     "'" + type_name_of(program_.cells[cell].type_id) + "' does not fit " +
                         entity_kind_name(target.kind) + ":" + target.name,
                     DiagGrade::Error, "from");
                return false;
            }
            Instruction load;
            load.op = OpCode::Load;
            load.a = cell;
            load.c = fault_site(step_id, "assign_out", "the value could not be read");
            flow.body.code.push_back(load);
            flow.body.max_stack = std::max(flow.body.max_stack, 1u);
        } else {
            const int field = find_field(entity, to.path, step_id, "to");
            if (field < 0) {
                if (target.fields.size() > 1)
                    diag(step_id, "move_dest",
                         std::string(entity_kind_name(target.kind)) + ":" + target.name +
                             " has " + std::to_string(target.fields.size()) +
                             " fields; pick one, or move a whole value of its type",
                         DiagGrade::Error, "to");
                return false;
            }
            /* AN ARRAY FIELD TAKES ONE ELEMENT AT AN INDEX (the step's `key`): the
               encode rewrites that element over the owner's own bytes, so the rest of
               the array rides through the RMW untouched. Whole-aggregate writes and
               map fields stay refused — the encode never builds those, so a value
               pushed there would be dropped without a trace. */
            const FieldDef& fdef = target.fields[field];
            const std::string key = trimmed(step.key);
            if (fdef.shape == Shape::Map) {
                diag(step_id, "move_dest",
                     std::string(entity_kind_name(target.kind)) + ":" + target.name +
                         "." + fdef.path +
                         " is a map field, which a mesh write cannot address",
                     DiagGrade::Error, "to");
                return false;
            }
            if (fdef.shape == Shape::List) {
                /* the WHOLE ARRAY: a list expression's elements pack over the RMW
                   base at the encode. Bounds are the schema's — a fixed array takes
                   at most its count (the rest zero), a variable one becomes exactly
                   the list. */
                if (key.empty()) {
                    if (verb != Verb::Write && verb != Verb::Publish &&
                        verb != Verb::Call) {
                        diag(step_id, "move_mode", "an array is written, never forced",
                             DiagGrade::Error, "to");
                        return false;
                    }
                    if (!push_scalar(element, step, flow, scope, from,
                                     Dest{Type(Shape::List), "this row",
                                          /*aggregate_ok=*/true}))
                        return false;
                    out.b = static_cast<uint32_t>(field);
                    flow.body.code.push_back(out);
                    ++program_.layout.effect_capacity;
                    return true;
                }
                if (target.kind != EntityKind::Variable &&
                    target.kind != EntityKind::Topic) {
                    diag(step_id, "move_dest",
                         std::string(target.kind == EntityKind::Function
                                         ? "a function's" : "a task's") +
                             " arguments are sent whole with the call; an element "
                             "write addresses a topic's or a variable's array",
                         DiagGrade::Error, "to");
                    return false;
                }
                if (verb != Verb::Write && verb != Verb::Publish) {
                    diag(step_id, "move_mode",
                         "an array element is written, never forced",
                         DiagGrade::Error, "to");
                    return false;
                }
                if (!push_scalar(element, step, flow, scope, from, Dest{Type(fdef.elem)}))
                    return false;
                uint32_t key_stack = 1;
                if (!expression(step_id, key, ExprTier::Wire, scope,
                                Dest{Type(Shape::Num)}, flow.body.code, key_stack,
                                nullptr, "key"))
                    return false;
                flow.body.max_stack = std::max(flow.body.max_stack, key_stack + 1);
                out.small = send_small(SendTarget::Elem, static_cast<uint8_t>(verb));
                out.b = static_cast<uint32_t>(field);
                out.c = fault_site(step_id, "assign_out",
                                   "@" + target.name + "." + fdef.path +
                                       " did not take the element: the index must be a "
                                       "whole number inside the owner's array");
                flow.body.code.push_back(out);
                ++program_.layout.effect_capacity;
                return true;
            }
            if (!key.empty()) {
                diag(step_id, "move_dest",
                     std::string(entity_kind_name(target.kind)) + ":" + target.name +
                         "." + fdef.path +
                         " is a scalar field; an index addresses an array",
                     DiagGrade::Error, "key");
                return false;
            }
            if (!push_scalar(element, step, flow, scope, from,
                             Dest{Type(fdef.shape, fdef.type_id)}))
                return false;
            out.b = static_cast<uint32_t>(field);
        }
        flow.body.code.push_back(out);
        ++program_.layout.effect_capacity;
        (void)element;
        return true;
    }

    /* Declare (or find) a struct-holding destination and put its fields in scope, so a
     * later row can read `m.position` the way it reads any other name. A declared
     * struct variable of the same type is a legal destination (that is how a value is
     * staged across flows, spec 2.7); a declared variable of any other type is a
     * finding rather than a coercion. */
    uint32_t ensure_struct_local(const ElementInfo& element, FlowProgram& flow,
                                 FlowLocals& locals, Env& scope,
                                 const std::string& name, uint16_t type_id, uint64_t step_id) {
        auto found = locals.find(name);
        if (found != locals.end()) {
            const CellDef& cell = program_.cells[found->second];
            if (cell.shape != Shape::Struct || cell.type_id != type_id) {
                diag(step_id, "temp_shape",
                     "'" + name + "' already holds a " + shape_name(cell.shape) +
                         " in this flow",
                     DiagGrade::Error, "to");
                return UINT32_MAX;
            }
            return found->second;
        }
        const uint32_t declared = declared_cell(element, name);
        if (declared != UINT32_MAX) {
            const CellDef& cell = program_.cells[declared];
            if (cell.shape != Shape::Struct || cell.type_id != type_id) {
                diag(step_id, "type_mismatch",
                     "'" + name + "' is a " +
                         (cell.shape == Shape::Struct ? type_name_of(cell.type_id)
                                                      : std::string(shape_name(cell.shape))) +
                         " variable; it cannot take a " + type_name_of(type_id),
                     DiagGrade::Error, "to");
                return UINT32_MAX;
            }
            locals[name] = declared;
            return declared;
        }
        const uint32_t cell =
            add_struct_cell(CellKind::Temp, element.id, flow.flow_id, 0, name, type_id);
        locals[name] = cell;
        add_field_cells(CellKind::Temp, element.id, flow.flow_id, name, cell);
        const std::vector<FieldDef>& fields = struct_fields(program_, type_id);
        for (uint32_t i = 0; i < fields.size(); ++i)
            scope.bind_field(name, fields[i].path,
                             Place{field_place_type(fields[i]), OpCode::Load, cell, i,
                                   static_cast<uint16_t>(LoadPlace::Field)});
        return cell;
    }

    int find_type(const std::string& name) const {
        for (uint32_t i = 1; i < program_.types.size(); ++i)
            if (program_.types[i].kind == TypeKind::Struct && program_.types[i].name == name)
                return static_cast<int>(i);
        return -1;
    }

    /* A full TypeRef (spec 2.2): a struct root by name, or `Root.path.to.field` for a
     * type that has no name of its own (an enum reached through a struct's field). */
    int find_type_ref(const std::string& text) const {
        const size_t dot = text.find('.');
        if (dot == std::string::npos) return find_type(text);
        const int root = find_type(text.substr(0, dot));
        if (root < 0) return -1;
        const std::string path = text.substr(dot + 1);
        for (const FieldDef& field : program_.types[root].fields)
            if (field.path == path && field.type_id) return field.type_id;
        return -1;
    }

    std::string type_name_of(uint16_t type_id) const {
        if (type_id >= program_.types.size()) return "?";
        const TypeDef& def = program_.types[type_id];
        return def.name.empty() ? std::string("this type") : def.name;
    }

    /* A CLAIMED slot's write, redirected into a run-local shadow so program order holds
     * within the flow (see the call site). Scalar shapes only: the write compiles
     * exactly as it would have — same coercions, same refusals — into a temp cell, and
     * `this.<slot>` rebinds to that cell for the steps below. An aggregate-shaped
     * slot (or an append/key write) still stands down whole: a shadow list is storage
     * this run has no business allocating. */
    bool shadow_slot_write(const ElementInfo& element, const StepDecl& step, FlowProgram& flow,
                           Env& scope, const std::string& slot) {
        const uint64_t step_id = step.id;
        auto found = element.slots.find(slot);
        if (found == element.slots.end()) return true;   /* claimed name, no cell: drop */
        const CellDef& def = program_.cells[found->second];
        if (def.shape == Shape::List || def.shape == Shape::Map || step.mode == "append" ||
            !trimmed(step.key).empty())
            return true;                                /* aggregate: plain stand-down */
        if (!push_scalar(element, step, flow, scope, step.from,
                         Dest{Type(def.shape, def.type_id)}))
            return false;
        const uint32_t shadow =
            add_temp_cell(flow.flow_id, element.id, "this." + slot + "'", def.shape);
        program_.cells[shadow].type_id = def.type_id;
        if (!emit_store(flow, step_id, shadow)) return false;
        scope.bind_field("this", slot,
                         Place{Type(def.shape, def.type_id), OpCode::Load, shadow, 0});
        return true;
    }

    /* `raise <event>(args)`: the one step that SPEAKS as the instance. The event must be
     * one the type declares — a gesture is the pointer's to raise — and the argument
     * expression compiles against the declared parameter's shape. The record queues on
     * the state; the scheduler dispatches it after this run halts. */
    bool compile_raise(const ElementInfo& element, const StepDecl& step, FlowProgram& flow,
                       Env& scope) {
        const uint64_t step_id = step.id;
        const std::string name = trimmed(step.event);
        if (name.empty()) {
            diag(step_id, "raise_event", "raise names no event", DiagGrade::Error, "event");
            return false;
        }
        if (gesture_event(name)) {
            diag(step_id, "raise_event",
                 "'" + name + "' is a gesture; a gesture is the pointer's to raise. "
                 "Declare an event of your own in the events section",
                 DiagGrade::Error, "event");
            return false;
        }
        /* a reference into specs_, which never grows after construction */
        const EventDecl* row = nullptr;
        if (element.type)
            for (const EventDecl& r : element.type->events)
                if (r.name == name) { row = &r; break; }
        if (!row) {
            diag(step_id, "raise_event",
                 "this type declares no event '" + name +
                     "'; declare it in the events section first",
                 DiagGrade::Error, "event");
            return false;
        }
        if (row->params.size() > 1) {
            diag(step_id, "raise_event",
                 "'" + name + "' declares " + std::to_string(row->params.size()) +
                     " parameters; an event carries one for now",
                 DiagGrade::Error, "event");
            return false;
        }
        bool has_arg = false;
        if (row->params.size() == 1) {
            const std::string& pname = row->params[0].name;
            const Shape shape = shape_from_name(row->params[0].shape);
            auto arg = step.args.find(pname);
            const std::string text = arg == step.args.end() ? "" : trimmed(arg->second);
            if (text.empty()) {
                diag(step_id, "raise_args",
                     "raise " + name + " needs " + pname, DiagGrade::Error, "args");
                return false;
            }
            if (!expression(step_id, text, ExprTier::Wire, scope, Dest{Type(shape)},
                            flow.body.code, flow.body.max_stack, nullptr, "args"))
                return false;
            has_arg = true;
        }
        uint32_t at = UINT32_MAX;
        for (uint32_t i = 0; i < program_.raises.size(); ++i)
            if (program_.raises[i].node_id == element.id &&
                program_.raises[i].event == name)
                at = i;
        if (at == UINT32_MAX) {
            program_.raises.push_back(RaiseDef{element.id, name});
            at = static_cast<uint32_t>(program_.raises.size() - 1);
        }
        Instruction ins;
        ins.op = OpCode::Send;
        ins.small = send_small(SendTarget::Self, 0);
        ins.a = at;
        ins.b = has_arg ? 1 : 0;
        ins.c = fault_site(step_id, "raise",
                           "the raise queue is full (events kept raising each other)");
        flow.body.code.push_back(ins);
        ++program_.layout.raise_capacity;
        return true;
    }

    /* `notify <text> [for <ms>]`: pop a notification up on every connected view. The
     * message is a DISPLAY-tier expression — it is for a human, so text joining and the
     * formatting vocabulary are exactly what it is made of — and `ms`, when authored,
     * is how long it stays; absent, the view scales the time with the length. */
    bool compile_notify(const StepDecl& step, FlowProgram& flow, Env& scope) {
        const uint64_t step_id = step.id;
        const std::string text = trimmed(step.text);
        if (text.empty()) {
            diag(step_id, "notify_text", "notify says nothing; give it a message",
                 DiagGrade::Error, "text");
            return false;
        }
        Shape actual = Shape::Unknown;
        if (!expression(step_id, text, ExprTier::Display, scope, Dest{},
                        flow.body.code, flow.body.max_stack, &actual, "text"))
            return false;
        if (actual == Shape::List || actual == Shape::Map) {
            diag(step_id, "notify_text",
                 "a notification is one line of text, not a " +
                     std::string(shape_name(actual)),
                 DiagGrade::Error, "text");
            return false;
        }
        const std::string ms = trimmed(step.ms);
        if (!ms.empty() &&
            !expression(step_id, ms, ExprTier::Display, scope, Dest{Type(Shape::Num)},
                        flow.body.code, flow.body.max_stack, nullptr, "ms"))
            return false;
        Instruction ins;
        ins.op = OpCode::Send;
        ins.small = send_small(SendTarget::System, 0);
        ins.b = ms.empty() ? 0 : 1;
        ins.c = fault_site(step_id, "notify", "notify needs a message it can render");
        flow.body.code.push_back(ins);
        ++program_.layout.notice_capacity;
        return true;
    }

    /* `param` is the trigger's signature (null = a nullary event); `claimed` is set for
     * TYPE BEHAVIOR: a slot-writing step whose slot is already claimed (a feed, an
     * authored flow) is DROPPED — per step, so the raise beside it still runs and a fed
     * control still speaks `changed` while standing down its local echo. */
    bool compile_steps(const ElementInfo& element, const FlowDecl& flow_node, FlowProgram& flow,
                       const EventParam* param = nullptr,
                       const std::unordered_map<std::string, std::string>* claimed = nullptr,
                       bool in_component = false, const std::string& copyless = "") {
        Env scope = in_component ? behavior_scope_for(element, Shape::Unknown)
                                             : scope_for(element, Shape::Unknown);
        /* `repeat` reads where an EVENT drove the run and carried the copy with it, and
           is refused by name where the trigger is a clock */
        if (copyless.empty()) bind_repeat(scope);
        else refuse_repeat(scope, copyless);
        /* the mesh, under its '@' spellings: a flow's rvalue or guard reads an entity
           by naming it, exactly as a slot expression does (same binding, same VM read
           off the last-value cache / the aggregate mirrors). A component's behavior gets
           none of it — see behavior_scope_for. */
        if (in_component) scope.unknown_help = kIsolatedHelp;
        else bind_entities(scope);
        if (param)
            scope.bind_value(param->name,
                             Place{Type(param->shape), OpCode::Arg, 0, 0});
        FlowLocals locals;
        /* A BROKEN STEP SUPPRESSES ITSELF, NEVER ITS SIBLINGS (the same recovery rule
           the checker holds): later steps still ANALYZE — their findings report and
           their names join the index — while the flow as a whole refuses, so nothing
           half-compiled ever runs (every caller discards the body on false). Only the
           failing step itself is marked blind whole (empty text = every site it owns):
           whatever of it the compile never reached left no row. */
        bool ok = true;
        for (size_t row = 0; row < flow_node.steps.size(); ++row) {
            const StepDecl& step = flow_node.steps[row];
            const uint64_t step_id = step.id;
            const std::string& kind = step.kind;
            bool step_ok = true;
            if (kind == "assign") {
                if (claimed) {
                    const std::string& slot = step.to.slot;
                    if (!slot.empty() && claimed->find(slot) != claimed->end()) {
                        /* THE WRITE STILL HOLDS WITHIN THIS RUN. The claimed cell stays
                           the feed's, but program order must not lie: a later step
                           reading this.<slot> reads what this flow just wrote — the
                           store lands in a run-local SHADOW and the name follows it,
                           so `value = false; raise changed(this.value)` speaks false
                           on a fed instance instead of the fed value. An aggregate
                           write (append, key, list/map slot) still just stands down. */
                        if (shadow_slot_write(element, step, flow, scope, slot))
                            continue;
                        program_.reference_gaps.push_back(RefSite{step_id, ""});
                        ok = false;
                        continue;
                    }
                }
                step_ok = compile_assign(element, step, flow, scope, locals);
            } else if (kind == "raise") {
                step_ok = compile_raise(element, step, flow, scope);
            } else if (kind == "notify") {
                step_ok = compile_notify(step, flow, scope);
            } else if (kind == "gate") {
                const std::string condition =
                    step.a.kind == NumOrText::Kind::Text ? step.a.text : "";
                step_ok = expression(step_id, condition, ExprTier::Wire, scope,
                                     Dest{Type(Shape::Bool)}, flow.body.code,
                                     flow.body.max_stack);
                if (step_ok) {
                    /* THE GATE IS A LOWERING (stage 6d): unknown says so and halts,
                       false halts silently, true steps over both endings. The saying
                       Halt counts this site, which is how a gate on an UNKNOWN
                       condition reports that the flow did not run (the log drains
                       it) — the one unknown rule, in three jumps. */
                    const uint32_t site = fault_site(
                        step_id, "gate_unknown",
                        "this gate's condition is UNKNOWN, so the flow "
                        "did not run; guard with known(...) or give the "
                        "value a default with ??");
                    const uint32_t at = static_cast<uint32_t>(flow.body.code.size());
                    Instruction unknown{OpCode::JmpNil};
                    unknown.a = at + 3;
                    unknown.c = site;
                    flow.body.code.push_back(unknown);
                    Instruction untaken{OpCode::JmpFalse};
                    untaken.a = at + 4;
                    untaken.c = site;
                    flow.body.code.push_back(untaken);
                    Instruction over{OpCode::Jmp};
                    over.a = at + 5;
                    over.c = site;
                    flow.body.code.push_back(over);
                    Instruction say{OpCode::Halt};
                    say.small = 1;
                    say.a = site;
                    flow.body.code.push_back(say);
                    flow.body.code.push_back(Instruction{OpCode::Halt});
                }
            } else if (kind == "deadband" || kind == "throttle") {
                /* THE SITE FILTERS ARE LOWERINGS (stage 6d) over one hidden cell:
                   probe the watched quantity, compare it to the site's memory, halt
                   inside the band (or the period), and remember the probe on the way
                   through. The first run finds the memory UNKNOWN — the compare
                   yields Nil and JmpNil steps to the store — so "never armed yet"
                   needs no sentinel. A non-numeric probe rides the same road:
                   unknown propagates and the flow RUNS (the old opcode faulted). */
                const bool band = kind == "deadband";
                const double a = step.a.kind == NumOrText::Kind::Num ? step.a.num : 0.0;
                const uint32_t cell = site_cell(element, step_id, kind.c_str());
                const uint32_t site = fault_site(
                    step_id, kind, band ? "the deadband's site memory is invalid"
                                        : "the throttle's site memory is invalid");
                std::vector<Instruction>& code = flow.body.code;
                auto emit = [&](OpCode op, uint32_t ia = 0, uint32_t ib = 0,
                                uint16_t small = 0) {
                    Instruction one{op};
                    one.a = ia;
                    one.b = ib;
                    one.small = small;
                    one.c = site;
                    code.push_back(one);
                };
                /* deadband watches the EVENT's parameter argument; throttle watches
                   the tick clock. The throttle threshold carries a half-millisecond
                   slack: ticks are milliseconds, so a true elapsed is a whole count
                   and the float compare can never land inside the slack — elapsed
                   stays exactly ">= the authored period" with no integer clock. */
                const uint32_t at = static_cast<uint32_t>(code.size());
                if (band) {
                    emit(OpCode::Arg, 0);
                    emit(OpCode::Load, cell);
                    emit(OpCode::Sub);
                    emit(OpCode::Call, 0, 1, static_cast<uint16_t>(Builtin::Abs));
                    emit(OpCode::Const, program_.add_constant(Value::number(a)));
                    emit(OpCode::Lt);
                    emit(OpCode::JmpNil, at + 9);
                    emit(OpCode::JmpFalse, at + 9);
                    emit(OpCode::Halt);
                    emit(OpCode::Arg, 0);
                    emit(OpCode::Store, cell);
                } else {
                    emit(OpCode::ClockRead, static_cast<uint32_t>(ClockField::Now));
                    emit(OpCode::Load, cell);
                    emit(OpCode::Sub);
                    emit(OpCode::Const, program_.add_constant(Value::number(
                                            (std::max(0.0, a) - 0.5) / 1000.0)));
                    emit(OpCode::Lt);
                    emit(OpCode::JmpNil, at + 8);
                    emit(OpCode::JmpFalse, at + 8);
                    emit(OpCode::Halt);
                    emit(OpCode::ClockRead, static_cast<uint32_t>(ClockField::Now));
                    emit(OpCode::Store, cell);
                }
                flow.body.max_stack = std::max(flow.body.max_stack, 2u);
            } else if (kind == "debounce" || kind == "delay") {
                /* one Park each; the POLICY is the whole difference — debounce
                   replaces an occupied site (the last arrival speaks), delay keeps
                   it (the first arrival's continuation holds its wake) */
                const double a = step.a.kind == NumOrText::Kind::Num ? step.a.num : 0.0;
                Instruction ins;
                ins.op = OpCode::Park;
                ins.a = program_.layout.pending_slots++;
                ins.b = static_cast<uint32_t>(std::max(0.0, a));
                ins.small = static_cast<uint16_t>(
                    kind == "debounce" ? ParkPolicy::Replace : ParkPolicy::Keep);
                ins.c = fault_site(step_id, "park", "park state is invalid");
                flow.body.code.push_back(ins);
            } else if (kind == "tmr_start" || kind == "tmr_cancel") {
                const int timer =
                    resolve_timer(element, step.timer, step_id, in_component);
                if (timer < 0) {
                    step_ok = false;
                } else {
                    reference(step_id, step.timer, program_.timers[timer].node_id);
                    Instruction ins;
                    ins.op = OpCode::Send;
                    ins.small = send_small(SendTarget::Timer, kind == "tmr_start" ? 0 : 1);
                    ins.a = static_cast<uint32_t>(timer);
                    ins.c = fault_site(step_id, "timer", "timer state is invalid");
                    flow.body.code.push_back(ins);
                }
            } else {
                diag(step_id, "step_kind", "unknown step kind '" + kind + "'");
                step_ok = false;
            }
            if (!step_ok) {
                program_.reference_gaps.push_back(RefSite{step_id, ""});
                ok = false;
            }
        }
        if (!ok) return false;
        flow.body.code.push_back(Instruction{OpCode::Halt});
        flow.worst_steps = static_cast<uint32_t>(flow.body.code.size());
        return true;
    }

    void build_flows() {
        for (ElementInfo& element : elements_) {
            for (const FlowDecl& node : element.node->flows) {
                const uint64_t flow_id = node.id;
                /* a flow whose every trigger refused never compiles its steps, so
                   nothing vouched for the names they carry — mark them blind whole */
                auto abandon_steps = [&] {
                    for (const StepDecl& step : node.steps)
                        program_.reference_gaps.push_back(RefSite{step.id, ""});
                };
                if (node.when.empty()) {
                    diag(flow_id, "trigger", "flow has no trigger");
                    abandon_steps();
                    continue;
                }
                bool stepped = false;   /* any trigger reached compile_steps */
                const uint32_t group = program_.layout.fired_groups++;
                for (const TriggerDecl& trigger : node.when) {
                    FlowProgram flow;
                    flow.node_id = element.id;
                    flow.flow_id = flow_id;
                    flow.group = group;
                    flow.runtime_index = static_cast<uint32_t>(program_.flows.size());
                    flow.first_only =
                        node.when.size() > 1 && node.when_mode == "first";
                    EventParam param;
                    bool has_param = false;
                    /* empty = this trigger carries a copy; otherwise the clock it is */
                    std::string copyless;
                    if (trigger.kind == "timer") {
                        const int timer = resolve_timer(element, trigger.var, flow_id);
                        if (timer < 0) {
                            program_.reference_gaps.push_back(
                                RefSite{flow_id, trigger.var});
                            continue;
                        }
                        reference(flow_id, trigger.var, program_.timers[timer].node_id);
                        flow.event = program_.timers[timer].event;
                        program_.timers[timer].rearm_groups.push_back(group);
                        copyless = "a timer";
                    } else if (trigger.kind == "every") {
                        if (!cadence_trigger(element, trigger, flow_id, flow)) continue;
                        copyless = "an `every` trigger";
                    } else {
                        flow.event = trigger.name;
                        /* A COMPONENT'S ELEMENTS ARE PRIVATE ANATOMY: an instance flow's
                           trigger never names one — the instance-level channel and the
                           component's own events are its whole vocabulary */
                        if (!trigger.element.empty()) {
                            diag(flow_id, "event",
                                 "'" + trigger.element + "' is an element of this instance's "
                                 "component; element channels live in the component's "
                                 "behavior",
                                 DiagGrade::Error);
                            continue;
                        }
                        if (!event_signature(element, flow.event, "", flow_id,
                                             /*in_behavior=*/false, param, has_param))
                            continue;
                        flow.hold_ticks =
                            static_cast<uint32_t>(std::max(0.0, trigger.hold_ms));
                        flow.every_ticks =
                            static_cast<uint32_t>(std::max(0.0, trigger.every_ms));
                    }
                    stepped = true;
                    if (!compile_steps(element, node, flow, has_param ? &param : nullptr,
                                       nullptr, /*in_component=*/false, copyless)) {
                        const std::string message = "flow could not be compiled";
                        flow.body.code.clear();
                        Instruction fault;
                        fault.op = OpCode::Fault;
                        fault.a = fault_site(flow_id, "compile_fault", message);
                        flow.body.code.push_back(fault);
                        flow.body.code.push_back(Instruction{OpCode::Halt});
                        flow.body.max_stack = 1;
                        flow.worst_steps = 2;
                    }
                    program_.frame.stack =
                        std::max(program_.frame.stack, flow.body.max_stack);
                    program_.flows.push_back(std::move(flow));
                }
                if (!stepped) abandon_steps();
            }
        }
    }

    /* Who already writes each of an instance's slots, and what to call it in a diagnostic.
     * One writer per slot is the rule that keeps a slot deterministic (spec 2.3); this is
     * where it is decided, once, at compile time. */
    std::unordered_map<std::string, std::string> claimed_slots(const ElementInfo& element) const {
        std::unordered_map<std::string, std::string> out;
        /* a slot whose authored value became a STANDING program is spoken for: its
           expression is the writer (a constant folded back into the start is not) */
        for (const SlotProgram& sp : program_.slot_programs)
            if (sp.node_id == element.id)
                out[sp.slot] = "its value is a bound expression";
        for (const FlowDecl& flow : element.node->flows)
            for (const std::string& slot : written_slots(flow))
                out[slot] = "a flow on this instance writes it";
        return out;
    }

    /* The slots one flow writes: the destinations of its moves that name a slot. One
     * step kind to scan, so precedence is decided from one place (spec 2.3). */
    std::vector<std::string> written_slots(const FlowDecl& flow) const {
        std::vector<std::string> out;
        for (const StepDecl& step : flow.steps) {
            if (step.kind != "assign") continue;
            if (!step.to.slot.empty()) out.push_back(step.to.slot);
        }
        return out;
    }

    /* A component's DEFAULT BEHAVIOR: ordinary flows shipped in the registry row rather
     * than authored per instance, so a Toggle toggles the moment it is placed. They are
     * compiled by this same compiler into the same programs, so there is no per-type code
     * and a custom component declares behavior the same way.
     *
     * Precedence, resolved here so exactly one writer survives: a slot bound to an
     * expression wins (the control is a view of the machine), then an authored flow that
     * assigns the same slot (the author overrode the default), otherwise the default runs. Suppression is
     * per slot WRITTEN, not per event, so "on tap, send to the PLC" coexists with the
     * default local echo. Standing down is deterministic and silent: the author asked for
     * the writer that won, so there is nothing to report. */
    void build_type_behavior() {
        for (ElementInfo& element : elements_) {
            if (!element.type) continue;
            const std::vector<FlowDecl>& behavior = element.type->behavior;
            if (behavior.empty()) continue;
            /* stand-down is PER STEP now (compile_steps drops the claimed slot writes),
               so a fed control still raises `changed` while its local echo yields */
            const std::unordered_map<std::string, std::string> claimed = claimed_slots(element);
            for (const FlowDecl& node : behavior) {
                bool stepped = false;   /* any trigger reached compile_steps */
                for (const TriggerDecl& trigger : node.when) {
                    FlowProgram flow;
                    flow.node_id = element.id;
                    /* the instance's own id: document ids are unique, so this cannot collide
                       with an authored flow, and it keeps state-site identity stable */
                    flow.flow_id = element.id;
                    flow.group = program_.layout.fired_groups++;
                    flow.runtime_index = static_cast<uint32_t>(program_.flows.size());
                    EventParam param;
                    bool has_param = false;
                    std::string copyless;
                    if (trigger.kind == "every") {
                        if (!cadence_trigger(element, trigger, element.id, flow)) continue;
                        copyless = "an `every` trigger";
                    } else {
                        flow.event = trigger.name;
                        /* behavior is the ONE place a trigger may name an element channel */
                        flow.element = trigger.element;
                        if (!event_signature(element, flow.event, flow.element, element.id,
                                             /*in_behavior=*/true, param, has_param))
                            continue;
                        flow.hold_ticks =
                            static_cast<uint32_t>(std::max(0.0, trigger.hold_ms));
                    }
                    stepped = true;
                    if (!compile_steps(element, node, flow, has_param ? &param : nullptr,
                                       &claimed, /*in_component=*/true, copyless))
                        continue;
                    program_.frame.stack =
                        std::max(program_.frame.stack, flow.body.max_stack);
                    program_.flows.push_back(std::move(flow));
                }
                /* every trigger refused for THIS instance: nothing vouched for the
                   definition steps' names, and the blind mark must win over rows
                   another instance's compile may have recorded */
                if (!stepped)
                    for (const StepDecl& step : node.steps)
                        program_.reference_gaps.push_back(RefSite{step.id, ""});
            }
        }
    }

    const Doc doc_;
    /* every component this compile may place: built-ins shadowed and extended by the
     * document's own, derived by the registry's own walk (compile/components.h) —
     * never read back off the served rows. Never grows, so pointers into it hold. */
    const std::vector<ComponentSpec> specs_;
    const MeshPort& mesh_;
    Program program_;
    bool has_errors_ = false;
    /* [struct slot][field] -> the derived cell holding that aggregate field's
     * entries (UINT32_MAX where the field is scalar): the compiler's own record of
     * the storage it allotted, consulted to bind writes and the read-side copies */
    std::vector<std::vector<uint32_t>> field_cells_;
    std::unordered_map<std::string, uint32_t> globals_;
    std::unordered_map<std::string, std::string> tokens_;     /* token name -> dark value */
    std::unordered_map<std::string, uint16_t> struct_keys_;   /* schema key -> type id */
    std::unordered_map<std::string, uint16_t> struct_names_;  /* root name -> type id */
    std::set<std::string> ambiguous_;                         /* reported once each */
    std::unordered_map<std::string, uint32_t> global_timers_;
    std::vector<ElementInfo> elements_;
    std::vector<PendingSlot> pending_slots_;
};

} // namespace

Shape shape_from_name(const std::string& name) {
    if (name == "num") return Shape::Num;
    if (name == "bool") return Shape::Bool;
    if (name == "text") return Shape::Text;
    if (name == "enum") return Shape::Enum;
    if (name == "list") return Shape::List;
    if (name == "map") return Shape::Map;
    if (name == "struct") return Shape::Struct;
    if (name == "color") return Shape::Color;
    return Shape::Unknown;
}

CompileResult compile_document(const Document& document, const MeshPort& mesh) {
    return Compiler(document, mesh).run();
}

std::vector<Diag> check_component_definitions(const Document& document,
                                              const MeshPort& mesh,
                                              std::vector<RefRow>* refs,
                                              std::vector<RefSite>* gaps) {
    return Compiler(document, mesh).check_definitions(refs, gaps);
}

} // namespace hmi

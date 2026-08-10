#include "compiler.h"

#include "lang/expression.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <set>
#include <unordered_map>

namespace hmi {
namespace {

uint64_t id_of(const Json& node) {
    auto it = node.find("id");
    return it == node.end() ? 0 : json_u64_or(*it, 0);
}

/* Type-safe reads of document values. Json::value() substitutes its default only for a
 * MISSING key and THROWS on a present-but-differently-typed one, and the document holds
 * both legitimately: optional numbers default to null in the schema (poll_hz), and a
 * step keeps its old variant's fields across a kind flip, so `a` may hold another
 * kind's text. A read here never throws; the wrong type reads as absent. */
double num_or(const Json& node, const char* key, double fallback) {
    auto it = node.find(key);
    return it != node.end() && it->is_number() ? it->get<double>() : fallback;
}

std::string str_or(const Json& node, const char* key, const char* fallback) {
    auto it = node.find(key);
    return it != node.end() && it->is_string() ? it->get<std::string>() : fallback;
}

/* An instance's authored value for one slot ADDRESS (spec 2.3). A widget's `slots`
 * object mirrors the type's parts: a widget-level slot is a key, a part's slot a key
 * inside an object named for the part, so "bar.fill_color" walks two levels. Null when
 * nothing is authored there (the type's default stands) — including when the path runs
 * into a non-object, which is a stale value, not a value. */
const Json* authored_slot(const Json& slots, const std::string& address) {
    const Json* at = &slots;
    size_t from = 0;
    while (from <= address.size()) {
        if (!at->is_object()) return nullptr;
        const size_t dot = address.find('.', from);
        const std::string segment = address.substr(
            from, dot == std::string::npos ? std::string::npos : dot - from);
        auto found = at->find(segment);
        if (found == at->end()) return nullptr;
        at = &*found;
        if (dot == std::string::npos) return at;
        from = dot + 1;
    }
    return nullptr;
}

bool entity_kind(const std::string& text, EntityKind& out) {
    if (text == "V") out = EntityKind::Variable;
    else if (text == "T") out = EntityKind::Topic;
    else if (text == "F") out = EntityKind::Function;
    else if (text == "S") out = EntityKind::Signal;
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
        case EntityKind::Signal: return Verb::Emit;
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

/* A move's `from` / `to` is one object discriminated by the key it carries (spec 2.6),
 * so reading one is asking which key is there. */
enum class SideKind { None, Expr, Local, Entity, Init };

SideKind side_kind(const Json& side) {
    if (!side.is_object()) return SideKind::None;
    if (side.contains("expr")) return SideKind::Expr;
    if (side.contains("local")) return SideKind::Local;
    if (side.contains("slot")) return SideKind::Local;
    if (side.contains("kind")) return SideKind::Entity;
    if (side.contains("init")) return SideKind::Init;
    return SideKind::None;
}

/* the slot a move destination names, or "" when it names something else */
std::string slot_of(const Json& side) {
    if (!side.is_object()) return {};
    auto it = side.find("slot");
    return it != side.end() && it->is_string() ? it->get<std::string>() : std::string();
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

/* one armed part of a widget's template: where a gesture rides, compiled once so
 * trigger validation and the dispatch topology read the same facts */
struct ArmedInfo {
    std::string part;        /* dotted node names under the root; "" = the root itself */
    std::string primitive;
    bool bubbles = true;
};

struct WidgetInfo {
    uint64_t id = 0;
    uint64_t page = 0;
    const Json* node = nullptr;
    const Json* type = nullptr;
    std::unordered_map<std::string, uint32_t> locals;
    std::unordered_map<std::string, uint32_t> slots;
    std::unordered_map<std::string, uint32_t> timers;
    std::vector<ArmedInfo> armed;
};

/* ---- the GESTURE VOCABULARY, closed on both sides (mirrors frontend types.ts) ----
 *
 * A gesture event is never DECLARED: picking a primitive for a part IS the declaration,
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

/* which primitives raise it (the availability check reads the armed parts) */
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
    Compiler(const Document& document, const Json& registry, const MeshPort& mesh)
        : document_(document), registry_(registry), mesh_(mesh) {
        program_.document_version = document.version();
        program_.add_text("");
        /* The theme tokens (spec 2.10), name -> DARK value: the backend has no view and
         * therefore no theme mode, so dark is the canonical runtime resolution; light is
         * a per-view rendering the frontend applies. */
        auto tokens = document.root.find("tokens");
        if (tokens != document.root.end() && tokens->is_array())
            for (const Json& token : *tokens) {
                const std::string name = str_or(token, "name", "");
                if (!name.empty()) tokens_[name] = str_or(token, "dark", "");
            }
    }

    CompileResult run() {
        copy_entities();
        build_cells();
        build_armed_parts();
        build_slot_programs();
        /* The type's defaults are compiled FIRST, so they run first: by the time an
         * authored flow on the same event runs, the widget's own state already reflects
         * the gesture and `widget.<slot>` agrees with what the event passed. */
        build_type_behavior();
        build_flows();
        program_.layout.stack_values = std::max<uint32_t>(program_.layout.stack_values, 1);
        program_.layout.effect_capacity = std::max<uint32_t>(program_.layout.effect_capacity, 1);
        CompileResult out;
        out.ok = !has_errors_;
        out.program = std::move(program_);
        return out;
    }

  private:
    /* an authored slot EXPRESSION, held from build_cells (where the cell is made) to
     * build_slot_programs (when every cell the expression could read exists) */
    struct PendingSlot {
        uint64_t widget_id = 0;
        std::string name;
        std::string text;
        uint32_t cell = 0;
        Json spec;   /* the registry slot row: variants for the constrained-text check */
    };

    void diag(uint64_t node, const std::string& code, const std::string& message,
              DiagGrade grade = DiagGrade::Error, const std::string& where = "") {
        program_.diagnostics.push_back(Diag{node, grade, code, message, where});
        if (grade == DiagGrade::Error) has_errors_ = true;
    }

    uint32_t fault_site(uint64_t node, const std::string& code, const std::string& message) {
        program_.runtime_faults.push_back(Diag{node, DiagGrade::Error, code, message});
        return static_cast<uint32_t>(program_.runtime_faults.size() - 1);
    }

    const Json* type_named(const std::string& name) const {
        if (!registry_.is_object()) return nullptr;
        auto types = registry_.find("types");
        if (types == registry_.end() || !types->is_array()) return nullptr;
        for (const Json& type : *types)
            if (type.value("name", "") == name) return &type;
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
        /* the aggregate intake bound: one delivery's elements live in the scratch pool
         * at a time (the pool resets per feed run), so the pool carries the LARGEST
         * single entity's aggregate payload plus every expression site's worst case
         * (added by the parser as it compiles) */
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
        program_.layout.elem_values += intake_values;
        program_.layout.elem_texts += intake_texts;
    }

    uint32_t add_cell(CellKind kind, uint64_t owner_widget, uint64_t node_id,
                      const std::string& name, Shape shape, const Json& initial,
                      bool persistent) {
        CellDef cell;
        cell.kind = kind;
        cell.owner_widget = owner_widget;
        cell.name = name;
        cell.node_id = node_id;
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
            cell.text_slot = program_.layout.text_slots++;
            cell.text_cap = 256;
        }
        /* an aggregate cell owns retained storage: the run's element pool resets every
           run, so a cell that holds a list or a map needs a slot that does not */
        if (shape == Shape::List || shape == Shape::Map)
            cell.list_slot = program_.layout.list_slots++;
        program_.cells.push_back(std::move(cell));
        return static_cast<uint32_t>(program_.cells.size() - 1);
    }

    uint32_t add_timer(uint64_t owner_widget, const Json& var) {
        TimerDef timer;
        timer.owner_widget = owner_widget;
        timer.node_id = id_of(var);
        timer.name = var.value("name", "");
        timer.event = "timer:" + std::to_string(timer.node_id);
        const Json& init = var["init"];
        const double seconds = init.is_number() ? init.get<double>() : 0.0;
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
    uint32_t declare_variable(const Json& var, CellKind kind, uint64_t owner) {
        const std::string name = var.value("name", "");
        const std::string type_text = var.value("type", "");
        const Shape shape = var_shape(type_text);
        if (shape == Shape::List || shape == Shape::Map) {
            /* an aggregate's start has its own spellings and lands in the cell's
               constant run, not in the scalar initial, which stays Nil */
            const uint32_t cell = add_cell(kind, owner, id_of(var), name, shape, Json(),
                                           var.value("persist", false));
            program_.cells[cell].elem = declared_elem(var, name);
            aggregate_var_initial(var, shape, cell);
            return cell;
        }
        if (shape != Shape::Unknown)
            return add_cell(kind, owner, id_of(var), name, shape, var.value("init", Json()),
                            var.value("persist", false));
        const int type_id = find_type_ref(type_text);
        if (type_id < 0) {
            diag(id_of(var), "unresolved_type",
                 type_text.empty()
                     ? "variable '" + name + "' has no type"
                     : "variable '" + name + "' has type '" + type_text +
                           "', which is not a type in the mesh",
                 DiagGrade::Error, "type");
            return UINT32_MAX;
        }
        const Json init = var.contains("init") ? var["init"] : Json();
        if (program_.types[type_id].kind == TypeKind::Enum) {
            const uint32_t cell = add_cell(kind, owner, id_of(var), name, Shape::Enum,
                                           Json(), var.value("persist", false));
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
                    diag(id_of(var), "enum_name",
                         "'" + wanted + "' is not one of this enum's variants",
                         DiagGrade::Error, "init");
            }
            return cell;
        }
        const uint32_t cell = add_struct_cell(kind, owner, 0, id_of(var), name,
                                              static_cast<uint16_t>(type_id));
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
                    diag(id_of(var), "unresolved_field",
                         "'" + type_text + "' has no field '" + it.key() + "'",
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
                        diag(id_of(var), "value_shape",
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
        auto globals = document_.root.find("globals");
        if (globals != document_.root.end() && globals->is_array()) {
            for (const Json& var : *globals) {
                const std::string name = var.value("name", "");
                const uint32_t cell = declare_variable(var, CellKind::Global, 0);
                if (cell == UINT32_MAX) continue;
                globals_[name] = cell;
                if (program_.cells[cell].shape == Shape::Timer)
                    global_timers_[name] = add_timer(0, var);
            }
        }

        auto pages = document_.root.find("pages");
        if (pages == document_.root.end() || !pages->is_array()) return;
        for (const Json& page : *pages) {
            const uint64_t page_id = id_of(page);
            /* A page is one tree of nodes nesting to any depth; the ones carrying cells are
             * the INSTANCES — a frame with a `type` — so this walks the whole tree and
             * compiles at those. `info.page` is always the PAGE's id, never a frame's:
             * page identity is what gates mesh polling, so an instance three frames deep
             * must still resolve to its page. */
            std::function<void(const Json&)> walk_children = [&](const Json& node) {
                auto children = node.find("children");
                if (children == node.end() || !children->is_array()) return;
                for (const Json& widget : *children) {
                    const std::string type_name = widget.value("type", "");
                    /* pre-order, so cells and flows are built in document order — which is
                       the order the scheduler runs them in */
                    if (type_name.empty()) { walk_children(widget); continue; }

                    WidgetInfo info;
                    info.id = id_of(widget);
                    info.page = page_id;
                    info.node = &widget;
                    info.type = type_named(type_name);
                    if (!info.type)
                        diag(info.id, "widget_type",
                             "widget type '" + type_name + "' is not registered");

                    auto locals = widget.find("locals");
                    if (locals != widget.end() && locals->is_array()) {
                        for (const Json& var : *locals) {
                            const std::string name = var.value("name", "");
                            const uint32_t cell = declare_variable(var, CellKind::Local, info.id);
                            if (cell == UINT32_MAX) continue;
                            info.locals[name] = cell;
                            if (program_.cells[cell].shape == Shape::Timer)
                                info.timers[name] = add_timer(info.id, var);
                        }
                    }

                    if (info.type) {
                        const Json& authored =
                            widget.contains("slots") && widget["slots"].is_object()
                                ? widget["slots"] : empty_object_;
                        for (const Json& slot : info.type->value("slots", Json::array())) {
                            const std::string name = slot.value("name", "");
                            const Shape shape = slot_shape(slot);
                            const bool aggregate =
                                shape == Shape::List || shape == Shape::Map;
                            /* the type's DEFAULT is a raw literal (the registry's own
                               spelling); only an AUTHORED value speaks the expression
                               encoding (spec D1) */
                            Json initial = slot.value("default", Json());
                            std::string expr_text;
                            /* the slot's NAME is its address: a part's property is stored
                               nested under the part, so the lookup walks the dots */
                            if (const Json* override = authored_slot(authored, name)) {
                                if (override->is_string()) {
                                    const std::string text =
                                        trimmed(override->get<std::string>());
                                    if (text.empty()) {
                                        /* empty = unset: the default stands */
                                    } else if (shape == Shape::Color && text[0] == '$') {
                                        /* a whole-value token reference stays the
                                           authored literal spelling */
                                        initial = Json(text);
                                    } else if (shape == Shape::List &&
                                               (text.compare(0, 9, "variants(") == 0 ||
                                                text[0] == '[')) {
                                        initial = *override;
                                    } else if (shape == Shape::Map && text[0] == '{') {
                                        initial = *override;
                                    } else {
                                        /* AN EXPRESSION: compiled after every cell of
                                           this widget exists (build_slot_programs); a
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
                            std::vector<Value> list_init;
                            const bool has_list =
                                expr_text.empty() &&
                                (shape == Shape::List
                                     ? list_slot_initial(info.id, name, initial, list_init)
                                     : shape == Shape::Map &&
                                           map_slot_initial(info.id, name, initial,
                                                            list_init));
                            info.slots[name] =
                                add_cell(CellKind::Slot, info.id, info.id, name, shape,
                                         aggregate || !expr_text.empty() ? Json() : initial,
                                         false);
                            if (has_list) {
                                program_.cells[info.slots[name]].has_list = true;
                                program_.cells[info.slots[name]].list_init =
                                    std::move(list_init);
                            }
                            if (!expr_text.empty())
                                pending_slots_.push_back(PendingSlot{
                                    info.id, name, expr_text, info.slots[name], slot});
                        }
                    }
                    widgets_.push_back(std::move(info));
                }
            };
            walk_children(page);
        }
    }

    /* ONE SLOT'S AUTHORED NUMBER, the instance's value first and the type's default
     * otherwise: what a compile-time constant over a widget's own configuration reads
     * (an edit recompiles, so compile time is live enough). */
    bool slot_number(const WidgetInfo& widget, const std::string& slot, double& out) const {
        if (!widget.node || !widget.type) return false;
        const Json& authored = widget.node->contains("slots") &&
                                       (*widget.node)["slots"].is_object()
                                   ? (*widget.node)["slots"]
                                   : empty_object_;
        if (const Json* at = authored_slot(authored, slot))
            if (at->is_number()) {
                out = at->get<double>();
                return true;
            }
        for (const Json& row : widget.type->value("slots", Json::array()))
            if (row.value("name", "") == slot) {
                auto def = row.find("default");
                if (def == row.end() || !def->is_number()) return false;
                out = def->get<double>();
                return true;
            }
        return false;
    }

    /* THE CONSTANT FOLDER: `+ - * / ( )` over numeric literals and the widget's own slot
     * values, and nothing else. It is what lets a cadence be authored as "1000 / rate"
     * and a keep as "rate * window" — configuration arithmetic, resolved once at compile
     * against values an edit would recompile anyway, rather than a second expression
     * tier the scheduler would have to evaluate per tick.
     *
     * `widget.` is accepted as a prefix so the same text reads in a flow's expressions
     * and here. Anything it cannot resolve fails, and the caller turns that into a
     * finding: a cadence that quietly fell back to a default would be a lie about how
     * often something samples. */
    bool fold_const(const WidgetInfo& widget, const std::string& text, double& out) const {
        size_t at = 0;
        bool ok = true;
        const std::function<double()> sum = [&]() -> double {
            const std::function<double()> unary = [&]() -> double {
                while (at < text.size() && std::isspace(static_cast<unsigned char>(text[at])))
                    ++at;
                if (at < text.size() && (text[at] == '-' || text[at] == '+')) {
                    const bool negate = text[at++] == '-';
                    const double inner = unary();
                    return negate ? -inner : inner;
                }
                if (at < text.size() && text[at] == '(') {
                    ++at;
                    const double inner = sum();
                    while (at < text.size() &&
                           std::isspace(static_cast<unsigned char>(text[at])))
                        ++at;
                    if (at < text.size() && text[at] == ')') ++at;
                    else ok = false;
                    return inner;
                }
                const size_t start = at;
                while (at < text.size() &&
                       (std::isdigit(static_cast<unsigned char>(text[at])) ||
                        text[at] == '.'))
                    ++at;
                if (at > start) return std::strtod(text.substr(start, at - start).c_str(),
                                                   nullptr);
                while (at < text.size() &&
                       (std::isalnum(static_cast<unsigned char>(text[at])) ||
                        text[at] == '_' || text[at] == '.'))
                    ++at;
                if (at == start) {
                    ok = false;
                    return 0.0;
                }
                std::string name = text.substr(start, at - start);
                if (name.compare(0, 7, "widget.") == 0) name = name.substr(7);
                double value = 0.0;
                if (!slot_number(widget, name, value)) ok = false;
                return value;
            };
            double left = unary();
            for (;;) {
                while (at < text.size() && std::isspace(static_cast<unsigned char>(text[at])))
                    ++at;
                if (at >= text.size()) break;
                const char op = text[at];
                if (op != '+' && op != '-' && op != '*' && op != '/') break;
                ++at;
                const double right = unary();
                /* one precedence level, applied left to right: configuration arithmetic
                   is short enough that parentheses say what is meant, and a folder that
                   silently disagreed with the expression tier would be worse than one
                   that asks for them */
                switch (op) {
                    case '+': left += right; break;
                    case '-': left -= right; break;
                    case '*': left *= right; break;
                    default:
                        if (right == 0.0) ok = false;
                        else left /= right;
                        break;
                }
            }
            return left;
        };
        const double value = sum();
        while (at < text.size() && std::isspace(static_cast<unsigned char>(text[at]))) ++at;
        if (!ok || at != text.size() || !std::isfinite(value)) return false;
        out = value;
        return true;
    }

    /* AN `every` TRIGGER: the flow runs on its own clock, with no event behind it. `ms`
     * is a number or the text of a constant expression over the widget's slots; anything
     * unresolvable drops the trigger with a finding rather than picking a rate nobody
     * asked for. Ticks are milliseconds, clamped to something a scheduler can honour. */
    bool cadence_trigger(const WidgetInfo& widget, const Json& trigger, uint64_t flow_id,
                         FlowProgram& flow) {
        auto ms = trigger.find("ms");
        double period = 0.0;
        bool ok = false;
        if (ms != trigger.end() && ms->is_number()) {
            period = ms->get<double>();
            ok = std::isfinite(period);
        } else if (ms != trigger.end() && ms->is_string()) {
            ok = fold_const(widget, ms->get<std::string>(), period);
        }
        if (!ok || period <= 0.0) {
            diag(flow_id, "trigger",
                 "an 'every' trigger needs `ms`: a number, or constant arithmetic over "
                 "this widget's slots (\"1000 / rate\")");
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
    Json resolve_token(uint64_t widget_id, const std::string& slot, const Json& value) {
        if (!value.is_string()) return value;
        const std::string text = value.get<std::string>();
        if (text.empty() || text[0] != '$') return value;
        auto found = tokens_.find(text.substr(1));
        if (found != tokens_.end()) return Json(found->second);
        diag(widget_id, "unknown_token",
             "unknown token '" + text + "': the slot paints transparent",
             DiagGrade::Warning, slot);
        return Json("#00000000");
    }

    /* A registry slot declared `enum` is CONSTRAINED TEXT: its values are the variant NAMES
     * the author picks and the template draws ("center"), so the cell holds the name. The
     * VM's Enum shape means something else, a mesh field's backing integer (spec 2.2), and
     * conflating them left every enum slot holding Nil. `icon` is the same species: the
     * declared shape drives the editor (the icon grid), the value is the glyph's NAME. */
    Shape slot_shape(const Json& slot) const {
        const std::string name = slot.value("shape", "");
        return name == "enum" || name == "icon" ? Shape::Text : shape_from_name(name);
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
    bool list_slot_initial(uint64_t widget_id, const std::string& slot, const Json& value,
                           std::vector<Value>& out) {
        const AggSite site{widget_id, "slot '" + slot + "' is a list", slot,
                           "Write the options as a list ([\"Off\", \"Low\", \"High\"]) "
                           "or as variants(Type.field), naming an enum in the mesh. To "
                           "FOLLOW a variable instead, write its name as the value — "
                           "the slot's expression is the binding"};
        if (value.is_null()) return false;
        if (value.is_string()) {
            const std::string text = trimmed(value.get<std::string>());
            if (text.empty()) return false;
            if (text.compare(0, 9, "variants(") == 0 && text.back() == ')') {
                const std::string ref = trimmed(text.substr(9, text.size() - 10));
                const int type_id = find_type_ref(ref);
                if (type_id < 0 || program_.types[type_id].kind != TypeKind::Enum) {
                    diag(widget_id, "unresolved_type",
                         "slot '" + slot + "': variants(" + ref + ") needs '" + ref +
                             "' to name an enum in the mesh (a field's type reads "
                             "Type.field)",
                         DiagGrade::Error, slot);
                    return false;
                }
                for (const auto& row : program_.types[type_id].variants)
                    out.push_back(Value::text(program_.add_text(row.first)));
                return list_within_bounds(site, out);
            }
            const Json parsed = Json::parse(text, nullptr, false);
            if (!parsed.is_array())
                return refuse_agg(site, "'" + text +
                                            "' is neither a list nor a variants() "
                                            "reference");
            return list_elements(site, parsed, out);
        }
        if (!value.is_array())
            return refuse_agg(site, "its value is " + json_brief(value));
        return list_elements(site, value, out);
    }

    /* THE AUTHORED VALUE OF A MAP SLOT: an object of scalars, or the text of one. The
     * same two spellings a list slot takes, for the same reason — an inspector field
     * commits a string and the document keeps what it was given. */
    bool map_slot_initial(uint64_t widget_id, const std::string& slot, const Json& value,
                          std::vector<Value>& out) {
        const AggSite site{widget_id, "slot '" + slot + "' is a map", slot,
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
        return map_entries(site, object, out);
    }

    bool list_elements(const AggSite& site, const Json& array, std::vector<Value>& out) {
        for (const Json& item : array) {
            Value element = Value::nil();
            if (!scalar_element(item, element)) {
                out.clear();
                return refuse_agg(site, "the element " + json_brief(item) +
                                            " is not a string, a number or a boolean");
            }
            out.push_back(element);
        }
        return list_within_bounds(site, out);
    }

    /* ONE MEMBER of an authored aggregate: the three JSON scalars, as themselves. A
     * nested array or object is refused by the caller — nested aggregates do not exist
     * anywhere in this system, so an authored one would be a shape nothing can hold. */
    bool scalar_element(const Json& item, Value& out) {
        if (item.is_string()) out = Value::text(program_.add_text(item.get<std::string>()));
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
    bool map_entries(const AggSite& site, const Json& object, std::vector<Value>& out) {
        for (auto it = object.begin(); it != object.end(); ++it) {
            Value value = Value::nil();
            if (!it->is_null() && !scalar_element(*it, value)) {
                out.clear();
                return refuse_agg(site, "the member '" + it.key() + "' is " +
                                            json_brief(*it) +
                                            ", which is not a string, a number or a "
                                            "boolean");
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
    void aggregate_var_initial(const Json& var, Shape shape, uint32_t cell) {
        const bool pairs = shape == Shape::Map;
        const std::string name = var.value("name", "");
        const AggSite site{
            id_of(var),
            std::string("variable '") + name + "' is a " + (pairs ? "map" : "list"),
            "init",
            pairs ? "Write its start as an object of scalars ({\"a\": 1, \"b\": 2}), or "
                    "leave it empty"
                  : "Write its start as a list of scalars ([1, 2, 3]), or leave it empty"};
        std::vector<Value> out;
        Json value = var.contains("init") ? var["init"] : Json();
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
        if (!value.is_null()) {
            if (pairs && value.is_object()) map_entries(site, value, out);
            else if (!pairs && value.is_array()) list_elements(site, value, out);
            else refuse_agg(site, "its start is " + json_brief(value));
        }
        /* a declared element type holds from the very start: one foreign element in
           the authored literal is a finding and the buffer starts empty instead */
        const Shape elem = program_.cells[cell].elem;
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

    /* a value outside a slot's declared variant set is a typo, not a new option */
    void check_variants(uint64_t widget_id, const std::string& slot, const Json& spec,
                        const Json& value) {
        auto variants = spec.find("variants");
        if (variants == spec.end() || !variants->is_array() || !value.is_string()) return;
        for (const Json& variant : *variants)
            if (variant == value) return;
        std::string known;
        for (const Json& variant : *variants)
            known += (known.empty() ? "" : ", ") + variant.get<std::string>();
        diag(widget_id, "slot_variant",
             "slot '" + slot + "' is " + json_brief(value) + ", which is not one of: " + known,
             DiagGrade::Error, slot);
    }

    /* the DECLARED element type of a list or map variable ("" = undeclared, any
     * scalar): spelled with the scalar variable type names, so the vocabulary the
     * type picker already teaches is the one this reads. A wrong spelling is a
     * finding on the variable, never a silent anything-goes. */
    Shape declared_elem(const Json& var, const std::string& name) {
        const std::string text = trimmed(var.value("elem", ""));
        if (text.empty()) return Shape::Unknown;
        const Shape shape = var_shape(text);
        if (shape == Shape::Num || shape == Shape::Bool || shape == Shape::Text)
            return shape;
        diag(id_of(var), "value_shape",
             "variable '" + name + "': '" + text +
                 "' is not an element type; elements are f64, bool, str or icon",
             DiagGrade::Error, "elem");
        return Shape::Unknown;
    }

    Shape var_shape(const std::string& type) const {
        if (type == "f64") return Shape::Num;
        if (type == "bool") return Shape::Bool;
        if (type == "str") return Shape::Text;
        /* an icon VARIABLE holds the glyph's name: the declared type drives the
           editor (the icon grid), the runtime cell is ordinary text */
        if (type == "icon") return Shape::Text;
        if (type == "timer") return Shape::Timer;
        /* an aggregate is an ORDINARY variable type now: a list is what a flow appends
           a history into, a map what it writes by key */
        if (type == "list") return Shape::List;
        if (type == "map") return Shape::Map;
        return Shape::Unknown;
    }

    WidgetInfo* widget_info(uint64_t id) {
        for (WidgetInfo& info : widgets_)
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
    int resolve_entity(const Json& ref, uint64_t node, const std::string& where = "") {
        if (!ref.is_object()) {
            diag(node, "entity_ref", "entity reference is not an object",
                 DiagGrade::Error, where);
            return -1;
        }
        EntityKind kind;
        const std::string kind_text = ref.value("kind", "");
        const std::string name = ref.value("name", "");
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
     * any other name */
    void bind_variable(ExpressionScope& scope, const std::string& name, uint32_t cell_index) {
        const CellDef& cell = program_.cells[cell_index];
        scope.names[name] = Binding{cell.shape, OpCode::Load, cell_index, 0, cell.type_id};
        if (cell.shape != Shape::Struct) return;
        const std::vector<FieldDef>& fields = struct_fields(program_, cell.type_id);
        for (uint32_t i = 0; i < fields.size(); ++i)
            scope.qualified[name + "." + fields[i].path] =
                Binding{fields[i].shape, OpCode::LoadField, cell_index, i,
                        fields[i].type_id};
    }

    /* a timer variable reads by FIELD (`blink.running`, `blink.remaining`): the state
     * lives in the timer table, not the cell, so its bindings load from there */
    void bind_timer(ExpressionScope& scope, const std::string& name, uint32_t index) {
        scope.qualified[name + ".running"] = Binding{Shape::Bool, OpCode::TmrRead, index, 0};
        scope.qualified[name + ".remaining"] = Binding{Shape::Num, OpCode::TmrRead, index, 1};
        scope.qualified[name + ".progress"] = Binding{Shape::Num, OpCode::TmrRead, index, 3};
        scope.qualified[name + ".duration"] = Binding{Shape::Num, OpCode::TmrRead, index, 2};
    }

    /* the system clock, in every scalar scope: `time` reads by field, off the one table
       the VM dispatches on. Bound FIRST-AS-RESERVED: it lands after every variable and
       timer, so `time.*` is always the clock — the same reservation the display tier
       makes by checking `time` before the property scope. */
    void bind_clock(ExpressionScope& scope) {
        constexpr uint32_t count = sizeof(kClockFields) / sizeof(kClockFields[0]);
        for (uint32_t i = 0; i < count; ++i)
            scope.qualified[std::string("time.") + kClockFields[i].name] =
                Binding{kClockFields[i].shape, OpCode::ClockRead, i, 0};
    }

    ExpressionScope scope_for(const WidgetInfo& widget, Shape x_shape) {
        ExpressionScope scope;
        scope.x_shape = x_shape;
        for (const auto& item : globals_) bind_variable(scope, item.first, item.second);
        for (const auto& item : widget.locals) bind_variable(scope, item.first, item.second);
        for (const auto& item : global_timers_) bind_timer(scope, item.first, item.second);
        for (const auto& item : widget.timers) bind_timer(scope, item.first, item.second);
        bind_clock(scope);
        for (const auto& item : widget.slots) {
            const CellDef& cell = program_.cells[item.second];
            scope.qualified["widget." + item.first] =
                Binding{cell.shape, OpCode::Load, item.second, 0};
        }
        return scope;
    }

    /* `agg_ok` says the DESTINATION is a declared HMI aggregate (a list/map variable or
     * slot), so a wire expression may yield that whole shape. It is never set for a
     * mesh destination — the machine still takes one scalar per field. */
    bool expression(uint64_t node, const std::string& text, ExprTier tier,
                    const ExpressionScope& scope, Shape expected,
                    std::vector<Instruction>& code, uint32_t& max_stack,
                    Shape* actual = nullptr, const std::string& where = "",
                    uint16_t* enum_out = nullptr, bool agg_ok = false) {
        ExpressionResult result;
        std::string error;
        ProgramEmit emit(program_);
        if (!compile_expression(text, tier, scope, emit, code, result, error,
                                agg_ok ? expected : Shape::Unknown)) {
            diag(node, "expression", error, DiagGrade::Error, where);
            return false;
        }
        if (expected != Shape::Unknown && result.shape != Shape::Unknown &&
            result.shape != Shape::Nil && result.shape != expected) {
            diag(node, "shape",
                 "expression yields " + std::string(shape_name(result.shape)) +
                     ", but this row wants " + shape_name(expected),
                 DiagGrade::Error, where);
            return false;
        }
        if (actual) *actual = result.shape;
        if (enum_out) *enum_out = result.enum_type;
        max_stack = std::max(max_stack, result.max_stack);
        return true;
    }

    /* the ARMED PARTS of every widget, off the served template: trigger validation and
     * the runtime's bubbling topology read one compiled truth */
    void build_armed_parts() {
        for (WidgetInfo& widget : widgets_) {
            if (!widget.type) continue;
            auto tmpl = widget.type->find("template");
            if (tmpl == widget.type->end() || !tmpl->is_object()) continue;
            collect_armed(*tmpl, "", widget, /*root=*/true);
        }
    }

    void collect_armed(const Json& node, const std::string& path, WidgetInfo& widget,
                       bool root) {
        auto interact = node.find("interact");
        if (interact != node.end() && interact->is_object() &&
            !str_or(*interact, "primitive", "").empty()) {
            ArmedInfo info;
            info.part = path;
            info.primitive = str_or(*interact, "primitive", "");
            info.bubbles = interact->value("bubbles", true);
            widget.armed.push_back(info);
            /* the root's own channel IS the widget-level one; only named parts enter
               the bubbling table */
            if (!path.empty())
                program_.armed_parts.push_back(ArmedPart{widget.id, path, info.bubbles});
        }
        (void)root;
        auto children = node.find("children");
        if (children == node.end() || !children->is_array()) return;
        for (const Json& child : *children) {
            const std::string name = str_or(child, "name", "");
            collect_armed(child, path.empty() ? name : path + "." + name, widget,
                          /*root=*/false);
        }
    }

    /* Resolve a trigger's SIGNATURE: a gesture event checks that some armed part (or
     * the named one) raises it and takes its fixed parameter; a custom event reads the
     * type's declaration. False = the trigger is invalid (diagnosed here). */
    bool event_signature(const WidgetInfo& widget, const std::string& event,
                         const std::string& part, uint64_t flow, bool in_behavior,
                         EventParam& param, bool& has_param) {
        has_param = false;
        if (gesture_event(event)) {
            bool available = false;
            for (const ArmedInfo& armed : widget.armed) {
                if (!part.empty() && armed.part != part) continue;
                if (gesture_from(event, armed.primitive)) { available = true; break; }
            }
            if (!available) {
                diag(flow, "event",
                     part.empty()
                         ? "no part of this widget raises '" + event +
                               "'; give a part the gesture that raises it"
                         : "part '" + part + "' does not raise '" + event + "'",
                     DiagGrade::Error);
                return false;
            }
            has_param = gesture_param(event, param);
            return true;
        }
        if (!part.empty()) {
            diag(flow, "event",
                 "a part channel carries gestures; '" + event + "' is raised by the "
                 "component itself and arrives on the widget's own channel",
                 DiagGrade::Error);
            return false;
        }
        (void)in_behavior;
        if (widget.type)
            for (const Json& row : widget.type->value("events", Json::array())) {
                if (row.value("name", "") != event) continue;
                const Json params = row.value("params", Json::array());
                if (params.is_array() && params.size() > 1) {
                    diag(flow, "event", "'" + event + "' declares " +
                             std::to_string(params.size()) +
                             " parameters; an event carries one for now",
                         DiagGrade::Error);
                    return false;
                }
                if (params.is_array() && params.size() == 1) {
                    param.name = str_or(params[0], "name", "value");
                    param.shape = shape_from_name(str_or(params[0], "shape", ""));
                    has_param = true;
                }
                return true;
            }
        diag(flow, "event", "widget type has no event '" + event + "'");
        return false;
    }

    /* EVERY READABLE MESH ENTITY, bound under its '@'-prefixed spelling: a bare-scalar
     * entity (or a one-field message) reads bare, a fielded one by `@name.field`. This
     * is what makes a slot expression multi-source — its deps are whatever it reads.
     * Function entities bind their RESPONSE fields; the poll cadence asks for them. */
    void bind_entities(ExpressionScope& scope) {
        for (uint32_t e = 0; e < program_.entities.size(); ++e) {
            const EntityDef& def = program_.entities[e];
            const std::vector<FieldDef>& fields = feed_fields(def);
            if (fields.empty()) continue;
            const std::string base = "@" + def.name;
            if (fields.size() == 1)
                scope.names[base] = Binding{fields[0].shape, OpCode::LoadEnt, e, 0,
                                            fields[0].type_id, fields[0].elem};
            if (fields.size() == 1 && fields[0].path.empty()) continue;
            for (uint32_t i = 0; i < fields.size(); ++i)
                scope.qualified[base + "." + fields[i].path] =
                    Binding{fields[i].shape, OpCode::LoadEnt, e, i, fields[i].type_id,
                            fields[i].elem};
        }
    }

    /* What a compiled slot expression READS, off its own instructions (lambda bodies
     * included): entity reads become deps the scheduler re-evaluates on — scalar
     * fields off the last-value cache, aggregate fields off the entity mirrors — and
     * a cell or timer read makes the program an every-tick one (cells can move any
     * tick). */
    bool scan_slot_deps(const std::vector<Instruction>& code, SlotProgram& sp) {
        for (const Instruction& ins : code) {
            switch (ins.op) {
                case OpCode::Load:
                case OpCode::LoadField:
                case OpCode::TmrRead:
                /* the clock moves every tick by definition */
                case OpCode::ClockRead:
                    sp.every_tick = true;
                    break;
                case OpCode::LoadEnt: {
                    if (!sp.depends_on(ins.a)) sp.dep_entities.push_back(ins.a);
                    /* the mesh must consume a read entity or its mirror never fills,
                       exactly as it does for one a flow reads */
                    program_.entities[ins.a].flow_reads = true;
                    break;
                }
                case OpCode::Iterate:
                    if (ins.a < program_.subs.size() &&
                        !scan_slot_deps(program_.subs[ins.a].code, sp))
                        return false;
                    break;
                default:
                    break;
            }
        }
        return true;
    }

    /* THE STANDING SLOT PROGRAMS (spec D1): every pending authored expression, compiled
     * against the widget's scope PLUS the mesh. A constant folds into the cell's start
     * and leaves no program; anything live stores into the cell whenever a dep moves —
     * every tick where it reads cells, on delivery where it reads only the mesh. */
    void build_slot_programs() {
        for (const PendingSlot& pending : pending_slots_) {
            WidgetInfo* widget = widget_info(pending.widget_id);
            if (!widget) continue;
            compile_slot_program(*widget, pending);
        }
    }

    void compile_slot_program(WidgetInfo& widget, const PendingSlot& pending) {
        const Shape wanted = program_.cells[pending.cell].shape;
        const bool aggregate = wanted == Shape::List || wanted == Shape::Map;
        ExpressionScope scope = scope_for(widget, Shape::Unknown);
        scope.no_x = true;   /* a slot expression has no pipeline register */
        bind_entities(scope);
        SlotProgram sp;
        sp.widget_id = widget.id;
        sp.page_id = widget.page;
        sp.slot = pending.name;
        sp.cell = pending.cell;
        Shape produced = Shape::Unknown;
        if (!expression(widget.id, pending.text, ExprTier::Display, scope,
                        aggregate ? wanted : Shape::Unknown, sp.code, sp.max_stack,
                        &produced, pending.name, nullptr, aggregate))
            return;   /* the finding is already pinned to the widget's slot row */
        /* the one automatic coercion (spec 6.2): an enum-yielding expression filling a
           text slot reads as its variant name, so a Dropdown bound to an enum field
           needs no authored transform */
        if (!aggregate && produced == Shape::Enum && wanted == Shape::Text) {
            Instruction as_name;
            as_name.op = OpCode::Method;
            as_name.a = program_.layout.text_slots++;
            as_name.b = 0;
            as_name.small = static_cast<uint16_t>(MethodId::EnumName);
            sp.code.push_back(as_name);
            produced = Shape::Text;
        }
        if (!aggregate && wanted != Shape::Unknown && produced != Shape::Unknown &&
            produced != Shape::Nil && produced != wanted) {
            diag(widget.id, "shape",
                 "the expression yields " + std::string(shape_name(produced)) +
                     ", but slot '" + pending.name + "' wants " + shape_name(wanted),
                 DiagGrade::Error, pending.name);
            return;
        }
        /* A CONSTANT is the literal it spells: it folds into the cell's start and no
           standing program exists — a quoted caption costs what the raw literal did. */
        if (sp.code.size() == 1 && sp.code[0].op == OpCode::Const) {
            const Value value = program_.constants[sp.code[0].a];
            program_.cells[pending.cell].initial = value;
            /* a constant text ref wears kConstantRef: strip it to read the pool */
            const uint32_t pool = value.ref & ~kConstantRef;
            if (value.tag == ValueTag::Text && pool < program_.texts.size())
                check_variants(widget.id, pending.name, pending.spec,
                               Json(program_.texts[pool]));
            return;
        }
        if (!scan_slot_deps(sp.code, sp)) return;
        /* a program that reads nothing live (an array literal, arithmetic over
           constants) still has to run once; the seed pass at start covers it, and
           there is nothing to re-run it for */
        for (uint32_t dep : sp.dep_entities) {
            if (program_.entities[dep].kind != EntityKind::Function) continue;
            double hz = 2.0;
            auto poll = widget.node->find("poll");
            if (poll != widget.node->end() && poll->is_object()) {
                auto rate = poll->find(pending.name);
                if (rate != poll->end() && rate->is_number() &&
                    rate->get<double>() > 0.0)
                    hz = rate->get<double>();
            }
            sp.poll_ms = std::max(10u, static_cast<uint32_t>(std::lround(1000.0 / hz)));
            break;
        }
        Instruction store;
        store.op = OpCode::Store;
        store.a = pending.cell;
        store.c = fault_site(widget.id, "slot_store",
                             "slot '" + pending.name + "' could not store its value");
        sp.code.push_back(store);
        sp.code.push_back(Instruction{OpCode::Halt});
        program_.layout.stack_values = std::max(program_.layout.stack_values, sp.max_stack);
        program_.slot_programs.push_back(std::move(sp));
    }

    void break_flow(FlowProgram& flow, uint64_t node, const std::string& code,
                    const std::string& message) {
        diag(node, code, message);
        flow.code.clear();
        Instruction fault;
        fault.op = OpCode::Fault;
        fault.a = fault_site(node, code, message);
        flow.code.push_back(fault);
        flow.code.push_back(Instruction{OpCode::Halt});
        flow.max_stack = 1;
        flow.worst_steps = 2;
    }

    uint32_t state_site(StateSiteKind kind, uint64_t flow, uint64_t row) {
        uint32_t slot = 0;
        if (kind == StateSiteKind::Deadband) slot = program_.layout.deadband_slots++;
        else if (kind == StateSiteKind::Throttle) slot = program_.layout.throttle_slots++;
        else slot = program_.layout.pending_slots++;
        program_.state_sites.push_back(StateSite{kind, flow, row, slot});
        return slot;
    }

    /* A DECLARED name in this widget's scope: its own local variable, else a global.
     * Temporaries are not here; they are declared by the move that writes them. */
    uint32_t declared_cell(const WidgetInfo& widget, const std::string& name) const {
        auto local = widget.locals.find(name);
        if (local != widget.locals.end()) return local->second;
        auto global = globals_.find(name);
        return global == globals_.end() ? UINT32_MAX : global->second;
    }

    /* A struct-shaped cell owns one of the run's struct slots: the cell's Value is the
     * handle, the fields live in that slot (spec 5.2). A flow temporary and a declared
     * struct variable differ only in kind and lifetime: a temporary's slot is snapshot
     * around suspensions, a variable's is stable storage. */
    uint32_t add_struct_cell(CellKind kind, uint64_t widget_id, uint64_t flow_id,
                             uint64_t node_id, const std::string& name, uint16_t type_id) {
        CellDef cell;
        cell.kind = kind;
        cell.owner_widget = widget_id;
        cell.owner_flow = flow_id;
        cell.node_id = node_id;
        cell.name = name;
        cell.shape = Shape::Struct;
        cell.type_id = type_id;
        cell.struct_slot = static_cast<uint32_t>(program_.structs.size());
        program_.structs.push_back(StructDef{type_id, kind == CellKind::Temp});
        program_.layout.max_struct_fields = std::max<uint32_t>(
            program_.layout.max_struct_fields,
            static_cast<uint32_t>(struct_fields(program_, type_id).size()));
        program_.cells.push_back(std::move(cell));
        return static_cast<uint32_t>(program_.cells.size() - 1);
    }

    uint32_t add_temp_cell(uint64_t flow_id, uint64_t widget_id, const std::string& name,
                           Shape shape) {
        CellDef cell;
        cell.kind = CellKind::Temp;
        cell.owner_widget = widget_id;
        cell.owner_flow = flow_id;
        cell.name = name;
        cell.shape = shape;
        if (shape == Shape::Text) {
            cell.text_slot = program_.layout.text_slots++;
            cell.text_cap = 256;
        }
        program_.cells.push_back(std::move(cell));
        return static_cast<uint32_t>(program_.cells.size() - 1);
    }

    int resolve_timer(const WidgetInfo& widget, const std::string& name,
                      uint64_t node) {
        auto local = widget.timers.find(name);
        if (local != widget.timers.end()) return static_cast<int>(local->second);
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
    bool compile_assign(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                        ExpressionScope& scope, FlowLocals& locals) {
        const uint64_t step_id = id_of(step);
        const Json& from = step.value("from", Json::object());
        const Json& to = step.value("to", Json::object());
        const SideKind source = side_kind(from);
        if (source == SideKind::None) {
            diag(step_id, "move_source", "this assignment has no value", DiagGrade::Error,
                 "from");
            return false;
        }

        /* THE TWO AGGREGATE WRITES (spec 2.6): `mode: append` puts one element on the
         * end of a list, `key` writes one key of a map. They are separate verbs because
         * they mean separate things — one grows a history, the other addresses a table —
         * and asking for both at once is asking for neither. */
        const std::string mode = str_or(step, "mode", "write");
        const std::string keep = trimmed(str_or(step, "keep", ""));
        const std::string key = trimmed(str_or(step, "key", ""));
        const bool appends = mode == "append";
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

        const std::string slot = slot_of(to);
        if (!slot.empty()) {
            auto found = widget.slots.find(slot);
            if (found == widget.slots.end()) {
                diag(step_id, "move_dest", "this widget has no slot '" + slot + "'",
                     DiagGrade::Error, "to");
                return false;
            }
            if (appends || !key.empty())
                return aggregate_assign(widget, step, flow, scope, found->second, appends,
                                      keep, key);
            /* a LIST or MAP slot takes a whole aggregate here: this is an HMI cell,
               not a machine, so the one-scalar rule steps aside for exactly its shape */
            return push_typed(widget, step, flow, scope, from,
                              program_.cells[found->second].shape, 0,
                              /*agg_ok=*/true) &&
                   emit_store(flow, step_id, found->second);
        }

        if (to.contains("local")) {
            if (appends || !key.empty()) {
                const std::string name = str_or(to, "local", "");
                const std::string path = str_or(to, "path", "");
                if (!path.empty()) {
                    diag(step_id, "move_dest",
                         "'" + name + "." + path + "' is inside a struct value, which "
                         "the HMI cannot edit element by element yet; write the element "
                         "to the entity's own field at an index, or stage it in a list "
                         "variable",
                         DiagGrade::Error, "to");
                    return false;
                }
                uint32_t cell = UINT32_MAX;
                auto found = locals.find(name);
                if (found != locals.end()) cell = found->second;
                else cell = declared_cell(widget, name);
                if (cell == UINT32_MAX) {
                    diag(step_id, "move_dest",
                         (appends ? "append writes into a list variable or a list slot; '"
                                  : "an element write needs a list or a map; '") +
                             name + "' is not declared",
                         DiagGrade::Error, "to");
                    return false;
                }
                return aggregate_assign(widget, step, flow, scope, cell, appends, keep, key);
            }
            return assign_into_local(widget, step, flow, scope, locals);
        }
        if (to.contains("kind")) {
            if (appends) {
                diag(step_id, "move_dest",
                     "a mesh entity takes no append; a list variable or a list slot "
                     "grows, and an array field takes one element at an index",
                     DiagGrade::Error, "to");
                return false;
            }
            /* a key on a mesh destination is an ELEMENT write into an array field;
               assign_out owns the field resolution, so the refusals can name it */
            return assign_out(widget, step, flow, scope, locals);
        }
        diag(step_id, "move_dest", "this move has no destination", DiagGrade::Error, "to");
        return false;
    }

    /* APPEND, KEYED or INDEXED WRITE into an aggregate cell. All push the ELEMENT
     * first and the bound (keep) or the address (key / index) after it, because the VM
     * pops what was pushed last: one instruction shape, three verbs. The address rides
     * the step's one `key` field either way — a map addresses an entry by text key, a
     * list a position by number index.
     *
     * The source is a SCALAR either way. A list into an append would be asking to
     * replace the list, which is what an ordinary write already is, and a nested
     * aggregate has no representation at all — so both are refused where the shape can
     * be seen at compile time. A DECLARED element type compiles the element toward it,
     * so a wrong-shaped element teaches here rather than faulting at the write. */
    bool aggregate_assign(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                        ExpressionScope& scope, uint32_t cell, bool appends,
                        const std::string& keep, const std::string& key) {
        const uint64_t step_id = id_of(step);
        const Json& from = step.value("from", Json::object());
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
        if (def.elem != Shape::Unknown) {
            /* the declared element type is the destination's shape: same coercions,
               same refusals a same-shaped scalar destination gets (an enum appends to
               a text list as its variant name) */
            if (!push_typed(widget, step, flow, scope, from, def.elem, 0))
                return false;
        } else {
            Shape produced = Shape::Unknown;
            if (!push_scalar(widget, step, flow, scope, from, Shape::Unknown, &produced))
                return false;
            if (produced == Shape::List || produced == Shape::Map ||
                produced == Shape::Struct) {
                diag(step_id, "shape",
                     appends ? "append takes one element; to replace the list write it whole"
                             : "an element write takes one scalar; a whole aggregate is "
                               "not an element",
                     DiagGrade::Error, "from");
                return false;
            }
        }
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
                flow.code.push_back(nothing);
                flow.max_stack = std::max(flow.max_stack, 2u);
            } else {
                if (!expression(step_id, keep, ExprTier::Wire, scope, Shape::Num,
                                flow.code, bound_stack, nullptr, "keep"))
                    return false;
                flow.max_stack = std::max(flow.max_stack, bound_stack + 1);
                /* a COURTESY check: a keep the folder can read and that is past the
                   ceiling is not an error (the list simply holds the last 4096), but it
                   is not what the author asked for either */
                double window = 0.0;
                if (fold_const(widget, keep, window) &&
                    window > static_cast<double>(kRetainedCeiling))
                    diag(step_id, "keep_bound",
                         "keep is " + std::to_string(static_cast<long long>(window)) +
                             "; a list holds at most " +
                             std::to_string(kRetainedCeiling) +
                             " elements, so it keeps the last " +
                             std::to_string(kRetainedCeiling),
                         DiagGrade::Warning, "keep");
            }
            Instruction ins;
            ins.op = OpCode::Append;
            ins.a = cell;
            ins.b = fault_site(
                step_id, "append",
                keep.empty()
                    ? "list '" + def.name + "' hit the " +
                          std::to_string(kRetainedCeiling) +
                          "-element ceiling; add keep to bound it"
                    : "'" + def.name +
                          "' could not append: an append takes ONE element that fits "
                          "the list, and a keep that is not a number leaves the list "
                          "unbounded to the " +
                          std::to_string(kRetainedCeiling) + "-element ceiling");
            flow.code.push_back(ins);
            return true;
        }
        /* likewise: the address rides above the value the write is carrying — a map's
           text key, or a list's number index */
        uint32_t key_stack = 1;
        if (!expression(step_id, key, ExprTier::Wire, scope,
                        indexed ? Shape::Num : Shape::Text, flow.code, key_stack,
                        nullptr, "key"))
            return false;
        flow.max_stack = std::max(flow.max_stack, key_stack + 1);
        Instruction ins;
        if (indexed) {
            ins.op = OpCode::StoreIndex;
            ins.a = cell;
            ins.b = fault_site(
                step_id, "store_index",
                "'" + def.name + "' did not take the element: the index must land "
                "inside the list (an element write edits, it never grows), and the "
                "element must fit the list");
        } else {
            ins.op = OpCode::StoreKey;
            ins.a = cell;
            ins.b = fault_site(step_id, "store_key",
                               "map '" + def.name +
                                   "' needs a text key, a value that fits it, and holds "
                                   "at most " + std::to_string(kRetainedCeiling) +
                                   " entries");
        }
        flow.code.push_back(ins);
        return true;
    }

    bool emit_store(FlowProgram& flow, uint64_t step_id, uint32_t cell) {
        Instruction store;
        store.op = OpCode::Store;
        store.a = cell;
        store.c = fault_site(step_id, "move_store", "the value could not be stored");
        flow.code.push_back(store);
        return true;
    }

    /* Put ONE value on the stack from an assignment's rvalue. The rvalue is always an
     * EXPRESSION now — a mesh read is `@name` / `@name.field`, bound into the flow's
     * scope by bind_entities — so this is one compile, one vocabulary. `agg_ok` says
     * the destination is a declared HMI aggregate, which may take a whole list or map
     * (copy a variable, rebuild one with a map/filter). */
    bool push_scalar(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                     ExpressionScope& scope, const Json& from, Shape expected,
                     Shape* actual = nullptr, bool agg_ok = false) {
        (void)widget;
        const uint64_t step_id = id_of(step);
        if (from.contains("expr"))
            return expression(step_id, str_or(from, "expr", "x"), ExprTier::Wire, scope,
                              expected, flow.code, flow.max_stack, actual, "from",
                              nullptr, agg_ok);
        diag(step_id, "move_source", "this assignment has no value", DiagGrade::Error,
             "from");
        return false;
    }

    /* push_scalar toward one typed destination, with the two compile-inserted enum
     * coercions (spec 6.2): text into an enum-typed field or variable becomes the
     * variant's value (a Dropdown's selected name writes back with no authored
     * transform), and an enum into a text destination renders as its variant name. */
    bool push_typed(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                    ExpressionScope& scope, const Json& from, Shape wanted,
                    uint16_t type_id, bool agg_ok = false) {
        if (wanted == Shape::Text) {
            Shape produced = Shape::Unknown;
            if (!push_scalar(widget, step, flow, scope, from, Shape::Unknown, &produced))
                return false;
            if (produced == Shape::Enum) {
                Instruction name;
                name.op = OpCode::Method;
                name.a = program_.layout.text_slots++;
                name.b = 0;
                name.small = static_cast<uint16_t>(MethodId::EnumName);
                flow.code.push_back(name);
                return true;
            }
            if (produced != Shape::Unknown && produced != Shape::Nil &&
                produced != Shape::Text) {
                diag(id_of(step), "shape",
                     "the source is " + std::string(shape_name(produced)) +
                         ", but this destination wants text",
                     DiagGrade::Error, "from");
                return false;
            }
            return true;
        }
        if (wanted != Shape::Enum || type_id == 0)
            return push_scalar(widget, step, flow, scope, from, wanted, nullptr, agg_ok);
        Shape produced = Shape::Unknown;
        if (!push_scalar(widget, step, flow, scope, from, Shape::Unknown, &produced))
            return false;
        if (produced == Shape::Text) {
            Instruction coerce;
            coerce.op = OpCode::EnumFromName;
            coerce.b = type_id;
            coerce.c = fault_site(id_of(step), "enum_name",
                                  "the text is not one of this enum's variants");
            flow.code.push_back(coerce);
            return true;
        }
        if (produced != Shape::Unknown && produced != Shape::Nil &&
            produced != Shape::Enum) {
            diag(id_of(step), "shape",
                 "the source is " + std::string(shape_name(produced)) +
                     ", but this destination wants enum",
                 DiagGrade::Error, "from");
            return false;
        }
        return true;
    }

    /* `-> local`: the destination names a variable in scope, or declares a temporary by
     * using it (spec 2.7). A whole-struct destination is filled by New or ReadEnt; a
     * field of one by StoreField; a scalar by Store. */
    bool assign_into_local(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                         ExpressionScope& scope, FlowLocals& locals) {
        const uint64_t step_id = id_of(step);
        const Json& from = step.value("from", Json::object());
        const Json& to = step.value("to", Json::object());
        const std::string name = str_or(to, "local", "");
        const std::string path = str_or(to, "path", "");
        if (name.empty()) {
            diag(step_id, "move_dest", "this move has no destination", DiagGrade::Error, "to");
            return false;
        }

        /* RESET (spec 2.6): the source `{init}` is the destination's own declared
           start. A struct variable re-runs its New (zero + authored defaults); a
           scalar or enum takes its init constant back. */
        if (from.contains("init")) {
            uint32_t cell = UINT32_MAX;
            auto found = locals.find(name);
            if (found != locals.end()) cell = found->second;
            else cell = declared_cell(widget, name);
            if (name == "x" || cell == UINT32_MAX) {
                diag(step_id, "move_source",
                     "'" + name + "' has no declared start to reset to",
                     DiagGrade::Error, "to");
                return false;
            }
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
                flow.code.push_back(zero);
                return true;
            }
            Instruction constant;
            constant.op = OpCode::Const;
            constant.a = program_.add_constant(def.initial);
            constant.c = fault_site(step_id, "move_source", "the default could not be read");
            flow.code.push_back(constant);
            flow.max_stack = std::max(flow.max_stack, 1u);
            return emit_store(flow, step_id, cell);
        }

        /* A TYPED temporary (spec 2.7): the destination carries a TypeRef, so a FRESH
           name is declared here with that type and zeroed at THIS ROW every run: the
           per-run clean value a persistent variable cannot be. On a name that already
           exists the type is a claim to check, never a redeclaration. */
        const std::string typed = str_or(to, "type", "");
        if (!typed.empty() && name != "x") {
            const int type_id = find_type_ref(typed);
            if (type_id < 0) {
                diag(step_id, "unresolved_type",
                     "type '" + typed + "' is not a type in the mesh",
                     DiagGrade::Error, "to");
                return false;
            }
            const bool fresh = locals.find(name) == locals.end() &&
                               declared_cell(widget, name) == UINT32_MAX;
            if (fresh && program_.types[type_id].kind == TypeKind::Enum) {
                const uint32_t cell = add_temp_cell(flow.flow_id, widget.id, name,
                                                    Shape::Enum);
                program_.cells[cell].type_id = static_cast<uint16_t>(type_id);
                locals[name] = cell;
                scope.names[name] = Binding{Shape::Enum, OpCode::Load, cell, 0,
                                            static_cast<uint16_t>(type_id)};
            } else if (fresh) {
                const uint32_t cell = ensure_struct_local(widget, flow, locals, scope,
                                                          name, static_cast<uint16_t>(type_id),
                                                          step_id);
                if (cell == UINT32_MAX) return false;
                Instruction zero;
                zero.op = OpCode::New;
                zero.a = cell;
                zero.b = static_cast<uint32_t>(type_id);
                zero.c = fault_site(step_id, "move_new", "the value could not be created");
                flow.code.push_back(zero);
            } else {
                const uint32_t held = locals.count(name) ? locals[name]
                                                         : declared_cell(widget, name);
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
            if (!expression(step_id, str_or(from, "expr", "x"), ExprTier::Wire, scope,
                            Shape::Unknown, flow.code, flow.max_stack, &produced,
                            "from", &produced_type)) {
                return false;
            }
            flow.code.push_back(Instruction{OpCode::StoreX});
            scope.x_shape = produced;
            scope.x_enum = produced_type;
            return true;
        }

        /* A field of a struct value: the holder must already exist (a temporary above
           this row, or a declared struct variable), because a field write says nothing
           about what type the whole value is. */
        if (!path.empty()) {
            uint32_t cell = UINT32_MAX;
            auto found = locals.find(name);
            if (found != locals.end()) cell = found->second;
            else cell = declared_cell(widget, name);
            if (cell == UINT32_MAX) {
                diag(step_id, "move_dest",
                     "'" + name + "' has no value yet at this row", DiagGrade::Error, "to");
                return false;
            }
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
            /* an aggregate field of a struct VALUE is a read-side mirror: its storage
               is the owner's, so the HMI has nowhere honest to put an edit. The
               entity's own field takes the element (at an index); a list variable
               stages anything richer. */
            if (fields[field].shape == Shape::List || fields[field].shape == Shape::Map) {
                diag(step_id, "move_dest",
                     "'" + name + "." + path + "' is an aggregate field of a struct "
                     "value, which the HMI cannot edit; write the element to the "
                     "entity's own field at an index, or stage it in a list variable",
                     DiagGrade::Error, "to");
                return false;
            }
            if (!push_typed(widget, step, flow, scope, from, fields[field].shape,
                            fields[field].type_id))
                return false;
            Instruction set;
            set.op = OpCode::StoreField;
            set.a = cell;
            set.b = static_cast<uint32_t>(field);
            set.c = fault_site(step_id, "move_field", "the field could not be set");
            flow.code.push_back(set);
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
            const std::string expr = trimmed(str_or(from, "expr", ""));
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
            const uint32_t cell = ensure_struct_local(widget, flow, locals, scope, name,
                                                      struct_type, step_id);
            if (cell == UINT32_MAX) return false;
            program_.entities[read_entity].flow_reads = true;
            Instruction ins;
            ins.op = OpCode::ReadEnt;
            ins.a = cell;
            ins.b = static_cast<uint32_t>(read_entity);
            ins.c = fault_site(step_id, "move_new", "the value could not be created");
            flow.code.push_back(ins);
            return true;
        }

        /* a scalar destination: an existing variable keeps its declared shape, a fresh
           temporary takes the source's */
        uint32_t cell = declared_cell(widget, name);
        Shape wanted = cell == UINT32_MAX ? Shape::Unknown : program_.cells[cell].shape;
        if (cell == UINT32_MAX) {
            auto found = locals.find(name);
            if (found != locals.end()) {
                cell = found->second;
                wanted = program_.cells[cell].shape;
            }
        }
        /* a DECLARED destination goes through the typed path, so an enum variable
           takes text (the Dropdown's selected name) and a text variable takes an enum
           (rendered as its name), exactly like the same-shaped fields do. A declared
           LIST or MAP variable takes a whole aggregate — an HMI cell, not a machine. */
        if (cell != UINT32_MAX) {
            if (!push_typed(widget, step, flow, scope, from, wanted,
                            program_.cells[cell].type_id, /*agg_ok=*/true))
                return false;
            return emit_store(flow, step_id, cell);
        }
        Shape produced = Shape::Unknown;
        const size_t mark = flow.code.size();
        if (!push_scalar(widget, step, flow, scope, from, wanted, &produced)) return false;
        if (cell == UINT32_MAX) {
            if (produced == Shape::Unknown || produced == Shape::Nil) {
                diag(step_id, "temp_shape",
                     "'" + name + "' cannot take its type from this source; "
                     "declare it as a variable",
                     DiagGrade::Error, "to");
                flow.code.resize(mark);
                return false;
            }
            cell = add_temp_cell(flow.flow_id, widget.id, name, produced);
            locals[name] = cell;
            scope.names[name] = Binding{produced, OpCode::Load, cell, 0};
        }
        return emit_store(flow, step_id, cell);
    }

    /* `-> entity`: the one way a value leaves a flow. The verb comes from the kind. */
    bool assign_out(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                  ExpressionScope& scope, FlowLocals& locals) {
        const uint64_t step_id = id_of(step);
        const Json& from = step.value("from", Json::object());
        const Json& to = step.value("to", Json::object());
        const int entity = resolve_entity(to, step_id, "to");
        if (entity < 0) return false;
        const EntityDef& target = program_.entities[entity];
        const Verb verb = verb_for(target.kind, str_or(step, "mode", "write"));
        if (verb == Verb::Unforce && target.kind != EntityKind::Variable) {
            diag(step_id, "move_mode", "only a variable can be unforced", DiagGrade::Error, "to");
            return false;
        }

        Instruction out;
        out.op = OpCode::MoveOut;
        out.a = static_cast<uint32_t>(entity);
        out.b = 0;
        out.small = static_cast<uint16_t>(verb);
        out.c = fault_site(step_id, "assign_out", "UNKNOWN was not sent");

        if (verb == Verb::Unforce) {
            flow.code.push_back(out);
            ++program_.layout.effect_capacity;
            return true;
        }

        /* a PARAMETERLESS target (a function whose request has no fields, a
           payload-less signal): the send itself is the whole message, so no field and
           no source are required — the schema's default (empty) request goes out.
           b = UINT32_MAX tells the VM to emit without popping a value. */
        if (target.fields.empty() && str_or(to, "path", "").empty() &&
            (target.kind == EntityKind::Function || target.kind == EntityKind::Signal)) {
            out.b = UINT32_MAX;
            flow.code.push_back(out);
            ++program_.layout.effect_capacity;
            return true;
        }

        /* a whole struct goes out as the message; anything else fills one field. The
           holder is a flow temporary or a declared struct variable, spelled as the
           degenerate expression — the rvalue is EXACTLY its bare name (a struct is
           not a stack value, so the whole-value send is recognized here). */
        const std::string source_local = bare_name(str_or(from, "expr", ""));
        uint32_t held_cell = UINT32_MAX;
        if (!source_local.empty()) {
            auto held = locals.find(source_local);
            if (held != locals.end()) held_cell = held->second;
            else held_cell = declared_cell(widget, source_local);
        }
        const bool whole = held_cell != UINT32_MAX &&
                           program_.cells[held_cell].shape == Shape::Struct;
        if (whole) {
            if (!trimmed(str_or(step, "key", "")).empty()) {
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
            flow.code.push_back(load);
            flow.max_stack = std::max(flow.max_stack, 1u);
        } else {
            const int field = find_field(entity, str_or(to, "path", ""), step_id, "to");
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
            const std::string key = trimmed(str_or(step, "key", ""));
            if (fdef.shape == Shape::Map) {
                diag(step_id, "move_dest",
                     std::string(entity_kind_name(target.kind)) + ":" + target.name +
                         "." + fdef.path +
                         " is a map field, which a mesh write cannot address",
                     DiagGrade::Error, "to");
                return false;
            }
            if (fdef.shape == Shape::List) {
                if (key.empty()) {
                    diag(step_id, "move_dest",
                         std::string(entity_kind_name(target.kind)) + ":" + target.name +
                             "." + fdef.path +
                             " is an array field; a mesh write takes ONE element — "
                             "give it an index",
                         DiagGrade::Error, "to");
                    return false;
                }
                if (target.kind != EntityKind::Variable &&
                    target.kind != EntityKind::Topic) {
                    diag(step_id, "move_dest",
                         target.kind == EntityKind::Function
                             ? "a function's arguments are sent whole with the call; "
                               "an element write addresses a topic's or a variable's "
                               "array"
                             : "a signal fires a whole event; an element write "
                               "addresses a topic's or a variable's array",
                         DiagGrade::Error, "to");
                    return false;
                }
                if (verb != Verb::Write && verb != Verb::Publish) {
                    diag(step_id, "move_mode",
                         "an array element is written, never forced",
                         DiagGrade::Error, "to");
                    return false;
                }
                if (!push_typed(widget, step, flow, scope, from, fdef.elem, 0))
                    return false;
                uint32_t key_stack = 1;
                if (!expression(step_id, key, ExprTier::Wire, scope, Shape::Num,
                                flow.code, key_stack, nullptr, "key"))
                    return false;
                flow.max_stack = std::max(flow.max_stack, key_stack + 1);
                out.op = OpCode::MoveOutElem;
                out.b = static_cast<uint32_t>(field);
                out.c = fault_site(step_id, "assign_out",
                                   "@" + target.name + "." + fdef.path +
                                       " did not take the element: the index must be a "
                                       "whole number inside the owner's array");
                flow.code.push_back(out);
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
            if (!push_typed(widget, step, flow, scope, from, fdef.shape, fdef.type_id))
                return false;
            out.b = static_cast<uint32_t>(field);
        }
        flow.code.push_back(out);
        ++program_.layout.effect_capacity;
        (void)widget;
        return true;
    }

    /* Declare (or find) a struct-holding destination and put its fields in scope, so a
     * later row can read `m.position` the way it reads any other name. A declared
     * struct variable of the same type is a legal destination (that is how a value is
     * staged across flows, spec 2.7); a declared variable of any other type is a
     * finding rather than a coercion. */
    uint32_t ensure_struct_local(const WidgetInfo& widget, FlowProgram& flow,
                                 FlowLocals& locals, ExpressionScope& scope,
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
        const uint32_t declared = declared_cell(widget, name);
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
            add_struct_cell(CellKind::Temp, widget.id, flow.flow_id, 0, name, type_id);
        locals[name] = cell;
        const std::vector<FieldDef>& fields = struct_fields(program_, type_id);
        for (uint32_t i = 0; i < fields.size(); ++i)
            scope.qualified[name + "." + fields[i].path] =
                Binding{fields[i].shape, OpCode::LoadField, cell, i, fields[i].type_id};
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
     * `widget.<slot>` rebinds to that cell for the steps below. An aggregate-shaped
     * slot (or an append/key write) still stands down whole: a shadow list is storage
     * this run has no business allocating. */
    bool shadow_slot_write(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                           ExpressionScope& scope, const std::string& slot) {
        const uint64_t step_id = id_of(step);
        auto found = widget.slots.find(slot);
        if (found == widget.slots.end()) return true;   /* claimed name, no cell: drop */
        const CellDef& def = program_.cells[found->second];
        const std::string mode = str_or(step, "mode", "write");
        if (def.shape == Shape::List || def.shape == Shape::Map || mode == "append" ||
            !trimmed(str_or(step, "key", "")).empty())
            return true;                                /* aggregate: plain stand-down */
        if (!push_typed(widget, step, flow, scope, step.value("from", Json::object()),
                        def.shape, def.type_id))
            return false;
        const uint32_t shadow =
            add_temp_cell(flow.flow_id, widget.id, "widget." + slot + "'", def.shape);
        program_.cells[shadow].type_id = def.type_id;
        if (!emit_store(flow, step_id, shadow)) return false;
        scope.qualified["widget." + slot] =
            Binding{def.shape, OpCode::Load, shadow, 0, def.type_id};
        return true;
    }

    /* `raise <event>(args)`: the one step that SPEAKS as the widget. The event must be
     * one the type declares — a gesture is the pointer's to raise — and the argument
     * expression compiles against the declared parameter's shape. The record queues on
     * the state; the scheduler dispatches it after this run halts. */
    bool compile_raise(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                       ExpressionScope& scope) {
        const uint64_t step_id = id_of(step);
        const std::string name = trimmed(str_or(step, "event", ""));
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
        /* COPY the row: the events list above is a temporary, and a pointer into it
           would dangle the moment the loop ends */
        Json row;
        bool declared = false;
        if (widget.type)
            for (const Json& r : widget.type->value("events", Json::array()))
                if (r.value("name", "") == name) { row = r; declared = true; break; }
        if (!declared) {
            diag(step_id, "raise_event",
                 "this type declares no event '" + name +
                     "'; declare it in the events section first",
                 DiagGrade::Error, "event");
            return false;
        }
        const Json params = row.value("params", Json::array());
        if (params.is_array() && params.size() > 1) {
            diag(step_id, "raise_event",
                 "'" + name + "' declares " + std::to_string(params.size()) +
                     " parameters; an event carries one for now",
                 DiagGrade::Error, "event");
            return false;
        }
        bool has_arg = false;
        if (params.is_array() && params.size() == 1) {
            const std::string pname = str_or(params[0], "name", "value");
            const Shape shape = shape_from_name(str_or(params[0], "shape", ""));
            const Json args = step.value("args", Json::object());
            const std::string text =
                args.is_object() ? trimmed(str_or(args, pname.c_str(), "")) : "";
            if (text.empty()) {
                diag(step_id, "raise_args",
                     "raise " + name + " needs " + pname, DiagGrade::Error, "args");
                return false;
            }
            if (!expression(step_id, text, ExprTier::Wire, scope, shape, flow.code,
                            flow.max_stack, nullptr, "args"))
                return false;
            has_arg = true;
        }
        uint32_t at = UINT32_MAX;
        for (uint32_t i = 0; i < program_.raises.size(); ++i)
            if (program_.raises[i].widget_id == widget.id &&
                program_.raises[i].event == name)
                at = i;
        if (at == UINT32_MAX) {
            program_.raises.push_back(RaiseDef{widget.id, name});
            at = static_cast<uint32_t>(program_.raises.size() - 1);
        }
        Instruction ins;
        ins.op = OpCode::Raise;
        ins.a = at;
        ins.b = has_arg ? 1 : 0;
        ins.c = fault_site(step_id, "raise",
                           "the raise queue is full (events kept raising each other)");
        flow.code.push_back(ins);
        ++program_.layout.raise_capacity;
        return true;
    }

    /* `notify <text> [for <ms>]`: pop a notification up on every connected view. The
     * message is a DISPLAY-tier expression — it is for a human, so text joining and the
     * formatting vocabulary are exactly what it is made of — and `ms`, when authored,
     * is how long it stays; absent, the view scales the time with the length. */
    bool compile_notify(const Json& step, FlowProgram& flow, ExpressionScope& scope) {
        const uint64_t step_id = id_of(step);
        const std::string text = trimmed(str_or(step, "text", ""));
        if (text.empty()) {
            diag(step_id, "notify_text", "notify says nothing; give it a message",
                 DiagGrade::Error, "text");
            return false;
        }
        Shape actual = Shape::Unknown;
        if (!expression(step_id, text, ExprTier::Display, scope, Shape::Unknown,
                        flow.code, flow.max_stack, &actual, "text"))
            return false;
        if (actual == Shape::List || actual == Shape::Map) {
            diag(step_id, "notify_text",
                 "a notification is one line of text, not a " +
                     std::string(shape_name(actual)),
                 DiagGrade::Error, "text");
            return false;
        }
        const std::string ms = trimmed(str_or(step, "ms", ""));
        if (!ms.empty() &&
            !expression(step_id, ms, ExprTier::Display, scope, Shape::Num, flow.code,
                        flow.max_stack, nullptr, "ms"))
            return false;
        Instruction ins;
        ins.op = OpCode::Notify;
        ins.b = ms.empty() ? 0 : 1;
        ins.c = fault_site(step_id, "notify", "notify needs a message it can render");
        flow.code.push_back(ins);
        ++program_.layout.notice_capacity;
        return true;
    }

    /* `param` is the trigger's signature (null = a nullary event); `claimed` is set for
     * TYPE BEHAVIOR: a slot-writing step whose slot is already claimed (a feed, an
     * authored flow) is DROPPED — per step, so the raise beside it still runs and a fed
     * control still speaks `changed` while standing down its local echo. */
    bool compile_steps(const WidgetInfo& widget, const Json& flow_node, FlowProgram& flow,
                       const EventParam* param = nullptr,
                       const std::unordered_map<std::string, std::string>* claimed = nullptr) {
        ExpressionScope scope = scope_for(widget, Shape::Unknown);
        /* the mesh, under its '@' spellings: a flow's rvalue or guard reads an entity
           by naming it, exactly as a slot expression does (same binding, same VM read
           off the last-value cache / the aggregate mirrors) */
        bind_entities(scope);
        if (param)
            scope.names[param->name] = Binding{param->shape, OpCode::LoadArg, 0, 0};
        FlowLocals locals;
        for (const Json& step : flow_node.value("do", Json::array())) {
            const uint64_t step_id = id_of(step);
            const std::string kind = step.value("kind", "");
            if (kind == "assign") {
                if (claimed) {
                    const std::string slot = slot_of(step.value("to", Json::object()));
                    if (!slot.empty() && claimed->find(slot) != claimed->end()) {
                        /* THE WRITE STILL HOLDS WITHIN THIS RUN. The claimed cell stays
                           the feed's, but program order must not lie: a later step
                           reading widget.<slot> reads what this flow just wrote — the
                           store lands in a run-local SHADOW and the name follows it,
                           so `value = false; raise changed(widget.value)` speaks false
                           on a fed instance instead of the fed value. An aggregate
                           write (append, key, list/map slot) still just stands down. */
                        if (!shadow_slot_write(widget, step, flow, scope, slot))
                            return false;
                        continue;
                    }
                }
                if (!compile_assign(widget, step, flow, scope, locals)) return false;
            } else if (kind == "raise") {
                if (!compile_raise(widget, step, flow, scope)) return false;
            } else if (kind == "notify") {
                if (!compile_notify(step, flow, scope)) return false;
            } else if (kind == "gate") {
                if (!expression(step_id, str_or(step, "a", ""), ExprTier::Wire, scope,
                                Shape::Bool, flow.code, flow.max_stack))
                    return false;
                flow.code.push_back(Instruction{OpCode::Gate});
            } else if (kind == "deadband") {
                Instruction ins;
                ins.op = OpCode::Deadband;
                ins.a = state_site(StateSiteKind::Deadband, flow.flow_id, step_id);
                ins.b = program_.add_constant(Value::number(num_or(step, "a", 0.0)));
                ins.c = fault_site(step_id, "deadband", "deadband needs a numeric value");
                flow.code.push_back(ins);
            } else if (kind == "throttle") {
                Instruction ins;
                ins.op = OpCode::Throttle;
                ins.a = state_site(StateSiteKind::Throttle, flow.flow_id, step_id);
                ins.b = static_cast<uint32_t>(std::max(0.0, step.value("a", 0.0)));
                ins.c = fault_site(step_id, "throttle", "throttle state is invalid");
                flow.code.push_back(ins);
            } else if (kind == "debounce" || kind == "delay") {
                Instruction ins;
                ins.op = OpCode::Suspend;
                ins.a = state_site(StateSiteKind::Suspend, flow.flow_id, step_id);
                ins.b = static_cast<uint32_t>(std::max(0.0, step.value("a", 0.0)));
                ins.small = kind == "debounce" ? 1 : 0;
                ins.c = fault_site(step_id, "suspend", "suspension state is invalid");
                flow.code.push_back(ins);
            } else if (kind == "tmr_start" || kind == "tmr_cancel") {
                const int timer = resolve_timer(widget, str_or(step, "timer", ""), step_id);
                if (timer < 0) return false;
                Instruction ins;
                ins.op = kind == "tmr_start" ? OpCode::TmrStart : OpCode::TmrCancel;
                ins.a = static_cast<uint32_t>(timer);
                ins.c = fault_site(step_id, "timer", "timer state is invalid");
                flow.code.push_back(ins);
            } else {
                diag(step_id, "step_kind", "unknown step kind '" + kind + "'");
                return false;
            }
        }
        flow.code.push_back(Instruction{OpCode::Halt});
        flow.worst_steps = static_cast<uint32_t>(flow.code.size());
        /* an entity read that arrived through an EXPRESSION (@name in an rvalue, a
           guard, a keep/key) must stamp the same subscription a structural read did:
           the mesh only consumes what something declares it reads */
        stamp_flow_reads(flow.code);
        return true;
    }

    /* every mesh read AND write this compiled code performs, marked so the mesh
     * consumes the entity (lambda bodies included — an ITERATE's sub can read the mesh
     * too). Writes stamp so apply() creates the accessor up front: a write through an
     * accessor created at the moment of the first effect finds no owner matched yet */
    void stamp_flow_reads(const std::vector<Instruction>& code) {
        for (const Instruction& ins : code) {
            if (ins.op == OpCode::LoadEnt) {
                if (ins.a < program_.entities.size())
                    program_.entities[ins.a].flow_reads = true;
            } else if (ins.op == OpCode::ReadEnt) {
                if (ins.b < program_.entities.size())
                    program_.entities[ins.b].flow_reads = true;
            } else if (ins.op == OpCode::MoveOut) {
                if (ins.a < program_.entities.size())
                    program_.entities[ins.a].flow_writes = true;
            } else if (ins.op == OpCode::Iterate && ins.a < program_.subs.size()) {
                stamp_flow_reads(program_.subs[ins.a].code);
            }
        }
    }

    void build_flows() {
        for (WidgetInfo& widget : widgets_) {
            auto flows = widget.node->find("flows");
            if (flows == widget.node->end() || !flows->is_array()) continue;
            for (const Json& node : *flows) {
                const uint64_t flow_id = id_of(node);
                const Json& triggers = node.value("when", Json::array());
                if (!triggers.is_array() || triggers.empty()) {
                    diag(flow_id, "trigger", "flow has no trigger");
                    continue;
                }
                const uint32_t group = program_.layout.fired_groups++;
                for (const Json& trigger : triggers) {
                    FlowProgram flow;
                    flow.widget_id = widget.id;
                    flow.flow_id = flow_id;
                    flow.group = group;
                    flow.runtime_index = static_cast<uint32_t>(program_.flows.size());
                    flow.first_only =
                        triggers.size() > 1 && node.value("when_mode", "first") == "first";
                    EventParam param;
                    bool has_param = false;
                    if (trigger.value("kind", "") == "timer") {
                        const std::string name = trigger.value("var", "");
                        const int timer = resolve_timer(widget, name, flow_id);
                        if (timer < 0) continue;
                        flow.event = program_.timers[timer].event;
                        program_.timers[timer].rearm_groups.push_back(group);
                    } else if (trigger.value("kind", "") == "every") {
                        if (!cadence_trigger(widget, trigger, flow_id, flow)) continue;
                    } else {
                        flow.event = trigger.value("name", "");
                        /* PARTS ARE PRIVATE ANATOMY: an instance flow's trigger never
                           names one — the widget-level channel and the component's own
                           events are its whole vocabulary */
                        const std::string part = trigger.value("part", "");
                        if (!part.empty()) {
                            diag(flow_id, "event",
                                 "'" + part + "' is a part of this widget's component; "
                                 "part channels live in the component's behavior",
                                 DiagGrade::Error);
                            continue;
                        }
                        if (!event_signature(widget, flow.event, "", flow_id,
                                             /*in_behavior=*/false, param, has_param))
                            continue;
                        flow.hold_ticks =
                            static_cast<uint32_t>(std::max(0.0, num_or(trigger, "hold_ms", 600.0)));
                        const Json every = trigger.value("every_ms", Json());
                        flow.every_ticks =
                            every.is_number()
                                ? static_cast<uint32_t>(std::max(0.0, every.get<double>()))
                                : 0;
                    }
                    if (!compile_steps(widget, node, flow, has_param ? &param : nullptr)) {
                        const std::string message = "flow could not be compiled";
                        flow.code.clear();
                        Instruction fault;
                        fault.op = OpCode::Fault;
                        fault.a = fault_site(flow_id, "compile_fault", message);
                        flow.code.push_back(fault);
                        flow.code.push_back(Instruction{OpCode::Halt});
                        flow.max_stack = 1;
                        flow.worst_steps = 2;
                    }
                    program_.layout.stack_values =
                        std::max(program_.layout.stack_values, flow.max_stack);
                    program_.flows.push_back(std::move(flow));
                }
            }
        }
    }

    /* Who already writes each of a widget's slots, and what to call it in a diagnostic.
     * One writer per slot is the rule that keeps a slot deterministic (spec 2.3); this is
     * where it is decided, once, at compile time. */
    std::unordered_map<std::string, std::string> claimed_slots(const WidgetInfo& widget) const {
        std::unordered_map<std::string, std::string> out;
        /* a slot whose authored value became a STANDING program is spoken for: its
           expression is the writer (a constant folded back into the start is not) */
        for (const SlotProgram& sp : program_.slot_programs)
            if (sp.widget_id == widget.id)
                out[sp.slot] = "its value is a bound expression";
        auto flows = widget.node->find("flows");
        if (flows != widget.node->end() && flows->is_array())
            for (const Json& flow : *flows)
                for (const std::string& slot : written_slots(flow))
                    out[slot] = "a flow on this widget writes it";
        return out;
    }

    /* The slots one flow writes: the destinations of its moves that name a slot. One
     * step kind to scan, so precedence is decided from one place (spec 2.3). */
    std::vector<std::string> written_slots(const Json& flow) const {
        std::vector<std::string> out;
        for (const Json& step : flow.value("do", Json::array())) {
            if (step.value("kind", "") != "assign") continue;
            const std::string slot = slot_of(step.value("to", Json::object()));
            if (!slot.empty()) out.push_back(slot);
        }
        return out;
    }

    /* A widget type's DEFAULT BEHAVIOR: ordinary flows shipped in the registry row rather
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
        for (WidgetInfo& widget : widgets_) {
            if (!widget.type) continue;
            const Json& behavior = widget.type->value("behavior", Json::array());
            if (!behavior.is_array() || behavior.empty()) continue;
            /* stand-down is PER STEP now (compile_steps drops the claimed slot writes),
               so a fed control still raises `changed` while its local echo yields */
            const std::unordered_map<std::string, std::string> claimed = claimed_slots(widget);
            for (const Json& node : behavior) {
                for (const Json& trigger : node.value("when", Json::array())) {
                    FlowProgram flow;
                    flow.widget_id = widget.id;
                    /* the widget's own id: document ids are unique, so this cannot collide
                       with an authored flow, and it keeps state-site identity stable */
                    flow.flow_id = widget.id;
                    flow.group = program_.layout.fired_groups++;
                    flow.runtime_index = static_cast<uint32_t>(program_.flows.size());
                    EventParam param;
                    bool has_param = false;
                    if (trigger.value("kind", "") == "every") {
                        if (!cadence_trigger(widget, trigger, widget.id, flow)) continue;
                    } else {
                        flow.event = trigger.value("name", "");
                        /* behavior is the ONE place a trigger may name a part channel */
                        flow.part = trigger.value("part", "");
                        if (!event_signature(widget, flow.event, flow.part, widget.id,
                                             /*in_behavior=*/true, param, has_param))
                            continue;
                        flow.hold_ticks = static_cast<uint32_t>(
                            std::max(0.0, num_or(trigger, "hold_ms", 600.0)));
                    }
                    if (!compile_steps(widget, node, flow, has_param ? &param : nullptr,
                                       &claimed))
                        continue;
                    program_.layout.stack_values =
                        std::max(program_.layout.stack_values, flow.max_stack);
                    program_.flows.push_back(std::move(flow));
                }
            }
        }
    }

    const Document& document_;
    const Json& registry_;
    const MeshPort& mesh_;
    Program program_;
    bool has_errors_ = false;
    Json empty_object_ = Json::object();
    std::unordered_map<std::string, uint32_t> globals_;
    std::unordered_map<std::string, std::string> tokens_;     /* token name -> dark value */
    std::unordered_map<std::string, uint16_t> struct_keys_;   /* schema key -> type id */
    std::unordered_map<std::string, uint16_t> struct_names_;  /* root name -> type id */
    std::set<std::string> ambiguous_;                         /* reported once each */
    std::unordered_map<std::string, uint32_t> global_timers_;
    std::vector<WidgetInfo> widgets_;
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

CompileResult compile_document(const Document& document, const Json& widget_registry,
                               const MeshPort& mesh) {
    return Compiler(document, widget_registry, mesh).run();
}

} // namespace hmi

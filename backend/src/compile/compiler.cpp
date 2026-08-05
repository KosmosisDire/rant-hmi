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

std::string trimmed(const std::string& text) {
    size_t from = 0, to = text.size();
    while (from < to && std::isspace(static_cast<unsigned char>(text[from]))) ++from;
    while (to > from && std::isspace(static_cast<unsigned char>(text[to - 1]))) --to;
    return text.substr(from, to - from);
}

/* the locals a flow has declared so far, by name. `x` is not in here: it is the flow's
 * first local by the spec's reckoning (2.6) but the VM keeps it in a register, so a move
 * naming it lowers to StoreX and nothing else changes. */
using FlowLocals = std::unordered_map<std::string, uint32_t>;

struct WidgetInfo {
    uint64_t id = 0;
    uint64_t page = 0;
    const Json* node = nullptr;
    const Json* type = nullptr;
    std::unordered_map<std::string, uint32_t> locals;
    std::unordered_map<std::string, uint32_t> slots;
    std::unordered_map<std::string, uint32_t> timers;
};

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
        build_feeds();
        build_event_values();
        /* The type's defaults are compiled FIRST, so they run first: by the time an
         * authored flow on the same event runs, the widget's own state already reflects
         * the gesture and `widget.<slot>` agrees with `x`. Two readings of the same
         * event would be worse than either one. */
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
            if (!entity.fields.empty()) entity.type_id = intern_struct(entity, e);
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
                            Json initial = slot.value("default", Json());
                            /* the slot's NAME is its address: a part's property is stored
                               nested under the part, so the lookup walks the dots */
                            if (const Json* override = authored_slot(authored, name))
                                initial = *override;
                            if (shape == Shape::Color) initial = resolve_token(info.id, name, initial);
                            check_variants(info.id, name, slot, initial);
                            /* an AGGREGATE slot's authored value has its own accepted
                               spellings and lands in the cell's constant run, not in
                               the scalar initial, which stays Nil */
                            const bool aggregate =
                                shape == Shape::List || shape == Shape::Map;
                            std::vector<Value> list_init;
                            const bool has_list =
                                shape == Shape::List
                                    ? list_slot_initial(info.id, name, initial, list_init)
                                    : shape == Shape::Map &&
                                          map_slot_initial(info.id, name, initial,
                                                           list_init);
                            info.slots[name] =
                                add_cell(CellKind::Slot, info.id, info.id, name, shape,
                                         aggregate ? Json() : initial, false);
                            if (has_list) {
                                program_.cells[info.slots[name]].has_list = true;
                                program_.cells[info.slots[name]].list_init =
                                    std::move(list_init);
                            }
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
        flow.event_shape = Shape::Unknown;
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
     * conflating them left every enum slot holding Nil. */
    Shape slot_shape(const Json& slot) const {
        const std::string name = slot.value("shape", "");
        return name == "enum" ? Shape::Text : shape_from_name(name);
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
                           "or as variants(Type.field), naming an enum in the mesh"};
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

    Shape var_shape(const std::string& type) const {
        if (type == "f64") return Shape::Num;
        if (type == "bool") return Shape::Bool;
        if (type == "str") return Shape::Text;
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

    ExpressionScope scope_for(const WidgetInfo& widget, Shape x_shape) {
        ExpressionScope scope;
        scope.x_shape = x_shape;
        for (const auto& item : globals_) bind_variable(scope, item.first, item.second);
        for (const auto& item : widget.locals) bind_variable(scope, item.first, item.second);
        for (const auto& item : global_timers_) bind_timer(scope, item.first, item.second);
        for (const auto& item : widget.timers) bind_timer(scope, item.first, item.second);
        for (const auto& item : widget.slots) {
            const CellDef& cell = program_.cells[item.second];
            scope.qualified["widget." + item.first] =
                Binding{cell.shape, OpCode::Load, item.second, 0};
        }
        return scope;
    }

    bool expression(uint64_t node, const std::string& text, ExprTier tier,
                    const ExpressionScope& scope, Shape expected,
                    std::vector<Instruction>& code, uint32_t& max_stack,
                    Shape* actual = nullptr, const std::string& where = "",
                    uint16_t* enum_out = nullptr) {
        ExpressionResult result;
        std::string error;
        ProgramEmit emit(program_);
        if (!compile_expression(text, tier, scope, emit, code, result, error)) {
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

    Shape event_shape(const WidgetInfo& widget, const std::string& event, uint64_t flow) {
        if (!widget.type) return Shape::Unknown;
        for (const Json& row : widget.type->value("events", Json::array()))
            if (row.value("name", "") == event)
                return shape_from_name(row.value("x", ""));
        diag(flow, "event", "widget type has no event '" + event + "'");
        return Shape::Unknown;
    }

    void build_feeds() {
        for (WidgetInfo& widget : widgets_) {
            auto feeds = widget.node->find("feeds");
            if (feeds == widget.node->end() || !feeds->is_array()) continue;
            for (const Json& node : *feeds) {
                FeedProgram feed;
                feed.widget_id = widget.id;
                feed.page_id = widget.page;
                feed.feed_id = id_of(node);
                const std::string slot = str_or(node, "slot", "");
                auto destination = widget.slots.find(slot);
                if (destination == widget.slots.end()) {
                    diag(feed.feed_id, "feed_slot", "widget has no slot '" + slot + "'",
                         DiagGrade::Error, "slot");
                    continue;
                }
                feed.cell = destination->second;
                /* A FED slot starts UNKNOWN: what the instance authored is not this
                   cell's value, the source is, and showing the authored constant until
                   the first update reads as live data that is not. A list slot's
                   authored constant goes the same way. */
                program_.cells[feed.cell].initial = Value::nil();
                program_.cells[feed.cell].has_list = false;
                program_.cells[feed.cell].list_init.clear();
                const Json& ref = node["src"];
                const std::string kind = ref.value("kind", "");

                /* NO SOURCE: the transform stands alone as a COMPUTED binding, an
                 * expression over the widget's scope (variables, widget.<slot>)
                 * re-evaluated every tick; x is Nil, there is nothing for it to be */
                if (!ref.is_object() || ref.value("name", "").empty()) {
                    const std::string xf = str_or(node, "xf", "");
                    if (xf.empty()) {
                        diag(feed.feed_id, "feed_source",
                             "pick a source, or write an expression",
                             DiagGrade::Error, "src");
                        continue;
                    }
                    feed.entity = UINT32_MAX;
                    feed.source_cell = UINT32_MAX;
                    ExpressionScope scope = scope_for(widget, Shape::Unknown);
                    if (!expression(feed.feed_id, xf, ExprTier::Display, scope,
                                    program_.cells[feed.cell].shape, feed.code,
                                    feed.max_stack, nullptr, "xf"))
                        continue;
                    Instruction store;
                    store.op = OpCode::Store;
                    store.a = feed.cell;
                    store.c = fault_site(feed.feed_id, "feed_store",
                                         "feed value could not be stored");
                    feed.code.push_back(store);
                    feed.code.push_back(Instruction{OpCode::Halt});
                    program_.layout.stack_values =
                        std::max(program_.layout.stack_values, feed.max_stack);
                    program_.feeds.push_back(std::move(feed));
                    continue;
                }

                ExpressionScope scope =
                    scope_for(widget, kind == "L" ? program_.cells[feed.cell].shape
                                                  : Shape::Unknown);
                if (kind == "L") {
                    const std::string name = ref.value("name", "");
                    auto local = widget.locals.find(name);
                    auto global = globals_.find(name);
                    uint32_t source = UINT32_MAX;
                    if (local != widget.locals.end()) source = local->second;
                    else if (global != globals_.end()) source = global->second;
                    else {
                        diag(feed.feed_id, "feed_source", "HMI variable '" + name + "' is unresolved",
                             DiagGrade::Error, "src");
                        continue;
                    }
                    feed.entity = UINT32_MAX;
                    feed.source_cell = source;
                    scope.x_shape = program_.cells[source].shape;
                    scope.x_enum = program_.cells[source].type_id;
                    /* a TIMER source: x reads the timer table by field, so the
                       scope carries which timer this is */
                    if (scope.x_shape == Shape::Timer) {
                        const int timer = resolve_timer(widget, name, feed.feed_id);
                        if (timer < 0) continue;
                        scope.x_timer = static_cast<uint32_t>(timer);
                    }
                } else {
                    const int entity = resolve_entity(ref, feed.feed_id, "src");
                    if (entity < 0) continue;
                    feed.entity = static_cast<uint32_t>(entity);
                    const std::vector<FieldDef>& readable =
                        feed_fields(program_.entities[feed.entity]);
                    const std::string path = str_or(node, "path", "");
                    if (path.empty() && readable.size() > 1) {
                        /* the WHOLE message as the source: x is a struct, its fields
                           qualified bindings reading the entity's last-value cache, so
                           `rgb(x.r, x.g, x.b)` pulls a color struct in as a color. A
                           function's response is not cached, so it stays per-field. */
                        if (program_.entities[feed.entity].kind == EntityKind::Function) {
                            diag(feed.feed_id, "feed_source",
                                 "a function's response is read field by field; pick one",
                                 DiagGrade::Error, "path");
                            continue;
                        }
                        feed.field = UINT32_MAX;
                        scope.x_shape = Shape::Struct;
                        for (uint32_t i = 0; i < readable.size(); ++i)
                            scope.qualified["x." + readable[i].path] =
                                Binding{readable[i].shape, OpCode::LoadEnt, feed.entity,
                                        i, readable[i].type_id};
                        if (str_or(node, "xf", "").empty() &&
                            node.value("cases", Json::array()).empty()) {
                            diag(feed.feed_id, "feed_source",
                                 "a whole message cannot fill a slot by itself; write a "
                                 "transform over x.<field>",
                                 DiagGrade::Error, "xf");
                            continue;
                        }
                    } else {
                        const int field = find_field(feed.entity, path, feed.feed_id,
                                                     "path", /*response=*/true);
                        if (field < 0) continue;
                        feed.field = static_cast<uint32_t>(field);
                        const FieldDef& source_field = readable[feed.field];
                        scope.x_shape = source_field.shape;
                        scope.x_enum = source_field.type_id;
                        scope.x_elem = source_field.elem;
                    }
                    if (program_.entities[feed.entity].kind == EntityKind::Function) {
                        const double hz = num_or(node, "poll_hz", 0.0);
                        feed.poll_ms = hz > 0.0
                            ? std::max(10u, static_cast<uint32_t>(std::lround(1000.0 / hz)))
                            : 1000u;
                    }
                }
                /* discrete PATTERN MATCHING (spec 2.4): with `cases`, each arm compares
                 * x against a scalar and runs its own transform; the feed's xf is the
                 * else. Coverage is checked, so a missed variant is a finding. */
                const Json cases = node.value("cases", Json::array());
                if (cases.is_array() && !cases.empty()) {
                    if (!compile_feed_cases(node, feed, scope, cases)) continue;
                    program_.layout.stack_values =
                        std::max(program_.layout.stack_values, feed.max_stack);
                    program_.feeds.push_back(std::move(feed));
                    continue;
                }

                std::string xf = str_or(node, "xf", "");
                /* the one automatic coercion (spec 6.2): an enum-shaped source feeding a
                 * text slot reads as its variant name, so a Dropdown bound to an enum
                 * field needs no authored transform */
                if (xf.empty() && scope.x_shape == Shape::Enum &&
                    program_.cells[feed.cell].shape == Shape::Text)
                    xf = "x.name";
                bool ok = true;
                if (xf.empty()) {
                    /* no transform: the source value stores as-is, so the shapes must
                     * already agree; anything else was a silent runtime store fault */
                    const Shape wanted = program_.cells[feed.cell].shape;
                    if (scope.x_shape != Shape::Unknown && wanted != Shape::Unknown &&
                        scope.x_shape != wanted) {
                        diag(feed.feed_id, "shape",
                             "the source is " + std::string(shape_name(scope.x_shape)) +
                                 " but the slot wants " + shape_name(wanted) +
                                 "; add a transform",
                             DiagGrade::Error, "xf");
                        continue;
                    }
                    feed.code.push_back(Instruction{OpCode::LoadX});
                    feed.max_stack = 1;
                } else {
                    ok = expression(feed.feed_id, xf, ExprTier::Display, scope,
                                    program_.cells[feed.cell].shape, feed.code, feed.max_stack,
                                    nullptr, "xf");
                }
                if (!ok) continue;
                Instruction store;
                store.op = OpCode::Store;
                store.a = feed.cell;
                store.c = fault_site(feed.feed_id, "feed_store", "feed value could not be stored");
                feed.code.push_back(store);
                feed.code.push_back(Instruction{OpCode::Halt});
                program_.layout.stack_values =
                    std::max(program_.layout.stack_values, feed.max_stack);
                program_.feeds.push_back(std::move(feed));
            }
        }
    }

    /* A feed's case arms (spec 2.4): CONDITIONS only, first match wins, top to bottom.
     *
     *   LoadX; JmpNil -> NIL
     *   arm i: <test_i>; JmpFalse -> arm i+1; <xf_i>; Jmp -> STORE
     *   <else xf>; Jmp -> STORE
     *   NIL: Const(nil)                  (the Nil bail-out)
     *   STORE: Store; Halt
     *
     * Every arm is {test, xf}: a boolean expression over x (`x == ._None`,
     * `x.running`, `x[8] == 4100`). The old value-matching arms ({when}) are gone,
     * and with them the coverage analysis: conditions cannot be enumerated, so an
     * empty else stands only where the value can PASS THROUGH unchanged. */
    bool compile_feed_cases(const Json& node, FeedProgram& feed, ExpressionScope& scope,
                            const Json& cases) {
        const Shape wanted = program_.cells[feed.cell].shape;
        const Shape source = scope.x_shape;
        std::vector<uint32_t> ends;

        /* the Nil bail guards a SCALAR x; a whole-message feed's x is Nil by design
           (its fields ride qualified bindings), and a TIMER's state lives in the
           timer table rather than the x value, so neither is gated on it */
        uint32_t bail = UINT32_MAX;
        if (source != Shape::Struct && source != Shape::Timer) {
            feed.code.push_back(Instruction{OpCode::LoadX});
            bail = static_cast<uint32_t>(feed.code.size());
            feed.code.push_back(Instruction{OpCode::JmpNil});
        }
        feed.max_stack = std::max(feed.max_stack, 2u);

        uint32_t index = 0;
        for (const Json& entry : cases) {
            const std::string where = "case" + std::to_string(index);
            const std::string test = entry.is_object() ? str_or(entry, "test", "") : "";
            if (test.empty()) {
                diag(feed.feed_id, "case_when",
                     entry.is_object() && entry.contains("when")
                         ? "value matching is gone; write a condition over x"
                         : "write this case's condition",
                     DiagGrade::Error, where);
                return false;
            }
            if (!expression(feed.feed_id, test, ExprTier::Display, scope, Shape::Bool,
                            feed.code, feed.max_stack, nullptr, where))
                return false;
            const uint32_t skip = static_cast<uint32_t>(feed.code.size());
            Instruction branch;
            branch.op = OpCode::JmpFalse;
            branch.c = fault_site(feed.feed_id, "case_when", "the case could not compare");
            feed.code.push_back(branch);
            const std::string xf = str_or(entry, "xf", "");
            if (xf.empty()) {
                diag(feed.feed_id, "expression", "this case needs an expression",
                     DiagGrade::Error, where);
                return false;
            }
            if (!expression(feed.feed_id, xf, ExprTier::Display, scope, wanted,
                            feed.code, feed.max_stack, nullptr, where))
                return false;
            ends.push_back(static_cast<uint32_t>(feed.code.size()));
            feed.code.push_back(Instruction{OpCode::Jmp});
            feed.code[skip].a = static_cast<uint32_t>(feed.code.size());
            ++index;
        }

        /* The ELSE arm. An EMPTY else means what an empty inline transform means: the
           value PASSES THROUGH (an enum into a text slot as its name), so cases read
           as "override these, show the rest as themselves". Where pass-through is
           impossible (an enum into a color), the else must be written. */
        const std::string otherwise = str_or(node, "xf", "");
        const bool passes =
            otherwise.empty() &&
            (source == Shape::Unknown || wanted == Shape::Unknown || source == wanted ||
             (source == Shape::Enum && wanted == Shape::Text));
        if (!otherwise.empty() || passes) {
            const std::string tail =
                !otherwise.empty() ? otherwise
                : source == Shape::Enum && wanted == Shape::Text ? "x.name"
                                                                 : "x";
            if (!expression(feed.feed_id, tail, ExprTier::Display, scope, wanted,
                            feed.code, feed.max_stack, nullptr, "xf"))
                return false;
            ends.push_back(static_cast<uint32_t>(feed.code.size()));
            feed.code.push_back(Instruction{OpCode::Jmp});
        } else {
            diag(feed.feed_id, "cases",
                 "the value cannot pass through as-is; write the else",
                 DiagGrade::Error, "xf");
            return false;
        }

        /* the Nil bail-out, which full coverage also falls into if it is ever wrong */
        if (bail != UINT32_MAX)
            feed.code[bail].a = static_cast<uint32_t>(feed.code.size());
        Instruction nil;
        nil.op = OpCode::Const;
        nil.a = program_.add_constant(Value::nil());
        feed.code.push_back(nil);
        feed.max_stack = std::max(feed.max_stack, 1u);

        for (uint32_t at : ends) feed.code[at].a = static_cast<uint32_t>(feed.code.size());
        Instruction store;
        store.op = OpCode::Store;
        store.a = feed.cell;
        store.c = fault_site(feed.feed_id, "feed_store", "feed value could not be stored");
        feed.code.push_back(store);
        feed.code.push_back(Instruction{OpCode::Halt});
        return true;
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
    bool compile_move(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                      ExpressionScope& scope, FlowLocals& locals) {
        const uint64_t step_id = id_of(step);
        const Json& from = step.value("from", Json::object());
        const Json& to = step.value("to", Json::object());
        const SideKind source = side_kind(from);
        if (source == SideKind::None) {
            diag(step_id, "move_source", "this move has no source", DiagGrade::Error, "from");
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
                return aggregate_move(widget, step, flow, scope, found->second, appends,
                                      keep, key);
            return push_typed(widget, step, flow, scope, from,
                              program_.cells[found->second].shape, 0) &&
                   emit_store(flow, step_id, found->second);
        }

        if (to.contains("local")) {
            if (appends || !key.empty()) {
                const std::string name = str_or(to, "local", "");
                uint32_t cell = UINT32_MAX;
                auto found = locals.find(name);
                if (found != locals.end()) cell = found->second;
                else cell = declared_cell(widget, name);
                if (cell == UINT32_MAX) {
                    diag(step_id, "move_dest",
                         (appends ? "append writes into a list variable or a list slot; '"
                                  : "a keyed write needs a map variable or a map slot; '") +
                             name + "' is not declared",
                         DiagGrade::Error, "to");
                    return false;
                }
                return aggregate_move(widget, step, flow, scope, cell, appends, keep, key);
            }
            return move_into_local(widget, step, flow, scope, locals);
        }
        if (to.contains("kind")) {
            if (appends || !key.empty()) {
                diag(step_id, "move_dest",
                     "a mesh entity takes a whole value; append writes into a list "
                     "variable or a list slot, and a keyed write into a map",
                     DiagGrade::Error, "to");
                return false;
            }
            return move_out(widget, step, flow, scope, locals);
        }
        diag(step_id, "move_dest", "this move has no destination", DiagGrade::Error, "to");
        return false;
    }

    /* APPEND or KEYED WRITE into an aggregate cell. Both push the ELEMENT first and the
     * bound (keep) or the address (key) after it, because the VM pops what was pushed
     * last: one instruction shape, two verbs.
     *
     * The source is a SCALAR either way. A list into an append would be asking to
     * replace the list, which is what an ordinary write already is, and a nested
     * aggregate has no representation at all — so both are refused where the shape can
     * be seen at compile time. */
    bool aggregate_move(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                        ExpressionScope& scope, uint32_t cell, bool appends,
                        const std::string& keep, const std::string& key) {
        const uint64_t step_id = id_of(step);
        const Json& from = step.value("from", Json::object());
        const CellDef& def = program_.cells[cell];
        const Shape wanted = appends ? Shape::List : Shape::Map;
        if (def.shape != wanted) {
            diag(step_id, "move_dest",
                 "'" + def.name + "' is " + shape_name(def.shape) + "; " +
                     (appends ? "append writes into a list variable or a list slot"
                              : "a keyed write needs a map variable or a map slot"),
                 DiagGrade::Error, "to");
            return false;
        }
        Shape produced = Shape::Unknown;
        if (!push_scalar(widget, step, flow, scope, from, Shape::Unknown, &produced))
            return false;
        if (produced == Shape::List || produced == Shape::Map ||
            produced == Shape::Struct) {
            diag(step_id, "shape",
                 appends ? "append takes one element; to replace the list write it whole"
                         : "a map holds scalars by key; a whole aggregate is not a value",
                 DiagGrade::Error, "from");
            return false;
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
                          "' could not append: an append takes ONE element, and a keep "
                          "that is not a number leaves the list unbounded to the " +
                          std::to_string(kRetainedCeiling) + "-element ceiling");
            flow.code.push_back(ins);
            return true;
        }
        /* likewise: the key rides above the value the write is carrying */
        uint32_t key_stack = 1;
        if (!expression(step_id, key, ExprTier::Wire, scope, Shape::Text, flow.code,
                        key_stack, nullptr, "key"))
            return false;
        flow.max_stack = std::max(flow.max_stack, key_stack + 1);
        Instruction ins;
        ins.op = OpCode::StoreKey;
        ins.a = cell;
        ins.b = fault_site(step_id, "store_key",
                           "map '" + def.name + "' needs a text key, and holds at most " +
                               std::to_string(kRetainedCeiling) + " of them");
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

    /* Put ONE value on the stack from a move's source. A struct source is not a scalar
     * and is handled by its own paths; everything here yields a single value. */
    bool push_scalar(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                     ExpressionScope& scope, const Json& from, Shape expected,
                     Shape* actual = nullptr) {
        (void)widget;
        const uint64_t step_id = id_of(step);
        if (from.contains("expr"))
            return expression(step_id, str_or(from, "expr", "x"), ExprTier::Wire, scope,
                              expected, flow.code, flow.max_stack, actual, "from");
        if (from.contains("local")) {
            const std::string text = str_or(from, "local", "");
            const std::string path = str_or(from, "path", "");
            return expression(step_id, path.empty() ? text : text + "." + path, ExprTier::Wire,
                              scope, expected, flow.code, flow.max_stack, actual, "from");
        }
        if (from.contains("kind")) {
            const int entity = resolve_entity(from, step_id, "from");
            if (entity < 0) return false;
            const int field = find_field(entity, str_or(from, "path", ""), step_id, "from");
            if (field < 0) return false;
            const FieldDef& def = program_.entities[entity].fields[field];
            if (expected != Shape::Unknown && def.shape != expected) {
                diag(step_id, "shape",
                     "the source is " + std::string(shape_name(def.shape)) +
                         ", but this destination wants " + shape_name(expected),
                     DiagGrade::Error, "from");
                return false;
            }
            program_.entities[entity].flow_reads = true;
            Instruction load;
            load.op = OpCode::LoadEnt;
            load.a = static_cast<uint32_t>(entity);
            load.b = static_cast<uint32_t>(field);
            load.c = fault_site(step_id, "move_read", "the entity's value could not be read");
            flow.code.push_back(load);
            flow.max_stack = std::max(flow.max_stack, 1u);
            if (actual) *actual = def.shape;
            return true;
        }
        diag(step_id, "move_source", "this move has no source", DiagGrade::Error, "from");
        return false;
    }

    /* push_scalar toward one typed destination, with the two compile-inserted enum
     * coercions (spec 6.2): text into an enum-typed field or variable becomes the
     * variant's value (a Dropdown's selected name writes back with no authored
     * transform), and an enum into a text destination renders as its variant name. */
    bool push_typed(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
                    ExpressionScope& scope, const Json& from, Shape wanted,
                    uint16_t type_id) {
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
            return push_scalar(widget, step, flow, scope, from, wanted);
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
    bool move_into_local(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
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
            if (!from.contains("expr")) {
                if (!push_scalar(widget, step, flow, scope, from, Shape::Unknown, &produced))
                    return false;
            } else if (!expression(step_id, str_or(from, "expr", "x"), ExprTier::Wire, scope,
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
           what "a temporary is typed by what is first moved into it" means. (Starting
           from a zeroed value is not a step: declare a variable with the type, and it
           is born zeroed, spec 2.7.) */
        uint16_t struct_type = 0;
        int read_entity = -1;
        if (from.contains("kind") && str_or(from, "path", "").empty()) {
            const int entity = resolve_entity(from, step_id, "from");
            if (entity < 0) return false;
            if (program_.entities[entity].fields.size() > 1 ||
                program_.entities[entity].type_id != 0) {
                read_entity = entity;
                struct_type = program_.entities[entity].type_id;
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
           (rendered as its name), exactly like the same-shaped fields do */
        if (cell != UINT32_MAX) {
            if (!push_typed(widget, step, flow, scope, from, wanted,
                            program_.cells[cell].type_id))
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
    bool move_out(const WidgetInfo& widget, const Json& step, FlowProgram& flow,
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
        out.c = fault_site(step_id, "move_out", "UNKNOWN was not sent");

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
           holder is a flow temporary or a declared struct variable, same as any other
           name in scope. */
        const std::string source_local = str_or(from, "local", "");
        uint32_t held_cell = UINT32_MAX;
        if (!source_local.empty()) {
            auto held = locals.find(source_local);
            if (held != locals.end()) held_cell = held->second;
            else held_cell = declared_cell(widget, source_local);
        }
        const bool whole = held_cell != UINT32_MAX && str_or(from, "path", "").empty() &&
                           program_.cells[held_cell].shape == Shape::Struct;
        if (whole) {
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
            load.c = fault_site(step_id, "move_out", "the value could not be read");
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
            if (!push_typed(widget, step, flow, scope, from, target.fields[field].shape,
                            target.fields[field].type_id))
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

    bool compile_steps(const WidgetInfo& widget, const Json& flow_node, FlowProgram& flow) {
        ExpressionScope scope = scope_for(widget, flow.event_shape);
        FlowLocals locals;
        for (const Json& step : flow_node.value("do", Json::array())) {
            const uint64_t step_id = id_of(step);
            const std::string kind = step.value("kind", "");
            if (kind == "move") {
                if (!compile_move(widget, step, flow, scope, locals)) return false;
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
        return true;
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
                    if (trigger.value("kind", "") == "timer") {
                        const std::string name = trigger.value("var", "");
                        const int timer = resolve_timer(widget, name, flow_id);
                        if (timer < 0) continue;
                        flow.event = program_.timers[timer].event;
                        flow.event_shape = Shape::Timer;
                        program_.timers[timer].rearm_groups.push_back(group);
                    } else if (trigger.value("kind", "") == "every") {
                        if (!cadence_trigger(widget, trigger, flow_id, flow)) continue;
                    } else {
                        flow.event = trigger.value("name", "");
                        flow.event_shape = event_shape(widget, flow.event, flow_id);
                        flow.hold_ticks =
                            static_cast<uint32_t>(std::max(0.0, num_or(trigger, "hold_ms", 600.0)));
                        const Json every = trigger.value("every_ms", Json());
                        flow.every_ticks =
                            every.is_number()
                                ? static_cast<uint32_t>(std::max(0.0, every.get<double>()))
                                : 0;
                    }
                    if (!compile_steps(widget, node, flow)) {
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

    /* WHAT `x` IS, per (widget, event). A gesture reports what the pointer did; the value
     * the widget PROPOSES is a property of the type, so the events table declares it:
     * a Toggle's tap proposes `!widget.value`, a Readout's press proposes the value it is
     * showing. A Slider's drag already carries its own proposal, so it declares nothing.
     *
     * Without this, `x` on a tap is the pointer's `true` and every flow that wants the
     * value has to restate the widget's own logic, which is both boilerplate and a second
     * place for it to be wrong. */
    void build_event_values() {
        for (WidgetInfo& widget : widgets_) {
            if (!widget.type) continue;
            for (const Json& row : widget.type->value("events", Json::array())) {
                const std::string expression_text = row.value("value", "");
                if (expression_text.empty()) continue;
                EventValueProgram source;
                source.widget_id = widget.id;
                source.event = row.value("name", "");
                const Shape shape = shape_from_name(row.value("x", ""));
                ExpressionScope scope = scope_for(widget, shape);
                if (!expression(widget.id, expression_text, ExprTier::Wire, scope, shape,
                                source.code, source.max_stack))
                    continue;
                source.code.push_back(Instruction{OpCode::StoreX});
                source.code.push_back(Instruction{OpCode::Halt});
                program_.layout.stack_values =
                    std::max(program_.layout.stack_values, source.max_stack);
                program_.event_values.push_back(std::move(source));
            }
        }
    }

    /* Who already writes each of a widget's slots, and what to call it in a diagnostic.
     * One writer per slot is the rule that keeps a slot deterministic (spec 2.3); this is
     * where it is decided, once, at compile time. */
    std::unordered_map<std::string, std::string> claimed_slots(const WidgetInfo& widget) const {
        std::unordered_map<std::string, std::string> out;
        auto feeds = widget.node->find("feeds");
        if (feeds != widget.node->end() && feeds->is_array())
            for (const Json& feed : *feeds) {
                const std::string slot = feed.value("slot", "");
                const Json& src = feed.value("src", Json::object());
                if (!slot.empty())
                    out[slot] = "it is fed from " + src.value("kind", "?") + ":" +
                                src.value("name", "?");
            }
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
            if (step.value("kind", "") != "move") continue;
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
     * Precedence, resolved here so exactly one writer survives: a feed on the slot wins
     * (the control is a view of the machine), then an authored flow that assigns the same
     * slot (the author overrode the default), otherwise the default runs. Suppression is
     * per slot WRITTEN, not per event, so "on tap, send to the PLC" coexists with the
     * default local echo. Standing down is deterministic and silent: the author asked for
     * the writer that won, so there is nothing to report. */
    void build_type_behavior() {
        for (WidgetInfo& widget : widgets_) {
            if (!widget.type) continue;
            const Json& behavior = widget.type->value("behavior", Json::array());
            if (!behavior.is_array() || behavior.empty()) continue;
            const std::unordered_map<std::string, std::string> claimed = claimed_slots(widget);
            for (const Json& node : behavior) {
                bool suppressed = false;
                for (const std::string& slot : written_slots(node)) {
                    if (claimed.find(slot) == claimed.end()) continue;
                    suppressed = true;
                    break;
                }
                if (suppressed) continue;
                for (const Json& trigger : node.value("when", Json::array())) {
                    FlowProgram flow;
                    flow.widget_id = widget.id;
                    /* the widget's own id: document ids are unique, so this cannot collide
                       with an authored flow, and it keeps state-site identity stable */
                    flow.flow_id = widget.id;
                    flow.group = program_.layout.fired_groups++;
                    flow.runtime_index = static_cast<uint32_t>(program_.flows.size());
                    if (trigger.value("kind", "") == "every") {
                        if (!cadence_trigger(widget, trigger, widget.id, flow)) continue;
                    } else {
                        flow.event = trigger.value("name", "");
                        flow.event_shape = event_shape(widget, flow.event, widget.id);
                    }
                    if (!compile_steps(widget, node, flow)) continue;
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

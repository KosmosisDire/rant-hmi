#include "compiler.h"

#include "expression.h"

#include <algorithm>
#include <cmath>
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
enum class SideKind { None, Expr, Local, Entity };

SideKind side_kind(const Json& side) {
    if (!side.is_object()) return SideKind::None;
    if (side.contains("expr")) return SideKind::Expr;
    if (side.contains("local")) return SideKind::Local;
    if (side.contains("slot")) return SideKind::Local;
    if (side.contains("kind")) return SideKind::Entity;
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
        if (program_.types[type_id].kind == TypeKind::Enum) {
            const uint32_t cell = add_cell(kind, owner, id_of(var), name, Shape::Enum,
                                           Json(), var.value("persist", false));
            const auto& variants = program_.types[type_id].variants;
            program_.cells[cell].type_id = static_cast<uint16_t>(type_id);
            program_.cells[cell].initial = Value::enumeration(
                variants.empty() ? 0 : variants[0].second, static_cast<uint16_t>(type_id));
            return cell;
        }
        return add_struct_cell(kind, owner, 0, id_of(var), name,
                               static_cast<uint16_t>(type_id));
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
            auto widgets = page.find("widgets");
            if (widgets == page.end() || !widgets->is_array()) continue;
            for (const Json& widget : *widgets) {
                WidgetInfo info;
                info.id = id_of(widget);
                info.page = id_of(page);
                info.node = &widget;
                info.type = type_named(widget.value("type", ""));
                if (!info.type)
                    diag(info.id, "widget_type",
                         "widget type '" + widget.value("type", "") + "' is not registered");

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
                        auto override = authored.find(name);
                        if (override != authored.end()) initial = *override;
                        check_variants(info.id, name, slot, initial);
                        check_enum_type_slot(info.id, name, slot, initial);
                        info.slots[name] =
                            add_cell(CellKind::Slot, info.id, info.id, name, shape, initial, false);
                    }
                }
                widgets_.push_back(std::move(info));
            }
        }
    }

    /* A registry slot declared `enum` is CONSTRAINED TEXT: its values are the variant NAMES
     * the author picks and the template draws ("center"), so the cell holds the name. The
     * VM's Enum shape means something else, a mesh field's backing integer (spec 2.2), and
     * conflating them left every enum slot holding Nil. */
    Shape slot_shape(const Json& slot) const {
        const std::string name = slot.value("shape", "");
        return name == "enum" ? Shape::Text : shape_from_name(name);
    }

    /* A slot whose editor is the type picker (a Dropdown's `options`) holds a TypeRef
     * naming an enum (spec 6.2). The view expands it to the variant names itself; what
     * the compiler owns is the finding when the reference stops resolving. */
    void check_enum_type_slot(uint64_t widget_id, const std::string& slot, const Json& spec,
                              const Json& value) {
        if (spec.value("editor", "") != "enum-type") return;
        if (!value.is_string() || value.get<std::string>().empty()) return;
        const std::string text = value.get<std::string>();
        const int type_id = find_type_ref(text);
        if (type_id < 0 || program_.types[type_id].kind != TypeKind::Enum)
            diag(widget_id, "unresolved_type",
                 "slot '" + slot + "': '" + text + "' does not name an enum in the mesh",
                 DiagGrade::Error, slot);
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

    ExpressionScope scope_for(const WidgetInfo& widget, Shape x_shape) {
        ExpressionScope scope;
        scope.x_shape = x_shape;
        for (const auto& item : globals_) bind_variable(scope, item.first, item.second);
        for (const auto& item : widget.locals) bind_variable(scope, item.first, item.second);
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
        if (!compile_expression(text, tier, scope, program_, code, result, error)) {
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
                program_.cells[feed.cell].initial = Value::nil();
                const Json& ref = node["src"];
                const std::string kind = ref.value("kind", "");
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
                } else {
                    const int entity = resolve_entity(ref, feed.feed_id, "src");
                    if (entity < 0) continue;
                    feed.entity = static_cast<uint32_t>(entity);
                    const int field = find_field(feed.entity, str_or(node, "path", ""),
                                                 feed.feed_id, "path", /*response=*/true);
                    if (field < 0) continue;
                    feed.field = static_cast<uint32_t>(field);
                    const FieldDef& source_field =
                        feed_fields(program_.entities[feed.entity])[feed.field];
                    scope.x_shape = source_field.shape;
                    scope.x_enum = source_field.type_id;
                    scope.x_elem = source_field.elem;
                    if (program_.entities[feed.entity].kind == EntityKind::Function) {
                        const double hz = num_or(node, "poll_hz", 0.0);
                        feed.poll_ms = hz > 0.0
                            ? std::max(10u, static_cast<uint32_t>(std::lround(1000.0 / hz)))
                            : 1000u;
                    }
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

        const std::string slot = slot_of(to);
        if (!slot.empty()) {
            auto found = widget.slots.find(slot);
            if (found == widget.slots.end()) {
                diag(step_id, "move_dest", "this widget has no slot '" + slot + "'",
                     DiagGrade::Error, "to");
                return false;
            }
            return push_typed(widget, step, flow, scope, from,
                              program_.cells[found->second].shape, 0) &&
                   emit_store(flow, step_id, found->second);
        }

        if (to.contains("local")) return move_into_local(widget, step, flow, scope, locals);
        if (to.contains("kind")) return move_out(widget, step, flow, scope, locals);
        diag(step_id, "move_dest", "this move has no destination", DiagGrade::Error, "to");
        return false;
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
                    flow.event = trigger.value("name", "");
                    flow.event_shape = event_shape(widget, flow.event, widget.id);
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

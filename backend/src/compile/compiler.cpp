#include "compiler.h"

#include "expression.h"

#include <algorithm>
#include <cmath>
#include <unordered_map>

namespace hmi {
namespace {

uint64_t id_of(const Json& node) {
    auto it = node.find("id");
    return it == node.end() ? 0 : json_u64_or(*it, 0);
}

bool entity_kind(const std::string& text, EntityKind& out) {
    if (text == "V") out = EntityKind::Variable;
    else if (text == "T") out = EntityKind::Topic;
    else if (text == "F") out = EntityKind::Function;
    else if (text == "S") out = EntityKind::Signal;
    else return false;
    return true;
}

bool parse_verb(const std::string& text, Verb& out) {
    if (text == "write") out = Verb::Write;
    else if (text == "force") out = Verb::Force;
    else if (text == "publish") out = Verb::Publish;
    else if (text == "call") out = Verb::Call;
    else if (text == "emit") out = Verb::Emit;
    else return false;
    return true;
}

bool verb_matches(EntityKind kind, Verb verb) {
    switch (kind) {
        case EntityKind::Variable: return verb == Verb::Write || verb == Verb::Force;
        case EntityKind::Topic: return verb == Verb::Publish;
        case EntityKind::Function: return verb == Verb::Call;
        case EntityKind::Signal: return verb == Verb::Emit;
    }
    return false;
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

/* the slot an assign target names, or "" when it names a variable */
std::string slot_target(const std::string& name) {
    const std::string prefix = "widget.";
    return name.compare(0, prefix.size(), prefix) == 0 ? name.substr(prefix.size()) : std::string();
}

/* what a JSON literal looks like in a message, for a diagnostic that names the mistake */
std::string json_brief(const Json& value) {
    const std::string text = value.dump();
    return text.size() > 32 ? text.substr(0, 29) + "..." : text;
}

struct WidgetInfo {
    uint64_t id = 0;
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
              DiagGrade grade = DiagGrade::Error) {
        program_.diagnostics.push_back(Diag{node, grade, code, message});
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

    void copy_entities() {
        program_.entities = mesh_.reflection();
        for (const EntityDef& entity : program_.entities)
            program_.layout.max_entity_fields =
                std::max<uint32_t>(program_.layout.max_entity_fields,
                                   static_cast<uint32_t>(entity.fields.size()));
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
                     ": it starts UNKNOWN");
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

    void build_cells() {
        auto globals = document_.root.find("globals");
        if (globals != document_.root.end() && globals->is_array()) {
            for (const Json& var : *globals) {
                const std::string name = var.value("name", "");
                const Shape shape = var_shape(var.value("type", ""));
                if (shape == Shape::Unknown) {
                    diag(id_of(var), "var_type", "variable '" + name + "' has an unknown type");
                    continue;
                }
                globals_[name] =
                    add_cell(CellKind::Global, 0, id_of(var), name, shape,
                             var.value("init", Json()), var.value("persist", false));
                if (shape == Shape::Struct) global_timers_[name] = add_timer(0, var);
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
                info.node = &widget;
                info.type = type_named(widget.value("type", ""));
                if (!info.type)
                    diag(info.id, "widget_type",
                         "widget type '" + widget.value("type", "") + "' is not registered");

                auto locals = widget.find("locals");
                if (locals != widget.end() && locals->is_array()) {
                    for (const Json& var : *locals) {
                        const std::string name = var.value("name", "");
                        const Shape shape = var_shape(var.value("type", ""));
                        if (shape == Shape::Unknown) {
                            diag(id_of(var), "var_type",
                                 "local variable '" + name + "' has an unknown type");
                            continue;
                        }
                        info.locals[name] =
                            add_cell(CellKind::Local, info.id, id_of(var), name, shape,
                                     var.value("init", Json()), var.value("persist", false));
                        if (shape == Shape::Struct)
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
             "slot '" + slot + "' is " + json_brief(value) + ", which is not one of: " + known);
    }

    Shape var_shape(const std::string& type) const {
        if (type == "f64") return Shape::Num;
        if (type == "bool") return Shape::Bool;
        if (type == "str") return Shape::Text;
        if (type == "timer") return Shape::Struct;
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

    int resolve_entity(const Json& ref, uint64_t node) {
        if (!ref.is_object()) {
            diag(node, "entity_ref", "entity reference is not an object");
            return -1;
        }
        EntityKind kind;
        const std::string kind_text = ref.value("kind", "");
        const std::string name = ref.value("name", "");
        if (kind_text == "L") {
            diag(node, "local_entity", "an HMI variable is not a mesh target");
            return -1;
        }
        if (!entity_kind(kind_text, kind)) {
            diag(node, "entity_kind", "entity kind '" + kind_text + "' is invalid");
            return -1;
        }
        const int found = find_entity(kind, name);
        if (found < 0)
            diag(node, "unresolved_entity",
                 "mesh entity " + kind_text + ":" + name + " is not reflected");
        return found;
    }

    int find_field(uint32_t entity, const std::string& path, uint64_t node) {
        const EntityDef& def = program_.entities[entity];
        if (path.empty() && def.fields.size() == 1) return 0;
        for (uint32_t i = 0; i < def.fields.size(); ++i)
            if (def.fields[i].path == path) return static_cast<int>(i);
        diag(node, "unresolved_field",
             "entity '" + def.name + "' has no field '" + path + "'");
        return -1;
    }

    ExpressionScope scope_for(const WidgetInfo& widget, Shape x_shape) {
        ExpressionScope scope;
        scope.x_shape = x_shape;
        for (const auto& item : globals_) {
            const CellDef& cell = program_.cells[item.second];
            scope.names[item.first] = Binding{cell.shape, OpCode::Load, item.second, 0};
        }
        for (const auto& item : widget.locals) {
            const CellDef& cell = program_.cells[item.second];
            scope.names[item.first] = Binding{cell.shape, OpCode::Load, item.second, 0};
        }
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
                    Shape* actual = nullptr) {
        ExpressionResult result;
        std::string error;
        if (!compile_expression(text, tier, scope, program_, code, result, error)) {
            diag(node, "expression", error);
            return false;
        }
        if (expected != Shape::Unknown && result.shape != Shape::Unknown &&
            result.shape != Shape::Nil && result.shape != expected) {
            diag(node, "shape",
                 "expression yields " + std::string(shape_name(result.shape)) +
                     ", but this row wants " + shape_name(expected));
            return false;
        }
        if (actual) *actual = result.shape;
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
                feed.feed_id = id_of(node);
                const std::string slot = node.value("slot", "");
                auto destination = widget.slots.find(slot);
                if (destination == widget.slots.end()) {
                    diag(feed.feed_id, "feed_slot", "widget has no slot '" + slot + "'");
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
                        diag(feed.feed_id, "feed_source", "HMI variable '" + name + "' is unresolved");
                        continue;
                    }
                    feed.entity = UINT32_MAX;
                    feed.source_cell = source;
                    scope.x_shape = program_.cells[source].shape;
                } else {
                    const int entity = resolve_entity(ref, feed.feed_id);
                    if (entity < 0) continue;
                    feed.entity = static_cast<uint32_t>(entity);
                    const int field = find_field(feed.entity, node.value("path", ""), feed.feed_id);
                    if (field < 0) continue;
                    feed.field = static_cast<uint32_t>(field);
                    scope.x_shape = program_.entities[feed.entity].fields[feed.field].shape;
                }
                const std::string xf = node.value("xf", "");
                bool ok = true;
                if (xf.empty()) {
                    feed.code.push_back(Instruction{OpCode::LoadX});
                    feed.max_stack = 1;
                } else {
                    ok = expression(feed.feed_id, xf, ExprTier::Display, scope,
                                    program_.cells[feed.cell].shape, feed.code, feed.max_stack);
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

    /* Where an assign writes. Reads already spell a slot `widget.<name>` (scope_for), so
     * writes use the same vocabulary: one name form, both directions. The scope is the
     * widget's OWN slots and nothing else, so a flow can never reach across and become a
     * second writer on another widget's slot (the one-writer rule, spec 2.3). */
    uint32_t assign_target(const WidgetInfo& widget, const std::string& name) const {
        const std::string slot = slot_target(name);
        if (!slot.empty()) {
            auto found = widget.slots.find(slot);
            return found == widget.slots.end() ? UINT32_MAX : found->second;
        }
        auto local = widget.locals.find(name);
        if (local != widget.locals.end()) return local->second;
        auto global = globals_.find(name);
        return global == globals_.end() ? UINT32_MAX : global->second;
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

    bool compile_steps(const WidgetInfo& widget, const Json& flow_node, FlowProgram& flow) {
        ExpressionScope scope = scope_for(widget, flow.event_shape);
        Shape current_x_shape = flow.event_shape;
        std::unordered_map<std::string, uint32_t> buffers;
        int current_buffer = -1;
        for (const Json& step : flow_node.value("do", Json::array())) {
            const uint64_t step_id = id_of(step);
            const std::string kind = step.value("kind", "");
            if (kind == "transform") {
                Shape transformed = Shape::Unknown;
                if (!expression(step_id, step.value("a", "x"), ExprTier::Wire, scope,
                                Shape::Unknown, flow.code, flow.max_stack, &transformed))
                    return false;
                flow.code.push_back(Instruction{OpCode::StoreX});
                current_x_shape = transformed;
                scope.x_shape = transformed;
            } else if (kind == "gate") {
                if (!expression(step_id, step.value("a", ""), ExprTier::Wire, scope,
                                Shape::Bool, flow.code, flow.max_stack))
                    return false;
                flow.code.push_back(Instruction{OpCode::Gate});
            } else if (kind == "deadband") {
                Instruction ins;
                ins.op = OpCode::Deadband;
                ins.a = state_site(StateSiteKind::Deadband, flow.flow_id, step_id);
                ins.b = program_.add_constant(Value::number(step.value("a", 0.0)));
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
            } else if (kind == "build") {
                const int entity = resolve_entity(step["target"], step_id);
                if (entity < 0) return false;
                BufferDef def;
                def.name = step.value("buf", "msg");
                def.entity = static_cast<uint32_t>(entity);
                const uint32_t buffer = static_cast<uint32_t>(program_.buffers.size());
                program_.buffers.push_back(def);
                buffers[def.name] = buffer;
                current_buffer = static_cast<int>(buffer);
                Instruction ins;
                ins.op = OpCode::MsgNew;
                ins.a = buffer;
                ins.b = def.entity;
                ins.small = step.value("seed", "last") == "last" ? 1 : 0;
                ins.c = fault_site(step_id, "message_build", "message buffer could not be opened");
                flow.code.push_back(ins);
                for (uint32_t i = 0; i < program_.entities[def.entity].fields.size(); ++i) {
                    const FieldDef& field = program_.entities[def.entity].fields[i];
                    scope.qualified[def.name + "." + field.path] =
                        Binding{field.shape, OpCode::LoadMsgF, buffer, i};
                }
            } else if (kind == "setf") {
                if (current_buffer < 0) {
                    diag(step_id, "message_owner", "field setter has no open message");
                    return false;
                }
                const uint32_t buffer = static_cast<uint32_t>(current_buffer);
                const uint32_t entity = program_.buffers[buffer].entity;
                const int field = find_field(entity, step.value("path", ""), step_id);
                if (field < 0) return false;
                const FieldDef& field_def = program_.entities[entity].fields[field];
                const std::string variant = step.value("variant", "");
                if (!variant.empty()) {
                    bool found = false;
                    for (const auto& item : field_def.variants) {
                        if (item.first != variant) continue;
                        Instruction constant;
                        constant.op = OpCode::Const;
                        constant.a = program_.add_constant(
                            Value::enumeration(item.second, field_def.enum_type));
                        flow.code.push_back(constant);
                        flow.max_stack = std::max(flow.max_stack, 1u);
                        found = true;
                        break;
                    }
                    if (!found) {
                        diag(step_id, "enum_variant",
                             "field has no enum variant '" + variant + "'");
                        return false;
                    }
                } else if (!expression(step_id, step.value("a", ""), ExprTier::Wire, scope,
                                       field_def.shape, flow.code, flow.max_stack)) {
                    return false;
                }
                Instruction set;
                set.op = OpCode::MsgSet;
                set.a = buffer;
                set.b = static_cast<uint32_t>(field);
                set.c = fault_site(step_id, "message_field", "message field could not be set");
                flow.code.push_back(set);
            } else if (kind == "send") {
                uint32_t buffer = UINT32_MAX;
                const std::string named = step.value("buf", "");
                if (!named.empty()) {
                    auto found = buffers.find(named);
                    if (found != buffers.end()) buffer = found->second;
                } else if (current_buffer >= 0) {
                    buffer = static_cast<uint32_t>(current_buffer);
                }
                Verb verb;
                if (!parse_verb(step.value("verb", ""), verb)) {
                    diag(step_id, "verb", "send verb is invalid");
                    return false;
                }
                if (buffer != UINT32_MAX) {
                    const uint32_t entity = program_.buffers[buffer].entity;
                    if (!verb_matches(program_.entities[entity].kind, verb)) {
                        diag(step_id, "verb", "send verb does not match the message target");
                        return false;
                    }
                    Instruction send;
                    send.op = OpCode::SendMsg;
                    send.a = buffer;
                    send.small = static_cast<uint16_t>(verb);
                    send.c = fault_site(step_id, "send_nil",
                                        "message contains UNKNOWN and was not sent");
                    flow.code.push_back(send);
                    current_buffer = -1;
                } else {
                    const int entity = resolve_entity(step["target"], step_id);
                    if (entity < 0) return false;
                    const EntityDef& target = program_.entities[entity];
                    if (target.fields.size() != 1) {
                        diag(step_id, "bare_send",
                             "bare send needs an entity with exactly one field");
                        return false;
                    }
                    if (!verb_matches(target.kind, verb)) {
                        diag(step_id, "verb", "send verb does not match the target kind");
                        return false;
                    }
                    if (current_x_shape != target.fields[0].shape) {
                        diag(step_id, "shape",
                             "pipeline value does not match the target field");
                        return false;
                    }
                    Instruction send;
                    send.op = OpCode::SendX;
                    send.a = static_cast<uint32_t>(entity);
                    send.b = 0;
                    send.small = static_cast<uint16_t>(verb);
                    send.c = fault_site(step_id, "send_nil", "UNKNOWN was not sent");
                    flow.code.push_back(send);
                }
                ++program_.layout.effect_capacity;
            } else if (kind == "assign") {
                const std::string name = step.value("var", "");
                const uint32_t cell = assign_target(widget, name);
                if (cell == UINT32_MAX) {
                    diag(step_id, "assign_var",
                         (slot_target(name).empty() ? "variable '" : "slot '") + name +
                             "' is unresolved");
                    return false;
                }
                if (!expression(step_id, step.value("a", "x"), ExprTier::Wire, scope,
                                program_.cells[cell].shape, flow.code, flow.max_stack))
                    return false;
                Instruction store;
                store.op = OpCode::Store;
                store.a = cell;
                store.c = fault_site(step_id, "assign_store", "assignment could not be stored");
                flow.code.push_back(store);
            } else if (kind == "unforce") {
                const int entity = resolve_entity(step["target"], step_id);
                if (entity < 0) return false;
                if (program_.entities[entity].kind != EntityKind::Variable) {
                    diag(step_id, "unforce_target", "unforce needs a variable target");
                    return false;
                }
                Instruction ins;
                ins.op = OpCode::Unforce;
                ins.a = static_cast<uint32_t>(entity);
                ins.c = fault_site(step_id, "unforce", "unforce could not be emitted");
                flow.code.push_back(ins);
                ++program_.layout.effect_capacity;
            } else if (kind == "tmr_start" || kind == "tmr_cancel") {
                const int timer = resolve_timer(widget, step.value("timer", ""), step_id);
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
                        flow.event_shape = Shape::Struct;
                        program_.timers[timer].rearm_groups.push_back(group);
                    } else {
                        flow.event = trigger.value("name", "");
                        flow.event_shape = event_shape(widget, flow.event, flow_id);
                        flow.hold_ticks =
                            static_cast<uint32_t>(std::max(0.0, trigger.value("hold_ms", 600.0)));
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
                for (const Json& step : flow.value("do", Json::array())) {
                    if (step.value("kind", "") != "assign") continue;
                    const std::string slot = slot_target(step.value("var", ""));
                    if (!slot.empty()) out[slot] = "a flow on this widget writes it";
                }
        return out;
    }

    /* The slots one behavior flow writes, so precedence is decided before it is compiled */
    std::vector<std::string> behavior_targets(const Json& flow) const {
        std::vector<std::string> out;
        for (const Json& step : flow.value("do", Json::array())) {
            if (step.value("kind", "") != "assign") continue;
            const std::string slot = slot_target(step.value("var", ""));
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
     * default local echo. Every suppression is reported, so none of this is invisible. */
    void build_type_behavior() {
        for (WidgetInfo& widget : widgets_) {
            if (!widget.type) continue;
            const Json& behavior = widget.type->value("behavior", Json::array());
            if (!behavior.is_array() || behavior.empty()) continue;
            const std::unordered_map<std::string, std::string> claimed = claimed_slots(widget);
            for (const Json& node : behavior) {
                bool suppressed = false;
                for (const std::string& slot : behavior_targets(node)) {
                    auto by = claimed.find(slot);
                    if (by == claimed.end()) continue;
                    diag(widget.id, "behavior_inactive",
                         "the default " + widget.type->value("name", "") + " behavior on '" +
                             slot + "' is inactive: " + by->second,
                         DiagGrade::Info);
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

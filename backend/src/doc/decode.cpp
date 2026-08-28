#include "decode.h"

namespace hmi {
namespace {

/* the one reading rule, stated once: a missing key is the default, and so is a
 * wrong-typed value — the schema guarantees the shape for anything adopt() prepared,
 * and a built-in definition is ours to keep well-formed */
std::string text_or(const Json& node, const char* key, const char* fallback) {
    auto it = node.find(key);
    return it != node.end() && it->is_string() ? it->get<std::string>() : fallback;
}

double number_or(const Json& node, const char* key, double fallback) {
    auto it = node.find(key);
    return it != node.end() && it->is_number() ? it->get<double>() : fallback;
}

bool bool_or(const Json& node, const char* key, bool fallback) {
    auto it = node.find(key);
    return it != node.end() && it->is_boolean() ? it->get<bool>() : fallback;
}

uint64_t id_of(const Json& node) {
    auto it = node.find("id");
    return it == node.end() ? 0 : json_u64_or(*it, 0);
}

NumOrText num_or_text(const Json& node, const char* key) {
    NumOrText out;
    auto it = node.find(key);
    if (it == node.end()) return out;
    if (it->is_number()) {
        out.kind = NumOrText::Kind::Num;
        out.num = it->get<double>();
        out.raw = *it;
    } else if (it->is_string()) {
        out.kind = NumOrText::Kind::Text;
        out.text = it->get<std::string>();
    } else {
        out.kind = NumOrText::Kind::Other;
    }
    return out;
}

/* an attrs-shaped object ({key: expression text}), in the object's own (key-sorted)
 * order — which is the order the old walks iterated, so findings keep their order */
std::vector<AttrDecl> decode_attrs(const Json& value) {
    std::vector<AttrDecl> out;
    if (!value.is_object()) return out;
    for (auto it = value.begin(); it != value.end(); ++it) {
        AttrDecl row;
        row.key = it.key();
        if (it->is_string()) {
            row.is_text = true;
            row.text = it->get<std::string>();
        }
        out.push_back(std::move(row));
    }
    return out;
}

std::vector<TransitionDecl> decode_transitions(const Json& node) {
    std::vector<TransitionDecl> out;
    auto rows = node.find("transitions");
    if (rows == node.end() || !rows->is_object()) return out;
    for (auto it = rows->begin(); it != rows->end(); ++it) {
        TransitionDecl row;
        row.key = it.key();
        if (it->is_object()) {
            row.is_row = true;
            row.ms = num_or_text(*it, "ms");
            row.profile = text_or(*it, "profile", "");
        }
        out.push_back(std::move(row));
    }
    return out;
}

std::vector<AnchorDecl> decode_anchors(const Json& node) {
    std::vector<AnchorDecl> out;
    auto rows = node.find("anchors");
    if (rows == node.end() || !rows->is_array()) return out;
    for (const Json& anchor : *rows) {
        AnchorDecl row;
        if (anchor.is_object()) {
            row.is_row = true;
            for (auto it = anchor.begin(); it != anchor.end(); ++it) {
                AnchorField field;
                field.key = it.key();
                if (it->is_object()) {
                    field.kind = AnchorField::Kind::Row;
                    field.row = decode_attrs(*it);
                } else if (it->is_string()) {
                    field.kind = AnchorField::Kind::Text;
                    field.text = it->get<std::string>();
                }
                row.fields.push_back(std::move(field));
            }
        }
        out.push_back(std::move(row));
    }
    return out;
}

InteractDecl decode_interact(const Json& node) {
    InteractDecl out;
    auto it = node.find("interact");
    if (it == node.end() || !it->is_object()) return out;
    out.present = true;
    auto primitive = it->find("primitive");
    if (primitive != it->end() && primitive->is_string()) {
        out.primitive_text = true;
        out.primitive = primitive->get<std::string>();
    }
    auto params = it->find("params");
    if (params != it->end()) out.params = decode_attrs(*params);
    out.bubbles = bool_or(*it, "bubbles", true);
    return out;
}

VarDecl decode_var(const Json& record) {
    VarDecl out;
    out.id = id_of(record);
    out.name = text_or(record, "name", "");
    out.type = text_or(record, "type", "num");
    out.elem = text_or(record, "elem", "");
    out.leaf = text_or(record, "leaf", "");
    auto init = record.find("init");
    if (init != record.end()) out.init = *init;
    out.persist = bool_or(record, "persist", false);
    out.is_public = bool_or(record, "public", false);
    out.group = text_or(record, "group", "appearance");
    out.editor = text_or(record, "editor", "");
    auto variants = record.find("variants");
    if (variants != record.end() && variants->is_array())
        for (const Json& variant : *variants)
            if (variant.is_string()) out.variants.push_back(variant.get<std::string>());
    auto bound = [&](const char* key, Json& slot) {
        auto it = record.find(key);
        if (it != record.end() && it->is_number()) slot = *it;
    };
    bound("step", out.step);
    bound("min", out.min);
    bound("max", out.max);
    out.smooth = num_or_text(record, "smooth");
    out.profile = text_or(record, "profile", "");
    return out;
}

FromDecl decode_from(const Json& step) {
    FromDecl out;
    auto it = step.find("from");
    if (it == step.end() || !it->is_object()) return out;
    for (const char* key : {"expr", "local", "slot", "kind", "init"})
        if (it->contains(key)) out.has_any = true;
    out.has_init = it->contains("init");
    auto expr = it->find("expr");
    if (expr != it->end()) {
        out.has_expr = true;
        if (expr->is_string()) {
            out.expr_text = true;
            out.expr = expr->get<std::string>();
        }
    }
    return out;
}

ToDecl decode_to(const Json& step) {
    ToDecl out;
    auto it = step.find("to");
    if (it == step.end() || !it->is_object()) return out;
    out.slot = text_or(*it, "slot", "");
    out.has_local = it->contains("local");
    out.local = text_or(*it, "local", "");
    out.path = text_or(*it, "path", "");
    out.type = text_or(*it, "type", "");
    out.has_kind = it->contains("kind");
    out.kind = text_or(*it, "kind", "");
    out.name = text_or(*it, "name", "");
    return out;
}

StepDecl decode_step(const Json& record) {
    StepDecl out;
    out.id = id_of(record);
    out.kind = text_or(record, "kind", "");
    out.from = decode_from(record);
    out.to = decode_to(record);
    out.mode = text_or(record, "mode", "write");
    out.keep = text_or(record, "keep", "");
    out.key = text_or(record, "key", "");
    out.a = num_or_text(record, "a");
    out.timer = text_or(record, "timer", "");
    out.event = text_or(record, "event", "");
    auto args = record.find("args");
    if (args != record.end() && args->is_object())
        for (auto it = args->begin(); it != args->end(); ++it)
            if (it->is_string()) out.args[it.key()] = it->get<std::string>();
    out.text = text_or(record, "text", "");
    out.ms = text_or(record, "ms", "");
    return out;
}

TriggerDecl decode_trigger(const Json& record) {
    TriggerDecl out;
    out.kind = text_or(record, "kind", "");
    out.name = text_or(record, "name", "");
    out.var = text_or(record, "var", "");
    out.element = text_or(record, "element", "");
    out.ms = num_or_text(record, "ms");
    out.holdMs = number_or(record, "holdMs", 600.0);
    out.every_ms = number_or(record, "every_ms", 0.0);
    return out;
}

NodeDecl decode_node(const Json& record) {
    NodeDecl out;
    out.id = id_of(record);
    out.kind = text_or(record, "kind", "frame");
    out.name = text_or(record, "name", "");
    out.type = text_or(record, "type", "");
    auto attrs = record.find("attrs");
    if (attrs != record.end()) out.attrs = decode_attrs(*attrs);
    out.transitions = decode_transitions(record);
    out.anchors = decode_anchors(record);
    out.closed = bool_or(record, "closed", false);
    auto slots = record.find("slots");
    if (slots != record.end() && slots->is_object()) out.slots = *slots;
    auto poll = record.find("poll");
    if (poll != record.end() && poll->is_object())
        for (auto it = poll->begin(); it != poll->end(); ++it)
            if (it->is_number()) out.poll[it.key()] = it->get<double>();
    out.interact = decode_interact(record);
    auto locals = record.find("locals");
    if (locals != record.end() && locals->is_array())
        for (const Json& var : *locals)
            if (var.is_object()) out.locals.push_back(decode_var(var));
    auto flows = record.find("flows");
    if (flows != record.end() && flows->is_array())
        for (const Json& flow : *flows)
            if (flow.is_object()) out.flows.push_back(decode_flow(flow));
    auto children = record.find("children");
    if (children != record.end() && children->is_array())
        for (const Json& child : *children)
            if (child.is_object()) out.children.push_back(decode_node(child));
    return out;
}

} // namespace

FlowDecl decode_flow(const Json& record) {
    FlowDecl out;
    out.id = id_of(record);
    auto when = record.find("when");
    if (when != record.end() && when->is_array())
        for (const Json& trigger : *when)
            if (trigger.is_object()) out.when.push_back(decode_trigger(trigger));
    out.when_mode = text_or(record, "when_mode", "first");
    auto steps = record.find("do");
    if (steps != record.end() && steps->is_array())
        for (const Json& step : *steps)
            if (step.is_object()) out.steps.push_back(decode_step(step));
    return out;
}

ComponentDecl decode_component(const Json& record) {
    ComponentDecl out;
    out.id = id_of(record);
    out.name = text_or(record, "name", "");
    out.design_w = number_or(record, "design_w", 240.0);
    out.design_h = number_or(record, "design_h", 120.0);
    auto events = record.find("events");
    if (events != record.end() && events->is_array()) {
        out.events = *events;
        for (const Json& event : *events) {
            if (!event.is_object()) continue;
            EventDecl decl;
            decl.name = text_or(event, "name", "");
            auto params = event.find("params");
            if (params != event.end() && params->is_array())
                for (const Json& param : *params) {
                    ParamDecl row;
                    if (param.is_object()) {
                        const std::string name = text_or(param, "name", "");
                        if (!name.empty()) row.name = name;
                        row.shape = text_or(param, "shape", "");
                    }
                    decl.params.push_back(std::move(row));
                }
            out.event_decls.push_back(std::move(decl));
        }
    }
    auto behavior = record.find("behavior");
    if (behavior != record.end() && behavior->is_array()) {
        out.behavior = *behavior;
        for (const Json& flow : *behavior)
            if (flow.is_object()) out.behavior_decls.push_back(decode_flow(flow));
    }
    /* the component record IS its root node; what it draws is a frame by definition */
    out.root = decode_node(record);
    out.root.kind = "frame";
    return out;
}

Doc decode_document(const Document& document) {
    Doc out;
    out.version = document.version();
    auto globals = document.root.find("globals");
    if (globals != document.root.end() && globals->is_array())
        for (const Json& var : *globals)
            if (var.is_object()) out.globals.push_back(decode_var(var));
    auto tokens = document.root.find("tokens");
    if (tokens != document.root.end() && tokens->is_array())
        for (const Json& token : *tokens)
            if (token.is_object())
                out.tokens.push_back(
                    TokenDecl{text_or(token, "name", ""), text_or(token, "dark", "")});
    auto components = document.root.find("components");
    if (components != document.root.end() && components->is_array())
        for (const Json& component : *components)
            if (component.is_object()) out.components.push_back(decode_component(component));
    auto pages = document.root.find("pages");
    if (pages != document.root.end() && pages->is_array())
        for (const Json& page : *pages) {
            if (!page.is_object()) continue;
            PageDecl decl;
            decl.id = id_of(page);
            auto children = page.find("children");
            if (children != page.end() && children->is_array())
                for (const Json& child : *children)
                    if (child.is_object()) decl.children.push_back(decode_node(child));
            out.pages.push_back(std::move(decl));
        }
    return out;
}

} // namespace hmi

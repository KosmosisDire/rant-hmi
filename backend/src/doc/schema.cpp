#include "schema.h"

#include <stdexcept>
#include <string>

namespace hmi {
namespace {

Prop text(std::string key, const char* def = "", Role role = Role::Plain) {
    Prop p; p.key = std::move(key); p.type = PropType::Text; p.def = def; p.role = role; return p;
}
Prop num(std::string key, Json def) {
    Prop p; p.key = std::move(key); p.type = PropType::Num; p.def = std::move(def); return p;
}
Prop boolean(std::string key, bool def) {
    Prop p; p.key = std::move(key); p.type = PropType::Bool; p.def = def; return p;
}
Prop enumer(std::string key, std::vector<std::string> variants, const char* def) {
    Prop p; p.key = std::move(key); p.type = PropType::Enum; p.variants = std::move(variants);
    p.def = def; return p;
}
/* Free text that still RETYPES another prop for the values it knows. A variable's type
 * is one of the four scalars or any TypeRef from the mesh (spec 2.7); only the scalars
 * imply an init shape, and an unknown value (a TypeRef) leaves the init alone: the
 * compiler resolves it against the type table and zeroes the value. */
Prop text_retyping(std::string key, const char* def, std::vector<std::string> known,
                   std::string retypes, std::vector<Json> defaults) {
    Prop p = text(std::move(key), def);
    p.variants = std::move(known);
    p.retypes = std::move(retypes);
    p.variant_defaults = std::move(defaults);
    return p;
}
Prop object(std::string key, Json def, Role role = Role::Plain) {
    Prop p; p.key = std::move(key); p.type = PropType::Object; p.def = std::move(def);
    p.role = role; return p;
}
Prop array(std::string key, Role role = Role::Plain) {
    Prop p; p.key = std::move(key); p.type = PropType::Array; p.def = Json::array();
    p.role = role; return p;
}
Prop any(std::string key, Json def) {
    Prop p; p.key = std::move(key); p.type = PropType::Any; p.def = std::move(def); return p;
}

Json entity_ref() { return Json{{"kind", "V"}, {"name", ""}}; }

/* built once, in kind order */
const std::vector<NodeSpec>& table() {
    static const std::vector<NodeSpec> specs = [] {
        std::vector<NodeSpec> t;

        NodeSpec doc;
        doc.kind = Kind::Doc;
        doc.name = "doc";
        doc.props = {
            num("version", 0),
            num("next_id", 1),
            /* one fixed artboard per HMI; 48 x 27 cells of exactly 30 units keeps
             * snapped geometry readable in the file */
            object("canvas", Json{{"unit_w", 1440}, {"unit_h", 810}, {"cols", 48}, {"rows", 27}}),
        };
        doc.lists = {{"globals", Kind::Var}, {"pages", Kind::Page}};
        t.push_back(doc);

        NodeSpec page;
        page.kind = Kind::Page;
        page.name = "page";
        page.props = {text("name", "Page")};
        page.lists = {{"widgets", Kind::Widget}};
        t.push_back(page);

        NodeSpec widget;
        widget.kind = Kind::Widget;
        widget.name = "widget";
        widget.props = {
            text("type", "Button"),
            text("label", ""),
            object("geom", Json{{"x", 0}, {"y", 0}, {"w", 180}, {"h", 90}}),   /* canvas units */
            object("slots", Json::object()),   /* unfed per-instance slot values */
        };
        widget.lists = {{"locals", Kind::Var}, {"feeds", Kind::Feed}, {"flows", Kind::Flow}};
        t.push_back(widget);

        NodeSpec var;
        var.kind = Kind::Var;
        var.name = "var";
        var.props = {
            text("name"),
            /* the type owns the init's shape: a bool variable whose init stayed the
             * number 0 would compile to UNKNOWN and never leave it (Nil poisons).
             * Anything beyond the four scalars is a TypeRef (spec 2.7): the variable
             * holds a struct, zeroed, and the compiler resolves the name. */
            text_retyping("type", "f64", {"f64", "bool", "str", "timer"}, "init",
                          {Json(0.0), Json(false), Json(""), Json(1.0)}),
            any("init", 0),
            boolean("persist", false),
        };
        t.push_back(var);

        NodeSpec feed;
        feed.kind = Kind::Feed;
        feed.name = "feed";
        feed.props = {
            text("slot"),
            object("src", entity_ref(), Role::EntityRef),
            text("path"),
            text("xf", "", Role::Expr),
            num("poll_hz", nullptr),
            num("stale_ms", nullptr),
        };
        t.push_back(feed);

        NodeSpec flow;
        flow.kind = Kind::Flow;
        flow.name = "flow";
        flow.props = {
            array("when", Role::Triggers),
            enumer("when_mode", {"first", "any"}, "first"),
        };
        flow.lists = {{"do", Kind::Step}};
        t.push_back(flow);

        /* One DO step per row; the common prop is `kind` and each kind adds its own
         * fields (spec 2.6). The compiler and the inspector both read this. */
        NodeSpec step;
        step.kind = Kind::Step;
        step.name = "step";
        step.variant_key = "kind";
        step.props = {enumer("kind",
                             {"move", "gate", "deadband", "throttle", "debounce", "delay",
                              "tmr_start", "tmr_cancel"},
                             "move")};
        step.variants = {
            /* ONE transfer step (spec 2.6). `from` and `to` are free-form objects
               discriminated by which key they carry, so a source or destination gains a
               form without a new prop:
                 from  {"expr": "x"} | {"kind","name","path"} | {"local","path"}
                       | {"init": true}                  (reset: the dest's own start)
                 to    {"local","path","type"?} | {"kind","name","path"} | {"slot"}
               `mode` applies to a V destination only; every other verb is derived. */
            {"move", {object("from", Json{{"expr", "x"}}, Role::MoveRef),
                      object("to", Json::object(), Role::MoveRef),
                      enumer("mode", {"write", "force", "unforce"}, "write")}},
            {"gate", {text("a", "", Role::Expr)}},
            {"deadband", {num("a", 0)}},
            {"throttle", {num("a", 0)}},
            {"debounce", {num("a", 0)}},
            {"delay", {num("a", 0)}},
            {"tmr_start", {text("timer", "", Role::VarName)}},
            {"tmr_cancel", {text("timer", "", Role::VarName)}},
        };
        t.push_back(step);

        return t;
    }();
    return specs;
}

} // namespace

bool json_u64(const Json& value, uint64_t& out) {
    if (value.is_number_unsigned()) { out = value.get<uint64_t>(); return true; }
    if (value.is_number_integer()) {
        const int64_t v = value.get<int64_t>();
        if (v < 0) return false;
        out = static_cast<uint64_t>(v);
        return true;
    }
    return false;
}

uint64_t json_u64_or(const Json& value, uint64_t fallback) {
    uint64_t out = 0;
    return json_u64(value, out) ? out : fallback;
}

const NodeSpec& node_spec(Kind kind) { return table()[static_cast<size_t>(kind)]; }

const char* kind_name(Kind kind) { return node_spec(kind).name.c_str(); }

std::string node_variant(const NodeSpec& spec, const Json& node) {
    if (spec.variant_key.empty()) return "";
    auto it = node.find(spec.variant_key);
    if (it == node.end() || !it->is_string()) return "";
    return it->get<std::string>();
}

std::vector<const Prop*> node_props(const NodeSpec& spec, const std::string& variant) {
    std::vector<const Prop*> out;
    for (const Prop& p : spec.props) out.push_back(&p);
    for (const auto& v : spec.variants)
        if (v.first == variant)
            for (const Prop& p : v.second) out.push_back(&p);
    return out;
}

const Prop* find_prop(const NodeSpec& spec, const std::string& variant, const std::string& key) {
    for (const Prop* p : node_props(spec, variant))
        if (p->key == key) return p;
    return nullptr;
}

bool declares_key(const NodeSpec& spec, const std::string& key) {
    for (const Prop& p : spec.props)
        if (p.key == key) return true;
    for (const auto& v : spec.variants)
        for (const Prop& p : v.second)
            if (p.key == key) return true;
    for (const ChildList& l : spec.lists)
        if (l.key == key) return true;
    return false;
}

Json coerce_like(const Json& like, const Json& value) {
    if (like.is_boolean()) {
        if (value.is_boolean()) return value;
        if (value.is_number()) return value.get<double>() != 0.0;
        if (value.is_string()) {
            const std::string text = value.get<std::string>();
            if (text == "true" || text == "1") return true;
            if (text == "false" || text == "0") return false;
        }
        return like;
    }
    if (like.is_number()) {
        if (value.is_number()) return value;
        if (value.is_boolean()) return value.get<bool>() ? 1.0 : 0.0;
        if (value.is_string()) {
            try {
                size_t used = 0;
                const std::string text = value.get<std::string>();
                const double parsed = std::stod(text, &used);
                if (used == text.size()) return parsed;
            } catch (...) {
            }
        }
        return like;
    }
    if (like.is_string()) {
        if (value.is_string()) return value;
        if (value.is_boolean()) return value.get<bool>() ? "true" : "false";
        if (value.is_number()) {
            Json out = value.dump();
            return out;
        }
        return like;
    }
    return value.is_null() ? like : value;
}

std::vector<std::string> retype_props(const NodeSpec& spec, Json& node) {
    std::vector<std::string> changed;
    if (!node.is_object()) return changed;
    for (const Prop& p : spec.props) {
        if (p.retypes.empty() || p.variants.size() != p.variant_defaults.size()) continue;
        auto selector = node.find(p.key);
        if (selector == node.end() || !selector->is_string()) continue;
        const std::string variant = selector->get<std::string>();
        for (size_t i = 0; i < p.variants.size(); ++i) {
            if (p.variants[i] != variant) continue;
            auto target = node.find(p.retypes);
            const Json before = target == node.end() ? Json(nullptr) : *target;
            /* an explicit null is not a mistyped value, it is a deliberate UNKNOWN start */
            if (target != node.end() && before.is_null()) break;
            const Json after = coerce_like(p.variant_defaults[i], before);
            if (after != before) {
                node[p.retypes] = after;
                changed.push_back(p.retypes);
            }
            break;
        }
    }
    return changed;
}

bool list_child(Kind parent, const std::string& list, Kind& out) {
    for (const ChildList& l : node_spec(parent).lists)
        if (l.key == list) { out = l.child; return true; }
    return false;
}

} // namespace hmi

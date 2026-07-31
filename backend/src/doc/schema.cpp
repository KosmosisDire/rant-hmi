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
        };
        doc.lists = {{"globals", Kind::Var}, {"tokens", Kind::Token},
                     {"components", Kind::Component}, {"pages", Kind::Page}};
        t.push_back(doc);

        /* A PAGE: one screen, and one of the two documents-of-nodes (the other is a
         * component). It is not a node itself — nothing places it, nothing sizes it — so
         * it holds children and a name and no more. Its children are the page's root
         * frames, in ONE ordered list, because z-order and flow order are the same order. */
        NodeSpec page;
        page.kind = Kind::Page;
        page.name = "page";
        page.props = {text("name", "Page")};
        page.lists = {{"children", Kind::Node}};
        t.push_back(page);

        /* THE NODE (schema.h): one kind, four variants, one field model.
         *
         * EVERY FIELD IS AN EXPRESSION and they all live in `attrs` — one map of attr name
         * -> expression text, checked against the closed vocabulary (registry/attrs.h) and
         * compiled to view programs. A literal is a degenerate expression, so a pane
         * painted `$surface` and one painted `alarm.pick($bad, $surface)` are the same kind
         * of field, and direct manipulation is a gesture that writes a CONSTANT into the
         * field an expression could occupy. Only what is STRUCTURAL stays a typed prop:
         * `kind` and `layout` (they decide what the node is and how its children are
         * placed, so the tree, the drop arithmetic and the inspector must read them
         * without evaluating anything), `name`, and a path's anchors.
         *
         * A FRAME WITH A `type` IS AN INSTANCE: it names a component, that component's
         * children are its subtree, and the instance's own `slots`, `feeds`, `flows` and
         * `locals` are how this one placement is wired. Those four ride the frame variant
         * rather than a "widget" kind of their own, because a widget was never a different
         * kind of thing — only a frame someone had already made. */
        NodeSpec node;
        node.kind = Kind::Node;
        node.name = "node";
        node.variant_key = "kind";
        node.props = {
            enumer("kind", {"frame", "text", "icon", "path"}, "frame"),
            /* ONE name per node: the label the tree shows, and — where something under it
               declares a property — the segment its addresses are built from. Free text
               until it has an address to carry (compile/components.cpp holds that line). */
            text("name", ""),
            object("attrs", Json::object()),
        };
        node.lists = {{"props", Kind::PropDef}};
        node.variants = {
            {"frame",
             {enumer("layout", {"free", "row", "col", "grid"}, "free"),
              /* "" = a plain frame; a component name = an instance of it */
              text("type", ""),
              /* per-instance slot values, NESTED like the component's own nodes: a
                 top-level property is a key here, a nested node's property a key inside an
                 object named for that node ({"bar": {"fill_color": "#fff"}} is the slot
                 addressed "bar.fill_color") */
              object("slots", Json::object()),
              object("interact", nullptr)},
             {{"children", Kind::Node},
              {"locals", Kind::Var},
              {"feeds", Kind::Feed},
              {"flows", Kind::Flow}}},
            {"text", {}, {}},
            {"icon", {}, {}},
            /* THE INK: ordered anchors whose every coordinate is expression text, plus
               `closed` (an open stroke or a filled shape). Never a `d` string — that is an
               import surface at most, and nothing here can compute with one. */
            {"path", {array("anchors"), boolean("closed", false)}, {}},
        };
        t.push_back(node);

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
            /* with `cases`, xf is the ELSE arm; alone it is the whole transform */
            text("xf", "", Role::Expr),
            /* CONDITIONAL arms over x (spec 2.4): [{test: Expr, xf: Expr}], first
               match wins; the feed's xf is the else */
            array("cases", Role::Cases),
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

        /* A theme token (spec 2.10): a named color role with one value per theme mode.
         * A color slot value may be "$<name>"; the backend compiles the DARK value (the
         * canonical runtime mode) and each view resolves per its own mode. */
        NodeSpec token;
        token.kind = Kind::Token;
        token.name = "token";
        token.props = {
            text("name"),
            text("group", "core"),
            text("light", "#000000"),
            text("dark", "#ffffff"),
        };
        t.push_back(token);

        /* A COMPONENT: a frame someone already made, kept in the library instead of on a
         * page — the other document-of-nodes beside Page. Its children are the template,
         * its `props` the vocabulary an instance fills in, its `events` the {name, x,
         * value?} rows a gesture raises, its `behavior` ordinary flows compiled per
         * instance. A component with a built-in's name SHADOWS that built-in.
         *
         * `layout`, `attrs` and `interact` describe the component's ROOT BOX and are
         * deliberately the same three fields the frame variant declares: the component
         * record IS its root node, so an instance renders as that box (dressed by the
         * component, overridden per key by the instance's own attrs) holding these
         * children. Two declarations of two fields is the whole cost of not having a
         * wrapper node nobody could point at. */
        NodeSpec component;
        component.kind = Kind::Component;
        component.name = "component";
        component.props = {
            text("name", "Component"),
            array("events"),
            /* the DESIGN FRAME: the size a component is AUTHORED at — its natural size,
             * the one the envelope contract will report. Purely an authoring convenience
             * for picking a sensible working size; it is not an instance size, and an
             * instance takes whatever box its parent gives it. A built-in carries no
             * document node and so no design frame either; the frontend falls back to
             * this same 240 x 120 default for one. */
            num("design_w", 240),
            num("design_h", 120),
            enumer("layout", {"free", "row", "col", "grid"}, "free"),
            object("attrs", Json::object()),
            object("interact", nullptr),
        };
        component.lists = {{"props", Kind::PropDef},
                           {"children", Kind::Node},
                           {"behavior", Kind::Flow}};
        t.push_back(component);

        /* One declared property = one served SlotSpec row: the optional keys (editor,
         * variants, step/min/max, history) are served only where they say something,
         * so a row here round-trips to exactly the wire shape (spec 2.3). A prop row
         * lives on the component (the widget's own vocabulary) or on any PART, whose
         * path prefixes its address. */
        NodeSpec prop;
        prop.kind = Kind::PropDef;
        prop.name = "prop";
        prop.props = {
            text("name"),
            enumer("shape", {"num", "bool", "text", "color", "enum", "series"}, "num"),
            any("default", 0.0),
            enumer("group", {"value", "appearance", "config", "frame"}, "appearance"),
            text("editor", ""),
            array("variants"),
            num("step", nullptr),
            num("min", nullptr),
            num("max", nullptr),
            boolean("history", false),
        };
        t.push_back(prop);

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
    for (const Variant& v : spec.variants)
        if (v.name == variant)
            for (const Prop& p : v.props) out.push_back(&p);
    return out;
}

std::vector<const ChildList*> node_lists(const NodeSpec& spec, const std::string& variant) {
    std::vector<const ChildList*> out;
    for (const ChildList& l : spec.lists) out.push_back(&l);
    for (const Variant& v : spec.variants)
        if (v.name == variant)
            for (const ChildList& l : v.lists) out.push_back(&l);
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
    for (const ChildList& l : spec.lists)
        if (l.key == key) return true;
    for (const Variant& v : spec.variants) {
        for (const Prop& p : v.props)
            if (p.key == key) return true;
        for (const ChildList& l : v.lists)
            if (l.key == key) return true;
    }
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

const ChildList* find_list(Kind parent, const std::string& variant, const std::string& list) {
    for (const ChildList* l : node_lists(node_spec(parent), variant))
        if (l->key == list) return l;
    return nullptr;
}

} // namespace hmi

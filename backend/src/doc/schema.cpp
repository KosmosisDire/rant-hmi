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
        doc.lists = {{"globals", {Kind::Var}}, {"tokens", {Kind::Token}},
                     {"components", {Kind::Component}}, {"pages", {Kind::Page}}};
        t.push_back(doc);

        NodeSpec page;
        page.kind = Kind::Page;
        page.name = "page";
        page.props = {text("name", "Page")};
        /* a page's children are widgets AND frames in ONE ordered list (proto doc
         * 2.2/2.4 one level up): z-order and flow order are the same order, so they
         * cannot live in two separate arrays. `kind` on each child says which. */
        page.lists = {{"children", {Kind::Frame, Kind::Widget}, "kind"}};
        t.push_back(page);

        NodeSpec widget;
        widget.kind = Kind::Widget;
        widget.name = "widget";
        widget.props = {
            /* the discriminator a page or frame's `children` reads (schema.h); fixed to
             * "widget" for every node of this kind, the same way a frame's is fixed to
             * "frame" — it exists so the two shapes can share one list, not as a choice
             * an instance makes */
            text("kind", "widget"),
            text("type", "Button"),
            text("label", ""),
            /* per-instance slot values, NESTED like the type's parts: a widget-level
             * slot is a key here, a part's slot a key inside an object named for the
             * part ({"bar": {"fill_color": "#fff"}} = slot address "bar.fill_color") */
            object("slots", Json::object()),
            /* PLACE: how the containing frame gives this instance room. `grow` is the
             * share of the free space it takes (1 = an equal share, 0 = only its `min`),
             * `min` a floor in CSS pixels on the container's MAIN axis. They live on the
             * CHILD because only the child knows what it needs; everything else about
             * where it lands is the container's. A frame declares the same pair. */
            num("grow", 1),
            num("min", 0),
        };
        widget.lists = {{"locals", {Kind::Var}}, {"feeds", {Kind::Feed}}, {"flows", {Kind::Flow}}};
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
        flow.lists = {{"do", {Kind::Step}}};
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

        /* A COMPONENT (spec 2.3): a widget type as document data. Its props are the
         * type's WIDGET-LEVEL slot specs (a part may declare its own), its parts the
         * visual template (attrs hold EXPRESSION TEXT, compiled to view programs by
         * compile/components.cpp), its events the {name, x, value?} rows, and its
         * behavior ordinary flows. A component with a built-in's name SHADOWS the
         * built-in in the derived registry. */
        NodeSpec component;
        component.kind = Kind::Component;
        component.name = "component";
        component.props = {
            text("name", "Component"),
            array("events"),
            /* the DESIGN FRAME: the size a component is AUTHORED at — its natural size,
             * the one the envelope contract will report. Purely an authoring convenience
             * for picking a sensible working size; it is not an instance size, and an
             * instance takes whatever box its frame gives it. A built-in carries no
             * document node and so no design frame either; the frontend falls back to
             * this same 240 x 120 default for one. */
            num("design_w", 240),
            num("design_h", 120),
        };
        component.lists = {{"props", {Kind::PropDef}},
                           {"parts", {Kind::Part}},
                           {"behavior", {Kind::Flow}}};
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

        /* One template node: a layout `box` (the only variant with a prop of its own,
         * `dir`, and the only kind that holds children or an interact) or a draw part.
         * `attrs` maps attr name -> expression text; `interact` is {primitive, params:
         * {name -> expression text}, emits: {primitive event -> declared event}},
         * null on a part that takes no gestures.
         *
         * A part OWNS PROPERTIES (spec 2.3): the props it declares are addressed under
         * its path (`bar.fill_color`), stored nested in an instance's `slots`, and
         * edited only while that part is selected. Its own props plus every ancestor's
         * are what its attr expressions see, so a value several parts read is declared
         * on the box that encloses them. */
        NodeSpec part;
        part.kind = Kind::Part;
        part.name = "part";
        part.variant_key = "kind";
        part.props = {
            enumer("kind",
                   {"box", "rect", "bar", "text", "icon", "arc", "needle",
                    "plot", "path", "code"},
                   "box"),
            text("name"),
            object("attrs", Json::object()),
            object("interact", nullptr),
            /* the `code` kind's body: user-authored JavaScript, run by the view once per
             * render (once per copy under `repeat`). It is never handed to the
             * template-expression compiler — compile/components.cpp passes it through
             * verbatim, alongside the part's lexical SCOPE, so the frontend can build
             * `props` by bare name without knowing the backend's own addressing scheme.
             * A common prop rather than a "code"-only variant field, the same way
             * `attrs` and `interact` are: harmless and unread on every other kind. */
            text("code", ""),
        };
        part.variants = {
            {"box", {enumer("dir", {"row", "col", "stack", "auto"}, "stack")}},
        };
        part.lists = {{"props", {Kind::PropDef}}, {"children", {Kind::Part}}};
        t.push_back(part);

        /* A FRAME (proto doc 2.2/2.4, one level up from the component-internal node
         * model it previews): a page-level container that groups widget instances and
         * other frames, and lays them out in a row, a column or a stack. It gives the
         * Layers tree a real hierarchy now that a widget's own internal parts are edited
         * in the Design workspace instead. A frame has NO geometry of its own, and neither
         * do its children: where a node lands follows from its order among its siblings and
         * from the container's own row/col/stack, gap, pad, align and justify — which is
         * what lets a page re-solve at a size nobody authored it at. "none" was the escape
         * hatch back to coordinates and went with them, so col is the default and the floor.
         *
         * FILL IS THE DEFAULT: `align` (the cross axis) starts at "stretch" and `grow`
         * at 1, so a child of a fresh frame occupies the room it is given instead of
         * shrinking to its content and leaving the author to place the remainder.
         *
         * `surface`, `border` and `radius` are deliberately the SAME NAMES a widget's
         * frame group already uses: one surface vocabulary at both tiers, so a pane and a
         * widget's panel are dressed with the same words. A colour is a "#rrggbb"/
         * "#rrggbbaa" literal or a "$name" theme-token reference, as everywhere else. */
        NodeSpec frame;
        frame.kind = Kind::Frame;
        frame.name = "frame";
        frame.props = {
            text("kind", "frame"),   /* the discriminator; see widget's own "kind" above */
            text("name", "Group"),
            enumer("layout", {"row", "col", "stack"}, "col"),
            num("gap", 0),
            num("pad", 0),
            enumer("align", {"start", "center", "end", "stretch"}, "stretch"),
            enumer("justify", {"start", "center", "end", "between"}, "start"),
            text("surface", ""),     /* "" = no surface at all, not a transparent one */
            text("border", ""),
            num("border_w", 1),
            num("radius", 0),
            /* the PLACE pair, declared identically on Kind::Widget above: a frame is a
               child of its own container, so it is placed by the same two numbers */
            num("grow", 1),
            num("min", 0),
        };
        frame.lists = {{"children", {Kind::Frame, Kind::Widget}, "kind"}};
        t.push_back(frame);

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

bool is_discriminator(Kind kind, const std::string& key) {
    for (const NodeSpec& spec : table())
        for (const ChildList& list : spec.lists) {
            if (list.discriminator != key) continue;
            for (Kind candidate : list.children)
                if (candidate == kind) return true;
        }
    return false;
}

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

const ChildList* find_list(Kind parent, const std::string& list) {
    for (const ChildList& l : node_spec(parent).lists)
        if (l.key == list) return &l;
    return nullptr;
}

bool list_child(Kind parent, const std::string& list, Kind& out) {
    const ChildList* l = find_list(parent, list);
    if (!l || l->children.size() != 1) return false;
    out = l->children[0];
    return true;
}

bool child_kind(const ChildList& list, const Json& child, Kind& out, std::string& err) {
    if (list.children.size() == 1) { out = list.children[0]; return true; }
    /* the legal-values text is built once per failure, never on the hot path */
    auto legal = [&] {
        std::string names;
        for (Kind k : list.children) {
            if (!names.empty()) names += ", ";
            names += "'" + std::string(kind_name(k)) + "'";
        }
        return names;
    };
    if (!child.is_object()) {
        err = "'" + list.key + "' child must be an object with a '" + list.discriminator +
              "' naming one of: " + legal();
        return false;
    }
    auto it = child.find(list.discriminator);
    if (it == child.end() || !it->is_string()) {
        err = "'" + list.key + "' child needs a '" + list.discriminator +
              "' naming one of: " + legal();
        return false;
    }
    const std::string want = it->get<std::string>();
    for (Kind k : list.children)
        if (node_spec(k).name == want) { out = k; return true; }
    err = "'" + list.discriminator + "' '" + want + "' is not one of: " + legal();
    return false;
}

} // namespace hmi

/* The document's node schema, as data. Every node kind declares its props (type,
 * default, reference role) and its child lists; op validation, default filling and
 * rename fan-out are one generic implementation over this table, so adding a
 * document field is a row here and nothing else. */
#pragma once

#include <nlohmann/json.hpp>
#include <cstdint>
#include <string>
#include <vector>

namespace hmi {

using Json = nlohmann::json;

/* A non-negative integer, however JSON happened to tag it: a parsed literal arrives
 * unsigned, one assigned from a C++ `int` arrives signed, and ids must read the same
 * either way. */
bool json_u64(const Json& value, uint64_t& out);
uint64_t json_u64_or(const Json& value, uint64_t fallback);

/* addressable node kinds; every instance carries a stable id.
 * node_spec() indexes the table by this enum, so the order here MUST match the order
 * the NodeSpecs are pushed in table(): append new kinds at the END of both.
 *
 * THERE IS ONE TREE. A page's frames, a component's internals and a widget instance were
 * three node kinds (Frame, Part, Widget) with three field models; they are now one `Node`
 * whose `kind` VARIANT says what it draws: frame | text | icon | path. A page holds
 * nodes, a frame holds nodes, a component holds nodes, and one inspector, one renderer
 * and one drag arithmetic serve all three because there is nothing left to tell apart.
 *
 * A WIDGET IS NOT A KIND. It is a frame with a `type`: it names a component, and that
 * component's children are its subtree — hidden on the page, entered to edit. The
 * component is the same frame, PRE-MADE and kept in the library instead of on a page,
 * and what earns it a record of its own is what it adds: declared properties, events and
 * behavior. So Page and Component are the two documents-of-nodes (a screen and a
 * template), neither a child of anything, and everything inside either one is a Node. */
enum class Kind { Doc, Page, Node, Var, Feed, Flow, Step, Token, Component, PropDef };

enum class PropType {
    Text,    /* string */
    Num,     /* number */
    Bool,    /* boolean */
    Enum,    /* string from `variants` */
    Object,  /* free-form object (slots, entity refs) */
    Array,   /* free-form array (trigger list) */
    Any,     /* any JSON value (a slot value, a variable's init) */
};

/* what a prop means for rename fan-out; Plain props hold no variable reference */
enum class Role {
    Plain,
    VarName,     /* a bare HMI variable name */
    EntityRef,   /* {kind, name}: an HMI variable only when kind == "L" */
    Expr,        /* expression text: identifiers may name variables */
    Triggers,    /* the flow's `when` array: timer entries name variables */
    MoveRef,     /* a move's `from` / `to`: an expression, a local name, or {kind, name} */
    Cases,       /* a feed's `cases` array: each entry's `xf` is an expression */
};

struct Prop {
    std::string key;
    PropType type = PropType::Any;
    Json def = nullptr;                  /* filled in on insert when absent */
    std::vector<std::string> variants;   /* PropType::Enum only */
    Role role = Role::Plain;
    /* An Enum prop may RETYPE another prop: each variant names the JSON shape that prop's
     * value must take, so the two can never disagree. A variable's `type` retypes its
     * `init` this way; without it a bool variable keeps the number 0 and compiles to
     * UNKNOWN, which is indistinguishable on screen from a value that has not arrived. */
    std::string retypes;
    std::vector<Json> variant_defaults;  /* parallel to `variants`; the shape to coerce to */
};

/* One child list, holding exactly one kind. Every list is uniform now that a page, a
 * frame and a component all hold the SAME kind of child: the discriminator machinery
 * that let a `{"kind":"frame"}` and a `{"kind":"widget"}` share one array went with the
 * split it existed to paper over — `kind` is a variant of one NodeSpec, not a choice
 * between two. */
struct ChildList {
    std::string key;
    Kind kind;
};

/* One variant of a node kind: the props AND the lists it adds on top of the common set.
 * A variant owns its lists because the variants differ in what they can HOLD, not only
 * in what they describe — a frame holds children, a widget holds its feeds and flows and
 * no children at all, a text leaf holds neither — and filling every node with every
 * other variant's empty arrays would make the document say things that are not true. */
struct Variant {
    std::string name;
    std::vector<Prop> props;
    std::vector<ChildList> lists;
};

/* A node kind. `variant_key` names the prop that selects a variant (a node switches on
 * "kind", a DO step likewise). */
struct NodeSpec {
    Kind kind;
    std::string name;
    std::vector<Prop> props;
    std::vector<ChildList> lists;
    std::string variant_key;
    std::vector<Variant> variants;
};

const NodeSpec& node_spec(Kind kind);
const char* kind_name(Kind kind);

/* the variant of a node instance, "" when its kind has none */
std::string node_variant(const NodeSpec& spec, const Json& node);

/* props of one node instance: the common set plus its variant's, in order */
std::vector<const Prop*> node_props(const NodeSpec& spec, const std::string& variant);
const Prop* find_prop(const NodeSpec& spec, const std::string& variant, const std::string& key);

/* lists of one node instance: the common set plus its variant's, in order. A variant's
 * lists are as much part of what the node IS as its props (a text leaf holds no
 * children), so every walk over a node's lists resolves the variant first. */
std::vector<const ChildList*> node_lists(const NodeSpec& spec, const std::string& variant);

/* the ChildList row for `parent`.`list` in `variant`, or null when that list does not
 * exist there — which is also how "a text leaf cannot hold children" is enforced, with no
 * kind named anywhere in the check. */
const ChildList* find_list(Kind parent, const std::string& variant, const std::string& list);

/* `value` as the same JSON shape as `like`, converting where the meaning carries (a number
 * to a bool by zero/non-zero, a bool to 0/1, a numeric string either way) and falling back
 * to `like` where it does not. Total: it always returns something of `like`'s shape. */
Json coerce_like(const Json& like, const Json& value);

/* Apply every retyping prop of this node, in declaration order. Returns the keys whose
 * value changed, so a caller that echoes ops can echo those too. Runs wherever the
 * document is written: on load, on insert, and after a set_prop. */
std::vector<std::string> retype_props(const NodeSpec& spec, Json& node);

/* Does this kind declare `key` at all: a common prop, ANY variant's prop, or a child
 * list? Flipping a DO step's kind leaves the previous variant's fields in place (they
 * are ignored by the compiler and reused if the user flips back), so a node is valid
 * while every key belongs to some variant, not only the active one. */
bool declares_key(const NodeSpec& spec, const std::string& key);

} // namespace hmi

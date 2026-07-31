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

/* addressable node kinds (spec 2.8); every instance carries a stable id.
 * node_spec() indexes the table by this enum, so the order here MUST match the order
 * the NodeSpecs are pushed in table(): append new kinds at the END of both. */
enum class Kind { Doc, Page, Widget, Var, Feed, Flow, Step, Token, Component, PropDef, Part, Frame };

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

/* One child list. Almost every list holds exactly one kind (`children` = {kind}, a
 * uniform vector); a PAGE or a FRAME's `children` holds several, because z-order and
 * flow order must be the SAME order, so a frame's widgets and sub-frames cannot live in
 * two separate arrays. A heterogeneous list's children carry a discriminator PROP (its
 * name in `discriminator`, always "kind") whose value names the target NodeSpec, so
 * `child_kind` below can tell a `{"kind":"frame", ...}` from a `{"kind":"widget", ...}`
 * sitting in the same array. `discriminator` is empty exactly when `children.size()==1`. */
struct ChildList {
    std::string key;
    std::vector<Kind> children;
    std::string discriminator;
};

/* A node kind. `variant_key` names the prop that selects a variant (DO steps switch
 * on "kind"); a variant contributes extra props on top of the common set. */
struct NodeSpec {
    Kind kind;
    std::string name;
    std::vector<Prop> props;
    std::vector<ChildList> lists;
    std::string variant_key;
    std::vector<std::pair<std::string, std::vector<Prop>>> variants;
};

const NodeSpec& node_spec(Kind kind);
const char* kind_name(Kind kind);

/* the variant of a node instance, "" when its kind has none */
std::string node_variant(const NodeSpec& spec, const Json& node);

/* props of one node instance: the common set plus its variant's, in order */
std::vector<const Prop*> node_props(const NodeSpec& spec, const std::string& variant);
const Prop* find_prop(const NodeSpec& spec, const std::string& variant, const std::string& key);

/* the ChildList row for `parent`.`list`, or null when that list does not exist */
const ChildList* find_list(Kind parent, const std::string& list);

/* the child kind of `parent`.`list`, valid for a SINGLE-kind list (out = children[0]);
 * false when the list does not exist or holds several kinds (use child_kind for those,
 * which resolves per NODE rather than per list). */
bool list_child(Kind parent, const std::string& list, Kind& out);

/* Resolve the Kind of one child node sitting in `list`. A uniform list (children.size()
 * == 1) always resolves to that one kind; a heterogeneous list (a page or frame's
 * `children`) reads the node's own `kind` prop and matches it against each candidate's
 * NodeSpec::name. False, with `err` naming the key and the legal values, when the
 * discriminator is missing or names nothing in `children` — used identically by adopt
 * (document load) and op validation (op_insert), so a malformed child is rejected rather
 * than silently defaulted into an arbitrary shape. */
bool child_kind(const ChildList& list, const Json& child, Kind& out, std::string& err);

/* Is `key` the discriminator of some heterogeneous list that can hold `kind`? Such a prop
 * does not describe the node, it names WHICH NODE IT IS, so it is structural: setting it
 * in place would leave every other field belonging to the shape the node used to be (a
 * "frame" still carrying locals/feeds/flows, a "widget" still carrying children), and the
 * next walk would index it as the new kind and quietly read the wrong fields. Refused by
 * op_set_prop — changing a node's kind means removing it and inserting the other one.
 *
 * Note this is the OPPOSITE rule to a variant_key ("kind" on a Part or a DO step), which
 * is deliberately settable and deliberately keeps the old variant's fields: a variant
 * flips within ONE NodeSpec, where every variant's key is a legal key. This flips BETWEEN
 * NodeSpecs, where they are not. */
bool is_discriminator(Kind kind, const std::string& key);

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

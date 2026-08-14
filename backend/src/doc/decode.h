/* THE TYPED DOCUMENT: what the compilers read.
 *
 * `Document` (doc.h) is the authoring artifact — the JSON tree the ops edit, the file
 * keeps and the wire serves, held as JSON precisely so the generic op machinery works
 * off the schema table. decode() is the one boundary between that tree and the compile
 * pipeline: it runs once at each compile entry and yields these records, so every
 * consumer downstream reads a FIELD where it used to probe a Json — the `contains`/
 * `is_string` walking that re-checked, at every use, what the schema had already
 * guaranteed at adopt.
 *
 * Decode is TOTAL and SILENT. A document that reaches a compiler has passed adopt() or
 * is a built-in definition, so a missing prop reads as the schema's own default and a
 * wrong-typed value reads as absent — the rule the old readers each restated with a
 * helper of their own, stated once. Where an old reader THREW on a wrong-typed value
 * instead (Json::value at a kind-flipped step's `a`), decode reads the default there
 * too: the crash was latent, never a behavior. Findings about what a
 * value MEANS (an init that cannot be its declared shape, an attr that is not
 * expression text) are the compilers' own and stay there — decode preserves exactly
 * the shape facts those findings read (`is_text`, `kind == None`).
 *
 * Strays stay strays: a key no record reads rides the JSON tree untouched and simply
 * does not decode. */
#pragma once

#include "doc.h"

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace hmi {

/* A NUMBER-OR-EXPRESSION leaf, the recurring authored shape (a cadence's ms, a
 * transition's time, a declared sweep): a plain number, or the TEXT of an expression.
 * None = absent; Other = present as something that is neither, which a reader refuses
 * with its own words. */
struct NumOrText {
    enum class Kind { None, Num, Text, Other };
    Kind kind = Kind::None;
    double num = 0.0;
    std::string text;
    /* the number's own JSON spelling (integer or float), because a folded transition
     * time is SERVED verbatim and 300 must not come back as 300.0 */
    Json raw;
};

/* One attr-style entry: a key whose value is expression text. `is_text` false is an
 * authored non-string — the compiler reports it against the key, so the fact rides. */
struct AttrDecl {
    std::string key;
    std::string text;
    bool is_text = false;
};

/* One per-attr transition row: {ms, profile?} beside the attr. `is_row` false is an
 * authored non-object, reported by the compiler in its own words. */
struct TransitionDecl {
    std::string key;
    bool is_row = false;
    NumOrText ms;          /* None = the row carried no `ms` at all */
    std::string profile;   /* "" = none */
};

/* One field of a path anchor, in authored (key-sorted) order. `arc` is the one nested
 * row; everything else is a coordinate expression. The kind says what was authored so
 * the anchor compiler's refusals keep their aim. */
struct AnchorField {
    enum class Kind { Text, Row, Other };
    std::string key;
    Kind kind = Kind::Other;
    std::string text;              /* Kind::Text */
    std::vector<AttrDecl> row;     /* Kind::Row — the arc's radii and flags */
};

struct AnchorDecl {
    bool is_row = false;           /* the entry was an object at all */
    std::vector<AnchorField> fields;
};

/* An element's gesture: {primitive, params?, bubbles?}. `primitive_text` keeps the
 * two readers honest — the serving default is "press" where no primitive was spelled,
 * while an authored empty string arms nothing and serves as itself. */
struct InteractDecl {
    bool present = false;
    bool primitive_text = false;   /* the record spelled `primitive` as a string */
    std::string primitive;
    std::vector<AttrDecl> params;
    bool bubbles = true;
};

/* One declared variable — a global, an element's local, a component's interface row.
 * `init` stays a VALUE (any JSON): its meaning is the declared type's to give, and the
 * findings about a value that cannot be its shape belong to the compiler that knows
 * the shape. */
struct VarDecl {
    uint64_t id = 0;
    std::string name;
    std::string type = "num";
    std::string elem;              /* a list/map's declared element type, "" = undeclared */
    std::string leaf;              /* a nested row's held type */
    Json init;                     /* null = a deliberate UNKNOWN start */
    bool persist = false;
    bool is_public = false;
    std::string group = "appearance";
    std::string editor;
    std::vector<std::string> variants;   /* constrained text: the picker's vocabulary */
    /* null = unset; a number otherwise. Held as JSON because the served row carries
     * the authored spelling verbatim — nothing in the compile reads them. */
    Json step, min, max;
    NumOrText smooth;              /* the declared render sweep */
    std::string profile;
};

/* An assignment's source. The discriminator keys are kept as facts, not folded, so the
 * old routing order holds exactly: `has_any` is what the no-value refusal reads, and a
 * row carrying both `expr` and `init` still resets. `expr_text` false with `has_expr`
 * true is a present-but-unspeakable source, which reads as the pipeline register. */
struct FromDecl {
    bool has_any = false;          /* any discriminator key at all */
    bool has_expr = false;
    bool has_init = false;
    bool expr_text = false;
    std::string expr;
};

/* An assignment's destination: a PLACE, picked, never typed. Exactly one of the three
 * forms is meant; the compiler routes on them in the authored order. */
struct ToDecl {
    std::string slot;              /* "" = not a slot destination */
    bool has_local = false;
    std::string local;
    std::string path;              /* a field of a struct holder */
    std::string type;              /* a typed temporary's TypeRef */
    bool has_kind = false;         /* an entity destination */
    std::string kind;
    std::string name;
};

/* One DO step. Every kind's fields ride one record — a step keeps its old variant's
 * fields across a kind flip, and the compiler reads only its own kind's. */
struct StepDecl {
    uint64_t id = 0;
    std::string kind;
    FromDecl from;
    ToDecl to;
    std::string mode = "write";
    std::string keep;              /* raw; the reader trims */
    std::string key;
    NumOrText a;                   /* a gate's text, a deadband/throttle/delay's number */
    std::string timer;
    std::string event;             /* raise */
    std::map<std::string, std::string> args;
    std::string text;              /* notify */
    std::string ms;
};

struct TriggerDecl {
    std::string kind;              /* "event" | "timer" | "every" */
    std::string name;              /* the event */
    std::string var;               /* the timer variable */
    std::string element;           /* the element channel (behavior only) */
    NumOrText ms;                  /* an `every` trigger's cadence */
    double hold_ms = 600.0;
    double every_ms = 0.0;
};

struct FlowDecl {
    uint64_t id = 0;
    std::vector<TriggerDecl> when;   /* empty = "flow has no trigger" */
    std::string when_mode = "first";
    std::vector<StepDecl> steps;
};

/* One node of the one tree: a page's element or a component's internals — same record,
 * because they are the same kind. `slots` stays a VALUE TREE (an instance's authored
 * values, any JSON, walked by authored_slot): what a value means is the declared
 * slot's shape to decide. */
struct NodeDecl {
    uint64_t id = 0;
    std::string kind = "frame";
    std::string name;
    std::string type;                        /* frame: "" or the component it places */
    std::vector<AttrDecl> attrs;             /* key-sorted, as the object iterates */
    std::vector<TransitionDecl> transitions;
    std::vector<AnchorDecl> anchors;         /* path */
    bool closed = false;                     /* path */
    Json slots = Json::object();             /* instance slot values */
    std::map<std::string, double> poll;      /* per-slot poll hz, numeric entries only */
    InteractDecl interact;
    std::vector<VarDecl> locals;
    std::vector<FlowDecl> flows;
    std::vector<NodeDecl> children;
};

struct PageDecl {
    uint64_t id = 0;
    std::vector<NodeDecl> children;
};

struct TokenDecl {
    std::string name;
    std::string dark;              /* the canonical runtime resolution */
};

/* A component definition — a document row or a built-in, one shape. The record IS its
 * root node (`root` carries the attrs, interact, locals and children); `events` and
 * `behavior` stay JSON because they are served VERBATIM in the registry row, and the
 * document compiler reads them back off that row (the seam dies at stage 5b, when the
 * registry becomes a pure serving product). */
struct ComponentDecl {
    uint64_t id = 0;
    std::string name;
    double design_w = 240.0;
    double design_h = 120.0;
    Json events = Json::array();
    Json behavior = Json::array();
    NodeDecl root;
};

struct Doc {
    uint64_t version = 0;
    std::vector<VarDecl> globals;
    std::vector<TokenDecl> tokens;
    std::vector<ComponentDecl> components;
    std::vector<PageDecl> pages;
};

Doc decode_document(const Document& document);

/* one component record: a doc.components row, or a built-in definition (which never
 * went through adopt — the same defaults hold, stated here once) */
ComponentDecl decode_component(const Json& record);

/* one flow record: a document flow, or a registry row's behavior flow — the document
 * compiler reads both through this */
FlowDecl decode_flow(const Json& record);

} // namespace hmi

/* The mesh seam (PLAN.md: The DART seam). compile/vm/sched see ONLY this interface:
 * reflection records out, effects in, decoded deliveries into the tick's inbound path.
 * The fake mesh and the real DART adapter are the two implementations. Everything here
 * is called from the logic thread; an implementation with its own I/O threads keeps
 * them behind its drain/refresh boundary. */
#pragma once

#include "vm/state.h"

#include <string>
#include <string_view>
#include <vector>

namespace hmi {

struct MeshElems;

struct EffectView {
    Verb verb = Verb::Write;
    const EntityDef* entity = nullptr;
    bool bare = false;
    uint32_t field = 0;
    /* an ELEMENT write into an array field: the position `value` lands at, UINT32_MAX
     * for a whole-field write. The encode rewrites that one element over the RMW base's
     * own bytes, so the rest of the owner's array rides through untouched. */
    uint32_t elem_index = UINT32_MAX;
    Value value = Value::nil();
    const Value* fields = nullptr;
    const uint8_t* set = nullptr;
    uint32_t field_count = 0;
    std::string_view bare_text;
    const FixedText* field_text = nullptr;
    /* AGGREGATE payloads per field (the emit's deep copy, resolved into spans at
     * flush): elems[i] carries field i's elements — a map's pairs interleaved,
     * texts[k] backing data[k] where that element is text. Null where this effect
     * carries no aggregate. Valid for the execute() call only. The write-out mirror
     * of MeshUpdate.elems. */
    const MeshElems* elems = nullptr;
};

/* The decoded elements behind one aggregate field: `count` Values (a map interleaves
 * key,value, so 2 x pairs). texts[k] backs data[k] when that element is Text. */
struct MeshElems {
    const Value* data = nullptr;
    const std::string_view* texts = nullptr;
    uint32_t count = 0;
};

/* One decoded arrival from the mesh: the entity's current field values, in the order of
 * its reflected field table (a FUNCTION delivers its RESPONSE fields, everything else
 * its value fields). An aggregate field carries a List/Map head value whose elements
 * ride in elems[i]; a field the codec cannot represent arrives Nil. Views are valid for
 * the on_update call only. */
struct MeshUpdate {
    EntityKind kind = EntityKind::Variable;
    std::string_view name;
    const Value* fields = nullptr;
    const std::string_view* texts = nullptr;   /* texts[i] backs fields[i] when Text */
    const MeshElems* elems = nullptr;          /* elems[i] backs fields[i] when List/Map */
    uint32_t field_count = 0;
};

class MeshSink {
  public:
    virtual ~MeshSink() = default;
    virtual void on_update(const MeshUpdate& update) = 0;
};

/* One line off the mesh's built-in @dart/log/{error,warn,info} topics: who logged, at
 * what wall time, and the line itself. Owned copies — the transport's views die with the
 * delivery callback, and these cross from the mesh's polling thread to the logic thread. */
struct MeshLogLine {
    int level = 2;              /* 0 error, 1 warn, 2 info (DartLogLevel's order) */
    std::string node;           /* the publishing node's name */
    std::string text;
    uint64_t wall_us = 0;       /* epoch micros, comparable across nodes */
};

class MeshPort {
  public:
    virtual ~MeshPort() = default;
    virtual const std::vector<EntityDef>& reflection() const noexcept = 0;
    virtual bool execute(const EffectView& effect, std::string& fault) noexcept = 0;

    /* Hand every delivery that arrived since the last call to the sink, decoded.
     * Called at the top of each tick (tick step 1), on the logic thread. */
    virtual void drain(MeshSink& sink) { (void)sink; }

    /* Reconcile subscriptions and function polls with a freshly compiled program:
     * which entities its programs read (flow reads and slot expressions alike), and at
     * what rate a function a slot expression calls is polled.
     * Called after every accepted compile, on the logic thread. */
    virtual void apply(const Program& program) { (void)program; }

    /* The pages at least one visible session is viewing; a function feed on any other
     * page stops polling (the spec's visibility rule, page-scoped). */
    virtual void set_viewed_pages(const std::vector<uint64_t>& pages) { (void)pages; }

    /* Refresh the reflection snapshot from the live mesh. Returns true when the
     * snapshot CHANGED, which is the caller's cue to recompile (a schema arriving or
     * changing re-resolves through the ordinary recompile + hot-swap path). Called at
     * control-plane rate on the logic thread; reflection() stays valid across it. */
    virtual bool refresh() { return false; }

    /* Append every @dart/log line that arrived since the last call and forget them.
     * Called at control-plane rate on the logic thread; a mesh with no log stream (the
     * fake, an offline node) appends nothing. */
    virtual void take_logs(std::vector<MeshLogLine>& out) { (void)out; }
};

bool flush_effects(const Program& program, RuntimeState& state, MeshPort& mesh,
                   std::string& fault) noexcept;

} // namespace hmi

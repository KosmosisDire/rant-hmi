/* The wiring: the document, the served registry and the sync protocol in one service
 * loop. Everything below is called from ONE thread (PLAN.md: one logic thread); the
 * server's threads only fill and drain queues. The scheduler, compiler and mesh join
 * this loop at their build-order stages. */
#pragma once

#include "diag.h"
#include "doc/doc.h"
#include "mesh/dart_mesh.h"
#include "mesh/fake.h"
#include "sched/scheduler.h"
#include "sync/server.h"

#include <chrono>
#include <deque>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <unordered_map>

namespace hmi {

/* bumped when a frame shape changes; a client with another number is refused
 * (3: the snapshot carries `builtins`, the built-ins' editable document form; 4: the
 * snapshot also carries `attr_table`, the closed attr vocabulary, spec 2.3; 5: the doc
 * lost `canvas` and every node lost `geom`; 6: a frame gained layout "stack", justify,
 * surface/border/border_w/radius, and both frames and instances gained grow/min; 7: move
 * reparents (its echo always carries parent+list+index) and `wrap` folds siblings into a
 * fresh frame; 8: ONE TREE — Frame, Widget and Part are one `node` kind with four
 * variants (frame | text | icon | path), every field is expression text in `attrs`, an
 * instance is a frame carrying a `type`, a component holds `children` and describes its
 * own root box, and the snapshot carries `node_attrs`, every page node's compiled attrs;
 * 10: list and map cells LEAVE `values` for the `aggs` delta lane — per-cell generation
 * and append cursor, appends only in a live frame, whole on a gen change, absent when
 * nothing moved — and `hist` is gone with the sampling ring it carried;
 * 12: FEEDS ARE GONE (spec D1) — a slot value is number | bool | wire-tier EXPRESSION
 * text the backend compiles and evaluates standing (`@entity.field` reads the mesh,
 * quoted text is the literal), instances carry a `poll` {slot: hz} map instead of
 * poll_hz, and the attr table gains a `variants` column;
 * 13: READ and WRITE unify into ASSIGNMENT — the step kind `move` is `assign`, its
 * `from` is `{expr}` always (plus `{init:true}` reset: the structural entity/local
 * source forms died into the `@name` / bare-name spellings), and flow expressions
 * bind the mesh under `@` exactly as slot expressions do;
 * 14: THE LOG — the snapshot carries `log` (the backlog of @dart/log lines and hmi
 * notifications, oldest first) and a `log` frame appends live entries {level, node,
 * text, wall_us, ms?}; the step kind `notify` broadcasts a notification to every
 * session as a level "notify" entry;
 * 15: ONE VOCABULARY — COMPONENT (a definition in the library), INSTANCE (a node
 * placing one) and ELEMENT (any node in the tree, including one named inside a
 * component). The served registry lists `components`, not `types`; an `input` frame
 * carries {node, event, value, seq, element} where `widget_id` and `part` stood; a
 * flow trigger's channel key is `element`; and the expression prefix `widget.<slot>`
 * is spelled `this.<slot>` in both tiers;
 * 16: THE DISPLAY TIER GETS THE WHOLE UNIVERSE — an attr on a PAGE element names the
 * variables in its lexical scope and the mesh, exactly as a flow does. A served view
 * program gains two cell kinds, `var:<id>` (loaded from the variable's own `v<id>` live
 * value) and `mesh:<entity>[.<field>]`, and a live frame carries the read mesh fields
 * beside the cells — scalars in `values`, aggregates on the `aggs` lane. A COMPONENT's
 * attrs still see neither: isolation is what the scope does not carry;
 * 17: THE COPY RIDES THE EVENT — an `input` frame from inside a `repeat` carries
 * `repeat: {index, count}`, absent outside one. A repeated element is ONE element with
 * one set of cells, so the copy is not runtime storage: it arrives with the gesture and
 * an event-triggered flow reads it as `repeat.index` / `.count` / `.fraction`, which is
 * what makes `@arr[repeat.index] = x` write the copy that was pressed;
 * 18: A PROPERTY IS A PUBLIC VARIABLE — the `props` list and the PropDef row are gone
 * from the document. A component declares `locals` like every other element, and a
 * variable marked `public` is what an instance fills in; a private one is the
 * component's own storage, served (its cell and address are real) but never offered.
 * `type` and `shape` are ONE vocabulary now — `f64`/`str` are spelled `num`/`text`,
 * `color` is a variable type, and a `text` with `variants` is what `enum` was — so a
 * served row carries {shape, default, public, elem?} where a PropDef's did */
constexpr int kProto = 18;

struct AppOptions {
    ServerOptions server;
    std::string doc_path = "hmi.json";
    bool persist = true;      /* write the document back on every accepted edit */
    bool verbose = false;
    bool mesh = true;         /* false = offline: a FakeMesh with no entities */
    DartMeshOptions mesh_opts;
};

class App {
  public:
    /* `mesh` overrides the port the options would build. The service loop never passes
     * one; a test does, so the whole App — the compile, the consume list, the live frame
     * — can be exercised against a mesh whose arrivals it controls. */
    explicit App(AppOptions opts, std::unique_ptr<MeshPort> mesh = nullptr);

    bool start(std::string& err);
    void stop();

    /* one pass over everything that arrived; returns how many frames it handled. The
     * service loop that calls this lives in main.cpp. */
    size_t poll();

    Document& document() { return doc_; }
    Server& server() { return server_; }
    uint64_t edits() const { return edits_; }

  private:
    struct SessionState {
        bool hello = false;
        std::string name;
        uint64_t page = 0;
        bool visible = true;
    };

    void on_frame(uint64_t session, const Json& frame);
    void on_hello(uint64_t session, const Json& frame);
    void on_apply_ops(uint64_t session, const Json& frame);
    void on_input(uint64_t session, const Json& frame);
    void compile_runtime();
    void publish_live();
    void update_viewed_pages();
    /* everything the log gained this pass — the mesh's @dart/log arrivals and the
     * notify steps' notices — into the ring and out to every session as one frame */
    void publish_log();
    /* the notify steps' records, captured AFTER each tick (the next tick clears
     * the outbox) into the pending frame */
    void drain_notices();
    /* runtime + effect faults into the log, COALESCED PER SITE: the first fault of a
     * site logs immediately, after which that site logs at most once per window with
     * the count it gathered. Keyed per site (effect faults per message), so two sites
     * faulting in alternation coalesce independently instead of defeating each other. */
    void drain_faults();

    Json snapshot() const;
    /* `full` is the SNAPSHOT's reading: every aggregate cell whole. A live frame sends
     * only what moved — appends since the cursor, or the whole cell when its generation
     * did — and omits a cell that did not move at all. */
    Json live(bool full = false) const;
    /* one aggregate's frame entry, or null when it has not moved since the cursor. Takes
     * the RETAINED SLOT rather than a cell, because a mesh field's mirror lives in the
     * same `lists` vector (appended after the cells') and rides the same delta lane. */
    Json agg_entry(uint32_t list_slot, Shape shape, const Value& value, bool full) const;
    Json mesh_json() const;
    /* the expression vocabulary (builtins + shape-scoped methods) for autocomplete */
    static Json lang_json();
    /* the current compile's diagnostics, as the wire carries them. A joining client gets
     * them in its snapshot: they are computed once at startup, so a view that arrives
     * later would otherwise never learn why its instance is dead. */
    Json diagnostics() const;
    void send_snapshot(uint64_t session);
    void reject(uint64_t session, const std::string& reason);

    /* the stale-base rule: which nodes changed since a given version */
    bool base_is_usable(uint64_t base, const Json& ops, std::string& why) const;
    void remember(uint64_t version, const std::vector<uint64_t>& touched);

    AppOptions opts_;
    Document doc_;
    /* The served registry: a COMPILE PRODUCT (built-ins shadowed/extended by the
     * document's components), rebuilt by every compile_runtime(). Component compile
     * findings land beside it and ride diagnostics() with the program's own. */
    Json registry_;
    /* every page node's compiled attrs, keyed by node id: the other half of the compile
       product, and the reason a page and a component render through one path */
    Json node_attrs_;
    /* every mesh field a PAGE's attrs read, as "<entity>\n<path>": the attr compiler
       gathers it, the live frame serves exactly those mirrors off it, and the mesh is
       handed the read entities at apply(). The display product's own fact — nothing
       is stamped into the wire compile. */
    std::set<std::string> attr_entity_reads_;
    std::vector<Diag> component_diags_;
    Server server_;
    std::unordered_map<uint64_t, SessionState> sessions_;
    std::deque<std::pair<uint64_t, std::vector<uint64_t>>> history_;
    std::vector<Inbound> batch_;
    uint64_t edits_ = 0;
    uint64_t epoch_ = 1;
    std::unique_ptr<MeshPort> mesh_;
    DartMesh* dart_mesh_ = nullptr;   /* set when mesh_ is the real adapter */
    std::unique_ptr<Scheduler> scheduler_;
    std::chrono::steady_clock::time_point next_tick_;
    std::chrono::steady_clock::time_point next_mesh_refresh_;
    uint64_t last_live_tick_ = 0;
    /* WHAT EACH AGGREGATE CELL LOOKED LIKE at the last broadcast, per retained slot: the
     * generation it was in and how many elements had ever been appended within it. A
     * frame omits any cell still at this pair, sends the appends past `total` while the
     * generation holds, and sends the whole cell when it moved. Reset to the unpublished
     * sentinel on every recompile, so the frame after one carries everything. */
    struct AggCursor {
        uint32_t gen = UINT32_MAX;
        uint64_t total = UINT64_MAX;
    };
    std::vector<AggCursor> agg_published_;
    /* THE LOG RING: what the mesh's @dart/log topics said and what notify steps spoke,
     * newest at the back, bounded. The snapshot carries the whole ring (a late joiner
     * sees history); a `log` frame carries only what just arrived. */
    std::deque<Json> log_;
    std::vector<Json> fresh_log_;          /* arrived this poll, not yet broadcast */
    std::vector<MeshLogLine> mesh_logs_;   /* take_logs scratch, reused per poll */
    /* FAULT COALESCING, one row per fault SITE (and one per effect-fault message):
     * what the state counter read at the last drain, how many faults gathered since
     * the last emitted entry, and the tick the next entry may go out — the window
     * rides the scheduler's own tick clock, which migrates across recompiles. */
    struct PendingFault {
        uint32_t seen = 0;
        uint64_t pending = 0;
        uint64_t emit_tick = 0;
    };
    std::vector<PendingFault> fault_sites_;         /* [runtime fault site] */
    std::map<std::string, PendingFault> effect_faults_;   /* by fault message */
};

} // namespace hmi

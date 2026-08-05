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
#include <memory>
#include <string>
#include <unordered_map>

namespace hmi {

/* bumped when a frame shape changes; a client with another number is refused
 * (3: the snapshot carries `builtins`, the built-ins' editable document form; 4: the
 * snapshot also carries `attr_table`, the closed attr vocabulary, spec 2.3; 5: the doc
 * lost `canvas` and every node lost `geom`; 6: a frame gained layout "stack", justify,
 * surface/border/border_w/radius, and both frames and widgets gained grow/min; 7: move
 * reparents (its echo always carries parent+list+index) and `wrap` folds siblings into a
 * fresh frame; 8: ONE TREE — Frame, Widget and Part are one `node` kind with four
 * variants (frame | text | icon | path), every field is expression text in `attrs`, an
 * instance is a frame carrying a `type`, a component holds `children` and describes its
 * own root box, and the snapshot carries `node_attrs`, every page node's compiled attrs;
 * 10: list and map cells LEAVE `values` for the `aggs` delta lane — per-cell generation
 * and append cursor, appends only in a live frame, whole on a gen change, absent when
 * nothing moved — and `hist` is gone with the sampling ring it carried) */
constexpr int kProto = 10;

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
    explicit App(AppOptions opts);

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

    Json snapshot() const;
    /* `full` is the SNAPSHOT's reading: every aggregate cell whole. A live frame sends
     * only what moved — appends since the cursor, or the whole cell when its generation
     * did — and omits a cell that did not move at all. */
    Json live(bool full = false) const;
    /* one aggregate cell's frame entry, or null when it has not moved since the cursor */
    Json agg_entry(const CellDef& cell, const Value& value, bool full) const;
    Json mesh_json() const;
    /* the expression vocabulary (builtins + shape-scoped methods) for autocomplete */
    static Json lang_json();
    /* the current compile's diagnostics, as the wire carries them. A joining client gets
     * them in its snapshot: they are computed once at startup, so a view that arrives
     * later would otherwise never learn why its widget is dead. */
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
};

} // namespace hmi

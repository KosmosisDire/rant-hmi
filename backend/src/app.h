/* The wiring: the document, the served registry and the sync protocol in one service
 * loop. Everything below is called from ONE thread (PLAN.md: one logic thread); the
 * server's threads only fill and drain queues. The scheduler, compiler and mesh join
 * this loop at their build-order stages. */
#pragma once

#include "doc/doc.h"
#include "mesh/fake.h"
#include "sched/scheduler.h"
#include "sync/server.h"

#include <chrono>
#include <deque>
#include <memory>
#include <string>
#include <unordered_map>

namespace hmi {

/* bumped when a frame shape changes; a client with another number is refused */
constexpr int kProto = 1;

struct AppOptions {
    ServerOptions server;
    std::string doc_path = "hmi.json";
    bool persist = true;      /* write the document back on every accepted edit */
    bool verbose = false;
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

    Json snapshot() const;
    Json live() const;
    void send_snapshot(uint64_t session);
    void reject(uint64_t session, const std::string& reason);

    /* the stale-base rule: which nodes changed since a given version */
    bool base_is_usable(uint64_t base, const Json& ops, std::string& why) const;
    void remember(uint64_t version, const std::vector<uint64_t>& touched);

    AppOptions opts_;
    Document doc_;
    Server server_;
    std::unordered_map<uint64_t, SessionState> sessions_;
    std::deque<std::pair<uint64_t, std::vector<uint64_t>>> history_;
    std::vector<Inbound> batch_;
    uint64_t edits_ = 0;
    uint64_t epoch_ = 1;
    FakeMesh mesh_;
    std::unique_ptr<Scheduler> scheduler_;
    std::chrono::steady_clock::time_point next_tick_;
    uint64_t last_live_tick_ = 0;
};

} // namespace hmi

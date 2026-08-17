/* The real DART adapter behind the MeshPort seam (PLAN.md stage 5). One dart::Node on
 * its own service thread; reflection from the peer entity walk, folded and deduped into
 * EntityDefs; handles cached per entity until its schema hash changes (then retired
 * and re-created with the new type); payloads encoded and
 * decoded by the OWNER's reflected layout, never a schema we impose. dart.hpp stays
 * behind this header (pimpl), so compile/vm/sched never see it. */
#pragma once

#include "port.h"

#include <memory>
#include <string>
#include <vector>

namespace hmi {

struct DartMeshOptions {
    std::string node_name = "hmi";
    uint16_t domain = 0;
    std::string interface_ip;              /* multicast interface; empty = auto probe */
    std::vector<std::string> seed_peers;   /* "ip" or "ip:port" unicast discovery seeds */
    uint16_t max_topics = 128;             /* the node's topic reserve (channels, not entities) */
    uint16_t discovery_port = 0;           /* 0 = the DART default (7400) */
    uint32_t announce_interval_us = 0;     /* 0 = the DART default (1s) */
    bool verbose = false;
};

class DartMesh final : public MeshPort {
  public:
    explicit DartMesh(DartMeshOptions opts);
    ~DartMesh() override;

    /* Open the node and start its service thread. false + err on failure. */
    bool start(std::string& err);

    const std::vector<EntityDef>& reflection() const noexcept override;
    bool execute(const EffectView& effect, std::string& fault) noexcept override;
    void drain(MeshSink& sink) override;
    void apply(const Program& program,
               const std::set<std::string>& display_reads) override;
    void set_viewed_pages(const std::vector<uint64_t>& pages) override;
    bool refresh() override;
    void take_logs(std::vector<MeshLogLine>& out) override;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace hmi

#include "app.h"

#include "doc/ops.h"
#include "registry/registry.h"

#include <chrono>
#include <cstdio>
#include <thread>

namespace hmi {
namespace {

/* how many versions of edit history the stale-base rule can look back over; a client
 * older than this reloads from a snapshot instead */
constexpr size_t kHistoryDepth = 128;

/* Client frames are untrusted: read fields without ever throwing. */
Json field(const Json& object, const char* key) {
    if (!object.is_object()) return nullptr;
    auto it = object.find(key);
    return it == object.end() ? Json(nullptr) : *it;
}

std::string str_or(const Json& value, const char* fallback) {
    return value.is_string() ? value.get<std::string>() : fallback;
}

std::string frame_type(const Json& frame) { return str_or(field(frame, "type"), ""); }

/* the nodes an op batch touches, as the client asked for them */
void op_targets(const Json& ops, std::vector<uint64_t>& out) {
    if (!ops.is_array()) return;
    for (const Json& op : ops) {
        if (!op.is_object()) continue;
        for (const char* key : {"node", "parent"}) {
            auto it = op.find(key);
            if (it == op.end()) continue;
            uint64_t id = 0;
            if (json_u64(*it, id)) out.push_back(id);
        }
    }
}

} // namespace

App::App(AppOptions opts) : opts_(std::move(opts)), server_(opts_.server) {}

bool App::start(std::string& err) {
    if (!Document::from_file(opts_.doc_path, doc_, err)) {
        std::printf("hmi: no document at %s (%s), starting from the default\n",
                    opts_.doc_path.c_str(), err.c_str());
        doc_ = Document::make_default();
        if (opts_.persist && !doc_.to_file(opts_.doc_path, err)) return false;
    }
    return server_.start(err);
}

void App::stop() { server_.stop(); }

size_t App::poll() {
    server_.drain(batch_);
    for (const Inbound& in : batch_) {
        switch (in.what) {
            case Inbound::What::Joined:
                sessions_[in.session] = SessionState{};
                if (opts_.verbose)
                    std::printf("hmi: session %llu from %s\n",
                                static_cast<unsigned long long>(in.session), in.client.c_str());
                break;
            case Inbound::What::Frame:
                on_frame(in.session, in.frame);
                break;
            case Inbound::What::Gone:
                sessions_.erase(in.session);
                if (opts_.verbose)
                    std::printf("hmi: session %llu gone\n",
                                static_cast<unsigned long long>(in.session));
                break;
        }
    }
    return batch_.size();
}

void App::on_frame(uint64_t session, const Json& frame) {
    if (frame.is_discarded() || !frame.is_object()) {
        reject(session, "frame is not JSON");
        return;
    }
    const std::string type = frame_type(frame);
    if (type == "hello") { on_hello(session, frame); return; }

    auto it = sessions_.find(session);
    if (it == sessions_.end()) return;
    if (!it->second.hello) { reject(session, "say hello first"); return; }

    if (type == "view") {
        it->second.page = json_u64_or(field(frame, "page_id"), 0);
        const Json visible = field(frame, "visible");
        it->second.visible = visible.is_boolean() ? visible.get<bool>() : true;
        return;
    }
    if (type == "apply_ops") { on_apply_ops(session, frame); return; }
    if (type == "input") {
        /* behavior runs at build-order stage 4; the frame shape is already the one the
         * scheduler will consume, so the frontend can be written against it now */
        if (opts_.verbose)
            std::printf("hmi: input %s\n", frame.dump().c_str());
        return;
    }
    reject(session, "unknown frame '" + type + "'");
}

void App::on_hello(uint64_t session, const Json& frame) {
    auto it = sessions_.find(session);
    if (it == sessions_.end()) return;
    const uint64_t proto = json_u64_or(field(frame, "proto"), 0);
    if (proto != static_cast<uint64_t>(kProto)) {
        reject(session, "protocol " + std::to_string(proto) + ", this backend speaks " +
                            std::to_string(kProto));
        server_.disconnect(session);
        return;
    }
    it->second.hello = true;
    it->second.name = str_or(field(frame, "client_name"), "view");
    server_.send(session, Json{{"type", "welcome"},
                               {"session_id", session},
                               {"proto", kProto},
                               {"doc_version", doc_.version()}});
    send_snapshot(session);
}

void App::on_apply_ops(uint64_t session, const Json& frame) {
    const uint64_t base = json_u64_or(field(frame, "base_version"), 0);
    const Json ops = field(frame, "ops");

    std::string why;
    if (!base_is_usable(base, ops, why)) { reject(session, why); return; }

    ApplyResult applied;
    std::string err;
    if (!apply_ops(doc_, ops, applied, err)) { reject(session, err); return; }

    remember(applied.version, applied.touched);
    ++edits_;
    if (opts_.persist && !doc_.to_file(opts_.doc_path, err))
        std::printf("hmi: cannot save %s: %s\n", opts_.doc_path.c_str(), err.c_str());

    server_.broadcast(Json{{"type", "ops_applied"},
                           {"version", applied.version},
                           {"ops", applied.ops},
                           {"origin_session", session}});
}

Json App::live() const {
    /* one map over the cell table; empty until the runtime owns cells (stage 4) */
    return Json{{"epoch", epoch_}, {"values", Json::object()}};
}

Json App::snapshot() const {
    return Json{{"type", "snapshot"},
                {"version", doc_.version()},
                {"doc", doc_.root},
                {"registry", registry()},
                {"live", live()}};
}

void App::send_snapshot(uint64_t session) { server_.send(session, snapshot()); }

void App::reject(uint64_t session, const std::string& reason) {
    server_.send(session, Json{{"type", "reject"}, {"reason", reason}});
    auto it = sessions_.find(session);
    if (it != sessions_.end() && it->second.hello) send_snapshot(session);
}

bool App::base_is_usable(uint64_t base, const Json& ops, std::string& why) const {
    const uint64_t now = doc_.version();
    if (base == now) return true;
    if (base > now) {
        why = "base version " + std::to_string(base) + " is ahead of " + std::to_string(now);
        return false;
    }
    if (history_.empty() || history_.front().first > base + 1) {
        why = "base version " + std::to_string(base) + " is too far behind " +
              std::to_string(now);
        return false;
    }
    /* Concurrent edits are fine while they touch different nodes; that is the common
     * case for two people on one panel (spec 4.2). Overlap is a reject. */
    std::vector<uint64_t> targets;
    op_targets(ops, targets);
    for (const auto& entry : history_) {
        if (entry.first <= base) continue;
        for (uint64_t changed : entry.second)
            for (uint64_t target : targets)
                if (changed == target) {
                    why = "node " + std::to_string(target) + " changed since version " +
                          std::to_string(base);
                    return false;
                }
    }
    return true;
}

void App::remember(uint64_t version, const std::vector<uint64_t>& touched) {
    history_.push_back({version, touched});
    while (history_.size() > kHistoryDepth) history_.pop_front();
}

} // namespace hmi

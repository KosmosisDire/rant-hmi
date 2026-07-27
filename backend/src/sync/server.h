/* Transport for the sync protocol: one port that serves the frontend's static files
 * over HTTP and upgrades /sync to a WebSocket session. This layer knows sessions and
 * frames, never document rules: client frames land in a bounded queue that the logic
 * thread drains (PLAN.md, cross-thread queues), and outbound frames are handed back
 * per session or broadcast. A session that overruns its queue is disconnected and
 * reconnects to a fresh snapshot. */
#pragma once

#include "doc/schema.h"

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace ix {
class HttpServer;
class WebSocket;
} // namespace ix

namespace hmi {

/* one thing that happened on a session, in arrival order */
struct Inbound {
    enum class What { Joined, Frame, Gone };
    What what = What::Frame;
    uint64_t session = 0;
    Json frame;              /* Frame only; discarded JSON means a malformed frame */
    std::string client;      /* Joined: the peer address, for logging */
};

struct ServerOptions {
    int port = 7500;
    std::string bind = "127.0.0.1";
    std::string statics;         /* directory served over HTTP; empty = none */
    size_t max_queued = 2048;    /* per-session inbound frames before disconnect */
};

class Server {
  public:
    explicit Server(ServerOptions opts);
    ~Server();

    bool start(std::string& err);
    void stop();

    /* the logic thread's intake: takes everything that arrived since the last call */
    void drain(std::vector<Inbound>& out);

    void send(uint64_t session, const Json& frame);
    void broadcast(const Json& frame);
    void broadcast_except(uint64_t session, const Json& frame);
    void disconnect(uint64_t session);
    size_t sessions();

  private:
    struct Session {
        std::weak_ptr<ix::WebSocket> ws;
        size_t queued = 0;
    };

    void queue(Inbound in);
    void send_locked(const Session& s, const std::string& text);

    ServerOptions opts_;
    std::unique_ptr<ix::HttpServer> http_;

    std::mutex sessions_mutex_;
    std::unordered_map<uint64_t, Session> sessions_;
    uint64_t next_session_ = 1;

    std::mutex inbox_mutex_;
    std::vector<Inbound> inbox_;
};

} // namespace hmi

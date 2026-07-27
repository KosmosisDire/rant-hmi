#include "server.h"

#include "doc/store.h"

#include <ixwebsocket/IXHttpServer.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>

namespace hmi {
namespace {

const char* mime_of(const std::string& path) {
    auto ends = [&](const char* ext) {
        const size_t n = std::string(ext).size();
        return path.size() >= n && path.compare(path.size() - n, n, ext) == 0;
    };
    if (ends(".html")) return "text/html; charset=utf-8";
    if (ends(".css")) return "text/css; charset=utf-8";
    if (ends(".js") || ends(".mjs")) return "text/javascript; charset=utf-8";
    if (ends(".json")) return "application/json";
    if (ends(".svg")) return "image/svg+xml";
    if (ends(".png")) return "image/png";
    if (ends(".woff2")) return "font/woff2";
    if (ends(".ico")) return "image/x-icon";
    return "application/octet-stream";
}

/* No path may leave the statics root: reject anything with a parent segment or a
 * drive/absolute prefix rather than trying to normalize it. */
bool safe_path(const std::string& uri) {
    if (uri.find("..") != std::string::npos) return false;
    if (uri.find(':') != std::string::npos) return false;
    if (uri.find('\\') != std::string::npos) return false;
    return !uri.empty() && uri[0] == '/';
}

std::shared_ptr<ix::HttpResponse> text_response(int code, const std::string& desc,
                                               const std::string& body, const char* mime) {
    ix::WebSocketHttpHeaders headers;
    headers["Content-Type"] = mime;
    headers["Cache-Control"] = "no-store";   /* an editor reloads constantly */
    return std::make_shared<ix::HttpResponse>(code, desc, ix::HttpErrorCode::Ok, headers, body);
}

} // namespace

Server::Server(ServerOptions opts) : opts_(std::move(opts)) {}

Server::~Server() { stop(); }

bool Server::start(std::string& err) {
    ix::initNetSystem();
    http_ = std::make_unique<ix::HttpServer>(opts_.port, opts_.bind);

    /* HTTP: the frontend's own files. The same port upgrades a WebSocket, so one
     * origin serves the app and its sync channel (no dev server, no CORS). */
    const std::string root = opts_.statics;
    http_->setOnConnectionCallback(
        [root](ix::HttpRequestPtr request,
               std::shared_ptr<ix::ConnectionState>) -> ix::HttpResponsePtr {
            if (root.empty())
                return text_response(404, "Not Found", "no statics directory\n", "text/plain");
            std::string uri = request->uri;
            const size_t query = uri.find('?');
            if (query != std::string::npos) uri = uri.substr(0, query);
            if (uri == "/" || uri.empty()) uri = "/index.html";
            if (!safe_path(uri))
                return text_response(400, "Bad Request", "bad path\n", "text/plain");
            std::string body, ignored;
            if (!read_file(root + uri, body, ignored))
                return text_response(404, "Not Found", "not found: " + uri + "\n", "text/plain");
            return text_response(200, "OK", body, mime_of(uri));
        });

    /* WebSocket: one session per connection. The connection callback hands us a
     * shared_ptr, so sessions hold a weak_ptr and a send can never touch a dead
     * socket. */
    static_cast<ix::WebSocketServer&>(*http_).setOnConnectionCallback(
        [this](std::weak_ptr<ix::WebSocket> weak, std::shared_ptr<ix::ConnectionState> state) {
            uint64_t id = 0;
            {
                std::lock_guard<std::mutex> lock(sessions_mutex_);
                id = next_session_++;
                sessions_[id] = Session{weak, 0};
            }
            const std::string peer = state->getRemoteIp();
            if (auto ws = weak.lock()) {
                ws->setOnMessageCallback([this, id, peer](const ix::WebSocketMessagePtr& msg) {
                    switch (msg->type) {
                        case ix::WebSocketMessageType::Open: {
                            Inbound in;
                            in.what = Inbound::What::Joined;
                            in.session = id;
                            in.client = peer;
                            queue(std::move(in));
                            break;
                        }
                        case ix::WebSocketMessageType::Message: {
                            Inbound in;
                            in.what = Inbound::What::Frame;
                            in.session = id;
                            in.frame = Json::parse(msg->str, nullptr, false);
                            queue(std::move(in));
                            break;
                        }
                        case ix::WebSocketMessageType::Close:
                        case ix::WebSocketMessageType::Error: {
                            Inbound in;
                            in.what = Inbound::What::Gone;
                            in.session = id;
                            queue(std::move(in));
                            {
                                std::lock_guard<std::mutex> lock(sessions_mutex_);
                                sessions_.erase(id);
                            }
                            break;
                        }
                        default:
                            break;
                    }
                });
            }
        });

    auto res = http_->listen();
    if (!res.first) {
        err = res.second;
        http_.reset();
        return false;
    }
    http_->start();
    return true;
}

void Server::stop() {
    if (!http_) return;
    http_->stop();
    http_.reset();
    std::lock_guard<std::mutex> lock(sessions_mutex_);
    sessions_.clear();
}

void Server::queue(Inbound in) {
    const uint64_t id = in.session;
    bool overrun = false;
    {
        std::lock_guard<std::mutex> lock(inbox_mutex_);
        inbox_.push_back(std::move(in));
        std::lock_guard<std::mutex> slock(sessions_mutex_);
        auto it = sessions_.find(id);
        if (it != sessions_.end()) overrun = ++it->second.queued > opts_.max_queued;
    }
    /* the logic thread is not keeping up with this client: drop it, it reconnects to a
     * snapshot and nobody else loses events for it */
    if (overrun) disconnect(id);
}

void Server::drain(std::vector<Inbound>& out) {
    out.clear();
    {
        std::lock_guard<std::mutex> lock(inbox_mutex_);
        out.swap(inbox_);
    }
    std::lock_guard<std::mutex> slock(sessions_mutex_);
    for (const Inbound& in : out) {
        auto it = sessions_.find(in.session);
        if (it != sessions_.end() && it->second.queued > 0) --it->second.queued;
    }
}

void Server::send_locked(const Session& s, const std::string& text) {
    if (auto ws = s.ws.lock()) ws->send(text, false);
}

void Server::send(uint64_t session, const Json& frame) {
    const std::string text = frame.dump();
    std::lock_guard<std::mutex> lock(sessions_mutex_);
    auto it = sessions_.find(session);
    if (it != sessions_.end()) send_locked(it->second, text);
}

void Server::broadcast(const Json& frame) { broadcast_except(0, frame); }

void Server::broadcast_except(uint64_t session, const Json& frame) {
    const std::string text = frame.dump();
    std::lock_guard<std::mutex> lock(sessions_mutex_);
    for (const auto& entry : sessions_)
        if (entry.first != session) send_locked(entry.second, text);
}

void Server::disconnect(uint64_t session) {
    std::shared_ptr<ix::WebSocket> ws;
    {
        std::lock_guard<std::mutex> lock(sessions_mutex_);
        auto it = sessions_.find(session);
        if (it == sessions_.end()) return;
        ws = it->second.ws.lock();
        sessions_.erase(it);
    }
    if (ws) ws->close();
}

size_t Server::sessions() {
    std::lock_guard<std::mutex> lock(sessions_mutex_);
    return sessions_.size();
}

} // namespace hmi

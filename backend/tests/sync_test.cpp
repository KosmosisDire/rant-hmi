/* Stage 2: the sync protocol end to end, headless. A real WebSocket client against a
 * real server: hello/welcome/snapshot, op broadcast and version sequencing, rejection
 * plus recovery snapshot, the stale-base rule, and the static file server. */
#include "app.h"
#include "check.h"
#include "doc/ops.h"
#include "doc/store.h"

#include <ixwebsocket/IXHttpClient.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <mutex>
#include <thread>
#include <vector>

#ifndef _WIN32
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

using namespace hmi;

namespace {

constexpr int kPort = 7581;
const char* kDocPath = "hmi_sync_test.tmp.json";
const char* kStatics = "hmi_sync_test_statics";

/* a test client: collects frames by type, in arrival order */
class Client {
  public:
    bool open(const std::string& url) {
        ws_.setUrl(url);
        ws_.disableAutomaticReconnection();
        ws_.setOnMessageCallback([this](const ix::WebSocketMessagePtr& msg) {
            if (msg->type == ix::WebSocketMessageType::Message) {
                std::lock_guard<std::mutex> lock(mutex_);
                frames_.push_back(Json::parse(msg->str, nullptr, false));
            } else if (msg->type == ix::WebSocketMessageType::Open) {
                open_ = true;
            }
        });
        ws_.start();
        return true;
    }
    void close() { ws_.stop(); }
    void send(const Json& frame) { ws_.send(frame.dump()); }
    bool is_open() const { return open_; }

    std::vector<Json> take() {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<Json> out;
        out.swap(frames_);
        return out;
    }

  private:
    ix::WebSocket ws_;
    std::mutex mutex_;
    std::vector<Json> frames_;
    std::atomic<bool> open_{false};
};

/* Drive the app's loop from this thread (it is the logic thread) while waiting for the
 * client's frames: the same shape as the real service loop. */
std::vector<Json> pump(App& app, Client& client, size_t want, int timeout_ms = 3000) {
    std::vector<Json> got;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
    while (std::chrono::steady_clock::now() < deadline) {
        app.poll();
        for (Json& frame : client.take()) got.push_back(std::move(frame));
        size_t control = 0;
        for (const Json& frame : got) {
            const std::string type = frame.value("type", std::string());
            if (type != "live" && type != "diag") ++control;
        }
        if (control >= want) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return got;
}

/* connect, wait for the socket, say hello, and collect the welcome + snapshot */
std::vector<Json> join(App& app, Client& client, const std::string& url, const char* name) {
    client.open(url);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (!client.is_open() && std::chrono::steady_clock::now() < deadline) {
        app.poll();
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    client.send(Json{{"type", "hello"}, {"proto", kProto}, {"client_name", name}});
    return pump(app, client, 2);
}

const Json* frame_of(const std::vector<Json>& frames, const char* type) {
    for (const Json& f : frames)
        if (f.is_object() && f.value("type", std::string()) == type) return &f;
    return nullptr;
}

void write_statics() {
    std::string err;
    write_file_atomic(std::string(kStatics) + "/index.html", "<h1>hmi</h1>\n", err);
}

Json widget_of(const Json& doc, size_t index) { return doc["pages"][0]["widgets"][index]; }

} // namespace

int main() {
    ix::initNetSystem();
    std::remove(kDocPath);
    std::filesystem::create_directories(kStatics);
    write_statics();

    AppOptions opts;
    opts.server.port = kPort;
    opts.server.statics = kStatics;
    opts.doc_path = kDocPath;
    opts.mesh = false;   /* the sync suite runs offline; mesh_test covers the adapter */
    App app(opts);
    std::string err;
    if (!CHECK_MSG(app.start(err), err)) return check::summary("sync_test");

    const std::string ws_url = "ws://127.0.0.1:" + std::to_string(kPort) + "/sync";

    /* the frontend's own files come off the same port as the sync channel */
    {
        ix::HttpClient http;
        auto args = http.createRequest("http://127.0.0.1:" + std::to_string(kPort) + "/");
        auto response = http.get("http://127.0.0.1:" + std::to_string(kPort) + "/", args);
        CHECK(response->statusCode == 200);
        CHECK(response->body == "<h1>hmi</h1>\n");
        auto missing = http.get("http://127.0.0.1:" + std::to_string(kPort) + "/nope.js", args);
        CHECK(missing->statusCode == 404);
    }

    /* join: hello -> welcome + snapshot, with the registry and the whole document */
    Client a;
    std::vector<Json> frames = join(app, a, ws_url, "a");
    const Json* welcome = frame_of(frames, "welcome");
    const Json* snapshot = frame_of(frames, "snapshot");
    CHECK(welcome != nullptr);
    CHECK(snapshot != nullptr);
    if (!welcome || !snapshot) return check::summary("sync_test");
    CHECK((*welcome)["proto"] == kProto);
    CHECK((*snapshot)["version"] == app.document().version());
    CHECK((*snapshot)["doc"]["pages"][0]["widgets"].size() == 7);
    CHECK((*snapshot)["registry"]["types"].size() == 8);
    CHECK((*snapshot)["live"]["values"].is_object());
    /* Compile findings ride the snapshot. They are produced once, at startup, so a view
     * that joins later has no other frame to learn them from and would sit looking at a
     * dead widget with nothing to explain it. */
    CHECK((*snapshot)["diag"]["compile"].is_array());

    /* every template attribute arrives as a compiled program */
    const Json& button = (*snapshot)["registry"]["types"][0];
    CHECK(button["name"] == "Button");
    CHECK(button["slots"].size() > 10);   /* base slots composed in */
    CHECK(button["template"]["children"][0]["attrs"]["fill"]["code"][0]["op"] == "LOAD");
    CHECK(button["template"]["interact"]["primitive"] == "press");

    /* a second view sees the first view's edit, and both see the same version */
    Client b;
    frames = join(app, b, ws_url, "b");
    CHECK(frame_of(frames, "snapshot") != nullptr);
    a.take();

    const uint64_t version = app.document().version();
    const uint64_t widget = widget_of(app.document().root, 0)["id"].get<uint64_t>();
    b.send(Json{{"type", "apply_ops"},
                {"base_version", version},
                {"ops", Json::array({Json{{"op", "set_prop"},
                                          {"node", widget},
                                          {"key", "label"},
                                          {"value", "Renamed"}}})}});
    frames = pump(app, a, 1);
    const Json* echo = frame_of(frames, "ops_applied");
    CHECK(echo != nullptr);
    if (echo) {
        CHECK((*echo)["version"] == version + 1);
        CHECK((*echo)["ops"][0]["value"] == "Renamed");
        CHECK((*echo)["origin_session"] != 0);
    }
    CHECK(widget_of(app.document().root, 0)["label"] == "Renamed");
    b.take();

    /* an insert comes back with the id the backend issued */
    const uint64_t page = app.document().root["pages"][0]["id"].get<uint64_t>();
    b.send(Json{{"type", "apply_ops"},
                {"base_version", app.document().version()},
                {"ops", Json::array({Json{{"op", "insert"},
                                          {"parent", page},
                                          {"list", "widgets"},
                                          {"node", {{"type", "Toggle"}}}}})}});
    frames = pump(app, b, 1);
    echo = frame_of(frames, "ops_applied");
    CHECK(echo != nullptr);
    if (echo) {
        CHECK((*echo)["ops"][0]["node"]["id"].is_number());
        CHECK((*echo)["ops"][0]["node"]["slots"].is_object());
        CHECK((*echo)["ops"][0]["index"] == 7);
    }

    /* a rejection always brings a snapshot with it, so a view can never sit desynced */
    a.take();
    a.send(Json{{"type", "apply_ops"},
                {"base_version", app.document().version()},
                {"ops", Json::array({Json{{"op", "set_prop"},
                                          {"node", widget},
                                          {"key", "nope"},
                                          {"value", 1}}})}});
    frames = pump(app, a, 2);
    CHECK(frame_of(frames, "reject") != nullptr);
    CHECK(frame_of(frames, "snapshot") != nullptr);

    /* the stale-base rule: an old base is fine on another node, refused on the same one */
    const uint64_t stale = app.document().version();
    a.take();
    a.send(Json{{"type", "apply_ops"},
                {"base_version", stale},
                {"ops", Json::array({Json{{"op", "set_prop"},
                                          {"node", widget},
                                          {"key", "label"},
                                          {"value", "first"}}})}});
    frames = pump(app, a, 1);
    CHECK(frame_of(frames, "ops_applied") != nullptr);
    a.take();
    b.take();
    a.send(Json{{"type", "apply_ops"},
                {"base_version", stale},
                {"ops", Json::array({Json{{"op", "set_prop"},
                                          {"node", widget},
                                          {"key", "label"},
                                          {"value", "second"}}})}});
    frames = pump(app, a, 2);
    CHECK_MSG(frame_of(frames, "reject") != nullptr, "same node, stale base: expected a reject");
    a.take();

    const uint64_t other = widget_of(app.document().root, 1)["id"].get<uint64_t>();
    a.send(Json{{"type", "apply_ops"},
                {"base_version", stale},
                {"ops", Json::array({Json{{"op", "set_prop"},
                                          {"node", other},
                                          {"key", "label"},
                                          {"value", "elsewhere"}}})}});
    frames = pump(app, a, 1);
    CHECK_MSG(frame_of(frames, "ops_applied") != nullptr,
              "different node, stale base: expected an accept");

    /* frames before hello, and unknown frames, are refused not ignored */
    Client c;
    c.open(ws_url);
    {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        while (!c.is_open() && std::chrono::steady_clock::now() < deadline) {
            app.poll();
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }
    c.send(Json{{"type", "view"}, {"page_id", page}});
    frames = pump(app, c, 1);
    CHECK(frame_of(frames, "reject") != nullptr);

    /* a view that saw a version gap asks for a fresh snapshot */
    a.take();
    a.send(Json{{"type", "resync"}});
    frames = pump(app, a, 1);
    CHECK(frame_of(frames, "snapshot") != nullptr);

    /* stage 4: an input runs once in the backend and the live cell reaches the view */
    const Json& reset = widget_of(app.document().root, 6);
    const uint64_t reset_id = reset["id"].get<uint64_t>();
    const uint64_t reset_step = reset["flows"][0]["do"][0]["id"].get<uint64_t>();
    uint64_t flow_var = 0;
    for (const Json& var : app.document().root["globals"])
        if (var["name"] == "flow") flow_var = var["id"].get<uint64_t>();
    a.take();
    a.send(Json{{"type", "apply_ops"},
                {"base_version", app.document().version()},
                {"ops", Json::array({Json{{"op", "set_prop"},
                                          {"node", reset_step},
                                          {"key", "from"},
                                          {"value", Json{{"expr", "5"}}}}})}});
    frames = pump(app, a, 1);
    CHECK(frame_of(frames, "ops_applied") != nullptr);
    a.take();
    a.send(Json{{"type", "input"},
                {"widget_id", reset_id},
                {"event", "press"},
                {"value", true},
                {"seq", 1}});
    bool saw_live = false;
    const auto live_deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
    while (!saw_live && std::chrono::steady_clock::now() < live_deadline) {
        app.poll();
        for (const Json& frame : a.take()) {
            if (frame.value("type", std::string()) != "live") continue;
            const std::string key = "v" + std::to_string(flow_var);
            if (frame["values"].contains(key) && frame["values"][key] == 5)
                saw_live = true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    CHECK(saw_live);

    /* the document on disk carries the edits */
    Document saved;
    CHECK_MSG(Document::from_file(kDocPath, saved, err), err);
    CHECK(saved.version() == app.document().version());
    CHECK(widget_of(saved.root, 0)["label"] == "first");

    /* CRASH REGRESSION: a peer that vanishes with no close handshake makes a later
       broadcast's send FAIL, and ix closes that socket synchronously INSIDE the send,
       re-entering the server's message callback on the broadcasting (logic) thread.
       That callback needs sessions_mutex_, so the server must never hold it across a
       send (it crashed with a same-thread relock before server.cpp snapshotted the
       sockets first). The raw socket upgrades by hand and dies with an RST (SO_LINGER
       0), so the server still holds its session when the broadcasts reach it. */
    {
#ifdef _WIN32
        SOCKET raw = ::socket(AF_INET, SOCK_STREAM, 0);
#else
        int raw = ::socket(AF_INET, SOCK_STREAM, 0);
#endif
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(static_cast<unsigned short>(kPort));
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        CHECK(::connect(raw, reinterpret_cast<sockaddr*>(&addr), sizeof addr) == 0);
        const std::string upgrade =
            "GET /sync HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n";
        ::send(raw, upgrade.c_str(), static_cast<int>(upgrade.size()), 0);
        char answer[256];
        (void)::recv(raw, answer, sizeof answer, 0);   /* the 101: the session exists */
        for (int i = 0; i < 25; ++i) {
            app.poll();
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        linger hard{};
        hard.l_onoff = 1;
        hard.l_linger = 0;
        ::setsockopt(raw, SOL_SOCKET, SO_LINGER, reinterpret_cast<const char*>(&hard),
                     sizeof hard);
#ifdef _WIN32
        ::closesocket(raw);
#else
        ::close(raw);
#endif
        /* broadcast repeatedly before the server's reader notices the corpse; each
           accepted op broadcasts ops_applied to every session, the dead one included */
        a.take();
        for (int i = 0; i < 8; ++i) {
            a.send(Json{{"type", "apply_ops"},
                        {"base_version", app.document().version()},
                        {"ops", Json::array({Json{{"op", "set_prop"},
                                                  {"node", widget},
                                                  {"key", "label"},
                                                  {"value", "alive " + std::to_string(i)}}})}});
            frames = pump(app, a, 1);
            CHECK(frame_of(frames, "ops_applied") != nullptr);
            a.take();
        }
    }

    a.close();
    b.close();
    c.close();
    app.stop();
    std::remove(kDocPath);
    std::filesystem::remove_all(kStatics);
    ix::uninitNetSystem();
    return check::summary("sync_test");
}

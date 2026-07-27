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
        if (got.size() >= want) break;
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

    /* the document on disk carries the edits */
    Document saved;
    CHECK_MSG(Document::from_file(kDocPath, saved, err), err);
    CHECK(saved.version() == app.document().version());
    CHECK(widget_of(saved.root, 0)["label"] == "first");

    a.close();
    b.close();
    c.close();
    app.stop();
    std::remove(kDocPath);
    std::filesystem::remove_all(kStatics);
    ix::uninitNetSystem();
    return check::summary("sync_test");
}

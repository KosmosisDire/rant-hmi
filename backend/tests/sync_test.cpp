/* Stage 2: the sync protocol end to end, headless. A real WebSocket client against a
 * real server: hello/welcome/snapshot, op broadcast and version sequencing, rejection
 * plus recovery snapshot, the stale-base rule, and the static file server. */
#include "app.h"
#include "check.h"
#include "doc/ops.h"
#include "doc/store.h"
#include "lang/ir.h"

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
/* the mesh-lane app runs on its own port and its own document, so the offline suite
   above keeps exactly the world it was written against */
const char* kMeshDocPath = "hmi_sync_mesh_test.tmp.json";
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

/* The default page is a tree of frames, so a demo instance is found by its LABEL wherever
 * it nests. `label` is the document's own field and an edit below renames one, so each
 * lookup names the label the instance carries AT THAT POINT. */
const Json* instance_in(const Json& node, const std::string& label) {
    auto kids = node.find("children");
    if (kids == node.end() || !kids->is_array()) return nullptr;
    for (const Json& child : *kids) {
        if (!child.value("type", "").empty() && child.value("name", "") == label)
            return &child;
        if (const Json* found = instance_in(child, label)) return found;
    }
    return nullptr;
}

Json instance_of(const Json& doc, const char* label) {
    const Json* found = instance_in(doc["pages"][0], label);
    return found ? *found : Json::object();
}

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
    /* the number itself, pinned: the frontend bumps in lockstep, and a silent drift here
       is a client that talks a frame shape this backend no longer sends
       (15: ONE VOCABULARY — the registry serves `components` rather than `types`, an
       `input` frame carries {node, ..., element} where widget_id/part stood, a flow
       trigger's channel key is `element`, and `instance.<slot>` is spelled `this.<slot>`;
       16: THE DISPLAY TIER GETS THE WHOLE UNIVERSE — a page element's attrs name the
       variables in scope and the mesh, so a view program carries `var:<id>` and
       `mesh:<entity>[.<field>]` cells and a live frame carries the read mesh fields;
       17: THE COPY RIDES THE EVENT — an `input` frame raised inside a `repeat` carries
       `repeat: {index, count}`, and carries the key only where there is a copy;
       18: A PROPERTY IS A PUBLIC VARIABLE — served slot rows read off `public` locals;
       19: THE VIEW DIALECT DIED INTO THE SERVED IR — a view program is packed
       {"i","k","c","s"} in the generated numeric vocabulary, not named-op rows) */
    CHECK(kProto == 22);
    CHECK((*snapshot)["version"] == app.document().version());
    /* the page is an arrangement on the artboard: the header band, the main pane and
       the side panes, everything else nested inside them */
    CHECK((*snapshot)["doc"]["pages"][0]["children"].size() == 4);
    CHECK((*snapshot)["registry"]["components"].size() == 10);
    CHECK((*snapshot)["live"]["values"].is_object());
    /* Compile findings ride the snapshot. They are produced once, at startup, so a view
     * that joins later has no other frame to learn them from and would sit looking at a
     * dead instance with nothing to explain it. */
    CHECK((*snapshot)["diag"]["compile"].is_array());

    /* every PAGE node's compiled attrs ride the snapshot beside the registry: the document
     * says what the tree is, this says what each node's fields evaluate to, and the
     * renderer needs both to draw a page and a component through one path */
    CHECK((*snapshot)["node_attrs"].is_object());
    {
        const Json& pump = instance_of((*snapshot)["doc"], "Pump");
        CHECK(pump.is_object());
    }

    /* AN AGGREGATE CELL RIDES `aggs`, NOT `values`: the demo's Selector authored its
       options, and a view that had to guess them from a type name could only ever be a
       tick behind what the backend actually holds. In a SNAPSHOT every aggregate is
       whole — generation, the absolute index its window starts at, its length now, and
       the elements — which is the baseline every later delta counts from. */
    {
        const Json mode = instance_of((*snapshot)["doc"], "Mode");
        const std::string key = std::to_string(json_u64_or(mode["id"], 0)) + ".options";
        const Json& aggs = (*snapshot)["live"]["aggs"];
        CHECK(!(*snapshot)["live"]["values"].contains(key));
        CHECK(aggs.contains(key));
        if (aggs.contains(key)) {
            CHECK(aggs[key]["values"] == Json::array({"Off", "Low", "High"}));
            CHECK(aggs[key]["len"] == 3);
            CHECK(aggs[key]["from"] == 0);
        }
    }

    /* the built-ins' editable DOCUMENT form rides beside the derived registry: nodes
     * with expression-text attrs, no compiled template, no ids (a fork inserts one
     * into doc.components and the backend issues ids through prepare) */
    CHECK((*snapshot)["builtins"].is_array());
    CHECK((*snapshot)["builtins"].size() == 10);
    CHECK((*snapshot)["builtins"][0]["name"] == "Button");
    CHECK((*snapshot)["builtins"][0]["children"].is_array());
    CHECK(!(*snapshot)["builtins"][0].contains("template"));
    CHECK(!(*snapshot)["builtins"][0].contains("id"));

    /* every template attribute arrives as a compiled PACKED program: the first word
       of the Button label's `i` stream is a Load of its text slot */
    const Json& button = (*snapshot)["registry"]["components"][0];
    CHECK(button["name"] == "Button");
    /* text, textColor, textSize, align, icon, iconColor, iconAlign, iconSize, progress,
       progressColor, surface, border, radius */
    CHECK(button["slots"].size() == 13);
    const Json* label = nullptr;
    for (const Json& child : button["template"]["children"])
        if (child.value("name", "") == "label") label = &child;
    if (CHECK(label != nullptr))
        CHECK((*label)["attrs"]["text"]["i"][0] == static_cast<uint32_t>(OpCode::Load));
    CHECK(button["template"]["interact"]["primitive"] == "press");

    /* a second view sees the first view's edit, and both see the same version */
    Client b;
    frames = join(app, b, ws_url, "b");
    CHECK(frame_of(frames, "snapshot") != nullptr);
    a.take();

    const uint64_t version = app.document().version();
    const uint64_t instance = instance_of(app.document().root, "Pump")["id"].get<uint64_t>();
    b.send(Json{{"type", "apply_ops"},
                {"base_version", version},
                {"ops", Json::array({Json{{"op", "set_prop"},
                                          {"node", instance},
                                          {"key", "name"},
                                          {"value", "Renamed"}}})}});
    frames = pump(app, a, 1);
    const Json* echo = frame_of(frames, "ops_applied");
    CHECK(echo != nullptr);
    if (echo) {
        CHECK((*echo)["version"] == version + 1);
        CHECK((*echo)["ops"][0]["value"] == "Renamed");
        CHECK((*echo)["origin_session"] != 0);
    }
    CHECK(instance_of(app.document().root, "Renamed")["id"] == instance);
    b.take();

    /* an insert comes back with the id the backend issued */
    const uint64_t page = app.document().root["pages"][0]["id"].get<uint64_t>();
    b.send(Json{{"type", "apply_ops"},
                {"base_version", app.document().version()},
                {"ops", Json::array({Json{{"op", "insert"},
                                          {"parent", page},
                                          {"list", "children"},
                                          {"node", {{"kind", "frame"}, {"type", "Toggle"}}}}})}});
    frames = pump(app, b, 1);
    echo = frame_of(frames, "ops_applied");
    CHECK(echo != nullptr);
    if (echo) {
        CHECK((*echo)["ops"][0]["node"]["id"].is_number());
        CHECK((*echo)["ops"][0]["node"]["slots"].is_object());
        /* appended after the four top-level panes */
        CHECK((*echo)["ops"][0]["index"] == 4);
    }

    /* a rejection always brings a snapshot with it, so a view can never sit desynced */
    a.take();
    a.send(Json{{"type", "apply_ops"},
                {"base_version", app.document().version()},
                {"ops", Json::array({Json{{"op", "set_prop"},
                                          {"node", instance},
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
                                          {"node", instance},
                                          {"key", "name"},
                                          {"value", "first"}}})}});
    frames = pump(app, a, 1);
    CHECK(frame_of(frames, "ops_applied") != nullptr);
    a.take();
    b.take();
    a.send(Json{{"type", "apply_ops"},
                {"base_version", stale},
                {"ops", Json::array({Json{{"op", "set_prop"},
                                          {"node", instance},
                                          {"key", "name"},
                                          {"value", "second"}}})}});
    frames = pump(app, a, 2);
    CHECK_MSG(frame_of(frames, "reject") != nullptr, "same node, stale base: expected a reject");
    a.take();

    /* a DIFFERENT instance (the Pump was renamed above, so it is Setpoint's turn) */
    const uint64_t other = instance_of(app.document().root, "Setpoint")["id"].get<uint64_t>();
    a.send(Json{{"type", "apply_ops"},
                {"base_version", stale},
                {"ops", Json::array({Json{{"op", "set_prop"},
                                          {"node", other},
                                          {"key", "name"},
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
    const Json reset = instance_of(app.document().root, "Reset");
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
                {"node", reset_id},
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

    /* THE DELTA LANE, LIVE. A list that did not move is ABSENT from `aggs` entirely; a
     * ring that appended carries ONLY what was appended, starting at the absolute index
     * the last frame left off at. That cursor is why a 4096-sample window costs one
     * element a frame instead of four thousand. */
    {
        const Json history_instance = instance_of(app.document().root, "History");
        const std::string ring =
            std::to_string(json_u64_or(history_instance["id"], 0)) + ".history";
        const Json mode = instance_of(app.document().root, "Mode");
        const std::string options =
            std::to_string(json_u64_or(mode["id"], 0)) + ".options";
        a.take();
        int quiet = 0, deltas = 0;
        bool appends_only = true, continuous = true;
        uint64_t expect_from = UINT64_MAX;
        const auto stop =
            std::chrono::steady_clock::now() + std::chrono::milliseconds(700);
        while (std::chrono::steady_clock::now() < stop) {
            app.poll();
            for (const Json& frame : a.take()) {
                if (frame.value("type", std::string()) != "live") continue;
                if (!frame.contains("aggs")) continue;
                const Json& aggs = frame["aggs"];
                if (!aggs.contains(options)) ++quiet;
                if (!aggs.contains(ring)) continue;
                const Json& row = aggs[ring];
                if (!row.contains("from")) continue;
                const uint64_t from = json_u64_or(row["from"], 0);
                /* a live frame never re-sends the window it already sent */
                if (row["values"].size() > 4) appends_only = false;
                if (expect_from != UINT64_MAX && from != expect_from) continuous = false;
                expect_from = from + row["values"].size();
                ++deltas;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        CHECK_MSG(quiet > 0, "an unchanged list should be absent from a live frame");
        CHECK_MSG(deltas > 0, "the Trend's ring should append on its own cadence");
        CHECK_MSG(appends_only, "a live delta carried the whole window, not the appends");
        CHECK_MSG(continuous, "the delta cursor skipped or repeated elements");
    }

    /* A ROW RIDES WHOLE INSIDE ITS ELEMENT. A cell whose `elem` declares list or map
     * holds ROWS, and the wire carries each one as the aggregate it is — an array, or an
     * object where the row is a map. A row published as a scalar's null is a plot that
     * draws nothing and says nothing about why, which is exactly what it was. */
    {
        a.take();
        a.send(Json{{"type", "apply_ops"},
                    {"base_version", app.document().version()},
                    {"ops", Json::array({
                         Json{{"op", "insert"},
                              {"parent", 0},
                              {"list", "globals"},
                              {"node", Json{{"name", "grid"},
                                            {"type", "List"},
                                            {"elem", "List"},
                                            {"leaf", "Num"},
                                            {"init", Json::array({Json::array({1, 2}),
                                                                  Json::array({3})})}}}},
                         Json{{"op", "insert"},
                              {"parent", 0},
                              {"list", "globals"},
                              {"node", Json{{"name", "byName"},
                                            {"type", "Map"},
                                            {"elem", "List"},
                                            {"leaf", "Num"},
                                            {"init", Json{{"a", Json::array({4, 5})}}}}}},
                     })}});
        frames = pump(app, a, 2);
        const Json* inserted = frame_of(frames, "ops_applied");
        CHECK(inserted != nullptr);
        uint64_t grid_id = 0, map_id = 0;
        if (inserted) {
            grid_id = json_u64_or((*inserted)["ops"][0]["node"]["id"], 0);
            map_id = json_u64_or((*inserted)["ops"][1]["node"]["id"], 0);
        }
        CHECK(grid_id != 0 && map_id != 0);
        const std::string grid = "v" + std::to_string(grid_id);
        const std::string by_name = "v" + std::to_string(map_id);
        Json rows, keyed;
        /* the aggs lane is a DELTA lane: a new cell rides the first frame after the
           recompile and is absent from every one after it, so the frames the apply
           already pumped count as much as the ones the wait collects */
        auto scan = [&](const std::vector<Json>& seen) {
            for (const Json& frame : seen) {
                const std::string type = frame.value("type", std::string());
                const Json* aggs = nullptr;
                if (type == "live" && frame.contains("aggs")) aggs = &frame["aggs"];
                else if (type == "snapshot" && frame.contains("live") &&
                         frame["live"].contains("aggs"))
                    aggs = &frame["live"]["aggs"];
                if (!aggs || !aggs->is_object()) continue;
                if (aggs->contains(grid)) rows = (*aggs)[grid];
                if (aggs->contains(by_name)) keyed = (*aggs)[by_name];
            }
        };
        scan(frames);
        const auto stop =
            std::chrono::steady_clock::now() + std::chrono::milliseconds(700);
        while (rows.is_null() && std::chrono::steady_clock::now() < stop) {
            app.poll();
            scan(a.take());
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        CHECK_MSG(!rows.is_null(), "a nested cell never reached the wire at all");
        if (!rows.is_null()) {
            CHECK(rows["len"] == 2);
            CHECK_MSG(rows["values"] == Json::array({Json::array({1, 2}),
                                                     Json::array({3})}),
                      "a row must ride as the list it is, not as a scalar's null");
        }
        /* and a row inside a MAP cell, which goes whole on any change */
        CHECK_MSG(!keyed.is_null() && keyed["values"]["a"] == Json::array({4, 5}),
                  "a map's rows ride the same way its scalars do");
    }

    /* A WHOLE STORE MOVES THE GENERATION, and a client sees that rather than a length
     * that happens to differ: editing the Selector's authored options reseeds its cell
     * at the recompile, so the next frame carries the list whole under a new gen. */
    {
        const Json mode = instance_of(app.document().root, "Mode");
        const uint64_t mode_id = json_u64_or(mode["id"], 0);
        const std::string options = std::to_string(mode_id) + ".options";
        a.take();
        a.send(Json{{"type", "apply_ops"},
                    {"base_version", app.document().version()},
                    {"ops", Json::array({Json{
                                {"op", "set_prop"},
                                {"node", mode_id},
                                {"key", "slots"},
                                {"value", Json{{"options", Json::array({"A", "B"})},
                                               {"value", "A"}}}}})}});
        /* ONE loop for the echo and the frame that follows it: the first live frame after
           a recompile carries every aggregate whole, so a pump that swallowed it would
           leave nothing left to see */
        bool reseeded = false, echoed = false;
        const auto stop =
            std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
        while (!reseeded && std::chrono::steady_clock::now() < stop) {
            app.poll();
            for (const Json& frame : a.take()) {
                const std::string type = frame.value("type", std::string());
                if (type == "ops_applied") echoed = true;
                if (type != "live" || !frame.contains("aggs")) continue;
                if (!frame["aggs"].contains(options)) continue;
                const Json& row = frame["aggs"][options];
                if (row["values"] == Json::array({"A", "B"}) && row["len"] == 2 &&
                    row["from"] == 0)
                    reseeded = true;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        CHECK(echoed);
        CHECK_MSG(reseeded, "an edited authored list should arrive whole under a new gen");
    }

    /* Components are document data (spec 2.3): inserting a component re-derives the
       served registry, and ops_applied does not carry it, so the backend follows the
       echo with a fresh snapshot for every client. A bad template expression is a
       finding on the ELEMENT node, named by the attr, and the component still serves
       (minus the broken attr). */
    a.take();
    b.take();
    a.send(Json{
        {"type", "apply_ops"},
        {"base_version", app.document().version()},
        {"ops",
         Json::array({Json{
             {"op", "insert"},
             {"parent", 0},   /* the doc root holds the components list */
             {"list", "components"},
             {"node",
              Json{{"name", "Lamp"},
                   {"locals", Json::array({Json{{"name", "tint"},
                                                {"type", "Color"},
                                                {"init", "#ff0000"},
                                                {"public", true}}})},
                   {"children",
                    Json::array({Json{{"kind", "frame"},
                                      {"name", "lamp"},
                                      {"attrs", Json{{"surface", "tint"},
                                                     {"radius", "nope + 1"}}}}})}}}}})}});
    frames = pump(app, a, 2);
    echo = frame_of(frames, "ops_applied");
    const Json* pushed = frame_of(frames, "snapshot");
    CHECK_MSG(echo != nullptr, "component insert: expected the op echo");
    CHECK_MSG(pushed != nullptr, "component insert: expected a pushed snapshot");
    if (echo && pushed) {
        CHECK((*pushed)["registry"]["components"].size() == 11);
        const Json& lamp = (*pushed)["registry"]["components"][10];
        CHECK(lamp["name"] == "Lamp");
        /* the good attr compiled to a packed view program; the bad one is not served */
        const Json& lamp_part = lamp["template"]["children"][0];
        CHECK(lamp_part["attrs"]["surface"]["i"][0] ==
              static_cast<uint32_t>(OpCode::Load));
        CHECK(!lamp_part["attrs"].contains("radius"));
        /* the finding is pinned to the node the ECHO issued, at the attr */
        const uint64_t part_id =
            (*echo)["ops"][0]["node"]["children"][0]["id"].get<uint64_t>();
        bool pinned = false;
        for (const Json& diag : (*pushed)["diag"]["compile"])
            if (diag["node"] == part_id && diag["where"] == "radius" &&
                diag["code"] == "template_expr")
                pinned = true;
        CHECK_MSG(pinned, "component insert: the bad attr's finding is not pinned");
        /* the other client got the same snapshot */
        std::vector<Json> theirs = pump(app, b, 2);
        CHECK(frame_of(theirs, "snapshot") != nullptr);
    }
    b.take();

    /* the document on disk carries the edits */
    Document saved;
    CHECK_MSG(Document::from_file(kDocPath, saved, err), err);
    CHECK(saved.version() == app.document().version());
    CHECK(instance_of(saved.root, "first")["id"] == instance);

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
                                                  {"node", instance},
                                                  {"key", "name"},
                                                  {"value", "alive " + std::to_string(i)}}})}});
            frames = pump(app, a, 1);
            CHECK(frame_of(frames, "ops_applied") != nullptr);
            a.take();
        }
    }

    /* ---- A MESH FIELD AN ATTR READS RIDES THE LIVE FRAME ----
     *
     * The last link of the display tier's universe, through a whole App: the attr
     * compiler records the read, the program compile stamps the entity so the mesh
     * consumes it, and the live frame carries the mirror under the SERVED SPELLING — the
     * one string both sides build through mesh_cell(). Its own app on its own port, over
     * a mesh whose arrivals this test controls. */
    {
        std::remove(kMeshDocPath);
        AppOptions mesh_opts;
        mesh_opts.server.port = kPort + 1;
        mesh_opts.server.statics = kStatics;
        mesh_opts.doc_path = kMeshDocPath;
        EntityDef tank;
        tank.kind = EntityKind::Variable;
        tank.name = "tank";
        tank.readable = true;
        FieldDef readings;
        readings.path = "readings";
        readings.shape = Shape::List;
        readings.elem = Shape::Num;
        readings.bound = 8;
        tank.fields = {FieldDef{"level", Shape::Num}, readings};
        auto port = std::make_unique<FakeMesh>(std::vector<EntityDef>{tank});
        FakeMesh* fake = port.get();
        App mesh_app(mesh_opts, std::move(port));
        std::string mesh_err;
        if (CHECK_MSG(mesh_app.start(mesh_err), mesh_err)) {
            const std::string mesh_url =
                "ws://127.0.0.1:" + std::to_string(kPort + 1) + "/sync";
            Client d;
            join(mesh_app, d, mesh_url, "d");
            const uint64_t mesh_page =
                mesh_app.document().root["pages"][0]["id"].get<uint64_t>();
            d.send(Json{{"type", "apply_ops"},
                        {"base_version", mesh_app.document().version()},
                        {"ops", Json::array({Json{
                            {"op", "insert"}, {"parent", mesh_page}, {"list", "children"},
                            {"node", {{"kind", "frame"},
                                      {"attrs", {{"w", "@tank.level"},
                                                 {"h", "@tank.readings.Length()"}}}}}}})}});
            frames = pump(mesh_app, d, 1);
            const Json* placed = frame_of(frames, "ops_applied");
            CHECK(placed != nullptr);
            /* the issued id off the echo: the retype block below asserts on this
               node's served programs */
            const uint64_t attr_node =
                placed ? json_u64_or((*placed)["ops"][0]["node"]["id"], 0) : 0;
            CHECK(attr_node != 0);

            /* the read is what makes the key exist at all: before any delivery the
               mirror is unknown, and an unknown cell omits its key rather than
               publishing a zero nobody measured */
            auto carried = [&](double& out) {
                bool seen = false;
                const auto stop = std::chrono::steady_clock::now() +
                                  std::chrono::milliseconds(1500);
                while (!seen && std::chrono::steady_clock::now() < stop) {
                    mesh_app.poll();
                    for (const Json& frame : d.take()) {
                        if (frame.value("type", std::string()) != "live") continue;
                        auto values = frame.find("values");
                        if (values == frame.end()) continue;
                        auto found = values->find("mesh:tank.level");
                        if (found == values->end() || !found->is_number()) continue;
                        out = found->get<double>();
                        seen = true;
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(2));
                }
                return seen;
            };
            double quiet = 0;
            CHECK(!carried(quiet));

            fake->push_update(EntityKind::Variable, "tank", {Value::number(42.5)});
            double level = 0;
            CHECK(carried(level));
            CHECK_EQ(level, 42.5);

            /* and it MOVES: the picture follows the mirror, frame after frame */
            fake->push_update(EntityKind::Variable, "tank", {Value::number(7.25)});
            double next = 0;
            CHECK(carried(next));
            CHECK_EQ(next, 7.25);

            /* AN ARRAY FIELD RIDES THE DELTA LANE, not `values` — the same lane a list
               cell rides, off the same mirror the wire tier reads. This is what lets a
               picture be drawn per element of a mesh array. */
            fake->push_update(
                EntityKind::Variable, "tank",
                {Value::number(7.25), Value::list(0, 3, ValueTag::Num)});
            fake->push_elems(1, {Value::number(1), Value::number(2), Value::number(3)});
            size_t elements = 0;
            {
                const auto stop = std::chrono::steady_clock::now() +
                                  std::chrono::milliseconds(1500);
                while (!elements && std::chrono::steady_clock::now() < stop) {
                    mesh_app.poll();
                    for (const Json& frame : d.take()) {
                        if (frame.value("type", std::string()) != "live") continue;
                        auto aggs = frame.find("aggs");
                        if (aggs == frame.end()) continue;
                        auto found = aggs->find("mesh:tank.readings");
                        if (found == aggs->end()) continue;
                        auto values = found->find("values");
                        if (values != found->end() && values->is_array())
                            elements = values->size();
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(2));
                }
            }
            CHECK_EQ(elements, size_t(3));

            /* ---- A MESH CHANGE RE-SERVES THE COMPILE PRODUCTS ----
             *
             * `node_attrs` and the registry ride ONLY the snapshot, and a recompile
             * the MESH triggers changes them exactly as an edit does: `w` above
             * compiled against @tank's reflection. The provider leaving must re-serve
             * the programs with that attr refused; its return must re-serve the
             * working ones. A view that only got the mesh frame would keep rendering
             * the old programs until a page reload. */
            {
                const std::string key = std::to_string(attr_node);
                d.take();
                fake->retype({});
                frames = pump(mesh_app, d, 2);
                const Json* tree = frame_of(frames, "mesh");
                CHECK(tree != nullptr);
                if (tree) CHECK((*tree)["entities"].empty());
                const Json* reserved = frame_of(frames, "snapshot");
                CHECK(reserved != nullptr);
                if (reserved && CHECK((*reserved)["node_attrs"].contains(key)))
                    CHECK(!(*reserved)["node_attrs"][key]["attrs"].contains("w"));

                fake->retype({tank});
                frames = pump(mesh_app, d, 2);
                const Json* restored = frame_of(frames, "snapshot");
                CHECK(restored != nullptr);
                if (restored && CHECK((*restored)["node_attrs"].contains(key)))
                    CHECK((*restored)["node_attrs"][key]["attrs"].contains("w"));
            }
            d.close();
        }
        mesh_app.stop();
        std::remove(kMeshDocPath);
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

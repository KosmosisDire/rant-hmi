/* End-to-end over a real mesh: a peer dart::Node hosting a variable, a topic, a
 * function and a signal on loopback multicast, against the DartMesh adapter driving
 * the compiled runtime. Covers reflection (kinds, fields, shapes), feeds from every
 * entity kind (including text and a paced function poll), and effects back out
 * (RMW variable write preserving an untouched text field, publish, emit). Runs on an
 * isolated domain so a busy desk never interferes. */
#include "check.h"
#include "steps.h"
#include "compile/compiler.h"
#include "doc/doc.h"
#include "mesh/dart_mesh.h"
#include "compile/components.h"
#include "sched/scheduler.h"

#include "dart.hpp"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <thread>

using namespace hmi;

namespace {

constexpr uint16_t kDomain = 41;
/* own discovery PORT, not just domain: another DART process on this host (the explorer,
 * a bridge) shares UDP 7400 via REUSEADDR and swallows the unicast seed announces */
constexpr uint16_t kDiscoveryPort = 17441;
constexpr const char* kLoopback = "127.0.0.1";
constexpr uint32_t kAnnounceUs = 100000;

Json entity_ref(const char* kind, const char* name) {
    return Json{{"kind", kind}, {"name", name}};
}

/* run the scheduler until `done` reports true, ticking at wall pace */
template <class F> bool run_until(Scheduler& sched, F done, int limit_ms = 8000) {
    for (int i = 0; i < limit_ms; ++i) {
        std::string fault;
        sched.tick(fault);
        if (done()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return false;
}

int cell_of(const Program& program, uint64_t widget, const char* slot) {
    for (uint32_t i = 0; i < program.cells.size(); ++i)
        if (program.cells[i].kind == CellKind::Slot && program.cells[i].owner_widget == widget &&
            program.cells[i].name == slot)
            return static_cast<int>(i);
    return -1;
}

double num_at(const Scheduler& sched, int cell) {
    if (cell < 0) return -1e300;
    const Value& value = sched.state().values[cell];
    return value.tag == ValueTag::Num ? value.data.num : -1e300;
}

std::string text_at(const Scheduler& sched, int cell) {
    if (cell < 0) return "<no cell>";
    const Value& value = sched.state().values[cell];
    return std::string(sched.state().text(sched.program(), value));
}

} // namespace

int main() {
    /* ---- the peer: what a small controller node looks like on the mesh ---- */
    auto tank_schema = dart::Schema::compile("Tank { level: f64, label: string<16> }");
    auto hist_schema =
        dart::Schema::compile("Hist { temps: f64[4] tags: string<8>[] extras: map }");
    auto belt_schema = dart::Schema::compile("Belt { speed: f64, running: bool }");
    auto req_schema = dart::Schema::compile("StatusQ { probe: u8 }");
    auto rsp_schema = dart::Schema::compile("StatusR { temp: f64 }");
    auto alarm_schema = dart::Schema::compile("Alarm { code: u8 }");
    auto cmd_schema = dart::Schema::compile("Cmd { n: f64 }");
    CHECK(tank_schema && hist_schema && belt_schema && req_schema && rsp_schema &&
          alarm_schema && cmd_schema);
    if (!tank_schema || !hist_schema || !belt_schema || !req_schema || !rsp_schema ||
        !alarm_schema || !cmd_schema)
        return check::summary("mesh_test");

    dart::NodeOptions peer_options;
    peer_options.domain = kDomain;
    peer_options.multicast_interface = kLoopback;
    /* the dart_test selftest recipe: loopback multicast PLUS a unicast seed, because
     * Windows loopback multicast is not reliable on its own (announces also reinforce
     * to known peers' data ports, so one landed announce heals both directions) */
    peer_options.seed_peers = {kLoopback};
    peer_options.discovery_port = kDiscoveryPort;
    peer_options.announce_interval_us = kAnnounceUs;
    peer_options.max_topics = 32;
    dart::Node peer(
        "plant", {}, [](const dart::Event& event) {
            if (event.is_error()) std::printf("peer: %s\n", event.to_string().c_str());
        },
        peer_options);
    CHECK(peer.valid());

    dart::MessageBuilder initial(*tank_schema);
    initial.set_f64("level", 42.5).set_string("label", "ok");
    CHECK(initial.ok());
    dart::VariableOptions<> tank_options;
    tank_options.initial = initial.bytes();
    tank_options.allow_force = true;
    dart::VariableDefinition<> tank(peer, "tank_level", &*tank_schema, tank_options);
    CHECK(tank.valid());

    dart::Publisher<> belt(peer, "belt", &*belt_schema,
                           dart::Qos{dart::Reliability::Reliable});
    CHECK(belt.valid());

    /* a variable with every aggregate kind: fixed f64 array, varr of strings, map */
    dart::MessageBuilder hist_initial(*hist_schema);
    {
        const double temps[4] = {1.5, 9.25, 3.0, 0.5};
        hist_initial.set_array("temps", dart::Bytes(
            reinterpret_cast<const uint8_t*>(temps), sizeof(temps)));
        std::vector<uint8_t> tag_slots;   /* string-array raw slots: [u16 len][cap bytes] */
        auto put_tag = [&](const char* tag) {
            const uint16_t length = static_cast<uint16_t>(std::strlen(tag));
            tag_slots.push_back(static_cast<uint8_t>(length & 0xff));
            tag_slots.push_back(static_cast<uint8_t>(length >> 8));
            const size_t at = tag_slots.size();
            tag_slots.resize(at + 8, 0);
            std::memcpy(tag_slots.data() + at, tag, length);
        };
        put_tag("hot");
        put_tag("cold");
        hist_initial.set_array("tags", dart::Bytes(tag_slots.data(), tag_slots.size()));
        dart::MapWriter extras;
        extras.put_uint("speed", 5).put_string("state", "run");
        CHECK(extras.ok());
        hist_initial.set_map("extras", extras);
    }
    CHECK(hist_initial.ok());
    dart::VariableOptions<> hist_options;
    hist_options.initial = hist_initial.bytes();
    dart::VariableDefinition<> hist(peer, "history", &*hist_schema, hist_options);
    CHECK(hist.valid());

    /* a forceable bool the document only reads from FLOWS (no feed names it): the
     * flow_reads subscription is the only thing that can fill its mirror */
    auto suck_schema = dart::Schema::compile("Suck { on: bool }");
    CHECK(suck_schema.has_value());
    if (!suck_schema) return check::summary("mesh_test");
    dart::MessageBuilder suck_initial(*suck_schema);
    suck_initial.set_bool("on", false);
    CHECK(suck_initial.ok());
    dart::VariableOptions<> suction_options;
    suction_options.initial = suck_initial.bytes();
    suction_options.allow_force = true;
    dart::VariableDefinition<> suction(peer, "suction", &*suck_schema, suction_options);
    CHECK(suction.valid());

    std::atomic<int> calls{0};
    dart::FunctionDefinition<> status(
        peer, "status", &*req_schema, &*rsp_schema,
        [&](dart::Request<>& request) {
            ++calls;
            dart::MessageBuilder reply(*rsp_schema);
            reply.set_f64("temp", 21.25);
            request.reply(reply.bytes());
        });
    CHECK(status.valid());

    std::atomic<int> alarms_seen{0};
    std::atomic<int> alarm_code{0};
    dart::Signal<> alarm(peer, "alarm", &*alarm_schema, [&](const dart::MessageView& msg) {
        alarm_code = static_cast<int>(msg.get_uint("code"));
        ++alarms_seen;
    });
    CHECK(alarm.valid());

    std::atomic<int> cmds_seen{0};
    std::atomic<double> cmd_value{0.0};
    dart::Subscriber<> cmd(peer, "cmd", &*cmd_schema,
                           [&](const dart::MessageView& msg) {
                               cmd_value = msg.get_f64("n");
                               ++cmds_seen;
                           });
    CHECK(cmd.valid());
    CHECK(peer.start());

    /* ---- the adapter ---- */
    DartMeshOptions mesh_options;
    mesh_options.node_name = "hmi-under-test";
    mesh_options.domain = kDomain;
    mesh_options.interface_ip = kLoopback;
    mesh_options.seed_peers = {kLoopback};
    mesh_options.discovery_port = kDiscoveryPort;
    mesh_options.announce_interval_us = kAnnounceUs;
    mesh_options.verbose = true;
    DartMesh mesh(mesh_options);
    std::string err;
    CHECK_MSG(mesh.start(err), err);

    /* reflection settles once discovery + detail fetches land */
    const char* wanted[] = {"tank_level", "history", "belt", "status",
                            "alarm",      "cmd",     "suction"};
    constexpr size_t kWanted = sizeof(wanted) / sizeof(wanted[0]);
    bool reflected = false;
    for (int i = 0; i < 100 && !reflected; ++i) {
        mesh.refresh();
        size_t found = 0;
        for (const char* name : wanted)
            for (const EntityDef& entity : mesh.reflection())
                if (entity.name == name && (!entity.fields.empty() || !entity.rsp_fields.empty()))
                    ++found;
        reflected = found == kWanted;
        if (!reflected) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        if (!reflected && i % 20 == 19) {
            std::printf("settle %d: peer sees %u peers; %zu/%zu entities [", i,
                        peer.peer_count(), found, kWanted);
            for (const EntityDef& entity : mesh.reflection())
                std::printf(" %c:%s", "VTFS"[static_cast<int>(entity.kind)],
                            entity.name.c_str());
            std::printf(" ]\n");
        }
    }
    CHECK_MSG(reflected, "reflection did not settle");

    const EntityDef* tank_def = nullptr;
    const EntityDef* status_def = nullptr;
    const EntityDef* hist_def = nullptr;
    for (const EntityDef& entity : mesh.reflection()) {
        if (entity.name == "tank_level") tank_def = &entity;
        if (entity.name == "status") status_def = &entity;
        if (entity.name == "history") hist_def = &entity;
    }
    CHECK(hist_def && hist_def->fields.size() == 3);
    if (hist_def && hist_def->fields.size() == 3) {
        CHECK(hist_def->fields[0].shape == Shape::List &&
              hist_def->fields[0].elem == Shape::Num && hist_def->fields[0].bound == 4);
        CHECK(hist_def->fields[1].shape == Shape::List &&
              hist_def->fields[1].elem == Shape::Text);
        CHECK(hist_def->fields[2].shape == Shape::Map);
    }
    CHECK(tank_def && tank_def->kind == EntityKind::Variable);
    if (tank_def) {
        CHECK(tank_def->writable);
        CHECK(tank_def->forceable);
        CHECK(tank_def->fields.size() == 2);
        CHECK(tank_def->fields[0].path == "level" && tank_def->fields[0].shape == Shape::Num);
        CHECK(tank_def->fields[1].path == "label" && tank_def->fields[1].shape == Shape::Text);
    }
    CHECK(status_def && status_def->kind == EntityKind::Function);
    if (status_def) {
        CHECK(status_def->fields.size() == 1 && status_def->fields[0].path == "probe");
        CHECK(status_def->rsp_fields.size() == 1 && status_def->rsp_fields[0].path == "temp" &&
              status_def->rsp_fields[0].shape == Shape::Num);
    }

    /* ---- the document: feeds from every kind, flows back out ---- */
    Json level_widget = {
        {"kind", "widget"},
        {"type", "Readout"},
        {"label", "Level"},
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", entity_ref("V", "tank_level")},
                                    {"path", "level"}}})},
        {"flows", Json::array({
            /* input: RMW write back to the tank; the label must survive untouched */
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "any"},
                 {"do", Json::array({
                     steps::set_x("77.75"),
                     steps::read_into("msg", "V", "tank_level"),
                     steps::set_field("msg", "level", "x"),
                     steps::write_value("msg", "V", "tank_level"),
                 })}},
            /* press: a bare publish and a bare emit */
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                 {"when_mode", "any"},
                 {"do", Json::array({
                     steps::write_field("T", "cmd", "", "5.5"),
                     steps::write_field("S", "alarm", "", "7"),
                 })}},
        })},
    };
    Json label_widget = {
        {"kind", "widget"},
        {"type", "Label"},
        {"label", "Tag"},
        {"feeds", Json::array({Json{{"slot", "text"},
                                    {"src", entity_ref("V", "tank_level")},
                                    {"path", "label"}}})},
    };
    Json speed_widget = {
        {"kind", "widget"},
        {"type", "Readout"},
        {"label", "Speed"},
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", entity_ref("T", "belt")},
                                    {"path", "speed"}}})},
    };
    Json temp_widget = {
        {"kind", "widget"},
        {"type", "Readout"},
        {"label", "Temp"},
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", entity_ref("F", "status")},
                                    {"path", "temp"},
                                    {"poll_hz", 20}}})},
    };
    Json alarm_widget = {
        {"kind", "widget"},
        {"type", "Readout"},
        {"label", "Alarm"},
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", entity_ref("S", "alarm")},
                                    {"path", "code"}}})},
    };
    Json hist_widget = {
        {"kind", "widget"},
        {"type", "Readout"},
        {"label", "Hist"},
        {"feeds", Json::array({
            Json{{"slot", "value"},
                 {"src", entity_ref("V", "history")},
                 {"path", "temps"},
                 {"xf", "x.max"}},
            Json{{"slot", "reading.decimals"},
                 {"src", entity_ref("V", "history")},
                 {"path", "extras"},
                 {"xf", "num(x.get(\"speed\"))"}},
            Json{{"slot", "units.text"},
                 {"src", entity_ref("V", "history")},
                 {"path", "tags"},
                 {"xf", "x.join(\"/\")"}},
        })},
    };

    /* the toggle-off-the-plant idiom: read the value, gate on it, force / unforce.
     * Deliberately NO feed references `suction` anywhere in this document. */
    Json suction_widget = {
        {"kind", "widget"},
        {"type", "Button"},
        {"label", "Suction"},
        {"flows", Json::array({
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({
                     Json{{"kind", "move"}, {"mode", "write"},
                          {"from", entity_ref("V", "suction")},
                          {"to", Json{{"local", "current"}, {"path", ""}}}},
                     Json{{"kind", "gate"}, {"a", "current.on == false"}},
                     Json{{"kind", "move"}, {"mode", "force"},
                          {"from", Json{{"expr", "true"}}},
                          {"to", entity_ref("V", "suction")}},
                 })}},
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({
                     Json{{"kind", "move"}, {"mode", "write"},
                          {"from", entity_ref("V", "suction")},
                          {"to", Json{{"local", "current"}, {"path", ""}}}},
                     Json{{"kind", "gate"}, {"a", "current.on == true"}},
                     Json{{"kind", "move"}, {"mode", "unforce"},
                          {"from", Json{{"expr", "x"}}},
                          {"to", entity_ref("V", "suction")}},
                 })}},
        })},
    };

    Json root = {
        {"version", 1},
        {"next_id", 1},
        {"globals", Json::array()},
        {"pages", Json::array({Json{{"name", "Main"},
                                    {"children", Json::array({level_widget, label_widget,
                                                              speed_widget, temp_widget,
                                                              alarm_widget, hist_widget,
                                                              suction_widget})}}})},
    };
    Document document;
    CHECK_MSG(document.adopt(std::move(root), err), err);

    CompileResult compiled = compile_document(document, builtin_registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!compiled.ok) return check::summary("mesh_test");

    const Json& page = document.root["pages"][0];
    const uint64_t page_id = page.value("id", 0);
    const uint64_t level_id = page["children"][0].value("id", 0);
    const uint64_t label_id = page["children"][1].value("id", 0);
    const uint64_t speed_id = page["children"][2].value("id", 0);
    const uint64_t temp_id = page["children"][3].value("id", 0);
    const uint64_t alarm_id = page["children"][4].value("id", 0);
    const uint64_t hist_id = page["children"][5].value("id", 0);

    Scheduler sched(std::move(compiled.program), mesh);
    mesh.apply(sched.program());
    mesh.set_viewed_pages({page_id});

    const int level_cell = cell_of(sched.program(), level_id, "value");
    const int label_cell = cell_of(sched.program(), label_id, "text");
    const int speed_cell = cell_of(sched.program(), speed_id, "value");
    const int temp_cell = cell_of(sched.program(), temp_id, "value");
    const int alarm_cell = cell_of(sched.program(), alarm_id, "value");
    CHECK(level_cell >= 0 && label_cell >= 0 && speed_cell >= 0 && temp_cell >= 0 &&
          alarm_cell >= 0);

    /* variable state arrives without any new write (on_change replays at registration) */
    CHECK_MSG(run_until(sched, [&] { return num_at(sched, level_cell) == 42.5; }),
              "tank level never arrived");
    CHECK_MSG(run_until(sched, [&] { return text_at(sched, label_cell) == "ok"; }),
              "tank label never arrived");

    /* aggregate fields decode into list/map values and reduce through transforms */
    {
        const int hist_max = cell_of(sched.program(), hist_id, "value");
        const int hist_speed = cell_of(sched.program(), hist_id, "reading.decimals");
        const int hist_tags = cell_of(sched.program(), hist_id, "units.text");
        CHECK(hist_max >= 0 && hist_speed >= 0 && hist_tags >= 0);
        CHECK_MSG(run_until(sched, [&] { return num_at(sched, hist_max) == 9.25; }),
                  "temps.max never arrived");
        CHECK_MSG(run_until(sched, [&] { return num_at(sched, hist_speed) == 5.0; }),
                  "extras.speed never arrived");
        CHECK_MSG(run_until(sched, [&] { return text_at(sched, hist_tags) == "hot/cold"; }),
                  "tags join never arrived");
    }

    /* a topic feed: publish from the peer until the cell shows it */
    {
        dart::MessageBuilder msg(*belt_schema);
        msg.set_f64("speed", 3.5).set_bool("running", true);
        CHECK(msg.ok());
        bool seen = false;
        for (int i = 0; i < 80 && !seen; ++i) {
            belt.send(msg.bytes());
            seen = run_until(sched, [&] { return num_at(sched, speed_cell) == 3.5; }, 100);
        }
        CHECK_MSG(seen, "belt speed never arrived");
    }

    /* a paced function feed (20 Hz, page visible) */
    CHECK_MSG(run_until(sched, [&] { return num_at(sched, temp_cell) == 21.25; }),
              "status.temp never arrived");
    CHECK_MSG(calls.load() > 0, "the peer's function was never called");

    /* a signal feed */
    {
        dart::MessageBuilder fire(*alarm_schema);
        fire.set_uint("code", 9);
        CHECK(fire.ok());
        bool seen = false;
        for (int i = 0; i < 80 && !seen; ++i) {
            alarm.emit(fire.bytes());
            seen = run_until(sched, [&] { return num_at(sched, alarm_cell) == 9.0; }, 100);
        }
        CHECK_MSG(seen, "alarm code never arrived");
    }

    /* effects: the tap flow RMW-writes the tank (label untouched), the press flow
     * publishes to the peer's subscriber and emits the alarm */
    uint64_t seq = 1;
    {
        bool written = false;
        for (int i = 0; i < 40 && !written; ++i) {
            sched.post(InputEvent{1, level_id, "tap", Value::number(0), seq++});
            written = run_until(
                sched,
                [&] {
                    auto bytes = tank.get();
                    if (!bytes) return false;
                    const dart::detail::DartBytes data =
                        dart::detail::dart_bytes(bytes->data(), bytes->size());
                    return dart::detail::dart_get_f64(data, tank_schema->raw(), "level") ==
                           77.75;
                },
                200);
        }
        CHECK_MSG(written, "the variable write never landed");
        auto bytes = tank.get();
        CHECK(bytes.has_value());
        if (bytes) {
            const dart::detail::DartBytes data =
                dart::detail::dart_bytes(bytes->data(), bytes->size());
            CHECK_EQ(dart::detail::dart_get_f64(data, tank_schema->raw(), "level"), 77.75);
            const dart::detail::DartString label =
                dart::detail::dart_get_string(data, tank_schema->raw(), "label");
            CHECK_EQ(std::string(label.data ? label.data : "", label.len), std::string("ok"));
        }
        /* and the feed loops the write back into the cell */
        CHECK_MSG(run_until(sched, [&] { return num_at(sched, level_cell) == 77.75; }),
                  "the write never fed back");
    }
    {
        bool seen = false;
        for (int i = 0; i < 40 && !seen; ++i) {
            sched.post(InputEvent{1, level_id, "press", Value::boolean(true), seq++});
            seen = run_until(sched, [&] { return cmds_seen.load() > 0; }, 200);
        }
        CHECK_MSG(seen, "the publish never reached the peer");
        CHECK_EQ(cmd_value.load(), 5.5);
        CHECK_MSG(run_until(sched, [&] { return alarms_seen.load() > 0; }, 2000),
                  "the emit never reached the peer");
        CHECK_EQ(alarm_code.load(), 7);
    }

    /* the flow-read toggle: the gates only ever pass once the flow_reads subscription
     * fills the mirror, so a landed force IS the proof of consumption */
    {
        const uint64_t suction_id = page["children"][6].value("id", 0);
        bool forced_on = false;
        for (int i = 0; i < 40 && !forced_on; ++i) {
            sched.post(InputEvent{1, suction_id, "tap", Value::boolean(true), seq++});
            forced_on = run_until(sched, [&] { return suction.forced(); }, 200);
        }
        CHECK_MSG(forced_on, "the flow-read gate never saw the value; force never landed");
        bool released = false;
        for (int i = 0; i < 40 && !released; ++i) {
            sched.post(InputEvent{1, suction_id, "tap", Value::boolean(true), seq++});
            released = run_until(sched, [&] { return !suction.forced(); }, 200);
        }
        CHECK_MSG(released, "the unforce never landed");
    }

    return check::summary("mesh_test");
}

/* End-to-end over a real mesh: a peer dart::Node hosting a variable, a topic, a
 * function and a signal on loopback multicast, against the DartMesh adapter driving
 * the compiled runtime. Covers reflection (kinds, fields, shapes), feeds from every
 * entity kind (including text and a paced function poll), and effects back out
 * (RMW variable write preserving an untouched text field, publish, emit). Runs on an
 * isolated domain so a busy desk never interferes. */
#include "check.h"
#include "compile/compiler.h"
#include "doc/doc.h"
#include "mesh/dart_mesh.h"
#include "registry/registry.h"
#include "sched/scheduler.h"

#include "dart.hpp"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <thread>

using namespace hmi;

namespace {

constexpr uint16_t kDomain = 41;
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
    auto belt_schema = dart::Schema::compile("Belt { speed: f64, running: bool }");
    auto req_schema = dart::Schema::compile("StatusQ { probe: u8 }");
    auto rsp_schema = dart::Schema::compile("StatusR { temp: f64 }");
    auto alarm_schema = dart::Schema::compile("Alarm { code: u8 }");
    auto cmd_schema = dart::Schema::compile("Cmd { n: f64 }");
    CHECK(tank_schema && belt_schema && req_schema && rsp_schema && alarm_schema && cmd_schema);
    if (!tank_schema || !belt_schema || !req_schema || !rsp_schema || !alarm_schema ||
        !cmd_schema)
        return check::summary("mesh_test");

    dart::NodeOptions peer_options;
    peer_options.domain = kDomain;
    peer_options.multicast_interface = kLoopback;
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
    mesh_options.announce_interval_us = kAnnounceUs;
    DartMesh mesh(mesh_options);
    std::string err;
    CHECK_MSG(mesh.start(err), err);

    /* reflection settles once discovery + detail fetches land */
    const char* wanted[] = {"tank_level", "belt", "status", "alarm", "cmd"};
    bool reflected = false;
    for (int i = 0; i < 100 && !reflected; ++i) {
        mesh.refresh();
        size_t found = 0;
        for (const char* name : wanted)
            for (const EntityDef& entity : mesh.reflection())
                if (entity.name == name && (!entity.fields.empty() || !entity.rsp_fields.empty()))
                    ++found;
        reflected = found == 5;
        if (!reflected) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    CHECK_MSG(reflected, "reflection did not settle");

    const EntityDef* tank_def = nullptr;
    const EntityDef* status_def = nullptr;
    for (const EntityDef& entity : mesh.reflection()) {
        if (entity.name == "tank_level") tank_def = &entity;
        if (entity.name == "status") status_def = &entity;
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
        {"type", "Readout"},
        {"label", "Level"},
        {"geom", Json{{"x", 0}, {"y", 0}, {"w", 120}, {"h", 60}}},
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", entity_ref("V", "tank_level")},
                                    {"path", "level"}}})},
        {"flows", Json::array({
            /* input: RMW write back to the tank; the label must survive untouched */
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "any"},
                 {"do", Json::array({
                     Json{{"kind", "transform"}, {"a", "77.75"}},
                     Json{{"kind", "build"},
                          {"buf", "msg"},
                          {"target", entity_ref("V", "tank_level")},
                          {"seed", "last"}},
                     Json{{"kind", "setf"}, {"path", "level"}, {"a", "x"}},
                     Json{{"kind", "send"}, {"buf", "msg"}, {"verb", "write"}},
                 })}},
            /* press: a bare publish and a bare emit */
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                 {"when_mode", "any"},
                 {"do", Json::array({
                     Json{{"kind", "transform"}, {"a", "5.5"}},
                     Json{{"kind", "send"},
                          {"target", entity_ref("T", "cmd")},
                          {"verb", "publish"}},
                     Json{{"kind", "transform"}, {"a", "7"}},
                     Json{{"kind", "send"},
                          {"target", entity_ref("S", "alarm")},
                          {"verb", "emit"}},
                 })}},
        })},
    };
    Json label_widget = {
        {"type", "Label"},
        {"label", "Tag"},
        {"geom", Json{{"x", 130}, {"y", 0}, {"w", 120}, {"h", 60}}},
        {"feeds", Json::array({Json{{"slot", "text"},
                                    {"src", entity_ref("V", "tank_level")},
                                    {"path", "label"}}})},
    };
    Json speed_widget = {
        {"type", "Readout"},
        {"label", "Speed"},
        {"geom", Json{{"x", 0}, {"y", 70}, {"w", 120}, {"h", 60}}},
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", entity_ref("T", "belt")},
                                    {"path", "speed"}}})},
    };
    Json temp_widget = {
        {"type", "Readout"},
        {"label", "Temp"},
        {"geom", Json{{"x", 130}, {"y", 70}, {"w", 120}, {"h", 60}}},
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", entity_ref("F", "status")},
                                    {"path", "temp"},
                                    {"poll_hz", 20}}})},
    };
    Json alarm_widget = {
        {"type", "Readout"},
        {"label", "Alarm"},
        {"geom", Json{{"x", 260}, {"y", 0}, {"w", 120}, {"h", 60}}},
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", entity_ref("S", "alarm")},
                                    {"path", "code"}}})},
    };

    Json root = {
        {"version", 1},
        {"next_id", 1},
        {"globals", Json::array()},
        {"pages", Json::array({Json{{"name", "Main"},
                                    {"widgets", Json::array({level_widget, label_widget,
                                                             speed_widget, temp_widget,
                                                             alarm_widget})}}})},
    };
    Document document;
    CHECK_MSG(document.adopt(std::move(root), err), err);

    CompileResult compiled = compile_document(document, registry(), mesh);
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.grade == DiagGrade::Error)
            std::printf("compile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
    CHECK(compiled.ok);
    if (!compiled.ok) return check::summary("mesh_test");

    const Json& page = document.root["pages"][0];
    const uint64_t page_id = page.value("id", 0);
    const uint64_t level_id = page["widgets"][0].value("id", 0);
    const uint64_t label_id = page["widgets"][1].value("id", 0);
    const uint64_t speed_id = page["widgets"][2].value("id", 0);
    const uint64_t temp_id = page["widgets"][3].value("id", 0);
    const uint64_t alarm_id = page["widgets"][4].value("id", 0);

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

    return check::summary("mesh_test");
}

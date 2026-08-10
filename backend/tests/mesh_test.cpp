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

    /* a variable the document only WRITES (no feed, no flow read anywhere): its
     * accessor exists solely because the compiler stamps flow_writes, and the very
     * first write races the accessor's forming owner match */
    auto set_schema = dart::Schema::compile("Set { target: f64 }");
    CHECK(set_schema.has_value());
    if (!set_schema) return check::summary("mesh_test");
    dart::MessageBuilder set_initial(*set_schema);
    set_initial.set_f64("target", 0.0);
    CHECK(set_initial.ok());
    dart::VariableOptions<> setpoint_options;
    setpoint_options.initial = set_initial.bytes();
    dart::VariableDefinition<> setpoint(peer, "setpoint", &*set_schema, setpoint_options);
    CHECK(setpoint.valid());

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

    /* BARE-TYPED topics (the whole schema is one anonymous type, no struct): a bool
     * the HMI publishes to, and an f64 it feeds from; both address the value by "" */
    auto flag_schema = dart::Schema::compile("bool");
    auto pressure_schema = dart::Schema::compile("f64");
    CHECK(flag_schema.has_value() && pressure_schema.has_value());
    if (!flag_schema || !pressure_schema) return check::summary("mesh_test");
    std::atomic<int> flags_seen{0};
    std::atomic<bool> flag_value{false};
    dart::Subscriber<> flag(peer, "flag", &*flag_schema,
                            [&](const dart::MessageView& msg) {
                                flag_value = msg.get_uint("") != 0;
                                ++flags_seen;
                            });
    CHECK(flag.valid());
    dart::Publisher<> pressure(peer, "pressure", &*pressure_schema,
                               dart::Qos{dart::Reliability::Reliable});
    CHECK(pressure.valid());
    CHECK(peer.start());

    /* a SECOND provider node the retype section below restarts with a new schema */
    auto gauge_v1 = dart::Schema::compile("Gauge { value: f64, unit: string<8> }");
    CHECK(gauge_v1.has_value());
    if (!gauge_v1) return check::summary("mesh_test");
    std::optional<dart::Node> prov;
    std::optional<dart::Publisher<>> gauge_pub;
    prov.emplace(
        "plant2", dart::Node::MessageHandler{},
        [](const dart::Event& event) {
            if (event.is_error()) std::printf("prov: %s\n", event.to_string().c_str());
        },
        peer_options);
    CHECK(prov->valid());
    gauge_pub.emplace(*prov, "gauge", &*gauge_v1, dart::Qos{dart::Reliability::Reliable});
    CHECK(gauge_pub->valid());
    CHECK(prov->start());

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
    const char* wanted[] = {"tank_level", "history", "belt", "status",   "alarm",
                            "cmd",        "suction", "flag", "pressure", "gauge",
                            "setpoint"};
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
    const EntityDef* flag_def = nullptr;
    for (const EntityDef& entity : mesh.reflection()) {
        if (entity.name == "tank_level") tank_def = &entity;
        if (entity.name == "status") status_def = &entity;
        if (entity.name == "history") hist_def = &entity;
        if (entity.name == "flag") flag_def = &entity;
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
    /* a bare-typed topic reflects as ONE anonymous field (path "") and no root name */
    CHECK(flag_def && flag_def->kind == EntityKind::Topic);
    if (flag_def) {
        CHECK(flag_def->type_name.empty());
        CHECK(flag_def->fields.size() == 1 && flag_def->fields[0].path.empty() &&
              flag_def->fields[0].shape == Shape::Bool);
    }

    /* ---- the document: slot expressions over every kind, flows back out ---- */
    Json level_widget = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Level"},
        {"slots", Json{{"value", "@tank_level.level"}}},
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
            /* press: a bare publish and a bare emit, plus a publish to a BARE-TYPED
             * topic (the anonymous value addressed by the empty path) */
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                 {"when_mode", "any"},
                 {"do", Json::array({
                     steps::write_field("T", "cmd", "", "5.5"),
                     steps::write_field("S", "alarm", "", "7"),
                     steps::write_field("T", "flag", "", "true"),
                 })}},
        })},
    };
    Json label_widget = {
        {"kind", "frame"},
        {"type", "Label"},
        {"name", "Tag"},
        {"slots", Json{{"text", "@tank_level.label"}}},
    };
    Json speed_widget = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Speed"},
        {"slots", Json{{"value", "@belt.speed"}}},
    };
    Json temp_widget = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Temp"},
        /* a FUNCTION source: the response field reads like any other, the cadence
           rides the widget's poll map (spec D1) */
        {"slots", Json{{"value", "@status.temp"}}},
        {"poll", Json{{"value", 20}}},
    };
    Json alarm_widget = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Alarm"},
        {"slots", Json{{"value", "@alarm.code"}}},
    };
    Json hist_widget = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Hist"},
        /* aggregate mesh fields read off the ENTITY MIRRORS: the delivery lands in a
           retained slot and the expression reduces it like any list or map */
        {"slots", Json{{"value", "@history.temps.max"},
                       {"reading",
                        Json{{"decimals", "num(@history.extras.get(\"speed\"))"}}},
                       {"units", Json{{"text", "@history.tags.join(\"/\")"}}}}},
    };

    /* a BARE-TYPED topic: the anonymous value IS the entity, read bare */
    Json pressure_widget = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Pressure"},
        {"slots", Json{{"value", "@pressure"}}},
    };

    /* the toggle-off-the-plant idiom: read the value, gate on it, force / unforce.
     * Deliberately NO slot expression references `suction` anywhere in this document. */
    Json suction_widget = {
        {"kind", "frame"},
        {"type", "Button"},
        {"name", "Suction"},
        {"flows", Json::array({
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({
                     Json{{"kind", "assign"}, {"mode", "write"},
                          {"from", Json{{"expr", "@suction"}}},
                          {"to", Json{{"local", "current"}, {"path", ""}}}},
                     Json{{"kind", "gate"}, {"a", "current.on == false"}},
                     Json{{"kind", "assign"}, {"mode", "force"},
                          {"from", Json{{"expr", "true"}}},
                          {"to", entity_ref("V", "suction")}},
                 })}},
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({
                     Json{{"kind", "assign"}, {"mode", "write"},
                          {"from", Json{{"expr", "@suction"}}},
                          {"to", Json{{"local", "current"}, {"path", ""}}}},
                     Json{{"kind", "gate"}, {"a", "current.on == true"}},
                     Json{{"kind", "assign"}, {"mode", "unforce"},
                          {"from", Json{{"expr", "x"}}},
                          {"to", entity_ref("V", "suction")}},
                 })}},
        })},
    };

    Json gauge_widget = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Gauge"},
        {"slots", Json{{"value", "@gauge.value"}}},
    };

    /* WRITE-ONLY: no expression anywhere reads @setpoint, so only the flow_writes
     * stamp gives it a standing accessor */
    Json setpoint_widget = {
        {"kind", "frame"},
        {"type", "Button"},
        {"name", "Setpoint"},
        {"flows", Json::array({
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "any"},
                 {"do", Json::array({
                     steps::write_field("V", "setpoint", "target", "5.5"),
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
                                                              suction_widget,
                                                              pressure_widget,
                                                              gauge_widget,
                                                              setpoint_widget})}}})},
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
    const uint64_t pressure_id = page["children"][7].value("id", 0);

    Scheduler sched(std::move(compiled.program), mesh);
    mesh.apply(sched.program());
    mesh.set_viewed_pages({page_id});

    /* ---- THE FIRST WRITE, immediately: the setpoint accessor was created by the
     * apply() a moment ago (flow_writes is its only claim to one) and its owner
     * match is still forming. ONE tap, no retries — the write must land anyway
     * (the mesh layer waits out the forming match instead of failing with a
     * no-owner send status and dropping the effect). ---- */
    {
        const uint64_t setpoint_id = page["children"][9].value("id", 0);
        sched.post(InputEvent{2, setpoint_id, "tap", Value::number(0), 1});
        const bool landed = run_until(
            sched,
            [&] {
                auto bytes = setpoint.get();
                if (!bytes) return false;
                const dart::detail::DartBytes data =
                    dart::detail::dart_bytes(bytes->data(), bytes->size());
                return dart::detail::dart_get_f64(data, set_schema->raw(), "target") == 5.5;
            },
            2000);
        CHECK_MSG(landed, "the FIRST write to a write-only variable never landed");
    }

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

    /* a topic binding: publish from the peer until the cell shows it */
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

    /* a BARE topic binding: the anonymous value reads bare */
    {
        const int pressure_cell = cell_of(sched.program(), pressure_id, "value");
        CHECK(pressure_cell >= 0);
        dart::MessageBuilder msg(*pressure_schema);
        msg.set_f64("", 3.25);
        CHECK(msg.ok());
        bool seen = false;
        for (int i = 0; i < 80 && !seen; ++i) {
            pressure.send(msg.bytes());
            seen = run_until(sched, [&] { return num_at(sched, pressure_cell) == 3.25; }, 100);
        }
        CHECK_MSG(seen, "bare pressure never arrived");
    }

    /* a paced function binding (20 Hz off the poll map, page visible) */
    CHECK_MSG(run_until(sched, [&] { return num_at(sched, temp_cell) == 21.25; }),
              "status.temp never arrived");
    CHECK_MSG(calls.load() > 0, "the peer's function was never called");

    /* a signal binding */
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
        /* and the binding loops the write back into the cell */
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

    /* the publish to the BARE-TYPED topic: the codec rebuilt from reflection must
     * spell the bare form, or the topic is refused as untyped */
    {
        bool seen = false;
        for (int i = 0; i < 40 && !seen; ++i) {
            sched.post(InputEvent{1, level_id, "press", Value::boolean(true), seq++});
            seen = run_until(sched, [&] { return flags_seen.load() > 0; }, 200);
        }
        CHECK_MSG(seen, "the bare publish never reached the peer");
        CHECK(flag_value.load());
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

    /* ---- a provider restarting with a NEW schema for a live topic: the adapter
     * retires the old-typed handle and codec on refresh and re-subscribes with the
     * new type through the ordinary recompile + apply path, so a binding whose field
     * survives the change keeps working without an HMI restart ---- */
    {
        const uint64_t gauge_id = page["children"][8].value("id", 0);
        const int gauge_cell = cell_of(sched.program(), gauge_id, "value");
        CHECK(gauge_cell >= 0);

        /* baseline: the v1 subscription feeds the cell */
        dart::MessageBuilder v1_msg(*gauge_v1);
        v1_msg.set_f64("value", 6.5).set_string("unit", "bar");
        CHECK(v1_msg.ok());
        bool seen = false;
        for (int i = 0; i < 80 && !seen; ++i) {
            gauge_pub->send(v1_msg.bytes());
            seen = run_until(sched, [&] { return num_at(sched, gauge_cell) == 6.5; }, 100);
        }
        CHECK_MSG(seen, "gauge v1 value never arrived");

        /* the provider restarts with a CHANGED schema (value survives, unit -> extra) */
        auto gauge_v2 = dart::Schema::compile("Gauge { value: f64, extra: u8 }");
        CHECK(gauge_v2.has_value());
        if (!gauge_v2) return check::summary("mesh_test");
        gauge_pub.reset();
        prov.reset();
        prov.emplace(
            "plant2", dart::Node::MessageHandler{},
            [](const dart::Event& event) {
                if (event.is_error()) std::printf("prov: %s\n", event.to_string().c_str());
            },
            peer_options);
        CHECK(prov->valid());
        gauge_pub.emplace(*prov, "gauge", &*gauge_v2, dart::Qos{dart::Reliability::Reliable});
        CHECK(gauge_pub->valid());
        CHECK(prov->start());

        /* refresh at control-plane pace until the new type reflects with its fields */
        bool retyped = false;
        for (int i = 0; i < 100 && !retyped; ++i) {
            mesh.refresh();
            for (const EntityDef& entity : mesh.reflection())
                if (entity.name == "gauge" && entity.schema_hash == gauge_v2->hash() &&
                    entity.fields.size() == 2)
                    retyped = true;
            if (!retyped) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        CHECK_MSG(retyped, "the re-typed gauge never reflected");

        /* the app's hot-swap: recompile against the new reflection, re-apply */
        CompileResult swapped = compile_document(document, builtin_registry(), mesh);
        for (const Diag& diag : swapped.program.diagnostics)
            if (diag.grade == DiagGrade::Error)
                std::printf("recompile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
        CHECK(swapped.ok);
        if (!swapped.ok) return check::summary("mesh_test");
        Scheduler swapped_sched(std::move(swapped.program), mesh);
        mesh.apply(swapped_sched.program());
        mesh.set_viewed_pages({page_id});

        const int swapped_cell = cell_of(swapped_sched.program(), gauge_id, "value");
        CHECK(swapped_cell >= 0);
        dart::MessageBuilder v2_msg(*gauge_v2);
        v2_msg.set_f64("value", 8.25).set_uint("extra", 3);
        CHECK(v2_msg.ok());
        seen = false;
        for (int i = 0; i < 80 && !seen; ++i) {
            gauge_pub->send(v2_msg.bytes());
            seen = run_until(swapped_sched,
                             [&] { return num_at(swapped_sched, swapped_cell) == 8.25; }, 100);
        }
        CHECK_MSG(seen, "the re-typed gauge value never arrived");
    }

    /* ---- the built-in @dart/log stream: a peer's log lines reach take_logs, decoded
     * with the publisher's name, the level and a comparable wall stamp ---- */
    {
        CHECK(peer.log_error("boiler overtemp") == dart::SendStatus::Ok);
        CHECK(peer.log_info("shift change") == dart::SendStatus::Ok);
        std::vector<MeshLogLine> lines;
        bool got_error = false;
        bool got_info = false;
        for (int i = 0; i < 100 && !(got_error && got_info); ++i) {
            mesh.take_logs(lines);
            for (const MeshLogLine& line : lines) {
                if (line.level == 0 && line.text == "boiler overtemp" &&
                    line.node == "plant" && line.wall_us > 0)
                    got_error = true;
                if (line.level == 2 && line.text == "shift change") got_info = true;
            }
            lines.clear();
            if (!(got_error && got_info))
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        CHECK_MSG(got_error, "the peer's log_error line never arrived");
        CHECK_MSG(got_info, "the peer's log_info line never arrived");
    }

    return check::summary("mesh_test");
}

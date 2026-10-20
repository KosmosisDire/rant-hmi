/* End-to-end over a real mesh: a peer rant::Node hosting a variable, a topic, a
 * function and a task on loopback multicast, against the RantMesh adapter driving
 * the compiled runtime. Covers reflection (kinds, fields, shapes), feeds from every
 * entity kind (including text, a paced function poll, and a task's running/message/
 * progress/result read table), and effects back out (RMW variable write preserving
 * an untouched text field, publish, task start and cancel). Runs on an
 * isolated domain so a busy desk never interferes. */
#include "check.h"
#include "steps.h"
#include "compile/compiler.h"
#include "doc/doc.h"
#include "mesh/rant_mesh.h"
#include "compile/components.h"
#include "sched/scheduler.h"
#include "vm/state.h"

#include "rant.hpp"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>

using namespace hmi;

namespace {

constexpr uint16_t kDomain = 41;
/* own discovery PORT, not just domain: another RANT process on this host (the explorer,
 * a bridge) shares UDP 6730 via REUSEADDR and swallows the unicast seed announces */
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

int cell_of(const Program& program, uint64_t instance, const char* slot) {
    for (uint32_t i = 0; i < program.cells.size(); ++i)
        if (program.cells[i].kind == CellKind::Slot && program.cells[i].owner_node == instance &&
            program.cells[i].name == slot)
            return static_cast<int>(i);
    return -1;
}

int global_cell_of(const Program& program, const char* name) {
    for (uint32_t i = 0; i < program.cells.size(); ++i)
        if (program.cells[i].kind == CellKind::Global && program.cells[i].name == name)
            return static_cast<int>(i);
    return -1;
}

double num_at(const Scheduler& sched, int cell) {
    if (cell < 0) return -1e300;
    const Value& value = sched.state().store.values[cell];
    return value.tag == ValueTag::Num ? value.data.num : -1e300;
}

std::string text_at(const Scheduler& sched, int cell) {
    if (cell < 0) return "<no cell>";
    const Value& value = sched.state().store.values[cell];
    return std::string(sched.state().text(sched.program(), value));
}

int bool_at(const Scheduler& sched, int cell) {
    if (cell < 0) return -1;
    const Value& value = sched.state().store.values[cell];
    return value.tag == ValueTag::Bool ? (value.data.boolean ? 1 : 0) : -1;
}

} // namespace

int main() {
    /* ---- the peer: what a small controller node looks like on the mesh ---- */
    rant::NodeOptions peer_options;
    peer_options.domain = kDomain;
    peer_options.multicast_interface = kLoopback;
    /* the rant_test selftest recipe: loopback multicast PLUS a unicast seed, because
     * Windows loopback multicast is not reliable on its own (announces also reinforce
     * to known peers' data ports, so one landed announce heals both directions) */
    peer_options.seed_peers = {kLoopback};
    peer_options.discovery_port = kDiscoveryPort;
    peer_options.announce_interval = std::chrono::microseconds(kAnnounceUs);
    peer_options.max_topics = 32;
    rant::Node peer("plant", peer_options);
    peer.on_event([](const rant::Event& event) {
        if (event.is_error()) std::printf("peer: %s\n", event.to_string().c_str());
    });
    CHECK(peer.valid());

    /* every schema below lives in peer's registry, which outlives every other node
     * this test creates and destroys, so a schema compiled here stays good to hand
     * to any of them (a Schema is just a pointer into its owning node's registry) */
    rant::Schema tank_schema = peer.schema("Tank { level: f64, label: string<16> }");
    rant::Schema hist_schema =
        peer.schema("Hist { temps: f64[4] tags: string<8>[] extras: map }");
    rant::Schema belt_schema = peer.schema("Belt { speed: f64, running: bool }");
    rant::Schema req_schema = peer.schema("StatusQ { probe: u8 }");
    rant::Schema rsp_schema = peer.schema("StatusR { temp: f64 }");
    rant::Schema purge_q = peer.schema("PurgeQ { target: u8 }");
    rant::Schema purge_p = peer.schema("PurgeP { pct: f64 }");
    rant::Schema purge_r = peer.schema("PurgeR { done: u8 }");
    rant::Schema cmd_schema = peer.schema("Cmd { n: f64 }");
    CHECK(tank_schema && hist_schema && belt_schema && req_schema && rsp_schema &&
          purge_q && purge_p && purge_r && cmd_schema);
    if (!tank_schema || !hist_schema || !belt_schema || !req_schema || !rsp_schema ||
        !purge_q || !purge_p || !purge_r || !cmd_schema)
        return check::summary("mesh_test");

    rant::MessageBuilder initial(tank_schema);
    initial.set_f64("level", 42.5).set_string("label", "ok");
    CHECK(initial.ok());
    rant::VariableOptions<rant::Bytes> tank_options;
    tank_options.initial = initial.bytes();
    tank_options.allow_force = true;
    rant::VariableDefinition<rant::Bytes> tank =
        peer.variable_definition<rant::Bytes>("tank_level", tank_options, tank_schema);
    CHECK(tank.valid());

    rant::Publisher<rant::Bytes> belt = peer.publisher<rant::Bytes>(
        "belt", rant::Qos{rant::Reliability::Reliable}, belt_schema);
    CHECK(belt.valid());

    /* a variable with every aggregate kind: fixed f64 array, varr of strings, map */
    rant::MessageBuilder hist_initial(hist_schema);
    {
        const double temps[4] = {1.5, 9.25, 3.0, 0.5};
        hist_initial.set_array("temps", rant::Bytes(
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
        hist_initial.set_array("tags", rant::Bytes(tag_slots.data(), tag_slots.size()));
        rant::MapWriter extras;
        extras.put_uint("speed", 5).put_string("state", "run");
        CHECK(extras.ok());
        hist_initial.set_map("extras", extras);
    }
    CHECK(hist_initial.ok());
    rant::VariableOptions<rant::Bytes> hist_options;
    hist_options.initial = hist_initial.bytes();
    rant::VariableDefinition<rant::Bytes> hist =
        peer.variable_definition<rant::Bytes>("history", hist_options, hist_schema);
    CHECK(hist.valid());

    /* a forceable bool the document only reads from FLOWS (no feed names it): the
     * flow-signature subscription is the only thing that can fill its mirror */
    rant::Schema suck_schema = peer.schema("Suck { on: bool }");
    CHECK(!suck_schema.empty());
    if (!suck_schema) return check::summary("mesh_test");
    rant::MessageBuilder suck_initial(suck_schema);
    suck_initial.set_bool("on", false);
    CHECK(suck_initial.ok());
    rant::VariableOptions<rant::Bytes> suction_options;
    suction_options.initial = suck_initial.bytes();
    suction_options.allow_force = true;
    rant::VariableDefinition<rant::Bytes> suction =
        peer.variable_definition<rant::Bytes>("suction", suction_options, suck_schema);
    CHECK(suction.valid());

    /* a variable the document only WRITES (no feed, no flow read anywhere): its
     * accessor exists solely because a flow's signature writes it, and the very
     * first write races the accessor's forming owner match */
    rant::Schema set_schema = peer.schema("Set { target: f64 }");
    CHECK(!set_schema.empty());
    if (!set_schema) return check::summary("mesh_test");
    rant::MessageBuilder set_initial(set_schema);
    set_initial.set_f64("target", 0.0);
    CHECK(set_initial.ok());
    rant::VariableOptions<rant::Bytes> setpoint_options;
    setpoint_options.initial = set_initial.bytes();
    rant::VariableDefinition<rant::Bytes> setpoint =
        peer.variable_definition<rant::Bytes>("setpoint", setpoint_options, set_schema);
    CHECK(setpoint.valid());

    std::atomic<int> calls{0};
    rant::FunctionDefinition<rant::Bytes, rant::Bytes> status =
        peer.function_definition<rant::Bytes, rant::Bytes>(
            "status",
            [&](rant::Request<rant::Bytes>& request) {
                ++calls;
                rant::MessageBuilder reply(rsp_schema);
                reply.set_f64("temp", 21.25);
                request.reply(reply.bytes());
            },
            {}, req_schema, rsp_schema);
    CHECK(status.valid());

    /* the TASK: the handler defers and the TEST drives the pending call from this
     * thread (progress, completion, honoring cancel) — the token verbs are
     * thread-safe by contract */
    std::atomic<int> purge_calls{0};
    std::atomic<int> purge_target{0};
    std::mutex purge_mu;
    std::optional<rant::PendingTask<rant::Bytes, rant::Bytes>> purge_pending;
    rant::TaskDefinition<rant::Bytes, rant::Bytes, rant::Bytes> purge =
        peer.task_definition<rant::Bytes, rant::Bytes, rant::Bytes>(
            "purge",
            [&](rant::TaskRequest<rant::Bytes, rant::Bytes>& request) {
                purge_target = static_cast<int>(request.get_uint("target"));
                ++purge_calls;
                std::lock_guard<std::mutex> hold(purge_mu);
                purge_pending.emplace(request.defer());
            },
            {}, purge_q, purge_p, purge_r);
    CHECK(purge.valid());

    std::atomic<int> cmds_seen{0};
    std::atomic<double> cmd_value{0.0};
    rant::Subscriber<rant::Bytes> cmd = peer.subscriber<rant::Bytes>(
        "cmd",
        [&](const rant::MessageView& msg) {
            cmd_value = msg.get_f64("n");
            ++cmds_seen;
        },
        {}, cmd_schema);
    CHECK(cmd.valid());

    /* BARE-TYPED topics (the whole schema is one anonymous type, no struct): a bool
     * the HMI publishes to, and an f64 it feeds from; both address the value by "" */
    rant::Schema flag_schema = peer.schema("bool");
    rant::Schema pressure_schema = peer.schema("f64");
    CHECK(flag_schema && pressure_schema);
    if (!flag_schema || !pressure_schema) return check::summary("mesh_test");
    std::atomic<int> flags_seen{0};
    std::atomic<bool> flag_value{false};
    rant::Subscriber<rant::Bytes> flag = peer.subscriber<rant::Bytes>(
        "flag",
        [&](const rant::MessageView& msg) {
            flag_value = msg.get_uint("") != 0;
            ++flags_seen;
        },
        {}, flag_schema);
    CHECK(flag.valid());
    rant::Publisher<rant::Bytes> pressure = peer.publisher<rant::Bytes>(
        "pressure", rant::Qos{rant::Reliability::Reliable}, pressure_schema);
    CHECK(pressure.valid());

    /* a SECOND provider node the retype section below restarts with a new schema.
     * gauge_v1 lives in prov's own registry (not peer's), since it is only ever used
     * to type prov's own publisher for as long as this incarnation lives. */
    std::optional<rant::Node> prov;
    std::optional<rant::Publisher<rant::Bytes>> gauge_pub;
    prov.emplace("plant2", peer_options);
    prov->on_event([](const rant::Event& event) {
        if (event.is_error()) std::printf("prov: %s\n", event.to_string().c_str());
    });
    CHECK(prov->valid());
    rant::Schema gauge_v1 = prov->schema("Gauge { value: f64, unit: string<8> }");
    CHECK(!gauge_v1.empty());
    if (!gauge_v1) return check::summary("mesh_test");
    gauge_pub = prov->publisher<rant::Bytes>("gauge", rant::Qos{rant::Reliability::Reliable}, gauge_v1);
    CHECK(gauge_pub->valid());

    /* ---- the adapter ---- */
    RantMeshOptions mesh_options;
    mesh_options.node_name = "hmi-under-test";
    mesh_options.domain = kDomain;
    mesh_options.interface_ip = kLoopback;
    mesh_options.seed_peers = {kLoopback};
    mesh_options.discovery_port = kDiscoveryPort;
    mesh_options.announce_interval_us = kAnnounceUs;
    mesh_options.verbose = true;
    RantMesh mesh(mesh_options);
    std::string err;
    CHECK_MSG(mesh.start(err), err);

    /* reflection settles once discovery + detail fetches land */
    const char* wanted[] = {"tank_level", "history", "belt", "status",   "purge",
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
                        static_cast<unsigned>(peer.reflection().peers().size()), found, kWanted);
            for (const EntityDef& entity : mesh.reflection())
                std::printf(" %c:%s", "VTFK"[static_cast<int>(entity.kind)],
                            entity.name.c_str());
            std::printf(" ]\n");
        }
    }
    CHECK_MSG(reflected, "reflection did not settle");

    /* THE PEER'S OWN SUBSCRIPTION STAYS REFLECTED while this node holds the handle it
       writes through. Consumption makes our subscriber (the publisher comes with the
       first publish) and the node folds our own records before the peers', so a
       topic the peer only consumes reads as "from us, nobody provides" the moment we
       hold it — which the leftover rule (an entity only this node consumes) must not
       swallow: the peer's subscriber is what made us hold the handle. Live, this was a
       recompile every 250 ms refusing "T:cage/gp12/jogCmd is not reflected" on the
       robot's jog command, on exactly the document that wrote it — and never on a
       blank one. One Button whose press publishes to `cmd` is the whole document. */
    {
        Json writer = {
            {"version", 1}, {"next_id", 1}, {"globals", Json::array()},
            {"pages", Json::array({Json{
                {"name", "Main"},
                {"children", Json::array({Json{
                    {"kind", "frame"}, {"type", "Button"}, {"name", "Send"},
                    {"flows", Json::array({Json{
                        {"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                        {"when_mode", "any"},
                        {"do", Json::array({steps::write_field("T", "cmd", "", "5.5")})}}})},
                }})}}})},
        };
        Document writer_doc;
        CHECK_MSG(writer_doc.adopt(std::move(writer), err), err);
        CompileResult writer_compiled = compile_document(writer_doc, mesh);
        CHECK(writer_compiled.ok);
        mesh.apply(writer_compiled.program, {});
        bool still = false;
        for (int i = 0; i < 20 && !still; ++i) {
            mesh.refresh();
            for (const EntityDef& entity : mesh.reflection())
                if (entity.kind == EntityKind::Topic && entity.name == "cmd") still = true;
            if (!still) std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        CHECK_MSG(still, "a topic the peer only consumes vanished from reflection once this "
                         "node held its subscriber for it");
    }

    const EntityDef* tank_def = nullptr;
    const EntityDef* status_def = nullptr;
    const EntityDef* hist_def = nullptr;
    const EntityDef* flag_def = nullptr;
    const EntityDef* purge_def = nullptr;
    for (const EntityDef& entity : mesh.reflection()) {
        if (entity.name == "tank_level") tank_def = &entity;
        if (entity.name == "status") status_def = &entity;
        if (entity.name == "history") hist_def = &entity;
        if (entity.name == "flag") flag_def = &entity;
        if (entity.name == "purge") purge_def = &entity;
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
    /* a task reflects its request as `fields` and its whole READ table as
     * `rsp_fields`: running, message, then the progress and response schemas under
     * their own roots */
    CHECK(purge_def && purge_def->kind == EntityKind::Task);
    if (purge_def) {
        CHECK(purge_def->cancellable);
        CHECK(purge_def->fields.size() == 1 && purge_def->fields[0].path == "target");
        CHECK(purge_def->rsp_fields.size() == 4);
        if (purge_def->rsp_fields.size() == 4) {
            CHECK(purge_def->rsp_fields[0].path == "running" &&
                  purge_def->rsp_fields[0].shape == Shape::Bool);
            CHECK(purge_def->rsp_fields[1].path == "message" &&
                  purge_def->rsp_fields[1].shape == Shape::Text);
            CHECK(purge_def->rsp_fields[2].path == "progress.pct" &&
                  purge_def->rsp_fields[2].shape == Shape::Num);
            CHECK(purge_def->rsp_fields[3].path == "result.done" &&
                  purge_def->rsp_fields[3].shape == Shape::Num);
        }
    }
    /* a bare-typed topic reflects as ONE anonymous field (path "") and no root name */
    CHECK(flag_def && flag_def->kind == EntityKind::Topic);
    if (flag_def) {
        CHECK(flag_def->type_name.empty());
        CHECK(flag_def->fields.size() == 1 && flag_def->fields[0].path.empty() &&
              flag_def->fields[0].shape == Shape::Bool);
    }

    /* ---- the document: slot expressions over every kind, flows back out ---- */
    Json level_instance = {
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
            /* press: a bare publish, plus a publish to a BARE-TYPED topic (the
             * anonymous value addressed by the empty path) */
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                 {"when_mode", "any"},
                 {"do", Json::array({
                     steps::write_field("T", "cmd", "", "5.5"),
                     steps::write_field("T", "flag", "", "true"),
                 })}},
        })},
    };
    Json label_instance = {
        {"kind", "frame"},
        {"type", "Button"},
        {"name", "Tag"},
        {"slots", Json{{"text", "@tank_level.label"}}},
    };
    Json speed_instance = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Speed"},
        {"slots", Json{{"value", "@belt.speed"}}},
    };
    Json temp_instance = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Temp"},
        /* a FUNCTION source: the response field reads like any other, the cadence
           rides the instance's poll map (spec D1) */
        {"slots", Json{{"value", "@status.temp"}}},
        {"poll", Json{{"value", 20}}},
    };
    /* the TASK instances: progress feeds a Readout, running a Toggle (bool), the
     * outcome message a Label, the result a Readout; a tap STARTS the task with its
     * request field and a press CANCELS the outstanding call */
    Json purge_instance = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Purge"},
        {"slots", Json{{"value", "@purge.progress.pct"}}},
        {"flows", Json::array({
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "any"},
                 {"do", Json::array({
                     steps::write_field("K", "purge", "target", "3"),
                 })}},
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                 {"when_mode", "any"},
                 {"do", Json::array({
                     Json{{"kind", "assign"}, {"mode", "cancel"},
                          {"from", Json{{"expr", "x"}}},
                          {"to", entity_ref("K", "purge")}},
                 })}},
        })},
    };
    Json purge_run_instance = {
        {"kind", "frame"},
        {"type", "Toggle"},
        {"name", "PurgeRun"},
        {"slots", Json{{"value", "@purge.running"}}},
    };
    Json purge_msg_instance = {
        {"kind", "frame"},
        {"type", "Button"},
        {"name", "PurgeMsg"},
        {"slots", Json{{"text", "@purge.message"}}},
    };
    Json purge_done_instance = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "PurgeDone"},
        {"slots", Json{{"value", "@purge.result.done"}}},
    };
    Json hist_instance = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Hist"},
        /* aggregate mesh fields read off the ENTITY MIRRORS: the delivery lands in a
           retained slot and the expression reduces it like any list or map */
        {"slots", Json{{"value", "@history.temps.Max()"},
                       {"decimals", "Num(@history.extras.Get(\"speed\"))"},
                       {"units", "@history.tags.Join(\"/\")"}}},
    };

    /* a BARE-TYPED topic: the anonymous value IS the entity, read bare */
    Json pressure_instance = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Pressure"},
        {"slots", Json{{"value", "@pressure"}}},
    };

    /* the toggle-off-the-plant idiom: read the value, gate on it, force / unforce.
     * Deliberately NO slot expression references `suction` anywhere in this document. */
    Json suction_instance = {
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

    Json gauge_instance = {
        {"kind", "frame"},
        {"type", "Readout"},
        {"name", "Gauge"},
        {"slots", Json{{"value", "@gauge.value"}}},
    };

    /* WRITE-ONLY: no expression anywhere reads @setpoint, so only the write in a
     * flow's signature gives it a standing accessor */
    Json setpoint_instance = {
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
                                    {"children", Json::array({level_instance, label_instance,
                                                              speed_instance, temp_instance,
                                                              purge_instance, hist_instance,
                                                              suction_instance,
                                                              pressure_instance,
                                                              gauge_instance,
                                                              setpoint_instance,
                                                              purge_run_instance,
                                                              purge_msg_instance,
                                                              purge_done_instance})}}})},
    };
    Document document;
    CHECK_MSG(document.adopt(std::move(root), err), err);

    CompileResult compiled = compile_document(document, mesh);
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
    const uint64_t purge_id = page["children"][4].value("id", 0);
    const uint64_t hist_id = page["children"][5].value("id", 0);
    const uint64_t pressure_id = page["children"][7].value("id", 0);
    const uint64_t purge_run_id = page["children"][10].value("id", 0);
    const uint64_t purge_msg_id = page["children"][11].value("id", 0);
    const uint64_t purge_done_id = page["children"][12].value("id", 0);

    Scheduler sched(std::move(compiled.program), mesh);
    mesh.apply(sched.program(), {});

    mesh.set_viewed_pages({page_id});

    /* ---- THE FIRST WRITE, immediately: the setpoint accessor was created by the
     * apply() a moment ago (a signature write is its only claim to one) and its owner
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
                const rant::detail::RantBytes data =
                    rant::detail::rant_bytes(bytes->data(), bytes->size());
                return rant::detail::rant_get_f64(data, set_schema.raw(), "target") == 5.5;
            },
            2000);
        CHECK_MSG(landed, "the FIRST write to a write-only variable never landed");
    }

    const int level_cell = cell_of(sched.program(), level_id, "value");
    const int label_cell = cell_of(sched.program(), label_id, "text");
    const int speed_cell = cell_of(sched.program(), speed_id, "value");
    const int temp_cell = cell_of(sched.program(), temp_id, "value");
    const int purge_pct_cell = cell_of(sched.program(), purge_id, "value");
    const int purge_run_cell = cell_of(sched.program(), purge_run_id, "value");
    const int purge_msg_cell = cell_of(sched.program(), purge_msg_id, "text");
    const int purge_done_cell = cell_of(sched.program(), purge_done_id, "value");
    CHECK(level_cell >= 0 && label_cell >= 0 && speed_cell >= 0 && temp_cell >= 0 &&
          purge_pct_cell >= 0 && purge_run_cell >= 0 && purge_msg_cell >= 0 &&
          purge_done_cell >= 0);

    /* variable state arrives without any new write (on_change replays at registration) */
    CHECK_MSG(run_until(sched, [&] { return num_at(sched, level_cell) == 42.5; }),
              "tank level never arrived");
    CHECK_MSG(run_until(sched, [&] { return text_at(sched, label_cell) == "ok"; }),
              "tank label never arrived");

    /* aggregate fields decode into list/map values and reduce through transforms */
    {
        const int hist_max = cell_of(sched.program(), hist_id, "value");
        const int hist_speed = cell_of(sched.program(), hist_id, "decimals");
        const int hist_tags = cell_of(sched.program(), hist_id, "units");
        CHECK(hist_max >= 0 && hist_speed >= 0 && hist_tags >= 0);
        CHECK_MSG(run_until(sched, [&] { return num_at(sched, hist_max) == 9.25; }),
                  "temps.Max() never arrived");
        CHECK_MSG(run_until(sched, [&] { return num_at(sched, hist_speed) == 5.0; }),
                  "extras.speed never arrived");
        CHECK_MSG(run_until(sched, [&] { return text_at(sched, hist_tags) == "hot/cold"; }),
                  "tags join never arrived");
    }

    /* a topic binding: publish from the peer until the cell shows it */
    {
        rant::MessageBuilder msg(belt_schema);
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
        rant::MessageBuilder msg(pressure_schema);
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

    /* effects: the tap flow RMW-writes the tank (label untouched), the press flow
     * publishes to the peer's subscriber */
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
                    const rant::detail::RantBytes data =
                        rant::detail::rant_bytes(bytes->data(), bytes->size());
                    return rant::detail::rant_get_f64(data, tank_schema.raw(), "level") ==
                           77.75;
                },
                200);
        }
        CHECK_MSG(written, "the variable write never landed");
        auto bytes = tank.get();
        CHECK(bytes.has_value());
        if (bytes) {
            const rant::detail::RantBytes data =
                rant::detail::rant_bytes(bytes->data(), bytes->size());
            CHECK_EQ(rant::detail::rant_get_f64(data, tank_schema.raw(), "level"), 77.75);
            const rant::detail::RantString label =
                rant::detail::rant_get_string(data, tank_schema.raw(), "label");
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
    }

    /* ---- THE TASK, end to end: a tap STARTS it (the request field rides the call),
     * `running` flips true off the RUNNING ack, a progress update lands in
     * `progress.pct`, and the terminal outcome fills `result.done` + `message` and
     * drops `running` — the whole read table, driven from the peer's pending call ---- */
    {
        bool started = false;
        for (int i = 0; i < 40 && !started; ++i) {
            sched.post(InputEvent{1, purge_id, "tap", Value::boolean(true), seq++});
            started = run_until(sched, [&] { return purge_calls.load() > 0; }, 200);
        }
        CHECK_MSG(started, "the task start never reached the peer");
        CHECK_EQ(purge_target.load(), 3);
        CHECK_MSG(run_until(sched, [&] { return bool_at(sched, purge_run_cell) == 1; }),
                  "running never flipped true");

        rant::MessageBuilder step(purge_p);
        step.set_f64("pct", 40.0);
        CHECK(step.ok());
        {
            std::lock_guard<std::mutex> hold(purge_mu);
            CHECK(purge_pending && purge_pending->valid());
            CHECK(purge_pending->progress(step.bytes()) == rant::SendStatus::Ok);
        }
        CHECK_MSG(run_until(sched, [&] { return num_at(sched, purge_pct_cell) == 40.0; }),
                  "the progress update never arrived");

        rant::MessageBuilder done(purge_r);
        done.set_uint("done", 1);
        CHECK(done.ok());
        {
            std::lock_guard<std::mutex> hold(purge_mu);
            CHECK(purge_pending->complete(done.bytes(), "swept") == rant::SendStatus::Ok);
        }
        CHECK_MSG(run_until(sched, [&] { return num_at(sched, purge_done_cell) == 1.0; }),
                  "the task result never arrived");
        CHECK_MSG(run_until(sched, [&] { return bool_at(sched, purge_run_cell) == 0; }),
                  "running never dropped after completion");
        CHECK_MSG(run_until(sched, [&] { return text_at(sched, purge_msg_cell) == "swept"; }),
                  "the outcome message never arrived");
    }

    /* ---- CANCEL: a second start, then the press flow's cancel; the peer honors it
     * and the caller's read table says cancelled honestly ---- */
    {
        const int had_calls = purge_calls.load();
        bool started = false;
        for (int i = 0; i < 40 && !started; ++i) {
            sched.post(InputEvent{1, purge_id, "tap", Value::boolean(true), seq++});
            started = run_until(sched, [&] { return purge_calls.load() > had_calls; }, 200);
        }
        CHECK_MSG(started, "the second task start never reached the peer");
        CHECK_MSG(run_until(sched, [&] { return bool_at(sched, purge_run_cell) == 1; }),
                  "running never flipped true on the second call");

        bool cancel_seen = false;
        for (int i = 0; i < 40 && !cancel_seen; ++i) {
            sched.post(InputEvent{1, purge_id, "press", Value::boolean(true), seq++});
            cancel_seen = run_until(
                sched,
                [&] {
                    std::lock_guard<std::mutex> hold(purge_mu);
                    return purge_pending && purge_pending->cancelled();
                },
                200);
        }
        CHECK_MSG(cancel_seen, "the cancel never reached the peer");
        {
            std::lock_guard<std::mutex> hold(purge_mu);
            CHECK(purge_pending->complete_cancelled("stopped") == rant::SendStatus::Ok);
        }
        CHECK_MSG(run_until(sched, [&] { return bool_at(sched, purge_run_cell) == 0; }),
                  "running never dropped after the cancel");
        CHECK_MSG(run_until(sched,
                            [&] { return text_at(sched, purge_msg_cell) == "stopped"; }),
                  "the cancelled outcome's message never arrived");
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

    /* the flow-read toggle: the gates only ever pass once the flow-signature
     * subscription fills the mirror, so a landed force IS the proof of consumption */
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
        rant::MessageBuilder v1_msg(gauge_v1);
        v1_msg.set_f64("value", 6.5).set_string("unit", "bar");
        CHECK(v1_msg.ok());
        bool seen = false;
        for (int i = 0; i < 80 && !seen; ++i) {
            gauge_pub->send(v1_msg.bytes());
            seen = run_until(sched, [&] { return num_at(sched, gauge_cell) == 6.5; }, 100);
        }
        CHECK_MSG(seen, "gauge v1 value never arrived");

        /* the provider restarts with a CHANGED schema (value survives, unit -> extra).
         * Same type NAME as v1 (a real retype keeps the name; the reader's subset
         * check is name based), compiled fresh in the new incarnation's own empty
         * registry, so there is no shape collision with the dead v1 incarnation's. */
        gauge_pub.reset();
        prov.reset();
        prov.emplace("plant2", peer_options);
        prov->on_event([](const rant::Event& event) {
            if (event.is_error()) std::printf("prov: %s\n", event.to_string().c_str());
        });
        CHECK(prov->valid());
        rant::Schema gauge_v2 = prov->schema("Gauge { value: f64, extra: u8 }");
        CHECK(!gauge_v2.empty());
        if (!gauge_v2) return check::summary("mesh_test");
        gauge_pub = prov->publisher<rant::Bytes>("gauge", rant::Qos{rant::Reliability::Reliable}, gauge_v2);
        CHECK(gauge_pub->valid());

        /* refresh at control-plane pace until the new type reflects with its fields */
        bool retyped = false;
        for (int i = 0; i < 100 && !retyped; ++i) {
            mesh.refresh();
            for (const EntityDef& entity : mesh.reflection())
                if (entity.name == "gauge" && entity.schema_hash == gauge_v2.hash() &&
                    entity.fields.size() == 2)
                    retyped = true;
            if (!retyped) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        CHECK_MSG(retyped, "the re-typed gauge never reflected");

        /* the app's hot-swap: recompile against the new reflection, re-apply */
        CompileResult swapped = compile_document(document, mesh);
        for (const Diag& diag : swapped.program.diagnostics)
            if (diag.grade == DiagGrade::Error)
                std::printf("recompile: [%s] %s\n", diag.code.c_str(), diag.message.c_str());
        CHECK(swapped.ok);
        if (!swapped.ok) return check::summary("mesh_test");
        Scheduler swapped_sched(std::move(swapped.program), mesh);
        mesh.apply(swapped_sched.program(), {});
        mesh.set_viewed_pages({page_id});

        const int swapped_cell = cell_of(swapped_sched.program(), gauge_id, "value");
        CHECK(swapped_cell >= 0);
        rant::MessageBuilder v2_msg(gauge_v2);
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

    /* ---- THE RESTART CYCLE, app-faithful: refresh at control-plane pace, and every
     * refresh that reports change RECOMPILES with state migration, exactly as
     * App::poll does. The restarting provider hosts ALL THREE pattern kinds — a
     * TOPIC (gauge), a VARIABLE read and written (dial), and a polled FUNCTION
     * (meter). A provider dying may kill ITS flows (honest diags) — nothing else.
     * Its RETURN — same-typed first, then retyped — must resume every feed, every
     * write and the beat flow, and values that survived the outage keep going. */
    {
        /* the trio's schemas live in whichever prov incarnation is hosting them: a
         * fresh, empty registry each restart, so retyping (a shape change under the
         * SAME type name) never collides with a shape a dead incarnation once held */
        std::optional<rant::Schema> gauge_schema, dial_schema;

        std::optional<rant::VariableDefinition<rant::Bytes>> dial_def;
        std::optional<rant::FunctionDefinition<rant::Bytes, rant::Bytes>> meter_def;
        double meter_reply = 21.5;
        auto host_plant2 = [&](const char* gauge_text, const char* dial_text,
                               double dial_setting, const char* meter_rsp_text) {
            prov.emplace("plant2", peer_options);
            prov->on_event([](const rant::Event& event) {
                if (event.is_error()) std::printf("prov: %s\n", event.to_string().c_str());
            });
            CHECK(prov->valid());
            gauge_schema.emplace(prov->schema(gauge_text));
            dial_schema.emplace(prov->schema(dial_text));
            gauge_pub = prov->publisher<rant::Bytes>(
                "gauge", rant::Qos{rant::Reliability::Reliable}, *gauge_schema);
            CHECK(gauge_pub->valid());
            rant::MessageBuilder seed(*dial_schema);
            seed.set_f64("setting", dial_setting);
            CHECK(seed.ok());
            rant::VariableOptions<rant::Bytes> dial_opts;
            dial_opts.initial = seed.bytes();
            dial_def = prov->variable_definition<rant::Bytes>("dial", dial_opts, *dial_schema);
            CHECK(dial_def->valid());
            rant::Schema meter_q = prov->schema("MeterQ { q: u8 }");
            rant::Schema meter_rsp = prov->schema(meter_rsp_text);
            meter_def = prov->function_definition<rant::Bytes, rant::Bytes>(
                "meter",
                [&meter_reply, meter_rsp](rant::Request<rant::Bytes>& request) {
                    rant::MessageBuilder reply(meter_rsp);
                    reply.set_f64("r", meter_reply);
                    request.reply(reply.bytes());
                },
                {}, meter_q, meter_rsp);
            CHECK(meter_def->valid());
        };
        auto kill_plant2 = [&] {
            meter_def.reset();
            dial_def.reset();
            gauge_pub.reset();
            prov.reset();
            gauge_schema.reset();
            dial_schema.reset();
        };

        /* the cycle's own document: gauge feed + beat flow into a global, dial feed +
         * tap write, polled meter feed, and a HEALTHY node's tank as the control */
        Json cy_gauge = {
            {"kind", "frame"},
            {"type", "Readout"},
            {"name", "CyGauge"},
            {"slots", Json{{"value", "@gauge.value"}}},
            {"flows", Json::array({
                Json{{"when", Json::array({steps::every(50)})},
                     {"when_mode", "any"},
                     {"do", Json::array({steps::set_var("hold", "@gauge.value")})}},
            })},
        };
        Json cy_dial = {
            {"kind", "frame"},
            {"type", "Readout"},
            {"name", "CyDial"},
            {"slots", Json{{"value", "@dial.setting"}}},
            {"flows", Json::array({
                Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                     {"when_mode", "any"},
                     {"do", Json::array({
                         steps::write_field("V", "dial", "setting", "33.5"),
                     })}},
            })},
        };
        Json cy_meter = {
            {"kind", "frame"},
            {"type", "Readout"},
            {"name", "CyMeter"},
            {"slots", Json{{"value", "@meter.r"}}},
            {"poll", Json{{"value", 20}}},
        };
        Json cy_tank = {
            {"kind", "frame"},
            {"type", "Readout"},
            {"name", "CyTank"},
            {"slots", Json{{"value", "@tank_level.level"}}},
        };
        Json cy_root = {
            {"version", 1},
            {"next_id", 1},
            {"globals",
             Json::array({Json{{"name", "hold"}, {"type", "Num"}, {"init", 0}}})},
            {"pages",
             Json::array({Json{{"name", "Cycle"},
                               {"children", Json::array({cy_gauge, cy_dial, cy_meter,
                                                         cy_tank})}}})},
        };
        Document cycle_doc;
        CHECK_MSG(cycle_doc.adopt(std::move(cy_root), err), err);
        const Json& cy_page = cycle_doc.root["pages"][0];
        const uint64_t cy_page_id = cy_page.value("id", 0);
        const uint64_t cy_gauge_id = cy_page["children"][0].value("id", 0);
        const uint64_t cy_dial_id = cy_page["children"][1].value("id", 0);
        const uint64_t cy_meter_id = cy_page["children"][2].value("id", 0);
        const uint64_t cy_tank_id = cy_page["children"][3].value("id", 0);

        std::unique_ptr<Scheduler> cur;
        auto recompile = [&] {
            CompileResult result = compile_document(cycle_doc, mesh);
            auto next = std::make_unique<Scheduler>(std::move(result.program), mesh);
            if (cur)
                next->state() =
                    migrate_state(cur->program(), cur->state(), next->program());
            cur = std::move(next);
            mesh.apply(cur->program(), {});
            mesh.set_viewed_pages({cy_page_id});
        };
        auto dump_faults = [&](const char* when) {
            const Host& state = cur->state();
            for (uint32_t i = 0;
                 i < state.out.faults.size() && i < cur->program().runtime_faults.size(); ++i)
                if (state.out.faults[i].count)
                    std::printf("cycle faults %s: %s (x%u)\n", when,
                                cur->program().runtime_faults[i].message.c_str(),
                                state.out.faults[i].count);
        };
        auto dump_diags = [&](const char* when) {
            for (const Diag& diag : cur->program().diagnostics)
                if (diag.grade == DiagGrade::Error)
                    std::printf("cycle diags %s: [%s] %s\n", when, diag.code.c_str(),
                                diag.message.c_str());
        };
        /* wait for one instance's cell to reach a value, refreshing/recompiling at
         * control-plane pace and pumping the publisher, exactly as the live app runs */
        auto wait_cell = [&](uint64_t instance, const char* slot, double want, int rounds,
                             std::function<void()> pump) {
            for (int i = 0; i < rounds; ++i) {
                if (mesh.refresh()) recompile();
                if (pump) pump();
                const int cell = cell_of(cur->program(), instance, slot);
                if (run_until(*cur, [&] { return num_at(*cur, cell) == want; }, 100))
                    return true;
            }
            return false;
        };
        auto wait_hold = [&](double want, int rounds) {
            for (int i = 0; i < rounds; ++i) {
                if (mesh.refresh()) recompile();
                const int cell = global_cell_of(cur->program(), "hold");
                if (run_until(*cur, [&] { return num_at(*cur, cell) == want; }, 100))
                    return true;
            }
            return false;
        };
        /* wait for the trio to reflect with the wanted shapes (hash for the topic,
         * field counts for the variable's value and the function's response) */
        auto reflect_trio = [&](uint64_t gauge_hash, size_t dial_fields,
                                size_t meter_rsp_fields) {
            for (int i = 0; i < 150; ++i) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
                if (mesh.refresh() && cur) recompile();
                bool gauge_ok = false, dial_ok = false, meter_ok = false;
                for (const EntityDef& entity : mesh.reflection()) {
                    if (entity.name == "gauge" && entity.schema_hash == gauge_hash)
                        gauge_ok = true;
                    if (entity.name == "dial" && entity.fields.size() == dial_fields)
                        dial_ok = true;
                    if (entity.name == "meter" &&
                        entity.rsp_fields.size() == meter_rsp_fields)
                        meter_ok = true;
                }
                if (gauge_ok && dial_ok && meter_ok) return true;
            }
            return false;
        };
        auto dial_setting_is = [&](const rant::Schema& schema, double want) {
            auto bytes = dial_def->get();
            if (!bytes) return false;
            const rant::detail::RantBytes data =
                rant::detail::rant_bytes(bytes->data(), bytes->size());
            return rant::detail::rant_get_f64(data, schema.raw(), "setting") == want;
        };
        uint64_t cy_seq = 1;
        /* tap the dial instance until its write lands at the owner (a human re-taps;
         * each round is one tap, not a blind retry of a dropped effect) */
        auto write_dial = [&](const rant::Schema& schema, int rounds) {
            for (int i = 0; i < rounds; ++i) {
                if (mesh.refresh()) recompile();
                cur->post(InputEvent{3, cy_dial_id, "tap", Value::number(0), cy_seq++});
                if (run_until(*cur, [&] { return dial_setting_is(schema, 33.5); }, 200))
                    return true;
            }
            return false;
        };

        /* plant2 restarts hosting the trio; the cycle doc compiles once they reflect */
        kill_plant2();
        host_plant2("Gauge { value: f64, extra: u8 }", "Dial { setting: f64 }", 7.5,
                    "MeterR { r: f64 }");
        CHECK_MSG(reflect_trio(gauge_schema->hash(), 1, 1), "cycle: the trio never reflected");
        recompile();
        dump_diags("at baseline");

        /* baseline: all three feed, the beat flow mirrors, the write lands */
        rant::MessageBuilder base_msg(*gauge_schema);
        base_msg.set_f64("value", 8.5).set_uint("extra", 1);
        CHECK(base_msg.ok());
        CHECK_MSG(wait_cell(cy_gauge_id, "value", 8.5, 80,
                            [&] { gauge_pub->send(base_msg.bytes()); }),
                  "cycle baseline: the gauge never fed");
        CHECK_MSG(wait_hold(8.5, 30), "cycle baseline: the beat flow never mirrored");
        CHECK_MSG(wait_cell(cy_dial_id, "value", 7.5, 80, {}),
                  "cycle baseline: the dial variable never fed");
        CHECK_MSG(wait_cell(cy_meter_id, "value", 21.5, 80, {}),
                  "cycle baseline: the meter poll never answered");
        CHECK_MSG(write_dial(*dial_schema, 40), "cycle baseline: the dial write never landed");
        dump_faults("at baseline");

        /* ---- the provider dies: entities leave, the refresh loop recompiles, its
         * flows die with honest diags — and NOTHING else breaks ---- */
        kill_plant2();
        bool vanished = false;
        for (int i = 0; i < 150 && !vanished; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (mesh.refresh()) recompile();
            vanished = true;
            for (const EntityDef& entity : mesh.reflection())
                if (entity.name == "gauge" || entity.name == "dial" ||
                    entity.name == "meter")
                    vanished = false;
        }
        CHECK_MSG(vanished, "cycle: the dead provider's entities never left reflection");
        dump_diags("while down");

        rant::MessageBuilder tank_new(tank_schema);
        tank_new.set_f64("level", 55.25).set_string("label", "up");
        CHECK(tank_new.ok());
        CHECK(tank.set(tank_new.bytes()) == rant::SendStatus::Ok);
        CHECK_MSG(wait_cell(cy_tank_id, "value", 55.25, 30, {}),
                  "cycle: a healthy entity stopped feeding while another node was down");
        CHECK_MSG(num_at(*cur, global_cell_of(cur->program(), "hold")) == 8.5,
                  "cycle: the global lost its value in the outage recompile");
        dump_faults("while down");

        /* ---- SAME-TYPED return: every feed, the poll, the beat flow and the write
         * resume with no help ---- */
        meter_reply = 22.75;
        host_plant2("Gauge { value: f64, extra: u8 }", "Dial { setting: f64 }", 12.25,
                    "MeterR { r: f64 }");
        CHECK_MSG(reflect_trio(gauge_schema->hash(), 1, 1),
                  "cycle: the same-typed return never reflected");
        dump_diags("after same-typed return");
        rant::MessageBuilder back_msg(*gauge_schema);
        back_msg.set_f64("value", 9.75).set_uint("extra", 2);
        CHECK(back_msg.ok());
        CHECK_MSG(wait_cell(cy_gauge_id, "value", 9.75, 80,
                            [&] { gauge_pub->send(back_msg.bytes()); }),
                  "cycle: the same-typed gauge never resumed");
        CHECK_MSG(wait_hold(9.75, 30),
                  "cycle: the beat flow never resumed after the same-typed return");
        CHECK_MSG(wait_cell(cy_dial_id, "value", 12.25, 80, {}),
                  "cycle: the same-typed dial variable never resumed");
        CHECK_MSG(wait_cell(cy_meter_id, "value", 22.75, 80, {}),
                  "cycle: the same-typed meter poll never resumed");
        CHECK_MSG(write_dial(*dial_schema, 40),
                  "cycle: the dial write never landed after the same-typed return");
        dump_faults("after same-typed return");

        /* ---- RETYPED return: every schema changes (the read fields survive by
         * name); the retype path must land through the same refresh loop ---- */
        kill_plant2();
        vanished = false;
        for (int i = 0; i < 150 && !vanished; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (mesh.refresh()) recompile();
            vanished = true;
            for (const EntityDef& entity : mesh.reflection())
                if (entity.name == "gauge" || entity.name == "dial" ||
                    entity.name == "meter")
                    vanished = false;
        }
        CHECK_MSG(vanished, "cycle: the provider never left before the retyped return");

        meter_reply = 64.25;
        host_plant2("Gauge { value: f64, mode: u16 }", "Dial { setting: f64, span: u8 }", 19.5,
                    "MeterR { r: f64, ok: bool }");
        CHECK_MSG(reflect_trio(gauge_schema->hash(), 2, 2),
                  "cycle: the retyped return never reflected");
        dump_diags("after retyped return");
        rant::MessageBuilder v3_msg(*gauge_schema);
        v3_msg.set_f64("value", 11.5).set_uint("mode", 2);
        CHECK(v3_msg.ok());
        CHECK_MSG(wait_cell(cy_gauge_id, "value", 11.5, 80,
                            [&] { gauge_pub->send(v3_msg.bytes()); }),
                  "cycle: the retyped gauge never resumed");
        CHECK_MSG(wait_hold(11.5, 30),
                  "cycle: the beat flow never resumed after the retyped return");
        CHECK_MSG(wait_cell(cy_dial_id, "value", 19.5, 80, {}),
                  "cycle: the retyped dial variable never resumed");
        CHECK_MSG(wait_cell(cy_meter_id, "value", 64.25, 80, {}),
                  "cycle: the retyped meter poll never resumed");
        CHECK_MSG(write_dial(*dial_schema, 40),
                  "cycle: the dial write never landed after the retyped return");
        dump_faults("after retyped return");
    }

    /* ---- the built-in @rant/log stream: a peer's log lines reach take_logs, decoded
     * with the publisher's name, the level and a comparable wall stamp ---- */
    {
        CHECK(peer.log(rant::LogLevel::Error, "boiler overtemp") == rant::SendStatus::Ok);
        CHECK(peer.log(rant::LogLevel::Info, "shift change") == rant::SendStatus::Ok);
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

#include "check.h"
#include "steps.h"
#include "compile/compiler.h"
#include "doc/doc.h"
#include "mesh/fake.h"
#include "compile/components.h"
#include "sched/scheduler.h"

#include <atomic>
#include <cstdlib>
#include <new>

static std::atomic<uint64_t> allocation_count{0};
static std::atomic<bool> allocation_trace{false};

void* operator new(std::size_t size) {
    allocation_count.fetch_add(1, std::memory_order_relaxed);
    if (allocation_trace.load(std::memory_order_relaxed))
        std::printf("  alloc %zu bytes\n", size);
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    allocation_count.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

using namespace hmi;

namespace {

Document timed_document() {
    Json button = {
        {"kind", "frame"},
        {"type", "Button"},
        {"slots", Json{{"text", "Run"}}},
        {"flows",
         Json::array({
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                  {"do", Json::array({Json{{"kind", "tmr_start"}, {"timer", "watchdog"}}})}},
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "release"}}})},
                  {"do", Json::array({Json{{"kind", "tmr_cancel"}, {"timer", "watchdog"}}})}},
             Json{{"when",
                   Json::array({Json{{"kind", "event"},
                                     {"name", "held"},
                                     {"hold_ms", 2},
                                     {"every_ms", 2}}})},
                  {"when_mode", "any"},
                  {"do",
                   Json::array({steps::set_var("count", "count + 100")})}},
             Json{{"when", Json::array({Json{{"kind", "timer"}, {"var", "watchdog"}}})},
                  {"do",
                   Json::array({steps::set_var("count", "count + 1000")})}},
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "any"},
                  {"do",
                   Json::array({
                       steps::guard("debounce", 2),
                       steps::set_var("count", "count + 5"),
                   })}},
         })},
    };
    Json root = {
        {"version", 1},
        {"next_id", 1},
        {"globals",
         Json::array({
             Json{{"name", "count"}, {"type", "num"}, {"init", 0}},
             Json{{"name", "watchdog"}, {"type", "timer"}, {"init", 0.005}},
         })},
        {"pages",
         Json::array({Json{{"name", "Main"}, {"children", Json::array({button})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    return document;
}

Document filter_document() {
    Json slider = {
        {"kind", "frame"},
        {"type", "Slider"},
        {"flows",
         Json::array({
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "input"}}})},
                  {"when_mode", "any"},
                  {"do",
                   Json::array({
                       Json{{"kind", "deadband"}, {"a", 5}},
                       steps::set_var("count", "count + 1"),
                   })}},
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "input"}}})},
                  {"when_mode", "any"},
                  {"do",
                   Json::array({
                       Json{{"kind", "throttle"}, {"a", 3}},
                       steps::set_var("count", "count + 10"),
                   })}},
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
                  {"when_mode", "any"},
                  {"do",
                   Json::array({
                       Json{{"kind", "delay"}, {"a", 2}},
                       steps::set_var("count", "count + 100"),
                   })}},
         })},
    };
    Json root = {
        {"version", 1},
        {"next_id", 1},
        {"globals", Json::array({Json{{"name", "count"}, {"type", "num"}, {"init", 0}}})},
        {"pages", Json::array({Json{{"name", "Main"}, {"children", Json::array({slider})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    return document;
}

Document first_document() {
    Json button = {
        {"kind", "frame"},
        {"type", "Button"},
        {"flows",
         Json::array({
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                  {"do", Json::array({Json{{"kind", "tmr_start"}, {"timer", "window"}}})}},
             Json{{"when",
                   Json::array({
                       Json{{"kind", "event"}, {"name", "release"}},
                       Json{{"kind", "timer"}, {"var", "window"}},
                   })},
                  {"when_mode", "first"},
                  {"do",
                   Json::array({
                       Json{{"kind", "tmr_cancel"}, {"timer", "window"}},
                       steps::set_var("count", "count + 1"),
                   })}},
         })},
    };
    Json root = {
        {"version", 1},
        {"next_id", 1},
        {"globals",
         Json::array({
             Json{{"name", "count"}, {"type", "num"}, {"init", 0}},
             Json{{"name", "window"}, {"type", "timer"}, {"init", 0.003}},
         })},
        {"pages", Json::array({Json{{"name", "Main"}, {"children", Json::array({button})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    return document;
}

uint32_t count_cell(const Program& program) {
    for (uint32_t i = 0; i < program.cells.size(); ++i)
        if (program.cells[i].name == "count") return i;
    return UINT32_MAX;
}

/* one named cell of one owner (0 = a global), by index; -1 when nothing declares it */
int cell_of(const Program& program, uint64_t owner, const std::string& name) {
    for (uint32_t i = 0; i < program.cells.size(); ++i)
        if (program.cells[i].owner_node == owner && program.cells[i].name == name)
            return static_cast<int>(i);
    return -1;
}

void tick(Scheduler& scheduler, uint32_t count) {
    std::string fault;
    for (uint32_t i = 0; i < count; ++i) CHECK_MSG(scheduler.tick(fault), fault);
}

void test_timing() {
    Document document = timed_document();
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    const uint32_t cell = count_cell(scheduler.program());
    std::string idle_fault;
    const uint64_t before_idle = allocation_count.load(std::memory_order_relaxed);
    allocation_trace = true;
    const bool idle_ok = scheduler.tick(idle_fault);
    allocation_trace = false;
    /* capture BEFORE any CHECK: reporting must never sit inside a counted window */
    const uint64_t after_idle = allocation_count.load(std::memory_order_relaxed);
    CHECK(idle_ok);
    CHECK(after_idle == before_idle);

    scheduler.post(InputEvent{1, instance, "press", Value::boolean(true), 1});
    tick(scheduler, 1);
    CHECK(scheduler.state().timers[0].running);
    tick(scheduler, 2);
    CHECK(scheduler.state().values[cell].data.num == 100);
    tick(scheduler, 3);
    CHECK(scheduler.state().values[cell].data.num == 1200);

    scheduler.post(InputEvent{1, instance, "release", Value::boolean(false), 2});
    tick(scheduler, 1);
    CHECK(!scheduler.state().timers[0].running);
    const double released = scheduler.state().values[cell].data.num;
    tick(scheduler, 8);
    CHECK(scheduler.state().values[cell].data.num == released);

    scheduler.post(InputEvent{1, instance, "tap", Value::boolean(true), 3});
    tick(scheduler, 1);
    scheduler.post(InputEvent{1, instance, "tap", Value::boolean(true), 4});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == released);
    tick(scheduler, 2);
    CHECK(scheduler.state().values[cell].data.num == released + 5);

    scheduler.post(InputEvent{2, instance, "press", Value::boolean(true), 1});
    tick(scheduler, 1);
    scheduler.release_session(2);
    tick(scheduler, 1);
    CHECK(!scheduler.state().timers[0].running);
}

void test_filters() {
    Document document = filter_document();
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, mesh);
    CHECK(compiled.ok);
    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    const uint32_t cell = count_cell(scheduler.program());

    scheduler.post(InputEvent{1, instance, "input", Value::number(0), 1});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 11);
    scheduler.post(InputEvent{1, instance, "input", Value::number(2), 2});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 11);
    tick(scheduler, 1);
    scheduler.post(InputEvent{1, instance, "input", Value::number(6), 3});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 22);

    scheduler.post(InputEvent{1, instance, "commit", Value::number(6), 4});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 22);
    tick(scheduler, 2);
    CHECK(scheduler.state().values[cell].data.num == 122);

    /* THE KEEP POLICY (stage 6d): a delay keeps the FIRST parked run and its wake —
       a second commit during the park simply ends, neither resetting the clock nor
       replacing the continuation (that cancellation is what debounce is). The +100
       lands exactly two ticks after the FIRST commit, and lands once. */
    scheduler.post(InputEvent{1, instance, "commit", Value::number(7), 5});
    tick(scheduler, 1);
    scheduler.post(InputEvent{1, instance, "commit", Value::number(8), 6});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 122);
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 222);
    tick(scheduler, 3);
    CHECK(scheduler.state().values[cell].data.num == 222);
}

void test_first_of_rearm() {
    Document document = first_document();
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, mesh);
    CHECK(compiled.ok);
    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    const uint32_t cell = count_cell(scheduler.program());

    scheduler.post(InputEvent{1, instance, "press", Value::boolean(true), 1});
    tick(scheduler, 1);
    scheduler.post(InputEvent{1, instance, "release", Value::boolean(false), 2});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 1);
    tick(scheduler, 5);
    CHECK(scheduler.state().values[cell].data.num == 1);

    scheduler.post(InputEvent{1, instance, "press", Value::boolean(true), 3});
    tick(scheduler, 1);
    tick(scheduler, 3);
    CHECK(scheduler.state().values[cell].data.num == 2);
    scheduler.post(InputEvent{1, instance, "release", Value::boolean(false), 4});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 2);

    scheduler.post(InputEvent{1, instance, "press", Value::boolean(true), 5});
    tick(scheduler, 1);
    scheduler.post(InputEvent{1, instance, "release", Value::boolean(false), 6});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 3);
}

/* THE SCHEDULER SPEAKS: a bound control's tap raises changed(value) from its behavior
 * (the local echo stands down per step — the slot's expression owns it), and the scheduler
 * drains the raise into the authored write-back within the same tick. The write-back
 * is the same sentence on every control: on changed, send value. */
void test_scheduler_speaks() {
    EntityDef sw;
    sw.kind = EntityKind::Variable;
    sw.name = "switch";
    sw.readable = true;
    sw.writable = true;
    sw.fields = {FieldDef{"on", Shape::Bool}};
    FakeMesh mesh({sw});

    Json toggle = {{"kind", "frame"}, {"type", "Toggle"},
                   /* the binding IS the slot's expression: value follows the mesh */
                   {"slots", Json{{"value", "@switch.on"}}},
                   {"flows",
                    Json::array({Json{
                        {"when", Json::array({Json{{"kind", "event"}, {"name", "changed"}}})},
                        {"when_mode", "first"},
                        {"do", Json::array({steps::write_field("V", "switch", "on",
                                                               "value")})}}})}};
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages",
                  Json::array({Json{{"name", "Main"}, {"children", Json::array({toggle})}}})}};
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    CompileResult compiled = compile_document(document, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    const uint64_t instance = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    const int slot_found = cell_of(scheduler.program(), instance, "value");
    if (!CHECK(slot_found >= 0)) return;
    const uint32_t slot = static_cast<uint32_t>(slot_found);

    mesh.push_update(EntityKind::Variable, "switch", {Value::boolean(false)});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[slot].data.boolean == false);

    /* the tap: the behavior's local echo stands down (the expression owns `value`) but the
       raise beside it still speaks — the SCHEDULER drains changed(true) into the
       authored write-back, all inside one tick */
    scheduler.post(InputEvent{1, instance, "press", Value::nil(), 1});
    scheduler.post(InputEvent{1, instance, "release", Value::nil(), 2});
    scheduler.post(InputEvent{1, instance, "tap", Value::nil(), 3});
    tick(scheduler, 1);
    CHECK(mesh.transcript().size() == 1);
    CHECK(mesh.transcript()[0] == "write V:switch.on=true");

    /* the machine's echo lands and the toggle shows true */
    mesh.push_update(EntityKind::Variable, "switch", {Value::boolean(true)});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[slot].data.boolean == true);

    /* the next tap proposes against the SHOWN value: changed(false) goes out */
    scheduler.post(InputEvent{1, instance, "press", Value::nil(), 4});
    scheduler.post(InputEvent{1, instance, "release", Value::nil(), 5});
    scheduler.post(InputEvent{1, instance, "tap", Value::nil(), 6});
    tick(scheduler, 1);
    CHECK(mesh.transcript().size() == 2);
    CHECK(mesh.transcript()[1] == "write V:switch.on=false");
}

/* HOLD-TO-TOGGLE: held() is a MOMENT — it carries nothing, and the flow reads the
 * state it flips. A press shorter than hold_ms commits nothing; the second hold reads
 * the state the first one left and flips it back. (The variable is `lit`, not `state`:
 * a slot expression spelling `state` names the VIEW's own input and goes per copy —
 * the placement rule, derived from the text on both tiers.) */
void test_held_nullary() {
    Json toggle = {{"kind", "frame"}, {"type", "Toggle"},
                   {"slots", Json{{"value", "lit"}}},
                   {"flows",
                    Json::array({Json{
                        {"when", Json::array({Json{{"kind", "event"},
                                                   {"name", "held"},
                                                   {"hold_ms", 5}}})},
                        {"when_mode", "first"},
                        {"do", Json::array({steps::set_var("lit", "!lit")})}}})}};
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals",
                  Json::array({Json{{"name", "lit"}, {"type", "bool"}, {"init", false}}})},
                 {"pages",
                  Json::array({Json{{"name", "Main"}, {"children", Json::array({toggle})}}})}};
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    const uint64_t instance = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    uint32_t state_cell = UINT32_MAX;
    for (uint32_t i = 0; i < scheduler.program().cells.size(); ++i)
        if (scheduler.program().cells[i].name == "lit") state_cell = i;
    CHECK(state_cell != UINT32_MAX);

    /* a press shorter than the hold commits nothing */
    scheduler.post(InputEvent{1, instance, "press", Value::boolean(true), 1});
    tick(scheduler, 2);
    scheduler.post(InputEvent{1, instance, "release", Value::boolean(false), 2});
    tick(scheduler, 8);
    CHECK(scheduler.state().values[state_cell].data.boolean == false);

    /* held past the threshold commits the press-time proposal (!false = true) */
    scheduler.post(InputEvent{1, instance, "press", Value::boolean(true), 3});
    tick(scheduler, 8);
    CHECK(scheduler.state().values[state_cell].data.boolean == true);
    scheduler.post(InputEvent{1, instance, "release", Value::boolean(false), 4});
    tick(scheduler, 1);

    /* the second hold proposes against the new shown value: it writes FALSE */
    scheduler.post(InputEvent{1, instance, "press", Value::boolean(true), 5});
    tick(scheduler, 8);
    CHECK(scheduler.state().values[state_cell].data.boolean == false);
}

/* TIMER FIELDS in expressions: `blink.running` / `.remaining` / `.duration` read the
 * timer table (in seconds), so a binding can color an instance off a running timer; the
 * computed bindings re-run every tick, so a readout tracks the countdown live. */
Json timer_read_root(const std::string& surface_xf) {
    Json button = {
        {"kind", "frame"},
        {"type", "Button"},
        {"slots", Json{{"text", "'Run'"}, {"surface", surface_xf}}},
        {"flows", Json::array({Json{
            {"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
            {"when_mode", "first"},
            {"do", Json::array({Json{{"kind", "tmr_start"}, {"timer", "blink"}}})}}})},
    };
    Json readout = {
        {"kind", "frame"},
        {"type", "Readout"},
        /* the timer reads by field, named directly — an element's slot nests under it */
        {"slots", Json{{"value", "blink.remaining * 1000"},
                       {"reading", Json{{"decimals", "blink.duration * 1000"},
                                        /* the fraction finished, 0..1, with no
                                           knowledge of the total time */
                                        {"text_size", "blink.progress"}}}}},
        {"flows", Json::array()},
    };
    /* the pressed-recently treatment (the old cased feed, now a ?: chain): the
       condition reads the timer's own field, the else is the resting color */
    Json toggle = {
        {"kind", "frame"},
        {"type", "Toggle"},
        {"slots", Json{{"pill",
                        Json{{"track_color", "blink.running ? #885a1f : #2e2e2e"}}}}},
        {"flows", Json::array()},
    };
    return Json{{"version", 1},
                {"next_id", 1},
                {"globals",
                 Json::array({Json{{"name", "blink"}, {"type", "timer"}, {"init", 0.004}}})},
                {"pages",
                 Json::array({Json{{"name", "Main"},
                                   {"children", Json::array({button, readout, toggle})}}})}};
}

void test_timer_reads() {
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(timer_read_root("blink.running.pick(#00ff00, #102030)"), error),
              error);
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    const uint64_t instance = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    const uint64_t readout_id =
        json_u64_or(document.root["pages"][0]["children"][1]["id"], 0);
    const uint64_t toggle_id =
        json_u64_or(document.root["pages"][0]["children"][2]["id"], 0);
    const uint32_t surface =
        static_cast<uint32_t>(cell_of(scheduler.program(), instance, "surface"));
    const uint32_t remaining =
        static_cast<uint32_t>(cell_of(scheduler.program(), readout_id, "value"));
    const uint32_t duration =
        static_cast<uint32_t>(cell_of(scheduler.program(), readout_id, "reading.decimals"));
    const uint32_t progress =
        static_cast<uint32_t>(cell_of(scheduler.program(), readout_id, "reading.text_size"));
    const uint32_t track_color =
        static_cast<uint32_t>(cell_of(scheduler.program(), toggle_id, "pill.track_color"));

    tick(scheduler, 1);
    CHECK(scheduler.state().values[surface].data.rgba == 0x102030ffu);
    CHECK(scheduler.state().values[remaining].data.num == 0);
    CHECK(scheduler.state().values[duration].data.num == 4);
    /* an idle timer's remaining is zero, so it reads as finished */
    CHECK(scheduler.state().values[progress].data.num == 1);
    CHECK(scheduler.state().values[track_color].data.rgba == 0x2e2e2effu);

    scheduler.post(InputEvent{1, instance, "press", Value::boolean(true), 1});
    tick(scheduler, 1);
    CHECK(scheduler.state().timers[0].running);
    CHECK(scheduler.state().values[surface].data.rgba == 0x00ff00ffu);
    CHECK(scheduler.state().values[track_color].data.rgba == 0x885a1fffu);
    const double started = scheduler.state().values[remaining].data.num;
    CHECK(started >= 3 && started <= 4);
    /* progress tracks remaining with no knowledge of the total */
    CHECK(scheduler.state().values[progress].data.num == 1.0 - started / 4.0);
    tick(scheduler, 2);
    CHECK(scheduler.state().values[remaining].data.num == started - 2);
    CHECK(scheduler.state().values[progress].data.num == 1.0 - (started - 2) / 4.0);

    tick(scheduler, 6);
    CHECK(!scheduler.state().timers[0].running);
    CHECK(scheduler.state().values[surface].data.rgba == 0x102030ffu);
    CHECK(scheduler.state().values[remaining].data.num == 0);
    CHECK(scheduler.state().values[progress].data.num == 1);
    CHECK(scheduler.state().values[track_color].data.rgba == 0x2e2e2effu);

    /* a BARE timer has no scalar to be, an unknown field is named, and x means
       nothing in a slot expression at all */
    auto refuses = [&](uint32_t instance_index, const char* slot, const std::string& xf,
                       const char* needle) {
        Json root = timer_read_root("blink.running.pick(#00ff00, #102030)");
        root["pages"][0]["children"][instance_index]["slots"][slot] = xf;
        Document bad;
        std::string adopt_error;
        CHECK_MSG(bad.adopt(std::move(root), adopt_error), adopt_error);
        CompileResult result = compile_document(bad, mesh);
        CHECK(!result.ok);
        bool found = false;
        for (const auto& diagnostic : result.program.diagnostics)
            if (diagnostic.message.find(needle) != std::string::npos) found = true;
        CHECK_MSG(found, "no diagnostic mentions '" + std::string(needle) + "'");
    };
    refuses(0, "surface", "blink.pick(#00ff00, #102030)", "unknown field");
    refuses(0, "surface", "blink == true", "is a timer");
    refuses(1, "value", "x * 2", "there is no x here");
    refuses(1, "value", "blink.expired * 2", "unknown field");

}

/* A FLOW that reads an entity (the read -> gate -> force/unforce toggle-off-the-plant
 * idiom): the read takes the last-value mirror, so the mirror must fill from arrivals
 * even though NO slot expression names the entity. The read rides the flow's
 * signature, so the mesh adapter subscribes it exactly like a bound one. */
void test_flow_entity_read() {
    Json button = {
        {"kind", "frame"},
        {"type", "Button"},
        {"slots", Json::object()},
        {"flows", Json::array({
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({
                     Json{{"kind", "assign"}, {"mode", "write"},
                          {"from", Json{{"expr", "@suction"}}},
                          {"to", Json{{"local", "current"}, {"path", ""}}}},
                     Json{{"kind", "gate"}, {"a", "current.value == false"}},
                     Json{{"kind", "assign"}, {"mode", "force"},
                          {"from", Json{{"expr", "true"}}},
                          {"to", Json{{"kind", "V"}, {"name", "suction"}, {"path", ""}}}},
                 })}},
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({
                     Json{{"kind", "assign"}, {"mode", "write"},
                          {"from", Json{{"expr", "@suction"}}},
                          {"to", Json{{"local", "current"}, {"path", ""}}}},
                     Json{{"kind", "gate"}, {"a", "current.value == true"}},
                     Json{{"kind", "assign"}, {"mode", "unforce"},
                          {"from", Json{{"expr", "x"}}},
                          {"to", Json{{"kind", "V"}, {"name", "suction"}, {"path", ""}}}},
                 })}},
        })},
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages",
                  Json::array({Json{{"name", "Main"}, {"children", Json::array({button})}}})}};
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);

    EntityDef suction;
    suction.kind = EntityKind::Variable;
    suction.name = "suction";
    suction.readable = true;
    suction.writable = true;
    suction.forceable = true;
    suction.fields = {FieldDef{"value", Shape::Bool}};
    EntityDef bystander = suction;
    bystander.name = "bystander";
    FakeMesh mesh({suction, bystander});
    CompileResult compiled = compile_document(document, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    /* the signature query the mesh adapter keys its subscriptions on: some flow
       reads the entity, and no flow touches the bystander */
    auto engaged = [&](uint32_t entity) {
        for (const FlowProgram& flow : compiled.program.flows)
            if (flow.body.sig.reads_entity(entity)) return true;
        return false;
    };
    CHECK(engaged(0));
    CHECK(!engaged(1));

    const uint64_t instance = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);

    /* before any arrival the mirror is unknown: both gates close, nothing sends */
    scheduler.post(InputEvent{1, instance, "tap", Value::boolean(true), 1});
    tick(scheduler, 1);
    CHECK(mesh.transcript().empty());

    /* the plant reports false: the tap forces true (and only that; no unforce) */
    mesh.push_update(EntityKind::Variable, "suction", {Value::boolean(false)});
    scheduler.post(InputEvent{1, instance, "tap", Value::boolean(true), 2});
    tick(scheduler, 1);
    CHECK(mesh.transcript().size() == 1);
    CHECK_MSG(mesh.transcript()[0] == "force V:suction.value=true", mesh.transcript()[0]);

    /* the forced value echoes back true: the next tap unforces */
    mesh.push_update(EntityKind::Variable, "suction", {Value::boolean(true)});
    scheduler.post(InputEvent{1, instance, "tap", Value::boolean(true), 3});
    tick(scheduler, 1);
    CHECK(mesh.transcript().size() == 2);
    CHECK_MSG(mesh.transcript()[1] == "unforce V:suction", mesh.transcript()[1]);
}

/* CADENCE FLOWS (the `every` trigger): a flow that runs on its own clock, with no event
 * behind it. This is what a history ring IS now — one append step at a cadence, bounded
 * by keep — so what used to be a privileged sampler is checked here as an ordinary flow:
 * it fires on its own ticks and no others, two of them run in document order, and once a
 * ring has reached its window every further append allocates nothing. */
void test_cadence_flows() {
    FakeMesh mesh({});
    Json button = {
        {"kind", "frame"},
        {"type", "Button"},
        {"flows",
         Json::array({
             Json{{"when", Json::array({steps::every(10)})},
                  {"do", Json::array({steps::append_var("fast", "level", "4")})}},
             Json{{"when", Json::array({steps::every(50)})},
                  {"do", Json::array({steps::append_var("slow", "level", "16")})}},
         })},
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals",
                  Json::array({
                      Json{{"name", "level"}, {"type", "num"}, {"init", 7.0}},
                      Json{{"name", "fast"}, {"type", "list"}},
                      Json{{"name", "slow"}, {"type", "list"}},
                  })},
                 {"pages",
                  Json::array({Json{{"name", "Main"},
                                    {"children", Json::array({button})}}})}};
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    CompileResult compiled = compile_document(document, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    /* document order, cadence carried on the flow itself */
    std::vector<uint32_t> cadences;
    for (const FlowProgram& flow : compiled.program.flows)
        if (flow.cadence_ticks) cadences.push_back(flow.cadence_ticks);
    CHECK(cadences.size() == 2);
    CHECK(cadences[0] == 10 && cadences[1] == 50);

    Scheduler scheduler(std::move(compiled.program), mesh);
    const int fast = cell_of(scheduler.program(), 0, "fast");
    const int slow = cell_of(scheduler.program(), 0, "slow");
    CHECK(fast >= 0 && slow >= 0);
    const uint32_t fast_slot = scheduler.program().cells[fast].list_slot;
    const uint32_t slow_slot = scheduler.program().cells[slow].list_slot;

    /* the first firing is at the seeding tick, then one per cadence: ticks 1, 11, 21 */
    tick(scheduler, 30);
    CHECK(scheduler.state().lists[fast_slot].total == 3);
    CHECK(scheduler.state().lists[slow_slot].total == 1);
    CHECK(scheduler.state().lists[fast_slot].count == 3);
    /* the appended value is what the cell held when the flow ran, not an event's x */
    const AggView view = scheduler.state().aggregate(scheduler.state().values[fast]);
    if (!CHECK(view.count == 3)) return;
    CHECK(view.data[0].data.num == 7.0);

    /* the keep window is a CEILING the ring settles at: past it, appends replace, and
       `total` keeps counting them (ticks 31..121 is ten more firings) */
    tick(scheduler, 100);
    CHECK(scheduler.state().lists[fast_slot].count == 4);
    CHECK(scheduler.state().lists[fast_slot].total == 13);

    /* STEADY STATE: with both rings at their window, a tick that appends allocates
       nothing — the slot's storage reached its working width and stays there */
    std::string fault;
    const uint64_t before = allocation_count.load(std::memory_order_relaxed);
    allocation_trace = true;
    for (int i = 0; i < 20; ++i) scheduler.tick(fault);
    allocation_trace = false;
    const uint64_t after = allocation_count.load(std::memory_order_relaxed);
    CHECK(scheduler.state().lists[fast_slot].total > 13);
    CHECK(after == before);
}

/* THE TREND, RE-AUTHORED: its own behavior flow samples the `value` slot into the
 * `history` list slot at 1000/rate ms, keeping rate x window of them. Nothing privileged
 * remains — the ring is a cell, the cadence is a flow, and an UNKNOWN value appends as
 * an honest gap rather than being skipped. */
void test_trend_samples() {
    EntityDef temp;
    temp.kind = EntityKind::Variable;
    temp.name = "temp";
    temp.readable = true;
    temp.fields = {FieldDef{"value", Shape::Num}};
    FakeMesh mesh({temp});

    Json trend = {{"kind", "frame"}, {"type", "Trend"},
                  {"slots", Json{{"rate", 100}, {"window", 1}, {"value", "@temp.value"}}},
                  {"flows", Json::array()}};
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages",
                  Json::array({Json{{"name", "Main"},
                                    {"children", Json::array({trend})}}})}};
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    CompileResult compiled = compile_document(document, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    /* 1000 / rate, folded at compile against the instance's own slot value */
    uint32_t cadence = 0;
    for (const FlowProgram& flow : compiled.program.flows)
        if (flow.cadence_ticks) cadence = flow.cadence_ticks;
    CHECK(cadence == 10);

    const uint64_t instance = json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    const int history = cell_of(scheduler.program(), instance, "history");
    if (!CHECK(history >= 0)) return;
    const uint32_t slot = scheduler.program().cells[history].list_slot;

    /* no arrival yet: the flow still runs, and it appends UNKNOWN — an honest gap */
    tick(scheduler, 25);
    CHECK(scheduler.state().lists[slot].total == 3);
    const AggView gaps = scheduler.state().aggregate(scheduler.state().values[history]);
    if (!CHECK(gaps.count == 3)) return;
    CHECK(gaps.data[0].tag == ValueTag::Nil);

    /* an arrival fills the value cell, and the next cadence tick appends it */
    mesh.push_update(EntityKind::Variable, "temp", {Value::number(42.5)});
    tick(scheduler, 11);
    const AggView after = scheduler.state().aggregate(scheduler.state().values[history]);
    if (!CHECK(after.count >= 4)) return;
    CHECK(after.data[after.count - 1].data.num == 42.5);

    /* rate x window is the keep: 100 samples, and the ring settles there */
    tick(scheduler, 1200);
    CHECK(scheduler.state().lists[slot].count == 100);
    CHECK(scheduler.state().lists[slot].total > 100);
}

/* ---- THE COPY RIDES THE EVENT (proto 17) ----
 *
 * A repeated element is ONE element with ONE set of cells, however many pictures the view
 * drew of it. So the copy is not runtime storage and there is nothing to look it up in:
 * it arrives with the gesture, stands on the state for that dispatch, and is what makes
 * `slots[repeat.index] = ...` write the copy the finger was actually on. */

InputEvent on_copy(uint64_t node, const char* event, uint64_t seq, uint32_t index,
                   uint32_t count) {
    InputEvent input;
    input.session = 1;
    input.node = node;
    input.event = event;
    input.sequence = seq;
    /* count 0 = the frame carried no `repeat` key at all: not inside a repeat */
    if (count) input.repeat = RepeatSeat{true, index, count};
    return input;
}

double element_at(const RuntimeState& state, int cell, uint32_t at) {
    const AggView view = state.aggregate(state.values[cell]);
    if (at >= view.count || view.data[at].tag != ValueTag::Num) return -1.0;
    return view.data[at].data.num;
}

Document repeat_document() {
    Json button = {
        {"kind", "frame"},
        {"type", "Button"},
        /* five pictures of this one element — the backend never counts them; the attr is
           the VIEW's instruction and is here only so the document is the real thing */
        {"attrs", Json{{"repeat", "5"}}},
        {"flows",
         Json::array({
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "any"},
                  {"do",
                   Json::array({
                       steps::set_var("mark", "repeat.fraction"),
                       steps::set_var("span", "repeat.count"),
                       steps::set_index("slots", "repeat.index", "100 + repeat.index"),
                   })}},
             Json{{"when", Json::array({Json{{"kind", "event"},
                                             {"name", "held"},
                                             {"hold_ms", 2}}})},
                  {"when_mode", "any"},
                  {"do", Json::array({steps::set_var("heldAt", "repeat.index")})}},
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "release"}}})},
                  {"when_mode", "any"},
                  {"do",
                   Json::array({
                       steps::guard("delay", 6),
                       steps::set_var("late", "repeat.index"),
                   })}},
         })},
    };
    Json root = {
        {"version", 1},
        {"next_id", 1},
        {"globals",
         Json::array({
             Json{{"name", "slots"}, {"type", "list"}, {"elem", "num"},
                  {"init", Json::array({0, 0, 0, 0, 0})}},
             Json{{"name", "mark"}, {"type", "num"}, {"init", 0}},
             Json{{"name", "span"}, {"type", "num"}, {"init", 0}},
             Json{{"name", "heldAt"}, {"type", "num"}, {"init", 0}},
             Json{{"name", "late"}, {"type", "num"}, {"init", 0}},
         })},
        {"pages",
         Json::array({Json{{"name", "Main"}, {"children", Json::array({button})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    return document;
}

void test_repeat_copy() {
    Document document = repeat_document();
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    const uint64_t instance =
        json_u64_or(document.root["pages"][0]["children"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    const Program& program = scheduler.program();
    const int slots = cell_of(program, 0, "slots");
    const int mark = cell_of(program, 0, "mark");
    const int span = cell_of(program, 0, "span");
    const int held_at = cell_of(program, 0, "heldAt");
    const int late = cell_of(program, 0, "late");
    if (!CHECK(slots >= 0 && mark >= 0 && span >= 0 && held_at >= 0 && late >= 0)) return;

    /* THE THIRD COPY OF FIVE: its own element moves and no other one does — which is the
       whole point, and the thing a single backend cell could never have expressed */
    scheduler.post(on_copy(instance, "tap", 1, 2, 5));
    tick(scheduler, 1);
    CHECK(element_at(scheduler.state(), slots, 2) == 102);
    CHECK(element_at(scheduler.state(), slots, 0) == 0);
    CHECK(element_at(scheduler.state(), slots, 4) == 0);
    /* the fraction is the view's own arithmetic asked from the other side: 0 at the
       first copy, 1 at the last */
    CHECK(scheduler.state().values[mark].data.num == 0.5);
    CHECK(scheduler.state().values[span].data.num == 5);

    scheduler.post(on_copy(instance, "tap", 2, 0, 5));
    tick(scheduler, 1);
    CHECK(element_at(scheduler.state(), slots, 0) == 100);
    CHECK(scheduler.state().values[mark].data.num == 0);

    scheduler.post(on_copy(instance, "tap", 3, 4, 5));
    tick(scheduler, 1);
    CHECK(element_at(scheduler.state(), slots, 4) == 104);
    CHECK(scheduler.state().values[mark].data.num == 1);
    /* three taps on three copies, three elements: nothing overwrote anything */
    CHECK(element_at(scheduler.state(), slots, 2) == 102);

    /* NO COPY BEHIND THE EVENT reads Nil, not a zero that would pass for the first copy,
       and the element write that needed an index FAULTS rather than landing somewhere */
    const uint32_t faults = scheduler.state().fault_count;
    scheduler.post(on_copy(instance, "tap", 4, 0, 0));
    tick(scheduler, 1);
    CHECK(scheduler.state().values[mark].tag == ValueTag::Nil);
    CHECK(scheduler.state().fault_count > faults);
    CHECK(element_at(scheduler.state(), slots, 0) == 100);

    /* A HELD FIRES LATER, BUT FIRES FOR THE COPY THE FINGER WENT DOWN ON — proved by
       tapping a DIFFERENT copy in the tick the hold comes due, which is dispatched first */
    scheduler.post(on_copy(instance, "press", 5, 3, 5));
    tick(scheduler, 1);
    scheduler.post(on_copy(instance, "tap", 6, 0, 5));
    tick(scheduler, 4);
    CHECK(scheduler.state().values[held_at].data.num == 3);

    /* AND A RUN THAT PARKS IN A DELAY WAKES AS ITS OWN COPY. The pending record carries
       the seat exactly as it carries the event parameter — so ANOTHER COPY IS TAPPED
       while this one sleeps, and the delayed write still lands on the copy that was
       released. Without that, the parked run would wake as whatever ran last. */
    scheduler.post(on_copy(instance, "release", 7, 1, 5));
    tick(scheduler, 1);
    CHECK(scheduler.state().values[late].data.num == 0);
    scheduler.post(on_copy(instance, "tap", 8, 4, 5));
    tick(scheduler, 1);
    CHECK(scheduler.state().values[late].data.num == 0);
    tick(scheduler, 8);
    CHECK(scheduler.state().values[late].data.num == 1);
}

/* A CADENCE HAS NO COPY, and the refusal says so at compile: `every` fires for the
 * ELEMENT, so reading Nil into an element write would fault a step away from the reason. */
void test_repeat_refused_without_an_event() {
    FakeMesh mesh;
    Json button = {
        {"kind", "frame"},
        {"type", "Button"},
        {"flows",
         Json::array({Json{{"when", Json::array({steps::every(50)})},
                           {"do", Json::array({steps::set_var("mark", "repeat.index")})}}})},
    };
    Json root = {
        {"version", 1},
        {"next_id", 1},
        {"globals", Json::array({Json{{"name", "mark"}, {"type", "num"}, {"init", 0}}})},
        {"pages",
         Json::array({Json{{"name", "Main"}, {"children", Json::array({button})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    CompileResult compiled = compile_document(document, mesh);
    CHECK(!compiled.ok);
    bool taught = false;
    for (const Diag& diag : compiled.program.diagnostics)
        if (diag.message.find("no copy behind an `every` trigger") != std::string::npos)
            taught = true;
    if (!CHECK(taught))
        for (const Diag& diag : compiled.program.diagnostics)
            std::printf("cadence repeat: [%s] %s\n", diag.code.c_str(),
                        diag.message.c_str());
}

} // namespace

int main() {
    test_timing();
    test_filters();
    test_first_of_rearm();
    test_scheduler_speaks();
    test_held_nullary();
    test_timer_reads();
    test_flow_entity_read();
    test_cadence_flows();
    test_trend_samples();
    test_repeat_copy();
    test_repeat_refused_without_an_event();
    return check::summary("scheduler_test");
}

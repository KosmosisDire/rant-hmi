#include "check.h"
#include "steps.h"
#include "compile/compiler.h"
#include "doc/doc.h"
#include "mesh/fake.h"
#include "registry/registry.h"
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
             Json{{"name", "count"}, {"type", "f64"}, {"init", 0}},
             Json{{"name", "watchdog"}, {"type", "timer"}, {"init", 0.005}},
         })},
        {"pages",
         Json::array({Json{{"name", "Main"}, {"widgets", Json::array({button})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    return document;
}

Document filter_document() {
    Json slider = {
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
        {"globals", Json::array({Json{{"name", "count"}, {"type", "f64"}, {"init", 0}}})},
        {"pages", Json::array({Json{{"name", "Main"}, {"widgets", Json::array({slider})}}})},
    };
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    return document;
}

Document first_document() {
    Json button = {
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
             Json{{"name", "count"}, {"type", "f64"}, {"init", 0}},
             Json{{"name", "window"}, {"type", "timer"}, {"init", 0.003}},
         })},
        {"pages", Json::array({Json{{"name", "Main"}, {"widgets", Json::array({button})}}})},
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

void tick(Scheduler& scheduler, uint32_t count) {
    std::string fault;
    for (uint32_t i = 0; i < count; ++i) CHECK_MSG(scheduler.tick(fault), fault);
}

void test_timing() {
    Document document = timed_document();
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    const uint64_t widget =
        json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
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

    scheduler.post(InputEvent{1, widget, "press", Value::boolean(true), 1});
    tick(scheduler, 1);
    CHECK(scheduler.state().timers[0].running);
    tick(scheduler, 2);
    CHECK(scheduler.state().values[cell].data.num == 100);
    tick(scheduler, 3);
    CHECK(scheduler.state().values[cell].data.num == 1200);

    scheduler.post(InputEvent{1, widget, "release", Value::boolean(false), 2});
    tick(scheduler, 1);
    CHECK(!scheduler.state().timers[0].running);
    const double released = scheduler.state().values[cell].data.num;
    tick(scheduler, 8);
    CHECK(scheduler.state().values[cell].data.num == released);

    scheduler.post(InputEvent{1, widget, "tap", Value::boolean(true), 3});
    tick(scheduler, 1);
    scheduler.post(InputEvent{1, widget, "tap", Value::boolean(true), 4});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == released);
    tick(scheduler, 2);
    CHECK(scheduler.state().values[cell].data.num == released + 5);

    scheduler.post(InputEvent{2, widget, "press", Value::boolean(true), 1});
    tick(scheduler, 1);
    scheduler.release_session(2);
    tick(scheduler, 1);
    CHECK(!scheduler.state().timers[0].running);
}

void test_filters() {
    Document document = filter_document();
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, registry(), mesh);
    CHECK(compiled.ok);
    const uint64_t widget =
        json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    const uint32_t cell = count_cell(scheduler.program());

    scheduler.post(InputEvent{1, widget, "input", Value::number(0), 1});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 11);
    scheduler.post(InputEvent{1, widget, "input", Value::number(2), 2});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 11);
    tick(scheduler, 1);
    scheduler.post(InputEvent{1, widget, "input", Value::number(6), 3});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 22);

    scheduler.post(InputEvent{1, widget, "commit", Value::number(6), 4});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 22);
    tick(scheduler, 2);
    CHECK(scheduler.state().values[cell].data.num == 122);
}

void test_first_of_rearm() {
    Document document = first_document();
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, registry(), mesh);
    CHECK(compiled.ok);
    const uint64_t widget =
        json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    const uint32_t cell = count_cell(scheduler.program());

    scheduler.post(InputEvent{1, widget, "press", Value::boolean(true), 1});
    tick(scheduler, 1);
    scheduler.post(InputEvent{1, widget, "release", Value::boolean(false), 2});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 1);
    tick(scheduler, 5);
    CHECK(scheduler.state().values[cell].data.num == 1);

    scheduler.post(InputEvent{1, widget, "press", Value::boolean(true), 3});
    tick(scheduler, 1);
    tick(scheduler, 3);
    CHECK(scheduler.state().values[cell].data.num == 2);
    scheduler.post(InputEvent{1, widget, "release", Value::boolean(false), 4});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 2);

    scheduler.post(InputEvent{1, widget, "press", Value::boolean(true), 5});
    tick(scheduler, 1);
    scheduler.post(InputEvent{1, widget, "release", Value::boolean(false), 6});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[cell].data.num == 3);
}

/* THE GESTURE PIN: x is evaluated once at pointer-down and reused by the whole
 * gesture. Without it, a press-authored flow commits `!value` to the plant, the
 * machine's echo lands before the finger lifts, and a release- or tap-authored flow
 * re-derives against the moved value and commits the OPPOSITE: one click, two
 * contradicting writes. Every event of the gesture must agree with the press. */
void test_gesture_pin() {
    EntityDef sw;
    sw.kind = EntityKind::Variable;
    sw.name = "switch";
    sw.readable = true;
    sw.writable = true;
    sw.fields = {FieldDef{"on", Shape::Bool}};
    FakeMesh mesh({sw});

    Json toggle = {{"type", "Toggle"},
                   {"slots", Json::object()},
                   {"feeds", Json::array({Json{{"slot", "value"},
                                               {"src", Json{{"kind", "V"}, {"name", "switch"}}},
                                               {"path", "on"},
                                               {"xf", ""}}})},
                   {"flows",
                    Json::array({Json{
                        {"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
                        {"when_mode", "first"},
                        {"do", Json::array({steps::write_field("V", "switch", "on", "x")})}}})}};
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages",
                  Json::array({Json{{"name", "Main"}, {"widgets", Json::array({toggle})}}})}};
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    CompileResult compiled = compile_document(document, registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    const uint64_t widget = json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    const uint32_t slot = scheduler.program().feeds[0].cell;

    mesh.push_update(EntityKind::Variable, "switch", {Value::boolean(false)});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[slot].data.boolean == false);

    /* pointer down: the press flow sends the proposal (true) to the machine */
    scheduler.post(InputEvent{1, widget, "press", Value::boolean(true), 1});
    tick(scheduler, 1);
    CHECK(mesh.transcript().size() == 1);
    CHECK(mesh.transcript()[0] == "write V:switch.on=true");

    /* the machine's echo lands MID-GESTURE: the toggle already shows true */
    mesh.push_update(EntityKind::Variable, "switch", {Value::boolean(true)});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[slot].data.boolean == true);

    /* pointer up: release then tap reuse the PINNED proposal (true), not a
       re-derivation against the moved value, so the shown value stands */
    scheduler.post(InputEvent{1, widget, "release", Value::boolean(false), 2});
    scheduler.post(InputEvent{1, widget, "tap", Value::boolean(true), 3});
    tick(scheduler, 1);
    CHECK(scheduler.state().values[slot].data.boolean == true);

    /* the NEXT click re-derives at its own pointer-down: the proposal flips */
    scheduler.post(InputEvent{1, widget, "press", Value::boolean(true), 4});
    tick(scheduler, 1);
    CHECK(mesh.transcript().size() == 2);
    CHECK(mesh.transcript()[1] == "write V:switch.on=false");
}

/* HOLD-TO-COMMIT: a Toggle whose only flow is on `held` (assign state = x), value fed
 * back from that variable. The held firing must carry the gesture's proposal, pinned
 * at pointer-down, never a bare `true`: the second hold has to write FALSE. */
void test_held_proposal() {
    Json toggle = {{"type", "Toggle"},
                   {"slots", Json::object()},
                   {"feeds", Json::array({Json{{"slot", "value"},
                                               {"src", Json{{"kind", "L"}, {"name", "state"}}},
                                               {"path", ""},
                                               {"xf", ""}}})},
                   {"flows",
                    Json::array({Json{
                        {"when", Json::array({Json{{"kind", "event"},
                                                   {"name", "held"},
                                                   {"hold_ms", 5}}})},
                        {"when_mode", "first"},
                        {"do", Json::array({steps::set_var("state", "x")})}}})}};
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals",
                  Json::array({Json{{"name", "state"}, {"type", "bool"}, {"init", false}}})},
                 {"pages",
                  Json::array({Json{{"name", "Main"}, {"widgets", Json::array({toggle})}}})}};
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    const uint64_t widget = json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    uint32_t state_cell = UINT32_MAX;
    for (uint32_t i = 0; i < scheduler.program().cells.size(); ++i)
        if (scheduler.program().cells[i].name == "state") state_cell = i;
    CHECK(state_cell != UINT32_MAX);

    /* a press shorter than the hold commits nothing */
    scheduler.post(InputEvent{1, widget, "press", Value::boolean(true), 1});
    tick(scheduler, 2);
    scheduler.post(InputEvent{1, widget, "release", Value::boolean(false), 2});
    tick(scheduler, 8);
    CHECK(scheduler.state().values[state_cell].data.boolean == false);

    /* held past the threshold commits the press-time proposal (!false = true) */
    scheduler.post(InputEvent{1, widget, "press", Value::boolean(true), 3});
    tick(scheduler, 8);
    CHECK(scheduler.state().values[state_cell].data.boolean == true);
    scheduler.post(InputEvent{1, widget, "release", Value::boolean(false), 4});
    tick(scheduler, 1);

    /* the second hold proposes against the new shown value: it writes FALSE */
    scheduler.post(InputEvent{1, widget, "press", Value::boolean(true), 5});
    tick(scheduler, 8);
    CHECK(scheduler.state().values[state_cell].data.boolean == false);
}

/* TIMER FIELDS in expressions: `blink.running` / `.remaining` / `.duration` read the
 * timer table (in seconds), so a binding can color a widget off a running timer; the
 * computed bindings re-run every tick, so a readout tracks the countdown live. */
Json timer_read_root(const std::string& surface_xf) {
    Json button = {
        {"type", "Button"},
        {"slots", Json{{"text", "Run"}}},
        {"feeds", Json::array({Json{{"slot", "surface"},
                                    {"src", Json{{"kind", "V"}, {"name", ""}}},
                                    {"path", ""},
                                    {"xf", surface_xf}}})},
        {"flows", Json::array({Json{
            {"when", Json::array({Json{{"kind", "event"}, {"name", "press"}}})},
            {"when_mode", "first"},
            {"do", Json::array({Json{{"kind", "tmr_start"}, {"timer", "blink"}}})}}})},
    };
    Json readout = {
        {"type", "Readout"},
        {"slots", Json::object()},
        /* the value feed's SOURCE is the timer itself: x is the timer, read by field */
        {"feeds", Json::array({Json{{"slot", "value"},
                                    {"src", Json{{"kind", "L"}, {"name", "blink"}}},
                                    {"path", ""},
                                    {"xf", "x.remaining * 1000"}},
                               Json{{"slot", "decimals"},
                                    {"src", Json{{"kind", "V"}, {"name", ""}}},
                                    {"path", ""},
                                    {"xf", "blink.duration * 1000"}},
                               /* the fraction finished, 0..1, with no knowledge of
                                  the total time */
                               Json{{"slot", "text_scale"},
                                    {"src", Json{{"kind", "V"}, {"name", ""}}},
                                    {"path", ""},
                                    {"xf", "blink.progress"}}})},
        {"flows", Json::array()},
    };
    /* the pressed-recently treatment (a CASED feed over the timer): the arm is a
       condition over x.running, the else the resting color; the Nil bail must not
       eat it (a timer cell's stored value is always Nil) */
    Json toggle = {
        {"type", "Toggle"},
        {"slots", Json::object()},
        {"feeds", Json::array({Json{{"slot", "track_color"},
                                    {"src", Json{{"kind", "L"}, {"name", "blink"}}},
                                    {"path", ""},
                                    {"cases", Json::array({Json{{"test", "x.running"},
                                                                {"xf", "#885a1f"}}})},
                                    {"xf", "#2e2e2e"}}})},
        {"flows", Json::array()},
    };
    return Json{{"version", 1},
                {"next_id", 1},
                {"globals",
                 Json::array({Json{{"name", "blink"}, {"type", "timer"}, {"init", 0.004}}})},
                {"pages",
                 Json::array({Json{{"name", "Main"},
                                   {"widgets", Json::array({button, readout, toggle})}}})}};
}

void test_timer_reads() {
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(timer_read_root("blink.running.pick(#00ff00, #102030)"), error),
              error);
    FakeMesh mesh;
    CompileResult compiled = compile_document(document, registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    const uint64_t widget = json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);
    const uint32_t surface = scheduler.program().feeds[0].cell;
    const uint32_t remaining = scheduler.program().feeds[1].cell;
    const uint32_t duration = scheduler.program().feeds[2].cell;
    const uint32_t progress = scheduler.program().feeds[3].cell;
    const uint32_t track_color = scheduler.program().feeds[4].cell;

    tick(scheduler, 1);
    CHECK(scheduler.state().values[surface].data.rgba == 0x102030ffu);
    CHECK(scheduler.state().values[remaining].data.num == 0);
    CHECK(scheduler.state().values[duration].data.num == 4);
    /* an idle timer's remaining is zero, so it reads as finished */
    CHECK(scheduler.state().values[progress].data.num == 1);
    CHECK(scheduler.state().values[track_color].data.rgba == 0x2e2e2effu);

    scheduler.post(InputEvent{1, widget, "press", Value::boolean(true), 1});
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

    /* a BARE timer (named or as x) has no scalar to be, and an unknown field is named */
    auto refuses = [&](uint32_t widget_index, const std::string& xf, const char* needle) {
        Json root = timer_read_root("blink.running.pick(#00ff00, #102030)");
        root["pages"][0]["widgets"][widget_index]["feeds"][0]["xf"] = xf;
        Document bad;
        std::string adopt_error;
        CHECK_MSG(bad.adopt(std::move(root), adopt_error), adopt_error);
        CompileResult result = compile_document(bad, registry(), mesh);
        CHECK(!result.ok);
        bool found = false;
        for (const auto& diagnostic : result.program.diagnostics)
            if (diagnostic.message.find(needle) != std::string::npos) found = true;
        CHECK_MSG(found, "no diagnostic mentions '" + std::string(needle) + "'");
    };
    refuses(0, "blink.pick(#00ff00, #102030)", "unknown field");
    refuses(0, "blink == true", "is a timer");
    refuses(1, "x * 2", "x is a timer");
    refuses(1, "x.expired * 2", "unknown field");

}

/* A FLOW that reads an entity (the read -> gate -> force/unforce toggle-off-the-plant
 * idiom): the read takes the last-value mirror, so the mirror must fill from arrivals
 * even though NO feed names the entity. The compiler stamps `flow_reads` so the mesh
 * adapter subscribes it exactly like a fed one. */
void test_flow_entity_read() {
    Json button = {
        {"type", "Button"},
        {"slots", Json::object()},
        {"flows", Json::array({
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({
                     Json{{"kind", "move"}, {"mode", "write"},
                          {"from", Json{{"kind", "V"}, {"name", "suction"}, {"path", ""}}},
                          {"to", Json{{"local", "current"}, {"path", ""}}}},
                     Json{{"kind", "gate"}, {"a", "current.value == false"}},
                     Json{{"kind", "move"}, {"mode", "force"},
                          {"from", Json{{"expr", "true"}}},
                          {"to", Json{{"kind", "V"}, {"name", "suction"}, {"path", ""}}}},
                 })}},
            Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                 {"when_mode", "first"},
                 {"do", Json::array({
                     Json{{"kind", "move"}, {"mode", "write"},
                          {"from", Json{{"kind", "V"}, {"name", "suction"}, {"path", ""}}},
                          {"to", Json{{"local", "current"}, {"path", ""}}}},
                     Json{{"kind", "gate"}, {"a", "current.value == true"}},
                     Json{{"kind", "move"}, {"mode", "unforce"},
                          {"from", Json{{"expr", "x"}}},
                          {"to", Json{{"kind", "V"}, {"name", "suction"}, {"path", ""}}}},
                 })}},
        })},
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages",
                  Json::array({Json{{"name", "Main"}, {"widgets", Json::array({button})}}})}};
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
    CompileResult compiled = compile_document(document, registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    /* the stamp the mesh adapter keys its subscriptions on: the read entity carries
       it, an unreferenced one does not */
    CHECK(compiled.program.entities[0].flow_reads);
    CHECK(!compiled.program.entities[1].flow_reads);

    const uint64_t widget = json_u64_or(document.root["pages"][0]["widgets"][0]["id"], 0);
    Scheduler scheduler(std::move(compiled.program), mesh);

    /* before any arrival the mirror is unknown: both gates close, nothing sends */
    scheduler.post(InputEvent{1, widget, "tap", Value::boolean(true), 1});
    tick(scheduler, 1);
    CHECK(mesh.transcript().empty());

    /* the plant reports false: the tap forces true (and only that; no unforce) */
    mesh.push_update(EntityKind::Variable, "suction", {Value::boolean(false)});
    scheduler.post(InputEvent{1, widget, "tap", Value::boolean(true), 2});
    tick(scheduler, 1);
    CHECK(mesh.transcript().size() == 1);
    CHECK_MSG(mesh.transcript()[0] == "force V:suction.value=true", mesh.transcript()[0]);

    /* the forced value echoes back true: the next tap unforces */
    mesh.push_update(EntityKind::Variable, "suction", {Value::boolean(true)});
    scheduler.post(InputEvent{1, widget, "tap", Value::boolean(true), 3});
    tick(scheduler, 1);
    CHECK(mesh.transcript().size() == 2);
    CHECK_MSG(mesh.transcript()[1] == "unforce V:suction", mesh.transcript()[1]);
}

/* TREND HISTORY (spec 2.9): a history-flagged slot samples into a backend ring at its
 * authored rate, viewed or not; a scalar and a list series both capture through the
 * feed's StoreHist tail; no arrival samples as NaN (an honest gap); a series-width
 * change resets the ring. */
void test_trend_history() {
    EntityDef temp;
    temp.kind = EntityKind::Variable;
    temp.name = "temp";
    temp.readable = true;
    temp.fields = {FieldDef{"value", Shape::Num}};
    EntityDef temps;
    temps.kind = EntityKind::Variable;
    temps.name = "temps";
    temps.readable = true;
    FieldDef vals;
    vals.path = "vals";
    vals.shape = Shape::List;
    vals.elem = Shape::Num;
    vals.bound = 4;
    temps.fields = {vals};
    FakeMesh mesh({temp, temps});

    auto trend = [](const char* source, const char* path) {
        return Json{{"type", "Trend"},
                    {"slots", Json{{"rate", 100}, {"window", 1}}},
                    {"feeds", Json::array({Json{{"slot", "value"},
                                                {"src", Json{{"kind", "V"}, {"name", source}}},
                                                {"path", path},
                                                {"xf", ""}}})},
                    {"flows", Json::array()}};
    };
    Json root = {{"version", 1},
                 {"next_id", 1},
                 {"globals", Json::array()},
                 {"pages",
                  Json::array({Json{{"name", "Main"},
                                    {"widgets", Json::array({trend("temp", ""),
                                                             trend("temps", "vals")})}}})}};
    Document document;
    std::string error;
    CHECK_MSG(document.adopt(std::move(root), error), error);
    CompileResult compiled = compile_document(document, registry(), mesh);
    CHECK_MSG(compiled.ok, compiled.program.diagnostics.empty()
                               ? "compile failed"
                               : compiled.program.diagnostics[0].message);
    CHECK(compiled.program.histories.size() == 2);
    CHECK(compiled.program.histories[0].rate_ticks == 10);
    CHECK(compiled.program.histories[0].capacity == 100);
    /* the feed's Store tail became StoreHist: nothing ever stores into the cell */
    bool rewired = false;
    for (const Instruction& ins : compiled.program.feeds[0].code)
        if (ins.op == OpCode::StoreHist) rewired = true;
    CHECK(rewired);

    Scheduler scheduler(std::move(compiled.program), mesh);
    auto newest = [&](uint32_t h) {
        const HistoryState& hist = scheduler.state().histories[h];
        const HistoryDef& def = scheduler.program().histories[h];
        return hist.data.data() +
               static_cast<size_t>((hist.head + hist.count - 1) % def.capacity) *
                   def.series_cap;
    };

    /* no arrival yet: the rate still ticks, and it samples UNKNOWN */
    tick(scheduler, 25);
    CHECK(scheduler.state().histories[0].count >= 2);
    CHECK(std::isnan(newest(0)[0]));

    /* a scalar arrival captures and the next rate tick commits it */
    mesh.push_update(EntityKind::Variable, "temp", {Value::number(42.5)});
    tick(scheduler, 11);
    CHECK(newest(0)[0] == 42.5f);

    /* a list arrival is a SERIES: one lane per element (the first wide sample already
       reset the ring away from the width-1 unknowns, so let a few accumulate) */
    mesh.push_update(EntityKind::Variable, "temps", {Value::list(0, 3, ValueTag::Num)});
    mesh.push_elems(0, {Value::number(1), Value::number(2), Value::number(3)});
    tick(scheduler, 35);
    CHECK(scheduler.state().histories[1].series == 3);
    CHECK(newest(1)[0] == 1.0f && newest(1)[1] == 2.0f && newest(1)[2] == 3.0f);

    /* a width change resets the ring rather than mixing sample shapes */
    const uint32_t before = scheduler.state().histories[1].count;
    CHECK(before > 1);
    mesh.push_update(EntityKind::Variable, "temps", {Value::list(0, 2, ValueTag::Num)});
    mesh.push_elems(0, {Value::number(7), Value::number(8)});
    tick(scheduler, 11);
    CHECK(scheduler.state().histories[1].series == 2);
    CHECK(scheduler.state().histories[1].count < before);
    CHECK(newest(1)[0] == 7.0f && newest(1)[1] == 8.0f);
}

} // namespace

int main() {
    test_timing();
    test_filters();
    test_first_of_rearm();
    test_gesture_pin();
    test_held_proposal();
    test_timer_reads();
    test_flow_entity_read();
    test_trend_history();
    return check::summary("scheduler_test");
}

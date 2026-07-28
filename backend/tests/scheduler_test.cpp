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

} // namespace

int main() {
    test_timing();
    test_filters();
    test_first_of_rearm();
    test_gesture_pin();
    test_held_proposal();
    return check::summary("scheduler_test");
}

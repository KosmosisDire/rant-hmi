#include "check.h"
#include "compile/compiler.h"
#include "doc/doc.h"
#include "mesh/fake.h"
#include "registry/registry.h"
#include "sched/scheduler.h"

#include <atomic>
#include <cstdlib>
#include <new>

static std::atomic<uint64_t> allocation_count{0};

void* operator new(std::size_t size) {
    allocation_count.fetch_add(1, std::memory_order_relaxed);
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
                   Json::array({Json{{"kind", "assign"},
                                     {"var", "count"},
                                     {"a", "count + 100"}}})}},
             Json{{"when", Json::array({Json{{"kind", "timer"}, {"var", "watchdog"}}})},
                  {"do",
                   Json::array({Json{{"kind", "assign"},
                                     {"var", "count"},
                                     {"a", "count + 1000"}}})}},
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "tap"}}})},
                  {"when_mode", "any"},
                  {"do",
                   Json::array({
                       Json{{"kind", "debounce"}, {"a", 2}},
                       Json{{"kind", "assign"}, {"var", "count"}, {"a", "count + 5"}},
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
                       Json{{"kind", "assign"}, {"var", "count"}, {"a", "count + 1"}},
                   })}},
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "input"}}})},
                  {"when_mode", "any"},
                  {"do",
                   Json::array({
                       Json{{"kind", "throttle"}, {"a", 3}},
                       Json{{"kind", "assign"}, {"var", "count"}, {"a", "count + 10"}},
                   })}},
             Json{{"when", Json::array({Json{{"kind", "event"}, {"name", "commit"}}})},
                  {"when_mode", "any"},
                  {"do",
                   Json::array({
                       Json{{"kind", "delay"}, {"a", 2}},
                       Json{{"kind", "assign"}, {"var", "count"}, {"a", "count + 100"}},
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
                       Json{{"kind", "assign"}, {"var", "count"}, {"a", "count + 1"}},
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
    const bool idle_ok = scheduler.tick(idle_fault);
    CHECK(idle_ok);
    CHECK(allocation_count.load(std::memory_order_relaxed) == before_idle);

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

} // namespace

int main() {
    test_timing();
    test_filters();
    test_first_of_rearm();
    return check::summary("scheduler_test");
}

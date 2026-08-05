#pragma once

#include "state.h"

#include <string>

namespace hmi {

struct RunResult {
    bool halted = false;
    bool faulted = false;
    bool suspended = false;
    uint32_t steps = 0;
};

/* Runs one flow with `arg` as the event's parameter (state.args[0], read by LoadArg
 * under the parameter's declared name). The pipeline register x starts Nil: an event is
 * a function call, and what it passed in arrives as a named parameter, never as x. */
RunResult run_flow(const Program& program, const FlowProgram& flow, RuntimeState& state,
                   Value arg) noexcept;

/* Does a flow listening on `flow_part` hear an event raised from `part`? An empty
 * flow_part is the widget-level channel: the root's own events plus every BUBBLING
 * armed part's. A named flow_part hears exactly that part (a component's behavior). */
bool part_reaches(const Program& program, uint64_t widget, const std::string& flow_part,
                  const std::string& part) noexcept;

/* every flow of `widget_id` triggered on `event` from `part`, in program order —
 * the test-facing single call; the scheduler's dispatch adds the queue semantics */
RunResult run_event(const Program& program, RuntimeState& state, uint64_t widget_id,
                    const std::string& event, Value arg,
                    const std::string& part = std::string()) noexcept;

RunResult run_feed(const Program& program, const FeedProgram& feed, RuntimeState& state,
                   Value source_value) noexcept;

RunResult resume_pending(const Program& program, RuntimeState& state,
                         uint32_t pending_slot) noexcept;

} // namespace hmi

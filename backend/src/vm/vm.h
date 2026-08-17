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

/* Runs one flow with `arg` as the event's parameter and `seat` as the repeat copy the
 * event arrived on — both seeded into the frame's argument slots, read by Arg (the
 * parameter under its declared name, the copy as repeat.index / .count / .fraction).
 * The pipeline register x starts Nil: an event is a function call, and what it passed
 * in arrives as a named parameter, never as x. */
RunResult run_flow(const Program& program, const FlowProgram& flow, RuntimeState& state,
                   Value arg, const RepeatSeat& seat = RepeatSeat{}) noexcept;

/* Does a flow listening on `flow_element` hear an event raised from `element`? An empty
 * flow_element is the instance-level channel: the root's own events plus every BUBBLING
 * armed element's. A named flow_element hears exactly that element (a component's
 * behavior). */
bool element_reaches(const Program& program, uint64_t node, const std::string& flow_element,
                     const std::string& element) noexcept;

/* every flow of `node_id` triggered on `event` from `element`, in program order —
 * the test-facing single call; the scheduler's dispatch adds the queue semantics */
RunResult run_event(const Program& program, RuntimeState& state, uint64_t node_id,
                    const std::string& event, Value arg,
                    const std::string& element = std::string()) noexcept;

/* one standing slot expression, re-evaluated into its cell; x is always Nil here */
RunResult run_slot(const Program& program, const SlotProgram& slot,
                   RuntimeState& state) noexcept;

RunResult resume_pending(const Program& program, RuntimeState& state,
                         uint32_t pending_slot) noexcept;

} // namespace hmi

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

RunResult run_flow(const Program& program, const FlowProgram& flow, RuntimeState& state,
                   Value event_value) noexcept;

RunResult run_event(const Program& program, RuntimeState& state, uint64_t widget_id,
                    const std::string& event, Value event_value) noexcept;

RunResult run_feed(const Program& program, const FeedProgram& feed, RuntimeState& state,
                   Value source_value) noexcept;

RunResult resume_pending(const Program& program, RuntimeState& state,
                         uint32_t pending_slot) noexcept;

} // namespace hmi

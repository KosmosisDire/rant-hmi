#include "scheduler.h"

#include <algorithm>

namespace hmi {

Scheduler::Scheduler(Program program, MeshPort& mesh)
    : program_(std::move(program)), state_(program_), mesh_(mesh) {
    inbound_.reserve(256);
    pressed_.reserve(64);
    holds_.reserve(std::max<size_t>(64, program_.flows.size() * 16));
    sequences_.reserve(64);
    ended_.reserve(program_.timers.size());
}

void Scheduler::post(InputEvent event) {
    if (accept_sequence(event.session, event.sequence))
        inbound_.push_back(std::move(event));
}

bool Scheduler::accept_sequence(uint64_t session, uint64_t sequence) {
    for (SessionSequence& row : sequences_) {
        if (row.session != session) continue;
        if (sequence <= row.sequence) return false;
        row.sequence = sequence;
        return true;
    }
    sequences_.push_back(SessionSequence{session, sequence});
    return true;
}

void Scheduler::run_one(uint32_t index, Value value) {
    if (index >= program_.flows.size()) return;
    const FlowProgram& flow = program_.flows[index];
    if (flow.first_only && flow.group < state_.fired.size() && state_.fired[flow.group])
        return;
    if (flow.first_only && flow.group < state_.fired.size()) state_.fired[flow.group] = 1;
    run_flow(program_, flow, state_, value);
}

void Scheduler::dispatch(uint64_t widget, const std::string& event, Value raw) {
    /* what the widget PROPOSES, derived once so every flow on this event sees the same x
     * (spec 2.3); the raw value stands where the type declares no derivation */
    const Value value = event_x(program_, state_, widget, event, raw);
    for (uint32_t i = 0; i < program_.flows.size(); ++i) {
        const FlowProgram& flow = program_.flows[i];
        if (flow.widget_id == widget && flow.event == event) run_one(i, value);
    }
}

void Scheduler::on_press(const InputEvent& event) {
    auto existing = std::find_if(pressed_.begin(), pressed_.end(), [&](const Pressed& row) {
        return row.session == event.session && row.widget == event.widget;
    });
    if (existing == pressed_.end())
        pressed_.push_back(Pressed{event.session, event.widget});
    holds_.erase(
        std::remove_if(holds_.begin(), holds_.end(), [&](const Hold& hold) {
            return hold.session == event.session &&
                   program_.flows[hold.flow].widget_id == event.widget;
        }),
        holds_.end());
    for (uint32_t i = 0; i < program_.flows.size(); ++i) {
        const FlowProgram& flow = program_.flows[i];
        if (flow.widget_id != event.widget || flow.event != "held") continue;
        holds_.push_back(
            Hold{event.session, i, state_.tick + flow.hold_ticks, flow.every_ticks});
    }
    dispatch(event.widget, "press", Value::boolean(true));
    dispatch(event.widget, "pressrelease", Value::boolean(true));
}

void Scheduler::on_release(const InputEvent& event) {
    pressed_.erase(
        std::remove_if(pressed_.begin(), pressed_.end(), [&](const Pressed& row) {
            return row.session == event.session && row.widget == event.widget;
        }),
        pressed_.end());
    holds_.erase(
        std::remove_if(holds_.begin(), holds_.end(), [&](const Hold& hold) {
            return hold.session == event.session &&
                   program_.flows[hold.flow].widget_id == event.widget;
        }),
        holds_.end());
    dispatch(event.widget, "release", Value::boolean(false));
    dispatch(event.widget, "pressrelease", Value::boolean(false));
}

void Scheduler::release_session(uint64_t session) {
    std::vector<uint64_t> widgets;
    for (const Pressed& row : pressed_)
        if (row.session == session) widgets.push_back(row.widget);
    uint64_t sequence = 1;
    for (const SessionSequence& row : sequences_)
        if (row.session == session) sequence = row.sequence + 1;
    for (uint64_t widget : widgets)
        post(InputEvent{session, widget, "release", Value::boolean(false), sequence++});
}

void Scheduler::apply_local_feeds() {
    for (const FeedProgram& feed : program_.feeds) {
        if (feed.source_cell == UINT32_MAX || feed.source_cell >= state_.values.size()) continue;
        run_feed(program_, feed, state_, state_.values[feed.source_cell]);
    }
}

bool Scheduler::tick(std::string& fault) {
    ++state_.tick;
    state_.clear_outputs();

    ended_.clear();
    for (uint32_t i = 0; i < state_.timers.size(); ++i) {
        TimerState& timer = state_.timers[i];
        if (!timer.running || timer.remaining == 0) continue;
        --timer.remaining;
        if (timer.remaining == 0) {
            timer.running = false;
            ended_.push_back(i);
        }
    }

    for (uint32_t i = 0; i < state_.pending.size(); ++i)
        if (state_.pending[i].active && state_.pending[i].wake_tick <= state_.tick)
            resume_pending(program_, state_, i);

    for (uint32_t timer : ended_) {
        const TimerDef& def = program_.timers[timer];
        for (uint32_t i = 0; i < program_.flows.size(); ++i)
            if (program_.flows[i].event == def.event) run_one(i, Value::nil());
    }

    for (const InputEvent& event : inbound_) {
        if (event.event == "press") on_press(event);
        else if (event.event == "release") on_release(event);
        else dispatch(event.widget, event.event, event.value);
    }
    inbound_.clear();

    for (size_t i = 0; i < holds_.size();) {
        Hold& hold = holds_[i];
        if (hold.next_tick > state_.tick) {
            ++i;
            continue;
        }
        run_one(hold.flow, Value::boolean(true));
        if (hold.repeat) {
            hold.next_tick += hold.repeat;
            ++i;
        } else {
            holds_.erase(holds_.begin() + static_cast<ptrdiff_t>(i));
        }
    }

    apply_local_feeds();
    return flush_effects(program_, state_, mesh_, fault);
}

} // namespace hmi

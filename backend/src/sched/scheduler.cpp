#include "scheduler.h"

#include <algorithm>
#include <chrono>

namespace hmi {

Scheduler::Scheduler(Program program, MeshPort& mesh)
    : program_(std::move(program)), state_(program_), mesh_(mesh) {
    inbound_.reserve(256);
    pressed_.reserve(64);
    holds_.reserve(std::max<size_t>(64, program_.flows.size() * 16));
    sequences_.reserve(64);
    ended_.reserve(program_.timers.size());
    cadence_next_.assign(program_.flows.size(), 0);
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
    drain_raised();
}

/* Dispatch every RAISED event the runs so far queued, in order, on the raising
 * instance's own channel. A raise during the drain appends to the same queue; the queue's
 * capacity (one slot per Raise instruction, never compacted mid-drain) is what bounds a
 * cascade — a raise loop fills it and the Raise op faults, it cannot spin. */
void Scheduler::drain_raised() {
    if (draining_) return;   /* the outermost run owns the drain */
    draining_ = true;
    for (uint32_t at = 0; at < state_.raised_count; ++at) {
        const RaisedRecord& record = state_.raised[at];
        if (record.def >= program_.raises.size()) continue;
        const RaiseDef& def = program_.raises[record.def];
        Value value = record.value;
        /* a text argument was copied into the record; home it into the input slot the
           way an InputEvent's text is, so the flows read it like any event payload */
        if (value.tag == ValueTag::Text && state_.input_scratch < state_.texts.size()) {
            state_.texts[state_.input_scratch].set(record.text.view());
            value = Value::text(state_.input_scratch);
        }
        for (uint32_t i = 0; i < program_.flows.size(); ++i) {
            const FlowProgram& flow = program_.flows[i];
            if (flow.node_id == def.node_id && flow.event == def.event &&
                flow.element.empty())
                run_one(i, value);
        }
    }
    state_.raised_count = 0;
    draining_ = false;
}

void Scheduler::dispatch(uint64_t node, const std::string& element,
                         const std::string& event, Value arg, RepeatSeat copy) {
    /* WHICH COPY, for the whole dispatch: every flow this event reaches runs as the copy
       that raised it, and so does anything they raise (drain_raised leaves it standing). */
    state_.repeat = copy;
    for (uint32_t i = 0; i < program_.flows.size(); ++i) {
        const FlowProgram& flow = program_.flows[i];
        if (flow.node_id != node || flow.event != event) continue;
        if (!element_reaches(program_, node, flow.element, element)) continue;
        run_one(i, arg);
    }
}

void Scheduler::on_press(const InputEvent& event) {
    auto existing = std::find_if(pressed_.begin(), pressed_.end(), [&](const Pressed& row) {
        return row.session == event.session && row.node == event.node &&
               row.element == event.element;
    });
    if (existing == pressed_.end())
        pressed_.push_back(
            Pressed{event.session, event.node, event.element, event.repeat});
    holds_.erase(
        std::remove_if(holds_.begin(), holds_.end(), [&](const Hold& hold) {
            return hold.session == event.session &&
                   program_.flows[hold.flow].node_id == event.node;
        }),
        holds_.end());
    for (uint32_t i = 0; i < program_.flows.size(); ++i) {
        const FlowProgram& flow = program_.flows[i];
        if (flow.node_id != event.node || flow.event != "held") continue;
        if (!element_reaches(program_, event.node, flow.element, event.element)) continue;
        holds_.push_back(Hold{event.session, i, state_.tick + flow.hold_ticks,
                              flow.every_ticks, event.repeat});
    }
    /* press() carries nothing — which edge fired IS the information; the down/up bool
       belongs to pressrelease alone */
    dispatch(event.node, event.element, "press", Value::nil(), event.repeat);
    dispatch(event.node, event.element, "pressrelease", Value::boolean(true),
             event.repeat);
}

void Scheduler::on_release(const InputEvent& event) {
    pressed_.erase(
        std::remove_if(pressed_.begin(), pressed_.end(), [&](const Pressed& row) {
            return row.session == event.session && row.node == event.node &&
                   row.element == event.element;
        }),
        pressed_.end());
    holds_.erase(
        std::remove_if(holds_.begin(), holds_.end(), [&](const Hold& hold) {
            return hold.session == event.session &&
                   program_.flows[hold.flow].node_id == event.node;
        }),
        holds_.end());
    dispatch(event.node, event.element, "release", Value::nil(), event.repeat);
    dispatch(event.node, event.element, "pressrelease", Value::boolean(false),
             event.repeat);
}

void Scheduler::release_session(uint64_t session) {
    std::vector<Pressed> down;
    for (const Pressed& row : pressed_)
        if (row.session == session) down.push_back(row);
    uint64_t sequence = 1;
    for (const SessionSequence& row : sequences_)
        if (row.session == session) sequence = row.sequence + 1;
    for (const Pressed& row : down) {
        InputEvent synth;
        synth.session = session;
        synth.node = row.node;
        synth.event = "release";
        synth.element = row.element;
        /* the copy the finger went down on: a view that disconnected mid-press releases
           the copy it pressed, not the element in general */
        synth.repeat = row.copy;
        synth.sequence = sequence++;
        post(std::move(synth));
    }
}

void Scheduler::apply_slot_programs() {
    for (const SlotProgram& slot : program_.slot_programs) {
        if (!slots_seeded_ && !slot.body.sig.every_tick) {
            /* the SEED: one evaluation at start, whatever the deps — a dep-less
               program (an array literal) lands its value here and never re-runs; a
               mesh-only one stores UNKNOWN, exactly what its cell already holds */
            run_slot(program_, slot, state_);
            continue;
        }
        if (!slot.body.sig.every_tick) continue;
        /* a cell-reading expression re-evaluates every tick, as the computed feeds
           always did: a cell can move any tick, and an unchanged store is free on the
           wire (scalars broadcast whole; an identical aggregate keeps its gen) */
        run_slot(program_, slot, state_);
    }
    slots_seeded_ = true;
}

void Scheduler::on_update(const MeshUpdate& update) {
    int entity = -1;
    for (uint32_t i = 0; i < program_.entities.size(); ++i)
        if (program_.entities[i].kind == update.kind && program_.entities[i].name == update.name) {
            entity = static_cast<int>(i);
            break;
        }
    if (entity < 0) return;
    const EntityDef& def = program_.entities[entity];
    const std::vector<FieldDef>& fields = feed_fields(def);
    const uint32_t count =
        std::min<uint32_t>(update.field_count, static_cast<uint32_t>(fields.size()));
    /* refresh the last-value cache (the seed-from-last / RMW base, and what LoadEnt
     * reads) from what actually arrived. Delivered text lands in its retained per-field
     * slot, so the cached value stays resolvable and re-sendable. A FUNCTION caches its
     * RESPONSE fields — `fields` is already the response table for one — because a slot
     * expression reads a polled response exactly as it reads a topic. */
    {
        auto& last = state_.last[entity];
        bool any = false;
        for (uint32_t i = 0; i < count && i < last.fields.size(); ++i) {
            Value value = update.fields[i];
            if (value.tag == ValueTag::Nil) continue;
            /* an AGGREGATE lands in its entity mirror — the retained slot behind the
             * cache's Value — so `@entity.<list field>` reads the last delivery the
             * way a scalar field reads the last value */
            if (value.tag == ValueTag::List || value.tag == ValueTag::Map) {
                if (i >= state_.entity_aggs[entity].size()) continue;
                const uint32_t mirror = state_.entity_aggs[entity][i];
                if (mirror == UINT32_MAX || !update.elems) continue;
                const MeshElems& source = update.elems[i];
                const bool pairs = value.tag == ValueTag::Map;
                uint32_t span = static_cast<uint32_t>(value.data.integer) *
                                (pairs ? 2u : 1u);
                span = std::min(span, source.count);
                const Value held = state_.hold_entity_agg(
                    mirror, source.data, source.texts, span, pairs,
                    list_elem_tag(value), fields[i].bound);
                if (held.tag == ValueTag::Nil) continue;
                last.fields[i] = held;
                any = true;
                continue;
            }
            if (value.tag == ValueTag::Enum) value.type_id = fields[i].type_id;
            if (value.tag == ValueTag::Text) {
                if (i >= state_.entity_texts[entity].size()) continue;
                const uint32_t slot = state_.entity_texts[entity][i];
                if (slot >= state_.texts.size()) continue;
                state_.texts[slot].set(update.texts[i]);
                value = Value::text(slot);
            }
            last.fields[i] = value;
            any = true;
        }
        if (any) last.known = true;
    }
    /* the mesh-only slot expressions re-evaluate on the deliveries they read; the
       every-tick ones read the refreshed cache on this same tick's pass anyway */
    for (const SlotProgram& slot : program_.slot_programs) {
        if (slot.body.sig.every_tick ||
            !slot.body.sig.reads_entity(static_cast<uint32_t>(entity)))
            continue;
        run_slot(program_, slot, state_);
    }
}

bool Scheduler::tick(std::string& fault) {
    ++state_.tick;
    /* one wall-clock sample per tick: everything this tick runs sees the same instant */
    if (!state_.wall_pinned)
        state_.wall_ms = static_cast<double>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch())
                .count());
    state_.clear_outputs();

    /* tick step 1: the mesh's arrivals, decoded, before anything time-driven runs */
    mesh_.drain(*this);

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

    /* THE CLOCK-DRIVEN RUNS CARRY NO COPY, and say so on the state: a timer and a
       cadence fire for the element, not for one of the pictures of it. `repeat` is
       refused at compile in these flows, so this only has to keep a stale seat from
       standing — a raise out of a cadence must not inherit the last press's copy. */
    for (uint32_t timer : ended_) {
        const TimerDef& def = program_.timers[timer];
        for (uint32_t i = 0; i < program_.flows.size(); ++i)
            if (program_.flows[i].event == def.event) {
                state_.repeat = RepeatSeat{};
                run_one(i, Value::nil());
            }
    }

    for (const InputEvent& event : inbound_) {
        if (event.event == "press") on_press(event);
        else if (event.event == "release") on_release(event);
        else {
            Value value = event.value;
            if (!event.text.empty() && state_.input_scratch < state_.texts.size()) {
                state_.texts[state_.input_scratch].set(event.text);
                value = Value::text(state_.input_scratch);
            }
            dispatch(event.node, event.element, event.event, value, event.repeat);
        }
    }
    inbound_.clear();

    for (size_t i = 0; i < holds_.size();) {
        Hold& hold = holds_[i];
        if (hold.next_tick > state_.tick) {
            ++i;
            continue;
        }
        /* held() is nullary — the firing IS the information; a flow reads the
           instance's own slots for values. The copy is the one the press landed on:
           a finger held down is still on the picture it went down on. */
        state_.repeat = hold.copy;
        run_one(hold.flow, Value::nil());
        if (hold.repeat) {
            hold.next_tick += hold.repeat;
            ++i;
        } else {
            holds_.erase(holds_.begin() + static_cast<ptrdiff_t>(i));
        }
    }

    apply_slot_programs();

    /* THE CADENCE PASS: every flow with an `every` trigger, on its own clock, viewed or
     * not — which is how a Trend has a past the moment a page opens now that its ring is
     * an ordinary list a flow appends to. Runs after the slot programs, so a sample lands
     * the same tick the value it reads arrived. Document order, because the flows vector
     * already is document order and two rings on one instance must not race.
     *
     * The catch-up clamp is what keeps a stalled tick from firing a burst: a cursor that
     * has fallen behind is pulled forward to the next tick rather than replaying the
     * cadences it missed. */
    for (uint32_t i = 0; i < program_.flows.size() && i < cadence_next_.size(); ++i) {
        const uint32_t cadence = program_.flows[i].cadence_ticks;
        if (!cadence) continue;
        uint64_t& next = cadence_next_[i];
        if (next == 0) next = state_.tick;
        if (state_.tick < next) continue;
        state_.repeat = RepeatSeat{};
        run_one(i, Value::nil());
        next += cadence;
        if (next <= state_.tick) next = state_.tick + 1;
    }

    return flush_effects(program_, state_, mesh_, fault);
}

} // namespace hmi

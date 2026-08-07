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
 * widget's own channel. A raise during the drain appends to the same queue; the queue's
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
            if (flow.widget_id == def.widget_id && flow.event == def.event &&
                flow.part.empty())
                run_one(i, value);
        }
    }
    state_.raised_count = 0;
    draining_ = false;
}

void Scheduler::dispatch(uint64_t widget, const std::string& part,
                         const std::string& event, Value arg) {
    state_.reset_scratch();
    for (uint32_t i = 0; i < program_.flows.size(); ++i) {
        const FlowProgram& flow = program_.flows[i];
        if (flow.widget_id != widget || flow.event != event) continue;
        if (!part_reaches(program_, widget, flow.part, part)) continue;
        run_one(i, arg);
    }
}

void Scheduler::on_press(const InputEvent& event) {
    auto existing = std::find_if(pressed_.begin(), pressed_.end(), [&](const Pressed& row) {
        return row.session == event.session && row.widget == event.widget &&
               row.part == event.part;
    });
    if (existing == pressed_.end())
        pressed_.push_back(Pressed{event.session, event.widget, event.part});
    holds_.erase(
        std::remove_if(holds_.begin(), holds_.end(), [&](const Hold& hold) {
            return hold.session == event.session &&
                   program_.flows[hold.flow].widget_id == event.widget;
        }),
        holds_.end());
    for (uint32_t i = 0; i < program_.flows.size(); ++i) {
        const FlowProgram& flow = program_.flows[i];
        if (flow.widget_id != event.widget || flow.event != "held") continue;
        if (!part_reaches(program_, event.widget, flow.part, event.part)) continue;
        holds_.push_back(
            Hold{event.session, i, state_.tick + flow.hold_ticks, flow.every_ticks});
    }
    /* press() carries nothing — which edge fired IS the information; the down/up bool
       belongs to pressrelease alone */
    dispatch(event.widget, event.part, "press", Value::nil());
    dispatch(event.widget, event.part, "pressrelease", Value::boolean(true));
}

void Scheduler::on_release(const InputEvent& event) {
    pressed_.erase(
        std::remove_if(pressed_.begin(), pressed_.end(), [&](const Pressed& row) {
            return row.session == event.session && row.widget == event.widget &&
                   row.part == event.part;
        }),
        pressed_.end());
    holds_.erase(
        std::remove_if(holds_.begin(), holds_.end(), [&](const Hold& hold) {
            return hold.session == event.session &&
                   program_.flows[hold.flow].widget_id == event.widget;
        }),
        holds_.end());
    dispatch(event.widget, event.part, "release", Value::nil());
    dispatch(event.widget, event.part, "pressrelease", Value::boolean(false));
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
        synth.widget = row.widget;
        synth.event = "release";
        synth.part = row.part;
        synth.sequence = sequence++;
        post(std::move(synth));
    }
}

void Scheduler::apply_slot_programs() {
    for (const SlotProgram& slot : program_.slot_programs) {
        if (!slots_seeded_ && !slot.every_tick) {
            /* the SEED: one evaluation at start, whatever the deps — a dep-less
               program (an array literal) lands its value here and never re-runs; a
               mesh-only one stores UNKNOWN, exactly what its cell already holds */
            state_.reset_scratch();
            run_slot(program_, slot, state_);
            continue;
        }
        if (!slot.every_tick) continue;
        /* a cell-reading expression re-evaluates every tick, as the computed feeds
           always did: a cell can move any tick, and an unchanged store is free on the
           wire (scalars broadcast whole; an identical aggregate keeps its gen) */
        state_.reset_scratch();
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
        if (slot.every_tick || !slot.depends_on(static_cast<uint32_t>(entity))) continue;
        state_.reset_scratch();
        run_slot(program_, slot, state_);
    }
}

bool Scheduler::tick(std::string& fault) {
    ++state_.tick;
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

    for (uint32_t timer : ended_) {
        const TimerDef& def = program_.timers[timer];
        for (uint32_t i = 0; i < program_.flows.size(); ++i)
            if (program_.flows[i].event == def.event) run_one(i, Value::nil());
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
            dispatch(event.widget, event.part, event.event, value);
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
           widget's own slots for values */
        state_.reset_scratch();
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
     * already is document order and two rings on one widget must not race.
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
        state_.reset_scratch();
        run_one(i, Value::nil());
        next += cadence;
        if (next <= state_.tick) next = state_.tick + 1;
    }

    return flush_effects(program_, state_, mesh_, fault);
}

} // namespace hmi

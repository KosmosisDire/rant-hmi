#include "scheduler.h"

#include <algorithm>

namespace hmi {

namespace {

/* does this (widget, event) declare a proposal? (the events table's `value`) */
bool declares_value(const Program& program, uint64_t widget, const std::string& event) {
    for (const EventValueProgram& source : program.event_values)
        if (source.widget_id == widget && source.event == event) return true;
    return false;
}

} // namespace

Scheduler::Scheduler(Program program, MeshPort& mesh)
    : program_(std::move(program)), state_(program_), mesh_(mesh) {
    inbound_.reserve(256);
    pressed_.reserve(64);
    holds_.reserve(std::max<size_t>(64, program_.flows.size() * 16));
    sequences_.reserve(64);
    pins_.reserve(64);
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

/* What the widget PROPOSES for this event, derived once so every flow on it sees the
 * same x (spec 2.3); the raw value stands where the type declares no derivation. A
 * gesture pin (set at pointer-down) overrides the derivation: the tap, release or held
 * that commits must commit the SAME x the press saw, even when the machine's echo
 * moved the shown value mid-gesture. */
Value Scheduler::proposed(uint64_t widget, const std::string& event, Value raw) {
    state_.reset_scratch();
    if (!declares_value(program_, widget, event)) return raw;
    const auto pin = std::find_if(pins_.begin(), pins_.end(), [&](const GesturePin& row) {
        return row.widget == widget;
    });
    if (pin != pins_.end()) return pin->x;
    return event_x(program_, state_, widget, event, raw);
}

void Scheduler::dispatch(uint64_t widget, const std::string& event, Value raw) {
    const Value value = proposed(widget, event, raw);
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
    /* pin the gesture's proposal at pointer-down; the release/tap that follow (tap
       arrives after release, from the view) reuse it instead of re-deriving against a
       shown value the machine may have moved mid-gesture. The pin lives until this
       widget's next press, so the late tap still finds it. */
    pins_.erase(std::remove_if(pins_.begin(), pins_.end(), [&](const GesturePin& row) {
                    return row.widget == event.widget;
                }),
                pins_.end());
    if (declares_value(program_, event.widget, "press")) {
        state_.reset_scratch();
        pins_.push_back(GesturePin{
            event.widget,
            event_x(program_, state_, event.widget, "press", Value::boolean(true))});
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
        if (feed.source_cell != UINT32_MAX && feed.source_cell < state_.values.size()) {
            state_.reset_scratch();
            run_feed(program_, feed, state_, state_.values[feed.source_cell]);
        } else if (feed.source_cell == UINT32_MAX && feed.entity == UINT32_MAX) {
            /* a COMPUTED binding (no source): the expression alone, every tick */
            state_.reset_scratch();
            run_feed(program_, feed, state_, Value::nil());
        }
    }
}

Value Scheduler::intake_aggregate(const MeshUpdate& update, uint32_t field,
                                  const FieldDef& def) {
    if (!update.elems || !update.elems[field].data) return Value::nil();
    const MeshElems& source = update.elems[field];
    const Value& head = update.fields[field];
    const bool is_map = head.tag == ValueTag::Map;
    const uint32_t width = is_map ? 2 : 1;
    const uint32_t limit = def.bound ? def.bound : kVarrCeiling;
    uint32_t count = static_cast<uint32_t>(head.data.integer);
    count = std::min(count, source.count / width);
    count = std::min(count, limit);   /* the ceiling: truncate, never overrun */
    const uint32_t need = count * width;
    const uint32_t offset = state_.alloc_elems(need);
    if (offset == UINT32_MAX) return Value::nil();
    for (uint32_t k = 0; k < need; ++k) {
        Value element = source.data[k];
        if (element.tag == ValueTag::Text) {
            const uint32_t slot = state_.alloc_elem_text();
            if (slot == UINT32_MAX) return Value::nil();
            state_.texts[slot].set(source.texts ? source.texts[k] : std::string_view{});
            element = Value::text(slot);
        }
        state_.elems[offset + k] = element;
    }
    return is_map ? Value::map(offset, count)
                  : Value::list(offset, count, static_cast<ValueTag>(head.flags));
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
    /* refresh the last-value cache (the seed-from-last / RMW base) from what actually
     * arrived. Delivered text lands in its retained per-field slot, so the cached value
     * stays resolvable and re-sendable. Functions stay out: their `fields` are the
     * request side, not what arrived. */
    const bool cache = def.kind != EntityKind::Function;
    if (cache) {
        auto& last = state_.last[entity];
        bool any = false;
        for (uint32_t i = 0; i < count && i < last.fields.size(); ++i) {
            Value value = update.fields[i];
            if (value.tag == ValueTag::Nil) continue;
            /* aggregates stay out of the last-value cache: their elements live in the
             * per-run scratch pool, and the wire side never builds them anyway */
            if (value.tag == ValueTag::List || value.tag == ValueTag::Map) continue;
            if (value.tag == ValueTag::Enum) value.type_id = fields[i].type_id;
            if (value.tag == ValueTag::Text) {
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
    for (const FeedProgram& feed : program_.feeds) {
        if (feed.source_cell != UINT32_MAX || feed.entity != static_cast<uint32_t>(entity))
            continue;
        if (feed.field >= count) continue;
        state_.reset_scratch();
        Value x = update.fields[feed.field];
        if (x.tag == ValueTag::Enum) x.type_id = fields[feed.field].type_id;
        if (x.tag == ValueTag::List || x.tag == ValueTag::Map)
            x = intake_aggregate(update, feed.field, fields[feed.field]);
        if (x.tag == ValueTag::Text) {
            /* cached entities already hold the text in its retained slot; a function
             * response rides the one scratch slot, consumed by this run alone */
            uint32_t slot = cache && feed.field < state_.entity_texts[entity].size()
                                ? state_.entity_texts[entity][feed.field]
                                : state_.mesh_scratch;
            if (slot >= state_.texts.size()) continue;
            if (!cache || slot == state_.mesh_scratch)
                state_.texts[slot].set(update.texts[feed.field]);
            x = Value::text(slot);
        }
        run_feed(program_, feed, state_, x);
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
            dispatch(event.widget, event.event, value);
        }
    }
    inbound_.clear();

    for (size_t i = 0; i < holds_.size();) {
        Hold& hold = holds_[i];
        if (hold.next_tick > state_.tick) {
            ++i;
            continue;
        }
        /* a held firing carries the gesture's proposal like any other event of it (the
           pin from its pointer-down), never a bare `true`: a hold-to-commit Toggle
           must see the value it is trying to set */
        run_one(hold.flow,
                proposed(program_.flows[hold.flow].widget_id, "held", Value::boolean(true)));
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

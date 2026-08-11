#include "port.h"

namespace hmi {

/* Fold one flushed write into the entity's last-value mirror, so the NEXT tick's
 * reads see it without waiting for the owner's echo. This runs at flush, not at emit
 * (the PLC-scan rule): every flow in the tick that produced the effect read the
 * tick-start snapshot. Delivered text is re-homed into the entity's retained slot,
 * exactly as an arrival is (Scheduler::on_update); aggregates stay out. */
static void mirror_write(RuntimeState& state, const EffectRecord& record) noexcept {
    if (record.verb == Verb::Unforce || record.entity >= state.last.size()) return;
    LastValueState& last = state.last[record.entity];
    auto rehome = [&](Value value, std::string_view text, uint32_t field) -> Value {
        if (value.tag != ValueTag::Text || record.entity >= state.entity_texts.size())
            return value;
        const auto& slots = state.entity_texts[record.entity];
        if (field >= slots.size() || slots[field] >= state.texts.size()) return value;
        state.texts[slots[field]].set(text);
        return Value::text(slots[field]);
    };
    if (record.bare) {
        if (record.field >= last.fields.size()) return;
        /* an ELEMENT write lands in the entity's aggregate MIRROR, in place, so the
           next tick reads its own write exactly as it does a scalar's. A mirror that
           is empty or shorter than the index just skips — the owner's next delivery
           is the truth either way, and the encode side bounds the real write. */
        if (record.elem_index != UINT32_MAX) {
            if (record.field >= state.entity_aggs[record.entity].size()) return;
            const uint32_t mirror = state.entity_aggs[record.entity][record.field];
            if (mirror == UINT32_MAX || mirror >= state.lists.size()) return;
            ListState& held = state.lists[mirror];
            if (record.elem_index >= held.count) return;
            Value element = record.value;
            if (element.tag == ValueTag::Text) {
                const uint32_t slot = state.list_text(held, record.elem_index);
                if (slot == UINT32_MAX) return;
                state.texts[slot].set(record.bare_text.view());
                element = Value::text(slot);
            }
            held.elems[record.elem_index] = element;
            ++held.gen;
            return;
        }
        /* a whole-aggregate field write reached the mirror via mirror_agg — the
           record's handle must never land here, it references the record's own copy */
        if (record.value.tag == ValueTag::List || record.value.tag == ValueTag::Map)
            return;
        last.fields[record.field] =
            rehome(record.value, record.bare_text.view(), record.field);
        last.known = true;
        return;
    }
    for (uint32_t f = 0; f < last.fields.size(); ++f) {
        const Value value = f < record.fields.size() ? record.fields[f] : Value::nil();
        /* aggregate fields mirrored via mirror_agg; the retained-mirror handle it
           set must survive this scalar sweep */
        if (value.tag == ValueTag::List || value.tag == ValueTag::Map) continue;
        last.fields[f] = rehome(value,
                                f < record.field_text.size() ? record.field_text[f].view()
                                                             : std::string_view{},
                                f);
    }
    last.known = true;
}

/* Fold a flushed AGGREGATE into the entity's retained mirror, so the next tick's
 * reads see it: the record's deep-copied elements land in the mirror slot exactly as
 * a delivery's would (hold_entity_agg re-homes text and sorts a map's pairs). The
 * mirror tables are the READ side's, so only V and T — whose value and feed tables
 * are the same table — take one. */
static void mirror_agg(const Program& program, RuntimeState& state,
                       const EffectRecord& record, uint32_t field,
                       const MeshElems& span) noexcept {
    const EntityDef& entity = program.entities[record.entity];
    if (entity.kind != EntityKind::Variable && entity.kind != EntityKind::Topic) return;
    if (record.entity >= state.entity_aggs.size() ||
        field >= state.entity_aggs[record.entity].size())
        return;
    const uint32_t mirror = state.entity_aggs[record.entity][field];
    if (mirror == UINT32_MAX) return;
    if (field >= entity.fields.size()) return;
    const FieldDef& def = entity.fields[field];
    const bool pairs = def.shape == Shape::Map;
    const ValueTag elem = def.elem == Shape::Num    ? ValueTag::Num
                          : def.elem == Shape::Bool ? ValueTag::Bool
                          : def.elem == Shape::Text ? ValueTag::Text
                                                    : ValueTag::Nil;
    const Value held = state.hold_entity_agg(mirror, span.data, span.texts, span.count,
                                             pairs, elem,
                                             def.bound ? def.bound : kVarrCeiling);
    if (held.tag == ValueTag::Nil) return;
    if (record.entity < state.last.size() &&
        field < state.last[record.entity].fields.size()) {
        state.last[record.entity].fields[field] = held;
        state.last[record.entity].known = true;
    }
}

bool flush_effects(const Program& program, RuntimeState& state, MeshPort& mesh,
                   std::string& fault) noexcept {
    /* every effect gets its attempt: one entity's failed send (its node down, say)
     * must not swallow the tick's writes to everything else. The last failure's
     * message is the tick's fault; a different one still standing next tick surfaces
     * then, and the app coalesces per message either way. */
    bool ok = true;
    /* per-effect scratch for the aggregate spans and their text views; sized to the
     * largest this program's effects can carry and reused across the loop */
    std::vector<MeshElems> spans;
    std::vector<std::string_view> views;
    for (uint32_t i = 0; i < state.effect_count; ++i) {
        const EffectRecord& record = state.effects[i];
        if (record.entity >= program.entities.size()) {
            fault = "effect names an invalid entity";
            ok = false;
            continue;
        }
        const EntityDef& entity = program.entities[record.entity];

        /* resolve the record's deep-copied aggregate runs into per-field spans; text
           elements' local refs become views over the record's own text slots */
        bool any_aggs = false;
        if (record.agg_used) {
            spans.assign(entity.fields.size(), MeshElems{});
            views.assign(record.agg_used, std::string_view{});
            for (uint32_t f = 0; f < entity.fields.size() && f < record.agg_span.size();
                 ++f) {
                const auto& span = record.agg_span[f];
                if (span.first == UINT32_MAX) continue;
                for (uint32_t k = 0; k < span.second; ++k) {
                    const Value& element = record.agg_values[span.first + k];
                    if (element.tag == ValueTag::Text &&
                        element.ref < record.agg_texts.size())
                        views[span.first + k] = record.agg_texts[element.ref].view();
                }
                spans[f] = MeshElems{record.agg_values.data() + span.first,
                                     views.data() + span.first, span.second};
                any_aggs = true;
                /* only what the record marks SET reaches the mirror — an unset
                   aggregate keeps whatever the owner last delivered */
                if (record.bare || (f < record.set.size() && record.set[f]))
                    mirror_agg(program, state, record, f, spans[f]);
            }
        }
        mirror_write(state, record);

        EffectView view;
        view.verb = record.verb;
        view.entity = &entity;
        view.bare = record.bare;
        view.field = record.field;
        view.elem_index = record.elem_index;
        view.value = record.value;
        view.fields = record.fields.data();
        view.set = record.set.data();
        view.field_count = static_cast<uint32_t>(entity.fields.size());
        view.bare_text = record.bare_text.view();
        view.field_text = record.field_text.data();
        view.elems = any_aggs ? spans.data() : nullptr;
        std::string one;
        if (!mesh.execute(view, one)) {
            fault = std::move(one);
            ok = false;
        }
    }
    return ok;
}

} // namespace hmi

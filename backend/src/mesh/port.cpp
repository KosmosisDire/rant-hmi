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
        last.fields[record.field] =
            rehome(record.value, record.bare_text.view(), record.field);
        last.known = true;
        return;
    }
    last.fields = record.fields;
    for (uint32_t f = 0; f < last.fields.size(); ++f)
        last.fields[f] = rehome(last.fields[f],
                                f < record.field_text.size() ? record.field_text[f].view()
                                                             : std::string_view{},
                                f);
    last.known = true;
}

bool flush_effects(const Program& program, RuntimeState& state, MeshPort& mesh,
                   std::string& fault) noexcept {
    /* every effect gets its attempt: one entity's failed send (its node down, say)
     * must not swallow the tick's writes to everything else. The last failure's
     * message is the tick's fault; a different one still standing next tick surfaces
     * then, and the app coalesces per message either way. */
    bool ok = true;
    for (uint32_t i = 0; i < state.effect_count; ++i) {
        const EffectRecord& record = state.effects[i];
        if (record.entity >= program.entities.size()) {
            fault = "effect names an invalid entity";
            ok = false;
            continue;
        }
        mirror_write(state, record);
        const EntityDef& entity = program.entities[record.entity];
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
        std::string one;
        if (!mesh.execute(view, one)) {
            fault = std::move(one);
            ok = false;
        }
    }
    return ok;
}

} // namespace hmi

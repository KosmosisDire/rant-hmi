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
    for (uint32_t i = 0; i < state.effect_count; ++i) {
        const EffectRecord& record = state.effects[i];
        if (record.entity >= program.entities.size()) {
            fault = "effect names an invalid entity";
            return false;
        }
        mirror_write(state, record);
        const EntityDef& entity = program.entities[record.entity];
        EffectView view;
        view.verb = record.verb;
        view.entity = &entity;
        view.bare = record.bare;
        view.field = record.field;
        view.value = record.value;
        view.fields = record.fields.data();
        view.set = record.set.data();
        view.field_count = static_cast<uint32_t>(entity.fields.size());
        view.bare_text = record.bare_text.view();
        view.field_text = record.field_text.data();
        if (!mesh.execute(view, fault)) return false;
    }
    return true;
}

} // namespace hmi

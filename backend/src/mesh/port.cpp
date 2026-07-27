#include "port.h"

namespace hmi {

bool flush_effects(const Program& program, RuntimeState& state, MeshPort& mesh,
                   std::string& fault) noexcept {
    for (uint32_t i = 0; i < state.effect_count; ++i) {
        const EffectRecord& record = state.effects[i];
        if (record.entity >= program.entities.size()) {
            fault = "effect names an invalid entity";
            return false;
        }
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

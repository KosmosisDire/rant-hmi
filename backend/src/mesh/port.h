#pragma once

#include "vm/state.h"

#include <string>
#include <string_view>
#include <vector>

namespace hmi {

struct EffectView {
    Verb verb = Verb::Write;
    const EntityDef* entity = nullptr;
    bool bare = false;
    uint32_t field = 0;
    Value value = Value::nil();
    const Value* fields = nullptr;
    const uint8_t* set = nullptr;
    uint32_t field_count = 0;
    std::string_view bare_text;
    const FixedText* field_text = nullptr;
};

class MeshPort {
  public:
    virtual ~MeshPort() = default;
    virtual const std::vector<EntityDef>& reflection() const noexcept = 0;
    virtual bool execute(const EffectView& effect, std::string& fault) noexcept = 0;
};

bool flush_effects(const Program& program, RuntimeState& state, MeshPort& mesh,
                   std::string& fault) noexcept;

} // namespace hmi

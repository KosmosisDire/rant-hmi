#pragma once

#include "port.h"

namespace hmi {

class FakeMesh final : public MeshPort {
  public:
    explicit FakeMesh(std::vector<EntityDef> entities = {});

    const std::vector<EntityDef>& reflection() const noexcept override;
    bool execute(const EffectView& effect, std::string& fault) noexcept override;

    void clear();
    const std::vector<std::string>& transcript() const;

  private:
    std::vector<EntityDef> entities_;
    std::vector<std::string> transcript_;
};

} // namespace hmi

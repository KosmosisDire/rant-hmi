#pragma once

#include "port.h"

namespace hmi {

class FakeMesh final : public MeshPort {
  public:
    explicit FakeMesh(std::vector<EntityDef> entities = {});

    const std::vector<EntityDef>& reflection() const noexcept override;
    bool execute(const EffectView& effect, std::string& fault) noexcept override;
    void drain(MeshSink& sink) override;

    /* Tests inject arrivals here; the next drain hands them to the sink in order. A
     * Text value's ref indexes `texts`. */
    void push_update(EntityKind kind, std::string name, std::vector<Value> fields,
                     std::vector<std::string> texts = {});

    void clear();
    const std::vector<std::string>& transcript() const;

  private:
    struct Update {
        EntityKind kind;
        std::string name;
        std::vector<Value> fields;
        std::vector<std::string> texts;
    };

    std::vector<EntityDef> entities_;
    std::vector<std::string> transcript_;
    std::vector<Update> updates_;
};

} // namespace hmi

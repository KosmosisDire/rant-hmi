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
    /* Attach an aggregate field's elements to the LAST pushed update: `elements` are
     * the raw Values (a map interleaves key,value), Text elements ref `texts`. */
    void push_elems(uint32_t field, std::vector<Value> elements,
                    std::vector<std::string> texts = {});

    /* Tests reshape the reflection here: the next refresh() reports the change, which
     * is the App's cue to recompile — the fake's half of a provider arriving, leaving
     * or retyping. */
    void retype(std::vector<EntityDef> entities);
    bool refresh() override;

    void clear();
    const std::vector<std::string>& transcript() const;

  private:
    struct FieldElems {
        std::vector<Value> data;
        std::vector<std::string> texts;
    };

    struct Update {
        EntityKind kind;
        std::string name;
        std::vector<Value> fields;
        std::vector<std::string> texts;
        std::vector<FieldElems> elems;   /* sized to fields when any field has elements */
    };

    std::vector<EntityDef> entities_;
    std::vector<std::string> transcript_;
    std::vector<Update> updates_;
    bool changed_ = false;
};

} // namespace hmi

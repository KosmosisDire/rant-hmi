#pragma once

#include "mesh/port.h"
#include "vm/vm.h"

#include <cstdint>
#include <string>
#include <vector>

namespace hmi {

struct InputEvent {
    uint64_t session = 0;
    uint64_t widget = 0;
    std::string event;
    Value value = Value::nil();
    uint64_t sequence = 0;
};

class Scheduler final : private MeshSink {
  public:
    Scheduler(Program program, MeshPort& mesh);

    const Program& program() const { return program_; }
    Program& program() { return program_; }
    const RuntimeState& state() const { return state_; }
    RuntimeState& state() { return state_; }

    void post(InputEvent event);
    void release_session(uint64_t session);
    bool tick(std::string& fault);

  private:
    struct Pressed {
        uint64_t session = 0;
        uint64_t widget = 0;
    };

    struct Hold {
        uint64_t session = 0;
        uint32_t flow = 0;
        uint64_t next_tick = 0;
        uint32_t repeat = 0;
    };

    struct SessionSequence {
        uint64_t session = 0;
        uint64_t sequence = 0;
    };

    /* A gesture's proposal, evaluated ONCE at pointer-down and reused by every event
     * of that gesture (press, release, tap, held). Spec 2.3 promises x never changes
     * meaning between a press and a tap on the same control; re-deriving it per event
     * breaks that whenever the machine's echo moves the shown value mid-gesture. */
    struct GesturePin {
        uint64_t widget = 0;
        Value x = Value::nil();
    };

    bool accept_sequence(uint64_t session, uint64_t sequence);
    Value proposed(uint64_t widget, const std::string& event, Value raw);
    void dispatch(uint64_t widget, const std::string& event, Value raw);
    void run_one(uint32_t flow, Value value);
    void on_press(const InputEvent& event);
    void on_release(const InputEvent& event);
    void apply_local_feeds();
    /* a decoded mesh arrival: refresh the RMW seed and run the feeds bound to it */
    void on_update(const MeshUpdate& update) override;
    /* copy an aggregate field's elements into the run's scratch pool (bounded) */
    Value intake_aggregate(const MeshUpdate& update, uint32_t field, const FieldDef& def);

    Program program_;
    RuntimeState state_;
    MeshPort& mesh_;
    std::vector<InputEvent> inbound_;
    std::vector<Pressed> pressed_;
    std::vector<Hold> holds_;
    std::vector<SessionSequence> sequences_;
    std::vector<GesturePin> pins_;
    std::vector<uint32_t> ended_;
};

} // namespace hmi

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

    bool accept_sequence(uint64_t session, uint64_t sequence);
    void dispatch(uint64_t widget, const std::string& event, Value raw);
    void run_one(uint32_t flow, Value value);
    void on_press(const InputEvent& event);
    void on_release(const InputEvent& event);
    void apply_local_feeds();
    /* a decoded mesh arrival: refresh the RMW seed and run the feeds bound to it */
    void on_update(const MeshUpdate& update) override;

    Program program_;
    RuntimeState state_;
    MeshPort& mesh_;
    std::vector<InputEvent> inbound_;
    std::vector<Pressed> pressed_;
    std::vector<Hold> holds_;
    std::vector<SessionSequence> sequences_;
    std::vector<uint32_t> ended_;
};

} // namespace hmi

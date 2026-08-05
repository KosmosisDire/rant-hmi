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
    /* a TEXT payload (a Dropdown's selected option): a Value cannot carry a string
       across the queue, so it rides beside and is homed into the run's input text slot
       at dispatch */
    std::string text;
    /* which ARMED PART of the widget raised it: the template node's dotted name, empty
       for the root's own gesture. Dispatch consults the compiled bubbling topology.
       (Last on purpose: the positional prefix above predates it.) */
    std::string part;
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
        std::string part;
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
    void dispatch(uint64_t widget, const std::string& part, const std::string& event,
                  Value arg);
    void run_one(uint32_t flow, Value value);
    /* dispatch every event the runs so far RAISED, in order; a raise during the drain
       joins the same queue, bounded by the raise buffer's own capacity */
    void drain_raised();
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
    std::vector<uint32_t> ended_;
    bool draining_ = false;
    /* when each CADENCE flow next runs, one entry per flow (0 = seed at the current
     * tick). Sized at construction, so the pass allocates nothing; it does not survive a
     * recompile, which restarts the phase — the RING migrates, being a cell, and that is
     * the part anyone can see. */
    std::vector<uint64_t> cadence_next_;
};

} // namespace hmi

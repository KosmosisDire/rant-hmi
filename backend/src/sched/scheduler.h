#pragma once

#include "mesh/port.h"
#include "vm/vm.h"

#include <cstdint>
#include <string>
#include <vector>

namespace hmi {

struct InputEvent {
    uint64_t session = 0;
    uint64_t node = 0;
    std::string event;
    Value value = Value::nil();
    uint64_t sequence = 0;
    /* a TEXT payload (a Dropdown's selected option): a Value cannot carry a string
       across the queue, so it rides beside and is homed into the run's input text slot
       at dispatch */
    std::string text;
    /* which ARMED ELEMENT of the instance raised it: the template node's dotted name,
       empty for the root's own gesture. Dispatch consults the compiled bubbling topology.
       (Last on purpose: the positional prefix above predates it.) */
    std::string element;
    /* and WHICH COPY of a `repeat` the pointer was on. The view draws N copies of one
       element off one set of cells, so this is the only place the copy exists at all —
       the flow reads it as `repeat.index`, and `@arr[repeat.index] = x` is what it is
       for. Not live outside a repeat. */
    RepeatSeat repeat;
};

class Scheduler final : private MeshSink {
  public:
    Scheduler(Program program, MeshPort& mesh);

    const Program& program() const { return program_; }
    Program& program() { return program_; }
    const Host& state() const { return state_; }
    Host& state() { return state_; }

    void post(InputEvent event);
    void release_session(uint64_t session);
    bool tick(std::string& fault);

  private:
    struct Pressed {
        uint64_t session = 0;
        uint64_t node = 0;
        std::string element;
        RepeatSeat copy;
    };

    struct Hold {
        uint64_t session = 0;
        uint32_t flow = 0;
        uint64_t next_tick = 0;
        uint32_t repeat = 0;
        /* the copy the press landed on: `held` fires later, but it fires for the copy a
           finger is still holding down (`repeat` above is the re-fire cadence — an older
           spelling of a different word) */
        RepeatSeat copy;
    };

    struct SessionSequence {
        uint64_t session = 0;
        uint64_t sequence = 0;
    };

    bool accept_sequence(uint64_t session, uint64_t sequence);
    /* `copy` is which repeat copy raised it, riding every invocation this dispatch
       makes (and anything they raise) as the frame's repeat arguments —
       default-constructed where nothing drove it from a copy */
    void dispatch(uint64_t node, const std::string& element, const std::string& event,
                  Value arg, RepeatSeat copy = RepeatSeat{});
    void run_one(uint32_t flow, Value value, const RepeatSeat& copy);
    /* dispatch every event the runs so far RAISED, in order, each as the copy whose
       dispatch queued it; a raise during the drain joins the same queue, bounded by
       the raise buffer's own capacity */
    void drain_raised(const RepeatSeat& copy);
    void on_press(const InputEvent& event);
    void on_release(const InputEvent& event);
    /* the STANDING slot expressions: every one once on the first pass (the seed), the
       cell-reading ones every tick after; the mesh-only ones re-run from on_update */
    void apply_slot_programs();
    /* a decoded mesh arrival: refresh the last-value mirror and re-evaluate the slot
       expressions that read this entity */
    void on_update(const MeshUpdate& update) override;

    Program program_;
    Host state_;
    MeshPort& mesh_;
    std::vector<InputEvent> inbound_;
    std::vector<Pressed> pressed_;
    std::vector<Hold> holds_;
    std::vector<SessionSequence> sequences_;
    std::vector<uint32_t> ended_;
    bool draining_ = false;
    /* the slot programs' first pass has not run yet: every program runs once then,
       whatever its deps, so a dep-less one (an array literal) still lands its value */
    bool slots_seeded_ = false;
    /* when each CADENCE flow next runs, one entry per flow (0 = seed at the current
     * tick). Sized at construction, so the pass allocates nothing; it does not survive a
     * recompile, which restarts the phase — the RING migrates, being a cell, and that is
     * the part anyone can see. */
    std::vector<uint64_t> cadence_next_;
};

} // namespace hmi

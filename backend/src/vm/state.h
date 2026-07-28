#pragma once

#include "program.h"

#include <cstdint>
#include <string_view>
#include <vector>

namespace hmi {

struct FixedText {
    std::vector<char> bytes;
    uint32_t length = 0;

    FixedText() = default;
    explicit FixedText(uint32_t capacity);
    void set(std::string_view value) noexcept;
    std::string_view view() const noexcept;
};

struct MessageState {
    bool open = false;
    uint32_t entity = 0;
    std::vector<Value> fields;
    std::vector<uint8_t> set;
};

struct LastValueState {
    bool known = false;
    std::vector<Value> fields;
};

struct EffectRecord {
    Verb verb = Verb::Write;
    uint32_t entity = 0;
    bool bare = false;
    uint32_t field = 0;
    Value value = Value::nil();
    std::vector<Value> fields;
    std::vector<uint8_t> set;
    FixedText bare_text;
    std::vector<FixedText> field_text;
};

struct RuntimeFault {
    uint32_t site = 0;
    uint64_t tick = 0;
    uint32_t count = 0;
};

struct TimerState {
    bool running = false;
    uint32_t remaining = 0;
};

/* runtime side of an OverlayDef: `shadow` is the latest FED value while `active`
 * says a local write is showing in the cell and holds until expire_tick */
struct OverlayState {
    bool active = false;
    uint64_t expire_tick = 0;
    Value shadow = Value::nil();
};

struct PendingState {
    bool active = false;
    uint64_t wake_tick = 0;
    uint32_t flow = 0;
    uint32_t resume_pc = 0;
    Value x = Value::nil();
    std::vector<MessageState> buffers;
};

class RuntimeState {
  public:
    explicit RuntimeState(const Program& program);

    uint64_t tick = 0;
    std::vector<Value> values;
    std::vector<FixedText> texts;
    /* mesh-inbound text storage, appended after the cell slots: one scratch slot for
     * values consumed immediately (a function response feed), and one RETAINED slot per
     * text-shaped entity field so the last-value cache can hold deliverable text (a
     * `seed: last` build must be able to re-send it) */
    uint32_t mesh_scratch = 0;
    std::vector<std::vector<uint32_t>> entity_texts;   /* [entity][field] -> text slot */
    /* suspension deep-copy storage: each pending site owns a fixed run of text slots
     * (one for x, one per text-shaped buffer field) so held text survives until resume */
    std::vector<uint32_t> pending_texts;               /* [pending site] -> first slot */
    /* the aggregate scratch pool: list/map elements live here for one run, dealt out
     * by a cursor that whoever seeds x resets (reset_scratch). Element text rides in
     * `texts` slots [elem_text_base, elem_text_base + layout.elem_texts). */
    std::vector<Value> elems;
    uint32_t elem_cursor = 0;
    uint32_t elem_text_base = 0;
    uint32_t elem_text_cursor = 0;
    uint32_t elem_text_count = 0;
    std::vector<MessageState> buffers;
    std::vector<LastValueState> last;
    std::vector<OverlayState> overlays;
    std::vector<Value> deadband;
    std::vector<uint64_t> throttle;
    std::vector<PendingState> pending;
    std::vector<TimerState> timers;
    std::vector<uint8_t> fired;
    std::vector<Value> stack;
    std::vector<EffectRecord> effects;
    uint32_t effect_count = 0;
    std::vector<RuntimeFault> faults;
    uint32_t fault_count = 0;

    std::string_view text(const Program& program, const Value& value) const noexcept;
    /* Write a cell. A LOCAL write (the default) to an overlaid cell shows immediately
     * and starts the pending window; an AUTHORITATIVE write (a feed) lands in the
     * overlay's shadow while a write is pending, confirms it on a match, and writes
     * through otherwise. Non-overlaid cells ignore the distinction. */
    bool store(const Program& program, uint32_t cell, const Value& value,
               bool authoritative = false) noexcept;
    /* fall pending overlays whose window has passed back to their fed shadow */
    void expire_overlays(const Program& program) noexcept;
    void clear_outputs() noexcept;
    void fault(uint32_t site) noexcept;

    /* aggregate scratch: reset before seeding a run's x, allocate during the run.
     * alloc_elems returns the pool offset or UINT32_MAX when the layout bound is hit;
     * alloc_elem_text returns a text slot index or UINT32_MAX. */
    void reset_scratch() noexcept;
    uint32_t alloc_elems(uint32_t count) noexcept;
    uint32_t alloc_elem_text() noexcept;
};

RuntimeState migrate_state(const Program& old_program, const RuntimeState& old_state,
                           const Program& new_program);

Value zero_value(Shape shape);

} // namespace hmi

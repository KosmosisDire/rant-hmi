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

/* One struct value's storage: its fields plus a set-bit each. The set bits are what
 * makes read-modify-write honest on the way out (spec 5.8): a fresh value sets none, a
 * read sets all, and a field write sets its own. Text fields own a FixedText slot each
 * (`texts`, UINT32_MAX where the field is not text): text landing in a struct is copied
 * into the struct's own slot, so the value at rest never points into a site's scratch
 * and a declared variable's text can migrate across a recompile. */
struct StructState {
    uint16_t type_id = 0;
    std::vector<Value> fields;
    std::vector<uint8_t> set;
    std::vector<uint32_t> texts;
};

/* HOW MANY ELEMENTS OF `shape` ONE BUFFER'S BYTES BUY (kBufferBytes, ir.h). Every element
 * costs its Value; a TEXT element costs its own text slot on top, and an UNDECLARED one is
 * charged as text because it may hold one. This is the only ceiling a retained aggregate
 * has, and it is per BUFFER — the outer entries and a nested cell's leaf arena each get
 * the whole of it. */
uint32_t buffer_capacity(Shape shape) noexcept;

/* One AGGREGATE cell's retained storage — a list's elements, or a map's entries
 * INTERLEAVED (key, value) with `count` counting PAIRS and the keys kept SORTED ascending
 * by text at all times (deterministic iteration is what makes a replay byte-identical,
 * and it is the order nlohmann serialises an object in, so the wire agrees for free).
 *
 * An aggregate built during a run lives in the scratch element pool, which resets before
 * the next one, so a cell that is to hold one ACROSS ticks needs storage of its own: this
 * is it. `elems` starts EMPTY and grows amortized toward the working size a store or an
 * append asks for, never past what one buffer's bytes buy (buffer_capacity) — a slot that
 * only ever holds three options must not carry a whole budget's worth of Values, and a
 * buffer that has earned its size keeps it rather than being cut off. `texts` names one
 * slot in
 * RuntimeState::texts per element position that has ever held text, so element text
 * resolves through exactly the machinery every other text value does.
 *
 * `gen` and `total` are the WIRE's truth and have to stay exact: gen bumps on every
 * discontinuity (a whole store, a clear, a store of Nil, a migration), and total counts
 * elements ever APPENDED within the current gen — never rewound by a trim, so it is a
 * cursor a client can compare against. A whole store resets total to the new count. */
struct ListState {
    uint32_t count = 0;
    uint32_t gen = 0;
    uint64_t total = 0;
    std::vector<Value> elems;
    std::vector<uint32_t> texts;

    /* ---- NESTED cells only (the cell declares `elem` list or map) ----
     *
     * Nesting is ONE declared level, so a row holds scalars and nothing below it can hold
     * anything. Every row's elements live together in this one LEAF ARENA and the row's
     * entry in `elems` is the sub-aggregate Value naming its start and length — no child
     * ListState, no slot allocator, no lifetime to get wrong.
     *
     * Extents are NOT in row order. A row that outgrows its capacity is relocated whole
     * to the tail and leaves a HOLE behind, which is what keeps growing one row off the
     * cost of every other row; `leaf_live` (the capacity actually reachable) against
     * `leaf_used` (the tail cursor) is how a compaction knows when the holes are worth
     * collecting. `leaf_texts` homes leaf text per POSITION exactly as `texts` does for
     * the outer entries, so a relocation carries text with it (move_leaf). */
    std::vector<Value> leaves;
    std::vector<uint32_t> leaf_texts;
    /* the extent reserved for each ROW (a map's PAIR index), which is what an append
     * writes into without moving anything */
    std::vector<uint32_t> row_cap;
    uint32_t leaf_used = 0;
    uint32_t leaf_live = 0;
    /* The DECLARED element and leaf shapes, copied from the cell at construction. An
     * aggregate `elem` is what makes this slot nested, and the storage has to be able to
     * say so on its own: a recompile hands migrate the NEW cell table and the OLD state,
     * so the slot being written is the only thing in reach that knows its own shape. A
     * mesh mirror declares neither and is never nested. */
    Shape elem = Shape::Unknown;
    Shape leaf = Shape::Unknown;

    bool nested() const noexcept { return elem == Shape::List || elem == Shape::Map; }
    bool row_pairs() const noexcept { return elem == Shape::Map; }

    /* HOW MANY ENTRIES THIS BUFFER MAY HOLD, and how many its arena may. Two budgets, one
     * per buffer, each the whole of kBufferBytes: a nested cell's rows are entries of the
     * first and their leaves live in the second, so a list declared to hold N rows holds N
     * of them however wide a row is. A nested cell's own entries are sub-aggregate Values
     * costing no text, which is why the outer budget asks about `elem` only when it is
     * flat. */
    uint32_t capacity() const noexcept {
        return buffer_capacity(nested() ? Shape::List : elem);
    }
    uint32_t leaf_capacity() const noexcept { return buffer_capacity(leaf); }
};

/* a bounds-checked window into an aggregate's elements; `count` is ENTRIES (a map's
 * PAIRS, entries interleaved key,value). Both storages resolve through it, so a reader
 * never has to know whether the value it holds is scratch or retained. */
struct AggView {
    const Value* data = nullptr;
    uint32_t count = 0;
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
    /* an ELEMENT write into an array field: the position `value` lands at, UINT32_MAX
     * for every whole-field write. Records are pooled and reused, so every emit path
     * must set it — a stale index would turn the next field write into an element one. */
    uint32_t elem_index = UINT32_MAX;
    Value value = Value::nil();
    std::vector<Value> fields;
    std::vector<uint8_t> set;
    FixedText bare_text;
    std::vector<FixedText> field_text;
    /* AGGREGATE payloads, deep-copied at EMIT exactly as scalar values are (a later
     * write in the same tick must not retro-edit this effect): per field a run in
     * `agg_values` (agg_span = offset,VALUES count; a map's entries interleaved;
     * UINT32_MAX offset = no aggregate). Text elements are re-homed into `agg_texts`
     * and their Value.ref re-pointed at that LOCAL index — these Values never
     * re-enter the VM; the flush resolves them into string views. */
    std::vector<Value> agg_values;
    std::vector<FixedText> agg_texts;
    std::vector<std::pair<uint32_t, uint32_t>> agg_span;
    uint32_t agg_used = 0;
    uint32_t agg_text_used = 0;
};

/* one queued raise: the RaiseDef it speaks as, its argument, and owned text storage so
 * a text argument survives until the scheduler dispatches it (mirrors EffectRecord) */
struct RaisedRecord {
    uint32_t def = 0;
    Value value = Value::nil();
    FixedText text;
};

/* one queued notification: the rendered message and how long it stays showing (0 = the
 * view scales the time with the message's length). The App drains these after the tick
 * and broadcasts them to every session — a notification is spoken once, to everyone. */
struct NoticeRecord {
    FixedText text;
    uint32_t ms = 0;
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

/* WHICH COPY OF A `repeat` A RUN BELONGS TO. A repeated element is ONE element the view
 * draws N times, so the backend keeps one set of cells and the copy is not a runtime
 * instance — it is an INDEX, and it arrives with the event the copy raised. `live` false
 * is an honest "there is no copy behind this run": a cadence or a timer fires for the
 * element, not for a copy of it, and RepeatRead answers Nil exactly as the view's
 * `repeat:` cells do outside a repeat. */
struct RepeatSeat {
    bool live = false;
    uint32_t index = 0;
    uint32_t count = 0;
};

struct PendingState {
    bool active = false;
    uint64_t wake_tick = 0;
    uint32_t flow = 0;
    uint32_t resume_pc = 0;
    Value x = Value::nil();
    /* the event parameter the parked run arrived with, restored at resume */
    Value arg = Value::nil();
    /* and which copy it arrived on: a run that parks in a debounce must wake as the same
       copy it was pressed on, or the delay would silently move the write elsewhere */
    RepeatSeat repeat;
    /* every struct slot, by value, so a run that parks mid-message re-enters with its
     * own storage and nothing dangles when the scratch resets (spec 5.6) */
    std::vector<StructState> structs;
};

class RuntimeState {
  public:
    explicit RuntimeState(const Program& program);

    uint64_t tick = 0;
    /* THE WALL CLOCK, epoch milliseconds, stamped by the scheduler at the top of each
     * tick (never mid-run, so one run can never see the second flip under it). ClockRead
     * serves its civil fields; `time.now` reads the tick counter instead, which is what
     * keeps a replayed program's arithmetic deterministic. Tests pin it by setting
     * wall_pinned and writing wall_ms by hand. */
    double wall_ms = 0;
    bool wall_pinned = false;
    std::vector<Value> values;
    std::vector<FixedText> texts;
    /* mesh-inbound text storage, appended after the cell slots: one scratch slot for
     * values consumed immediately (a function response feed), and one RETAINED slot per
     * text-shaped entity field so the last-value cache can hold deliverable text (a
     * `seed: last` build must be able to re-send it) */
    uint32_t mesh_scratch = 0;
    /* one slot for an input event's text payload (a Dropdown's selected option),
       homed here at dispatch so `x` can be text without the queue owning storage */
    uint32_t input_scratch = 0;
    std::vector<std::vector<uint32_t>> entity_texts;   /* [entity][field] -> text slot */
    /* suspension deep-copy storage: each pending site owns a fixed run of text slots
     * (one for x, one per text-shaped field of every struct slot) so held text survives
     * until resume */
    std::vector<uint32_t> pending_texts;               /* [pending site] -> first slot */
    /* the aggregate scratch pool: list/map elements live here for one run, dealt out
     * by a cursor that whoever seeds x resets (reset_scratch). Element text rides in
     * `texts` slots [elem_text_base, elem_text_base + layout.elem_texts). */
    std::vector<Value> elems;
    uint32_t elem_cursor = 0;
    uint32_t elem_text_base = 0;
    uint32_t elem_text_cursor = 0;
    uint32_t elem_text_count = 0;
    /* one entry per LIST- or MAP-shaped cell, indexed by CellDef::list_slot — and,
     * appended AFTER those, the MESH AGGREGATE MIRRORS (entity_aggs below) */
    std::vector<ListState> lists;
    /* MESH AGGREGATE MIRRORS: one retained slot per aggregate-shaped readable entity
     * field, indexed [entity][read-side field] -> `lists`, UINT32_MAX where the field
     * is not an aggregate. A delivery copies the elements in (hold_entity_agg) and the
     * last-value cache holds the retained Value, so LoadEnt hands a slot expression or
     * a flow the entity's last list/map exactly as the cache hands it a scalar. Empty
     * after a recompile until the mesh re-delivers — the scalar cache's own rule. */
    std::vector<std::vector<uint32_t>> entity_aggs;
    std::vector<StructState> structs;
    std::vector<LastValueState> last;
    std::vector<Value> deadband;
    std::vector<uint64_t> throttle;
    std::vector<PendingState> pending;
    std::vector<TimerState> timers;
    std::vector<uint8_t> fired;
    std::vector<Value> stack;
    std::vector<EffectRecord> effects;
    uint32_t effect_count = 0;
    /* THE EVENT PARAMETER: what the triggering event passed in, seeded at dispatch,
     * read by LoadArg wherever the parameter's name is spoken — including inside a
     * lambda body, which is why this is state rather than a run_code register. One
     * slot: the vocabulary is one parameter per event (enforced at compile). */
    Value args[1] = {Value::nil()};
    /* THE COPY THIS RUN IS: seeded by whoever drove the run (an input event carries one,
     * a cadence does not), read by RepeatRead. A raise inherits it untouched, which is
     * right — an event raised from a copy's own run is that copy speaking. */
    RepeatSeat repeat;
    /* raised events queued during a run, dispatched by the scheduler AFTER it halts */
    std::vector<RaisedRecord> raised;
    uint32_t raised_count = 0;
    /* notifications queued during this tick, drained by the App after it */
    std::vector<NoticeRecord> notices;
    uint32_t notice_count = 0;
    std::vector<RuntimeFault> faults;
    uint32_t fault_count = 0;

    std::string_view text(const Program& program, const Value& value) const noexcept;
    bool store(const Program& program, uint32_t cell, const Value& value) noexcept;
    void clear_outputs() noexcept;
    void fault(uint32_t site) noexcept;

    /* the elements behind a list or a map, whichever storage it names */
    AggView aggregate(const Value& value) const noexcept;
    /* Copy a run of elements into an aggregate cell's retained slot and point the cell
     * at it. The source may live anywhere -- the scratch pool, a program's constant
     * list, the state being retired at a recompile -- so text is resolved through the
     * pair it belongs to and copied into the slot's own storage. A whole store is a
     * DISCONTINUITY: gen bumps and total restarts at the new element count. `pairs`
     * says the run is a map's interleaved entries, which are re-sorted by key here
     * because the source may be a scratch map the mesh built in arrival order. */
    bool hold_list(const Program& source_program, const RuntimeState& source,
                   uint32_t cell, uint32_t list_slot, const Value* data,
                   uint32_t count, bool pairs = false) noexcept;
    /* the same start, for a cell whose elements are ROWS: the authored rows live on the
     * cell as `row_init` rather than in one flat run, because a run of scalars is exactly
     * what a nested literal is not */
    void seed_nested(const Program& program, uint32_t cell, const CellDef& def) noexcept;
    /* Append ONE element to a list cell — a scalar, or a whole ROW where the cell
     * declares a list/map element. An element the cell's declared shape does not fit is
     * refused, and so is an append that would cross kRetainedCeiling with no keep to
     * bound it; both return false so the caller can fault loudly. A Nil value APPENDS: a
     * gap is a value, and a ring that silently skipped its unknown samples would draw a
     * lie. `keep`, when it is a number, trims the FRONT afterwards. */
    bool append_list(const Program& program, uint32_t cell, Value value,
                     const Value& keep) noexcept;
    /* the same append where the cell declares a nested element: the value is a whole ROW,
     * laid into the slot's leaf arena beside every other row's. Reached through
     * append_list, which is where the shape is decided. */
    bool append_row(const Program& program, uint32_t cell, Value value,
                    const Value& keep) noexcept;
    /* Write ONE key of a map cell, at its sorted position. A Nil value ERASES the key
     * (an absent key is already erased, which is not a failure). A non-text key, an
     * aggregate value, or a NEW key past the ceiling all return false: a map has no
     * keep, so a runaway one is a bug by construction. */
    bool store_key(const Program& program, uint32_t cell, const Value& key,
                   Value value) noexcept;
    /* Write ONE position of a list cell. The index must be a number inside the list
     * (0..count-1): an element write EDITS in place, growth stays Append's verb, so a
     * miss refuses rather than extending. A Nil value stores as Nil (a gap is a value;
     * a list has no positional erase). An unchanged element is no write at all — the
     * wire stays silent; a changed one is a discontinuity (gen moves, whole resend),
     * because the aggs lane has no in-place-edit vocabulary. */
    bool store_index(const Program& program, uint32_t cell, const Value& index,
                     Value value) noexcept;
    /* ---- INSIDE one row of a nested cell ----
     *
     * `outer` addresses the row the way the cell itself is addressed — a number index
     * into a nested list, a text key into a nested map — and the verbs below are the row's
     * own append and element write. Both refuse on a cell that is not nested, on a row
     * that is not there (a row is grown by writing the OUTER entry, never by reaching
     * into a position that does not exist), and on an aggregate value (a row holds
     * scalars: nesting is one level and this is already the bottom of it).
     *
     * A leaf edit is a DISCONTINUITY like every other in-place edit here: the aggs lane
     * has no vocabulary for "element 3 of row 2 moved", so the generation bumps and the
     * cell goes out whole on the next publish. */
    bool append_leaf(const Program& program, uint32_t cell, const Value& outer, Value value,
                     const Value& keep) noexcept;
    bool store_leaf(const Program& program, uint32_t cell, const Value& outer,
                    const Value& inner, Value value) noexcept;
    /* One delivered aggregate field into its mirror slot: `data` is the delivery's
     * element run (a map's pairs interleaved, arrival order), `elem_texts[k]` the text
     * behind data[k] where that element is text. Bounds to the field's own bound and
     * the retained ceiling, sorts a map's pairs by key, homes text per position, and
     * returns the retained Value the last-value cache should hold (Nil on refusal). */
    Value hold_entity_agg(uint32_t list_slot, const Value* data,
                          const std::string_view* elem_texts, uint32_t delivered,
                          bool pairs, ValueTag elem, uint32_t bound) noexcept;
    /* the text slot backing element `at` of a retained aggregate, allocated on first use */
    uint32_t list_text(ListState& held, uint32_t at) noexcept;
    /* the same, for position `at` of a nested slot's LEAF arena */
    uint32_t leaf_text(ListState& held, uint32_t at) noexcept;
    /* move one entry within a retained slot, its text following it into the destination
     * position's own slot: what a trim and a keyed insert are both built out of */
    void move_entry(ListState& held, uint32_t dst, uint32_t src) noexcept;
    /* the same move, within the leaf arena */
    void move_leaf(ListState& held, uint32_t dst, uint32_t src) noexcept;

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

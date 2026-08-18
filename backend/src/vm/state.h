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

/* One struct value's storage: its fields, where a field NOBODY HAS SET holds Nil —
 * un-set-ness IS Unknown-ness (stage 6c), which is what makes read-modify-write
 * honest on the way out (spec 5.8): the encode keeps the owner's own bytes for every
 * Nil field, coherent because a mesh field is not erasable. A fresh value knows
 * nothing but its authored defaults; a read fills what the cache knows; a write
 * fills its field. Text fields own a FixedText slot each (`texts`, UINT32_MAX where
 * the field is not text): text landing in a struct is copied into the struct's own
 * slot, so the value at rest never points into a site's scratch and a declared
 * variable's text can migrate across a recompile. */
struct StructState {
    uint16_t type_id = 0;
    std::vector<Value> fields;
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
 * Store::texts per element position that has ever held text, so element text
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
    /* the message's fields AS GIVEN: a Nil field was never set, and both the encode
     * and the mirror leave the owner's own value standing for it */
    std::vector<Value> fields;
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

/* WHICH COPY OF A `repeat` A RUN BELONGS TO — the HOST'S record of the occurrence
 * (an input event carries one, a hold remembers the press's), converted into the
 * frame's repeat arguments at invocation. A repeated element is ONE element the view
 * draws N times, so the backend keeps one set of cells and the copy is not a runtime
 * instance — it is an INDEX, and it arrives with the event the copy raised. `live`
 * false is an honest "there is no copy behind this run": a cadence or a timer fires
 * for the element, not for a copy of it, and the repeat arguments seed Nil exactly
 * as the view's `repeat:` cells read outside a repeat. */
struct RepeatSeat {
    bool live = false;
    uint32_t index = 0;
    uint32_t count = 0;
};

/* THE FRAME (stage 6a): the storage a RUN owns, as opposed to the storage a CELL
 * owns. Values at rest live in cell storage; values in flight live here, sized once
 * from the compiler's FrameExtent and reused run after run.
 *
 * The text arena is [fixed site slots | element text slots]: every text-producing
 * site owns the frame-relative slot the compiler assigned it, and the region after
 * `text_base` is dealt by a cursor to whatever homes text per ELEMENT (split, map's
 * re-homed results, a fold's carried accumulator). A frame text ref carries
 * kFrameRef, so nothing at rest can be confused with it. The element arena is the
 * pool aggregate-producing sites build into, reset at each fresh run's entry. */
struct Frame {
    /* how many argument slots every frame carries (the vocabulary is fixed: one
     * declared parameter per event — enforced at compile — plus the copy context) */
    static constexpr uint32_t kArgs = 4;

    std::vector<Value> stack;
    /* [fixed site slots | frame locals' field texts | element text region] */
    std::vector<FixedText> texts;
    std::vector<Value> elems;
    /* FLOW TEMPORARIES: a run's message buffers live with the run, so a park keeps
     * them by ownership and nothing snapshots or restores field by field. Slot k
     * here is struct slot layout.state_structs + k. */
    std::vector<StructState> locals;
    /* THE INVOCATION'S ARGUMENTS: what this run was CALLED with, seeded by the
     * invoker and read by Arg — [0] the triggering event's declared parameter,
     * [1..3] the repeat copy the event arrived on (index, count, fraction; Nil
     * where no copy is behind the run). Frame-resident so a lambda body reads
     * them without touching its own x2/x3 registers, and so a park keeps them by
     * keeping the frame. */
    Value args[kArgs] = {Value::nil(), Value::nil(), Value::nil(), Value::nil()};
    uint32_t elem_cursor = 0;
    uint32_t text_base = 0;
    uint32_t text_cursor = 0;

    /* a fresh run starts with an empty arena and no arguments; the invoker seeds
     * what it calls with, and a resumed run keeps what it held */
    void reset() noexcept {
        elem_cursor = 0;
        text_cursor = text_base;
        for (Value& arg : args) arg = Value::nil();
    }
    /* a run of `count` element slots, or UINT32_MAX when the extent is spent */
    uint32_t alloc(uint32_t count) noexcept {
        if (count > elems.size() || elem_cursor > elems.size() - count) return UINT32_MAX;
        const uint32_t offset = elem_cursor;
        elem_cursor += count;
        return offset;
    }
    /* one element text slot (a frame index — callers ref it as kFrameRef | slot) */
    uint32_t alloc_text() noexcept {
        if (text_cursor >= texts.size()) return UINT32_MAX;
        return text_cursor++;
    }
};

/* THE STORE (stage 7): what the system KNOWS — every value AT REST. The declared
 * cells' scalars, their text, their retained aggregates and their struct fields, and
 * the mesh's last-value mirrors beside them: a database, addressed by the compiler's
 * layout, with no idea when or why anything runs. Values IN FLIGHT live in the run's
 * Frame instead, and the two never share an index space (kFrameRef marks the frame's).
 * The storage-only verbs live here; anything that must ROUTE between the store and
 * the active frame (a write landing in a flow temporary, text resolution, aggregate
 * views) stays one level up, where both halves are in reach. */
struct Store {
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
    /* one entry per LIST- or MAP-shaped cell, indexed by CellDef::list_slot — and,
     * appended AFTER those, the MESH AGGREGATE MIRRORS (entity_aggs below) */
    std::vector<ListState> lists;
    /* MESH AGGREGATE MIRRORS: one retained slot per aggregate-shaped readable entity
     * field, indexed [entity][read-side field] -> `lists`, UINT32_MAX where the field
     * is not an aggregate. A delivery copies the elements in (hold_entity_agg) and the
     * last-value cache holds the retained Value, so an entity read hands a slot expression or
     * a flow the entity's last list/map exactly as the cache hands it a scalar. Empty
     * after a recompile until the mesh re-delivers — the scalar cache's own rule. */
    std::vector<std::vector<uint32_t>> entity_aggs;
    /* declared struct variables' slots only: a flow temporary's fields live in
     * frame.locals (struct_at routes a handle to whichever owns it) */
    std::vector<StructState> structs;
    std::vector<LastValueState> last;

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
};

/* THE OUTBOX (stage 7): what the system SAYS. Every message leaving a run passes
 * through here and nowhere else — the mesh port flushes the effects, the scheduler
 * dispatches the raises, the App broadcasts the notices — which is what makes "effects
 * run once, centrally" a structure rather than a discipline. The queue counts reset at
 * each tick's start; the fault log's per-site records accumulate instead, because a
 * log COALESCES (one row per site, counted) where a mailbox drains. */
struct Outbox {
    std::vector<EffectRecord> effects;
    uint32_t effect_count = 0;
    /* raised events queued during a run, dispatched by the scheduler AFTER it halts */
    std::vector<RaisedRecord> raised;
    uint32_t raised_count = 0;
    /* notifications queued during this tick, drained by the App after it */
    std::vector<NoticeRecord> notices;
    uint32_t notice_count = 0;
    std::vector<RuntimeFault> faults;
    uint32_t fault_count = 0;

    /* a fresh tick starts with empty queues. The notice reset only matters to a
       harness that ticks the scheduler bare, where an undrained notice dies quietly
       instead of filling the buffer into a spurious fault. */
    void clear() noexcept {
        effect_count = 0;
        raised_count = 0;
        notice_count = 0;
        fault_count = 0;
    }
    /* count one runtime finding at `site`, stamped with the host's tick */
    void fault(uint32_t site, uint64_t tick) noexcept {
        if (site >= faults.size()) return;
        faults[site].site = site;
        faults[site].tick = tick;
        ++faults[site].count;
        ++fault_count;
    }
};

struct PendingState {
    bool active = false;
    uint64_t wake_tick = 0;
    uint32_t flow = 0;
    uint32_t resume_pc = 0;
    Value x = Value::nil();
    /* THE PARKED FRAME (stage 6a): parking SWAPS the run's frame in here whole —
     * arena, cursors, arguments and all — and resume swaps it back, so held scratch
     * survives by ownership rather than by deep copy. A run that parks in a debounce
     * wakes as the same copy it was pressed on because the repeat arguments ride
     * the frame. Values referencing storage OUTSIDE the frame (a cell's text slot,
     * the input scratch) are pinned into the frame arena at park, which is the
     * whole of what still copies. */
    Frame held;
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
    /* every value at rest: the cells' storage and the mesh mirrors */
    Store store;
    std::vector<PendingState> pending;
    std::vector<TimerState> timers;
    std::vector<uint8_t> fired;
    /* the active run's frame: every run enters it, and nothing at rest points into it */
    Frame frame;
    /* every message out: the mesh effects, the raises, the notices, the fault log */
    Outbox out;

    std::string_view text(const Program& program, const Value& value) const noexcept;
    /* the storage behind a struct handle: a declared variable's slot is the state's,
     * a flow temporary's is the frame's — it parks and resumes with its run */
    StructState* struct_at(uint32_t slot) noexcept {
        if (slot < store.structs.size()) return &store.structs[slot];
        const uint32_t local = slot - static_cast<uint32_t>(store.structs.size());
        return local < frame.locals.size() ? &frame.locals[local] : nullptr;
    }
    const StructState* struct_at(uint32_t slot) const noexcept {
        if (slot < store.structs.size()) return &store.structs[slot];
        const uint32_t local = slot - static_cast<uint32_t>(store.structs.size());
        return local < frame.locals.size() ? &frame.locals[local] : nullptr;
    }
    /* the FixedText behind a struct field's own text slot, wherever it lives
     * (kFrameRef marks a frame local's; UINT32_MAX resolves to nowhere) */
    FixedText* field_text(uint32_t ref) noexcept {
        if ((ref & kFrameRef) != 0) {
            const uint32_t at = ref & ~kFrameRef;
            return at < frame.texts.size() ? &frame.texts[at] : nullptr;
        }
        return ref < store.texts.size() ? &store.texts[ref] : nullptr;
    }
    /* THE ONE STORE (stage 6c): every write a program makes lands through here — the
     * place says where, the mode how (ir_ops.h). `step` is the place's dynamic step:
     * Elem's index, Key's key, an Append's keep bound, a Leaf's outer address; `step2`
     * is the Leaf place's second (Assign: the inner index or key; Append: the keep).
     * A write that lands in a struct's aggregate-field storage (CellDef::field_of)
     * starts the storage fresh when the field is still Unknown and refreshes the
     * owner's field handle afterwards, as part of the write.
     * False is a REFUSAL the caller faults on: a foreign element, a miss, a full
     * buffer — never a silent drop. */
    bool write(const Program& program, uint32_t cell, uint32_t field, StorePlace place,
               StoreMode mode, Value value, const Value& step = Value::nil(),
               const Value& step2 = Value::nil()) noexcept;
    /* one runtime finding, stamped with this state's own tick */
    void fault(uint32_t site) noexcept { out.fault(site, tick); }

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
  private:
    /* THE LANDINGS behind `write`, one per place-and-mode. The whole store replaces
     * (an unchanged aggregate is no write; Nil clears); the field store re-homes text
     * into the struct's own slot; the element store EDITS inside the window (growth is
     * the append mode's verb) and a changed element is a discontinuity the wire sees
     * whole; the keyed store upserts at sorted position and Nil ERASES; the append
     * grows by one trimmed to `keep`, refusing at the retained ceiling unbounded, and
     * a Nil element APPENDS (a gap is a value — a ring that skipped its unknown
     * samples would draw a lie). The leaf pair does the same inside one ROW of a
     * nested cell, `outer` addressing the row the way the cell itself is addressed;
     * a row that is not there refuses (a row grows by writing the OUTER entry). */
    bool write_whole(const Program& program, uint32_t cell, const Value& value) noexcept;
    bool write_field(const Program& program, uint32_t cell, uint32_t field,
                     Value value) noexcept;
    bool write_elem(const Program& program, uint32_t cell, const Value& index,
                    Value value) noexcept;
    bool write_key(const Program& program, uint32_t cell, const Value& key,
                   Value value) noexcept;
    bool write_append(const Program& program, uint32_t cell, Value value,
                      const Value& keep) noexcept;
    /* write_append where the cell declares a nested element: the value is a whole ROW,
     * laid into the slot's leaf arena beside every other row's */
    bool write_row(const Program& program, uint32_t cell, Value value,
                   const Value& keep) noexcept;
    bool write_leaf(const Program& program, uint32_t cell, const Value& outer,
                    const Value& inner, Value value) noexcept;
    bool write_leaf_append(const Program& program, uint32_t cell, const Value& outer,
                           Value value, const Value& keep) noexcept;
};

RuntimeState migrate_state(const Program& old_program, const RuntimeState& old_state,
                           const Program& new_program);

} // namespace hmi

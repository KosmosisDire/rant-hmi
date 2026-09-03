#include "state.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace hmi {

namespace {

constexpr uint32_t kDefaultTextCap = 256;

bool same_cell(const CellDef& a, const CellDef& b) {
    return a.kind == b.kind && a.owner_node == b.owner_node && a.name == b.name &&
           a.shape == b.shape && a.owner_flow == b.owner_flow;
}

/* a constant-pool text's content, empty for anything else */
std::string_view constant_text(const Program& program, const Value& value) {
    if (value.tag != ValueTag::Text || (value.ref & kConstantRef) == 0) return {};
    const uint32_t at = value.ref & ~kConstantRef;
    return at < program.texts.size() ? std::string_view(program.texts[at]) : std::string_view{};
}

/* the literal a cell is compiled to start from, if it starts from one */
std::string_view initial_text(const Program& program, const CellDef& cell) {
    return constant_text(program, cell.initial);
}

/* the authored LIST two cells start from, compared by content: each program interns its
 * own texts, so the constants behind them can never be compared by ref */
bool same_run(const Program& old_program, const std::vector<Value>& before,
              const Program& new_program, const std::vector<Value>& after) {
    if (before.size() != after.size()) return false;
    for (size_t i = 0; i < before.size(); ++i) {
        const Value& was = before[i];
        const Value& now = after[i];
        if (was.tag != now.tag) return false;
        if (was.tag == ValueTag::Text) {
            if (constant_text(old_program, was) != constant_text(new_program, now))
                return false;
        } else if (!value_same_scalar(was, now)) {
            return false;
        }
    }
    return true;
}

bool same_list_init(const Program& old_program, const CellDef& before,
                    const Program& new_program, const CellDef& after) {
    if (before.has_list != after.has_list) return false;
    if (!same_run(old_program, before.list_init, new_program, after.list_init)) return false;
    /* the authored ROWS are part of the same start: an edit to one of them moved what the
       slot reads exactly as an edit to a flat element does */
    if (before.row_init.size() != after.row_init.size()) return false;
    for (size_t row = 0; row < before.row_init.size(); ++row)
        if (!same_run(old_program, before.row_init[row], new_program, after.row_init[row]))
            return false;
    return true;
}

/* does one element FIT a cell's DECLARED element shape? Unknown = undeclared (any scalar
 * goes, the untyped list this always was), and Nil always fits — a gap is a value here as
 * everywhere. Icon-typed declarations lower to Text, so the scalar cases cover every
 * declarable one; List and Map are the NESTED declaration, where the element is a row and
 * only a row will do. */
bool elem_fits(Shape elem, ValueTag tag) noexcept {
    if (elem == Shape::Unknown || tag == ValueTag::Nil) return true;
    switch (elem) {
        case Shape::Num: return tag == ValueTag::Num;
        case Shape::Bool: return tag == ValueTag::Bool;
        case Shape::Text: return tag == ValueTag::Text;
        case Shape::Color: return tag == ValueTag::Color || tag == ValueTag::Token;
        case Shape::List: return tag == ValueTag::List;
        case Shape::Map: return tag == ValueTag::Map;
        default: return true;
    }
}

/* Did the DOCUMENT move what this cell reads, such that carrying the old run forward would
 * discard the edit?
 *
 * Only a SLOT can be in that position. A variable's `initial` is its INIT: the value a run
 * STARTS from, which is a different thing from the value it currently holds, so editing the
 * init must leave a running variable alone (test_migration pins this). A slot has no such
 * separation. Where nothing feeds or writes it, the authored constant IS the slot's value,
 * and an edit to it that did not survive the recompile would look like the edit did nothing.
 *
 * A slot the runtime does own still survives: a feed or flow writes it, and an edit
 * elsewhere leaves this cell's compiled constant untouched, so there is nothing to restate. */
bool authored_moved(const Program& old_program, const CellDef& before, const Program& new_program,
                    const CellDef& after) {
    if (after.kind != CellKind::Slot) return false;
    if (before.shape == Shape::List || after.shape == Shape::List ||
        before.shape == Shape::Map || after.shape == Shape::Map)
        return !same_list_init(old_program, before, new_program, after);
    if (before.shape == Shape::Text || after.shape == Shape::Text)
        return initial_text(old_program, before) != initial_text(new_program, after);
    return !value_same_scalar(before.initial, after.initial);
}

} // namespace

FixedText::FixedText(uint32_t capacity) : bytes(std::max<uint32_t>(capacity, 1), '\0') {}

void FixedText::set(std::string_view value) noexcept {
    if (bytes.empty()) {
        length = 0;
        return;
    }
    length = static_cast<uint32_t>(std::min(value.size(), bytes.size() - 1));
    if (length) std::memcpy(bytes.data(), value.data(), length);
    bytes[length] = '\0';
}

std::string_view FixedText::view() const noexcept {
    return bytes.empty() ? std::string_view{} : std::string_view(bytes.data(), length);
}

/* An element costs its Value, and a TEXT element costs the text slot that holds its bytes
 * as well — a position that has ever held text keeps one for the buffer's life. An
 * UNDECLARED element is charged as text because it may become one, which is the honest
 * worst case for a buffer nothing has typed. */
uint32_t buffer_capacity(Shape shape) noexcept {
    const uint64_t per = shape == Shape::Text || shape == Shape::Unknown
                             ? sizeof(Value) + kDefaultTextCap
                             : sizeof(Value);
    const uint64_t fits = kBufferBytes / per;
    return static_cast<uint32_t>(fits > UINT32_MAX ? UINT32_MAX : fits);
}

Host::Host(const Program& program) {
    store.values.resize(program.cells.size(), Value::nil());
    store.texts.reserve(program.layout.cell_texts);
    for (uint32_t i = 0; i < program.layout.cell_texts; ++i)
        store.texts.emplace_back(kDefaultTextCap);

    for (uint32_t i = 0; i < program.cells.size(); ++i) {
        const CellDef& cell = program.cells[i];
        if (cell.shape != Shape::Text) {
            store.values[i] = cell.initial;
            continue;
        }
        const uint32_t slot = cell.text_slot;
        if (slot >= store.texts.size()) continue;
        store.texts[slot] = FixedText(cell.text_cap ? cell.text_cap : kDefaultTextCap);
        if (cell.initial.tag == ValueTag::Text &&
            (cell.initial.ref & kConstantRef) != 0) {
            const uint32_t at = cell.initial.ref & ~kConstantRef;
            if (at < program.texts.size()) store.texts[slot].set(program.texts[at]);
        }
        store.values[i] = Value::text(slot);
    }
    /* mesh-inbound text storage (see the header): the scratch slot, then one retained
     * slot per text-shaped entity field. Delivered strings land in ordinary FixedText
     * slots, so they resolve through the standard text machinery: a feed's store copies
     * them into the destination cell, and a `seed: last` build can re-send them. */
    store.mesh_scratch = static_cast<uint32_t>(store.texts.size());
    store.texts.emplace_back(kDefaultTextCap);
    store.input_scratch = static_cast<uint32_t>(store.texts.size());
    store.texts.emplace_back(kDefaultTextCap);
    store.entity_texts.resize(program.entities.size());
    for (uint32_t e = 0; e < program.entities.size(); ++e) {
        /* the READ side's table: a function's response fields — what a delivery
           carries, what the cache holds, and what a slot expression loads */
        const std::vector<FieldDef>& entity_fields = feed_fields(program.entities[e]);
        store.entity_texts[e].assign(entity_fields.size(), UINT32_MAX);
        for (uint32_t f = 0; f < entity_fields.size(); ++f) {
            if (entity_fields[f].shape != Shape::Text) continue;
            store.entity_texts[e][f] = static_cast<uint32_t>(store.texts.size());
            store.texts.emplace_back(kDefaultTextCap);
        }
    }
    /* retained aggregate storage: one slot per list- or map-shaped cell, born EMPTY and
     * grown to whatever the cell actually holds. A cell carries its aggregate across
     * ticks and the pool above does not survive a run, so the two storages are separate
     * and only this one is stable. Element text slots are appended to `texts` on first
     * use (list_text), after the pool's own run, so nothing above is disturbed. */
    store.lists.resize(program.layout.list_slots);
    /* the MESH AGGREGATE MIRRORS ride the same vector, after the cells' slots: one
       empty retained slot per aggregate-shaped read-side entity field, filled by
       deliveries (hold_entity_agg) and handed out through the last-value cache */
    store.entity_aggs.resize(program.entities.size());
    for (uint32_t e = 0; e < program.entities.size(); ++e) {
        const std::vector<FieldDef>& read_fields = feed_fields(program.entities[e]);
        store.entity_aggs[e].assign(read_fields.size(), UINT32_MAX);
        for (uint32_t f = 0; f < read_fields.size(); ++f) {
            if (read_fields[f].shape != Shape::List && read_fields[f].shape != Shape::Map)
                continue;
            store.entity_aggs[e][f] = static_cast<uint32_t>(store.lists.size());
            store.lists.emplace_back();
        }
    }
    /* EVERY aggregate cell tells its slot what shape it is, authored start or not: the
       storage has to be able to say on its own whether it is nested, because a recompile
       hands migrate the NEW cell table beside the OLD state and the slot being written is
       the only thing in reach that knows */
    for (const CellDef& cell : program.cells) {
        if (cell.shape != Shape::List && cell.shape != Shape::Map) continue;
        if (cell.list_slot >= store.lists.size()) continue;
        store.lists[cell.list_slot].elem = cell.elem;
        store.lists[cell.list_slot].leaf = cell.leaf;
    }
    for (uint32_t i = 0; i < program.cells.size(); ++i) {
        const CellDef& cell = program.cells[i];
        if (!cell.has_list) continue;
        if (cell.shape != Shape::List && cell.shape != Shape::Map) continue;
        const bool pairs = cell.shape == Shape::Map;
        if (cell.list_slot < store.lists.size() && store.lists[cell.list_slot].nested()) {
            seed_nested(program, i, cell);
            continue;
        }
        const uint32_t count = static_cast<uint32_t>(cell.list_init.size());
        hold_list(program, *this, i, cell.list_slot, cell.list_init.data(),
                  pairs ? count / 2 : count, pairs);
        /* a fresh run's baseline is generation ZERO: hold_list bumps gen because a
           whole store is a discontinuity, and there is nothing here to be discontinuous
           from */
        if (cell.list_slot < store.lists.size()) store.lists[cell.list_slot].gen = 0;
    }

    uint32_t max_fields = std::max<uint32_t>(program.layout.max_entity_fields, 1);
    /* declared struct variables' slots: state storage. A flow temporary's slot is
       the frame's, built with it below. */
    const uint32_t state_structs = std::min<uint32_t>(
        program.layout.state_structs, static_cast<uint32_t>(program.structs.size()));
    store.structs.resize(state_structs);
    for (uint32_t i = 0; i < state_structs; ++i) {
        StructState& item = store.structs[i];
        item.type_id = program.structs[i];
        const std::vector<FieldDef>& defs = struct_fields(program, item.type_id);
        const uint32_t n = static_cast<uint32_t>(defs.size());
        /* born UNKNOWN (spec 2.7): a field nobody has set holds Nil, and a move out
         * keeps the owner's bytes for every such field — the authored defaults land
         * over this below */
        item.fields.resize(n, Value::nil());
        item.texts.assign(n, UINT32_MAX);
        for (uint32_t f = 0; f < n; ++f)
            if (defs[f].shape == Shape::Text) {
                item.texts[f] = static_cast<uint32_t>(store.texts.size());
                store.texts.emplace_back(kDefaultTextCap);
            }
    }
    /* THE FRAME: the storage the active run owns. Site text slots first, then the
       frame locals' own field text, then the element text region the cursor deals. */
    exec.frame.stack.resize(std::max<uint32_t>(program.frame.stack, 1), Value::nil());
    exec.frame.texts.reserve(program.frame.texts + program.frame.elem_texts);
    for (uint32_t i = 0; i < program.frame.texts; ++i)
        exec.frame.texts.emplace_back(kDefaultTextCap);
    /* FLOW TEMPORARIES are frame locals: a parked message buffer survives by the
       frame's ownership, and nothing snapshots or restores field by field */
    for (uint32_t i = state_structs; i < program.structs.size(); ++i) {
        StructState item;
        item.type_id = program.structs[i];
        const std::vector<FieldDef>& defs = struct_fields(program, item.type_id);
        const uint32_t n = static_cast<uint32_t>(defs.size());
        item.fields.resize(n, Value::nil());
        item.texts.assign(n, UINT32_MAX);
        for (uint32_t f = 0; f < n; ++f)
            if (defs[f].shape == Shape::Text) {
                item.texts[f] = kFrameRef | static_cast<uint32_t>(exec.frame.texts.size());
                exec.frame.texts.emplace_back(kDefaultTextCap);
            }
        exec.frame.locals.push_back(std::move(item));
    }
    exec.frame.text_base = static_cast<uint32_t>(exec.frame.texts.size());
    exec.frame.text_cursor = exec.frame.text_base;
    for (uint32_t i = 0; i < program.frame.elem_texts; ++i)
        exec.frame.texts.emplace_back(kDefaultTextCap);
    /* and the element pool aggregate-producing sites build into */
    exec.frame.elems.resize(program.frame.elems, Value::nil());

    /* a struct-shaped cell POINTS at its slot: the Value is the handle, the fields
     * live in the slot's own storage, so a cell read pushes something copyable and a
     * field write lands in exactly one place. A declared variable's authored
     * DEFAULTS land over the Unknown; every other field — the aggregates included —
     * stays Nil until something writes it. */
    for (uint32_t i = 0; i < program.cells.size(); ++i) {
        const CellDef& cell = program.cells[i];
        if (cell.shape != Shape::Struct) continue;
        StructState* item = struct_at(cell.struct_slot);
        if (!item) continue;
        store.values[i] = Value::structure(cell.struct_slot, cell.type_id);
        for (const auto& start : cell.struct_init) {
            if (start.first >= item->fields.size()) continue;
            item->fields[start.first] = start.second;
        }
    }

    store.last.resize(program.entities.size());
    for (uint32_t i = 0; i < program.entities.size(); ++i)
        /* sized for BOTH tables: a function's mirror holds its response (what a slot
           expression reads), while ReadEnt walks the value/request table — the wider
           run keeps either read in bounds and the unused tail stays Nil */
        store.last[i].fields.resize(std::max(program.entities[i].fields.size(),
                                       feed_fields(program.entities[i]).size()),
                              Value::nil());

    timers.resize(program.timers.size());
    fired.resize(program.layout.fired_groups, 0);
    exec.pending.resize(program.layout.pending_slots);
    /* every pending site holds a full frame of its own: parking swaps the active
       frame in whole, so a parked run's scratch survives by ownership */
    for (PendingState& item : exec.pending) item.held = exec.frame;
    /* aggregate payload capacity: the widest single entity's aggregate fields decide
       what one effect may have to carry (a map's entries interleave, so 2x pairs) */
    uint32_t agg_values_cap = 0, agg_texts_cap = 0;
    for (const EntityDef& entity : program.entities) {
        uint32_t values_here = 0, texts_here = 0;
        for (const FieldDef& field : entity.fields) {
            if (field.shape != Shape::List && field.shape != Shape::Map) continue;
            const uint32_t bound =
                std::min<uint32_t>(field.bound ? field.bound : kVarrCeiling,
                                   kDeliveryCeiling);
            if (field.shape == Shape::Map) {
                values_here += bound * 2;
                texts_here += bound * 2;
            } else {
                values_here += bound;
                if (field.elem == Shape::Text) texts_here += bound;
            }
        }
        agg_values_cap = std::max(agg_values_cap, values_here);
        agg_texts_cap = std::max(agg_texts_cap, texts_here);
    }
    out.effects.resize(std::max<uint32_t>(program.layout.effect_capacity, 1));
    for (EffectRecord& effect : out.effects) {
        effect.fields.resize(max_fields, Value::nil());
        effect.bare_text = FixedText(kDefaultTextCap);
        effect.field_text.reserve(max_fields);
        for (uint32_t i = 0; i < max_fields; ++i)
            effect.field_text.emplace_back(kDefaultTextCap);
        effect.agg_values.resize(agg_values_cap, Value::nil());
        effect.agg_span.resize(max_fields, {UINT32_MAX, 0});
        effect.agg_texts.reserve(agg_texts_cap);
        for (uint32_t i = 0; i < agg_texts_cap; ++i)
            effect.agg_texts.emplace_back(kDefaultTextCap);
    }
    out.raised.resize(std::max<uint32_t>(program.layout.raise_capacity, 1));
    for (RaisedRecord& record : out.raised) record.text = FixedText(kDefaultTextCap);
    out.notices.resize(std::max<uint32_t>(program.layout.notice_capacity, 1));
    for (NoticeRecord& record : out.notices) record.text = FixedText(kDefaultTextCap);
    out.faults.resize(std::max<size_t>(program.runtime_faults.size(), 1));
    for (uint32_t i = 0; i < program.runtime_faults.size(); ++i)
        out.faults[i].site = i;
}

std::string_view Host::text(const Program& program, const Value& value) const noexcept {
    if (value.tag != ValueTag::Text) return {};
    if ((value.ref & kConstantRef) != 0) {
        const uint32_t at = value.ref & ~kConstantRef;
        return at < program.texts.size() ? std::string_view(program.texts[at]) : std::string_view{};
    }
    /* in flight: the producing site's slot in the active run's frame */
    if ((value.ref & kFrameRef) != 0) {
        const uint32_t at = value.ref & ~kFrameRef;
        return at < exec.frame.texts.size() ? exec.frame.texts[at].view() : std::string_view{};
    }
    return value.ref < store.texts.size() ? store.texts[value.ref].view() : std::string_view{};
}

AggView Host::aggregate(const Value& value) const noexcept {
    const uint32_t count = agg_count(value);
    if (value_retained(value) &&
        (value.tag == ValueTag::List || value.tag == ValueTag::Map)) {
        if (value.ref >= store.lists.size()) return {};
        const ListState& held = store.lists[value.ref];
        /* ONE ROW of a nested cell: its entries are in the slot's LEAF arena at the start
           the value carries, not among the slot's outer entries */
        if (value_row(value)) {
            const uint32_t start = agg_start(value);
            const uint64_t span = static_cast<uint64_t>(count) *
                                  (value.tag == ValueTag::Map ? 2u : 1u);
            if (static_cast<uint64_t>(start) + span > held.leaves.size()) return {};
            return {held.leaves.data() + start, count};
        }
        if (count > held.count) return {};
        return {held.elems.data(), count};
    }
    const uint32_t need = value.tag == ValueTag::Map ? count * 2 : count;
    if (value.ref > exec.frame.elems.size() || need > exec.frame.elems.size() - value.ref) return {};
    return {exec.frame.elems.data() + value.ref, count};
}

uint32_t Store::list_text(ListState& held, uint32_t at) noexcept {
    /* a map's entries interleave, so the widest position an aggregate can name is twice
       its entry budget: one text slot per key AND one per text value */
    if (at >= static_cast<uint64_t>(held.capacity()) * 2) return UINT32_MAX;
    while (held.texts.size() <= at) {
        held.texts.push_back(static_cast<uint32_t>(texts.size()));
        texts.emplace_back(kDefaultTextCap);
    }
    return held.texts[at];
}

/* Move one entry within a retained slot, text and all: the value copies, and a TEXT
 * value's bytes move into the destination POSITION's own slot, because element text is
 * homed per position. Erasing shifts DOWN (ascending destinations) and inserting shifts
 * UP (descending), which is what keeps a source from being overwritten before it is read. */
void Store::move_entry(ListState& held, uint32_t dst, uint32_t src) noexcept {
    if (dst == src || src >= held.elems.size() || dst >= held.elems.size()) return;
    Value value = held.elems[src];
    if (value.tag == ValueTag::Text) {
        const uint32_t slot = list_text(held, dst);
        if (slot != UINT32_MAX && value.ref < texts.size()) {
            texts[slot].set(texts[value.ref].view());
            value = Value::text(slot);
        }
    }
    held.elems[dst] = value;
}

uint32_t Store::leaf_text(ListState& held, uint32_t at) noexcept {
    if (at >= static_cast<uint64_t>(held.leaf_capacity()) * 2) return UINT32_MAX;
    while (held.leaf_texts.size() <= at) {
        held.leaf_texts.push_back(static_cast<uint32_t>(texts.size()));
        texts.emplace_back(kDefaultTextCap);
    }
    return held.leaf_texts[at];
}

void Store::move_leaf(ListState& held, uint32_t dst, uint32_t src) noexcept {
    if (dst == src || src >= held.leaves.size() || dst >= held.leaves.size()) return;
    Value value = held.leaves[src];
    if (value.tag == ValueTag::Text) {
        const uint32_t slot = leaf_text(held, dst);
        if (slot != UINT32_MAX && value.ref < texts.size()) {
            texts[slot].set(texts[value.ref].view());
            value = Value::text(slot);
        }
    }
    held.leaves[dst] = value;
}

namespace {

/* where a row's own entry sits among the outer ones: a nested map keeps its keys
 * interleaved exactly as a flat one does, so the row rides beside its key */
inline uint32_t row_at(uint32_t row, bool pairs) noexcept { return pairs ? row * 2 + 1 : row; }

/* leaf POSITIONS one row occupies for `count` entries (a map row interleaves) */
inline uint32_t row_span(uint32_t count, bool row_pairs) noexcept {
    return row_pairs ? count * 2 : count;
}

/* Collect the holes relocation leaves behind: slide every live extent down onto a running
 * cursor and re-point its row at where it landed. The extents are walked in START order,
 * never row order — a relocated row sits at the tail while later rows still sit below it,
 * and sliding out of order would write over an extent that has not been read yet. */
void compact_leaves(Host& state, ListState& held, bool pairs) noexcept {
    std::vector<uint32_t> order;
    order.reserve(held.count);
    for (uint32_t row = 0; row < held.count; ++row) {
        const Value& entry = held.elems[row_at(row, pairs)];
        if (entry.tag == ValueTag::List || entry.tag == ValueTag::Map) order.push_back(row);
    }
    std::sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) {
        return agg_start(held.elems[row_at(a, pairs)]) <
               agg_start(held.elems[row_at(b, pairs)]);
    });
    uint32_t cursor = 0;
    for (uint32_t row : order) {
        Value& entry = held.elems[row_at(row, pairs)];
        const uint32_t start = agg_start(entry);
        const uint32_t count = agg_count(entry);
        const bool row_pairs = entry.tag == ValueTag::Map;
        const uint32_t used = row_span(count, row_pairs);
        if (start != cursor)
            for (uint32_t i = 0; i < used; ++i) state.store.move_leaf(held, cursor + i, start + i);
        entry = Value::retained_row(entry.ref, cursor, count, list_elem_tag(entry), row_pairs);
        cursor += row < held.row_cap.size() ? held.row_cap[row] : used;
    }
    held.leaf_used = cursor;
    held.leaf_live = cursor;
}

/* Is there room at the arena's tail for `span` more leaves, compacting when that is what
 * it takes? The holes a relocation leaves are collected once they have grown past what is
 * LIVE — amortized O(1) per append, since a compaction costs the live extent and only runs
 * when the holes have matched it — and again at the budget itself, where collecting them is
 * the only way to make room. The small-arena floor keeps a three-element buffer from
 * sorting and reallocating on every append for no gain. */
bool arena_room(Host& state, ListState& held, bool pairs, uint32_t span) noexcept {
    const uint64_t arena = held.leaf_capacity();
    const uint32_t holes = held.leaf_used - held.leaf_live;
    if (static_cast<uint64_t>(held.leaf_used) + span > arena ||
        (held.leaf_used > 64 && holes > held.leaf_live))
        compact_leaves(state, held, pairs);
    return static_cast<uint64_t>(held.leaf_used) + span <= arena;
}

/* Make room for `want` ENTRIES in row `row` and answer where its entries now start. A row
 * still inside its capacity does not move at all — which is what makes an append into a
 * settled row free — and one that has outgrown it is relocated whole to the tail with its
 * capacity doubled, paying its own length rather than every later row's. */
uint32_t reserve_row(Host& state, ListState& held, uint32_t row, bool pairs,
                     uint32_t want) noexcept {
    if (row >= held.count || row >= held.row_cap.size()) return UINT32_MAX;
    const bool row_pairs = held.elems[row_at(row, pairs)].tag == ValueTag::Map;
    const uint32_t need = row_span(want, row_pairs);
    const uint32_t was = held.row_cap[row];
    if (need <= was) return agg_start(held.elems[row_at(row, pairs)]);
    /* THE ARENA IS ITS OWN BUFFER with its own budget: leaves are not entries of the list
       and never spend the room its rows are counted in */
    const uint32_t arena = held.leaf_capacity();
    if (held.leaf_live - was + need > arena) return UINT32_MAX;
    uint32_t cap = was ? was * 2 : 4;
    while (cap < need) cap *= 2;
    if (cap > arena) cap = arena;
    if (!arena_room(state, held, pairs, cap)) return UINT32_MAX;
    Value& entry = held.elems[row_at(row, pairs)];
    const uint32_t start = agg_start(entry);
    const uint32_t used = row_span(agg_count(entry), row_pairs);
    const uint32_t dst = held.leaf_used;
    if (held.leaves.size() < dst + cap) held.leaves.resize(dst + cap, Value::nil());
    for (uint32_t i = 0; i < used; ++i) state.store.move_leaf(held, dst + i, start + i);
    held.leaf_used = dst + cap;
    held.leaf_live = held.leaf_live - was + cap;
    held.row_cap[row] = cap;
    entry = Value::retained_row(entry.ref, dst, agg_count(entry), list_elem_tag(entry),
                                row_pairs);
    return dst;
}

/* give up a row's extent: the capacity becomes hole and the entry stops naming it */
void release_row(ListState& held, uint32_t row, bool pairs) noexcept {
    if (row >= held.row_cap.size()) return;
    held.leaf_live -= held.row_cap[row];
    held.row_cap[row] = 0;
    if (row_at(row, pairs) < held.elems.size())
        held.elems[row_at(row, pairs)] = Value::nil();
}

/* WHICH ROW an outer address names: a nested list is addressed by number index, a nested
 * map by text key, each exactly as the cell itself is. UINT32_MAX where the address is the
 * wrong kind or names no row — a row is grown by writing the OUTER entry, never by
 * reaching into a position that is not there. */
uint32_t find_row(const Program& program, const Host& state, const ListState& held,
                  bool pairs, const Value& outer) noexcept {
    if (pairs) {
        if (outer.tag != ValueTag::Text) return UINT32_MAX;
        const std::string_view wanted = state.text(program, outer);
        for (uint32_t row = 0; row < held.count; ++row)
            if (state.text(program, held.elems[row * 2]) == wanted) return row;
        return UINT32_MAX;
    }
    if (outer.tag != ValueTag::Num || !(outer.data.num >= 0.0)) return UINT32_MAX;
    const uint32_t at = static_cast<uint32_t>(outer.data.num);
    return at < held.count ? at : UINT32_MAX;
}

/* the window `keep` asks a ring to hold, or UINT32_MAX where it asks for none: floored, at
 * least one, never past what the buffer can hold — NaN lands on one beside the negatives */
uint32_t keep_window(const Value& keep, uint32_t cap) noexcept {
    if (keep.tag != ValueTag::Num) return UINT32_MAX;
    double wanted = std::floor(keep.data.num);
    if (!(wanted >= 1.0)) wanted = 1.0;
    if (wanted > static_cast<double>(cap)) wanted = cap;
    return static_cast<uint32_t>(wanted);
}

/* Trim a LIST cell's window to `window` entries from the FRONT, which is the whole of what
 * `keep` does. A nested cell gives up the dropped rows' extents on the way past — a
 * released extent is the arena's only notice that a row has gone. */
void trim_front(Host& state, ListState& held, uint32_t window) noexcept {
    if (window == UINT32_MAX || held.count <= window) return;
    const uint32_t drop = held.count - window;
    if (held.nested()) {
        for (uint32_t row = 0; row < drop; ++row) release_row(held, row, false);
        held.row_cap.erase(held.row_cap.begin(), held.row_cap.begin() + drop);
    }
    for (uint32_t i = 0; i + drop < held.count; ++i) state.store.move_entry(held, i, i + drop);
    held.count = window;
}

/* Copy ONE row's entries into the arena at row `row`, text and all.
 *
 * The extent always lands at the TAIL. A whole-row store is not the hot path — an append
 * into a settled row is, and that one does not move anything — and taking fresh ground is
 * what lets this read its source while it writes: nothing it is copying FROM can be the
 * ground it is copying ONTO. The row's old extent becomes hole for the next compaction.
 *
 * The source may live anywhere the caller can name — the run's scratch pool, another
 * cell's arena, the state being retired at a recompile — so text resolves through the
 * PAIR it came from. A source inside THIS arena is the one thing that cannot be handled
 * here and is staged through the scratch pool before it arrives (stage_row).
 *
 * A map row is re-sorted by key for the reason the outer map is: deterministic iteration
 * is what keeps a replay byte-identical. */
bool place_row(Host& state, const Program& source_program, const Host& source,
               ListState& held, uint32_t list_slot, uint32_t row, bool pairs,
               const Value* data, uint32_t count, bool row_pairs, Shape leaf) noexcept {
    if (row >= held.row_cap.size() || row_at(row, pairs) >= held.elems.size()) return false;
    const uint32_t arena = held.leaf_capacity();
    if (count > arena || (!data && count)) return false;
    const uint32_t span = row_span(count, row_pairs);
    /* a declared leaf shape is a promise this level keeps too: one foreign element refuses
       the whole row, exactly as it refuses a whole flat store. A map row's KEYS are text
       by construction; its values are what the check walks. */
    for (uint32_t i = row_pairs ? 1u : 0u; i < span; i += row_pairs ? 2u : 1u)
        if (!elem_fits(leaf, data[i].tag)) return false;
    const uint32_t was = held.row_cap[row];
    /* the arena's own budget, never the outer list's: a row is not an entry of the list it
       sits in, so its leaves cost the list nothing */
    if (held.leaf_live - was + span > arena) return false;
    if (!arena_room(state, held, pairs, span)) return false;
    const uint32_t dst = held.leaf_used;
    if (held.leaves.size() < dst + span) held.leaves.resize(dst + span, Value::nil());
    for (uint32_t i = 0; i < span; ++i) held.leaves[dst + i] = data[i];
    if (row_pairs)
        for (uint32_t i = 1; i < count; ++i) {
            const Value key = held.leaves[dst + i * 2];
            const Value value = held.leaves[dst + i * 2 + 1];
            const std::string_view text_key = source.text(source_program, key);
            uint32_t j = i;
            while (j > 0 &&
                   text_key < source.text(source_program, held.leaves[dst + (j - 1) * 2])) {
                held.leaves[dst + j * 2] = held.leaves[dst + (j - 1) * 2];
                held.leaves[dst + j * 2 + 1] = held.leaves[dst + (j - 1) * 2 + 1];
                --j;
            }
            held.leaves[dst + j * 2] = key;
            held.leaves[dst + j * 2 + 1] = value;
        }
    for (uint32_t i = 0; i < span; ++i) {
        if (held.leaves[dst + i].tag != ValueTag::Text) continue;
        const uint32_t slot = state.store.leaf_text(held, dst + i);
        if (slot == UINT32_MAX) return false;
        /* a slot index only means the same storage when the source IS this run: across
           two states the same number names two different buffers, so the copy stands */
        if (&source != &state || held.leaves[dst + i].ref != slot)
            state.store.texts[slot].set(source.text(source_program, held.leaves[dst + i]));
        held.leaves[dst + i] = Value::text(slot);
    }
    held.leaf_used = dst + span;
    held.leaf_live = held.leaf_live - was + span;
    held.row_cap[row] = span;
    ValueTag tag = ValueTag::Nil;
    bool uniform = count != 0;
    for (uint32_t i = 0; i < count; ++i) {
        const ValueTag here = held.leaves[dst + row_span(i, row_pairs) +
                                          (row_pairs ? 1u : 0u)].tag;
        if (i == 0) tag = here;
        else if (here != tag) uniform = false;
    }
    held.elems[row_at(row, pairs)] =
        Value::retained_row(list_slot, dst, count, uniform ? tag : ValueTag::Nil, row_pairs);
    return true;
}

/* A row taken from the very cell being written (`grid[0] = grid[1]`), copied into the
 * run's scratch pool first. Nothing else can be said honestly about such a source: the
 * write is free to relocate extents and re-home text inside this arena, and a view into
 * it taken beforehand would be describing storage that has since moved. */
Value stage_row(Host& state, const Program& program, const Value& value) noexcept {
    const AggView view = state.aggregate(value);
    const bool row_pairs = value.tag == ValueTag::Map;
    const uint32_t span = row_span(view.count, row_pairs);
    const uint32_t at = state.exec.frame.alloc(span);
    if (at == UINT32_MAX) return Value::nil();
    for (uint32_t i = 0; i < span; ++i) {
        Value entry = view.data[i];
        if (entry.tag == ValueTag::Text) {
            const uint32_t slot = state.exec.frame.alloc_text();
            if (slot == UINT32_MAX) return Value::nil();
            state.exec.frame.texts[slot].set(state.text(program, entry));
            entry = Value::text(kFrameRef | slot);
        }
        state.exec.frame.elems[at + i] = entry;
    }
    return row_pairs ? Value::map(at, view.count)
                     : Value::list(at, view.count, list_elem_tag(value));
}

/* the same staging, applied only where it is needed: a source that names THIS slot */
Value settled_row(Host& state, const Program& program, uint32_t list_slot,
                  const Value& value) noexcept {
    if (!value_retained(value) || value.ref != list_slot) return value;
    return stage_row(state, program, value);
}

} // namespace

/* the Value a cell holds for its retained slot: the element tag is only meaningful when
 * every element agrees, which is what an aggregate reader checks before trusting it */
static Value retained_value(const ListState& held, uint32_t list_slot, bool pairs) {
    if (pairs) return Value::retained_map(list_slot, held.count);
    ValueTag elem = ValueTag::Nil;
    bool uniform = held.count != 0;
    for (uint32_t i = 0; i < held.count; ++i) {
        if (i == 0) elem = held.elems[i].tag;
        else if (held.elems[i].tag != elem) uniform = false;
    }
    return Value::retained_list(list_slot, held.count, uniform ? elem : ValueTag::Nil);
}

bool Host::hold_list(const Program& source_program, const Host& source,
                             uint32_t cell_index, uint32_t list_slot, const Value* data,
                             uint32_t count, bool pairs) noexcept {
    if (list_slot >= store.lists.size() || cell_index >= store.values.size()) return false;
    ListState& held = store.lists[list_slot];
    if (count > held.capacity()) count = held.capacity();
    if (!data && count) return false;
    /* grow to what this store actually holds, once; a slot that only ever carries three
       options never carries the ceiling's worth of Values. A map's entries interleave,
       so the run is twice its pair count. */
    const uint32_t span = pairs ? count * 2 : count;
    if (held.elems.size() < span) held.elems.resize(span, Value::nil());
    for (uint32_t i = 0; i < span; ++i) held.elems[i] = data[i];
    /* A ROW OF THIS VERY SLOT is copied into the scratch pool before the arena below is
       disturbed (`grid = [grid[1], grid[0]]`): the placement writes at the arena's tail
       and may compact it, and a source inside the ground being written cannot be read
       honestly. Only a store made by THIS run can be in that position — another state's
       slot index names another state's storage. */
    if (held.nested() && &source == this)
        for (uint32_t row = 0; row < count; ++row) {
            Value& entry = held.elems[row_at(row, pairs)];
            if (!value_retained(entry) || entry.ref != list_slot) continue;
            entry = stage_row(*this, source_program, entry);
            if (entry.tag == ValueTag::Nil) return false;
        }
    /* A MAP arrives in whatever order its source built it (a mesh delivery is arrival
       order), and a retained map is SORTED BY KEY: insertion sort over the pairs, in
       place, before any text is re-homed — the values still point at the source's own
       storage here, so a swap costs nothing but a Value copy. */
    if (pairs)
        for (uint32_t i = 1; i < count; ++i) {
            const Value key = held.elems[i * 2];
            const Value value = held.elems[i * 2 + 1];
            const std::string_view text_key = source.text(source_program, key);
            uint32_t j = i;
            while (j > 0 &&
                   text_key < source.text(source_program, held.elems[(j - 1) * 2])) {
                held.elems[j * 2] = held.elems[(j - 1) * 2];
                held.elems[j * 2 + 1] = held.elems[(j - 1) * 2 + 1];
                --j;
            }
            held.elems[j * 2] = key;
            held.elems[j * 2 + 1] = value;
        }
    for (uint32_t i = 0; i < span; ++i) {
        if (held.elems[i].tag != ValueTag::Text) continue;
        const uint32_t slot = store.list_text(held, i);
        if (slot == UINT32_MAX) return false;
        /* a slot index only means the same storage when the source IS this run: across
           two states the same number names two different buffers, so the copy stands */
        if (&source != this || held.elems[i].ref != slot)
            store.texts[slot].set(source.text(source_program, held.elems[i]));
        held.elems[i] = Value::text(slot);
    }
    held.count = count;
    /* THE ROWS, where the cell declares any. A whole store replaces every one of them, so
       the arena starts over: every old extent goes at once and the placements below lay
       the new ones down from the bottom. The leaf TEXT slots stay allocated and are
       reused by position, exactly as the outer entries' are. */
    if (held.nested()) {
        held.leaf_used = 0;
        held.leaf_live = 0;
        held.row_cap.assign(count, 0);
        for (uint32_t row = 0; row < count; ++row) {
            const Value entry = held.elems[row_at(row, pairs)];
            if (entry.tag != ValueTag::List && entry.tag != ValueTag::Map) {
                /* an UNKNOWN row is a value like any other gap: the entry reads Nil and
                   holds no extent. Anything that is not an aggregate at all refuses. */
                held.elems[row_at(row, pairs)] = Value::nil();
                if (entry.tag != ValueTag::Nil) return false;
                continue;
            }
            if (held.row_pairs() != (entry.tag == ValueTag::Map)) return false;
            const AggView view = source.aggregate(entry);
            if (!place_row(*this, source_program, source, held, list_slot, row, pairs,
                           view.data, view.count, held.row_pairs(), held.leaf))
                return false;
        }
    }
    /* a whole store is a DISCONTINUITY: the wire cannot describe it as appends, so the
       generation moves and the append cursor restarts at what is now there */
    ++held.gen;
    held.total = count;
    store.values[cell_index] = retained_value(held, list_slot, pairs);
    return true;
}

void Host::seed_nested(const Program& program, uint32_t cell_index,
                               const CellDef& cell) noexcept {
    if (cell.list_slot >= store.lists.size() || cell_index >= store.values.size()) return;
    ListState& held = store.lists[cell.list_slot];
    const bool pairs = cell.shape == Shape::Map;
    const bool row_pairs = cell.elem == Shape::Map;
    uint32_t count = static_cast<uint32_t>(cell.row_init.size());
    if (count > held.capacity()) count = held.capacity();
    const uint32_t span = pairs ? count * 2 : count;
    if (held.elems.size() < span) held.elems.resize(span, Value::nil());
    for (uint32_t i = 0; i < span; ++i) held.elems[i] = Value::nil();
    held.leaf_used = 0;
    held.leaf_live = 0;
    held.row_cap.assign(count, 0);
    held.count = count;
    for (uint32_t row = 0; row < count; ++row) {
        /* a nested map's KEYS ride `list_init` interleaved exactly as a flat map's do, so
           the document's own sorted order lands unchanged and the value beside each key is
           the row placed below */
        if (pairs) {
            const uint32_t key_at = row * 2;
            const Value key =
                key_at < cell.list_init.size() ? cell.list_init[key_at] : Value::nil();
            const uint32_t slot = store.list_text(held, key_at);
            if (slot == UINT32_MAX) break;
            store.texts[slot].set(text(program, key));
            held.elems[key_at] = Value::text(slot);
        }
        const std::vector<Value>& elements = cell.row_init[row];
        const uint32_t entries =
            static_cast<uint32_t>(elements.size()) / (row_pairs ? 2u : 1u);
        place_row(*this, program, *this, held, cell.list_slot, row, pairs, elements.data(),
                  entries, row_pairs, cell.leaf);
    }
    /* a fresh run's baseline is generation ZERO: there is nothing here to be
       discontinuous from */
    held.gen = 0;
    held.total = count;
    store.values[cell_index] = retained_value(held, cell.list_slot, pairs);
}

Value Store::hold_entity_agg(uint32_t list_slot, const Value* data,
                                    const std::string_view* elem_texts,
                                    uint32_t delivered, bool pairs, ValueTag elem,
                                    uint32_t bound) noexcept {
    if (list_slot >= lists.size()) return Value::nil();
    if (!data && delivered) return Value::nil();
    ListState& held = lists[list_slot];
    const uint32_t width = pairs ? 2u : 1u;
    uint32_t count = delivered / width;
    const uint32_t limit = std::min(bound ? bound : kVarrCeiling, kDeliveryCeiling);
    if (count > limit) count = limit;   /* the ceiling: truncate, never overrun */
    const uint32_t span = count * width;
    if (held.elems.size() < span) held.elems.resize(span, Value::nil());

    /* A MAP arrives in the owner's own order and a retained map is SORTED BY KEY: the
       order is decided over the delivery's key views (still valid here), then the
       entries land already in place — text is homed per POSITION, so deciding the
       order first is what keeps each key's bytes from being copied twice. */
    uint32_t order[kDeliveryCeiling];
    if (pairs) {
        for (uint32_t i = 0; i < count; ++i) order[i] = i;
        auto key_of = [&](uint32_t pair) {
            const Value& key = data[pair * 2];
            return key.tag == ValueTag::Text && elem_texts ? elem_texts[pair * 2]
                                                           : std::string_view{};
        };
        for (uint32_t i = 1; i < count; ++i) {
            const uint32_t held_index = order[i];
            uint32_t j = i;
            while (j > 0 && key_of(held_index) < key_of(order[j - 1])) {
                order[j] = order[j - 1];
                --j;
            }
            order[j] = held_index;
        }
    }

    for (uint32_t at = 0; at < span; ++at) {
        const uint32_t from = pairs ? order[at / 2] * 2 + (at & 1u) : at;
        Value element = data[from];
        if (element.tag == ValueTag::Text) {
            const uint32_t slot = list_text(held, at);
            if (slot == UINT32_MAX) return Value::nil();
            texts[slot].set(elem_texts ? elem_texts[from] : std::string_view{});
            element = Value::text(slot);
        }
        held.elems[at] = element;
    }
    held.count = count;
    /* a mirror is not on the wire, so its generation only has to keep moving */
    ++held.gen;
    held.total = count;
    return pairs ? Value::retained_map(list_slot, count)
                 : Value::retained_list(list_slot, count, elem);
}

bool Host::write_append(const Program& program, uint32_t cell_index, Value value,
                                const Value& keep) noexcept {
    if (cell_index >= store.values.size() || cell_index >= program.cells.size()) return false;
    const CellDef& cell = program.cells[cell_index];
    if (cell.shape != Shape::List || cell.list_slot >= store.lists.size()) return false;
    /* a struct is not an element on any tier: it has no wire form here and no leaf shape
       could describe it */
    if (value.tag == ValueTag::Struct) return false;
    /* a declared element type is a promise the runtime keeps: what the compiler could
       not see (x, a mesh read) is refused here, loudly, at the write. A NESTED cell
       declares list or map, so its append takes a whole ROW and nothing else — and an
       undeclared cell still takes only scalars, because a row with no declared shape
       would be a nesting nobody wrote down. */
    if (!elem_fits(cell.elem, value.tag)) return false;
    ListState& held = store.lists[cell.list_slot];
    if (!held.nested() && (value.tag == ValueTag::List || value.tag == ValueTag::Map))
        return false;
    /* the runaway case: with nothing bounding the ring, the buffer's own budget is the
       only answer, and it refuses rather than silently dropping the oldest sample */
    if (keep.tag != ValueTag::Num && held.count >= held.capacity()) return false;
    if (held.nested()) return write_row(program, cell_index, value, keep);
    /* the element tag is a HINT and it is tracked, not recomputed: a ring appends every
       tick, and rescanning four thousand elements for a fact one comparison settles is
       exactly the per-tick cost this tier does not pay. Mixed reads as Nil, which is
       what a scan would have reported anyway. */
    const Value& current = store.values[cell_index];
    const ValueTag was = current.tag == ValueTag::List && held.count
                             ? list_elem_tag(current)
                             : value.tag;
    if (value.tag == ValueTag::Text) {
        const uint32_t slot = store.list_text(held, held.count);
        if (slot == UINT32_MAX) return false;
        if (value.ref != slot) store.texts[slot].set(text(program, value));
        value = Value::text(slot);
    }
    /* push_back only where the slot has not yet reached its working width: once a ring
       is full every further append writes in place, which is what makes a cadence flow
       allocation-free in steady state */
    if (held.count < held.elems.size()) held.elems[held.count] = value;
    else held.elems.push_back(value);
    ++held.count;
    ++held.total;
    trim_front(*this, held, keep_window(keep, held.capacity()));
    store.values[cell_index] = Value::retained_list(
        cell.list_slot, held.count, was == value.tag ? was : ValueTag::Nil);
    return true;
}

/* APPEND ONE ROW to a nested list cell. The outer entry is grown exactly as a scalar
 * append grows one — an entry, a capacity, a cursor — and the row's own elements are laid
 * into the arena beside every other row's. A Nil row appends as a Nil entry with no extent
 * at all, which is the same gap a Nil scalar leaves and reads the same way. */
bool Host::write_row(const Program& program, uint32_t cell_index, Value value,
                             const Value& keep) noexcept {
    const CellDef& cell = program.cells[cell_index];
    ListState& held = store.lists[cell.list_slot];
    if (value.tag != ValueTag::Nil && held.row_pairs() != (value.tag == ValueTag::Map))
        return false;
    /* a row of THIS slot is staged before the arena can move under it */
    if (value_retained(value) && value.ref == cell.list_slot) {
        value = stage_row(*this, program, value);
        if (value.tag == ValueTag::Nil) return false;
    }
    const Value& current = store.values[cell_index];
    const ValueTag was = current.tag == ValueTag::List && held.count
                             ? list_elem_tag(current)
                             : value.tag;
    const uint32_t row = held.count;
    if (held.elems.size() <= row) held.elems.resize(row + 1, Value::nil());
    held.elems[row] = Value::nil();
    held.row_cap.resize(row + 1, 0);
    ++held.count;
    if (value.tag != ValueTag::Nil) {
        const AggView view = aggregate(value);
        if (!place_row(*this, program, *this, held, cell.list_slot, row, false, view.data,
                       view.count, held.row_pairs(), held.leaf)) {
            /* the entry never happened: an arena that could not take the row must not
               leave a row behind that names nothing */
            --held.count;
            held.row_cap.resize(row);
            return false;
        }
    }
    ++held.total;
    trim_front(*this, held, keep_window(keep, held.capacity()));
    store.values[cell_index] = Value::retained_list(
        cell.list_slot, held.count, was == value.tag ? was : ValueTag::Nil);
    return true;
}

bool Host::write_key(const Program& program, uint32_t cell_index, const Value& key,
                             Value value) noexcept {
    if (cell_index >= store.values.size() || cell_index >= program.cells.size()) return false;
    const CellDef& cell = program.cells[cell_index];
    if (cell.shape != Shape::Map || cell.list_slot >= store.lists.size()) return false;
    if (key.tag != ValueTag::Text) return false;
    if (value.tag == ValueTag::Struct) return false;
    /* Nil ERASES below, so it passes; anything else must fit the declared value shape —
       which is a whole ROW where the cell declares a nested one */
    if (!elem_fits(cell.elem, value.tag)) return false;
    ListState& held = store.lists[cell.list_slot];
    if (!held.nested() && (value.tag == ValueTag::List || value.tag == ValueTag::Map))
        return false;
    if (held.nested() && value.tag != ValueTag::Nil) {
        if (held.row_pairs() != (value.tag == ValueTag::Map)) return false;
        /* a row of THIS slot is staged before the arena can move under it */
        if (value_retained(value) && value.ref == cell.list_slot) {
            value = stage_row(*this, program, value);
            if (value.tag == ValueTag::Nil) return false;
        }
    }
    /* the key is copied out before anything below can grow `texts` and move the slot it
       was resolved from; a key is one text value, so one buffer is the whole cost */
    char buffer[kDefaultTextCap];
    const std::string_view source = text(program, key);
    const size_t length = std::min(source.size(), sizeof(buffer));
    if (length) std::memcpy(buffer, source.data(), length);
    const std::string_view wanted(buffer, length);

    uint32_t at = 0;
    bool found = false;
    while (at < held.count) {
        const std::string_view here = text(program, held.elems[at * 2]);
        if (here == wanted) { found = true; break; }
        if (wanted < here) break;
        ++at;
    }

    /* Nil ERASES: a map's only removal verb, so "absent" and "UNKNOWN here" cannot both
       be spelled. Erasing a key that is not there is not a failure, it is already done. */
    if (value.tag == ValueTag::Nil) {
        if (!found) return true;
        /* the erased key's row goes with it: an extent nothing names is a hole, and the
           arena has no other way to hear that it was let go */
        if (held.nested()) {
            release_row(held, at, true);
            held.row_cap.erase(held.row_cap.begin() + at);
        }
        for (uint32_t p = at * 2; p + 2 < held.count * 2; ++p) store.move_entry(held, p, p + 2);
        --held.count;
        ++held.total;
        store.values[cell_index] = Value::retained_map(cell.list_slot, held.count);
        return true;
    }

    if (!found) {
        /* a map has no keep, so a runaway one is a bug by construction rather than a
           window that needs trimming */
        if (held.count >= held.capacity()) return false;
        const uint32_t span = (held.count + 1) * 2;
        if (held.elems.size() < span) held.elems.resize(span, Value::nil());
        for (uint32_t p = span; p-- > at * 2 + 2;) store.move_entry(held, p, p - 2);
        ++held.count;
        /* the shifted-up copy at the new pair still names the row BELOW it; the entry is
           blank until the placement writes it, and its capacity starts at nothing */
        if (held.nested()) {
            held.elems[at * 2 + 1] = Value::nil();
            held.row_cap.insert(held.row_cap.begin() + at, 0);
        }
        const uint32_t slot = store.list_text(held, at * 2);
        if (slot == UINT32_MAX) return false;
        store.texts[slot].set(wanted);
        held.elems[at * 2] = Value::text(slot);
    }
    if (held.nested()) {
        const AggView view = aggregate(value);
        if (!place_row(*this, program, *this, held, cell.list_slot, at, true, view.data,
                       view.count, held.row_pairs(), held.leaf))
            return false;
        ++held.total;
        store.values[cell_index] = Value::retained_map(cell.list_slot, held.count);
        return true;
    }
    if (value.tag == ValueTag::Text) {
        const uint32_t slot = store.list_text(held, at * 2 + 1);
        if (slot == UINT32_MAX) return false;
        if (value.ref != slot) store.texts[slot].set(text(program, value));
        value = Value::text(slot);
    }
    held.elems[at * 2 + 1] = value;
    ++held.total;
    store.values[cell_index] = Value::retained_map(cell.list_slot, held.count);
    return true;
}

/* wire-visible equality between two aggregate elements, each resolved through the same
   run: what the aggs lane would serialize identically is what counts as unchanged */
static bool same_element(const Program& program, const Host& state,
                         const Value& a, const Value& b) noexcept {
    if (a.tag != b.tag) return false;
    switch (a.tag) {
        case ValueTag::Nil: return true;
        case ValueTag::Num:
            return a.data.num == b.data.num ||
                   (std::isnan(a.data.num) && std::isnan(b.data.num));
        case ValueTag::Bool: return a.data.boolean == b.data.boolean;
        case ValueTag::Enum:
            return a.data.integer == b.data.integer && a.type_id == b.type_id;
        case ValueTag::Color: return a.data.rgba == b.data.rgba;
        case ValueTag::Token: return a.ref == b.ref;
        case ValueTag::Text: return state.text(program, a) == state.text(program, b);
        case ValueTag::List:
        case ValueTag::Map: {
            /* TWO ROWS are the same when the wire would serialise them the same. The walk
               goes exactly one level, because there is exactly one level: a row holds
               scalars, so the recursion below bottoms out on the cases above. */
            const AggView left = state.aggregate(a);
            const AggView right = state.aggregate(b);
            if (left.count != right.count || (!left.data && left.count) ||
                (!right.data && right.count))
                return false;
            const uint32_t span = a.tag == ValueTag::Map ? left.count * 2 : left.count;
            for (uint32_t i = 0; i < span; ++i)
                if (!same_element(program, state, left.data[i], right.data[i])) return false;
            return true;
        }
        default: return false;
    }
}

bool Host::write_whole(const Program& program, uint32_t cell_index,
                               const Value& value) noexcept {
    if (cell_index >= store.values.size()) return false;
    const CellDef& cell = program.cells[cell_index];
    /* a struct cell's Value is its handle and is fixed for the run: it is filled by New
     * or ReadEnt and edited field by field, never replaced wholesale */
    if (cell.shape == Shape::Struct) return false;
    if (cell.shape != value_shape(value) && value.tag != ValueTag::Nil) return false;
    /* An AGGREGATE cell is written WHOLE and keeps what it was given: the entries are
     * copied out of wherever they were built into the cell's own retained slot, because
     * what built them (the scratch pool) is reused by the very next run. Appending and
     * keyed writes are their own places and modes; this is replacement. */
    if (cell.shape == Shape::List || cell.shape == Shape::Map) {
        const bool pairs = cell.shape == Shape::Map;
        if (value.tag == ValueTag::Nil) {
            /* already UNKNOWN: re-storing Nil every tick (a computed binding whose
               expression keeps failing) is not a change the wire should see */
            if (store.values[cell_index].tag == ValueTag::Nil) return true;
            /* CLEARED is a discontinuity like any other whole store, and the wire has to
               see it as one: the cell reads UNKNOWN and its generation moves */
            if (cell.list_slot < store.lists.size()) {
                ListState& held = store.lists[cell.list_slot];
                held.count = 0;
                ++held.gen;
                held.total = 0;
                /* the rows go with the entries: an extent nothing names is hole, and an
                   arena still counting the cleared rows as live would refuse the next
                   append for room it is actually holding */
                held.row_cap.clear();
                held.leaf_used = 0;
                held.leaf_live = 0;
            }
            store.values[cell_index] = Value::nil();
            return true;
        }
        /* a cell fed from its own value: the copy would read the slot it is writing, so
           there is nothing to do and everything to get wrong. A ROW of the same slot is
           NOT that — `grid = grid[0]` is a real (and refused) reshape, not a no-op — so
           the shortcut is the whole cell's alone. */
        if (value_retained(value) && !value_row(value) && value.ref == cell.list_slot) {
            store.values[cell_index] = value;
            return true;
        }
        const AggView view = aggregate(value);
        /* a DECLARED element type holds for a whole store too: one foreign element
           refuses the whole picture, exactly as a wrong-shaped scalar refuses above —
           a typed buffer must not be replaceable by what it could never have grown into.
           A map's keys are text by construction; its VALUES are what the check walks. */
        if (cell.elem != Shape::Unknown && view.data) {
            const uint32_t entries = pairs ? view.count * 2 : view.count;
            for (uint32_t i = pairs ? 1u : 0u; i < entries; i += pairs ? 2u : 1u)
                if (!elem_fits(cell.elem, view.data[i].tag)) return false;
        }
        /* AN UNCHANGED STORE IS NOT A CHANGE. A feed or computed binding re-evaluates
           every tick and stores what it built; copying an identical picture would move
           the generation, and the wire would resend the whole aggregate thirty times a
           second for nothing. The compare is bounded by the window and costs less than
           the copy it skips. Only a cell already HOLDING this shape can be unchanged —
           an empty list stored over UNKNOWN is a real change. */
        if (cell.list_slot < store.lists.size() &&
            value_shape(store.values[cell_index]) == cell.shape) {
            const ListState& held = store.lists[cell.list_slot];
            if (held.count == view.count) {
                const uint32_t entries = pairs ? view.count * 2 : view.count;
                bool same = view.data != nullptr || entries == 0;
                for (uint32_t i = 0; same && i < entries; ++i)
                    same = same_element(program, *this, view.data[i], held.elems[i]);
                if (same) return true;
            }
        }
        return hold_list(program, *this, cell_index, cell.list_slot, view.data,
                         view.count, pairs);
    }
    if (cell.shape != Shape::Text || value.tag == ValueTag::Nil) {
        store.values[cell_index] = value;
        return true;
    }
    if (cell.text_slot >= store.texts.size()) return false;
    store.texts[cell.text_slot].set(text(program, value));
    store.values[cell_index] = Value::text(cell.text_slot);
    return true;
}

bool Host::write_elem(const Program& program, uint32_t cell_index,
                              const Value& index, Value value) noexcept {
    if (cell_index >= store.values.size() || cell_index >= program.cells.size()) return false;
    const CellDef& cell = program.cells[cell_index];
    if (cell.shape != Shape::List || cell.list_slot >= store.lists.size()) return false;
    if (index.tag != ValueTag::Num) return false;
    if (value.tag == ValueTag::Struct) return false;
    if (!elem_fits(cell.elem, value.tag)) return false;
    ListState& held = store.lists[cell.list_slot];
    if (!held.nested() && (value.tag == ValueTag::List || value.tag == ValueTag::Map))
        return false;
    if (held.nested() && value.tag != ValueTag::Nil &&
        held.row_pairs() != (value.tag == ValueTag::Map))
        return false;
    /* the index truncates the way an `x[i]` read does; NaN and negatives land in the
       first refusal, a position past the window in the second — an element write EDITS
       what is there, it never grows the list (growth is the append mode's verb) */
    const double raw = index.data.num;
    if (!(raw >= 0.0)) return false;
    const uint32_t at = static_cast<uint32_t>(raw);
    if (at >= held.count) return false;
    /* an unchanged element is no write at all: the wire stays silent */
    if (same_element(program, *this, held.elems[at], value)) return true;
    if (held.nested()) {
        /* a row of THIS slot is staged before the arena can move under it */
        if (value_retained(value) && value.ref == cell.list_slot) {
            value = stage_row(*this, program, value);
            if (value.tag == ValueTag::Nil) return false;
        }
        if (value.tag == ValueTag::Nil) {
            release_row(held, at, false);
        } else {
            const AggView view = aggregate(value);
            if (!place_row(*this, program, *this, held, cell.list_slot, at, false,
                           view.data, view.count, held.row_pairs(), held.leaf))
                return false;
        }
        ++held.gen;
        held.total = held.count;
        store.values[cell_index] = retained_value(held, cell.list_slot, false);
        return true;
    }
    if (value.tag == ValueTag::Text) {
        const uint32_t slot = store.list_text(held, at);
        if (slot == UINT32_MAX) return false;
        if (value.ref != slot) store.texts[slot].set(text(program, value));
        value = Value::text(slot);
    }
    held.elems[at] = value;
    /* the aggs lane speaks appends and whole pictures, never an in-place edit: the
       generation moves and the window goes out whole on the next publish */
    ++held.gen;
    held.total = held.count;
    store.values[cell_index] = retained_value(held, cell.list_slot, false);
    return true;
}

bool Host::write_leaf_append(const Program& program, uint32_t cell_index,
                                     const Value& outer, Value value,
                                     const Value& keep) noexcept {
    if (cell_index >= store.values.size() || cell_index >= program.cells.size()) return false;
    const CellDef& cell = program.cells[cell_index];
    if (cell.list_slot >= store.lists.size()) return false;
    ListState& held = store.lists[cell.list_slot];
    /* only a LIST row grows by appending — a map row grows by being written a new key,
       which is the leaf assign's verb, exactly as it is one level up */
    if (!held.nested() || held.row_pairs()) return false;
    if (value.tag == ValueTag::List || value.tag == ValueTag::Map ||
        value.tag == ValueTag::Struct)
        return false;
    if (!elem_fits(held.leaf, value.tag)) return false;
    const bool pairs = cell.shape == Shape::Map;
    const uint32_t row = find_row(program, *this, held, pairs, outer);
    if (row == UINT32_MAX) return false;
    /* an UNKNOWN row is not a list to append to: it is a gap, and growing one would be
       inventing the list it stands for */
    if (held.elems[row_at(row, pairs)].tag != ValueTag::List) return false;
    const uint32_t count = agg_count(held.elems[row_at(row, pairs)]);
    const ValueTag was = count ? list_elem_tag(held.elems[row_at(row, pairs)]) : value.tag;
    if (keep.tag != ValueTag::Num && count >= held.leaf_capacity()) return false;
    const uint32_t start = reserve_row(*this, held, row, pairs, count + 1);
    if (start == UINT32_MAX) return false;
    if (value.tag == ValueTag::Text) {
        const uint32_t slot = store.leaf_text(held, start + count);
        if (slot == UINT32_MAX) return false;
        if (value.ref != slot) store.texts[slot].set(text(program, value));
        value = Value::text(slot);
    }
    held.leaves[start + count] = value;
    uint32_t now = count + 1;
    /* a ROW's own window is bounded by the arena it lives in, not by the list's entries */
    const uint32_t window = keep_window(keep, held.leaf_capacity());
    if (window != UINT32_MAX && now > window) {
        const uint32_t drop = now - window;
        for (uint32_t i = 0; i + drop < now; ++i) store.move_leaf(held, start + i, start + i + drop);
        now = window;
    }
    held.elems[row_at(row, pairs)] = Value::retained_row(
        cell.list_slot, start, now, was == value.tag ? was : ValueTag::Nil, false);
    ++held.gen;
    held.total = held.count;
    store.values[cell_index] = retained_value(held, cell.list_slot, pairs);
    return true;
}

bool Host::write_leaf(const Program& program, uint32_t cell_index, const Value& outer,
                              const Value& inner, Value value) noexcept {
    if (cell_index >= store.values.size() || cell_index >= program.cells.size()) return false;
    const CellDef& cell = program.cells[cell_index];
    if (cell.list_slot >= store.lists.size()) return false;
    ListState& held = store.lists[cell.list_slot];
    if (!held.nested()) return false;
    /* the bottom of the nesting is scalars: there is no third level for this to address */
    if (value.tag == ValueTag::List || value.tag == ValueTag::Map ||
        value.tag == ValueTag::Struct)
        return false;
    if (!elem_fits(held.leaf, value.tag)) return false;
    const bool pairs = cell.shape == Shape::Map;
    const uint32_t row = find_row(program, *this, held, pairs, outer);
    if (row == UINT32_MAX) return false;
    const uint32_t entry_at = row_at(row, pairs);
    const uint32_t count = agg_count(held.elems[entry_at]);
    const uint32_t start = agg_start(held.elems[entry_at]);

    if (held.elems[entry_at].tag == ValueTag::List) {
        if (inner.tag != ValueTag::Num || !(inner.data.num >= 0.0)) return false;
        const uint32_t at = static_cast<uint32_t>(inner.data.num);
        /* a leaf write EDITS what is there; a row grows by its own append, never by a
           write past its end */
        if (at >= count) return false;
        if (same_element(program, *this, held.leaves[start + at], value)) return true;
        const ValueTag was = list_elem_tag(held.elems[entry_at]);
        if (value.tag == ValueTag::Text) {
            const uint32_t slot = store.leaf_text(held, start + at);
            if (slot == UINT32_MAX) return false;
            if (value.ref != slot) store.texts[slot].set(text(program, value));
            value = Value::text(slot);
        }
        held.leaves[start + at] = value;
        held.elems[entry_at] = Value::retained_row(
            cell.list_slot, start, count, was == value.tag ? was : ValueTag::Nil, false);
    } else if (held.elems[entry_at].tag == ValueTag::Map) {
        /* a MAP row upserts by key inside its own extent, by the rules the outer map
           keeps among its entries: sorted position, Nil erases, a new key shifts the
           pairs above it up */
        if (inner.tag != ValueTag::Text) return false;
        char buffer[kDefaultTextCap];
        const std::string_view source = text(program, inner);
        const size_t length = std::min(source.size(), sizeof(buffer));
        if (length) std::memcpy(buffer, source.data(), length);
        const std::string_view wanted(buffer, length);
        uint32_t at = 0;
        bool found = false;
        while (at < count) {
            const std::string_view here = text(program, held.leaves[start + at * 2]);
            if (here == wanted) { found = true; break; }
            if (wanted < here) break;
            ++at;
        }
        if (value.tag == ValueTag::Nil) {
            if (!found) return true;
            for (uint32_t p = at * 2; p + 2 < count * 2; ++p)
                store.move_leaf(held, start + p, start + p + 2);
            held.elems[entry_at] =
                Value::retained_row(cell.list_slot, start, count - 1, ValueTag::Nil, true);
        } else {
            uint32_t base = start;
            uint32_t now = count;
            if (!found) {
                if (count >= held.leaf_capacity()) return false;
                base = reserve_row(*this, held, row, pairs, count + 1);
                if (base == UINT32_MAX) return false;
                for (uint32_t p = (count + 1) * 2; p-- > at * 2 + 2;)
                    store.move_leaf(held, base + p, base + p - 2);
                const uint32_t slot = store.leaf_text(held, base + at * 2);
                if (slot == UINT32_MAX) return false;
                store.texts[slot].set(wanted);
                held.leaves[base + at * 2] = Value::text(slot);
                now = count + 1;
            }
            if (value.tag == ValueTag::Text) {
                const uint32_t slot = store.leaf_text(held, base + at * 2 + 1);
                if (slot == UINT32_MAX) return false;
                if (value.ref != slot) store.texts[slot].set(text(program, value));
                value = Value::text(slot);
            }
            held.leaves[base + at * 2 + 1] = value;
            held.elems[entry_at] =
                Value::retained_row(cell.list_slot, base, now, ValueTag::Nil, true);
        }
    } else {
        /* an UNKNOWN row holds no position to write: the gap is the answer */
        return false;
    }
    /* the aggs lane speaks appends and whole pictures, never an in-place edit — one level
       down changes nothing about that */
    ++held.gen;
    held.total = held.count;
    store.values[cell_index] = retained_value(held, cell.list_slot, pairs);
    return true;
}

bool Host::write_field(const Program& program, uint32_t cell_index, uint32_t field,
                               Value value) noexcept {
    const Value holder = store.values[cell_index];
    StructState* item = holder.tag == ValueTag::Struct ? struct_at(holder.ref) : nullptr;
    if (!item || field >= item->fields.size()) return false;
    /* text is copied into the struct's OWN slot, so the value at rest never points
     * into a site's scratch and survives whatever runs next */
    if (value.tag == ValueTag::Text && field < item->texts.size() &&
        value.ref != item->texts[field]) {
        FixedText* own = field_text(item->texts[field]);
        if (own) {
            own->set(text(program, value));
            value = Value::text(item->texts[field]);
        }
    }
    item->fields[field] = value;
    return true;
}

bool Host::write(const Program& program, uint32_t cell, uint32_t field,
                         StorePlace place, StoreMode mode, Value value, const Value& step,
                         const Value& step2) noexcept {
    if (cell >= store.values.size() || cell >= program.cells.size()) return false;
    /* THE OWNER HANDSHAKE, both halves of it: a write landing in a struct's
     * aggregate-field storage (a derived cell) first STARTS THE STORAGE FRESH when
     * the field is still Unknown — New leaves the field Nil and touches no rows, so
     * whatever the slot held in the struct's previous life clears the moment the
     * field comes alive — and afterwards refreshes the owner's field with the
     * handle this write just made true. Part of the write itself, so no instruction
     * anywhere has to remember to follow a store. */
    const CellDef& def = program.cells[cell];
    StructState* owner = nullptr;
    if (def.field_of != UINT32_MAX && def.field_of < store.values.size()) {
        const Value holder = store.values[def.field_of];
        owner = holder.tag == ValueTag::Struct ? struct_at(holder.ref) : nullptr;
        if (owner && def.field_index < owner->fields.size() &&
            owner->fields[def.field_index].tag == ValueTag::Nil)
            write_whole(program, cell, Value::nil());
    }
    bool landed = false;
    if (mode == StoreMode::Append) {
        landed = place == StorePlace::Cell
                     ? write_append(program, cell, value, step)
                     : place == StorePlace::Leaf &&
                           write_leaf_append(program, cell, step, value, step2);
    } else {
        switch (place) {
            case StorePlace::Cell: landed = write_whole(program, cell, value); break;
            case StorePlace::Field:
                landed = write_field(program, cell, field, value);
                break;
            case StorePlace::Elem: landed = write_elem(program, cell, step, value); break;
            case StorePlace::Key: landed = write_key(program, cell, step, value); break;
            case StorePlace::Leaf:
                landed = write_leaf(program, cell, step, step2, value);
                break;
        }
    }
    if (landed && owner && def.field_index < owner->fields.size())
        owner->fields[def.field_index] = store.values[cell];
    return landed;
}

namespace {

/* the same field-by-field identity the compiler keys struct types by: a declared struct
 * variable migrates only while its type still means the same thing */
bool same_struct_type(const Program& a, uint16_t a_type, const Program& b, uint16_t b_type) {
    const std::vector<FieldDef>& fa = struct_fields(a, a_type);
    const std::vector<FieldDef>& fb = struct_fields(b, b_type);
    if (fa.size() != fb.size()) return false;
    for (uint32_t i = 0; i < fa.size(); ++i)
        if (fa[i].path != fb[i].path || fa[i].shape != fb[i].shape) return false;
    return true;
}

/* Carry a declared struct variable's fields into the new run's slot. Values copy
 * directly except text (re-homed into the new slot's own FixedText) and aggregates
 * (their content migrates by the derived cells' own names, and the re-point pass
 * below hands the owner the new handles); enum values are restamped with the new
 * program's type id. A Nil field stays Nil — Unknown migrates as Unknown. */
void migrate_struct(const Program& old_program, const Host& old_state,
                    const StructState& src, const Program& new_program,
                    Host& next, StructState& dst) {
    const std::vector<FieldDef>& defs = struct_fields(new_program, dst.type_id);
    for (uint32_t f = 0; f < defs.size() && f < src.fields.size(); ++f) {
        const Value& value = src.fields[f];
        switch (defs[f].shape) {
            case Shape::Text:
                if (value.tag == ValueTag::Text && f < dst.texts.size() &&
                    dst.texts[f] < next.store.texts.size()) {
                    next.store.texts[dst.texts[f]].set(old_state.text(old_program, value));
                    dst.fields[f] = Value::text(dst.texts[f]);
                }
                break;
            case Shape::List:
            case Shape::Map:
                break;
            case Shape::Enum:
                if (value.tag == ValueTag::Enum)
                    dst.fields[f] = Value::enumeration(value.data.integer, defs[f].type_id);
                break;
            default:
                if (value_shape(value) == defs[f].shape) dst.fields[f] = value;
                break;
        }
    }
}

} // namespace

Host migrate_state(const Program& old_program, const Host& old_state,
                           const Program& new_program) {
    Host next(new_program);
    next.tick = old_state.tick;
    for (uint32_t n = 0; n < new_program.cells.size(); ++n) {
        const CellDef& wanted = new_program.cells[n];
        /* a temporary holds a value only inside a run, so a swap between runs has
         * nothing to carry */
        if (wanted.kind == CellKind::Temp) continue;
        /* a struct cell's handle was set by the constructor above and must not be
         * replaced by the old program's slot index (spec 5.11); what migrates is the
         * SLOT'S CONTENT, field by field, while the type still matches */
        if (wanted.shape == Shape::Struct) {
            for (uint32_t o = 0; o < old_program.cells.size(); ++o) {
                const CellDef& before = old_program.cells[o];
                if (!same_cell(wanted, before)) continue;
                if (same_struct_type(old_program, before.type_id, new_program,
                                     wanted.type_id) &&
                    wanted.struct_slot < next.store.structs.size() &&
                    before.struct_slot < old_state.store.structs.size())
                    migrate_struct(old_program, old_state,
                                   old_state.store.structs[before.struct_slot], new_program,
                                   next, next.store.structs[wanted.struct_slot]);
                break;
            }
            continue;
        }
        for (uint32_t o = 0; o < old_program.cells.size(); ++o) {
            if (!same_cell(wanted, old_program.cells[o])) continue;
            /* the author restated where this cell starts: keep what the new program
               seeded rather than the value the old run had reached */
            if (authored_moved(old_program, old_program.cells[o], new_program, wanted)) break;
            /* an element-type change is a retype: the buffer resets to its fresh seed
               exactly as a scalar variable resets on a type change. The LEAF shape counts
               the same way — a list of numbers is not a list of text, at either depth */
            if (wanted.elem != old_program.cells[o].elem) break;
            if (wanted.leaf != old_program.cells[o].leaf) break;
            const Value& value = old_state.store.values[o];
            if (wanted.shape == Shape::Text && value.tag == ValueTag::Text) {
                if (wanted.text_slot < next.store.texts.size()) {
                    next.store.texts[wanted.text_slot].set(old_state.text(old_program, value));
                    next.store.values[n] = Value::text(wanted.text_slot);
                }
            } else if (wanted.shape == Shape::List || wanted.shape == Shape::Map) {
                /* a retained aggregate carries over BY VALUE, exactly as text does: the
                   entries are copied into the new run's own slot and their text with
                   them, so nothing the new state holds points into the retired one.
                   The wire cursor comes with it and then MOVES: a recompile is a new
                   baseline, and the snapshot that follows re-seeds every client. */
                const bool pairs = wanted.shape == Shape::Map;
                const ValueTag holds = pairs ? ValueTag::Map : ValueTag::List;
                if (value.tag != holds) {
                    next.store.values[n] = Value::nil();
                    if (wanted.list_slot < next.store.lists.size()) {
                        ListState& blank = next.store.lists[wanted.list_slot];
                        blank.count = 0;
                        /* the rows go with the entries: an arena nothing names is hole,
                           and the seed it was born with is no longer what it holds */
                        blank.leaf_used = 0;
                        blank.leaf_live = 0;
                        blank.row_cap.clear();
                    }
                } else {
                    const AggView view = old_state.aggregate(value);
                    next.hold_list(old_program, old_state, n, wanted.list_slot, view.data,
                                   view.count, pairs);
                }
                const uint32_t was_slot = old_program.cells[o].list_slot;
                if (wanted.list_slot < next.store.lists.size() &&
                    was_slot < old_state.store.lists.size()) {
                    ListState& now = next.store.lists[wanted.list_slot];
                    now.gen = old_state.store.lists[was_slot].gen + 1;
                    now.total = old_state.store.lists[was_slot].total;
                }
            } else if (wanted.shape == Shape::Enum && value.tag == ValueTag::Enum) {
                /* the type table is rebuilt per program, so the stamp is re-issued */
                next.store.values[n] = Value::enumeration(value.data.integer, wanted.type_id);
            } else if (value.tag == ValueTag::Token) {
                /* a token carries over BY NAME through the new program's own table; a
                   name the new document no longer declares reads UNKNOWN */
                next.store.values[n] = Value::nil();
                if (value.ref < old_program.tokens.size())
                    for (uint32_t t = 0; t < new_program.tokens.size(); ++t)
                        if (new_program.tokens[t] == old_program.tokens[value.ref]) {
                            next.store.values[n] = Value::token(t);
                            break;
                        }
            } else {
                next.store.values[n] = value;
            }
            break;
        }
    }
    /* struct aggregate fields re-point at THIS run's derived handles: the content
       migrated by the derived cells' own names above, and whatever handle
       migrate_struct copied referenced the retired run's slots */
    for (uint32_t n = 0; n < new_program.cells.size(); ++n) {
        const CellDef& cell = new_program.cells[n];
        if (cell.field_of == UINT32_MAX || cell.field_of >= new_program.cells.size())
            continue;
        const uint32_t slot = new_program.cells[cell.field_of].struct_slot;
        if (slot >= next.store.structs.size()) continue;
        if (cell.field_index < next.store.structs[slot].fields.size())
            next.store.structs[slot].fields[cell.field_index] = next.store.values[n];
    }
    return next;
}

} // namespace hmi

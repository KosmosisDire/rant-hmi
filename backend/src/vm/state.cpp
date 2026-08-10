#include "state.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace hmi {

namespace {

constexpr uint32_t kDefaultTextCap = 256;

bool same_cell(const CellDef& a, const CellDef& b) {
    return a.kind == b.kind && a.owner_widget == b.owner_widget && a.name == b.name &&
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
bool same_list_init(const Program& old_program, const CellDef& before,
                    const Program& new_program, const CellDef& after) {
    if (before.has_list != after.has_list ||
        before.list_init.size() != after.list_init.size())
        return false;
    for (size_t i = 0; i < before.list_init.size(); ++i) {
        const Value& was = before.list_init[i];
        const Value& now = after.list_init[i];
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

Value zero_value(Shape shape) {
    switch (shape) {
        case Shape::Num: return Value::number(0);
        case Shape::Bool: return Value::boolean(false);
        case Shape::Enum: return Value::enumeration(0, 0);
        case Shape::Color: return Value::color(0x00000000u);
        case Shape::Text: return Value::text(kConstantRef);
        /* aggregates in a struct are inert empty placeholders: never Nil (a move out
         * must not fault on a field the wire side cannot set anyway; the RMW base
         * preserves the owner's actual bytes) */
        case Shape::List: return Value::list(0, 0, ValueTag::Nil);
        case Shape::Map: return Value::map(0, 0);
        default: return Value::nil();
    }
}


RuntimeState::RuntimeState(const Program& program) {
    values.resize(program.cells.size(), Value::nil());
    texts.reserve(program.layout.text_slots);
    for (uint32_t i = 0; i < program.layout.text_slots; ++i)
        texts.emplace_back(kDefaultTextCap);

    for (uint32_t i = 0; i < program.cells.size(); ++i) {
        const CellDef& cell = program.cells[i];
        if (cell.shape != Shape::Text) {
            values[i] = cell.initial;
            continue;
        }
        const uint32_t slot = cell.text_slot;
        if (slot >= texts.size()) continue;
        texts[slot] = FixedText(cell.text_cap ? cell.text_cap : kDefaultTextCap);
        if (cell.initial.tag == ValueTag::Text &&
            (cell.initial.ref & kConstantRef) != 0) {
            const uint32_t at = cell.initial.ref & ~kConstantRef;
            if (at < program.texts.size()) texts[slot].set(program.texts[at]);
        }
        values[i] = Value::text(slot);
    }
    /* mesh-inbound text storage (see the header): the scratch slot, then one retained
     * slot per text-shaped entity field. Delivered strings land in ordinary FixedText
     * slots, so they resolve through the standard text machinery: a feed's store copies
     * them into the destination cell, and a `seed: last` build can re-send them. */
    mesh_scratch = static_cast<uint32_t>(texts.size());
    texts.emplace_back(kDefaultTextCap);
    input_scratch = static_cast<uint32_t>(texts.size());
    texts.emplace_back(kDefaultTextCap);
    entity_texts.resize(program.entities.size());
    for (uint32_t e = 0; e < program.entities.size(); ++e) {
        /* the READ side's table: a function's response fields — what a delivery
           carries, what the cache holds, and what a slot expression loads */
        const std::vector<FieldDef>& entity_fields = feed_fields(program.entities[e]);
        entity_texts[e].assign(entity_fields.size(), UINT32_MAX);
        for (uint32_t f = 0; f < entity_fields.size(); ++f) {
            if (entity_fields[f].shape != Shape::Text) continue;
            entity_texts[e][f] = static_cast<uint32_t>(texts.size());
            texts.emplace_back(kDefaultTextCap);
        }
    }
    /* suspension deep-copy slots: a fixed run per pending site (x first, then every
     * text-shaped field of every struct slot, in table order; the Suspend op walks the
     * same order) */
    uint32_t per_pending = 2;   /* one for x, one for the event parameter */
    for (const StructDef& item : program.structs)
        for (const FieldDef& field : struct_fields(program, item.type_id))
            if (field.shape == Shape::Text) ++per_pending;
    pending_texts.resize(program.layout.pending_slots);
    for (uint32_t i = 0; i < program.layout.pending_slots; ++i) {
        pending_texts[i] = static_cast<uint32_t>(texts.size());
        for (uint32_t k = 0; k < per_pending; ++k) texts.emplace_back(kDefaultTextCap);
    }
    /* the aggregate scratch pool (elements + their text slots) */
    elems.resize(program.layout.elem_values, Value::nil());
    elem_text_base = static_cast<uint32_t>(texts.size());
    elem_text_cursor = elem_text_base;
    elem_text_count = program.layout.elem_texts;
    for (uint32_t i = 0; i < program.layout.elem_texts; ++i)
        texts.emplace_back(kDefaultTextCap);

    /* retained aggregate storage: one slot per list- or map-shaped cell, born EMPTY and
     * grown to whatever the cell actually holds. A cell carries its aggregate across
     * ticks and the pool above does not survive a run, so the two storages are separate
     * and only this one is stable. Element text slots are appended to `texts` on first
     * use (list_text), after the pool's own run, so nothing above is disturbed. */
    lists.resize(program.layout.list_slots);
    /* the MESH AGGREGATE MIRRORS ride the same vector, after the cells' slots: one
       empty retained slot per aggregate-shaped read-side entity field, filled by
       deliveries (hold_entity_agg) and handed out through the last-value cache */
    entity_aggs.resize(program.entities.size());
    for (uint32_t e = 0; e < program.entities.size(); ++e) {
        const std::vector<FieldDef>& read_fields = feed_fields(program.entities[e]);
        entity_aggs[e].assign(read_fields.size(), UINT32_MAX);
        for (uint32_t f = 0; f < read_fields.size(); ++f) {
            if (read_fields[f].shape != Shape::List && read_fields[f].shape != Shape::Map)
                continue;
            entity_aggs[e][f] = static_cast<uint32_t>(lists.size());
            lists.emplace_back();
        }
    }
    for (uint32_t i = 0; i < program.cells.size(); ++i) {
        const CellDef& cell = program.cells[i];
        if (!cell.has_list) continue;
        if (cell.shape != Shape::List && cell.shape != Shape::Map) continue;
        const bool pairs = cell.shape == Shape::Map;
        const uint32_t count = static_cast<uint32_t>(cell.list_init.size());
        hold_list(program, *this, i, cell.list_slot, cell.list_init.data(),
                  pairs ? count / 2 : count, pairs);
        /* a fresh run's baseline is generation ZERO: hold_list bumps gen because a
           whole store is a discontinuity, and there is nothing here to be discontinuous
           from */
        if (cell.list_slot < lists.size()) lists[cell.list_slot].gen = 0;
    }

    uint32_t max_fields = std::max<uint32_t>(program.layout.max_entity_fields, 1);
    structs.resize(program.structs.size());
    for (uint32_t i = 0; i < program.structs.size(); ++i) {
        StructState& item = structs[i];
        item.type_id = program.structs[i].type_id;
        const std::vector<FieldDef>& defs = struct_fields(program, item.type_id);
        const uint32_t n = static_cast<uint32_t>(defs.size());
        /* born ZEROED with no bit set (spec 2.7): a declared struct variable reads as
         * its type's zero before anything writes it, and a move out of one carries only
         * the fields that were actually given */
        item.fields.resize(n, Value::nil());
        item.set.resize(n, 0);
        item.texts.assign(n, UINT32_MAX);
        for (uint32_t f = 0; f < n; ++f) {
            item.fields[f] = zero_value(defs[f].shape);
            if (defs[f].shape == Shape::Text) {
                item.texts[f] = static_cast<uint32_t>(texts.size());
                texts.emplace_back(kDefaultTextCap);
            }
        }
    }
    /* a struct-shaped cell POINTS at its slot: the Value is the handle, the fields live
     * in `structs`, so a cell read pushes something copyable and a field write lands in
     * exactly one place. A declared variable's authored DEFAULTS land over the zero. */
    for (uint32_t i = 0; i < program.cells.size(); ++i) {
        const CellDef& cell = program.cells[i];
        if (cell.shape != Shape::Struct || cell.struct_slot >= structs.size()) continue;
        values[i] = Value::structure(cell.struct_slot, cell.type_id);
        StructState& item = structs[cell.struct_slot];
        for (const auto& start : cell.struct_init) {
            if (start.first >= item.fields.size()) continue;
            item.fields[start.first] = start.second;
            item.set[start.first] = 1;
        }
    }

    last.resize(program.entities.size());
    for (uint32_t i = 0; i < program.entities.size(); ++i)
        /* sized for BOTH tables: a function's mirror holds its response (what a slot
           expression reads), while ReadEnt walks the value/request table — the wider
           run keeps either read in bounds and the unused tail stays Nil */
        last[i].fields.resize(std::max(program.entities[i].fields.size(),
                                       feed_fields(program.entities[i]).size()),
                              Value::nil());

    deadband.resize(program.layout.deadband_slots, Value::nil());
    throttle.resize(program.layout.throttle_slots, UINT64_MAX);
    timers.resize(program.timers.size());
    fired.resize(program.layout.fired_groups, 0);
    pending.resize(program.layout.pending_slots);
    for (PendingState& item : pending) {
        item.structs.resize(structs.size());
        for (uint32_t i = 0; i < structs.size(); ++i) {
            item.structs[i].type_id = structs[i].type_id;
            item.structs[i].fields.resize(structs[i].fields.size(), Value::nil());
            item.structs[i].set.resize(structs[i].set.size(), 0);
        }
    }

    stack.resize(std::max<uint32_t>(program.layout.stack_values, 1), Value::nil());
    effects.resize(std::max<uint32_t>(program.layout.effect_capacity, 1));
    for (EffectRecord& effect : effects) {
        effect.fields.resize(max_fields, Value::nil());
        effect.set.resize(max_fields, 0);
        effect.bare_text = FixedText(kDefaultTextCap);
        effect.field_text.reserve(max_fields);
        for (uint32_t i = 0; i < max_fields; ++i)
            effect.field_text.emplace_back(kDefaultTextCap);
    }
    raised.resize(std::max<uint32_t>(program.layout.raise_capacity, 1));
    for (RaisedRecord& record : raised) record.text = FixedText(kDefaultTextCap);
    notices.resize(std::max<uint32_t>(program.layout.notice_capacity, 1));
    for (NoticeRecord& record : notices) record.text = FixedText(kDefaultTextCap);
    faults.resize(std::max<size_t>(program.runtime_faults.size(), 1));
    for (uint32_t i = 0; i < program.runtime_faults.size(); ++i)
        faults[i].site = i;
}

std::string_view RuntimeState::text(const Program& program, const Value& value) const noexcept {
    if (value.tag != ValueTag::Text) return {};
    if ((value.ref & kConstantRef) != 0) {
        const uint32_t at = value.ref & ~kConstantRef;
        return at < program.texts.size() ? std::string_view(program.texts[at]) : std::string_view{};
    }
    return value.ref < texts.size() ? texts[value.ref].view() : std::string_view{};
}

AggView RuntimeState::aggregate(const Value& value) const noexcept {
    const uint32_t count = static_cast<uint32_t>(value.data.integer);
    if (value_retained(value) &&
        (value.tag == ValueTag::List || value.tag == ValueTag::Map)) {
        if (value.ref >= lists.size() || count > lists[value.ref].count) return {};
        return {lists[value.ref].elems.data(), count};
    }
    const uint32_t need = value.tag == ValueTag::Map ? count * 2 : count;
    if (value.ref > elems.size() || need > elems.size() - value.ref) return {};
    return {elems.data() + value.ref, count};
}

uint32_t RuntimeState::list_text(ListState& held, uint32_t at) noexcept {
    /* a map's entries interleave, so the widest position an aggregate can name is twice
       the ceiling: one text slot per key AND one per text value */
    if (at >= kRetainedCeiling * 2) return UINT32_MAX;
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
void RuntimeState::move_entry(ListState& held, uint32_t dst, uint32_t src) noexcept {
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

bool RuntimeState::hold_list(const Program& source_program, const RuntimeState& source,
                             uint32_t cell_index, uint32_t list_slot, const Value* data,
                             uint32_t count, bool pairs) noexcept {
    if (list_slot >= lists.size() || cell_index >= values.size()) return false;
    ListState& held = lists[list_slot];
    if (count > kRetainedCeiling) count = kRetainedCeiling;
    if (!data && count) return false;
    /* grow to what this store actually holds, once; a slot that only ever carries three
       options never carries the ceiling's worth of Values. A map's entries interleave,
       so the run is twice its pair count. */
    const uint32_t span = pairs ? count * 2 : count;
    if (held.elems.size() < span) held.elems.resize(span, Value::nil());
    for (uint32_t i = 0; i < span; ++i) held.elems[i] = data[i];
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
        const uint32_t slot = list_text(held, i);
        if (slot == UINT32_MAX) return false;
        /* a slot index only means the same storage when the source IS this run: across
           two states the same number names two different buffers, so the copy stands */
        if (&source != this || held.elems[i].ref != slot)
            texts[slot].set(source.text(source_program, held.elems[i]));
        held.elems[i] = Value::text(slot);
    }
    held.count = count;
    /* a whole store is a DISCONTINUITY: the wire cannot describe it as appends, so the
       generation moves and the append cursor restarts at what is now there */
    ++held.gen;
    held.total = count;
    values[cell_index] = retained_value(held, list_slot, pairs);
    return true;
}

Value RuntimeState::hold_entity_agg(uint32_t list_slot, const Value* data,
                                    const std::string_view* elem_texts,
                                    uint32_t delivered, bool pairs, ValueTag elem,
                                    uint32_t bound) noexcept {
    if (list_slot >= lists.size()) return Value::nil();
    if (!data && delivered) return Value::nil();
    ListState& held = lists[list_slot];
    const uint32_t width = pairs ? 2u : 1u;
    uint32_t count = delivered / width;
    const uint32_t limit = std::min(bound ? bound : kVarrCeiling, kRetainedCeiling);
    if (count > limit) count = limit;   /* the ceiling: truncate, never overrun */
    const uint32_t span = count * width;
    if (held.elems.size() < span) held.elems.resize(span, Value::nil());

    /* A MAP arrives in the owner's own order and a retained map is SORTED BY KEY: the
       order is decided over the delivery's key views (still valid here), then the
       entries land already in place — text is homed per POSITION, so deciding the
       order first is what keeps each key's bytes from being copied twice. */
    uint32_t order[kRetainedCeiling];
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

bool RuntimeState::append_list(const Program& program, uint32_t cell_index, Value value,
                               const Value& keep) noexcept {
    if (cell_index >= values.size() || cell_index >= program.cells.size()) return false;
    const CellDef& cell = program.cells[cell_index];
    if (cell.shape != Shape::List || cell.list_slot >= lists.size()) return false;
    /* nested aggregates do not exist: an append takes ONE element, and a list of lists
       has no representation anywhere else in the system either */
    if (value.tag == ValueTag::List || value.tag == ValueTag::Map ||
        value.tag == ValueTag::Struct)
        return false;
    ListState& held = lists[cell.list_slot];
    /* the runaway case: with nothing bounding the ring, the ceiling is the only answer,
       and it refuses rather than silently dropping the oldest sample */
    if (keep.tag != ValueTag::Num && held.count >= kRetainedCeiling) return false;
    /* the element tag is a HINT and it is tracked, not recomputed: a ring appends every
       tick, and rescanning four thousand elements for a fact one comparison settles is
       exactly the per-tick cost this tier does not pay. Mixed reads as Nil, which is
       what a scan would have reported anyway. */
    const Value& current = values[cell_index];
    const ValueTag was = current.tag == ValueTag::List && held.count
                             ? list_elem_tag(current)
                             : value.tag;
    if (value.tag == ValueTag::Text) {
        const uint32_t slot = list_text(held, held.count);
        if (slot == UINT32_MAX) return false;
        if (value.ref != slot) texts[slot].set(text(program, value));
        value = Value::text(slot);
    }
    /* push_back only where the slot has not yet reached its working width: once a ring
       is full every further append writes in place, which is what makes a cadence flow
       allocation-free in steady state */
    if (held.count < held.elems.size()) held.elems[held.count] = value;
    else held.elems.push_back(value);
    ++held.count;
    ++held.total;
    if (keep.tag == ValueTag::Num) {
        double wanted = std::floor(keep.data.num);
        if (!(wanted >= 1.0)) wanted = 1.0;   /* NaN lands here too */
        if (wanted > static_cast<double>(kRetainedCeiling)) wanted = kRetainedCeiling;
        const uint32_t window = static_cast<uint32_t>(wanted);
        if (held.count > window) {
            const uint32_t drop = held.count - window;
            for (uint32_t i = 0; i + drop < held.count; ++i) move_entry(held, i, i + drop);
            held.count = window;
        }
    }
    values[cell_index] = Value::retained_list(
        cell.list_slot, held.count, was == value.tag ? was : ValueTag::Nil);
    return true;
}

bool RuntimeState::store_key(const Program& program, uint32_t cell_index, const Value& key,
                             Value value) noexcept {
    if (cell_index >= values.size() || cell_index >= program.cells.size()) return false;
    const CellDef& cell = program.cells[cell_index];
    if (cell.shape != Shape::Map || cell.list_slot >= lists.size()) return false;
    if (key.tag != ValueTag::Text) return false;
    if (value.tag == ValueTag::List || value.tag == ValueTag::Map ||
        value.tag == ValueTag::Struct)
        return false;
    ListState& held = lists[cell.list_slot];
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
        for (uint32_t p = at * 2; p + 2 < held.count * 2; ++p) move_entry(held, p, p + 2);
        --held.count;
        ++held.total;
        values[cell_index] = Value::retained_map(cell.list_slot, held.count);
        return true;
    }

    if (!found) {
        /* a map has no keep, so a runaway one is a bug by construction rather than a
           window that needs trimming */
        if (held.count >= kRetainedCeiling) return false;
        const uint32_t span = (held.count + 1) * 2;
        if (held.elems.size() < span) held.elems.resize(span, Value::nil());
        for (uint32_t p = span; p-- > at * 2 + 2;) move_entry(held, p, p - 2);
        ++held.count;
        const uint32_t slot = list_text(held, at * 2);
        if (slot == UINT32_MAX) return false;
        texts[slot].set(wanted);
        held.elems[at * 2] = Value::text(slot);
    }
    if (value.tag == ValueTag::Text) {
        const uint32_t slot = list_text(held, at * 2 + 1);
        if (slot == UINT32_MAX) return false;
        if (value.ref != slot) texts[slot].set(text(program, value));
        value = Value::text(slot);
    }
    held.elems[at * 2 + 1] = value;
    ++held.total;
    values[cell_index] = Value::retained_map(cell.list_slot, held.count);
    return true;
}

/* wire-visible equality between two aggregate elements, each resolved through the same
   run: what the aggs lane would serialize identically is what counts as unchanged */
static bool same_element(const Program& program, const RuntimeState& state,
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
        case ValueTag::Text: return state.text(program, a) == state.text(program, b);
        default: return false;
    }
}

bool RuntimeState::store(const Program& program, uint32_t cell_index,
                         const Value& value) noexcept {
    if (cell_index >= values.size()) return false;
    const CellDef& cell = program.cells[cell_index];
    /* a struct cell's Value is its handle and is fixed for the run: it is filled by New
     * or ReadEnt and edited field by field, never replaced wholesale */
    if (cell.shape == Shape::Struct) return false;
    if (cell.shape != value_shape(value) && value.tag != ValueTag::Nil) return false;
    /* An AGGREGATE cell is written WHOLE and keeps what it was given: the entries are
     * copied out of wherever they were built into the cell's own retained slot, because
     * what built them (the scratch pool) is reused by the very next run. Appending and
     * keyed writes are their own verbs (Append / StoreKey); this is replacement. */
    if (cell.shape == Shape::List || cell.shape == Shape::Map) {
        const bool pairs = cell.shape == Shape::Map;
        if (value.tag == ValueTag::Nil) {
            /* already UNKNOWN: re-storing Nil every tick (a computed binding whose
               expression keeps failing) is not a change the wire should see */
            if (values[cell_index].tag == ValueTag::Nil) return true;
            /* CLEARED is a discontinuity like any other whole store, and the wire has to
               see it as one: the cell reads UNKNOWN and its generation moves */
            if (cell.list_slot < lists.size()) {
                ListState& held = lists[cell.list_slot];
                held.count = 0;
                ++held.gen;
                held.total = 0;
            }
            values[cell_index] = Value::nil();
            return true;
        }
        /* a cell fed from its own value: the copy would read the slot it is writing, so
           there is nothing to do and everything to get wrong */
        if (value_retained(value) && value.ref == cell.list_slot) {
            values[cell_index] = value;
            return true;
        }
        const AggView view = aggregate(value);
        /* AN UNCHANGED STORE IS NOT A CHANGE. A feed or computed binding re-evaluates
           every tick and stores what it built; copying an identical picture would move
           the generation, and the wire would resend the whole aggregate thirty times a
           second for nothing. The compare is bounded by the window and costs less than
           the copy it skips. Only a cell already HOLDING this shape can be unchanged —
           an empty list stored over UNKNOWN is a real change. */
        if (cell.list_slot < lists.size() &&
            value_shape(values[cell_index]) == cell.shape) {
            const ListState& held = lists[cell.list_slot];
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
        values[cell_index] = value;
        return true;
    }
    if (cell.text_slot >= texts.size()) return false;
    texts[cell.text_slot].set(text(program, value));
    values[cell_index] = Value::text(cell.text_slot);
    return true;
}

void RuntimeState::clear_outputs() noexcept {
    effect_count = 0;
    raised_count = 0;
    /* the App drains notices between ticks; this reset only matters to a harness that
       ticks the scheduler bare, where an undrained notice dies quietly instead of
       filling the buffer into a spurious fault */
    notice_count = 0;
    fault_count = 0;
}

void RuntimeState::reset_scratch() noexcept {
    elem_cursor = 0;
    elem_text_cursor = elem_text_base;
}

uint32_t RuntimeState::alloc_elems(uint32_t count) noexcept {
    if (count > elems.size() || elem_cursor > elems.size() - count) return UINT32_MAX;
    const uint32_t offset = elem_cursor;
    elem_cursor += count;
    return offset;
}

uint32_t RuntimeState::alloc_elem_text() noexcept {
    if (elem_text_cursor >= elem_text_base + elem_text_count) return UINT32_MAX;
    return elem_text_cursor++;
}

void RuntimeState::fault(uint32_t site) noexcept {
    if (site >= faults.size()) return;
    faults[site].site = site;
    faults[site].tick = tick;
    ++faults[site].count;
    ++fault_count;
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
 * (they point into the old run's element pool, so they stay the zeroed placeholder);
 * enum values are restamped with the new program's type id. */
void migrate_struct(const Program& old_program, const RuntimeState& old_state,
                    const StructState& src, const Program& new_program,
                    RuntimeState& next, StructState& dst) {
    const std::vector<FieldDef>& defs = struct_fields(new_program, dst.type_id);
    for (uint32_t f = 0; f < defs.size() && f < src.fields.size(); ++f) {
        const Value& value = src.fields[f];
        dst.set[f] = src.set[f];
        switch (defs[f].shape) {
            case Shape::Text:
                if (value.tag == ValueTag::Text && f < dst.texts.size() &&
                    dst.texts[f] < next.texts.size()) {
                    next.texts[dst.texts[f]].set(old_state.text(old_program, value));
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

RuntimeState migrate_state(const Program& old_program, const RuntimeState& old_state,
                           const Program& new_program) {
    RuntimeState next(new_program);
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
                    wanted.struct_slot < next.structs.size() &&
                    before.struct_slot < old_state.structs.size())
                    migrate_struct(old_program, old_state,
                                   old_state.structs[before.struct_slot], new_program,
                                   next, next.structs[wanted.struct_slot]);
                break;
            }
            continue;
        }
        for (uint32_t o = 0; o < old_program.cells.size(); ++o) {
            if (!same_cell(wanted, old_program.cells[o])) continue;
            /* the author restated where this cell starts: keep what the new program
               seeded rather than the value the old run had reached */
            if (authored_moved(old_program, old_program.cells[o], new_program, wanted)) break;
            const Value& value = old_state.values[o];
            if (wanted.shape == Shape::Text && value.tag == ValueTag::Text) {
                if (wanted.text_slot < next.texts.size()) {
                    next.texts[wanted.text_slot].set(old_state.text(old_program, value));
                    next.values[n] = Value::text(wanted.text_slot);
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
                    next.values[n] = Value::nil();
                    if (wanted.list_slot < next.lists.size())
                        next.lists[wanted.list_slot].count = 0;
                } else {
                    const AggView view = old_state.aggregate(value);
                    next.hold_list(old_program, old_state, n, wanted.list_slot, view.data,
                                   view.count, pairs);
                }
                const uint32_t was_slot = old_program.cells[o].list_slot;
                if (wanted.list_slot < next.lists.size() &&
                    was_slot < old_state.lists.size()) {
                    ListState& now = next.lists[wanted.list_slot];
                    now.gen = old_state.lists[was_slot].gen + 1;
                    now.total = old_state.lists[was_slot].total;
                }
            } else if (wanted.shape == Shape::Enum && value.tag == ValueTag::Enum) {
                /* the type table is rebuilt per program, so the stamp is re-issued */
                next.values[n] = Value::enumeration(value.data.integer, wanted.type_id);
            } else {
                next.values[n] = value;
            }
            break;
        }
    }
    return next;
}

} // namespace hmi

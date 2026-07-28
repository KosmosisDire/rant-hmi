#include "state.h"

#include <algorithm>
#include <cstring>

namespace hmi {

namespace {

constexpr uint32_t kDefaultTextCap = 256;

bool same_cell(const CellDef& a, const CellDef& b) {
    return a.kind == b.kind && a.owner_widget == b.owner_widget && a.name == b.name &&
           a.shape == b.shape && a.owner_flow == b.owner_flow;
}

/* the literal a cell is compiled to start from, if it starts from one */
std::string_view initial_text(const Program& program, const CellDef& cell) {
    if (cell.initial.tag != ValueTag::Text || (cell.initial.ref & kConstantRef) == 0) return {};
    const uint32_t at = cell.initial.ref & ~kConstantRef;
    return at < program.texts.size() ? std::string_view(program.texts[at]) : std::string_view{};
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
    entity_texts.resize(program.entities.size());
    for (uint32_t e = 0; e < program.entities.size(); ++e) {
        const std::vector<FieldDef>& entity_fields = program.entities[e].fields;
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
    uint32_t per_pending = 1;
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

    uint32_t max_fields = std::max<uint32_t>(program.layout.max_entity_fields, 1);
    structs.resize(program.structs.size());
    for (uint32_t i = 0; i < program.structs.size(); ++i) {
        StructState& item = structs[i];
        item.type_id = program.structs[i].type_id;
        const uint32_t n = static_cast<uint32_t>(struct_fields(program, item.type_id).size());
        item.fields.resize(n, Value::nil());
        item.set.resize(n, 0);
    }
    /* a struct-shaped cell POINTS at its slot: the Value is the handle, the fields live
     * in `structs`, so a cell read pushes something copyable and a field write lands in
     * exactly one place */
    for (uint32_t i = 0; i < program.cells.size(); ++i) {
        const CellDef& cell = program.cells[i];
        if (cell.shape != Shape::Struct || cell.struct_slot >= structs.size()) continue;
        values[i] = Value::structure(cell.struct_slot, cell.type_id);
    }

    last.resize(program.entities.size());
    for (uint32_t i = 0; i < program.entities.size(); ++i)
        last[i].fields.resize(program.entities[i].fields.size(), Value::nil());

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

bool RuntimeState::store(const Program& program, uint32_t cell_index,
                         const Value& value) noexcept {
    if (cell_index >= values.size()) return false;
    const CellDef& cell = program.cells[cell_index];
    /* a struct cell's Value is its handle and is fixed for the run: it is filled by New
     * or ReadEnt and edited field by field, never replaced wholesale */
    if (cell.shape == Shape::Struct) return false;
    if (cell.shape != value_shape(value) && value.tag != ValueTag::Nil) return false;
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

RuntimeState migrate_state(const Program& old_program, const RuntimeState& old_state,
                           const Program& new_program) {
    RuntimeState next(new_program);
    next.tick = old_state.tick;
    for (uint32_t n = 0; n < new_program.cells.size(); ++n) {
        const CellDef& wanted = new_program.cells[n];
        /* a temporary holds a value only inside a run, so a swap between runs has
         * nothing to carry; a struct cell's handle was set by the constructor above and
         * must not be replaced by the old program's slot index (spec 5.11) */
        if (wanted.kind == CellKind::Temp || wanted.shape == Shape::Struct) continue;
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
            } else {
                next.values[n] = value;
            }
            break;
        }
    }
    return next;
}

} // namespace hmi

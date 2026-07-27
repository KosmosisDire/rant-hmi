#include "state.h"

#include <algorithm>
#include <cstring>

namespace hmi {

namespace {

constexpr uint32_t kDefaultTextCap = 256;

bool same_cell(const CellDef& a, const CellDef& b) {
    return a.kind == b.kind && a.owner_widget == b.owner_widget && a.name == b.name &&
           a.shape == b.shape;
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

    uint32_t max_fields = std::max<uint32_t>(program.layout.max_entity_fields, 1);
    buffers.resize(program.buffers.size());
    for (uint32_t i = 0; i < program.buffers.size(); ++i) {
        MessageState& buffer = buffers[i];
        buffer.entity = program.buffers[i].entity;
        const uint32_t n = static_cast<uint32_t>(program.entities[buffer.entity].fields.size());
        buffer.fields.resize(n, Value::nil());
        buffer.set.resize(n, 0);
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
        item.buffers.resize(buffers.size());
        for (uint32_t i = 0; i < buffers.size(); ++i) {
            item.buffers[i].entity = buffers[i].entity;
            item.buffers[i].fields.resize(buffers[i].fields.size(), Value::nil());
            item.buffers[i].set.resize(buffers[i].set.size(), 0);
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
        for (uint32_t o = 0; o < old_program.cells.size(); ++o) {
            if (!same_cell(wanted, old_program.cells[o])) continue;
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

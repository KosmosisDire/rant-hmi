#include "fake.h"

#include <iomanip>
#include <sstream>

namespace hmi {
namespace {

std::string print_value(const Value& value, std::string_view text) {
    std::ostringstream out;
    out << std::setprecision(17);
    switch (value.tag) {
        case ValueTag::Nil: out << "nil"; break;
        case ValueTag::Num: out << value.data.num; break;
        case ValueTag::Bool: out << (value.data.boolean ? "true" : "false"); break;
        case ValueTag::Text: out << '"' << text << '"'; break;
        case ValueTag::Enum: out << "enum(" << value.type_id << "," << value.data.integer << ")"; break;
        case ValueTag::Color: out << format_color(value.data.rgba); break;
        case ValueTag::List: out << "list"; break;
        case ValueTag::Map: out << "map"; break;
    }
    return out.str();
}

/* an aggregate field with its elements resolved: what the transcript pins for the
 * write-out tests — a list as [a,b,c], a map as {k=v,...} */
std::string print_agg(const Value& value, const MeshElems& span) {
    const bool pairs = value.tag == ValueTag::Map;
    std::ostringstream out;
    out << std::setprecision(17);
    out << (pairs ? "{" : "[");
    for (uint32_t k = 0; k < span.count; ++k) {
        const std::string_view text = span.texts ? span.texts[k] : std::string_view{};
        if (pairs) {
            if (k % 2 == 0) {
                if (k) out << ",";
                out << text << "=";
                continue;
            }
        } else if (k) {
            out << ",";
        }
        out << print_value(span.data[k], text);
    }
    out << (pairs ? "}" : "]");
    return out.str();
}

} // namespace

FakeMesh::FakeMesh(std::vector<EntityDef> entities) : entities_(std::move(entities)) {}

const std::vector<EntityDef>& FakeMesh::reflection() const noexcept { return entities_; }

bool FakeMesh::execute(const EffectView& effect, std::string& fault) noexcept {
    if (!effect.entity) {
        fault = "effect has no entity";
        return false;
    }
    std::ostringstream out;
    out << verb_name(effect.verb) << " " << entity_kind_name(effect.entity->kind) << ":"
        << effect.entity->name;
    if (effect.verb == Verb::Unforce) {
        transcript_.push_back(out.str());
        return true;
    }
    const auto span_of = [&](uint32_t field) -> const MeshElems* {
        return effect.elems && field < effect.field_count && effect.elems[field].data
                   ? &effect.elems[field]
                   : nullptr;
    };
    if (effect.bare) {
        if (effect.field < effect.entity->fields.size() &&
            !effect.entity->fields[effect.field].path.empty())
            out << "." << effect.entity->fields[effect.field].path;
        if (effect.elem_index != UINT32_MAX) out << "[" << effect.elem_index << "]";
        const MeshElems* span = span_of(effect.field);
        out << "=" << (span && effect.elem_index == UINT32_MAX
                           ? print_agg(effect.value, *span)
                           : print_value(effect.value, effect.bare_text));
    } else {
        out << "{";
        for (uint32_t i = 0; i < effect.field_count; ++i) {
            if (i) out << ",";
            const MeshElems* span = span_of(i);
            out << effect.entity->fields[i].path << "="
                << (span ? print_agg(effect.fields[i], *span)
                         : print_value(effect.fields[i], effect.field_text[i].view()));
        }
        out << "}";
    }
    transcript_.push_back(out.str());
    return true;
}

void FakeMesh::drain(MeshSink& sink) {
    for (const Update& update : updates_) {
        std::vector<std::string_view> views(update.fields.size());
        for (size_t i = 0; i < update.fields.size(); ++i)
            if (update.fields[i].tag == ValueTag::Text &&
                update.fields[i].ref < update.texts.size())
                views[i] = update.texts[update.fields[i].ref];
        std::vector<MeshElems> elems;
        std::vector<std::vector<std::string_view>> elem_views;
        if (!update.elems.empty()) {
            elems.resize(update.fields.size());
            elem_views.resize(update.fields.size());
            for (size_t i = 0; i < update.elems.size() && i < update.fields.size(); ++i) {
                const FieldElems& source = update.elems[i];
                if (source.data.empty()) continue;
                elem_views[i].resize(source.data.size());
                for (size_t k = 0; k < source.data.size(); ++k)
                    if (source.data[k].tag == ValueTag::Text &&
                        source.data[k].ref < source.texts.size())
                        elem_views[i][k] = source.texts[source.data[k].ref];
                elems[i].data = source.data.data();
                elems[i].texts = elem_views[i].data();
                elems[i].count = static_cast<uint32_t>(source.data.size());
            }
        }
        MeshUpdate out;
        out.kind = update.kind;
        out.name = update.name;
        out.fields = update.fields.data();
        out.texts = views.data();
        out.elems = elems.empty() ? nullptr : elems.data();
        out.field_count = static_cast<uint32_t>(update.fields.size());
        sink.on_update(out);
    }
    updates_.clear();
}

void FakeMesh::push_update(EntityKind kind, std::string name, std::vector<Value> fields,
                           std::vector<std::string> texts) {
    updates_.push_back(Update{kind, std::move(name), std::move(fields), std::move(texts), {}});
}

void FakeMesh::push_elems(uint32_t field, std::vector<Value> elements,
                          std::vector<std::string> texts) {
    if (updates_.empty()) return;
    Update& update = updates_.back();
    if (update.elems.size() < update.fields.size()) update.elems.resize(update.fields.size());
    if (field >= update.elems.size()) return;
    update.elems[field] = FieldElems{std::move(elements), std::move(texts)};
}

void FakeMesh::retype(std::vector<EntityDef> entities) {
    entities_ = std::move(entities);
    changed_ = true;
}

bool FakeMesh::refresh() {
    const bool changed = changed_;
    changed_ = false;
    return changed;
}

void FakeMesh::clear() { transcript_.clear(); }

const std::vector<std::string>& FakeMesh::transcript() const { return transcript_; }

} // namespace hmi

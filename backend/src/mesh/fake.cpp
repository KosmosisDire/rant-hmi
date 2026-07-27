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
        case ValueTag::Enum: out << "enum(" << value.enum_type << "," << value.data.integer << ")"; break;
        case ValueTag::Color: out << format_color(value.data.rgba); break;
        case ValueTag::List: out << "list"; break;
        case ValueTag::Map: out << "map"; break;
    }
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
    if (effect.bare) {
        if (effect.field < effect.entity->fields.size())
            out << "." << effect.entity->fields[effect.field].path;
        out << "=" << print_value(effect.value, effect.bare_text);
    } else {
        out << "{";
        for (uint32_t i = 0; i < effect.field_count; ++i) {
            if (i) out << ",";
            out << effect.entity->fields[i].path << "="
                << print_value(effect.fields[i], effect.field_text[i].view());
        }
        out << "}";
    }
    transcript_.push_back(out.str());
    return true;
}

void FakeMesh::clear() { transcript_.clear(); }

const std::vector<std::string>& FakeMesh::transcript() const { return transcript_; }

} // namespace hmi

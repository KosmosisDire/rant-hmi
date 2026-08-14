/* THE ENV: everything ambient a surface's expressions may name, as an
 * OBJECT-DESCRIPTOR ROSTER. Every host object — a variable, the clock, a timer, a
 * mesh entity, `this`, the pipeline register `x` — is one entry: an optional bare
 * VALUE (the read of the name itself) plus typed FIELDS (dotted paths under it), each
 * a Place saying what type it is and which load fetches it. The checker resolves
 * names against descriptors and nothing else, so adding an ambient value is a
 * descriptor entry, never a language edit.
 *
 * Compile-time only: the runtime never sees this. The caller (the document compiler,
 * a test) decides what exists here and in whose words a missing name is refused. */
#pragma once

#include "lang/ir.h"
#include "lang/type.h"

#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace hmi {

/* an enum type's vocabulary: variant name -> backing integer, in declaration order */
using EnumVariants = std::vector<std::pair<std::string, int64_t>>;

/* one readable place: its type and the instruction that fetches it */
struct Place {
    Type type;
    OpCode load = OpCode::Load;
    uint32_t a = 0;
    uint32_t b = 0;
};

struct HostObject {
    /* the bare read of the name itself; absent where the object reads only by field
     * (the clock, a timer, a whole-message entity) */
    std::optional<Place> value;
    /* dotted paths under the name ("running", "pos.x", "bar.fill_color") */
    std::map<std::string, Place> fields;
    /* what reading the bare name of a fields-only object teaches, in the binder's
     * words ("'time' reads by field (time.now / ...)"). Empty = the checker's
     * generic whole-message refusal. */
    std::string bare_refusal;
};

struct Env {
    std::map<std::string, HostObject> objects;
    /* WORDS THAT MEAN SOMETHING IN THE LANGUAGE BUT NOTHING HERE, each with the whole
     * message in the caller's words (`repeat` in a flow no copy can trigger; `x` in a
     * slot expression). A word refused here is refused WHOLE — its dots are never
     * walked — and a name the roster binds as a value still wins over a refusal. */
    std::map<std::string, std::string> refused;
    /* WHY A NAME IS NOT HERE, appended to every unknown-name and unknown-entity
     * refusal (a component's deliberately narrow scope is not a typo). */
    std::string unknown_help;
    /* the enum vocabulary behind each type-table id (null rows = not an enum): type
     * data the checker resolves `.variant` and `.is()` against */
    std::vector<const EnumVariants*> enums;

    void bind_value(const std::string& name, Place place) {
        objects[name].value = std::move(place);
    }
    void bind_field(const std::string& root, const std::string& path, Place place) {
        objects[root].fields[path] = std::move(place);
    }
    void refuse(const std::string& word, std::string why) {
        refused[word] = std::move(why);
    }
    const EnumVariants* variants(uint16_t type_id) const {
        return type_id < enums.size() ? enums[type_id] : nullptr;
    }
};

} // namespace hmi

/* The compiler's TYPE — a value, not a flag plus side channels. Recursive: an
 * aggregate carries its element type by pointer, so deeper element knowledge
 * (stage 4 of the rewrite) is a data change, not a redesign. At stage 2 it carries
 * exactly what the old shape tracker did — a kind, an enum id, one element level —
 * so what compiles and what refuses is unchanged. */
#pragma once

#include "lang/value.h"

#include <memory>

namespace hmi {

struct Type {
    Shape kind = Shape::Unknown;
    /* Enum: the type-table id (0 = untyped) */
    uint16_t id = 0;
    /* List/Map: the element type (a map's VALUE type; keys are text). Null = unstated,
     * which the checker treats exactly as it treats Unknown. */
    std::shared_ptr<const Type> elem;

    Type() = default;
    explicit Type(Shape kind, uint16_t id = 0) : kind(kind), id(id) {}

    static Type list_of(Shape kind, Shape elem_kind) {
        Type type(kind);
        if (elem_kind != Shape::Unknown)
            type.elem = std::make_shared<const Type>(elem_kind);
        return type;
    }

    Shape elem_shape() const { return elem ? elem->kind : Shape::Unknown; }
    uint16_t enum_id() const { return kind == Shape::Enum ? id : 0; }
};

} // namespace hmi

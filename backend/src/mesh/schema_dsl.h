/* The reflected field table spelled back as compile-ready DSL. The HMI types its
 * handles with a schema REBUILT from a peer's dart::SchemaInfo snapshot; the rebuild is
 * only faithful when it reproduces the owner's canonical wire byte for byte (hence its
 * hash), and the match gate refuses anything less: a NAMED type narrows (an anonymous
 * struct reads a `Color` writer, a `Color` reader refuses an anonymous one), so a
 * dropped name turns `color: Color` into a request every named reader rejects. This
 * mirrors the library's own printer (dart_schema_print): every named type hoisted to a
 * leading `Name = type` definition, dependencies first, each once; the root last. */
#pragma once

#include <string>

namespace dart {
struct SchemaInfo;
}

namespace hmi {

std::string schema_dsl(const dart::SchemaInfo& info);

} // namespace hmi

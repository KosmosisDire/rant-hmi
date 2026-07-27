/* The document: the only authoring artifact and the only input to the compiler.
 * Held as JSON so serialization is exact and the generic op machinery (ops.h) works
 * off the schema table rather than per-node code; every addressable node carries a
 * stable id, and the id index resolves one to its parent, list and position. */
#pragma once

#include "schema.h"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace hmi {

/* the root Doc node is addressable as id 0 (so ops can insert into its lists) */
constexpr uint64_t kDocId = 0;

struct NodeEntry {
    Kind kind = Kind::Doc;
    Json* node = nullptr;
    uint64_t parent = kDocId;
    std::string list;       /* the parent list this node sits in ("" for the root) */
    size_t index = 0;       /* its position in that list */
};

class Document {
  public:
    Json root = Json::object();

    /* a starter document: one page, a small demo composition */
    static Document make_default();

    static bool from_file(const std::string& path, Document& out, std::string& err);
    bool to_file(const std::string& path, std::string& err) const;

    /* adopt parsed JSON: fills defaults, issues missing ids, validates, indexes */
    bool adopt(Json j, std::string& err);

    uint64_t version() const;
    void set_version(uint64_t v);
    uint64_t issue_id();

    void reindex();
    const NodeEntry* find(uint64_t id) const;
    NodeEntry* find(uint64_t id);
    Json* node(uint64_t id);
    const Json* node(uint64_t id) const;

    /* every widget in document order, with the page it belongs to */
    struct WidgetRef { Json* page; Json* widget; };
    std::vector<WidgetRef> widgets();

    /* Fill defaults and issue ids over a subtree being inserted, validating as it
     * goes. Rejects unknown keys and wrong value types. */
    bool prepare(Kind kind, Json& node, std::string& err);

  private:
    std::unordered_map<uint64_t, NodeEntry> index_;
    void index_subtree(Json& node, Kind kind, uint64_t parent, const std::string& list, size_t idx);
};

/* Value check for one prop, shared by insert and set_prop. null is always accepted
 * and means "unset" (an optional poll rate, a cleared expression). */
bool check_prop(const Prop& prop, const Json& value, std::string& err);

} // namespace hmi

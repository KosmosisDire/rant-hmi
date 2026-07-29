/* DartMesh: MeshPort over a real dart::Node (see dart_mesh.h). Layout of the file:
 * reflection (entity fold + field tables + the DSL rebuild), the per-entity record,
 * consumption (subscribe / observe / listen / poll), drain (decode into the sink),
 * and effects (encode by the owner's reflected layout).
 *
 * Codec note: encode/decode go through the embedded C serialize API (dart::detail::
 * dart_get_* / dart_set_* on raw buffers) rather than a re-implementation; the public
 * Schema::raw() is the sanctioned bridge to it. Write-side handles are TYPED with a
 * schema rebuilt to DSL from the reflected field table: an identical structure compiles
 * to the identical canonical wire, hence the identical hash, so the mesh's schema gate
 * sees the owner's own type and never a foreign one.
 *
 * Threading: every MeshPort entry runs on the logic thread. The node's service thread
 * only touches per-record slots and rings behind their own mutex (variable on_change,
 * signal handler, async call completions); topics queue inside DART and are taken here.
 * Records are never destroyed while the node lives, so handler captures stay valid. */
#include "dart_mesh.h"

#include "dart.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <deque>
#include <map>
#include <mutex>
#include <optional>

namespace hmi {
namespace {

namespace dc = dart::detail;

using Clock = std::chrono::steady_clock;

constexpr size_t kSignalRingCap = 256;   /* queued signal fires before oldest drops */
constexpr int kTakeBudget = 256;         /* topic messages decoded per entity per tick */
constexpr uint32_t kEffectWaitUs = 20000;   /* bounded backpressure for effect sends */

EntityKind kind_of(dart::EntityKind kind) {
    switch (kind) {
        case dart::EntityKind::Variable: return EntityKind::Variable;
        case dart::EntityKind::Function: return EntityKind::Function;
        case dart::EntityKind::Signal: return EntityKind::Signal;
        case dart::EntityKind::Topic: default: return EntityKind::Topic;
    }
}

char kind_letter(EntityKind kind) {
    switch (kind) {
        case EntityKind::Variable: return 'V';
        case EntityKind::Topic: return 'T';
        case EntityKind::Function: return 'F';
        case EntityKind::Signal: return 'S';
    }
    return '?';
}

std::string rec_key(EntityKind kind, std::string_view name) {
    std::string key(1, kind_letter(kind));
    key += ':';
    key.append(name.data(), name.size());
    return key;
}

const char* scalar_name(dart::FieldType kind) {
    static const char* names[] = {"u8", "u16", "u32", "u64", "i8", "i16",
                                  "i32", "i64", "f32", "f64", "bool"};
    const int at = static_cast<int>(kind);
    return at >= 0 && at <= 10 ? names[at] : "u8";
}

/* Spell the reflected field table back as compile-ready DSL (the flat table is
 * depth-first: a struct's members directly follow it one level deeper). Commas between
 * fields are optional in the DSL, so fields self-delimit with whitespace. */
std::string schema_dsl(const dart::SchemaInfo& info) {
    std::string out = info.name.empty() ? std::string("T") : info.name;
    out += " { ";
    uint16_t open = 0;
    for (const dart::SchemaField& field : info.fields) {
        while (open > field.depth) {
            out += "} ";
            --open;
        }
        out += field.name;
        out += ": ";
        switch (field.kind) {
            case dart::FieldType::Struct:
                out += "{ ";
                ++open;
                continue;
            case dart::FieldType::String:
                out += "string<" + std::to_string(field.str_cap) + ">";
                break;
            case dart::FieldType::VString:
                out += "string";
                break;
            case dart::FieldType::Array:
            case dart::FieldType::VArray: {
                if (field.elem == dart::FieldType::String)
                    out += "string<" + std::to_string(field.str_cap) + ">";
                else
                    out += scalar_name(field.elem);
                out += "[";
                if (field.kind == dart::FieldType::Array)
                    out += std::to_string(field.count);
                out += "]";
                break;
            }
            case dart::FieldType::Map:
                out += "map";
                break;
            case dart::FieldType::Enum: {
                out += "enum<";
                out += scalar_name(field.elem);
                out += "> { ";
                bool first = true;
                for (const dart::SchemaField::Option& option : field.variants) {
                    if (!first) out += ", ";
                    first = false;
                    out += option.name + "=" + std::to_string(option.value);
                }
                out += " }";
                break;
            }
            default:
                out += scalar_name(field.kind);
                break;
        }
        out += " ";
    }
    while (open) {
        out += "} ";
        --open;
    }
    out += "}";
    return out;
}

/* how one presented field encodes on the wire (aligned 1:1 with the FieldDef table) */
struct EncField {
    std::string path;
    dart::FieldType kind = dart::FieldType::U8;
    dart::FieldType elem = dart::FieldType::U8;   /* enum backing */
};

/* The reflected schema as the HMI's field vocabulary: dotted leaf paths. Struct
 * containers contribute their name to the path. Aggregate kinds present as List/Map
 * shapes for the READ side (feeds decode their elements into the scratch pool); the
 * write side never builds them (a wire value is one scalar), so encode skips them and
 * the RMW base preserves the owner's aggregate bytes untouched. */
void build_fields(const dart::SchemaInfo& info, std::vector<FieldDef>& out,
                  std::vector<EncField>* enc) {
    std::vector<std::string> stack;
    for (const dart::SchemaField& field : info.fields) {
        stack.resize(field.depth);
        std::string path;
        for (const std::string& part : stack) path += part + ".";
        path += field.name;
        if (field.kind == dart::FieldType::Struct) {
            stack.push_back(field.name);
            continue;
        }
        FieldDef def;
        def.path = path;
        switch (field.kind) {
            case dart::FieldType::Bool: def.shape = Shape::Bool; break;
            case dart::FieldType::String:
            case dart::FieldType::VString: def.shape = Shape::Text; break;
            case dart::FieldType::Enum:
                def.shape = Shape::Enum;
                for (const dart::SchemaField::Option& option : field.variants)
                    def.variants.push_back({option.name, option.value});
                break;
            case dart::FieldType::Array:
            case dart::FieldType::VArray:
                def.shape = Shape::List;
                def.elem = field.elem == dart::FieldType::String ? Shape::Text
                           : field.elem == dart::FieldType::Bool ? Shape::Bool
                                                                 : Shape::Num;
                def.bound = field.kind == dart::FieldType::Array
                                ? field.count
                                : kVarrCeiling;
                break;
            case dart::FieldType::Map:
                def.shape = Shape::Map;
                def.bound = kVarrCeiling;
                break;
            default: def.shape = Shape::Num; break;
        }
        out.push_back(std::move(def));
        if (enc) enc->push_back(EncField{path, field.kind, field.elem});
    }
}

/* scalar element sizes on the wire (little-endian; LE host assumed per PLAN.md) */
size_t elem_size_of(dart::FieldType kind) {
    switch (kind) {
        case dart::FieldType::U8:
        case dart::FieldType::I8:
        case dart::FieldType::Bool: return 1;
        case dart::FieldType::U16:
        case dart::FieldType::I16: return 2;
        case dart::FieldType::U32:
        case dart::FieldType::I32:
        case dart::FieldType::F32: return 4;
        default: return 8;   /* U64 I64 F64 */
    }
}

Value scalar_elem(dart::FieldType kind, const uint8_t* at) {
    uint64_t raw = 0;
    const size_t size = elem_size_of(kind);
    for (size_t i = 0; i < size; ++i) raw |= static_cast<uint64_t>(at[i]) << (8 * i);
    switch (kind) {
        case dart::FieldType::Bool: return Value::boolean(raw != 0);
        case dart::FieldType::I8: return Value::number(static_cast<int8_t>(raw));
        case dart::FieldType::I16: return Value::number(static_cast<int16_t>(raw));
        case dart::FieldType::I32: return Value::number(static_cast<int32_t>(raw));
        case dart::FieldType::I64:
            return Value::number(static_cast<double>(static_cast<int64_t>(raw)));
        case dart::FieldType::F32: {
            float value = 0;
            std::memcpy(&value, at, sizeof(value));
            return Value::number(value);
        }
        case dart::FieldType::F64: {
            double value = 0;
            std::memcpy(&value, at, sizeof(value));
            return Value::number(value);
        }
        default: return Value::number(static_cast<double>(raw));
    }
}

/* one decoded field by the SENDER's layout (the schema the payload arrived with) */
Value decode_field(dc::DartBytes data, const dc::DartSchema* schema, const char* path,
                   std::string& text_out) {
    const int index = dc::dart_schema_field_index(schema, path);
    if (index < 0) return Value::nil();
    dc::DartSchemaFieldInfo info;
    if (!dc::dart_schema_field_at(schema, static_cast<uint16_t>(index), &info))
        return Value::nil();
    switch (static_cast<dart::FieldType>(info.kind)) {
        case dart::FieldType::U8:
        case dart::FieldType::U16:
        case dart::FieldType::U32:
        case dart::FieldType::U64:
            return Value::number(static_cast<double>(dc::dart_get_uint(data, schema, path)));
        case dart::FieldType::I8:
        case dart::FieldType::I16:
        case dart::FieldType::I32:
        case dart::FieldType::I64:
            return Value::number(static_cast<double>(dc::dart_get_int(data, schema, path)));
        case dart::FieldType::F32:
            return Value::number(static_cast<double>(dc::dart_get_f32(data, schema, path)));
        case dart::FieldType::F64:
            return Value::number(dc::dart_get_f64(data, schema, path));
        case dart::FieldType::Bool:
            return Value::boolean(dc::dart_get_uint(data, schema, path) != 0);
        case dart::FieldType::Enum:
            return Value::enumeration(dc::dart_get_int(data, schema, path), 0);
        case dart::FieldType::String:
        case dart::FieldType::VString: {
            const dc::DartString s = dc::dart_get_string(data, schema, path);
            text_out.assign(s.data ? s.data : "", s.len);
            return Value::text(0);   /* the view rides beside the value, not the ref */
        }
        default:
            return Value::nil();
    }
}

} // namespace

/* ======================= the per-entity record ============================== */

struct Rec {
    EntityKind kind = EntityKind::Topic;
    std::string name;

    /* the owner's reflected schema(s) + our faithful recompilations */
    dart::SchemaInfo schema;                    /* value / payload / request */
    dart::SchemaInfo rsp_schema;                /* FUNCTION: response */
    std::optional<dart::Schema> compiled;
    std::optional<dart::Schema> rsp_compiled;

    /* the field vocabulary as the compiler sees it, plus per-field encode info */
    std::vector<FieldDef> fields;
    std::vector<FieldDef> rsp_fields;
    std::vector<EncField> enc;

    /* handles, created on first need, cached for the node's lifetime */
    std::optional<dart::Topic> topic;           /* Topic entity: sub + (role-flipped) pub */
    bool topic_pub = false;
    std::optional<dart::RemoteVariable<>> var;
    std::optional<dart::Signal<>> sig;
    std::optional<dart::RemoteFunction<>> fn;

    /* latest-wins slot: variable updates and function responses (service thread in,
     * logic thread out); signals keep order in a bounded ring instead */
    std::mutex slot_mu;
    std::vector<uint8_t> slot;
    const dc::DartSchema* slot_schema = nullptr;
    bool slot_dirty = false;
    std::deque<std::pair<std::vector<uint8_t>, const dc::DartSchema*>> ring;
    size_t ring_dropped = 0;

    /* RMW base: the owner's exact last payload bytes (logic thread only) */
    std::vector<uint8_t> last_payload;
    uint64_t last_payload_hash = 0;
    const dc::DartSchema* last_schema = nullptr;   /* interned in the node, safe to keep */

    /* function polling (logic thread; inflight also cleared by the async callback) */
    uint32_t poll_ms = 0;
    std::vector<uint64_t> pages;
    Clock::time_point next_poll{};
    std::atomic<bool> inflight{false};
    std::vector<uint8_t> default_request;

    /* decode scratch, reused per delivery */
    std::vector<Value> values;
    std::vector<std::string> texts;
    std::vector<std::string_view> views;
    /* aggregate element scratch: elements flattened across the delivery's fields,
     * spans built after decoding (vector addresses are stable by then) */
    struct ElemMeta {
        uint32_t field = 0;
        uint32_t offset = 0;
        uint32_t count = 0;
    };
    std::vector<Value> elem_pool;
    std::vector<std::string> elem_strings;
    std::vector<std::string_view> elem_views;
    std::vector<MeshElems> elem_spans;
    std::vector<ElemMeta> elem_meta;

    /* encode scratch */
    std::vector<uint8_t> out;
};

struct DartMesh::Impl {
    DartMeshOptions opts;

    /* recs before node: the node tears down first (joining its service thread), after
     * which no handler can touch a rec. Handles are non-owning, safe to outlive. */
    std::map<std::string, std::unique_ptr<Rec>> recs;
    std::optional<dart::Node> node;

    std::atomic<bool> dirty{true};
    std::vector<EntityDef> entities;
    std::string signature;
    /* per-entity reflected schemas from the last refresh, keyed like recs */
    std::map<std::string, dart::Entity> folded;

    std::vector<uint64_t> viewed_pages;

    Rec* ensure_rec(const EntityDef& def);
    void fill_rec_schema(Rec& rec, const dart::Entity& folded_entity) const;
    bool ensure_consumption(Rec& rec, std::string& err);
    bool encode(Rec& rec, const EffectView& effect, std::string& fault);
    void deliver(MeshSink& sink, Rec& rec, const std::vector<FieldDef>& fields,
                 dc::DartBytes data, const dc::DartSchema* schema);
    bool page_viewed(const Rec& rec) const;
    void log(const char* what, const std::string& detail) const {
        if (opts.verbose) std::printf("hmi mesh: %s %s\n", what, detail.c_str());
    }
};

DartMesh::DartMesh(DartMeshOptions opts) : impl_(new Impl()) { impl_->opts = std::move(opts); }
DartMesh::~DartMesh() = default;

bool DartMesh::start(std::string& err) {
    dart::NodeOptions options;
    options.domain = impl_->opts.domain;
    options.max_topics = impl_->opts.max_topics;
    options.fetch_details = true;   /* every peer entity's name + schema, observer style */
    options.match_wait_ms = 50;     /* effects block briefly for a forming match, never 1s */
    options.multicast_interface = impl_->opts.interface_ip;
    options.seed_peers = impl_->opts.seed_peers;
    options.discovery_port = impl_->opts.discovery_port;
    options.announce_interval_us = impl_->opts.announce_interval_us;
    Impl* impl = impl_.get();
#if defined(__cpp_exceptions)
    try {
#endif
        impl_->node.emplace(
            impl_->opts.node_name, dart::Node::MessageHandler{},
            [impl](const dart::Event& event) {
                switch (event.kind()) {
                    case dart::EventKind::PeerUp:
                    case dart::EventKind::PeerDown:
                    case dart::EventKind::PeerInterest:
                        impl->dirty.store(true, std::memory_order_relaxed);
                        break;
                    default: break;
                }
                if (event.is_error() && impl->opts.verbose)
                    std::printf("hmi mesh: %s\n", event.to_string().c_str());
            },
            options);
#if defined(__cpp_exceptions)
    } catch (const std::exception& e) {
        err = e.what();
        return false;
    }
#endif
    if (!impl_->node || !impl_->node->valid()) {
        err = dart::Node::last_open_error();
        return false;
    }
    if (!impl_->node->start()) {
        err = "mesh service thread failed to start";
        return false;
    }
    return true;
}

const std::vector<EntityDef>& DartMesh::reflection() const noexcept { return impl_->entities; }

void DartMesh::set_viewed_pages(const std::vector<uint64_t>& pages) {
    impl_->viewed_pages = pages;
}

/* ============================ reflection ==================================== */

bool DartMesh::refresh() {
    if (!impl_->node || !impl_->node->valid()) return false;
    impl_->dirty.store(false, std::memory_order_relaxed);

    /* fold every peer's advertised entities by (kind, name). The provider side owns
     * the schema and reliability; consumers only widen writable/forceable. */
    std::map<std::string, dart::Entity> fold;
    for (const dart::Peer& peer : impl_->node->peers()) {
        for (dart::Entity& entity : impl_->node->peer_entities(peer.id)) {
            if (entity.name.empty() || entity.name.compare(0, 2, "0x") == 0)
                continue;   /* details not fetched yet; the next refresh sees them */
            const std::string key = rec_key(kind_of(entity.kind), entity.name);
            auto it = fold.find(key);
            if (it == fold.end()) {
                fold.emplace(key, std::move(entity));
                continue;
            }
            dart::Entity& kept = it->second;
            kept.writable = kept.writable || entity.writable;
            kept.forceable = kept.forceable || entity.forceable;
            const bool better_schema =
                !entity.schema.empty() &&
                (kept.schema.empty() || (entity.provides && !kept.provides));
            if (better_schema) {
                kept.schema = std::move(entity.schema);
                kept.schema_hash = entity.schema_hash;
                kept.rsp_schema = std::move(entity.rsp_schema);
                kept.rsp_schema_hash = entity.rsp_schema_hash;
                kept.reliable = entity.reliable;
                kept.provides = kept.provides || entity.provides;
            }
        }
    }

    std::vector<EntityDef> next;
    std::string signature;
    for (const auto& item : fold) {
        const dart::Entity& entity = item.second;
        EntityDef def;
        def.kind = kind_of(entity.kind);
        def.name = entity.name;
        def.readable = true;
        def.writable = def.kind == EntityKind::Variable ? entity.writable : true;
        def.forceable = def.kind == EntityKind::Variable && entity.forceable;
        /* the schema's root type name is the only name a type has (spec 2.2); the hash
         * is its identity, so two entities of one type fold to one type-table entry */
        def.type_name = entity.schema.name;
        def.schema_hash = entity.schema_hash;
        build_fields(entity.schema, def.fields, nullptr);
        if (def.kind == EntityKind::Function)
            build_fields(entity.rsp_schema, def.rsp_fields, nullptr);
        signature += item.first;
        signature += def.writable ? "+w" : "";
        signature += def.forceable ? "+f" : "";
        signature += entity.reliable ? "+r" : "";
        signature += ":" + std::to_string(entity.schema_hash);
        signature += "/" + std::to_string(entity.rsp_schema_hash);
        signature += ";";
        next.push_back(std::move(def));
    }
    if (signature == impl_->signature) return false;

    for (const auto& item : fold) {
        auto rec = impl_->recs.find(item.first);
        if (rec != impl_->recs.end() && rec->second->schema.hash != 0 &&
            rec->second->schema.hash != item.second.schema_hash)
            impl_->log("schema changed for live entity (handles keep the old type until restart)",
                       item.first);
    }
    impl_->signature = std::move(signature);
    impl_->entities = std::move(next);
    impl_->folded = std::move(fold);
    return true;
}

/* ====================== records and consumption ============================= */

Rec* DartMesh::Impl::ensure_rec(const EntityDef& def) {
    const std::string key = rec_key(def.kind, def.name);
    auto folded_it = folded.find(key);
    auto it = recs.find(key);
    if (it != recs.end()) {
        Rec& rec = *it->second;
        /* the compiler's field tables are the current truth; keep ours aligned */
        rec.fields = def.fields;
        rec.rsp_fields = def.rsp_fields;
        if (!rec.compiled && folded_it != folded.end() && !folded_it->second.schema.empty())
            fill_rec_schema(rec, folded_it->second);
        return &rec;
    }
    auto rec = std::make_unique<Rec>();
    rec->kind = def.kind;
    rec->name = def.name;
    rec->fields = def.fields;
    rec->rsp_fields = def.rsp_fields;
    if (folded_it != folded.end()) fill_rec_schema(*rec, folded_it->second);
    Rec* out = rec.get();
    recs.emplace(key, std::move(rec));
    return out;
}

/* (Re)build a record's compiled schemas + encode table from the latest reflection.
 * Runs at creation and again whenever a record still lacks a schema one has arrived
 * for (an entity that reflected untyped and typed later). Live HANDLES keep the type
 * they were created with; only the codec upgrades. */
void DartMesh::Impl::fill_rec_schema(Rec& rec, const dart::Entity& folded_entity) const {
    rec.schema = folded_entity.schema;
    rec.rsp_schema = folded_entity.rsp_schema;
    const std::string key = rec_key(rec.kind, rec.name);
    if (!rec.schema.empty()) {
        std::string err;
        rec.compiled = dart::Schema::compile(schema_dsl(rec.schema), &err);
        if (!rec.compiled) log("schema rebuild failed", key + ": " + err);
    }
    if (!rec.rsp_schema.empty()) {
        std::string err;
        rec.rsp_compiled = dart::Schema::compile(schema_dsl(rec.rsp_schema), &err);
        if (!rec.rsp_compiled)
            log("response schema rebuild failed", key + ": " + err);
    }
    if (rec.compiled) {
        rec.enc.clear();
        std::vector<FieldDef> unused;
        build_fields(rec.schema, unused, &rec.enc);
        /* a faithful rebuild reproduces the owner's canonical wire, hence its hash */
        if (rec.compiled->hash() != rec.schema.hash)
            log("rebuilt schema hash differs from the reflected one", key);
        /* the default request a function poll sends */
        if (rec.kind == EntityKind::Function) {
            rec.default_request.resize(dc::dart_schema_msg_min(rec.compiled->raw()));
            dc::dart_schema_message_default(rec.compiled->raw(), rec.default_request.data(),
                                            rec.default_request.size());
        }
    }
}

bool DartMesh::Impl::ensure_consumption(Rec& rec, std::string& err) {
    const dart::Schema* schema = rec.compiled ? &*rec.compiled : nullptr;
#if defined(__cpp_exceptions)
    try {
#endif
        switch (rec.kind) {
            case EntityKind::Topic: {
                if (rec.topic) break;
                dart::Qos qos;
                /* request what the provider offers, so the match can never be refused
                 * by the RxO rule; a reliable provider then repairs into our queue */
                auto it = folded.find(rec_key(rec.kind, rec.name));
                qos.reliability = it != folded.end() && it->second.reliable
                                      ? dart::Reliability::Reliable
                                      : dart::Reliability::BestEffort;
                rec.topic.emplace(*node, rec.name, dart::Role::SubOnly, schema, qos);
                rec.topic->take(0);   /* switch to QUEUED delivery from the start */
                break;
            }
            case EntityKind::Variable: {
                if (rec.var) break;
                dart::VariableOptions<> options;
                options.backpressure_wait_us = kEffectWaitUs;
                rec.var.emplace(*node, rec.name, schema, options);
                Rec* self = &rec;
                rec.var->on_change([self](const dart::VariableUpdate& update) {
                    const dart::Bytes value = update.value();
                    std::lock_guard<std::mutex> hold(self->slot_mu);
                    self->slot.assign(value.begin(), value.end());
                    self->slot_schema = update.raw_schema();
                    self->slot_dirty = true;
                });
                break;
            }
            case EntityKind::Signal: {
                if (rec.sig) break;
                Rec* self = &rec;
                dart::SignalOptions options;
                options.backpressure_wait_us = kEffectWaitUs;
                rec.sig.emplace(*node, rec.name, schema,
                                [self](const dart::MessageView& msg) {
                                    const dart::Bytes data = msg.data();
                                    std::lock_guard<std::mutex> hold(self->slot_mu);
                                    if (self->ring.size() >= kSignalRingCap) {
                                        self->ring.pop_front();
                                        ++self->ring_dropped;
                                    }
                                    self->ring.emplace_back(
                                        std::vector<uint8_t>(data.begin(), data.end()),
                                        msg.raw_schema());
                                },
                                options);
                break;
            }
            case EntityKind::Function: {
                if (rec.fn) break;
                dart::FunctionOptions options;
                options.backpressure_wait_us = kEffectWaitUs;
                rec.fn.emplace(*node, rec.name, schema,
                               rec.rsp_compiled ? &*rec.rsp_compiled : nullptr, options);
                break;
            }
        }
#if defined(__cpp_exceptions)
    } catch (const std::exception& e) {
        err = e.what();
        return false;
    }
#endif
    return true;
}

void DartMesh::apply(const Program& program) {
    if (!impl_->node || !impl_->node->valid()) return;
    for (auto& item : impl_->recs) {
        item.second->poll_ms = 0;
        item.second->pages.clear();
    }
    /* consume one entity, returning its rec. A recompile starts from a fresh
     * RuntimeState: re-deliver the variable state we already hold, so its cells and
     * RMW seed refill on the next drain instead of waiting for the owner's next write */
    auto consume = [&](const EntityDef& def) -> Rec* {
        Rec* rec = impl_->ensure_rec(def);
        std::string err;
        if (!impl_->ensure_consumption(*rec, err)) {
            impl_->log("subscription failed", rec_key(def.kind, def.name) + ": " + err);
            return nullptr;
        }
        if (def.kind == EntityKind::Variable && !rec->last_payload.empty() &&
            rec->last_schema) {
            std::lock_guard<std::mutex> hold(rec->slot_mu);
            rec->slot = rec->last_payload;
            rec->slot_schema = rec->last_schema;
            rec->slot_dirty = true;
        }
        return rec;
    };
    for (const FeedProgram& feed : program.feeds) {
        if (feed.source_cell != UINT32_MAX) continue;
        if (feed.entity >= program.entities.size()) continue;
        const EntityDef& def = program.entities[feed.entity];
        Rec* rec = consume(def);
        if (!rec) continue;
        if (def.kind == EntityKind::Function && feed.poll_ms) {
            rec->poll_ms = rec->poll_ms ? std::min(rec->poll_ms, feed.poll_ms) : feed.poll_ms;
            if (std::find(rec->pages.begin(), rec->pages.end(), feed.page_id) ==
                rec->pages.end())
                rec->pages.push_back(feed.page_id);
        }
    }
    /* an entity a FLOW reads (`read <entity> -> local`, a single-field source) needs
     * the same consumption as a fed one: without a live subscription its last-value
     * mirror never fills and every read yields Nil, so a gate over it can never pass */
    for (const EntityDef& def : program.entities)
        if (def.flow_reads) consume(def);
}

/* ============================== drain ======================================= */

bool DartMesh::Impl::page_viewed(const Rec& rec) const {
    if (rec.pages.empty()) return true;
    for (uint64_t page : rec.pages) {
        if (page == 0) return true;
        if (std::find(viewed_pages.begin(), viewed_pages.end(), page) != viewed_pages.end())
            return true;
    }
    return false;
}

void DartMesh::Impl::deliver(MeshSink& sink, Rec& rec, const std::vector<FieldDef>& fields,
                             dc::DartBytes data, const dc::DartSchema* schema) {
    if (!schema || fields.empty()) return;
    rec.values.resize(fields.size());
    rec.texts.resize(fields.size());
    rec.views.assign(fields.size(), std::string_view{});
    rec.elem_pool.clear();
    rec.elem_strings.clear();
    rec.elem_meta.clear();

    auto map_scalar = [&](const dc::DartValue& entry) -> Value {
        switch (static_cast<dart::FieldType>(entry.kind)) {
            case dart::FieldType::U8:
            case dart::FieldType::U16:
            case dart::FieldType::U32:
            case dart::FieldType::U64:
                return Value::number(static_cast<double>(entry.v.u));
            case dart::FieldType::I8:
            case dart::FieldType::I16:
            case dart::FieldType::I32:
            case dart::FieldType::I64:
                return Value::number(static_cast<double>(entry.v.i));
            case dart::FieldType::F32:
            case dart::FieldType::F64:
                return Value::number(entry.v.f);
            case dart::FieldType::Bool:
                return Value::boolean(entry.v.u != 0);
            case dart::FieldType::VString: {
                const Value out = Value::text(static_cast<uint32_t>(rec.elem_strings.size()));
                rec.elem_strings.emplace_back(
                    entry.bytes.data ? reinterpret_cast<const char*>(entry.bytes.data) : "",
                    entry.bytes.len);
                return out;
            }
            default: return Value::nil();   /* nested arrays/maps: not represented */
        }
    };

    auto decode_agg = [&](const FieldDef& def, uint32_t field_index) -> Value {
        const int index = dc::dart_schema_field_index(schema, def.path.c_str());
        if (index < 0) return Value::nil();
        dc::DartValue raw;
        if (!dc::dart_get_value(data, schema, static_cast<uint16_t>(index), &raw))
            return Value::nil();
        const uint32_t offset = static_cast<uint32_t>(rec.elem_pool.size());
        const dart::FieldType kind = static_cast<dart::FieldType>(raw.kind);
        const uint32_t limit = def.bound ? def.bound : kVarrCeiling;
        if (kind == dart::FieldType::Map) {
            const dc::DartBytes body = raw.bytes;
            uint32_t pairs = std::min<uint32_t>(dc::dart_map_count(body), limit);
            uint32_t kept = 0;
            for (uint32_t e = 0; e < pairs; ++e) {
                dc::DartString key{};
                dc::DartValue entry{};
                if (!dc::dart_map_at(body, static_cast<uint16_t>(e), &key, &entry)) break;
                rec.elem_pool.push_back(
                    Value::text(static_cast<uint32_t>(rec.elem_strings.size())));
                rec.elem_strings.emplace_back(key.data ? key.data : "", key.len);
                rec.elem_pool.push_back(map_scalar(entry));
                ++kept;
            }
            rec.elem_meta.push_back(
                {field_index, offset, static_cast<uint32_t>(rec.elem_pool.size()) - offset});
            return Value::map(0, kept);
        }
        if (kind != dart::FieldType::Array && kind != dart::FieldType::VArray)
            return Value::nil();
        const dart::FieldType elem = static_cast<dart::FieldType>(raw.elem);
        if (elem == dart::FieldType::String) {
            uint32_t count = 0;
            while (count < limit) {
                const dc::DartString s = dc::dart_get_string_at(
                    data, schema, def.path.c_str(), static_cast<uint16_t>(count));
                if (!s.data) break;
                rec.elem_pool.push_back(
                    Value::text(static_cast<uint32_t>(rec.elem_strings.size())));
                rec.elem_strings.emplace_back(s.data, s.len);
                ++count;
            }
            rec.elem_meta.push_back({field_index, offset, count});
            return Value::list(0, count, ValueTag::Text);
        }
        const size_t size = elem_size_of(elem);
        uint32_t count = size ? static_cast<uint32_t>(raw.bytes.len / size) : 0;
        count = std::min(count, limit);
        for (uint32_t k = 0; k < count; ++k)
            rec.elem_pool.push_back(scalar_elem(elem, raw.bytes.data + k * size));
        rec.elem_meta.push_back({field_index, offset, count});
        return Value::list(0, count,
                           elem == dart::FieldType::Bool ? ValueTag::Bool : ValueTag::Num);
    };

    for (size_t i = 0; i < fields.size(); ++i) {
        if (fields[i].shape == Shape::List || fields[i].shape == Shape::Map) {
            rec.values[i] = decode_agg(fields[i], static_cast<uint32_t>(i));
            continue;
        }
        rec.values[i] = decode_field(data, schema, fields[i].path.c_str(), rec.texts[i]);
        if (rec.values[i].tag == ValueTag::Text) rec.views[i] = rec.texts[i];
    }

    /* element vectors are stable now: build the views and per-field spans */
    rec.elem_views.assign(rec.elem_pool.size(), std::string_view{});
    for (size_t k = 0; k < rec.elem_pool.size(); ++k)
        if (rec.elem_pool[k].tag == ValueTag::Text &&
            rec.elem_pool[k].ref < rec.elem_strings.size())
            rec.elem_views[k] = rec.elem_strings[rec.elem_pool[k].ref];
    bool any_elems = false;
    rec.elem_spans.assign(fields.size(), MeshElems{});
    for (const Rec::ElemMeta& meta : rec.elem_meta) {
        rec.elem_spans[meta.field] =
            MeshElems{rec.elem_pool.data() + meta.offset,
                      rec.elem_views.data() + meta.offset, meta.count};
        any_elems = true;
    }

    MeshUpdate update;
    update.kind = rec.kind;
    update.name = rec.name;
    update.fields = rec.values.data();
    update.texts = rec.views.data();
    update.elems = any_elems ? rec.elem_spans.data() : nullptr;
    update.field_count = static_cast<uint32_t>(fields.size());
    sink.on_update(update);
}

void DartMesh::drain(MeshSink& sink) {
    Impl& impl = *impl_;
    if (!impl.node || !impl.node->valid()) return;
    const Clock::time_point now = Clock::now();
    for (auto& item : impl.recs) {
        Rec& rec = *item.second;

        if (rec.topic) {
            for (int budget = 0; budget < kTakeBudget; ++budget) {
                std::optional<dart::Message<>> msg = rec.topic->take(0);
                if (!msg) break;
                const dart::Bytes data = msg->data();
                if (msg->raw_schema()) {
                    rec.last_payload.assign(data.begin(), data.end());
                    rec.last_payload_hash = dc::dart_schema_hash(msg->raw_schema());
                    rec.last_schema = msg->raw_schema();
                }
                impl.deliver(sink, rec, rec.fields,
                             dc::dart_bytes(data.data(), data.size()), msg->raw_schema());
            }
        }

        bool slot_dirty = false;
        const dc::DartSchema* schema = nullptr;
        {
            std::lock_guard<std::mutex> hold(rec.slot_mu);
            slot_dirty = rec.slot_dirty;
            if (slot_dirty) {
                rec.out.assign(rec.slot.begin(), rec.slot.end());
                schema = rec.slot_schema;
                rec.slot_dirty = false;
            }
        }
        if (slot_dirty) {
            if (rec.kind == EntityKind::Variable && schema) {
                rec.last_payload = rec.out;
                rec.last_payload_hash = dc::dart_schema_hash(schema);
                rec.last_schema = schema;
            }
            impl.deliver(sink, rec,
                         rec.kind == EntityKind::Function ? rec.rsp_fields : rec.fields,
                         dc::dart_bytes(rec.out.data(), rec.out.size()), schema);
        }

        while (true) {
            std::vector<uint8_t> payload;
            const dc::DartSchema* fire_schema = nullptr;
            {
                std::lock_guard<std::mutex> hold(rec.slot_mu);
                if (rec.ring.empty()) break;
                payload = std::move(rec.ring.front().first);
                fire_schema = rec.ring.front().second;
                rec.ring.pop_front();
            }
            impl.deliver(sink, rec, rec.fields,
                         dc::dart_bytes(payload.data(), payload.size()), fire_schema);
        }

        if (rec.fn && rec.poll_ms && impl.page_viewed(rec) && now >= rec.next_poll &&
            !rec.inflight.load(std::memory_order_relaxed)) {
            rec.next_poll = now + std::chrono::milliseconds(rec.poll_ms);
            rec.inflight.store(true, std::memory_order_relaxed);
            Rec* self = &rec;
            const dart::SendStatus status = rec.fn->call_async(
                dart::Bytes(rec.default_request.data(), rec.default_request.size()),
                [self](const dart::ResponseView<>& response) {
                    if (response.ok() && response.raw_schema()) {
                        const dart::Bytes data = response.data();
                        std::lock_guard<std::mutex> hold(self->slot_mu);
                        self->slot.assign(data.begin(), data.end());
                        self->slot_schema = response.raw_schema();
                        self->slot_dirty = true;
                    }
                    self->inflight.store(false, std::memory_order_relaxed);
                });
            if (status != dart::SendStatus::Ok)
                rec.inflight.store(false, std::memory_order_relaxed);
        }
    }
}

/* ============================== effects ===================================== */

bool DartMesh::Impl::encode(Rec& rec, const EffectView& effect, std::string& fault) {
    if (!rec.compiled) {
        fault = "entity '" + rec.name + "' has no reflected schema to encode with";
        return false;
    }
    const dc::DartSchema* schema = rec.compiled->raw();
    const size_t base_size = dc::dart_schema_msg_min(schema);

    /* the RMW base: the owner's exact last payload when its layout matches ours,
     * else the schema's defaults (a write before any read starts from defaults) */
    rec.out.assign(std::max(base_size, static_cast<size_t>(64)), 0);
    bool seeded = false;
    if (rec.kind == EntityKind::Variable && effect.verb != Verb::Publish) {
        if (rec.last_payload.empty() && rec.var) {
            if (auto current = rec.var->get()) {
                rec.last_payload = std::move(*current);
                rec.last_payload_hash = rec.compiled->hash();
            }
        }
        if (!rec.last_payload.empty() && rec.last_payload_hash == rec.compiled->hash()) {
            rec.out.assign(rec.last_payload.begin(), rec.last_payload.end());
            if (rec.out.size() < base_size) rec.out.resize(base_size, 0);
            seeded = true;
        }
    }
    if (!seeded) {
        rec.out.assign(base_size, 0);
        dc::dart_schema_message_default(schema, rec.out.data(), rec.out.size());
    }

    auto set_one = [&](uint32_t index, const Value& value, std::string_view text) -> bool {
        if (index >= rec.enc.size()) {
            fault = "effect names a field the schema does not have";
            return false;
        }
        const EncField& enc = rec.enc[index];
        const char* path = enc.path.c_str();
        auto grow_for = [&](size_t extra) {
            const size_t used =
                dc::dart_schema_msg_len(schema, rec.out.data(), rec.out.size());
            if (rec.out.size() < used + extra) rec.out.resize(used + extra);
        };
        int ok = 0;
        switch (enc.kind) {
            case dart::FieldType::U8:
            case dart::FieldType::U16:
            case dart::FieldType::U32:
            case dart::FieldType::U64:
                ok = dc::dart_set_uint(rec.out.data(), rec.out.size(), schema, path,
                                       value.tag == ValueTag::Bool
                                           ? (value.data.boolean ? 1u : 0u)
                                           : static_cast<uint64_t>(std::llround(
                                                 std::max(0.0, value.data.num))));
                break;
            case dart::FieldType::I8:
            case dart::FieldType::I16:
            case dart::FieldType::I32:
            case dart::FieldType::I64:
                ok = dc::dart_set_int(rec.out.data(), rec.out.size(), schema, path,
                                      static_cast<int64_t>(std::llround(value.data.num)));
                break;
            case dart::FieldType::F32:
                ok = dc::dart_set_f32(rec.out.data(), rec.out.size(), schema, path,
                                      static_cast<float>(value.data.num));
                break;
            case dart::FieldType::F64:
                ok = dc::dart_set_f64(rec.out.data(), rec.out.size(), schema, path,
                                      value.data.num);
                break;
            case dart::FieldType::Bool:
                ok = dc::dart_set_uint(rec.out.data(), rec.out.size(), schema, path,
                                       value_truth(value) ? 1u : 0u);
                break;
            case dart::FieldType::Enum:
                ok = dc::dart_set_int(rec.out.data(), rec.out.size(), schema, path,
                                      value.tag == ValueTag::Enum
                                          ? value.data.integer
                                          : static_cast<int64_t>(std::llround(value.data.num)));
                break;
            case dart::FieldType::String:
            case dart::FieldType::VString:
                grow_for(text.size() + 8);
                ok = dc::dart_set_string(rec.out.data(), rec.out.size(), schema, path,
                                         dc::dart_string(text.data(), text.size()));
                break;
            case dart::FieldType::Array:
            case dart::FieldType::VArray:
            case dart::FieldType::Map:
                /* aggregates are read-side only: the buffer holds an inert empty
                 * placeholder and the RMW base keeps the owner's bytes untouched */
                return true;
            default:
                fault = "field '" + enc.path + "' has a kind the HMI cannot encode";
                return false;
        }
        if (!ok) {
            fault = "field '" + enc.path + "' was refused by the schema";
            return false;
        }
        return true;
    };

    if (effect.bare) {
        if (!set_one(effect.field, effect.value, effect.bare_text)) return false;
    } else {
        const uint32_t count =
            std::min<uint32_t>(effect.field_count, static_cast<uint32_t>(rec.enc.size()));
        for (uint32_t i = 0; i < count; ++i) {
            const std::string_view text =
                effect.field_text ? effect.field_text[i].view() : std::string_view{};
            if (!set_one(i, effect.fields[i], text)) return false;
        }
    }
    const size_t live = dc::dart_schema_msg_len(schema, rec.out.data(), rec.out.size());
    rec.out.resize(live ? live : base_size);
    return true;
}

bool DartMesh::execute(const EffectView& effect, std::string& fault) noexcept {
    Impl& impl = *impl_;
    if (!effect.entity) {
        fault = "effect has no entity";
        return false;
    }
    if (!impl.node || !impl.node->valid()) {
        fault = "mesh node is not running";
        return false;
    }
    Rec* rec = impl.ensure_rec(*effect.entity);
    std::string err;
    if (!impl.ensure_consumption(*rec, err)) {
        fault = "entity '" + rec->name + "': " + err;
        return false;
    }

    if (effect.verb == Verb::Unforce) {
        if (!rec->var) {
            fault = "unforce needs a variable";
            return false;
        }
        const dart::SendStatus status = rec->var->unforce();
        if (status != dart::SendStatus::Ok) {
            fault = "unforce of '" + rec->name + "' was refused";
            return false;
        }
        return true;
    }

    if (!impl.encode(*rec, effect, fault)) return false;
    const dart::Bytes payload(rec->out.data(), rec->out.size());

    dart::SendStatus status = dart::SendStatus::Ok;
    switch (effect.verb) {
        case Verb::Write:
            status = rec->var ? rec->var->set(payload) : dart::SendStatus::NoTopic;
            break;
        case Verb::Force:
            status = rec->var ? rec->var->force(payload) : dart::SendStatus::NoTopic;
            break;
        case Verb::Publish: {
            if (!rec->topic) {
                fault = "publish target '" + rec->name + "' has no topic";
                return false;
            }
            if (!rec->topic_pub) {
                /* consumption created the topic SubOnly; the first publish widens it */
                rec->topic->set_role(dart::Role::PubSub);
                rec->topic_pub = true;
            }
            status = rec->topic->send(payload);
            break;
        }
        case Verb::Call: {
            if (!rec->fn) {
                fault = "call target '" + rec->name + "' has no function";
                return false;
            }
            Rec* self = rec;
            status = rec->fn->call_async(
                payload, [self](const dart::ResponseView<>& response) {
                    if (response.ok() && response.raw_schema()) {
                        const dart::Bytes data = response.data();
                        std::lock_guard<std::mutex> hold(self->slot_mu);
                        self->slot.assign(data.begin(), data.end());
                        self->slot_schema = response.raw_schema();
                        self->slot_dirty = true;
                    }
                });
            break;
        }
        case Verb::Emit:
            status = rec->sig ? rec->sig->emit(payload) : dart::SendStatus::NoTopic;
            break;
        default:
            fault = "verb does not apply to the mesh";
            return false;
    }
    if (status != dart::SendStatus::Ok) {
        fault = std::string(verb_name(effect.verb)) + " of '" + rec->name +
                "' failed (send status " + std::to_string(static_cast<int>(status)) + ")";
        return false;
    }
    if (rec->kind == EntityKind::Variable && rec->compiled) {
        rec->last_payload = rec->out;
        rec->last_payload_hash = rec->compiled->hash();
        rec->last_schema = rec->compiled->raw();
    }
    return true;
}

} // namespace hmi

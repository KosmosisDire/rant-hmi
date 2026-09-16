/* RantMesh: MeshPort over a real rant::Node (see rant_mesh.h). Layout of the file:
 * reflection (entity fold + field tables + the DSL rebuild), the per-entity record,
 * consumption (subscribe / observe / listen / poll), drain (decode into the sink),
 * and effects (encode by the owner's reflected layout).
 *
 * Codec note: encode/decode go through the embedded C serialize API (rant::detail::
 * rant_get_* / rant_set_* on raw buffers) rather than a re-implementation; the public
 * Schema::raw() is the sanctioned bridge to it. Write-side handles are TYPED with the
 * provider's own schema, copied off the node's reflection (rant::Entity carries owned
 * Schema values), so the mesh's schema gate sees the owner's type and never a foreign one.
 *
 * Threading: every MeshPort entry runs on the logic thread. The node's service thread
 * only touches per-record slots behind their own mutex (variable on_change, task
 * progress and outcomes, async call completions); topics queue inside RANT and are
 * taken here.
 * Records are never destroyed while the node lives, so handler captures stay valid. */
#include "rant_mesh.h"

#include "rant.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <deque>
#include <map>
#include <mutex>
#include <optional>
#include <thread>

namespace hmi {
namespace {

namespace dc = rant::detail;

using Clock = std::chrono::steady_clock;

constexpr int kTakeBudget = 256;         /* topic messages decoded per entity per tick */
constexpr uint32_t kEffectWaitUs = 20000;   /* bounded backpressure for effect sends */
constexpr int kOwnerWaitMs = 50;      /* one write's bounded wait on a still-forming owner match */
constexpr int kOwnerFormingMs = 2000; /* how long a fresh accessor is credited a forming match */
constexpr size_t kLogPendCap = 512;      /* undrained @rant/log lines before oldest drops */

EntityKind kind_of(rant::EntityKind kind) {
    switch (kind) {
        case rant::EntityKind::Variable: return EntityKind::Variable;
        case rant::EntityKind::Function: return EntityKind::Function;
        case rant::EntityKind::Task: return EntityKind::Task;
        case rant::EntityKind::Topic: default: return EntityKind::Topic;
    }
}

char kind_letter(EntityKind kind) {
    switch (kind) {
        case EntityKind::Variable: return 'V';
        case EntityKind::Topic: return 'T';
        case EntityKind::Function: return 'F';
        case EntityKind::Task: return 'K';
    }
    return '?';
}

std::string rec_key(EntityKind kind, std::string_view name) {
    std::string key(1, kind_letter(kind));
    key += ':';
    key.append(name.data(), name.size());
    return key;
}

/* how one presented field encodes on the wire (aligned 1:1 with the FieldDef table) */
struct EncField {
    std::string path;
    rant::FieldType kind = rant::FieldType::U8;
    rant::FieldType elem = rant::FieldType::U8;   /* enum backing */
    uint16_t str_cap = 0;   /* string elements: the slot cap ([u16 len][cap] each) */
};

/* The reflected schema as the HMI's field vocabulary: dotted leaf paths. Struct
 * containers contribute their name to the path. Aggregate kinds present as List/Map
 * shapes for the READ side (feeds decode their elements into the scratch pool); the
 * write side never builds them (a wire value is one scalar), so encode skips them and
 * the RMW base preserves the owner's aggregate bytes untouched. `prefix` roots every
 * path under one presented segment (a task's `progress.` / `result.` groups). */
void build_fields(const rant::Schema& schema, std::vector<FieldDef>& out,
                  std::vector<EncField>* enc, const char* prefix = "") {
    std::vector<std::string> stack;
    rant::Schema::Field field;
    for (uint16_t i = 0; schema.field_at(i, field); ++i) {
        stack.resize(field.depth);
        std::string path = prefix;
        for (const std::string& segment : stack) path += segment + ".";
        path.append(field.name.data(), field.name.size());
        /* a BARE schema's one anonymous field under a prefix presents as the prefix
           itself (a bare-f64 progress reads `@task.progress`) */
        if (!path.empty() && path.back() == '.') path.pop_back();
        if (field.kind == rant::FieldType::Struct) {
            stack.emplace_back(field.name);
            continue;
        }
        FieldDef def;
        def.path = path;
        switch (field.kind) {
            case rant::FieldType::Bool: def.shape = Shape::Bool; break;
            case rant::FieldType::String:
            case rant::FieldType::VString: def.shape = Shape::Text; break;
            case rant::FieldType::Enum: {
                def.shape = Shape::Enum;
                rant::Schema::EnumVariant option;
                for (uint16_t k = 0; schema.enum_variant(i, k, option); ++k)
                    def.variants.push_back({std::string(option.name), option.value});
                break;
            }
            case rant::FieldType::Array:
            case rant::FieldType::VArray:
                def.shape = Shape::List;
                def.elem = field.elem == rant::FieldType::String ? Shape::Text
                           : field.elem == rant::FieldType::Bool ? Shape::Bool
                                                                 : Shape::Num;
                def.bound = field.kind == rant::FieldType::Array
                                ? field.count
                                : kVarrCeiling;
                break;
            case rant::FieldType::Map:
                def.shape = Shape::Map;
                def.bound = kVarrCeiling;
                break;
            default: def.shape = Shape::Num; break;
        }
        out.push_back(std::move(def));
        if (enc) enc->push_back(EncField{path, field.kind, field.elem, field.str_cap});
    }
}

/* The READ table a TASK serves: the HMI's own call state first, then the progress
 * schema's fields under `progress.`, then the response schema's under `result.` —
 * ONE table like any entity's, delivered piecewise (the adapter Nil-pads around
 * whichever part arrived, and on_update skips Nil). The two leading facts are the
 * adapter's own: whether ITS call is outstanding, and the last outcome's human story
 * (RantResponse.message — the one field a generic consumer displays on failure). */
constexpr uint32_t kTaskLeadFields = 2;   /* running, message */

void build_task_read_fields(const rant::Entity& entity, std::vector<FieldDef>& out) {
    FieldDef running;
    running.path = "running";
    running.shape = Shape::Bool;
    out.push_back(std::move(running));
    FieldDef message;
    message.path = "message";
    message.shape = Shape::Text;
    out.push_back(std::move(message));
    build_fields(entity.progress_schema, out, nullptr, "progress.");
    build_fields(entity.rsp_schema, out, nullptr, "result.");
}

/* scalar element sizes on the wire (little-endian; LE host assumed per PLAN.md) */
size_t elem_size_of(rant::FieldType kind) {
    switch (kind) {
        case rant::FieldType::U8:
        case rant::FieldType::I8:
        case rant::FieldType::Bool: return 1;
        case rant::FieldType::U16:
        case rant::FieldType::I16: return 2;
        case rant::FieldType::U32:
        case rant::FieldType::I32:
        case rant::FieldType::F32: return 4;
        default: return 8;   /* U64 I64 F64 */
    }
}

/* one scalar element's wire bytes at `at` (little-endian, narrowing like a C cast —
 * the same rules the whole-field setters apply); the inverse of scalar_elem */
void pack_scalar_elem(rant::FieldType kind, const Value& value, uint8_t* at) {
    switch (kind) {
        case rant::FieldType::Bool:
            at[0] = value_truth(value) ? 1 : 0;
            return;
        case rant::FieldType::F32: {
            const float f = static_cast<float>(value.data.num);
            std::memcpy(at, &f, sizeof(f));
            return;
        }
        case rant::FieldType::F64:
            std::memcpy(at, &value.data.num, sizeof(double));
            return;
        default: {
            const bool unsigned_kind =
                kind == rant::FieldType::U8 || kind == rant::FieldType::U16 ||
                kind == rant::FieldType::U32 || kind == rant::FieldType::U64;
            const uint64_t raw =
                unsigned_kind
                    ? static_cast<uint64_t>(std::llround(std::max(0.0, value.data.num)))
                    : static_cast<uint64_t>(std::llround(value.data.num));
            const size_t size = elem_size_of(kind);
            for (size_t i = 0; i < size; ++i)
                at[i] = static_cast<uint8_t>(raw >> (8 * i));
            return;
        }
    }
}

Value scalar_elem(rant::FieldType kind, const uint8_t* at) {
    uint64_t raw = 0;
    const size_t size = elem_size_of(kind);
    for (size_t i = 0; i < size; ++i) raw |= static_cast<uint64_t>(at[i]) << (8 * i);
    switch (kind) {
        case rant::FieldType::Bool: return Value::boolean(raw != 0);
        case rant::FieldType::I8: return Value::number(static_cast<int8_t>(raw));
        case rant::FieldType::I16: return Value::number(static_cast<int16_t>(raw));
        case rant::FieldType::I32: return Value::number(static_cast<int32_t>(raw));
        case rant::FieldType::I64:
            return Value::number(static_cast<double>(static_cast<int64_t>(raw)));
        case rant::FieldType::F32: {
            float value = 0;
            std::memcpy(&value, at, sizeof(value));
            return Value::number(value);
        }
        case rant::FieldType::F64: {
            double value = 0;
            std::memcpy(&value, at, sizeof(value));
            return Value::number(value);
        }
        default: return Value::number(static_cast<double>(raw));
    }
}

/* one decoded field by the SENDER's layout (the schema the payload arrived with) */
Value decode_field(dc::RantBytes data, const dc::RantSchema* schema, const char* path,
                   std::string& text_out) {
    const int index = dc::rant_schema_field_index(schema, path);
    if (index < 0) return Value::nil();
    dc::RantSchemaFieldInfo info;
    if (!dc::rant_schema_field_at(schema, static_cast<uint16_t>(index), &info))
        return Value::nil();
    switch (static_cast<rant::FieldType>(info.kind)) {
        case rant::FieldType::U8:
        case rant::FieldType::U16:
        case rant::FieldType::U32:
        case rant::FieldType::U64:
            return Value::number(static_cast<double>(dc::rant_get_uint(data, schema, path)));
        case rant::FieldType::I8:
        case rant::FieldType::I16:
        case rant::FieldType::I32:
        case rant::FieldType::I64:
            return Value::number(static_cast<double>(dc::rant_get_int(data, schema, path)));
        case rant::FieldType::F32:
            return Value::number(static_cast<double>(dc::rant_get_f32(data, schema, path)));
        case rant::FieldType::F64:
            return Value::number(dc::rant_get_f64(data, schema, path));
        case rant::FieldType::Bool:
            return Value::boolean(dc::rant_get_uint(data, schema, path) != 0);
        case rant::FieldType::Enum:
            return Value::enumeration(dc::rant_get_int(data, schema, path), 0);
        case rant::FieldType::String:
        case rant::FieldType::VString: {
            const dc::RantString s = dc::rant_get_string(data, schema, path);
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

    /* the provider's schemas, owned copies off the reflection (nullopt = untyped) */
    std::optional<rant::Schema> compiled;       /* value / payload / request */
    std::optional<rant::Schema> rsp_compiled;   /* FUNCTION / TASK: response */
    std::optional<rant::Schema> prg_compiled;   /* TASK: progress */
    /* the entity's mesh generation the handles were created at (0 = none yet): it moves
     * with the provider's identity, any schema, or an attr, and refresh() retires the
     * handles when it does */
    uint64_t generation = 0;

    /* the field vocabulary as the compiler sees it, plus per-field encode info.
     * `rsp_raw` / `prg_raw` are the DECODE tables (the schemas' own unprefixed
     * paths); a task's presented read table prefixes them, so deliveries land at a
     * lead offset instead. */
    std::vector<FieldDef> fields;
    std::vector<FieldDef> rsp_raw;
    std::vector<FieldDef> prg_raw;
    std::vector<EncField> enc;

    /* handles, created on first need, cached until the entity re-types (refresh
     * retires them and the next apply() recreates them with the new schema) */
    std::optional<rant::Topic> topic;           /* Topic entity: sub + (role-flipped) pub */
    bool topic_pub = false;
    std::optional<rant::RemoteVariable<>> var;
    std::optional<rant::RemoteTask<>> task;
    std::optional<rant::RemoteFunction<>> fn;

    /* the owner-match story for writes through the variable accessor: var_created
     * bounds how long a FORMING match is worth waiting on; owner_seen flips the first
     * time the owner provably exists (an update arrives, or a write lands), after
     * which a no-owner send status means the node LEFT and failing fast is honest */
    Clock::time_point var_created{};
    std::atomic<bool> owner_seen{false};

    /* latest-wins slot: variable updates and function/task responses (service thread
     * in, logic thread out) */
    std::mutex slot_mu;
    std::vector<uint8_t> slot;
    const dc::RantSchema* slot_schema = nullptr;
    bool slot_dirty = false;

    /* TASK call state, behind the same mutex: ONE outstanding call per task from this
     * HMI (the backend is the one caller for every session), its latest progress
     * payload latest-wins, and the running/message pair the read table leads with */
    uint32_t call_id = 0;
    bool call_live = false;
    bool task_running = false;
    std::string task_message;
    bool task_flags_dirty = false;
    std::vector<uint8_t> prg_slot;
    const dc::RantSchema* prg_slot_schema = nullptr;
    bool prg_dirty = false;

    /* RMW base: the owner's exact last payload bytes (logic thread only) */
    std::vector<uint8_t> last_payload;
    uint64_t last_payload_hash = 0;
    const dc::RantSchema* last_schema = nullptr;   /* interned in the node, safe to keep */

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
    /* whole-array packing scratch: elements' wire bytes before rant_set_array */
    std::vector<uint8_t> pack;
};

struct RantMesh::Impl {
    RantMeshOptions opts;

    /* recs before node: the node tears down first (joining its service thread), after
     * which no handler can touch a rec. Handles are non-owning, safe to outlive. */
    std::map<std::string, std::unique_ptr<Rec>> recs;
    std::optional<rant::Node> node;

    std::atomic<bool> dirty{true};
    std::vector<EntityDef> entities;
    std::string signature;
    /* the mesh's entities from the last refresh, keyed like recs */
    std::map<std::string, rant::Entity> folded;

    std::vector<uint64_t> viewed_pages;

    /* the mesh-wide @rant/log stream: on_log callbacks (polling thread) append here,
     * take_logs (logic thread) empties it; bounded drop-oldest so a deaf consumer can
     * never grow it */
    std::mutex log_mu;
    std::deque<MeshLogLine> log_pending;

    Rec* ensure_rec(const EntityDef& def);
    void fill_rec_schema(Rec& rec, const rant::Entity& folded_entity) const;
    bool ensure_consumption(Rec& rec, std::string& err);
    void retire_rec_patterns(Rec& rec);
    bool encode(Rec& rec, const EffectView& effect, std::string& fault);
    /* decode one payload against `fields` and hand it to the sink, the decoded values
     * landing at positions [lead, lead + fields.size()) of the update — the leading
     * positions ride Nil, which on_update skips. A task's presented read table is
     * [running, message, progress.*, result.*], so its progress payload delivers at
     * lead 2 and its response past the progress block. */
    void deliver(MeshSink& sink, Rec& rec, const std::vector<FieldDef>& fields,
                 dc::RantBytes data, const dc::RantSchema* schema, uint32_t lead = 0);
    void deliver_task_flags(MeshSink& sink, Rec& rec, bool running,
                            const std::string& message);
    bool page_viewed(const Rec& rec) const;
    void log(const char* what, const std::string& detail) const {
        if (opts.verbose) std::printf("hmi mesh: %s %s\n", what, detail.c_str());
    }
};

RantMesh::RantMesh(RantMeshOptions opts) : impl_(new Impl()) { impl_->opts = std::move(opts); }
RantMesh::~RantMesh() = default;

bool RantMesh::start(std::string& err) {
    rant::NodeOptions options;
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
            impl_->opts.node_name, rant::Node::MessageHandler{},
            [impl](const rant::Event& event) {
                switch (event.kind()) {
                    case rant::EventKind::PeerUp:
                    case rant::EventKind::PeerDown:
                    case rant::EventKind::PeerInterest:
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
        err = rant::Node::last_open_error();
        return false;
    }
    /* The mesh-wide log stream, one subscription per level, registered BEFORE the
     * service thread starts (on_log widens the node's own log handle, which is setup
     * work). A widened @rant/log topic is a CONSUMER-QUEUE topic — lines queue inside
     * RANT and nobody fires the handler until someone dispatches that queue — so
     * take_logs pumps the three queues on the logic thread; the handler then runs
     * there, copying the line into the pending ring and nothing else. */
    for (const rant::LogLevel level :
         {rant::LogLevel::Error, rant::LogLevel::Warn, rant::LogLevel::Info}) {
        impl_->node->on_log(level, [impl, level](const rant::LogLine& line) {
            MeshLogLine copy;
            copy.level = static_cast<int>(level);
            copy.node = std::string(line.node);
            copy.text = std::string(line.text);
            copy.wall_us = line.wall_us;
            std::lock_guard<std::mutex> hold(impl->log_mu);
            if (impl->log_pending.size() >= kLogPendCap) impl->log_pending.pop_front();
            impl->log_pending.push_back(std::move(copy));
        });
    }
    if (!impl_->node->start()) {
        err = "mesh service thread failed to start";
        return false;
    }
    return true;
}

void RantMesh::take_logs(std::vector<MeshLogLine>& out) {
    /* drain exactly the three log queues — never rant_node_dispatch, which would pull
     * the ENTITY topics' queued messages through the (empty) node handler and eat them
     * out from under drain()'s take path */
    if (impl_->node && impl_->node->valid())
        for (const rant::LogLevel level :
             {rant::LogLevel::Error, rant::LogLevel::Warn, rant::LogLevel::Info}) {
            rant::Topic channel = impl_->node->log_topic(level);
            if (channel.valid()) channel.dispatch(/*max_msgs=*/64, /*timeout_ms=*/0);
        }
    std::lock_guard<std::mutex> hold(impl_->log_mu);
    for (MeshLogLine& line : impl_->log_pending) out.push_back(std::move(line));
    impl_->log_pending.clear();
}

const std::vector<EntityDef>& RantMesh::reflection() const noexcept { return impl_->entities; }

void RantMesh::set_viewed_pages(const std::vector<uint64_t>& pages) {
    impl_->viewed_pages = pages;
}

/* ============================ reflection ==================================== */

bool RantMesh::refresh() {
    if (!impl_->node || !impl_->node->valid()) return false;
    impl_->dirty.store(false, std::memory_order_relaxed);

    /* the mesh as the node folds it: one entity per (kind, name) across every LIVE peer
     * (a dropped peer never counts: down means down), the provider's schemas, and a
     * GENERATION that moves with the provider's identity, any schema, or an attr. An entity
     * nobody provides and ONLY THIS NODE consumes is our own leftover handle, not the mesh.
     * Only this node: the count is what says so, not the schema's origin. Our Topic handle
     * is a subscriber first (ensure_consumption creates it SubOnly; the first publish
     * widens it) and the node folds our own records before the peers', so a topic a peer
     * only consumes and we only write reads as "from us, nobody provides" the moment we
     * hold it — with the peer's subscriber counted beside ours. Dropping it there hid the
     * robot's jog command from every recompile of exactly the document that wrote it. */
    std::map<std::string, rant::Entity> fold;
    for (rant::Entity& entity : impl_->node->mesh()) {
        if (entity.name.empty() || entity.name.compare(0, 2, "0x") == 0)
            continue;   /* details not fetched yet; the next refresh sees them */
        if (!entity.providers && entity.from == impl_->opts.node_name &&
            entity.consumers <= 1)
            continue;
        fold.emplace(rec_key(kind_of(entity.kind), entity.name), std::move(entity));
    }

    std::vector<EntityDef> next;
    std::string signature;
    for (const auto& item : fold) {
        const rant::Entity& entity = item.second;
        EntityDef def;
        def.kind = kind_of(entity.kind);
        def.name = entity.name;
        def.readable = true;
        def.writable = def.kind == EntityKind::Variable ? entity.writable : true;
        def.forceable = def.kind == EntityKind::Variable && entity.forceable;
        /* the schema's root type name is the only name a type has (spec 2.2); the hash
         * is its identity, so two entities of one type fold to one type-table entry */
        def.type_name = std::string(entity.schema.name());
        def.schema_hash = entity.schema.hash();
        build_fields(entity.schema, def.fields, nullptr);
        if (def.kind == EntityKind::Function)
            build_fields(entity.rsp_schema, def.rsp_fields, nullptr);
        if (def.kind == EntityKind::Task) {
            def.cancellable = entity.cancellable;
            build_task_read_fields(entity, def.rsp_fields);
        }
        signature += item.first;
        signature += def.writable ? "+w" : "";
        signature += def.forceable ? "+f" : "";
        signature += def.cancellable ? "+c" : "";
        signature += entity.reliable ? "+r" : "";
        signature += ":" + std::to_string(entity.generation);
        signature += ";";
        next.push_back(std::move(def));
    }
    if (signature == impl_->signature) return false;

    /* an entity whose GENERATION moved (a provider restarted, re-typed, or appeared):
     * retire the rec's handles and codec now, so the recompile this refresh triggers
     * re-subscribes with the current type (ensure_rec refills from `folded`,
     * ensure_consumption recreates the handles; Topic::retire releases the name). The
     * Rec object itself stays: service-thread handler captures remain valid, and the
     * old handlers went with their channels. */
    for (const auto& item : fold) {
        auto it = impl_->recs.find(item.first);
        if (it == impl_->recs.end()) continue;
        Rec& rec = *it->second;
        if (rec.generation == 0 || rec.generation == item.second.generation) continue;
        impl_->log("entity changed, re-subscribing with the current type", item.first);
        if (rec.topic) rec.topic->retire();
        rec.topic.reset();
        rec.topic_pub = false;
        impl_->retire_rec_patterns(rec);
        rec.generation = 0;
        rec.compiled.reset();
        rec.rsp_compiled.reset();
        rec.prg_compiled.reset();
        rec.rsp_raw.clear();
        rec.prg_raw.clear();
        rec.enc.clear();
        rec.default_request.clear();
        rec.last_payload.clear();
        rec.last_payload_hash = 0;
        rec.last_schema = nullptr;
        {
            std::lock_guard<std::mutex> hold(rec.slot_mu);
            rec.slot.clear();
            rec.slot_schema = nullptr;
            rec.slot_dirty = false;
            rec.prg_slot.clear();
            rec.prg_slot_schema = nullptr;
            rec.prg_dirty = false;
        }
    }
    impl_->signature = std::move(signature);
    impl_->entities = std::move(next);
    impl_->folded = std::move(fold);
    return true;
}

/* ====================== records and consumption ============================= */

Rec* RantMesh::Impl::ensure_rec(const EntityDef& def) {
    const std::string key = rec_key(def.kind, def.name);
    auto folded_it = folded.find(key);
    auto it = recs.find(key);
    if (it != recs.end()) {
        Rec& rec = *it->second;
        /* the compiler's field tables are the current truth; keep ours aligned */
        rec.fields = def.fields;
        if (rec.generation == 0 && folded_it != folded.end())
            fill_rec_schema(rec, folded_it->second);
        return &rec;
    }
    auto rec = std::make_unique<Rec>();
    rec->kind = def.kind;
    rec->name = def.name;
    rec->fields = def.fields;
    if (folded_it != folded.end()) fill_rec_schema(*rec, folded_it->second);
    Rec* out = rec.get();
    recs.emplace(key, std::move(rec));
    return out;
}

/* Take a record's schemas + encode table from the latest reflection. Runs at creation
 * and again after refresh() retired a changed entity's handles (the next apply() lands
 * here with the current type). */
void RantMesh::Impl::fill_rec_schema(Rec& rec, const rant::Entity& entity) const {
    rec.generation = entity.generation;
    rec.compiled.reset();
    rec.rsp_compiled.reset();
    rec.prg_compiled.reset();
    if (!entity.schema.empty()) rec.compiled = entity.schema;
    if (!entity.rsp_schema.empty()) {
        rec.rsp_compiled = entity.rsp_schema;
        rec.rsp_raw.clear();
        build_fields(entity.rsp_schema, rec.rsp_raw, nullptr);
    }
    if (!entity.progress_schema.empty()) {
        rec.prg_compiled = entity.progress_schema;
        rec.prg_raw.clear();
        build_fields(entity.progress_schema, rec.prg_raw, nullptr);
    }
    if (rec.compiled) {
        rec.enc.clear();
        std::vector<FieldDef> unused;
        build_fields(*rec.compiled, unused, &rec.enc);
        /* the default request a function poll sends */
        if (rec.kind == EntityKind::Function) {
            rec.default_request.resize(dc::rant_schema_msg_min(rec.compiled->raw()));
            dc::rant_schema_message_default(rec.compiled->raw(), rec.default_request.data(),
                                            rec.default_request.size());
        }
    }
}

/* Park + drop the PATTERN handles (variable / task / function). Their standing
 * lanes go DEAF across a provider incarnation change — a fresh accessor provably
 * receives where the standing one does not — and a live old-typed channel would
 * shadow a same-name successor on every peer, refusing each match with
 * schema-mismatch. retire() parks the underlying
 * channels Inactive so the successor owns the name outright. A task retire answers
 * its outstanding call Cancelled through the ordinary response callback, so the
 * read table's `running` goes false honestly. The plain TOPIC
 * handle STAYS: topic subscriptions rematch a returning provider by themselves,
 * and the C++ topic cache would hand a parked channel straight back on a
 * same-schema re-create. */
void RantMesh::Impl::retire_rec_patterns(Rec& rec) {
    if (rec.var) rec.var->retire();
    rec.var.reset();
    rec.owner_seen.store(false, std::memory_order_relaxed);
    if (rec.task) rec.task->retire();
    rec.task.reset();
    if (rec.fn) rec.fn->retire();
    rec.fn.reset();
}

bool RantMesh::Impl::ensure_consumption(Rec& rec, std::string& err) {
    const rant::Schema* schema = rec.compiled ? &*rec.compiled : nullptr;
#if defined(__cpp_exceptions)
    try {
#endif
        switch (rec.kind) {
            case EntityKind::Topic: {
                if (rec.topic) break;
                rant::Qos qos;
                /* request what the provider offers, so the match can never be refused
                 * by the RxO rule; a reliable provider then repairs into our queue */
                auto it = folded.find(rec_key(rec.kind, rec.name));
                qos.reliability = it != folded.end() && it->second.reliable
                                      ? rant::Reliability::Reliable
                                      : rant::Reliability::BestEffort;
                rec.topic.emplace(*node, rec.name, rant::Role::SubOnly, schema, qos);
                rec.topic->take(0);   /* switch to QUEUED delivery from the start */
                break;
            }
            case EntityKind::Variable: {
                if (rec.var) break;
                rant::VariableOptions<> options;
                options.backpressure_wait_us = kEffectWaitUs;
                rec.var.emplace(*node, rec.name, schema, options);
                rec.var_created = Clock::now();
                Rec* self = &rec;
                rec.var->on_change([self](const rant::VariableUpdate& update) {
                    /* an update can only come from the owner: the match has formed */
                    self->owner_seen.store(true, std::memory_order_relaxed);
                    const rant::Bytes value = update.value();
                    std::lock_guard<std::mutex> hold(self->slot_mu);
                    self->slot.assign(value.begin(), value.end());
                    self->slot_schema = update.raw_schema();
                    self->slot_dirty = true;
                });
                break;
            }
            case EntityKind::Task: {
                if (rec.task) break;
                rant::TaskOptions options;
                options.backpressure_wait_us = kEffectWaitUs;
                rec.task.emplace(*node, rec.name, schema,
                                 rec.prg_compiled ? &*rec.prg_compiled : nullptr,
                                 rec.rsp_compiled ? &*rec.rsp_compiled : nullptr, options);
                break;
            }
            case EntityKind::Function: {
                if (rec.fn) break;
                rant::FunctionOptions options;
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

void RantMesh::apply(const Program& program,
                     const std::set<std::string>& display_reads) {
    if (!impl_->node || !impl_->node->valid()) return;
    for (auto& item : impl_->recs) {
        item.second->poll_ms = 0;
        item.second->pages.clear();
    }
    /* consume one entity, returning its rec. A recompile starts from a fresh
     * Host: re-deliver the variable state we already hold, so its cells and
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
            /* NEVER CLOBBER AN UNDRAINED ARRIVAL. A fresh value can land in the slot
             * a moment before this apply (a provider's restart replay racing the
             * recompile its return triggers): re-seeding over it would stand the
             * STALE mirror value forever, because on_change is edge-triggered and
             * the owner will not say an unchanged value twice. */
            if (!rec->slot_dirty) {
                rec->slot = rec->last_payload;
                rec->slot_schema = rec->last_schema;
                rec->slot_dirty = true;
            }
        }
        return rec;
    };
    /* a FUNCTION a slot expression reads is POLLED: the instance's `poll` map set the
     * cadence at compile, page-gated by the instance's page (the visibility rule) */
    for (const SlotProgram& slot : program.slot_programs) {
        if (!slot.poll_ms) continue;
        for (uint32_t dep : slot.body.sig.reads) {
            if (dep >= program.entities.size()) continue;
            const EntityDef& def = program.entities[dep];
            if (def.kind != EntityKind::Function) continue;
            Rec* rec = consume(def);
            if (!rec) continue;
            rec->poll_ms = rec->poll_ms ? std::min(rec->poll_ms, slot.poll_ms)
                                        : slot.poll_ms;
            if (std::find(rec->pages.begin(), rec->pages.end(), slot.page_id) ==
                rec->pages.end())
                rec->pages.push_back(slot.page_id);
        }
    }
    /* an entity ANY program reads — a flow's `read <entity>`, a single-field source,
     * a slot expression's `@entity` — needs a live subscription: without one its
     * last-value mirror never fills and every read yields Nil, so a gate over it can
     * never pass. An entity a flow only WRITES needs its accessor standing just as
     * early: one created at the moment of the first effect has no owner matched yet,
     * and that first write would fail. All of it is a QUERY over the procedure
     * signatures — nothing is stamped per entity; the DISPLAY tier's reads arrive
     * by name beside the program. */
    std::vector<uint8_t> engaged(program.entities.size(), 0);
    auto mark = [&](const std::vector<uint32_t>& list) {
        for (uint32_t e : list)
            if (e < engaged.size()) engaged[e] = 1;
    };
    for (const FlowProgram& flow : program.flows) {
        mark(flow.body.sig.reads);
        mark(flow.body.sig.writes);
    }
    for (const SlotProgram& slot : program.slot_programs) {
        mark(slot.body.sig.reads);
        mark(slot.body.sig.writes);
    }
    for (uint32_t e = 0; e < program.entities.size(); ++e)
        if (engaged[e] || display_reads.count(program.entities[e].name))
            consume(program.entities[e]);
}

/* ============================== drain ======================================= */

bool RantMesh::Impl::page_viewed(const Rec& rec) const {
    if (rec.pages.empty()) return true;
    for (uint64_t page : rec.pages) {
        if (page == 0) return true;
        if (std::find(viewed_pages.begin(), viewed_pages.end(), page) != viewed_pages.end())
            return true;
    }
    return false;
}

void RantMesh::Impl::deliver(MeshSink& sink, Rec& rec, const std::vector<FieldDef>& fields,
                             dc::RantBytes data, const dc::RantSchema* schema,
                             uint32_t lead) {
    if (!schema || fields.empty()) return;
    const uint32_t total = lead + static_cast<uint32_t>(fields.size());
    rec.values.assign(total, Value::nil());
    rec.texts.resize(total);
    rec.views.assign(total, std::string_view{});
    rec.elem_pool.clear();
    rec.elem_strings.clear();
    rec.elem_meta.clear();

    auto map_scalar = [&](const dc::RantValue& entry) -> Value {
        switch (static_cast<rant::FieldType>(entry.kind)) {
            case rant::FieldType::U8:
            case rant::FieldType::U16:
            case rant::FieldType::U32:
            case rant::FieldType::U64:
                return Value::number(static_cast<double>(entry.v.u));
            case rant::FieldType::I8:
            case rant::FieldType::I16:
            case rant::FieldType::I32:
            case rant::FieldType::I64:
                return Value::number(static_cast<double>(entry.v.i));
            case rant::FieldType::F32:
            case rant::FieldType::F64:
                return Value::number(entry.v.f);
            case rant::FieldType::Bool:
                return Value::boolean(entry.v.u != 0);
            case rant::FieldType::VString: {
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
        const int index = dc::rant_schema_field_index(schema, def.path.c_str());
        if (index < 0) return Value::nil();
        dc::RantValue raw;
        if (!dc::rant_get_value(data, schema, static_cast<uint16_t>(index), &raw))
            return Value::nil();
        const uint32_t offset = static_cast<uint32_t>(rec.elem_pool.size());
        const rant::FieldType kind = static_cast<rant::FieldType>(raw.kind);
        const uint32_t limit = def.bound ? def.bound : kVarrCeiling;
        if (kind == rant::FieldType::Map) {
            const dc::RantBytes body = raw.bytes;
            uint32_t pairs = std::min<uint32_t>(dc::rant_map_count(body), limit);
            uint32_t kept = 0;
            for (uint32_t e = 0; e < pairs; ++e) {
                dc::RantString key{};
                dc::RantValue entry{};
                if (!dc::rant_map_at(body, static_cast<uint16_t>(e), &key, &entry)) break;
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
        if (kind != rant::FieldType::Array && kind != rant::FieldType::VArray)
            return Value::nil();
        const rant::FieldType elem = static_cast<rant::FieldType>(raw.elem);
        if (elem == rant::FieldType::String) {
            uint32_t count = 0;
            while (count < limit) {
                const dc::RantString s = dc::rant_get_string_at(
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
                           elem == rant::FieldType::Bool ? ValueTag::Bool : ValueTag::Num);
    };

    for (size_t i = 0; i < fields.size(); ++i) {
        const size_t at = lead + i;
        if (fields[i].shape == Shape::List || fields[i].shape == Shape::Map) {
            rec.values[at] = decode_agg(fields[i], static_cast<uint32_t>(at));
            continue;
        }
        rec.values[at] = decode_field(data, schema, fields[i].path.c_str(), rec.texts[at]);
        if (rec.values[at].tag == ValueTag::Text) rec.views[at] = rec.texts[at];
    }

    /* element vectors are stable now: build the views and per-field spans */
    rec.elem_views.assign(rec.elem_pool.size(), std::string_view{});
    for (size_t k = 0; k < rec.elem_pool.size(); ++k)
        if (rec.elem_pool[k].tag == ValueTag::Text &&
            rec.elem_pool[k].ref < rec.elem_strings.size())
            rec.elem_views[k] = rec.elem_strings[rec.elem_pool[k].ref];
    bool any_elems = false;
    rec.elem_spans.assign(total, MeshElems{});
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
    update.field_count = total;
    sink.on_update(update);
}

/* the task read table's two leading facts, delivered as a two-field update: position
 * 0 = running, 1 = message (on_update touches only the positions an update carries) */
void RantMesh::Impl::deliver_task_flags(MeshSink& sink, Rec& rec, bool running,
                                        const std::string& message) {
    const Value fields[kTaskLeadFields] = {Value::boolean(running), Value::text(0)};
    const std::string_view texts[kTaskLeadFields] = {std::string_view{}, message};
    MeshUpdate update;
    update.kind = rec.kind;
    update.name = rec.name;
    update.fields = fields;
    update.texts = texts;
    update.field_count = kTaskLeadFields;
    sink.on_update(update);
}

void RantMesh::drain(MeshSink& sink) {
    Impl& impl = *impl_;
    if (!impl.node || !impl.node->valid()) return;
    const Clock::time_point now = Clock::now();
    for (auto& item : impl.recs) {
        Rec& rec = *item.second;

        if (rec.topic) {
            for (int budget = 0; budget < kTakeBudget; ++budget) {
                std::optional<rant::Message<>> msg = rec.topic->take(0);
                if (!msg) break;
                const rant::Bytes data = msg->data();
                if (msg->raw_schema()) {
                    rec.last_payload.assign(data.begin(), data.end());
                    rec.last_payload_hash = dc::rant_schema_hash(msg->raw_schema());
                    rec.last_schema = msg->raw_schema();
                }
                impl.deliver(sink, rec, rec.fields,
                             dc::rant_bytes(data.data(), data.size()), msg->raw_schema());
            }
        }

        bool slot_dirty = false;
        const dc::RantSchema* schema = nullptr;
        bool flags_dirty = false;
        bool running = false;
        std::string message;
        bool prg_dirty = false;
        std::vector<uint8_t> prg_payload;
        const dc::RantSchema* prg_schema = nullptr;
        {
            std::lock_guard<std::mutex> hold(rec.slot_mu);
            slot_dirty = rec.slot_dirty;
            if (slot_dirty) {
                rec.out.assign(rec.slot.begin(), rec.slot.end());
                schema = rec.slot_schema;
                rec.slot_dirty = false;
            }
            flags_dirty = rec.task_flags_dirty;
            if (flags_dirty) {
                running = rec.task_running;
                message = rec.task_message;
                rec.task_flags_dirty = false;
            }
            prg_dirty = rec.prg_dirty;
            if (prg_dirty) {
                prg_payload = rec.prg_slot;
                prg_schema = rec.prg_slot_schema;
                rec.prg_dirty = false;
            }
        }
        /* the task read table's [running, message, progress.*, result.*] delivers
         * piecewise: whichever parts moved land at their own positions this tick */
        if (flags_dirty) impl.deliver_task_flags(sink, rec, running, message);
        if (prg_dirty)
            impl.deliver(sink, rec, rec.prg_raw,
                         dc::rant_bytes(prg_payload.data(), prg_payload.size()),
                         prg_schema, kTaskLeadFields);
        if (slot_dirty) {
            if (rec.kind == EntityKind::Variable && schema) {
                rec.last_payload = rec.out;
                rec.last_payload_hash = dc::rant_schema_hash(schema);
                rec.last_schema = schema;
            }
            const bool response =
                rec.kind == EntityKind::Function || rec.kind == EntityKind::Task;
            impl.deliver(sink, rec, response ? rec.rsp_raw : rec.fields,
                         dc::rant_bytes(rec.out.data(), rec.out.size()), schema,
                         rec.kind == EntityKind::Task
                             ? kTaskLeadFields + static_cast<uint32_t>(rec.prg_raw.size())
                             : 0);
        }

        if (rec.fn && rec.poll_ms && impl.page_viewed(rec) && now >= rec.next_poll &&
            !rec.inflight.load(std::memory_order_relaxed)) {
            rec.next_poll = now + std::chrono::milliseconds(rec.poll_ms);
            rec.inflight.store(true, std::memory_order_relaxed);
            Rec* self = &rec;
            const rant::SendStatus status = rec.fn->call_async(
                rant::Bytes(rec.default_request.data(), rec.default_request.size()),
                [self](const rant::ResponseView<>& response) {
                    if (response.ok() && response.raw_schema()) {
                        const rant::Bytes data = response.data();
                        std::lock_guard<std::mutex> hold(self->slot_mu);
                        self->slot.assign(data.begin(), data.end());
                        self->slot_schema = response.raw_schema();
                        self->slot_dirty = true;
                    }
                    self->inflight.store(false, std::memory_order_relaxed);
                });
            if (status != rant::SendStatus::Ok)
                rec.inflight.store(false, std::memory_order_relaxed);
        }
    }
}

/* ============================== effects ===================================== */

bool RantMesh::Impl::encode(Rec& rec, const EffectView& effect, std::string& fault) {
    /* a PARAMETERLESS send (bare, field UINT32_MAX: a no-argument call or a
       payload-less emit) has nothing to encode: an untyped target gets an empty
       payload, a typed one its schema's default message */
    const bool empty_send = effect.bare && effect.field == UINT32_MAX;
    if (!rec.compiled) {
        if (empty_send) {
            rec.out.clear();
            return true;
        }
        fault = "entity '" + rec.name + "' has no reflected schema to encode with";
        return false;
    }
    const dc::RantSchema* schema = rec.compiled->raw();
    const size_t base_size = dc::rant_schema_msg_min(schema);

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
        dc::rant_schema_message_default(schema, rec.out.data(), rec.out.size());
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
                dc::rant_schema_msg_len(schema, rec.out.data(), rec.out.size());
            if (rec.out.size() < used + extra) rec.out.resize(used + extra);
        };
        int ok = 0;
        switch (enc.kind) {
            case rant::FieldType::U8:
            case rant::FieldType::U16:
            case rant::FieldType::U32:
            case rant::FieldType::U64:
                ok = dc::rant_set_uint(rec.out.data(), rec.out.size(), schema, path,
                                       value.tag == ValueTag::Bool
                                           ? (value.data.boolean ? 1u : 0u)
                                           : static_cast<uint64_t>(std::llround(
                                                 std::max(0.0, value.data.num))));
                break;
            case rant::FieldType::I8:
            case rant::FieldType::I16:
            case rant::FieldType::I32:
            case rant::FieldType::I64:
                ok = dc::rant_set_int(rec.out.data(), rec.out.size(), schema, path,
                                      static_cast<int64_t>(std::llround(value.data.num)));
                break;
            case rant::FieldType::F32:
                ok = dc::rant_set_f32(rec.out.data(), rec.out.size(), schema, path,
                                      static_cast<float>(value.data.num));
                break;
            case rant::FieldType::F64:
                ok = dc::rant_set_f64(rec.out.data(), rec.out.size(), schema, path,
                                      value.data.num);
                break;
            case rant::FieldType::Bool:
                ok = dc::rant_set_uint(rec.out.data(), rec.out.size(), schema, path,
                                       value_truth(value) ? 1u : 0u);
                break;
            case rant::FieldType::Enum:
                ok = dc::rant_set_int(rec.out.data(), rec.out.size(), schema, path,
                                      value.tag == ValueTag::Enum
                                          ? value.data.integer
                                          : static_cast<int64_t>(std::llround(value.data.num)));
                break;
            case rant::FieldType::String:
            case rant::FieldType::VString:
                grow_for(text.size() + 8);
                ok = dc::rant_set_string(rec.out.data(), rec.out.size(), schema, path,
                                         dc::rant_string(text.data(), text.size()));
                break;
            case rant::FieldType::Array:
            case rant::FieldType::VArray: {
                /* THE WHOLE ARRAY (no index): when this effect carries elements for
                   the field and the field was actually GIVEN, they pack and land via
                   rant_set_array — a fixed array takes at most its schema's count
                   (the rest zeroes), a variable one becomes exactly the list.
                   Ungiven, the RMW base keeps the owner's bytes untouched.
                   ONE ELEMENT (an index) rewrites in place over that base, so the
                   rest of the owner's array rides through exactly as delivered; the
                   bounds are the owner's, and an element write never grows. */
                if (effect.elem_index == UINT32_MAX) {
                    const bool given =
                        effect.bare || (effect.fields && index < effect.field_count &&
                                        effect.fields[index].tag != ValueTag::Nil);
                    const MeshElems* span =
                        effect.elems && index < effect.field_count
                            ? &effect.elems[index]
                            : nullptr;
                    if (!given || !span || !span->data) return true;
                    const uint32_t entries = span->count;
                    if (enc.elem == rant::FieldType::String) {
                        const size_t slot = 2u + enc.str_cap;
                        rec.pack.assign(static_cast<size_t>(entries) * slot, 0);
                        for (uint32_t k = 0; k < entries; ++k) {
                            if (span->data[k].tag == ValueTag::Nil) {
                                fault = "field '" + enc.path +
                                        "' has an UNKNOWN element at " +
                                        std::to_string(k) +
                                        "; a send of UNKNOWN is refused";
                                return false;
                            }
                            const std::string_view at =
                                span->texts ? span->texts[k] : std::string_view{};
                            const size_t len =
                                std::min(at.size(), static_cast<size_t>(enc.str_cap));
                            rec.pack[k * slot] = static_cast<uint8_t>(len & 0xff);
                            rec.pack[k * slot + 1] =
                                static_cast<uint8_t>((len >> 8) & 0xff);
                            if (len)
                                std::memcpy(rec.pack.data() + k * slot + 2, at.data(),
                                            len);
                        }
                    } else {
                        const size_t size = elem_size_of(enc.elem);
                        rec.pack.assign(static_cast<size_t>(entries) * size, 0);
                        for (uint32_t k = 0; k < entries; ++k) {
                            const Value& element = span->data[k];
                            if (element.tag == ValueTag::Nil) {
                                fault = "field '" + enc.path +
                                        "' has an UNKNOWN element at " +
                                        std::to_string(k) +
                                        "; a send of UNKNOWN is refused";
                                return false;
                            }
                            if (enc.elem != rant::FieldType::Bool &&
                                element.tag != ValueTag::Num) {
                                fault = "field '" + enc.path +
                                        "' holds numbers; element " +
                                        std::to_string(k) + " is not one";
                                return false;
                            }
                            pack_scalar_elem(enc.elem, element,
                                             rec.pack.data() + k * size);
                        }
                    }
                    grow_for(rec.pack.size() + 16);
                    if (!dc::rant_set_array(
                            rec.out.data(), rec.out.size(), schema, path,
                            dc::rant_bytes(rec.pack.data(), rec.pack.size()))) {
                        fault = "field '" + enc.path + "' did not take " +
                                std::to_string(entries) +
                                " elements (a fixed array holds its schema's count)";
                        return false;
                    }
                    return true;
                }
                if (enc.elem == rant::FieldType::String) {
                    if (!dc::rant_set_string_at(
                            rec.out.data(), rec.out.size(), schema, path,
                            static_cast<uint16_t>(effect.elem_index),
                            dc::rant_string(text.data(), text.size()))) {
                        fault = "field '" + enc.path + "' has no element " +
                                std::to_string(effect.elem_index) + " to write";
                        return false;
                    }
                    return true;
                }
                if (enc.elem != rant::FieldType::Bool && value.tag != ValueTag::Num) {
                    fault = "field '" + enc.path + "' holds numbers; the element is not one";
                    return false;
                }
                const dc::RantBytes view = dc::rant_get_array(
                    dc::rant_bytes(rec.out.data(), rec.out.size()), schema, path);
                const size_t size = elem_size_of(enc.elem);
                const uint32_t count =
                    view.data && size ? static_cast<uint32_t>(view.len / size) : 0;
                if (effect.elem_index >= count) {
                    fault = "field '" + enc.path + "' holds " + std::to_string(count) +
                            " elements; index " + std::to_string(effect.elem_index) +
                            " is past it (an element write never grows the owner's array)";
                    return false;
                }
                uint8_t* at = rec.out.data() + (view.data - rec.out.data()) +
                              static_cast<size_t>(effect.elem_index) * size;
                pack_scalar_elem(enc.elem, value, at);
                return true;
            }
            case rant::FieldType::Map: {
                /* the HMI has no map encode. A map field the author actually GAVE
                   refuses loudly — a value dropped without a trace is the one
                   unforgivable outcome; ungiven, the RMW base keeps the owner's
                   bytes untouched as ever. */
                const bool given =
                    !effect.bare && effect.fields && index < effect.field_count &&
                    effect.fields[index].tag != ValueTag::Nil && effect.elems &&
                    effect.elems[index].data;
                if (given) {
                    fault = "field '" + enc.path +
                            "' is a map, which the HMI cannot encode";
                    return false;
                }
                return true;
            }
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
        /* field UINT32_MAX = a parameterless send: the base (default) message as-is */
        if (effect.field != UINT32_MAX &&
            !set_one(effect.field, effect.value, effect.bare_text))
            return false;
    } else {
        const uint32_t count =
            std::min<uint32_t>(effect.field_count, static_cast<uint32_t>(rec.enc.size()));
        for (uint32_t i = 0; i < count; ++i) {
            /* an UNGIVEN (Nil) field keeps the RMW base's own bytes: what the author
               never set must not zero the machine's value, and a mesh field is not
               erasable so there is nothing else Nil could honestly mean here */
            if (effect.fields[i].tag == ValueTag::Nil) continue;
            const std::string_view text =
                effect.field_text ? effect.field_text[i].view() : std::string_view{};
            if (!set_one(i, effect.fields[i], text)) return false;
        }
    }
    const size_t live = dc::rant_schema_msg_len(schema, rec.out.data(), rec.out.size());
    rec.out.resize(live ? live : base_size);
    return true;
}

/* what a failed send status MEANS, in the author's language; the raw number only
 * where no story is known */
static std::string send_status_story(rant::SendStatus status) {
    switch (status) {
        case rant::SendStatus::NoTopic:
            return "found no provider on the mesh (its node may be down)";
        case rant::SendStatus::BadRole:
            return "was refused: the provider is read-only";
        case rant::SendStatus::TooBig:
            return "exceeds the message size bound";
        case rant::SendStatus::OutOfMemory:
            return "failed: the mesh node is out of memory";
        default:
            return "failed (send status " +
                   std::to_string(static_cast<int>(status)) + ")";
    }
}

bool RantMesh::execute(const EffectView& effect, std::string& fault) noexcept {
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
        const rant::SendStatus status = rec->var->unforce();
        if (status != rant::SendStatus::Ok) {
            fault = "unforce of '" + rec->name + "' was refused";
            return false;
        }
        return true;
    }

    /* cancel means "ensure my call is not running": with nothing outstanding — never
     * started, or the terminal outcome just landed — it is already satisfied, so only
     * a genuine refusal is a fault (cancellation itself stays cooperative: the
     * terminal status is the answer). */
    if (effect.verb == Verb::Cancel) {
        if (!rec->task) {
            fault = "cancel target '" + rec->name + "' has no task";
            return false;
        }
        uint32_t call_id = 0;
        {
            std::lock_guard<std::mutex> hold(rec->slot_mu);
            if (!rec->call_live) return true;
            call_id = rec->call_id;
        }
        const rant::SendStatus status = rec->task->cancel(call_id);
        if (status == rant::SendStatus::BadRole) {
            fault = "task '" + rec->name + "' declares no cancel";
            return false;
        }
        if (status != rant::SendStatus::Ok && status != rant::SendStatus::State) {
            fault = "cancel of '" + rec->name + "' " + send_status_story(status);
            return false;
        }
        return true;
    }

    if (!impl.encode(*rec, effect, fault)) return false;
    const rant::Bytes payload(rec->out.data(), rec->out.size());

    rant::SendStatus status = rant::SendStatus::Ok;
    switch (effect.verb) {
        case Verb::Write:
            status = rec->var ? rec->var->set(payload) : rant::SendStatus::NoTopic;
            break;
        case Verb::Force:
            status = rec->var ? rec->var->force(payload) : rant::SendStatus::NoTopic;
            break;
        case Verb::Publish: {
            if (!rec->topic) {
                fault = "publish target '" + rec->name + "' has no topic";
                return false;
            }
            if (!rec->topic_pub) {
                /* consumption created the topic SubOnly; the first publish widens it */
                rec->topic->set_role(rant::Role::PubSub);
                rec->topic_pub = true;
            }
            status = rec->topic->send(payload);
            break;
        }
        case Verb::Call: {
            if (rec->kind == EntityKind::Task) {
                if (!rec->task) {
                    fault = "call target '" + rec->name + "' has no task";
                    return false;
                }
                /* claim the one outstanding call BEFORE sending: the terminal
                 * callback may fire the moment the request commits, and it must find
                 * call_live already true so its clear is never overwritten. A failed
                 * send registered no callbacks, so the rollback below cannot race. */
                {
                    std::lock_guard<std::mutex> hold(rec->slot_mu);
                    if (rec->call_live) {
                        fault = "task '" + rec->name +
                                "' is still running; cancel it or wait for it to finish";
                        return false;
                    }
                    rec->call_live = true;
                    rec->task_running = true;
                    rec->task_message.clear();
                    rec->task_flags_dirty = true;
                }
                Rec* self = rec;
                const rant::TaskCall call = rec->task->call_async(
                    payload,
                    [self](const rant::ProgressView<>& progress) {
                        /* the RUNNING ack arrives empty; either way the call provably
                         * runs. Progress is latest-wins: an HMI paints the newest. */
                        std::lock_guard<std::mutex> hold(self->slot_mu);
                        if (!self->task_running) {
                            self->task_running = true;
                            self->task_flags_dirty = true;
                        }
                        if (progress.has_value() && progress.raw_schema()) {
                            const rant::Bytes data = progress.data();
                            self->prg_slot.assign(data.begin(), data.end());
                            self->prg_slot_schema = progress.raw_schema();
                            self->prg_dirty = true;
                        }
                    },
                    [self](const rant::ResponseView<>& response) {
                        std::lock_guard<std::mutex> hold(self->slot_mu);
                        self->call_live = false;
                        self->task_running = false;
                        self->task_message.assign(response.message());
                        self->task_flags_dirty = true;
                        if (response.ok() && response.raw_schema()) {
                            const rant::Bytes data = response.data();
                            self->slot.assign(data.begin(), data.end());
                            self->slot_schema = response.raw_schema();
                            self->slot_dirty = true;
                        }
                    });
                status = call.status;
                {
                    std::lock_guard<std::mutex> hold(rec->slot_mu);
                    if (status == rant::SendStatus::Ok) {
                        rec->call_id = call.id;
                    } else {
                        rec->call_live = false;
                        rec->task_running = false;
                        rec->task_flags_dirty = true;
                    }
                }
                break;
            }
            if (!rec->fn) {
                fault = "call target '" + rec->name + "' has no function";
                return false;
            }
            Rec* self = rec;
            status = rec->fn->call_async(
                payload, [self](const rant::ResponseView<>& response) {
                    if (response.ok() && response.raw_schema()) {
                        const rant::Bytes data = response.data();
                        std::lock_guard<std::mutex> hold(self->slot_mu);
                        self->slot.assign(data.begin(), data.end());
                        self->slot_schema = response.raw_schema();
                        self->slot_dirty = true;
                    }
                });
            break;
        }
        default:
            fault = "verb does not apply to the mesh";
            return false;
    }
    /* A variable write's owner match may still be FORMING: the library queues an
     * unmatched function CALL and match-waits a topic SEND, but the accessor write
     * route fails fast with NoTopic while no owner has matched. Retry briefly — only
     * while this accessor has never seen its owner (once seen, NoTopic means the node
     * LEFT, and failing fast is honest) and only while the accessor is young enough
     * for "still forming" to be the likely story, so a write to a genuinely absent
     * owner never stalls the tick loop at steady state. */
    if (status == rant::SendStatus::NoTopic && rec->var &&
        (effect.verb == Verb::Write || effect.verb == Verb::Force) &&
        !rec->owner_seen.load(std::memory_order_relaxed)) {
        const Clock::time_point deadline =
            std::min(Clock::now() + std::chrono::milliseconds(kOwnerWaitMs),
                     rec->var_created + std::chrono::milliseconds(kOwnerFormingMs));
        while (status == rant::SendStatus::NoTopic && Clock::now() < deadline) {
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
            status = effect.verb == Verb::Force ? rec->var->force(payload)
                                                : rec->var->set(payload);
        }
    }
    if (status == rant::SendStatus::Ok && rec->kind == EntityKind::Variable)
        rec->owner_seen.store(true, std::memory_order_relaxed);
    if (status != rant::SendStatus::Ok) {
        fault = std::string(verb_name(effect.verb)) + " of '" + rec->name + "' " +
                send_status_story(status);
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

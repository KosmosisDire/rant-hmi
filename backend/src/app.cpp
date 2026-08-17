#include "app.h"

#include "compile/compiler.h"
#include "compile/components.h"
#include "lang/expression.h"
#include "lang/template_expr.h"
#include "doc/ops.h"
#include "registry/attrs.h"
#include "registry/registry.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <thread>

namespace hmi {
namespace {

/* how many versions of edit history the stale-base rule can look back over; a client
 * older than this reloads from a snapshot instead */
constexpr size_t kHistoryDepth = 128;

/* how much log history the snapshot replays to a late joiner */
constexpr size_t kLogKeep = 256;

/* how long a fault site holds new occurrences after logging an entry (ticks are ms):
 * a site faulting every tick reads as one line with a rising count every window, not
 * a thousand lines a second */
constexpr uint64_t kFaultWindowTicks = 5000;

/* Client frames are untrusted: read fields without ever throwing. */
Json field(const Json& object, const char* key) {
    if (!object.is_object()) return nullptr;
    auto it = object.find(key);
    return it == object.end() ? Json(nullptr) : *it;
}

std::string str_or(const Json& value, const char* fallback) {
    return value.is_string() ? value.get<std::string>() : fallback;
}

std::string frame_type(const Json& frame) { return str_or(field(frame, "type"), ""); }

Value input_value(const Json& value) {
    if (value.is_boolean()) return Value::boolean(value.get<bool>());
    if (value.is_number()) return Value::number(value.get<double>());
    if (value.is_string()) {
        bool ok = false;
        const uint32_t color = parse_color(value.get<std::string>(), ok);
        if (ok) return Value::color(color);
    }
    return Value::nil();
}

/* the nodes an op batch touches, as the client asked for them */
void op_targets(const Json& ops, std::vector<uint64_t>& out) {
    if (!ops.is_array()) return;
    for (const Json& op : ops) {
        if (!op.is_object()) continue;
        for (const char* key : {"node", "parent"}) {
            auto it = op.find(key);
            if (it == op.end()) continue;
            uint64_t id = 0;
            if (json_u64(*it, id)) out.push_back(id);
        }
    }
}

} // namespace

App::App(AppOptions opts, std::unique_ptr<MeshPort> mesh)
    : opts_(std::move(opts)), server_(opts_.server) {
    if (mesh) {
        mesh_ = std::move(mesh);
    } else if (opts_.mesh) {
        auto mesh = std::make_unique<DartMesh>(opts_.mesh_opts);
        dart_mesh_ = mesh.get();
        mesh_ = std::move(mesh);
    } else {
        mesh_ = std::make_unique<FakeMesh>();
    }
}

bool App::start(std::string& err) {
    if (!Document::from_file(opts_.doc_path, doc_, err)) {
        std::printf("hmi: no document at %s (%s), starting from the default\n",
                    opts_.doc_path.c_str(), err.c_str());
        doc_ = Document::make_default();
        if (opts_.persist && !doc_.to_file(opts_.doc_path, err)) return false;
    }
    if (dart_mesh_ && !dart_mesh_->start(err)) return false;
    if (dart_mesh_) mesh_->refresh();   /* whatever the mesh already knows, before the
                                           first compile; the rest lands via refresh */
    compile_runtime();
    next_tick_ = std::chrono::steady_clock::now();
    next_mesh_refresh_ = next_tick_;
    return server_.start(err);
}

void App::stop() { server_.stop(); }

size_t App::poll() {
    server_.drain(batch_);
    for (const Inbound& in : batch_) {
        switch (in.what) {
            case Inbound::What::Joined:
                sessions_[in.session] = SessionState{};
                if (opts_.verbose)
                    std::printf("hmi: session %llu from %s\n",
                                static_cast<unsigned long long>(in.session), in.client.c_str());
                break;
            case Inbound::What::Frame:
                on_frame(in.session, in.frame);
                break;
            case Inbound::What::Gone:
                if (scheduler_) scheduler_->release_session(in.session);
                sessions_.erase(in.session);
                update_viewed_pages();
                if (opts_.verbose)
                    std::printf("hmi: session %llu gone\n",
                                static_cast<unsigned long long>(in.session));
                break;
        }
    }
    if (scheduler_) {
        const auto now = std::chrono::steady_clock::now();
        size_t catchup = 0;
        while (next_tick_ <= now && catchup++ < 100) {
            std::string fault;
            if (!scheduler_->tick(fault)) {
                /* an effect fault joins the log through the same coalescer as the
                   VM's runtime faults, keyed by its message */
                ++effect_faults_[fault].pending;
                if (opts_.verbose)
                    std::printf("hmi: effect fault: %s\n", fault.c_str());
            }
            /* before the next tick's clear_outputs erases them */
            drain_notices();
            next_tick_ += std::chrono::milliseconds(1);
        }
        if (next_tick_ + std::chrono::milliseconds(100) < now)
            next_tick_ = now;
        drain_faults();
        if (scheduler_->state().tick - last_live_tick_ >= 33) publish_live();
    }
    publish_log();
    /* reflection at control-plane rate: a schema arriving or changing recompiles
     * through the ordinary hot-swap path and re-serves the entity tree */
    if (std::chrono::steady_clock::now() >= next_mesh_refresh_) {
        next_mesh_refresh_ = std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
        if (mesh_->refresh()) {
            compile_runtime();
            if (server_.sessions()) {
                Json frame = mesh_json();
                frame["type"] = "mesh";
                server_.broadcast(frame);
            }
        }
    }
    return batch_.size();
}

void App::on_frame(uint64_t session, const Json& frame) {
    if (frame.is_discarded() || !frame.is_object()) {
        reject(session, "frame is not JSON");
        return;
    }
    const std::string type = frame_type(frame);
    if (type == "hello") { on_hello(session, frame); return; }

    auto it = sessions_.find(session);
    if (it == sessions_.end()) return;
    if (!it->second.hello) { reject(session, "say hello first"); return; }

    if (type == "view") {
        it->second.page = json_u64_or(field(frame, "page_id"), 0);
        const Json visible = field(frame, "visible");
        it->second.visible = visible.is_boolean() ? visible.get<bool>() : true;
        update_viewed_pages();
        return;
    }
    if (type == "apply_ops") { on_apply_ops(session, frame); return; }
    if (type == "resync") {
        /* a view that saw a version gap discards its state and reloads from here,
         * rather than patching around the hole */
        send_snapshot(session);
        return;
    }
    if (type == "input") {
        on_input(session, frame);
        return;
    }
    reject(session, "unknown frame '" + type + "'");
}

void App::on_hello(uint64_t session, const Json& frame) {
    auto it = sessions_.find(session);
    if (it == sessions_.end()) return;
    const uint64_t proto = json_u64_or(field(frame, "proto"), 0);
    if (proto != static_cast<uint64_t>(kProto)) {
        reject(session, "protocol " + std::to_string(proto) + ", this backend speaks " +
                            std::to_string(kProto));
        server_.disconnect(session);
        return;
    }
    it->second.hello = true;
    it->second.name = str_or(field(frame, "client_name"), "view");
    server_.send(session, Json{{"type", "welcome"},
                               {"session_id", session},
                               {"proto", kProto},
                               {"doc_version", doc_.version()}});
    send_snapshot(session);
}

void App::on_apply_ops(uint64_t session, const Json& frame) {
    const uint64_t base = json_u64_or(field(frame, "base_version"), 0);
    const Json ops = field(frame, "ops");

    std::string why;
    if (!base_is_usable(base, ops, why)) { reject(session, why); return; }

    ApplyResult applied;
    std::string err;
    /* THE INDEXER a rename resolves against: the same three compiles compile_runtime
     * runs, over whatever document the op layer hands in (the scratch mid-batch), rows
     * and blind sites only. Bound here because doc/ must not include compile/. */
    const Indexer indexer = [this](const Document& doc) {
        RefIndex index;
        std::vector<Diag> findings;
        std::set<std::string> per_copy;
        compile_page_attrs(doc, findings, &mesh_->reflection(), nullptr, &per_copy,
                           &index.rows, &index.blind);
        CompileResult compiled = compile_document(doc, *mesh_, &per_copy);
        for (RefRow& row : compiled.program.references)
            index.rows.push_back(std::move(row));
        for (RefSite& gap : compiled.program.reference_gaps)
            index.blind.push_back(std::move(gap));
        check_component_definitions(doc, *mesh_, &index.rows, &index.blind);
        return index;
    };
    if (!apply_ops(doc_, ops, applied, err, indexer)) { reject(session, err); return; }

    remember(applied.version, applied.touched);
    ++edits_;
    if (opts_.persist && !doc_.to_file(opts_.doc_path, err))
        std::printf("hmi: cannot save %s: %s\n", opts_.doc_path.c_str(), err.c_str());

    /* THE COMPILE PRODUCTS DO NOT RIDE THE ECHO. The registry (built-ins shadowed by the
     * document's components) and `node_attrs` (every page node's compiled fields) are both
     * derived, and ops_applied carries neither: when an edit changed what the derivation
     * produces, every client gets a fresh snapshot AFTER the op echo. The echo keeps the
     * editing clients' version sequencing and in-flight batches exact; the snapshot (which
     * settles everything outstanding on the client, protocol.ts) delivers the new product.
     *
     * `node_attrs` is why an ordinary set_prop can trigger this now: editing an attr
     * changes the PROGRAM that field evaluates to, and a view still holding the old one
     * would keep drawing the old value — a boundary drag would commit and then snap back.
     * Comparing the derived JSON is the one detection that cannot drift from whatever ops
     * turn out to touch what. (A per-node delta on the echo is the obvious optimisation;
     * at this document size a snapshot is cheaper than the machinery to avoid one.) */
    const Json registry_before = registry_;
    const Json attrs_before = node_attrs_;
    compile_runtime();
    server_.broadcast(Json{{"type", "ops_applied"},
                           {"version", applied.version},
                           {"ops", applied.ops},
                           {"origin_session", session}});
    if (registry_ != registry_before || node_attrs_ != attrs_before)
        server_.broadcast(snapshot());
}

/* One SCALAR cell value as the wire sees it: numbers and booleans as themselves, text
 * resolved through the run's slots, a color as its hex, an enum as its variant NAME (the
 * vocabulary the author picked it by; a value outside it shows its integer). Null for
 * anything that is not a scalar — an aggregate rides as an aggregate (wire_element), and
 * a value that is neither is a gap. */
static Json wire_scalar(const Program& program, const RuntimeState& state,
                        const Value& value) {
    switch (value.tag) {
        case ValueTag::Num: return value.data.num;
        case ValueTag::Bool: return value.data.boolean;
        case ValueTag::Text: return std::string(state.text(program, value));
        case ValueTag::Color: return format_color(value.data.rgba);
        case ValueTag::Enum: {
            if (value.type_id < program.types.size())
                for (const auto& row : program.types[value.type_id].variants)
                    if (row.second == value.data.integer) return row.first;
            return static_cast<double>(value.data.integer);
        }
        default: return Json();
    }
}

/* ONE ELEMENT of an aggregate cell as the wire sees it. A scalar is itself; a ROW — the
 * element of a cell whose `elem` declares list or map — is the aggregate it is: a JSON
 * array, or an object where the row is a map. The recursion stops after exactly one step
 * because nesting is one declared level, so a row holds leaves and nothing else.
 *
 * A row rides WHOLE inside its element rather than on a delta lane of its own. That is
 * not a shortcut: a leaf edit or a leaf append moves the CELL's generation (there is no
 * in-place-edit vocabulary on the aggs lane), and a moved generation already resends the
 * whole window — so a per-row delta would have nothing left to save. */
static Json wire_element(const Program& program, const RuntimeState& state,
                         const Value& value) {
    if (value.tag != ValueTag::List && value.tag != ValueTag::Map)
        return wire_scalar(program, state, value);
    const AggView row = state.aggregate(value);
    if (value.tag == ValueTag::Map) {
        Json entries = Json::object();
        for (uint32_t i = 0; i < row.count; ++i)
            entries[std::string(state.text(program, row.data[i * 2]))] =
                wire_scalar(program, state, row.data[i * 2 + 1]);
        return entries;
    }
    Json items = Json::array();
    for (uint32_t i = 0; i < row.count; ++i)
        items.push_back(wire_scalar(program, state, row.data[i]));
    return items;
}

Json App::live(bool full) const {
    Json values = Json::object();
    Json aggs = Json::object();
    if (!scheduler_)
        return Json{{"epoch", epoch_}, {"values", values}, {"aggs", aggs}};
    const Program& program = scheduler_->program();
    const RuntimeState& state = scheduler_->state();
    for (uint32_t i = 0; i < program.cells.size(); ++i) {
        const CellDef& cell = program.cells[i];
        /* a struct value's derived field cell never publishes: it has no key of its
           own and the struct's would collide */
        if (cell.field_of != UINT32_MAX) continue;
        const Value& value = state.values[i];
        const std::string key =
            cell.kind == CellKind::Slot
                ? std::to_string(cell.owner_node) + "." + cell.name
                : "v" + std::to_string(cell.node_id);
        /* AN AGGREGATE CELL RIDES THE DELTA LANE, not `values`. A ring re-sent whole
           every frame is the same bytes over and over for one appended sample, and at a
           4096-element window that is the broadcast's whole cost. */
        if (cell.shape == Shape::List || cell.shape == Shape::Map) {
            Json entry = agg_entry(cell.list_slot, cell.shape, value, full);
            if (!entry.is_null()) aggs[key] = std::move(entry);
            continue;
        }
        switch (value.tag) {
            case ValueTag::Num:
            case ValueTag::Bool:
            case ValueTag::Text:
            case ValueTag::Color:
            case ValueTag::Enum:
                values[key] = wire_scalar(program, state, value);
                break;
            default: break;
        }
    }
    /* THE MESH FIELDS A PAGE'S ATTRS READ. Only those: the display tier is a compression
     * of display state and this lane exists to keep it one, so an entity a flow alone
     * reads never rides here. The read set is the display compile's own product
     * (attr_entity_reads_), consulted here rather than stamped into the entity table.
     * The value is the SAME last-value mirror the flow reads (LoadEnt), which is what
     * makes an attr and a guard agree about a field; an unknown one omits its key,
     * exactly as a Nil cell does, and the view reads Nil for it. */
    for (uint32_t e = 0; e < program.entities.size(); ++e) {
        const EntityDef& def = program.entities[e];
        if (e >= state.last.size()) continue;
        const LastValueState& last = state.last[e];
        const std::vector<FieldDef>& fields = feed_fields(def);
        for (uint32_t i = 0; i < fields.size(); ++i) {
            if (!attr_entity_reads_.count(def.name + "\n" + fields[i].path)) continue;
            const std::string key = mesh_cell(def.name, fields[i].path);
            if (fields[i].shape == Shape::List || fields[i].shape == Shape::Map) {
                const uint32_t mirror = e < state.entity_aggs.size() &&
                                                i < state.entity_aggs[e].size()
                                            ? state.entity_aggs[e][i]
                                            : UINT32_MAX;
                if (mirror == UINT32_MAX) continue;
                Json entry = agg_entry(mirror, fields[i].shape,
                                       last.known ? last.fields[i] : Value::nil(), full);
                if (!entry.is_null()) aggs[key] = std::move(entry);
                continue;
            }
            if (!last.known || i >= last.fields.size()) continue;
            switch (last.fields[i].tag) {
                case ValueTag::Num:
                case ValueTag::Bool:
                case ValueTag::Text:
                case ValueTag::Color:
                case ValueTag::Enum:
                    values[key] = wire_scalar(program, state, last.fields[i]);
                    break;
                default: break;
            }
        }
    }
    for (uint32_t i = 0; i < program.timers.size(); ++i) {
        const TimerDef& def = program.timers[i];
        const TimerState& timer = state.timers[i];
        values["v" + std::to_string(def.node_id)] =
            Json{{"running", timer.running},
                 {"remaining", static_cast<double>(timer.remaining) / 1000.0},
                 {"duration", static_cast<double>(def.duration_ticks) / 1000.0},
                 {"progress", def.duration_ticks
                                  ? 1.0 - static_cast<double>(timer.remaining) /
                                              def.duration_ticks
                                  : 0.0}};
    }
    return Json{{"epoch", epoch_},
                {"values", std::move(values)},
                {"aggs", std::move(aggs)}};
}

/* ONE AGGREGATE CELL ON THE WIRE, or null when it has not moved since the last publish.
 *
 * The contract, in full:
 *   {"gen": G, "nil": true}                          the cell is UNKNOWN
 *   {"gen": G, "from": F, "len": L, "values": [...]}  a list: the elements at absolute
 *                                                     indices F.. , and the length the
 *                                                     window has NOW (the client appends
 *                                                     them, then trims its front to L)
 *   {"gen": G, "map": true, "values": {k: v, ...}}    a map, whole
 *
 * An element is a scalar, or — where the cell's `elem` declares one — a whole ROW, which
 * rides as the aggregate it is (wire_element): [..] for a list row, {k: v} for a map row.
 *
 * `from` and the cursor count APPENDS EVER and never rewind on a trim, so the client can
 * tell "three new samples" from "a different list that happens to be the same length".
 * When the generation moves — a whole store, a clear, a recompile — the frame carries the
 * whole window and the client replaces rather than appends. A map is small and has no
 * append order, so it goes whole on any change at all. */
Json App::agg_entry(uint32_t list_slot, Shape shape, const Value& value, bool full) const {
    const Program& program = scheduler_->program();
    const RuntimeState& state = scheduler_->state();
    if (list_slot >= state.lists.size()) return Json();
    const ListState& held = state.lists[list_slot];
    const AggCursor cursor =
        list_slot < agg_published_.size() ? agg_published_[list_slot] : AggCursor{};
    const bool moved = cursor.gen != held.gen || cursor.total != held.total;
    if (!full && !moved) return Json();

    if (value.tag != ValueTag::List && value.tag != ValueTag::Map)
        return Json{{"gen", held.gen}, {"nil", true}};

    const AggView view = state.aggregate(value);
    if (shape == Shape::Map) {
        Json entries = Json::object();
        for (uint32_t k = 0; k < view.count; ++k)
            entries[std::string(state.text(program, view.data[k * 2]))] =
                wire_element(program, state, view.data[k * 2 + 1]);
        return Json{{"gen", held.gen}, {"map", true}, {"values", std::move(entries)}};
    }

    /* the absolute index of the oldest element still in the window: everything before it
       has fallen off the front and cannot be sent as an append */
    const uint64_t oldest = held.total - view.count;
    uint64_t from = oldest;
    if (!full && cursor.gen == held.gen && cursor.total >= oldest &&
        cursor.total <= held.total)
        from = cursor.total;
    Json items = Json::array();
    for (uint64_t at = from; at < held.total; ++at)
        items.push_back(wire_element(program, state,
                                     view.data[static_cast<uint32_t>(at - oldest)]));
    return Json{{"gen", held.gen},
                {"from", from},
                {"len", view.count},
                {"values", std::move(items)}};
}

void App::on_input(uint64_t session, const Json& frame) {
    if (!scheduler_) return;
    const uint64_t node = json_u64_or(field(frame, "node"), 0);
    const uint64_t sequence = json_u64_or(field(frame, "seq"), 0);
    const std::string event = str_or(field(frame, "event"), "");
    if (!node || event.empty()) {
        reject(session, "input needs node and event");
        return;
    }
    InputEvent input;
    input.session = session;
    input.node = node;
    input.event = event;
    input.element = str_or(field(frame, "element"), "");
    input.value = input_value(field(frame, "value"));
    input.sequence = sequence;
    /* WHICH COPY OF A `repeat` the pointer was on. Absent is the honest spelling of "not
       inside a repeat" — the key rides only where there is one, exactly as a Nil cell's
       key is omitted. A row that does not describe a real copy is no copy at all rather
       than an index the flows would write somewhere with. */
    const Json copy = field(frame, "repeat");
    if (copy.is_object()) {
        const uint64_t index = json_u64_or(field(copy, "index"), 0);
        const uint64_t count = json_u64_or(field(copy, "count"), 0);
        if (count > 0 && index < count) {
            input.repeat.live = true;
            input.repeat.index = static_cast<uint32_t>(index);
            input.repeat.count = static_cast<uint32_t>(count);
        }
    }
    /* a string that is not a color is TEXT (a Dropdown's selected option); it rides
       beside the Value and the scheduler homes it into the run's input slot */
    const Json raw = field(frame, "value");
    if (raw.is_string() && input.value.tag == ValueTag::Nil)
        input.text = raw.get<std::string>();
    scheduler_->post(std::move(input));
}

void App::compile_runtime() {
    component_diags_.clear();
    registry_ = derive_registry(doc_, component_diags_);
    /* A PAGE COMPILES TOO. Its nodes are the same nodes a component's are, so their attrs
     * are lowered by the same compiler into the same view programs, and the renderer runs
     * one interpreter over both. This is the whole of what "one tree" costs the backend. */
    /* THE ATTRS COMPILE FIRST. What they read of the mesh stays THEIR product
     * (attr_entity_reads_): the live frame serves exactly those fields, and the mesh is
     * handed the read entities at apply() beside the program — nothing display-tier is
     * stamped into the wire compile. A page's expressions see the mesh; a component's
     * deliberately do not. */
    attr_entity_reads_.clear();
    per_copy_slots_.clear();
    node_attrs_ = compile_page_attrs(doc_, component_diags_, &mesh_->reflection(),
                                     &attr_entity_reads_, &per_copy_slots_);
    /* the WIRE tier checks unplaced components' behavior the same way the display
       tier just checked their attrs: off the definition, findings only */
    for (Diag& diag : check_component_definitions(doc_, *mesh_))
        component_diags_.push_back(std::move(diag));
    CompileResult compiled = compile_document(doc_, *mesh_, &per_copy_slots_);
    auto next = std::make_unique<Scheduler>(std::move(compiled.program), *mesh_);
    if (scheduler_)
        next->state() = migrate_state(scheduler_->program(), scheduler_->state(),
                                      next->program());
    scheduler_ = std::move(next);
    ++epoch_;
    /* resend every aggregate whole on the next live frame: a migrated cell's generation
       moved, and a client holding the old one has to replace rather than append */
    agg_published_.assign(scheduler_->state().lists.size(), AggCursor{});
    /* fault sites renumber with the program: drop the coalescing rows (a still-faulting
       site simply announces itself again, which after an edit is the right thing) */
    fault_sites_.clear();
    /* the entities the display tier reads, by name: the mesh consumes them exactly as
       it consumes what the procedure signatures read */
    std::set<std::string> display_reads;
    for (const std::string& key : attr_entity_reads_)
        display_reads.insert(key.substr(0, key.find('\n')));
    mesh_->apply(scheduler_->program(), display_reads);
    update_viewed_pages();
    if (server_.sessions())
        server_.broadcast(Json{{"type", "diag"}, {"compile", diagnostics()}});
}

void App::update_viewed_pages() {
    std::vector<uint64_t> pages;
    for (const auto& item : sessions_) {
        if (!item.second.visible || !item.second.page) continue;
        if (std::find(pages.begin(), pages.end(), item.second.page) == pages.end())
            pages.push_back(item.second.page);
    }
    mesh_->set_viewed_pages(pages);
}

Json App::mesh_json() const {
    auto fields_json = [](const std::vector<FieldDef>& fields) {
        Json rows = Json::array();
        for (const FieldDef& field : fields) {
            Json row{{"path", field.path}, {"shape", shape_name(field.shape)}};
            if (field.shape == Shape::List || field.shape == Shape::Map)
                row["elem"] = shape_name(field.elem);
            if (!field.variants.empty()) {
                Json variants = Json::array();
                for (const auto& variant : field.variants)
                    variants.push_back(Json{{"name", variant.first},
                                            {"value", variant.second}});
                row["variants"] = std::move(variants);
            }
            rows.push_back(std::move(row));
        }
        return rows;
    };

    Json entities = Json::array();
    for (const EntityDef& entity : mesh_->reflection()) {
        Json row{{"kind", std::string(1, "VTFS"[static_cast<int>(entity.kind)])},
                 {"name", entity.name},
                 {"type", entity.type_name},
                 {"writable", entity.writable},
                 {"forceable", entity.forceable},
                 {"fields", fields_json(entity.fields)}};
        if (entity.kind == EntityKind::Function)
            row["returns"] = fields_json(entity.rsp_fields);
        entities.push_back(std::move(row));
    }

    /* The TYPE TABLE (spec 2.2), which is a COMPILE product rather than raw reflection:
     * two entities carrying the same schema are one entry, so `ValveCmd` is offered once
     * however many valves the mesh has. Each entry names the entities carrying it, which
     * is how a picker identifies an unfamiliar type name. An unnamed root is served with
     * an empty name: the view lists it, marked, and refuses to pick it by name. */
    Json types = Json::array();
    if (scheduler_) {
        const Program& program = scheduler_->program();
        for (uint16_t id = 1; id < program.types.size(); ++id) {
            const TypeDef& def = program.types[id];
            if (def.kind != TypeKind::Struct) continue;
            Json carriers = Json::array();
            for (const EntityDef& entity : program.entities)
                if (entity.type_id == id)
                    carriers.push_back(
                        Json{{"kind", std::string(1, "VTFS"[static_cast<int>(entity.kind)])},
                             {"name", entity.name}});
            types.push_back(Json{{"name", def.name},
                                 {"fields", fields_json(def.fields)},
                                 {"entities", std::move(carriers)}});
        }
    }
    return Json{{"entities", std::move(entities)}, {"types", std::move(types)}};
}

/* the expression language as data (spec 3.7): straight from the compiler's own
 * tables, so what autocomplete offers and what compiles can never disagree */
Json App::lang_json() {
    Json builtins = Json::array();
    Json methods = Json::array();
    for (const LangRow& row : language_reference()) {
        Json args = Json::array();
        for (uint32_t i = 0; i < row.max_args && i < 5 && row.args[i]; ++i)
            args.push_back(row.args[i]);
        Json entry{{"name", row.name},
                   {"args", std::move(args)},
                   {"min_args", row.min_args},
                   {"result", row.result},
                   {"tier", row.display_only ? "display" : "both"},
                   /* does the VIEW have an encoding for this row at all (expression.h):
                      the question a template attribute's autocomplete must filter on,
                      separate from `tier`, which only says which SCALAR positions
                      (feed vs. flow) may use it */
                   {"view", row.view}};
        if (std::string(row.kind) == "method") {
            entry["receiver"] = row.receiver;
            methods.push_back(std::move(entry));
        } else {
            builtins.push_back(std::move(entry));
        }
    }
    return Json{{"builtins", std::move(builtins)}, {"methods", std::move(methods)}};
}

Json App::diagnostics() const {
    Json rows = Json::array();
    auto row = [&](const Diag& diag) {
        Json entry{{"node", diag.node_id},
                   {"grade", diag.grade == DiagGrade::Error     ? "error"
                             : diag.grade == DiagGrade::Warning ? "warning"
                                                                : "info"},
                   {"code", diag.code},
                   {"message", diag.message},
                   {"where", diag.where}};
        /* the SPAN as data: where in the field's expression source the finding
           points, so the view can underline instead of parsing a column out of
           the words */
        if (diag.at != static_cast<size_t>(-1)) {
            entry["at"] = static_cast<uint64_t>(diag.at);
            entry["length"] = static_cast<uint64_t>(diag.length);
        }
        rows.push_back(std::move(entry));
    };
    /* component findings first: a broken component explains the instance findings that
     * usually follow it */
    for (const Diag& diag : component_diags_) row(diag);
    if (!scheduler_) return rows;
    for (const Diag& diag : scheduler_->program().diagnostics) row(diag);
    return rows;
}

/* one notify step's record into a wire entry: the flow already rendered the text, the
 * tick already stamped the wall clock. `ms` rides only when the author set it — its
 * absence IS the "scale with the length" instruction to the view. */
void App::drain_notices() {
    if (!scheduler_) return;
    RuntimeState& state = scheduler_->state();
    for (uint32_t i = 0; i < state.notice_count && i < state.notices.size(); ++i) {
        const NoticeRecord& record = state.notices[i];
        Json entry{{"level", "notify"},
                   {"node", "hmi"},
                   {"text", std::string(record.text.view())},
                   {"wall_us", static_cast<uint64_t>(state.wall_ms * 1000.0)}};
        if (record.ms) entry["ms"] = record.ms;
        fresh_log_.push_back(std::move(entry));
    }
    state.notice_count = 0;
}

/* RUNTIME FAULTS INTO THE LOG, coalesced per site. state.faults keeps one cumulative
 * counter per compiled fault site (the diagnostics live in program.runtime_faults);
 * this drain diffs each counter against what it last saw, logs a site's FIRST fault
 * immediately, and from then on logs that site at most once per window with the count
 * it gathered — "message (x512)". The key is the SITE (an effect fault's is its
 * message), so two sites faulting in alternation each coalesce on their own clock;
 * there is no shared "last entry" for them to defeat. */
void App::drain_faults() {
    if (!scheduler_) return;
    const Program& program = scheduler_->program();
    const RuntimeState& state = scheduler_->state();
    const uint64_t now = state.tick;
    if (fault_sites_.size() != program.runtime_faults.size())
        fault_sites_.assign(program.runtime_faults.size(), PendingFault{});
    auto emit = [&](PendingFault& row, const std::string& message) {
        fresh_log_.push_back(
            Json{{"level", "error"},
                 {"node", "hmi"},
                 {"text", row.pending > 1
                              ? message + " (x" + std::to_string(row.pending) + ")"
                              : message},
                 {"wall_us", static_cast<uint64_t>(state.wall_ms * 1000.0)}});
        row.pending = 0;
        row.emit_tick = now + kFaultWindowTicks;
    };
    for (uint32_t i = 0; i < fault_sites_.size() && i < state.faults.size(); ++i) {
        PendingFault& row = fault_sites_[i];
        const uint32_t count = state.faults[i].count;
        if (count != row.seen) {
            /* != rather than >: a counter that restarted (a migrated state) reads as
               its new value's worth of faults instead of a silent stall */
            row.pending += count > row.seen ? count - row.seen : count;
            row.seen = count;
        }
        if (row.pending && now >= row.emit_tick)
            emit(row, program.runtime_faults[i].message);
    }
    for (auto& item : effect_faults_)
        if (item.second.pending && now >= item.second.emit_tick)
            emit(item.second, item.first);
}

/* the log's one exit: whatever this poll gathered — notify records and the mesh's
 * @dart/log lines — lands in the ring (the snapshot's backlog) and broadcasts as ONE
 * `log` frame, so every session pops the same notifications at the same moment */
void App::publish_log() {
    mesh_logs_.clear();
    mesh_->take_logs(mesh_logs_);
    static const char* const kLevelNames[3] = {"error", "warn", "info"};
    for (const MeshLogLine& line : mesh_logs_)
        fresh_log_.push_back(
            Json{{"level", kLevelNames[line.level >= 0 && line.level < 3 ? line.level : 2]},
                 {"node", line.node},
                 {"text", line.text},
                 {"wall_us", line.wall_us}});
    if (fresh_log_.empty()) return;
    Json entries = Json::array();
    for (Json& entry : fresh_log_) {
        log_.push_back(entry);
        entries.push_back(std::move(entry));
    }
    fresh_log_.clear();
    while (log_.size() > kLogKeep) log_.pop_front();
    if (server_.sessions())
        server_.broadcast(Json{{"type", "log"}, {"entries", std::move(entries)}});
}

void App::publish_live() {
    if (!scheduler_) return;
    last_live_tick_ = scheduler_->state().tick;
    Json frame = live();
    frame["type"] = "live";
    /* the cursors advance ONLY here: a snapshot is one session's whole picture and must
       not tell the broadcast that everyone has seen it */
    const RuntimeState& state = scheduler_->state();
    agg_published_.assign(state.lists.size(), AggCursor{});
    for (uint32_t i = 0; i < state.lists.size(); ++i)
        agg_published_[i] = AggCursor{state.lists[i].gen, state.lists[i].total};
    server_.broadcast(frame);
}

Json App::snapshot() const {
    Json live_frame = live(/*full=*/true);
    Json log_rows = Json::array();
    for (const Json& entry : log_) log_rows.push_back(entry);
    return Json{{"type", "snapshot"},
                {"version", doc_.version()},
                {"doc", doc_.root},
                {"registry", registry_},
                /* every PAGE node's compiled attrs, keyed by node id: the document says
                 * what the tree IS, this says what each node's fields evaluate to, and
                 * the renderer needs both. Rides the snapshot rather than the live frame
                 * because it changes when the DOCUMENT does, not when a value does. */
                {"node_attrs", node_attrs_},
                /* the built-ins' EDITABLE document form (no ids): the registry serves
                 * compiled programs, so forking a built-in into doc.components needs
                 * this. It never changes at runtime, so the snapshot is enough. */
                {"builtins", builtin_components()},
                {"live", std::move(live_frame)},
                {"mesh", mesh_json()},
                {"lang", lang_json()},
                /* the closed attr vocabulary (spec 2.3): declared once in C++
                 * (registry/attrs.h), never changes at runtime, so — exactly like
                 * `builtins` above — the snapshot is its only carrier */
                {"attr_table", attr_table_json()},
                /* the log backlog, oldest first: what the mesh's @dart/log topics said
                 * and what notify steps spoke before this client joined. History only —
                 * a snapshot never pops notifications; the `log` frame does that. */
                {"log", std::move(log_rows)},
                {"diag", Json{{"compile", diagnostics()}}}};
}

void App::send_snapshot(uint64_t session) { server_.send(session, snapshot()); }

void App::reject(uint64_t session, const std::string& reason) {
    server_.send(session, Json{{"type", "reject"}, {"reason", reason}});
    auto it = sessions_.find(session);
    if (it != sessions_.end() && it->second.hello) send_snapshot(session);
}

bool App::base_is_usable(uint64_t base, const Json& ops, std::string& why) const {
    const uint64_t now = doc_.version();
    if (base == now) return true;
    if (base > now) {
        why = "base version " + std::to_string(base) + " is ahead of " + std::to_string(now);
        return false;
    }
    if (history_.empty() || history_.front().first > base + 1) {
        why = "base version " + std::to_string(base) + " is too far behind " +
              std::to_string(now);
        return false;
    }
    /* Concurrent edits are fine while they touch different nodes; that is the common
     * case for two people on one panel (spec 4.2). Overlap is a reject. */
    std::vector<uint64_t> targets;
    op_targets(ops, targets);
    for (const auto& entry : history_) {
        if (entry.first <= base) continue;
        for (uint64_t changed : entry.second)
            for (uint64_t target : targets)
                if (changed == target) {
                    why = "node " + std::to_string(target) + " changed since version " +
                          std::to_string(base);
                    return false;
                }
    }
    return true;
}

void App::remember(uint64_t version, const std::vector<uint64_t>& touched) {
    history_.push_back({version, touched});
    while (history_.size() > kHistoryDepth) history_.pop_front();
}

} // namespace hmi

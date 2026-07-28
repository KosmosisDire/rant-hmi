#include "app.h"

#include "compile/compiler.h"
#include "compile/expression.h"
#include "doc/ops.h"
#include "registry/registry.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <thread>

namespace hmi {
namespace {

/* how many versions of edit history the stale-base rule can look back over; a client
 * older than this reloads from a snapshot instead */
constexpr size_t kHistoryDepth = 128;

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

App::App(AppOptions opts) : opts_(std::move(opts)), server_(opts_.server) {
    if (opts_.mesh) {
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
            if (!scheduler_->tick(fault) && opts_.verbose)
                std::printf("hmi: effect fault: %s\n", fault.c_str());
            next_tick_ += std::chrono::milliseconds(1);
        }
        if (next_tick_ + std::chrono::milliseconds(100) < now)
            next_tick_ = now;
        if (scheduler_->state().tick - last_live_tick_ >= 33) publish_live();
    }
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
    if (!apply_ops(doc_, ops, applied, err)) { reject(session, err); return; }

    remember(applied.version, applied.touched);
    ++edits_;
    if (opts_.persist && !doc_.to_file(opts_.doc_path, err))
        std::printf("hmi: cannot save %s: %s\n", opts_.doc_path.c_str(), err.c_str());

    compile_runtime();
    server_.broadcast(Json{{"type", "ops_applied"},
                           {"version", applied.version},
                           {"ops", applied.ops},
                           {"origin_session", session}});
}

Json App::live() const {
    Json values = Json::object();
    if (!scheduler_) return Json{{"epoch", epoch_}, {"values", values}};
    const Program& program = scheduler_->program();
    const RuntimeState& state = scheduler_->state();
    for (uint32_t i = 0; i < program.cells.size(); ++i) {
        const CellDef& cell = program.cells[i];
        const Value& value = state.values[i];
        const std::string key =
            cell.kind == CellKind::Slot
                ? std::to_string(cell.owner_widget) + "." + cell.name
                : "v" + std::to_string(cell.node_id);
        switch (value.tag) {
            case ValueTag::Num: values[key] = value.data.num; break;
            case ValueTag::Bool: values[key] = value.data.boolean; break;
            case ValueTag::Text: values[key] = std::string(state.text(program, value)); break;
            case ValueTag::Color: values[key] = format_color(value.data.rgba); break;
            case ValueTag::Enum: {
                /* an enum reads as its variant NAME (the vocabulary the author picked
                   it by); a value outside the vocabulary shows its integer */
                std::string name;
                if (value.type_id < program.types.size())
                    for (const auto& row : program.types[value.type_id].variants)
                        if (row.second == value.data.integer) { name = row.first; break; }
                if (name.empty()) values[key] = static_cast<double>(value.data.integer);
                else values[key] = name;
                break;
            }
            default: break;
        }
    }
    for (uint32_t i = 0; i < program.timers.size(); ++i) {
        const TimerDef& def = program.timers[i];
        const TimerState& timer = state.timers[i];
        values["v" + std::to_string(def.node_id)] =
            Json{{"running", timer.running},
                 {"remaining", static_cast<double>(timer.remaining) / 1000.0},
                 {"duration", static_cast<double>(def.duration_ticks) / 1000.0}};
    }
    return Json{{"epoch", epoch_}, {"values", std::move(values)}};
}

void App::on_input(uint64_t session, const Json& frame) {
    if (!scheduler_) return;
    const uint64_t widget = json_u64_or(field(frame, "widget_id"), 0);
    const uint64_t sequence = json_u64_or(field(frame, "seq"), 0);
    const std::string event = str_or(field(frame, "event"), "");
    if (!widget || event.empty()) {
        reject(session, "input needs widget_id and event");
        return;
    }
    InputEvent input{session, widget, event, input_value(field(frame, "value")), sequence};
    /* a string that is not a color is TEXT (a Dropdown's selected option); it rides
       beside the Value and the scheduler homes it into the run's input slot */
    const Json raw = field(frame, "value");
    if (raw.is_string() && input.value.tag == ValueTag::Nil)
        input.text = raw.get<std::string>();
    scheduler_->post(std::move(input));
}

void App::compile_runtime() {
    CompileResult compiled = compile_document(doc_, registry(), *mesh_);
    auto next = std::make_unique<Scheduler>(std::move(compiled.program), *mesh_);
    if (scheduler_)
        next->state() = migrate_state(scheduler_->program(), scheduler_->state(),
                                      next->program());
    scheduler_ = std::move(next);
    ++epoch_;
    mesh_->apply(scheduler_->program());
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
                   {"tier", row.display_only ? "display" : "both"}};
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
    if (!scheduler_) return rows;
    for (const Diag& diag : scheduler_->program().diagnostics)
        rows.push_back(Json{{"node", diag.node_id},
                            {"grade", diag.grade == DiagGrade::Error     ? "error"
                                      : diag.grade == DiagGrade::Warning ? "warning"
                                                                         : "info"},
                            {"code", diag.code},
                            {"message", diag.message},
                            {"where", diag.where}});
    return rows;
}

void App::publish_live() {
    if (!scheduler_) return;
    last_live_tick_ = scheduler_->state().tick;
    Json frame = live();
    frame["type"] = "live";
    server_.broadcast(frame);
}

Json App::snapshot() const {
    return Json{{"type", "snapshot"},
                {"version", doc_.version()},
                {"doc", doc_.root},
                {"registry", registry()},
                {"live", live()},
                {"mesh", mesh_json()},
                {"lang", lang_json()},
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

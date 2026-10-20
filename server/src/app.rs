//! The backend's one loop. It owns the project, the mesh and every screen's session, so
//! nothing is shared and nothing locks.

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use serde_json::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tracing::{info, warn};

use crate::authorize::{Who, authorize};
use crate::mesh::{Delivery, Mesh};
use crate::pages::{Edit, Event, Pages};
use crate::mesh::codec;
use crate::project::{Import, Intent, Kind, Per, Project, Variable};
use crate::protocol::{ClientMsg, Level, ServerMsg, ValueUpdate};
use crate::script::{CallFailure, End, FromScript, Script, ToScript};

/// How often changed values go out and the mesh is checked.
const TICK: Duration = Duration::from_millis(33);
/// A screen silent this long is lost.
const SILENCE: Duration = Duration::from_millis(500);
/// How many edits a screen can undo.
const UNDO_DEPTH: usize = 200;
const HEALTH_EVERY: Duration = Duration::from_secs(1);

/// What a screen's connection hands the loop.
pub enum Inbound {
    /// `out` takes the screen's encoded messages.
    Open { session: u32, out: UnboundedSender<Bytes> },
    Message { session: u32, msg: ClientMsg },
    Close { session: u32 },
}

struct Session {
    out: UnboundedSender<Bytes>,
    heard: Instant,
    /// The edits that undo this screen's own edits, newest last, and those that redo them.
    undo: Vec<Edit>,
    redo: Vec<Edit>,
    /// The values of the variables each screen has.
    vars: HashMap<String, Value>,
}

/// Why an edit is applied, which says which stack its undo goes on.
#[derive(Clone, Copy)]
enum Step {
    Do,
    Undo,
    Redo,
}

/// A handler run going on: who started it, and what it is called in the log.
struct Running {
    session: u32,
    page: String,
    id: String,
    event: Event,
    label: String,
}

#[derive(Default)]
struct Slot {
    value: Option<Value>,
    known: bool,
}

pub struct App {
    project: Project,
    pages: Pages,
    mesh: Mesh,
    script: Script,
    runs: HashMap<u64, Running>,
    next_run: u64,
    node: String,
    sessions: HashMap<u32, Session>,
    values: HashMap<String, Slot>,
    changed: BTreeSet<String>,
    /// The values of the variables every screen shares.
    shared: HashMap<String, Value>,
    epoch: Option<u32>,
    health_at: Instant,
}

impl App {
    pub fn new(project: Project, pages: Pages, mesh: Mesh, script: Script, node: String) -> App {
        script.send(ToScript::Imports(project.imports.clone()));
        script.send(ToScript::Pages(pages.keys()));
        script.send(ToScript::Variables(project.variables.clone()));
        let shared: HashMap<String, Value> = project.variables.iter().filter(|v| v.per == Per::Hmi).map(|v| (v.name.clone(), v.start.clone())).collect();
        script.send(ToScript::Values(shared.iter().map(|(k, v)| (k.clone(), Some(v.clone()))).collect()));
        App {
            project,
            pages,
            mesh,
            script,
            runs: HashMap::new(),
            next_run: 0,
            node,
            sessions: HashMap::new(),
            values: HashMap::new(),
            changed: BTreeSet::new(),
            shared,
            epoch: None,
            health_at: Instant::now(),
        }
    }

    /// Runs until Ctrl C.
    pub async fn run(mut self, mut deliveries: UnboundedReceiver<Delivery>, mut inbound: UnboundedReceiver<Inbound>, mut heard: UnboundedReceiver<FromScript>) {
        let mut tick = tokio::time::interval(TICK);
        let shutdown = tokio::signal::ctrl_c();
        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                Some(d) = deliveries.recv() => self.deliver(d),
                Some(i) = inbound.recv() => self.inbound(i),
                Some(s) = heard.recv() => self.scripted(s),
                _ = tick.tick() => self.tick(),
                _ = &mut shutdown => break,
            }
        }
        for session in self.sessions.keys().copied().collect::<Vec<_>>() {
            self.end(session, "the HMI is closing");
        }
    }

    fn deliver(&mut self, d: Delivery) {
        let slot = self.values.entry(d.alias.clone()).or_default();
        slot.value = Some(d.value);
        slot.known = true;
        self.changed.insert(d.alias);
    }

    fn inbound(&mut self, i: Inbound) {
        match i {
            Inbound::Open { session, out } => {
                let vars: HashMap<String, Value> = self.project.variables.iter().filter(|v| v.per == Per::Screen).map(|v| (v.name.clone(), v.start.clone())).collect();
                self.script.send(ToScript::Screen { session, values: vars.iter().map(|(k, v)| (k.clone(), v.clone())).collect() });
                self.sessions.insert(session, Session { out, heard: Instant::now(), undo: Vec::new(), redo: Vec::new(), vars });
                info!("screen {session} connected");
                self.welcome(session);
            }
            Inbound::Message { session, msg } => {
                let Some(s) = self.sessions.get_mut(&session) else { return };
                s.heard = Instant::now();
                self.handle(session, msg);
            }
            Inbound::Close { session } => {
                if self.sessions.contains_key(&session) {
                    self.end(session, "closed");
                }
            }
        }
    }

    /// Everything a screen needs to draw, in one go.
    fn welcome(&mut self, session: u32) {
        let hello = ServerMsg::Hello {
            session,
            project: self.project.info.clone(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            node: self.node.clone(),
        };
        self.send(session, &hello);
        self.send(session, &ServerMsg::Imports { imports: self.project.imports.clone() });
        self.send(session, &ServerMsg::Pages { pages: self.pages.list.clone() });
        self.send(session, &ServerMsg::Mesh { entities: self.mesh.entities() });
        self.send(session, &ServerMsg::Variables { variables: self.project.variables.clone() });
        let mut values: Vec<ValueUpdate> = self.project.imports.iter().map(|i| self.update(&i.alias)).collect();
        let own = self.sessions.get(&session).map(|s| s.vars.clone()).unwrap_or_default();
        values.extend(self.shared.iter().chain(own.iter()).map(|(k, v)| known(k, v)));
        self.send(session, &ServerMsg::Values { values });
        self.send(session, &ServerMsg::Health { peers: self.mesh.peers() });
    }

    fn handle(&mut self, session: u32, msg: ClientMsg) {
        if let Err(text) = authorize(&Who { session }, &msg) {
            return self.refuse(session, text, None);
        }
        match msg {
            ClientMsg::Ping { t } => self.send(session, &ServerMsg::Pong { t }),
            ClientMsg::Import { import } => match self.project.import(import.clone()) {
                Ok(()) => {
                    info!("imported {} as {}", import.entity, import.alias);
                    self.mesh.attach(&import);
                    self.refresh_known();
                    self.script.send(ToScript::Imports(self.project.imports.clone()));
                    self.broadcast(&ServerMsg::Imports { imports: self.project.imports.clone() });
                }
                Err(text) => self.refuse(session, text, Some(import.alias)),
            },
            ClientMsg::Unimport { alias } => match self.project.unimport(&alias) {
                Ok(()) => {
                    info!("removed the import {alias}");
                    self.mesh.detach(&alias);
                    self.values.remove(&alias);
                    self.changed.remove(&alias);
                    self.script.send(ToScript::Imports(self.project.imports.clone()));
                    self.broadcast(&ServerMsg::Imports { imports: self.project.imports.clone() });
                }
                Err(text) => self.refuse(session, text, Some(alias)),
            },
            ClientMsg::ChangeImport { alias, import } => self.change_import(session, alias, import),
            ClientMsg::SetVariable { name, variable } => self.set_variable(session, name, variable),
            ClientMsg::Set { alias, path, value } => {
                if let Err(text) = self.set(Some(session), &alias, &path, value) {
                    self.refuse(session, text, Some(alias));
                }
            }
            ClientMsg::Edit { edit } => self.edit(session, edit, Step::Do),
            ClientMsg::Undo => {
                if let Some(edit) = self.sessions.get_mut(&session).and_then(|s| s.undo.pop()) {
                    self.edit(session, edit, Step::Undo);
                }
            }
            ClientMsg::Redo => {
                if let Some(edit) = self.sessions.get_mut(&session).and_then(|s| s.redo.pop()) {
                    self.edit(session, edit, Step::Redo);
                }
            }
            ClientMsg::Fire { page, id, event } => self.fire(session, page, id, event),
            ClientMsg::SetStart { page } => {
                if self.pages.get(&page).is_none() {
                    return self.refuse(session, format!("there is no page {page}"), None);
                }
                match self.project.set_start(page) {
                    Ok(()) => self.broadcast(&ServerMsg::Project { project: self.project.info.clone() }),
                    Err(text) => self.refuse(session, text, None),
                }
            }
        }
    }

    /// Adds, changes or removes a variable. A rename carries its values and every use of its
    /// name along, a new start or scope starts its values over.
    fn set_variable(&mut self, session: u32, name: String, to: Option<Variable>) {
        let old = self.project.variable(&name).cloned();
        if let Err(text) = self.project.set_variable(&name, to.clone()) {
            return self.refuse(session, text, None);
        }
        let mut kept_shared = self.shared.remove(&name);
        let mut kept_own: HashMap<u32, Value> = self.sessions.iter_mut().filter_map(|(id, s)| s.vars.remove(&name).map(|v| (*id, v))).collect();
        if old.as_ref().zip(to.as_ref()).is_none_or(|(o, n)| o.start != n.start || o.per != n.per) {
            kept_shared = None;
            kept_own.clear();
        }
        self.script.send(ToScript::Variables(self.project.variables.clone()));
        self.broadcast(&ServerMsg::Variables { variables: self.project.variables.clone() });
        let Some(v) = to else { return };
        if v.name != name {
            info!("renamed the variable {name} to {}", v.name);
            match self.pages.rename(&name, &v.name) {
                Ok(touched) if !touched.is_empty() => self.broadcast(&ServerMsg::Pages { pages: self.pages.list.clone() }),
                Ok(_) => {}
                Err(text) => self.refuse(session, text, None),
            }
        }
        match v.per {
            Per::Hmi => {
                let value = kept_shared.unwrap_or_else(|| v.start.clone());
                self.shared.insert(v.name.clone(), value.clone());
                self.script.send(ToScript::Values(vec![(v.name.clone(), Some(value.clone()))]));
                self.broadcast(&ServerMsg::Values { values: vec![known(&v.name, &value)] });
            }
            Per::Screen => {
                let ids: Vec<u32> = self.sessions.keys().copied().collect();
                for id in ids {
                    let value = kept_own.remove(&id).unwrap_or_else(|| v.start.clone());
                    if let Some(s) = self.sessions.get_mut(&id) {
                        s.vars.insert(v.name.clone(), value.clone());
                    }
                    self.script.send(ToScript::Screen { session: id, values: vec![(v.name.clone(), value.clone())] });
                    self.send(id, &ServerMsg::Values { values: vec![known(&v.name, &value)] });
                }
            }
        }
    }

    /// Renames an import or changes its intent. A rename moves its handle, its value and every
    /// use of the alias in pages and handlers.
    fn change_import(&mut self, session: u32, alias: String, import: Import) {
        if let Err(text) = self.project.change(&alias, import.clone()) {
            return self.refuse(session, text, Some(alias));
        }
        if import.alias != alias {
            info!("renamed the import {alias} to {}", import.alias);
            self.mesh.detach(&alias);
            self.mesh.attach(&import);
            if let Some(slot) = self.values.remove(&alias) {
                self.values.insert(import.alias.clone(), slot);
            }
            self.changed.remove(&alias);
            self.changed.insert(import.alias.clone());
            match self.pages.rename(&alias, &import.alias) {
                Ok(touched) if !touched.is_empty() => self.broadcast(&ServerMsg::Pages { pages: self.pages.list.clone() }),
                Ok(_) => {}
                Err(text) => self.refuse(session, text, None),
            }
        }
        self.refresh_known();
        self.script.send(ToScript::Imports(self.project.imports.clone()));
        self.broadcast(&ServerMsg::Imports { imports: self.project.imports.clone() });
    }

    /// Starts the element's handler for `event`, unless it is still running from before.
    fn fire(&mut self, session: u32, page: String, id: String, event: Event) {
        let Some(e) = self.pages.element(&page, &id) else { return };
        let Some(h) = e.handlers.iter().find(|h| h.event == event) else { return };
        if self.runs.values().any(|r| r.page == page && r.id == id && r.event == event) {
            return;
        }
        let label = format!("{} {}", e.props.get("name").unwrap_or(&id), event.word());
        let code = h.code.clone();
        self.next_run += 1;
        self.runs.insert(self.next_run, Running { session, page, id, event, label });
        self.script.send(ToScript::Run { run: self.next_run, session: Some(session), code });
    }

    /// What a run did: every write and call is logged with the screen that started it.
    fn scripted(&mut self, msg: FromScript) {
        match msg {
            FromScript::Write { run, alias, value } => {
                info!("{} sets {alias} to {value}", self.label(run));
                let session = self.runs.get(&run).map(|r| r.session);
                if let Err(text) = self.set(session, &alias, "", value) {
                    self.tell(run, Level::Fault, text);
                }
            }
            FromScript::Call { run, call, alias, request } => {
                info!("{} calls {alias} with {request}", self.label(run));
                match self.mesh.call(&alias, &request) {
                    Ok(answer) => {
                        let script = self.script.clone();
                        tokio::spawn(async move { script.send(ToScript::Answer { call, outcome: answer.await }) });
                    }
                    Err(message) => self.script.send(ToScript::Answer { call, outcome: Err(CallFailure { status: "no_provider".into(), message }) }),
                }
            }
            FromScript::Notify { run, text } => self.tell(run, Level::Info, text),
            FromScript::Log { run, text } => info!("{}: {text}", self.label(run)),
            FromScript::Open { run, page, replace } => match (self.pages.get(&page), self.runs.get(&run)) {
                (None, _) => self.tell(run, Level::Fault, format!("there is no page {page}")),
                (Some(_), Some(r)) => self.send(r.session, &ServerMsg::Open { page, replace }),
                (Some(_), None) => {}
            },
            FromScript::Close { run } => {
                if let Some(r) = self.runs.get(&run) {
                    self.send(r.session, &ServerMsg::Close);
                }
            }
            FromScript::Done { run, end } => {
                let text = match &end {
                    End::Ok => None,
                    End::Unknown(alias) => Some((Level::Warn, format!("stopped, since {alias} is unknown"))),
                    End::Fault(text) => Some((Level::Fault, text.clone())),
                };
                if let Some((level, text)) = text {
                    warn!("{}: {text}", self.label(run));
                    self.tell(run, level, text);
                }
                self.runs.remove(&run);
            }
        }
    }

    fn label(&self, run: u64) -> String {
        self.runs.get(&run).map_or_else(|| format!("run {run}"), |r| format!("screen {} {}", r.session, r.label))
    }

    /// Tells the screen that started a run, naming what said it.
    fn tell(&self, run: u64, level: Level, text: String) {
        if let Some(r) = self.runs.get(&run) {
            let text = if matches!(level, Level::Info) { text } else { format!("{}: {text}", r.label) };
            self.send(r.session, &ServerMsg::Notice { text, level });
        }
    }

    /// Applies an edit, saves what it touched and sends that to every screen. The screen
    /// that asked keeps its undo, and hears what it made, so it can select it.
    fn edit(&mut self, session: u32, edit: Edit, step: Step) {
        let applied = match self.pages.apply(edit) {
            Ok(applied) => applied,
            Err(text) => return self.refuse(session, text, None),
        };
        if let Some(s) = self.sessions.get_mut(&session) {
            match step {
                Step::Do => {
                    s.undo.push(applied.undo);
                    s.redo.clear();
                }
                Step::Undo => s.redo.push(applied.undo),
                Step::Redo => s.undo.push(applied.undo),
            }
            if s.undo.len() > UNDO_DEPTH {
                s.undo.remove(0);
            }
        }
        // a page added or removed changes the list, otherwise each page goes out alone
        let touched: Vec<_> = applied.pages.iter().map(|id| self.pages.get(id)).collect();
        if touched.iter().any(Option::is_none) || applied.pages.iter().any(|id| matches!(&applied.made, Some((p, m)) if p == id && m == id)) {
            self.broadcast(&ServerMsg::Pages { pages: self.pages.list.clone() });
        } else {
            for page in touched.into_iter().flatten() {
                self.broadcast(&ServerMsg::Page { page: page.clone() });
            }
        }
        if let Some((page, id)) = applied.made {
            self.send(session, &ServerMsg::Made { page, id });
        }
        self.script.send(ToScript::Pages(self.pages.keys()));
    }

    /// Writes a variable, the screen's own for one each screen has, or sets a variable import
    /// on the mesh.
    fn set(&mut self, session: Option<u32>, alias: &str, path: &str, value: Value) -> Result<(), String> {
        if let Some(per) = self.project.variable(alias).map(|v| v.per) {
            let held = match per {
                Per::Hmi => self.shared.get_mut(alias),
                Per::Screen => session.and_then(|s| self.sessions.get_mut(&s)).and_then(|s| s.vars.get_mut(alias)),
            };
            let held = held.ok_or_else(|| format!("{alias} is each screen's own, and this has no screen"))?;
            match path.is_empty() {
                true => *held = value,
                false => codec::put(held, path, value)?,
            }
            let now = held.clone();
            match (per, session) {
                (Per::Screen, Some(s)) => {
                    self.script.send(ToScript::Screen { session: s, values: vec![(alias.to_owned(), now.clone())] });
                    self.send(s, &ServerMsg::Values { values: vec![known(alias, &now)] });
                }
                _ => {
                    self.script.send(ToScript::Values(vec![(alias.to_owned(), Some(now.clone()))]));
                    self.broadcast(&ServerMsg::Values { values: vec![known(alias, &now)] });
                }
            }
            return Ok(());
        }
        let import = self.project.find(alias).ok_or_else(|| format!("{alias} is not an import"))?;
        if import.intent != Intent::Write {
            return Err(format!("{alias} is imported to read. Import it to write to change it."));
        }
        if import.kind != Kind::Variable {
            return Err(format!("{alias} is a {:?}, and only variables can be set for now", import.kind).to_lowercase());
        }
        let last = self.values.get(alias).and_then(|s| s.value.as_ref());
        self.mesh.set(alias, path, value, last)
    }

    fn tick(&mut self) {
        let epoch = self.mesh.epoch();
        if self.epoch != Some(epoch) {
            self.epoch = Some(epoch);
            for import in self.project.imports.clone() {
                self.mesh.attach(&import);
            }
            self.refresh_known();
            self.broadcast(&ServerMsg::Mesh { entities: self.mesh.entities() });
        }
        if !self.changed.is_empty() {
            let values: Vec<ValueUpdate> = std::mem::take(&mut self.changed).iter().map(|a| self.update(a)).collect();
            self.script.send(ToScript::Values(values.iter().map(|v| (v.alias.clone(), v.value.clone().filter(|_| v.known))).collect()));
            self.broadcast(&ServerMsg::Values { values });
        }
        if self.health_at.elapsed() >= HEALTH_EVERY {
            self.health_at = Instant::now();
            self.broadcast(&ServerMsg::Health { peers: self.mesh.peers() });
        }
        let lost: Vec<u32> = self.sessions.iter().filter(|(_, s)| s.heard.elapsed() > SILENCE).map(|(id, _)| *id).collect();
        for session in lost {
            self.end(session, "lost");
        }
    }

    /// A datapoint is known while its entity is live and, for one with a value, once that
    /// value arrived. The last value stays when it goes unknown.
    fn refresh_known(&mut self) {
        for import in &self.project.imports {
            let live = self.mesh.live(import);
            let slot = self.values.entry(import.alias.clone()).or_default();
            let watched = matches!(import.kind, Kind::Topic | Kind::Variable);
            let known = live && (!watched || slot.value.is_some());
            if slot.known != known {
                slot.known = known;
                self.changed.insert(import.alias.clone());
            }
        }
    }

    fn update(&self, alias: &str) -> ValueUpdate {
        let slot = self.values.get(alias);
        ValueUpdate {
            alias: alias.to_owned(),
            value: slot.and_then(|s| s.value.clone()),
            known: slot.is_some_and(|s| s.known),
        }
    }

    /// Ends a screen's session. Dropping its sender closes its socket. Holds and forces it
    /// started will be let go here once handlers exist.
    fn end(&mut self, session: u32, why: &str) {
        if self.sessions.remove(&session).is_some() {
            info!("screen {session} {why}");
            self.script.send(ToScript::Gone(session));
        }
    }

    fn refuse(&self, session: u32, text: String, alias: Option<String>) {
        warn!("screen {session}: {text}");
        self.send(session, &ServerMsg::Refused { text, alias });
    }

    fn send(&self, session: u32, msg: &ServerMsg) {
        if let Some(s) = self.sessions.get(&session) {
            let _ = s.out.send(encode(msg));
        }
    }

    fn broadcast(&self, msg: &ServerMsg) {
        if self.sessions.is_empty() {
            return;
        }
        let text = encode(msg);
        for s in self.sessions.values() {
            let _ = s.out.send(text.clone());
        }
    }
}

/// A variable's value as a screen gets it: always known.
fn known(name: &str, value: &Value) -> ValueUpdate {
    ValueUpdate { alias: name.to_owned(), value: Some(value.clone()), known: true }
}

fn encode(msg: &ServerMsg) -> Bytes {
    let mut out = Vec::new();
    ciborium::into_writer(msg, &mut out).expect("every server message encodes");
    out.into()
}

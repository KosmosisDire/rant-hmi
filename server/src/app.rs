//! The backend's one loop. It owns the project, the mesh and every screen's session, so
//! nothing is shared and nothing locks.

use std::cell::Cell;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use crate::value::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tracing::{info, warn};

use crate::authorize::{Who, authorize};
use crate::mesh::codec;
use crate::mesh::{Delivery, Mesh};
use crate::pages::logic::{Rule, When};
use crate::pages::{Edit, Pages};
use crate::project::{Computed, Import, Intent, Kind, Per, Project, Record, Variable};
use crate::protocol::{ClientMsg, Level, Sample, ServerMsg, ValueUpdate};
use crate::script::{CallFailure, End, FromScript, Script, ToScript};
use crate::video::{FromVideo, ToVideo};

/// How often changed values go out and the mesh is checked.
const TICK: Duration = Duration::from_millis(33);
/// How long the project's files stay still after a change before the HMI reads them.
const QUIET: Duration = Duration::from_millis(150);
/// A screen silent this long lets go of what it holds, so a jog never outlives its link.
const SILENCE: Duration = Duration::from_millis(500);
/// A screen silent this long is lost. A busy page stops reading its socket a while, which
/// is no reason to start it over.
const LOST: Duration = Duration::from_secs(5);
/// A screen this many bytes behind gets no values until it catches up, then all at once, so
/// a slow link carries a camera at the rate it can and nothing piles up.
const BEHIND: usize = 1 << 20;
/// How many edits a screen can undo.
const UNDO_DEPTH: usize = 200;
const HEALTH_EVERY: Duration = Duration::from_secs(1);
/// Events a second of, while the first still runs, is ignored. Any other is a stream, such as a
/// drag or a joystick's move, whose latest must land, so it waits for the run.
const ONCE: [&str; 5] = ["tap", "press", "release", "hold", "outside"];

/// What a screen's connection hands the loop.
pub enum Inbound {
    /// `local` is the address the screen reached the HMI on.
    Open { session: u32, out: Outbox, local: IpAddr },
    Message { session: u32, msg: ClientMsg },
    /// The screen answered the socket's ping.
    Heard { session: u32 },
    Close { session: u32 },
}

/// A screen's way out. `queued` counts the bytes its socket has not taken yet, which the
/// socket's writer takes off as it sends.
pub struct Outbox {
    tx: UnboundedSender<Bytes>,
    queued: Arc<AtomicUsize>,
    /// Values were left out while the screen was behind, so it needs them all.
    stale: Cell<bool>,
}

impl Outbox {
    pub fn new(tx: UnboundedSender<Bytes>, queued: Arc<AtomicUsize>) -> Outbox {
        Outbox { tx, queued, stale: Cell::new(false) }
    }

    /// Sends, but leaves values out while the screen is behind, since newer ones replace them.
    fn put(&self, bytes: Bytes, values: bool) {
        if values && self.queued.load(Ordering::Relaxed) > BEHIND {
            self.stale.set(true);
            return;
        }
        self.queued.fetch_add(bytes.len(), Ordering::Relaxed);
        let _ = self.tx.send(bytes);
    }

    /// True once a screen that missed values has caught up, and then only once.
    fn caught_up(&self) -> bool {
        let caught = self.stale.get() && self.queued.load(Ordering::Relaxed) < BEHIND / 2;
        if caught {
            self.stale.set(false);
        }
        caught
    }
}

struct Session {
    out: Outbox,
    local: IpAddr,
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

/// A run going on: the screen that started it, none for a rule's, what it belongs to, and
/// what the log calls it.
struct Running {
    session: Option<u32>,
    page: String,
    id: String,
    /// The copy of a repeated element it runs for.
    index: Option<u32>,
    event: String,
    label: String,
}

/// An element a screen holds pressed: the screen, page, element and copy of a repeat.
type Pressed = (u32, String, String, Option<u32>);

/// An element's handler for an event: page, element, copy of a repeat and event.
type HandlerKey = (String, String, Option<u32>, String);

/// A rule's condition: true since when, and whether it has fired since it turned true.
#[derive(Default)]
struct Turned {
    since: Option<Instant>,
    fired: bool,
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
    video: UnboundedSender<ToVideo>,
    /// The screens playing each import's video.
    playing: HashMap<String, HashSet<u32>>,
    runs: HashMap<u64, Running>,
    next_run: u64,
    /// Pages opened to wait for an answer: the waiting call, and the screen that shows them.
    asks: HashMap<u64, u32>,
    /// Elements a screen holds pressed, as screen, page, element and the copy of a repeat.
    pressed: HashSet<Pressed>,
    /// The latest stream event that came while its handler still ran, with its screen, what it
    /// brought and its copy. It runs when that run ends.
    waiting: HashMap<HandlerKey, (u32, Value, Option<(u32, Value)>)>,
    /// When each timer rule is next due.
    timers: HashMap<String, Instant>,
    turned: HashMap<String, Turned>,
    /// Values that changed since the last tick, with what they were before.
    moved: Vec<(String, Option<Value>, Value)>,
    node: String,
    /// The client script the backend serves.
    build: String,
    sessions: HashMap<u32, Session>,
    values: HashMap<String, Slot>,
    changed: BTreeSet<String>,
    /// The values of the variables every screen shares.
    shared: HashMap<String, Value>,
    /// Each record's samples, oldest first, and when it next samples.
    history: HashMap<String, VecDeque<Sample>>,
    sample_at: HashMap<String, Instant>,
    epoch: Option<u32>,
    health_at: Instant,
    /// When a project file last changed outside the HMI, until it is read.
    edited: Option<Instant>,
}

impl App {
    pub fn new(project: Project, pages: Pages, mesh: Mesh, script: Script, video: UnboundedSender<ToVideo>, node: String, build: String) -> App {
        script.send(ToScript::Imports(project.imports.clone()));
        script.send(ToScript::Pages(pages.keys()));
        script.send(ToScript::Variables(project.variables.clone()));
        let shared: HashMap<String, Value> = project.variables.iter().filter(|v| v.per == Per::Hmi).map(|v| (v.name.clone(), v.start.clone())).collect();
        script.send(ToScript::Values(shared.iter().map(|(k, v)| (k.clone(), Some(v.clone()))).collect()));
        script.send(ToScript::Records(sources(&project.records)));
        script.send(ToScript::Computed(project.computed.clone()));
        App {
            project,
            pages,
            mesh,
            script,
            video,
            playing: HashMap::new(),
            runs: HashMap::new(),
            next_run: 0,
            asks: HashMap::new(),
            pressed: HashSet::new(),
            waiting: HashMap::new(),
            timers: HashMap::new(),
            turned: HashMap::new(),
            moved: Vec::new(),
            node,
            build,
            sessions: HashMap::new(),
            values: HashMap::new(),
            changed: BTreeSet::new(),
            shared,
            history: HashMap::new(),
            sample_at: HashMap::new(),
            epoch: None,
            health_at: Instant::now(),
            edited: None,
        }
    }

    /// Runs until Ctrl C.
    pub async fn run(
        mut self,
        mut deliveries: UnboundedReceiver<Delivery>,
        mut inbound: UnboundedReceiver<Inbound>,
        mut heard: UnboundedReceiver<FromScript>,
        mut changed: UnboundedReceiver<()>,
        mut answered: UnboundedReceiver<FromVideo>,
    ) {
        let mut tick = tokio::time::interval(TICK);
        self.rules_changed();
        self.run_rules(|r| matches!(r.when, When::Starts), Value::Null);
        let shutdown = tokio::signal::ctrl_c();
        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                Some(d) = deliveries.recv() => self.deliver(d),
                Some(i) = inbound.recv() => self.inbound(i),
                Some(s) = heard.recv() => self.scripted(s),
                Some(()) = changed.recv() => self.edited = Some(Instant::now()),
                Some(v) = answered.recv() => self.answered(v),
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
        let previous = slot.value.replace(d.value.clone());
        self.moved.push((d.alias.clone(), previous, d.value));
        slot.known = true;
        self.changed.insert(d.alias);
    }

    fn inbound(&mut self, i: Inbound) {
        match i {
            Inbound::Open { session, out, local } => {
                let vars: HashMap<String, Value> = self.project.variables.iter().filter(|v| v.per == Per::Screen).map(|v| (v.name.clone(), v.start.clone())).collect();
                self.script.send(ToScript::Screen { session, values: vars.iter().map(|(k, v)| (k.clone(), v.clone())).collect() });
                self.sessions.insert(session, Session { out, local, heard: Instant::now(), undo: Vec::new(), redo: Vec::new(), vars });
                info!("screen {session} connected");
                self.welcome(session);
                self.run_rules(|r| matches!(r.when, When::Connects), Value::map([("screen", session.into())]));
            }
            Inbound::Message { session, msg } => {
                let Some(s) = self.sessions.get_mut(&session) else { return };
                s.heard = Instant::now();
                self.handle(session, msg);
            }
            Inbound::Heard { session } => {
                if let Some(s) = self.sessions.get_mut(&session) {
                    s.heard = Instant::now();
                }
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
            build: self.build.clone(),
        };
        self.send(session, &hello);
        self.send(session, &ServerMsg::Imports { imports: self.project.imports.clone() });
        self.send(session, &ServerMsg::Pages { pages: self.pages.list.clone() });
        self.send(session, &ServerMsg::Mesh { entities: self.mesh.entities() });
        self.send(session, &ServerMsg::Variables { variables: self.project.variables.clone() });
        self.send(session, &ServerMsg::Records { records: self.project.records.clone() });
        self.send(session, &ServerMsg::Computed { computed: self.project.computed.clone() });
        for r in &self.project.records {
            let samples = self.history.get(&r.name).map(|h| h.iter().cloned().collect()).unwrap_or_default();
            self.send(session, &ServerMsg::Samples { name: r.name.clone(), samples, whole: true });
        }
        self.send(session, &ServerMsg::Rules { rules: self.pages.rules.clone() });
        self.send(session, &ServerMsg::Theme { tokens: self.project.tokens.clone() });
        self.send(session, &ServerMsg::Values { values: self.all_values(session) });
        self.send(session, &ServerMsg::Health { peers: self.mesh.peers() });
    }

    /// Every value a screen shows: the imports', the computed ones', the shared variables' and
    /// its own.
    fn all_values(&self, session: u32) -> Vec<ValueUpdate> {
        let names = self.project.imports.iter().map(|i| &i.alias).chain(self.project.computed.iter().map(|c| &c.name));
        let mut values: Vec<ValueUpdate> = names.map(|name| self.update(name)).collect();
        if let Some(s) = self.sessions.get(&session) {
            values.extend(self.shared.iter().chain(s.vars.iter()).map(|(k, v)| known(k, v)));
        }
        values
    }

    fn handle(&mut self, session: u32, msg: ClientMsg) {
        if let Err(text) = authorize(&Who { session }, &msg) {
            return self.refuse(session, text, None);
        }
        match msg {
            ClientMsg::Ping { t } => self.send(session, &ServerMsg::Pong { t }),
            ClientMsg::Play { alias, offer } => {
                let Some(import) = self.project.find(&alias).cloned() else {
                    return self.refuse(session, format!("{alias} is not a mesh import, so it has no video"), None);
                };
                let Some(local) = self.sessions.get(&session).map(|s| s.local) else { return };
                self.playing.entry(alias.clone()).or_default().insert(session);
                self.mesh.play(&import);
                let _ = self.video.send(ToVideo::Offer { session, alias, sdp: offer, local });
            }
            ClientMsg::StopPlaying { alias } => self.stop_playing(session, &alias),
            ClientMsg::Import { import } => match self.project.import(import.clone()) {
                Ok(()) => {
                    info!("imported {} as {}", import.entity, import.alias);
                    self.mesh.attach(&import);
                    self.imports_changed();
                }
                Err(text) => self.refuse(session, text, Some(import.alias)),
            },
            ClientMsg::Unimport { alias } => match self.project.unimport(&alias) {
                Ok(()) => {
                    info!("removed the import {alias}");
                    self.mesh.detach(&alias);
                    self.values.remove(&alias);
                    self.changed.remove(&alias);
                    self.imports_changed();
                }
                Err(text) => self.refuse(session, text, Some(alias)),
            },
            ClientMsg::ChangeImport { alias, import } => self.change_import(session, alias, import),
            ClientMsg::SetVariable { name, variable } => self.set_variable(session, name, variable),
            ClientMsg::SetRecord { name, record } => self.set_record(session, name, record),
            ClientMsg::SetComputed { name, computed } => self.set_computed(session, name, computed),
            ClientMsg::SetToken { name, token } => {
                let renamed = token.as_ref().filter(|t| t.name != name).map(|t| t.name.clone());
                if let Err(text) = self.project.set_token(&name, token) {
                    self.send(session, &ServerMsg::Theme { tokens: self.project.tokens.clone() });
                    return self.refuse(session, text, None);
                }
                self.broadcast(&ServerMsg::Theme { tokens: self.project.tokens.clone() });
                if let Some(to) = renamed {
                    self.follow_rename(session, &format!("${name}"), &format!("${to}"), true);
                }
            }
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
            ClientMsg::Fire { page, id, event, payload, index, item } => {
                let key = (session, page.clone(), id.clone(), index);
                match event.as_str() {
                    "press" => self.pressed.insert(key),
                    "release" => self.pressed.remove(&key),
                    _ => false,
                };
                self.fire(session, page, id, event, payload, index.map(|i| (i, item.unwrap_or(Value::Null))));
            }
            ClientMsg::Answer { ask, value } => {
                if self.asks.get(&ask) == Some(&session) {
                    self.asks.remove(&ask);
                    self.script.send(ToScript::Answer { call: ask, outcome: Ok(value) });
                }
            }
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
            self.send(session, &ServerMsg::Variables { variables: self.project.variables.clone() });
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
            self.follow_rename(session, &name, &v.name, false);
        }
        self.start_variable(&v, kept_shared, kept_own);
    }

    /// Adds, changes or removes a record. A rename carries its history and every use of its
    /// name along, a new source starts the history over.
    fn set_record(&mut self, session: u32, name: String, to: Option<Record>) {
        let old = self.project.record(&name).cloned();
        if let Err(text) = self.project.set_record(&name, to.clone()) {
            self.send(session, &ServerMsg::Records { records: self.project.records.clone() });
            return self.refuse(session, text, None);
        }
        let kept = self.history.remove(&name).filter(|_| old.as_ref().zip(to.as_ref()).is_some_and(|(o, n)| o.source == n.source));
        self.sample_at.remove(&name);
        self.records_changed();
        let Some(r) = to else { return };
        if r.name != name {
            info!("renamed the record {name} to {}", r.name);
            self.follow_rename(session, &name, &r.name, false);
        }
        let samples: VecDeque<Sample> = kept.unwrap_or_default();
        self.broadcast(&ServerMsg::Samples { name: r.name.clone(), samples: samples.iter().cloned().collect(), whole: true });
        self.history.insert(r.name, samples);
    }

    fn set_computed(&mut self, session: u32, name: String, to: Option<Computed>) {
        if let Err(text) = self.project.set_computed(&name, to.clone()) {
            self.send(session, &ServerMsg::Computed { computed: self.project.computed.clone() });
            return self.refuse(session, text, None);
        }
        // a name no longer worked out reads as unknown on every screen
        if to.as_ref().is_none_or(|c| c.name != name) {
            self.values.remove(&name);
            self.changed.insert(name.clone());
        }
        if let Some(c) = to.as_ref().filter(|c| c.name != name) {
            info!("renamed the computed value {name} to {}", c.name);
            self.follow_rename(session, &name, &c.name, false);
        }
        self.computed_changed();
        // worked out first, so the trial starts from what it reads now
        if let Some(c) = to.filter(|c| c.set.is_some()) {
            self.script.send(ToScript::Try { session, name: c.name });
        }
    }

    /// Asks the engine to judge the conditions and work the computed values out anew, by the
    /// values it has now.
    fn rethink(&self) {
        self.script.send(ToScript::Judge);
        if !self.project.computed.is_empty() {
            self.script.send(ToScript::Compute);
        }
    }

    /// Tells the engine and every screen the computed values, whole, and works them out anew.
    fn computed_changed(&mut self) {
        self.script.send(ToScript::Computed(self.project.computed.clone()));
        self.script.send(ToScript::Compute);
        self.broadcast(&ServerMsg::Computed { computed: self.project.computed.clone() });
    }

    /// Takes what the engine worked out as values, which go out as any value does.
    fn computed(&mut self, list: Vec<(String, Option<Value>)>) {
        for (name, value) in list {
            let slot = self.values.entry(name.clone()).or_default();
            if slot.value == value && slot.known == value.is_some() {
                continue;
            }
            let previous = std::mem::replace(&mut slot.value, value.clone());
            slot.known = value.is_some();
            if let Some(v) = value {
                self.moved.push((name.clone(), previous, v));
            }
            self.changed.insert(name);
        }
    }

    /// Tells the engine and every screen the records, whole.
    fn records_changed(&mut self) {
        self.script.send(ToScript::Records(sources(&self.project.records)));
        self.broadcast(&ServerMsg::Records { records: self.project.records.clone() });
    }

    /// Asks the engine for each record that is due, and keeps when it is due next.
    fn sample(&mut self) {
        let now = Instant::now();
        let mut due = Vec::new();
        for r in &self.project.records {
            let at = self.sample_at.entry(r.name.clone()).or_insert(now);
            if *at <= now {
                // one that fell behind starts again from now, rather than catching up
                let every = Duration::from_millis(r.every_ms.into());
                *at = if now.duration_since(*at) > every { now + every } else { *at + every };
                due.push(r.name.clone());
            }
        }
        if !due.is_empty() {
            self.script.send(ToScript::Sample(due));
        }
    }

    /// Keeps what the engine read for each record, drops samples past its keep, and sends the
    /// new ones to every screen.
    fn sampled(&mut self, read: Vec<(String, Option<Value>)>) {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
        for (name, value) in read {
            let (Some(v), Some(r)) = (value, self.project.record(&name)) else { continue };
            let keep = f64::from(r.keep_s) * 1000.0;
            let history = self.history.entry(name.clone()).or_default();
            let sample = Sample { t, v };
            history.push_back(sample.clone());
            while history.front().is_some_and(|s| s.t < t - keep) {
                history.pop_front();
            }
            self.broadcast(&ServerMsg::Samples { name, samples: vec![sample], whole: false });
        }
    }

    /// Gives a variable its values: those kept, else its start.
    fn start_variable(&mut self, v: &Variable, kept_shared: Option<Value>, mut kept_own: HashMap<u32, Value>) {
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
            self.send(session, &ServerMsg::Imports { imports: self.project.imports.clone() });
            return self.refuse(session, text, Some(alias));
        }
        if import.alias != alias {
            info!("renamed the import {alias} to {}", import.alias);
            self.mesh.detach(&alias);
            if let Some(slot) = self.values.remove(&alias) {
                self.values.insert(import.alias.clone(), slot);
            }
            self.changed.remove(&alias);
            self.changed.insert(import.alias.clone());
            self.follow_rename(session, &alias, &import.alias, false);
        }
        self.mesh.attach(&import);
        self.imports_changed();
    }

    /// Tells the engine and every screen the imports, after they changed.
    fn imports_changed(&mut self) {
        self.refresh_known();
        self.script.send(ToScript::Imports(self.project.imports.clone()));
        self.broadcast(&ServerMsg::Imports { imports: self.project.imports.clone() });
    }

    /// Writes every use of `from` as `to` in the pages, components too where they read it,
    /// and sends the pages out when any changed.
    fn follow_rename(&mut self, session: u32, from: &str, to: &str, components: bool) {
        match self.pages.rename(from, to, components) {
            Ok(touched) if !touched.is_empty() => self.broadcast(&ServerMsg::Pages { pages: self.pages.list.clone() }),
            Ok(_) => {}
            Err(text) => self.refuse(session, text, None),
        }
    }

    /// Starts the element's handler for `event`, unless it is still running from before.
    /// Runs an element's handler for `event`, unless it still runs from before. `at` is the
    /// copy of a repeat it happened on, its index and item.
    fn fire(&mut self, session: u32, page: String, id: String, event: String, payload: Value, at: Option<(u32, Value)>) {
        let Some(e) = self.pages.element(&page, &id) else { return };
        let Some(h) = e.handlers.iter().find(|h| h.event == event) else { return };
        let index = at.as_ref().map(|(i, _)| *i);
        if self.runs.values().any(|r| r.page == page && r.id == id && r.index == index && r.event == event) {
            if !ONCE.contains(&event.as_str()) {
                self.waiting.insert((page, id, index, event), (session, payload, at));
            }
            return;
        }
        let label = format!("{} {event}", e.props.get("name").unwrap_or(&id));
        let code = h.code.clone();
        self.next_run += 1;
        self.runs.insert(self.next_run, Running { session: Some(session), page, id, index, event, label });
        self.script.send(ToScript::Run { run: self.next_run, session: Some(session), code, p: payload, at });
    }

    /// Runs each rule that `fits`, unless it still runs from before.
    fn run_rules(&mut self, fits: impl Fn(&Rule) -> bool, p: Value) {
        let due: Vec<Rule> = self.pages.rules.iter().filter(|r| fits(r)).cloned().collect();
        for rule in due {
            if self.runs.values().any(|r| r.session.is_none() && r.id == rule.id) {
                continue;
            }
            self.next_run += 1;
            self.runs.insert(self.next_run, Running { session: None, page: String::new(), id: rule.id, index: None, event: "rule".into(), label: rule.name });
            self.script.send(ToScript::Run { run: self.next_run, session: None, code: rule.code, p: p.clone(), at: None });
        }
    }

    /// Hands the conditions to the engine and keeps each timer's next time.
    fn rules_changed(&mut self) {
        let conditions = self.pages.rules.iter().filter_map(|r| match &r.when {
            When::Turns { condition, .. } => Some((r.id.clone(), condition.clone())),
            _ => None,
        });
        self.script.send(ToScript::Conditions(conditions.collect()));
        let now = Instant::now();
        let every: HashMap<String, u32> = self.pages.rules.iter().filter_map(|r| if let When::Every { ms } = r.when { Some((r.id.clone(), ms)) } else { None }).collect();
        self.timers.retain(|id, _| every.contains_key(id));
        for (id, ms) in every {
            self.timers.entry(id).or_insert(now + Duration::from_millis(ms.into()));
        }
        let rules = &self.pages.rules;
        self.turned.retain(|id, _| rules.iter().any(|r| &r.id == id));
        self.script.send(ToScript::Judge);
    }

    /// Notes when each condition turned true or false.
    fn judged(&mut self, truths: Vec<(String, bool)>) {
        let now = Instant::now();
        for (id, truth) in truths {
            let t = self.turned.entry(id).or_default();
            match (truth, t.since) {
                (true, None) => t.since = Some(now),
                (false, _) => *t = Turned::default(),
                _ => {}
            }
        }
        self.fire_turned();
    }

    /// Fires each rule whose condition has held true long enough, once until it turns false.
    fn fire_turned(&mut self) {
        let now = Instant::now();
        let held = |r: &Rule, t: Option<&Turned>| match (&r.when, t) {
            (When::Turns { ms, .. }, Some(t)) => !t.fired && t.since.is_some_and(|s| now.duration_since(s) >= Duration::from_millis((*ms).into())),
            _ => false,
        };
        let ready: Vec<String> = self.pages.rules.iter().filter(|r| held(r, self.turned.get(&r.id))).map(|r| r.id.clone()).collect();
        for id in ready {
            if let Some(t) = self.turned.get_mut(&id) {
                t.fired = true;
            }
            self.run_rules(|r| r.id == id, Value::Null);
        }
    }

    /// What a run did: every write and call is logged with the screen that started it.
    fn scripted(&mut self, msg: FromScript) {
        match msg {
            FromScript::Write { run, alias, value } => {
                info!("{} sets {alias} to {value}", self.label(run));
                let session = self.runs.get(&run).and_then(|r| r.session);
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
            FromScript::Send { run, alias, value } => {
                info!("{} sends {value} on {alias}", self.label(run));
                if let Err(text) = self.mesh.send(&alias, &value) {
                    self.tell(run, Level::Fault, text);
                }
            }
            FromScript::Notify { run, text } => self.tell(run, Level::Info, text),
            FromScript::Log { run, text } => info!("{}: {text}", self.label(run)),
            FromScript::Open { run, page, replace, call } => match (self.pages.get(&page), self.runs.get(&run).and_then(|r| r.session)) {
                (Some(_), Some(session)) => {
                    self.asks.insert(call, session);
                    self.send(session, &ServerMsg::Open { page, replace, ask: call });
                }
                (found, _) => {
                    let message = if found.is_none() { format!("there is no page {page}") } else { "open works in an element's handler, which has a screen".into() };
                    self.script.send(ToScript::Answer { call, outcome: Err(CallFailure { status: "no_page".into(), message }) });
                }
            },
            FromScript::Close { run, answer } => {
                if let Some(session) = self.runs.get(&run).and_then(|r| r.session) {
                    self.send(session, &ServerMsg::Close { answer });
                }
            }
            FromScript::Judged(truths) => self.judged(truths),
            FromScript::Computed(list) => self.computed(list),
            FromScript::Tried { session, warning } => self.send(session, &ServerMsg::Notice { text: warning, level: Level::Warn }),
            FromScript::Inverted { session, name, target, value } => {
                let done = value.and_then(|v| {
                    info!("{name} sets {target} to {v}");
                    self.set(session, &target, "", v)
                });
                match (done, session) {
                    (Err(text), Some(s)) => self.refuse(s, text, Some(name)),
                    (Err(text), None) => warn!("{text}"),
                    _ => {}
                }
            }
            FromScript::Sampled(read) => self.sampled(read),
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
                // what waited for this run goes now, if its screen is still here
                let Some(r) = self.runs.remove(&run) else { return };
                if let Some((session, payload, at)) = self.waiting.remove(&(r.page.clone(), r.id.clone(), r.index, r.event.clone())) {
                    if self.sessions.contains_key(&session) {
                        self.fire(session, r.page, r.id, r.event, payload, at);
                    }
                }
            }
        }
    }

    fn label(&self, run: u64) -> String {
        match self.runs.get(&run) {
            Some(Running { session: Some(s), label, .. }) => format!("screen {s} {label}"),
            Some(Running { label, .. }) => format!("handler {label}"),
            None => format!("run {run}"),
        }
    }

    /// Tells the screen that started a run, naming what said it. A rule's run has no screen,
    /// so every screen hears it.
    fn tell(&self, run: u64, level: Level, text: String) {
        let Some(r) = self.runs.get(&run) else { return };
        let text = if matches!(level, Level::Info) { text } else { format!("{}: {text}", r.label) };
        match r.session {
            Some(session) => self.send(session, &ServerMsg::Notice { text, level }),
            None => self.broadcast(&ServerMsg::Notice { text, level }),
        }
    }

    /// Applies an edit, saves what it touched and sends that to every screen. The screen
    /// that asked keeps its undo, and hears what it made, so it can select it.
    fn edit(&mut self, session: u32, edit: Edit, step: Step) {
        let rules = matches!(edit, Edit::SetRule { .. });
        let shown = match &edit {
            Edit::SetInput { page, .. }
            | Edit::SetEvent { page, .. }
            | Edit::ResizePage { page, .. }
            | Edit::SetFill { page, .. }
            | Edit::SetProps { page, .. } => Some(page.clone()),
            _ => None,
        };
        let applied = match self.pages.apply(edit) {
            Ok(applied) => applied,
            Err(text) => {
                // a screen shows these changes at once, so a refused one is set right
                if rules {
                    self.send(session, &ServerMsg::Rules { rules: self.pages.rules.clone() });
                }
                if let Some(page) = shown.and_then(|id| self.pages.get(&id).cloned()) {
                    self.send(session, &ServerMsg::Page { page });
                }
                return self.refuse(session, text, None);
            }
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
        if applied.rules {
            self.broadcast(&ServerMsg::Rules { rules: self.pages.rules.clone() });
            self.rules_changed();
        }
        self.script.send(ToScript::Pages(self.pages.keys()));
    }

    /// Writes a variable, the screen's own for one each screen has, or sets a variable import
    /// on the mesh.
    fn set(&mut self, session: Option<u32>, alias: &str, path: &str, value: Value) -> Result<(), String> {
        // a computed value's setter works out what its target takes, then that is set
        if let Some(c) = self.project.computed(alias) {
            if c.set.is_none() {
                return Err(format!("{alias} is worked out from other values, and has no setter to write it"));
            }
            if !path.is_empty() {
                return Err(format!("{alias} is worked out whole, so it is set whole"));
            }
            self.script.send(ToScript::Invert { session, name: alias.to_owned(), v: value });
            return Ok(());
        }
        if let Some(per) = self.project.variable(alias).map(|v| v.per) {
            let held = match per {
                Per::Hmi => self.shared.get_mut(alias),
                Per::Screen => session.and_then(|s| self.sessions.get_mut(&s)).and_then(|s| s.vars.get_mut(alias)),
            };
            let held = held.ok_or_else(|| format!("{alias} is each screen's own, and this has no screen"))?;
            let before = held.clone();
            match path.is_empty() {
                true => *held = value,
                false => codec::put(held, path, value)?,
            }
            let now = held.clone();
            self.moved.push((alias.to_owned(), Some(before), now.clone()));
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
            return Err(format!("{alias} is not a variable, so it cannot be set"));
        }
        let last = self.values.get(alias).and_then(|s| s.value.as_ref());
        self.mesh.set(alias, path, value, last)
    }

    /// Takes in the project as its files say now, after a change made outside the HMI. A file
    /// with a mistake leaves everything as it was, and every screen hears why.
    fn reload(&mut self) {
        let root = self.project.root().to_path_buf();
        let (project, pages) = match Project::open(&root).and_then(|p| Pages::open(&root).map(|q| (p, q))) {
            Ok(both) => both,
            Err(e) => {
                warn!("{e:#}");
                let text = format!("{e:#}. The HMI keeps what it had.");
                return self.broadcast(&ServerMsg::Notice { text, level: Level::Warn });
            }
        };
        let old = std::mem::replace(&mut self.project, project);
        if old.info != self.project.info {
            self.broadcast(&ServerMsg::Project { project: self.project.info.clone() });
        }
        if old.imports != self.project.imports {
            for gone in old.imports.iter().filter(|i| !self.project.imports.contains(i)) {
                self.mesh.detach(&gone.alias);
                if !self.project.imports.iter().any(|i| i.alias == gone.alias) {
                    self.values.remove(&gone.alias);
                    self.changed.remove(&gone.alias);
                }
            }
            for import in self.project.imports.clone() {
                self.mesh.attach(&import);
            }
            self.imports_changed();
        }
        if old.variables != self.project.variables {
            for v in old.variables.iter().filter(|v| !self.project.variables.contains(v)) {
                self.shared.remove(&v.name);
                self.sessions.values_mut().for_each(|s| drop(s.vars.remove(&v.name)));
            }
            self.script.send(ToScript::Variables(self.project.variables.clone()));
            self.broadcast(&ServerMsg::Variables { variables: self.project.variables.clone() });
            for v in self.project.variables.clone().iter().filter(|v| !old.variables.contains(v)) {
                self.start_variable(v, None, HashMap::new());
            }
        }
        if old.records != self.project.records {
            for r in old.records.iter().filter(|r| !self.project.records.contains(r)) {
                self.history.remove(&r.name);
                self.sample_at.remove(&r.name);
            }
            self.records_changed();
            for r in self.project.records.iter().filter(|r| !old.records.contains(r)) {
                self.broadcast(&ServerMsg::Samples { name: r.name.clone(), samples: Vec::new(), whole: true });
            }
        }
        if old.computed != self.project.computed {
            for c in old.computed.iter().filter(|c| self.project.computed(&c.name).is_none()) {
                self.values.remove(&c.name);
                self.changed.insert(c.name.clone());
            }
            self.computed_changed();
        }
        if old.tokens != self.project.tokens {
            self.broadcast(&ServerMsg::Theme { tokens: self.project.tokens.clone() });
        }
        let (pages_moved, rules_moved) = (pages.list != self.pages.list, pages.rules != self.pages.rules);
        if pages_moved || rules_moved {
            self.pages = pages;
            // what a screen could undo no longer matches the files
            self.sessions.values_mut().for_each(|s| {
                s.undo.clear();
                s.redo.clear();
            });
        }
        if pages_moved {
            self.script.send(ToScript::Pages(self.pages.keys()));
            self.broadcast(&ServerMsg::Pages { pages: self.pages.list.clone() });
        }
        if rules_moved {
            self.broadcast(&ServerMsg::Rules { rules: self.pages.rules.clone() });
            self.rules_changed();
        }
    }

    fn tick(&mut self) {
        if self.edited.is_some_and(|t| t.elapsed() >= QUIET) {
            self.edited = None;
            self.reload();
        }
        let epoch = self.mesh.epoch();
        if self.epoch != Some(epoch) {
            self.epoch = Some(epoch);
            for import in self.project.imports.clone() {
                self.mesh.attach(&import);
            }
            self.refresh_known();
            // a camera's Video child can come or go, which changes where its video comes from
            for alias in self.playing.keys().cloned().collect::<Vec<_>>() {
                if let Some(import) = self.project.find(&alias).cloned() {
                    self.mesh.play(&import);
                }
            }
            self.broadcast(&ServerMsg::Mesh { entities: self.mesh.entities() });
        }
        let now = Instant::now();
        let due: Vec<String> = self.timers.iter().filter(|(_, at)| **at <= now).map(|(id, _)| id.clone()).collect();
        for id in due {
            if let Some(When::Every { ms }) = self.pages.rules.iter().find(|r| r.id == id).map(|r| r.when.clone()) {
                self.timers.insert(id.clone(), now + Duration::from_millis(ms.into()));
            }
            self.run_rules(|r| r.id == id, Value::Null);
        }
        if !self.changed.is_empty() {
            let values: Vec<ValueUpdate> = std::mem::take(&mut self.changed).iter().map(|a| self.update(a)).collect();
            self.script.send(ToScript::Values(values.iter().map(|v| (v.alias.clone(), v.value.clone().filter(|_| v.known))).collect()));
            self.broadcast(&ServerMsg::Values { values });
            // the engine has the new values before it judges by them
            self.rethink();
        }
        // a change runs the rules that wait on it, and a variable's asks the conditions anew,
        // its value already with the engine
        let moved = std::mem::take(&mut self.moved);
        for (name, previous, value) in &moved {
            let p = Value::map([("value", value.clone()), ("previous", previous.clone().unwrap_or_default())]);
            self.run_rules(|r| matches!(&r.when, When::Changes { name: n } if n == name), p);
        }
        if moved.iter().any(|(name, _, _)| self.project.variable(name).is_some()) {
            self.rethink();
        }
        self.fire_turned();
        self.sample();
        if self.health_at.elapsed() >= HEALTH_EVERY {
            self.health_at = Instant::now();
            self.broadcast(&ServerMsg::Health { peers: self.mesh.peers() });
        }
        let caught: Vec<u32> = self.sessions.iter().filter(|(_, s)| s.out.caught_up()).map(|(id, _)| *id).collect();
        for session in caught {
            self.send(session, &ServerMsg::Values { values: self.all_values(session) });
        }
        let silent: Vec<(u32, Duration)> = self.sessions.iter().map(|(id, s)| (*id, s.heard.elapsed())).filter(|(_, t)| *t > SILENCE).collect();
        for (session, silence) in silent {
            match silence > LOST {
                true => self.end(session, "lost"),
                false => self.let_go(session, "went silent"),
            }
        }
    }

    /// A mesh import is known while its entity is live and, for one with a value, once that
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

    /// Ends a screen's session, which closes its socket. Its pages answer nothing, what it held
    /// pressed is let go, and the rules for a lost screen run.
    fn end(&mut self, session: u32, why: &str) {
        if self.sessions.remove(&session).is_some() {
            info!("screen {session} {why}");
            self.script.send(ToScript::Gone(session));
            for alias in self.playing.keys().cloned().collect::<Vec<_>>() {
                self.stop_playing(session, &alias);
            }
            let _ = self.video.send(ToVideo::Gone { session });
            // a page the screen showed answers nothing, so no handler waits on it for ever
            let asked: Vec<u64> = self.asks.iter().filter(|(_, s)| **s == session).map(|(ask, _)| *ask).collect();
            for ask in asked {
                self.asks.remove(&ask);
                self.script.send(ToScript::Answer { call: ask, outcome: Ok(Value::Null) });
            }
            self.let_go(session, why);
            self.run_rules(|r| matches!(r.when, When::Leaves), Value::map([("screen", session.into())]));
        }
    }

    /// Runs the release of what a screen holds pressed, so a jog never outlives its link.
    fn let_go(&mut self, session: u32, why: &str) {
        let held: Vec<Pressed> = self.pressed.iter().filter(|(s, ..)| *s == session).cloned().collect();
        for key in held {
            self.pressed.remove(&key);
            let (_, page, id, index) = key;
            warn!("screen {session} {why} holding {id} on {page}, so its release runs");
            self.fire(session, page, id, "release".into(), Value::map([("lost", true.into())]), index.map(|i| (i, Value::Null)));
        }
    }

    /// The screen no longer plays the import's video, and nothing watches a source no screen plays.
    fn stop_playing(&mut self, session: u32, alias: &str) {
        let Some(screens) = self.playing.get_mut(alias) else { return };
        if !screens.remove(&session) {
            return;
        }
        let _ = self.video.send(ToVideo::Stop { session, alias: alias.to_owned() });
        if screens.is_empty() {
            self.playing.remove(alias);
            self.mesh.stop_playing(alias);
        }
    }

    fn answered(&mut self, v: FromVideo) {
        match v {
            FromVideo::Answer { session, alias, sdp } => self.send(session, &ServerMsg::Play { alias, answer: sdp }),
            FromVideo::Failed { session, alias, text } => {
                self.stop_playing(session, &alias);
                self.refuse(session, text, None);
            }
        }
    }

    fn refuse(&self, session: u32, text: String, alias: Option<String>) {
        warn!("screen {session}: {text}");
        self.send(session, &ServerMsg::Refused { text, alias });
    }

    fn send(&self, session: u32, msg: &ServerMsg) {
        if let Some(s) = self.sessions.get(&session) {
            s.out.put(encode(msg), matches!(msg, ServerMsg::Values { .. }));
        }
    }

    fn broadcast(&self, msg: &ServerMsg) {
        if self.sessions.is_empty() {
            return;
        }
        let text = encode(msg);
        for s in self.sessions.values() {
            s.out.put(text.clone(), matches!(msg, ServerMsg::Values { .. }));
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

/// Each record's source by name, as the engine reads them.
fn sources(records: &[Record]) -> Vec<(String, String)> {
    records.iter().map(|r| (r.name.clone(), r.source.clone())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    #[test]
    fn a_screen_behind_misses_values_but_nothing_else_then_hears_it_caught_up() {
        let (tx, mut rx) = unbounded_channel();
        let queued = Arc::new(AtomicUsize::new(BEHIND + 1));
        let out = Outbox::new(tx, queued.clone());
        out.put(Bytes::from_static(b"values"), true);
        out.put(Bytes::from_static(b"page"), false);
        assert_eq!(rx.try_recv().unwrap(), Bytes::from_static(b"page"));
        assert!(rx.try_recv().is_err());
        assert!(!out.caught_up());
        queued.store(0, Ordering::Relaxed);
        assert!(out.caught_up());
        assert!(!out.caught_up());
        out.put(Bytes::from_static(b"values"), true);
        assert_eq!(rx.try_recv().unwrap(), Bytes::from_static(b"values"));
    }
}

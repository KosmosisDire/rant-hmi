//! The backend's one loop. It owns the project, the mesh and every screen's session, so
//! nothing is shared and nothing locks.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use serde_json::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tracing::{info, warn};

use crate::authorize::{Who, authorize};
use crate::mesh::codec;
use crate::mesh::{Delivery, Mesh};
use crate::pages::logic::{Rule, When};
use crate::pages::{Edit, Pages};
use crate::project::{Import, Intent, Kind, Per, Project, Variable};
use crate::protocol::{ClientMsg, Level, ServerMsg, ValueUpdate};
use crate::script::{CallFailure, End, FromScript, Script, ToScript};

/// How often changed values go out and the mesh is checked.
const TICK: Duration = Duration::from_millis(33);
/// How long the project's files stay still after a change before the HMI reads them.
const QUIET: Duration = Duration::from_millis(150);
/// A screen silent this long is lost.
const SILENCE: Duration = Duration::from_millis(500);
/// How many edits a screen can undo.
const UNDO_DEPTH: usize = 200;
const HEALTH_EVERY: Duration = Duration::from_secs(1);
/// Events a second of, while the first still runs, is ignored. Any other is a stream, such as a
/// drag or a joystick's move, whose latest must land, so it waits for the run.
const ONCE: [&str; 5] = ["tap", "press", "release", "hold", "outside"];

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
    epoch: Option<u32>,
    health_at: Instant,
    /// When a project file last changed outside the HMI, until it is read.
    edited: Option<Instant>,
}

impl App {
    pub fn new(project: Project, pages: Pages, mesh: Mesh, script: Script, node: String, build: String) -> App {
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
            Inbound::Open { session, out } => {
                let vars: HashMap<String, Value> = self.project.variables.iter().filter(|v| v.per == Per::Screen).map(|v| (v.name.clone(), v.start.clone())).collect();
                self.script.send(ToScript::Screen { session, values: vars.iter().map(|(k, v)| (k.clone(), v.clone())).collect() });
                self.sessions.insert(session, Session { out, heard: Instant::now(), undo: Vec::new(), redo: Vec::new(), vars });
                info!("screen {session} connected");
                self.welcome(session);
                self.run_rules(|r| matches!(r.when, When::Connects), serde_json::json!({ "screen": session }));
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
            build: self.build.clone(),
        };
        self.send(session, &hello);
        self.send(session, &ServerMsg::Imports { imports: self.project.imports.clone() });
        self.send(session, &ServerMsg::Pages { pages: self.pages.list.clone() });
        self.send(session, &ServerMsg::Mesh { entities: self.mesh.entities() });
        self.send(session, &ServerMsg::Variables { variables: self.project.variables.clone() });
        self.send(session, &ServerMsg::Rules { rules: self.pages.rules.clone() });
        self.send(session, &ServerMsg::Theme { tokens: self.project.tokens.clone() });
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
            self.mesh.attach(&import);
            if let Some(slot) = self.values.remove(&alias) {
                self.values.insert(import.alias.clone(), slot);
            }
            self.changed.remove(&alias);
            self.changed.insert(import.alias.clone());
            self.follow_rename(session, &alias, &import.alias, false);
        }
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
            self.script.send(ToScript::Judge);
        }
        // a change runs the rules that wait on it, and a variable's asks the conditions anew,
        // its value already with the engine
        let moved = std::mem::take(&mut self.moved);
        for (name, previous, value) in &moved {
            let p = serde_json::json!({ "value": value, "previous": previous });
            self.run_rules(|r| matches!(&r.when, When::Changes { name: n } if n == name), p);
        }
        if moved.iter().any(|(name, _, _)| self.project.variable(name).is_some()) {
            self.script.send(ToScript::Judge);
        }
        self.fire_turned();
        if self.health_at.elapsed() >= HEALTH_EVERY {
            self.health_at = Instant::now();
            self.broadcast(&ServerMsg::Health { peers: self.mesh.peers() });
        }
        let lost: Vec<u32> = self.sessions.iter().filter(|(_, s)| s.heard.elapsed() > SILENCE).map(|(id, _)| *id).collect();
        for session in lost {
            self.end(session, "lost");
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
            // a page the screen showed answers nothing, so no handler waits on it for ever
            let asked: Vec<u64> = self.asks.iter().filter(|(_, s)| **s == session).map(|(ask, _)| *ask).collect();
            for ask in asked {
                self.asks.remove(&ask);
                self.script.send(ToScript::Answer { call: ask, outcome: Ok(Value::Null) });
            }
            // what the screen held pressed is let go, so a jog never outlives its screen
            let held: Vec<Pressed> = self.pressed.iter().filter(|(s, ..)| *s == session).cloned().collect();
            for key in held {
                self.pressed.remove(&key);
                let (_, page, id, index) = key;
                warn!("screen {session} was lost holding {id} on {page}, so its release runs");
                self.fire(session, page, id, "release".into(), serde_json::json!({ "lost": true }), index.map(|i| (i, Value::Null)));
            }
            self.run_rules(|r| matches!(r.when, When::Leaves), serde_json::json!({ "screen": session }));
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

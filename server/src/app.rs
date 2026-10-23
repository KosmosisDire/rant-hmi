//! The backend's one loop. It owns the project, the mesh and every screen's session, so
//! nothing is shared and nothing locks.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::net::IpAddr;
use std::ops::Deref;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use rant::types::Timestamp;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tracing::{info, warn};

use crate::authorize::{Who, authorize};
use crate::events;
use crate::lanes::{Lanes, PIECE};
use crate::mesh::codec;
use crate::mesh::{Delivery, Mesh};
use crate::pages::logic::{Rule, When};
use crate::pages::{Edit, Pages};
use crate::project::{Computed, Import, Kind, Per, Project, Record, Target, Token, Variable};
use crate::rules;
use crate::protocol::{ClientMsg, EnumInfo, Level, Sample, ServerMsg, ValueUpdate, encode};
use crate::script::{CallFailure, End, Form, FromScript, Script, ToScript};
use crate::status::{Client, HmiStatus};
use crate::value::Value;
use crate::rtc::{Connections, Frame, FromRtc, MESSAGE_MAX, ToRtc, Way};

/// How often changed values go out and the mesh is checked.
const TICK: Duration = Duration::from_millis(33);
/// How long the project's files stay still after a change before the HMI reads them.
const QUIET: Duration = Duration::from_millis(150);
/// A screen silent this long lets go of what it holds, so a jog never outlives its link.
const SILENCE: Duration = Duration::from_millis(500);
/// A screen silent this long is lost. A busy page stops reading its socket a while, which
/// is no reason to start it over.
const LOST: Duration = Duration::from_secs(5);
/// How many edits a screen can undo.
const UNDO_DEPTH: usize = 200;
const HEALTH_EVERY: Duration = Duration::from_secs(1);

/// What a screen's connection hands the loop.
pub enum Inbound {
    /// `local` is the address the screen reached the HMI on, `remote` the one it came from.
    Open { session: u32, out: Outbox, local: IpAddr, remote: IpAddr },
    Message { session: u32, msg: ClientMsg },
    /// The screen answered the socket's ping, which took `ping` there and back.
    Heard { session: u32, ping: Option<Duration> },
    Close { session: u32 },
}

/// How screens reach the loop, over the network or in this process, each numbered from one
/// count.
#[derive(Clone)]
pub struct Door {
    inbound: UnboundedSender<Inbound>,
    next: Arc<AtomicU32>,
}

impl Door {
    pub fn new() -> (Door, UnboundedReceiver<Inbound>) {
        let (inbound, received) = unbounded_channel();
        (Door { inbound, next: Arc::new(AtomicU32::new(1)) }, received)
    }

    /// Opens a screen's session, sent what `lanes` carry. None once the loop is gone.
    pub fn open(&self, lanes: Arc<Lanes>, local: IpAddr, remote: IpAddr) -> Option<u32> {
        let session = self.next.fetch_add(1, Ordering::Relaxed);
        self.inbound.send(Inbound::Open { session, out: Outbox(lanes), local, remote }).ok().map(|_| session)
    }

    /// Hands the loop what a screen did, false once the loop is gone.
    pub fn send(&self, i: Inbound) -> bool {
        self.inbound.send(i).is_ok()
    }
}

/// What reaches the loop from each part that runs beside it.
pub struct Sources {
    pub mesh: UnboundedReceiver<Delivery>,
    pub screens: UnboundedReceiver<Inbound>,
    pub script: UnboundedReceiver<FromScript>,
    /// A project file changed.
    pub files: UnboundedReceiver<()>,
    pub rtc: UnboundedReceiver<FromRtc>,
    pub frames: UnboundedReceiver<Frame>,
}

/// A screen's socket, in lanes that take turns (`lanes.rs`), which it sends as fast as the
/// screen confirms them. They close when the screen goes.
pub struct Outbox(Arc<Lanes>);

impl Deref for Outbox {
    type Target = Lanes;

    fn deref(&self) -> &Lanes {
        &self.0
    }
}

impl Drop for Outbox {
    fn drop(&mut self) {
        self.0.close();
    }
}

struct Session {
    out: Outbox,
    local: IpAddr,
    remote: IpAddr,
    /// When it connected.
    since: Timestamp,
    ping: Option<Duration>,
    /// How much the round trip wavers, in ms, smoothed.
    jitter: f64,
    /// Whether its WebRTC data channels are open.
    channels: bool,
    /// Whether it sends on its channels, and what they brought before it said so.
    switched: bool,
    early: Vec<ClientMsg>,
    heard: Instant,
    /// The edits that undo this screen's own edits, newest last, and those that redo them.
    undo: Vec<Edit>,
    redo: Vec<Edit>,
    /// The values of the variables each screen has.
    vars: HashMap<String, Value>,
    /// The imports whose video it plays over WebRTC, and those it decodes itself from frames
    /// on its socket.
    plays: HashSet<String>,
    decodes: HashSet<String>,
}

impl Session {
    /// A new round trip, and how far it was from the last.
    fn timed(&mut self, rtt: Duration) {
        if let Some(last) = self.ping {
            self.jitter += ((rtt.as_secs_f64() - last.as_secs_f64()).abs() * 1000.0 - self.jitter) / 16.0;
        }
        self.ping = Some(rtt);
    }
}

/// Why an edit is applied, which says which stack its undo goes on.
#[derive(Clone, Copy)]
enum Step {
    Do,
    Undo,
    Redo,
}

/// A run going on: the screen that started it, none for a rule's, the handler it runs, and
/// what the log calls it.
struct Running {
    session: Option<u32>,
    of: HandlerKey,
    label: String,
}

/// A handler as it runs: an element's for an event and filter on the copy of a repeat it
/// happened on, or a rule's, which is its id alone.
#[derive(Clone, PartialEq, Eq, Hash, Default)]
struct HandlerKey {
    page: String,
    id: String,
    index: Option<u32>,
    event: String,
    filter: Filter,
}

/// A handler's filter, or what an event brought in the fields filters read.
type Filter = BTreeMap<String, String>;

/// An input a screen holds on an element, as a press or a key: the screen, page, element and
/// copy of a repeat, the event that ends it, and what it brought that its end's filters read,
/// or for a stream that ends itself, as axes, the filter of the handler that hears it.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Held {
    session: u32,
    page: String,
    id: String,
    index: Option<u32>,
    end: &'static str,
    by: Filter,
}

/// An event waiting for its handler's run to end: its screen, what it brought and the copy of a
/// repeat it happened on.
type Waiting = (u32, Value, Option<(u32, Value)>);

/// A rule's condition: true since when, and whether it has fired since it turned true, for the
/// condition and code it was judged with.
#[derive(Default)]
struct Turned {
    since: Option<Instant>,
    fired: bool,
    of: Option<(When, String)>,
}

/// The project's named lists, each told to the engine and every screen whole.
#[derive(Clone, Copy)]
enum List {
    Imports,
    Variables,
    Records,
    Computed,
    Theme,
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
    rtc: Connections,
    /// The screens playing each import's video, either way.
    playing: HashMap<String, HashSet<u32>>,
    runs: HashMap<u64, Running>,
    next_run: u64,
    /// Pages opened to wait for an answer: the waiting call, and the screen that shows them.
    asks: HashMap<u64, u32>,
    /// What screens hold on elements with a handler for its end.
    /// What each brings to its end should the screen be lost.
    held: HashMap<Held, Value>,
    /// What came while its handler still ran, run in order as each run ends: a stream's latest
    /// event, those before gathered in, and every end, since a held input never loses its end.
    waiting: HashMap<HandlerKey, VecDeque<Waiting>>,
    /// When each timer rule is next due.
    timers: HashMap<String, Instant>,
    turned: HashMap<String, Turned>,
    /// Values that changed since the last tick, with what they were before.
    moved: Vec<(String, Option<Value>, Value)>,
    node: String,
    /// The client script the backend serves.
    build: String,
    sessions: HashMap<u32, Session>,
    /// The last batch of values sent.
    seq: Cell<u64>,
    values: HashMap<String, Slot>,
    changed: BTreeSet<String>,
    /// The values of the variables every screen shares.
    shared: HashMap<String, Value>,
    /// Each record's samples, oldest first, and when it next samples.
    history: HashMap<String, VecDeque<Sample>>,
    sample_at: HashMap<String, Instant>,
    epoch: Option<u32>,
    /// When the HMI started.
    started_at: Timestamp,
    /// What the engine was last told each import's message is made of.
    forms: HashMap<String, Form>,
    /// The mesh's enums code names, as the engine and the screens were last told.
    enums: Vec<EnumInfo>,
    health_at: Instant,
    /// When a project file last changed outside the HMI, until it is read.
    edited: Option<Instant>,
}

impl App {
    pub fn new(project: Project, pages: Pages, mesh: Mesh, script: Script, rtc: Connections, node: String, build: String) -> App {
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
            rtc,
            playing: HashMap::new(),
            runs: HashMap::new(),
            next_run: 0,
            asks: HashMap::new(),
            held: HashMap::new(),
            waiting: HashMap::new(),
            timers: HashMap::new(),
            turned: HashMap::new(),
            moved: Vec::new(),
            node,
            build,
            sessions: HashMap::new(),
            seq: Cell::new(0),
            values: HashMap::new(),
            changed: BTreeSet::new(),
            shared,
            history: HashMap::new(),
            sample_at: HashMap::new(),
            epoch: None,
            started_at: Timestamp::now(),
            forms: HashMap::new(),
            enums: Vec::new(),
            health_at: Instant::now(),
            edited: None,
        }
    }

    /// Runs until `stop` ends.
    pub async fn run(mut self, mut from: Sources, stop: impl Future<Output = ()>) {
        let mut tick = tokio::time::interval(TICK);
        self.rules_changed();
        self.run_rules(|r| matches!(r.when, When::Starts), Value::Null);
        tokio::pin!(stop);
        loop {
            tokio::select! {
                Some(d) = from.mesh.recv() => self.deliver(d),
                Some(i) = from.screens.recv() => self.inbound(i),
                Some(s) = from.script.recv() => self.scripted(s),
                Some(()) = from.files.recv() => self.edited = Some(Instant::now()),
                Some(r) = from.rtc.recv() => self.connection(r),
                Some(f) = from.frames.recv() => self.frame(f),
                _ = tick.tick() => self.tick(),
                _ = &mut stop => break,
            }
        }
        for session in self.sessions.keys().copied().collect::<Vec<_>>() {
            self.end(session, "the HMI is closing");
        }
    }

    fn deliver(&mut self, d: Delivery) {
        let waits = self.waits(&d.alias);
        let slot = self.values.entry(d.alias.clone()).or_default();
        let previous = slot.value.replace(d.value);
        // only a rule that waits on it needs the value it had, which for a cloud is costly to copy
        if waits && let Some(value) = slot.value.clone() {
            self.moved.push((d.alias.clone(), previous, value));
        }
        slot.known = true;
        self.changed.insert(d.alias);
    }

    /// Whether a rule runs when `name` changes.
    fn waits(&self, name: &str) -> bool {
        self.pages.rules.iter().any(|r| matches!(&r.when, When::Changes { name: n } if n == name))
    }

    fn inbound(&mut self, i: Inbound) {
        match i {
            Inbound::Open { session, out, local, remote } => {
                let vars: HashMap<String, Value> = self.project.variables.iter().filter(|v| v.per == Per::Screen).map(|v| (v.name.clone(), v.start.clone())).collect();
                self.script.send(ToScript::Screen { session, values: vars.iter().map(|(k, v)| (k.clone(), v.clone())).collect() });
                self.sessions.insert(session, Session { out, local, remote, since: Timestamp::now(), ping: None, jitter: 0.0, channels: false, switched: false, early: Vec::new(), heard: Instant::now(), undo: Vec::new(), redo: Vec::new(), vars, plays: HashSet::new(), decodes: HashSet::new() });
                info!("screen {session} connected");
                self.welcome(session);
                self.run_rules(|r| matches!(r.when, When::Connects), Value::map([("screen", session.into())]));
            }
            Inbound::Message { session, msg } => {
                let Some(s) = self.sessions.get_mut(&session) else { return };
                s.heard = Instant::now();
                self.handle(session, msg);
            }
            Inbound::Heard { session, ping } => {
                if let Some(s) = self.sessions.get_mut(&session) {
                    s.heard = Instant::now();
                    // the screen times its channels while it has them
                    if let Some(ping) = ping.filter(|_| !s.channels) {
                        s.timed(ping);
                    }
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
        // every name a page reads comes before the pages, so a screen never draws one, nor
        // works out where its handlers run, without them
        self.send(session, &self.whole(List::Imports));
        self.send(session, &ServerMsg::Mesh { entities: self.mesh.entities() });
        for list in [List::Variables, List::Records, List::Computed] {
            self.send(session, &self.whole(list));
        }
        self.send(session, &ServerMsg::Enums { enums: self.enums.clone() });
        self.send(session, &self.whole(List::Theme));
        self.send(session, &ServerMsg::Pages { pages: self.pages.list.clone() });
        for r in &self.project.records {
            let samples = self.history.get(&r.name).map(|h| h.iter().cloned().collect()).unwrap_or_default();
            self.send(session, &ServerMsg::Samples { name: r.name.clone(), samples, whole: true });
        }
        self.send(session, &ServerMsg::Rules { rules: self.pages.rules.clone() });
        self.put_values(Some(session), self.all_values(session));
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
            // answered where it came in
            ClientMsg::Ping { .. } => {}
            // a new connection plays nothing until the screen offers its videos on it
            ClientMsg::Channels { offer } => {
                let Some(s) = self.sessions.get_mut(&session) else { return };
                s.plays.clear();
                let local = s.local;
                self.watch(session);
                self.rtc.send(ToRtc::Channels { session, sdp: offer, local, ice: self.project.info.ice.clone() });
            }
            ClientMsg::Candidate { candidate } => {
                self.rtc.send(ToRtc::Candidate { session, candidate });
            }
            ClientMsg::OffChannels => {
                self.rtc.send(ToRtc::Unlink { session });
                self.unlinked(session);
            }
            ClientMsg::OnChannels => {
                let Some(s) = self.sessions.get_mut(&session) else { return };
                s.switched = true;
                for msg in std::mem::take(&mut s.early) {
                    self.handle(session, msg);
                }
            }
            ClientMsg::Play { offer, mut videos } => {
                let plays = self.with_video(session, videos.iter().map(|v| v.alias.clone()));
                videos.retain(|v| plays.contains(&v.alias));
                if let Some(s) = self.sessions.get_mut(&session) {
                    s.plays = plays;
                }
                self.watch(session);
                self.rtc.send(ToRtc::Play { session, sdp: offer, videos });
            }
            ClientMsg::Frames { aliases } => {
                let decodes = self.with_video(session, aliases);
                let Some(s) = self.sessions.get_mut(&session) else { return };
                for alias in s.decodes.difference(&decodes) {
                    s.out.stop_video(alias);
                }
                s.decodes = decodes;
                self.watch(session);
            }
            ClientMsg::Import { import } => match self.project.import(import.clone()) {
                Ok(()) => {
                    info!("imported {} as {}", import.entity, import.alias);
                    self.mesh.attach(&import);
                    self.list_changed(List::Imports);
                }
                Err(text) => self.refuse(session, text, Some(import.alias)),
            },
            ClientMsg::Unimport { alias } => match self.project.unimport(&alias) {
                Ok(()) => {
                    info!("removed the import {alias}");
                    self.mesh.detach(&alias);
                    self.values.remove(&alias);
                    self.changed.remove(&alias);
                    self.list_changed(List::Imports);
                }
                Err(text) => self.refuse(session, text, Some(alias)),
            },
            ClientMsg::ChangeImport { alias, import } => self.change_import(session, alias, import),
            ClientMsg::SetVariable { name, variable } => self.set_variable(session, name, variable),
            ClientMsg::SetRecord { name, record } => self.set_record(session, name, record),
            ClientMsg::SetComputed { name, computed } => self.set_computed(session, name, computed),
            ClientMsg::SetToken { name, token } => self.set_token(session, name, token),
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
            ClientMsg::Fire { page, id, event, payload, index, item, heard } => {
                let on = HandlerKey { page, id, index, event, filter: Filter::new() };
                self.follow_held(session, &on, &payload, &heard);
                let at = index.map(|i| (i, item.unwrap_or(Value::Null)));
                for filter in heard {
                    self.fire(session, HandlerKey { filter, ..on.clone() }, payload.clone(), at.clone());
                }
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

    /// Changes one of the project's lists by `change`, which checks it. A refusal sends the
    /// screen the list as it stands, so what it showed goes back.
    fn change_list(&mut self, session: u32, list: List, alias: Option<String>, change: impl FnOnce(&mut Project) -> Result<(), String>) -> bool {
        let Err(text) = change(&mut self.project) else { return true };
        self.send(session, &self.whole(list));
        self.refuse(session, text, alias);
        false
    }

    /// A list as it stands, as every screen hears it.
    fn whole(&self, list: List) -> ServerMsg {
        let p = &self.project;
        match list {
            List::Imports => ServerMsg::Imports { imports: p.imports.clone() },
            List::Variables => ServerMsg::Variables { variables: p.variables.clone() },
            List::Records => ServerMsg::Records { records: p.records.clone() },
            List::Computed => ServerMsg::Computed { computed: p.computed.clone() },
            List::Theme => ServerMsg::Theme { tokens: p.tokens.clone() },
        }
    }

    /// Tells the engine and every screen a list, whole, after it changed. A change to the
    /// computed values works them out anew.
    fn list_changed(&mut self, list: List) {
        match list {
            List::Imports => {
                self.refresh_known();
                self.script.send(ToScript::Imports(self.project.imports.clone()));
                self.types_changed();
            }
            List::Variables => self.script.send(ToScript::Variables(self.project.variables.clone())),
            List::Records => self.script.send(ToScript::Records(sources(&self.project.records))),
            List::Computed => {
                self.script.send(ToScript::Computed(self.project.computed.clone()));
                self.script.send(ToScript::Compute);
            }
            List::Theme => {}
        }
        self.broadcast(&self.whole(list));
    }

    /// Adds, changes or removes a variable. A rename carries its values and every use of its
    /// name along, a new start or scope starts its values over.
    fn set_variable(&mut self, session: u32, name: String, to: Option<Variable>) {
        let old = self.project.variable(&name).cloned();
        if !self.change_list(session, List::Variables, None, |p| p.set_variable(&name, to.clone())) {
            return;
        }
        let (mut kept_shared, mut kept_own) = self.take_variable(&name);
        if old.as_ref().zip(to.as_ref()).is_none_or(|(o, n)| o.start != n.start || o.per != n.per) {
            kept_shared = None;
            kept_own.clear();
        }
        self.list_changed(List::Variables);
        let Some(v) = to else { return };
        if v.name != name {
            self.follow_rename(session, "variable", &name, &v.name, false);
        }
        self.start_variable(&v, kept_shared, kept_own);
    }

    /// Takes a variable's values off the HMI and every screen: the shared one and each screen's.
    fn take_variable(&mut self, name: &str) -> (Option<Value>, HashMap<u32, Value>) {
        let own = self.sessions.iter_mut().filter_map(|(id, s)| s.vars.remove(name).map(|v| (*id, v))).collect();
        (self.shared.remove(name), own)
    }

    /// Adds, changes or removes a record. A rename carries its history and every use of its
    /// name along, a new source starts the history over.
    fn set_record(&mut self, session: u32, name: String, to: Option<Record>) {
        let old = self.project.record(&name).cloned();
        if !self.change_list(session, List::Records, None, |p| p.set_record(&name, to.clone())) {
            return;
        }
        let kept = self.take_history(&name).filter(|_| old.as_ref().zip(to.as_ref()).is_some_and(|(o, n)| o.source == n.source));
        self.list_changed(List::Records);
        let Some(r) = to else { return };
        if r.name != name {
            self.follow_rename(session, "record", &name, &r.name, false);
        }
        let samples: VecDeque<Sample> = kept.unwrap_or_default();
        self.broadcast(&ServerMsg::Samples { name: r.name.clone(), samples: samples.iter().cloned().collect(), whole: true });
        self.history.insert(r.name, samples);
    }

    /// Takes a record's samples, and forgets when it samples next.
    fn take_history(&mut self, name: &str) -> Option<VecDeque<Sample>> {
        self.sample_at.remove(name);
        self.history.remove(name)
    }

    fn set_computed(&mut self, session: u32, name: String, to: Option<Computed>) {
        if !self.change_list(session, List::Computed, None, |p| p.set_computed(&name, to.clone())) {
            return;
        }
        if to.as_ref().is_none_or(|c| c.name != name) {
            self.unknown(&name);
        }
        if let Some(c) = to.as_ref().filter(|c| c.name != name) {
            self.follow_rename(session, "computed value", &name, &c.name, false);
        }
        self.list_changed(List::Computed);
        // worked out first, so the trial starts from what it reads now
        if let Some(c) = to.filter(|c| c.set.is_some()) {
            self.script.send(ToScript::Try { session, name: c.name });
        }
    }

    /// A name no longer worked out reads as unknown on every screen.
    fn unknown(&mut self, name: &str) {
        self.values.remove(name);
        self.changed.insert(name.to_owned());
    }

    /// Adds, changes or removes a token. Pages and components follow a rename.
    fn set_token(&mut self, session: u32, name: String, to: Option<Token>) {
        let renamed = to.as_ref().filter(|t| t.name != name).map(|t| t.name.clone());
        if !self.change_list(session, List::Theme, None, |p| p.set_token(&name, to)) {
            return;
        }
        self.list_changed(List::Theme);
        if let Some(to) = renamed {
            self.follow_rename(session, "token", &format!("${name}"), &format!("${to}"), true);
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
        let t = since_epoch().as_secs_f64() * 1000.0;
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
                self.put_values(None, vec![known(&v.name, &value)]);
            }
            Per::Screen => {
                let ids: Vec<u32> = self.sessions.keys().copied().collect();
                for id in ids {
                    let value = kept_own.remove(&id).unwrap_or_else(|| v.start.clone());
                    if let Some(s) = self.sessions.get_mut(&id) {
                        s.vars.insert(v.name.clone(), value.clone());
                    }
                    self.script.send(ToScript::Screen { session: id, values: vec![(v.name.clone(), value.clone())] });
                    self.put_values(Some(id), vec![known(&v.name, &value)]);
                }
            }
        }
    }

    /// Renames an import or changes its intent. A rename moves its handle, its value and every
    /// use of the alias in pages and handlers.
    fn change_import(&mut self, session: u32, alias: String, import: Import) {
        if !self.change_list(session, List::Imports, Some(alias.clone()), |p| p.change(&alias, import.clone())) {
            return;
        }
        if import.alias != alias {
            self.mesh.detach(&alias);
            if let Some(slot) = self.values.remove(&alias) {
                self.values.insert(import.alias.clone(), slot);
            }
            self.changed.remove(&alias);
            self.changed.insert(import.alias.clone());
            self.follow_rename(session, "import", &alias, &import.alias, false);
        }
        self.mesh.attach(&import);
        self.list_changed(List::Imports);
    }

    /// Writes every use of `from`, a renamed `what`, as `to` in the pages, components too where
    /// they read it, and sends the pages out when any changed.
    fn follow_rename(&mut self, session: u32, what: &str, from: &str, to: &str, components: bool) {
        info!("renamed the {what} {from} to {to}");
        match self.pages.rename(from, to, components) {
            Ok(touched) if !touched.is_empty() => self.broadcast(&ServerMsg::Pages { pages: self.pages.list.clone() }),
            Ok(_) => {}
            Err(text) => self.refuse(session, text, None),
        }
    }

    /// Runs the element's handler `of` names, unless it still runs from before. Then a stream's
    /// event and an end wait for it, while a one off start is dropped. `at` is the copy of a
    /// repeat it happened on, its index and item.
    fn fire(&mut self, session: u32, of: HandlerKey, payload: Value, at: Option<(u32, Value)>) {
        let Some(e) = self.pages.element(&of.page, &of.id) else { return };
        let Some(h) = e.handlers.iter().find(|h| h.event == of.event && h.filter == of.filter) else { return };
        if self.runs.values().any(|r| r.of == of) {
            let stream = !events::find(&of.event).is_some_and(|e| e.once);
            let end = events::ended_by(&of.event).is_some();
            if !stream && !end {
                return;
            }
            let queue = self.waiting.entry(of.clone()).or_default();
            match queue.back_mut() {
                // a stream's events from the same screen and copy gather in, so no move is lost
                Some((s, was, a)) if stream && *s == session && a.as_ref().map(|a| a.0) == at.as_ref().map(|a| a.0) => *was = events::gather(&of.event, was, payload),
                _ => queue.push_back((session, payload, at)),
            }
            return;
        }
        let label = format!("{} {}", e.props.get("name").unwrap_or(&of.id), of.event);
        let code = h.code.clone();
        self.start(Running { session: Some(session), of, label }, code, payload, at);
    }

    /// The filters of an element's handlers that take `event` bringing `p`.
    fn taking(&self, page: &str, id: &str, event: &str, p: &Value) -> Vec<Filter> {
        self.pages.element(page, id).map(|e| e.handlers.iter().filter(|h| h.takes(event, p)).map(|h| h.filter.clone()).collect()).unwrap_or_default()
    }

    /// Follows what a screen holds from the events that begin and end it, `on` an element with a
    /// handler for the end, so that end still runs should the screen be lost. A stream that ends
    /// itself is held by each handler that `heard` it until it comes to rest.
    fn follow_held(&mut self, session: u32, on: &HandlerKey, p: &Value, heard: &[Filter]) {
        let (page, id, event) = (on.page.as_str(), on.id.as_str(), on.event.as_str());
        let Some(info) = events::find(event) else { return };
        let end = info.ends_with.unwrap_or(info.name);
        let at = |by: Filter| Held { session, page: page.to_owned(), id: id.to_owned(), index: on.index, end, by };
        if events::ends_itself(event) {
            let rest = events::rest(event, p);
            for filter in heard {
                match rest == *p {
                    true => self.held.remove(&at(filter.clone())),
                    false => self.held.insert(at(filter.clone()), rest.clone()),
                };
            }
            return;
        }
        let read: Vec<(&str, &Value)> = events::settings(end).iter().filter(|s| s.kind == events::SettingKind::Filter).filter_map(|s| Some((s.name, p.get(s.name)?))).collect();
        let held = at(read.iter().filter_map(|(k, v)| Some((k.to_string(), events::filter_text(v)?))).collect());
        if info.ends_with.is_some() && !self.taking(page, id, end, p).is_empty() {
            self.held.insert(held, Value::map(read.into_iter().map(|(k, v)| (k, v.clone()))));
        } else if events::ended_by(event).is_some() {
            self.held.remove(&held);
        }
    }

    /// Starts `code` as the run `running` names, with `p` and the copy of a repeat `at`.
    fn start(&mut self, running: Running, code: String, p: Value, at: Option<(u32, Value)>) {
        self.next_run += 1;
        let session = running.session;
        self.runs.insert(self.next_run, running);
        self.script.send(ToScript::Run { run: self.next_run, session, code, p, at });
    }

    /// Runs each rule that `fits`, unless it still runs from before.
    fn run_rules(&mut self, fits: impl Fn(&Rule) -> bool, p: Value) {
        let due: Vec<Rule> = self.pages.rules.iter().filter(|r| fits(r)).cloned().collect();
        for rule in due {
            let of = HandlerKey { id: rule.id, ..HandlerKey::default() };
            if self.runs.values().any(|r| r.session.is_none() && r.of == of) {
                continue;
            }
            self.start(Running { session: None, of, label: rule.name }, rule.code, p.clone(), None);
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
        // one edited since it was judged is judged anew, so its new condition or code fires
        let rules = &self.pages.rules;
        self.turned.retain(|id, t| rules.iter().any(|r| &r.id == id && t.of.as_ref().is_some_and(|(w, c)| *w == r.when && *c == r.code)));
        for r in rules.iter().filter(|r| matches!(r.when, When::Turns { .. })) {
            self.turned.entry(r.id.clone()).or_insert_with(|| Turned { of: Some((r.when.clone(), r.code.clone())), ..Turned::default() });
        }
        self.script.send(ToScript::Judge);
    }

    /// Notes when each condition turned true or false.
    fn judged(&mut self, truths: Vec<(String, bool)>) {
        let now = Instant::now();
        for (id, truth) in truths {
            let Some(t) = self.turned.get_mut(&id) else { continue };
            match (truth, t.since) {
                (true, None) => t.since = Some(now),
                (false, _) => (t.since, t.fired) = (None, false),
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
                    // the engine took the write as the latest, so it hears what holds instead
                    if self.project.find(&alias).is_some() {
                        let now = self.update(&alias);
                        self.script.send(ToScript::Values(vec![(alias, now.value.filter(|_| now.known))]));
                    }
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
                // the first of what waited for this run goes now, if its screen is still here
                let Some(r) = self.runs.remove(&run) else { return };
                while let Some((session, payload, at)) = self.waiting.get_mut(&r.of).and_then(VecDeque::pop_front) {
                    if self.sessions.contains_key(&session) {
                        self.fire(session, r.of.clone(), payload, at);
                        break;
                    }
                }
                if self.waiting.get(&r.of).is_some_and(VecDeque::is_empty) {
                    self.waiting.remove(&r.of);
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
        let mut shown: Vec<String> = edit.pages().into_iter().map(str::to_owned).collect();
        let applied = match self.pages.apply(edit) {
            Ok(applied) => applied,
            Err(text) => {
                // a screen shows a change at once, so a refused one gets back what it named
                if rules {
                    self.send(session, &ServerMsg::Rules { rules: self.pages.rules.clone() });
                }
                shown.sort();
                shown.dedup();
                for page in shown.iter().filter_map(|id| self.pages.get(id).cloned()).collect::<Vec<_>>() {
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
        for (from, to) in &applied.moved {
            for e in self.sessions.values_mut().flat_map(|s| s.undo.iter_mut().chain(s.redo.iter_mut())) {
                e.repage(from, to);
            }
            if self.project.info.start.as_deref() == Some(from) {
                match self.project.set_start(to.clone()) {
                    Ok(()) => self.broadcast(&ServerMsg::Project { project: self.project.info.clone() }),
                    Err(e) => warn!("could not keep {to} the start page: {e}"),
                }
            }
            self.broadcast(&ServerMsg::Moved { from: from.clone(), to: to.clone() });
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
        let target = self.project.look_up(alias).target(alias, path, session.is_some()).map_err(|u| u.text)?;
        // a computed value's setter works out what its target takes, then that is set
        if let Target::Computed = target {
            self.script.send(ToScript::Invert { session, name: alias.to_owned(), v: value });
            return Ok(());
        }
        if let Target::Variable(per) = target {
            let held = match per {
                Per::Hmi => self.shared.get_mut(alias),
                Per::Screen => session.and_then(|s| self.sessions.get_mut(&s)).and_then(|s| s.vars.get_mut(alias)),
            };
            let held = held.ok_or_else(|| rules::say(rules::NO_SCREEN, alias))?;
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
                    self.put_values(Some(s), vec![known(alias, &now)]);
                }
                _ => {
                    self.script.send(ToScript::Values(vec![(alias.to_owned(), Some(now.clone()))]));
                    self.put_values(None, vec![known(alias, &now)]);
                }
            }
            return Ok(());
        }
        let last = self.values.get(alias).and_then(|s| s.value.as_ref());
        let whole = self.mesh.set(alias, path, value, last)?;
        // what the HMI wrote is the latest it knows at once, so a write soon after builds on it,
        // not on the value before, which the mesh has not echoed back yet
        let slot = self.values.entry(alias.to_owned()).or_default();
        slot.value = Some(whole.clone());
        slot.known = true;
        self.changed.insert(alias.to_owned());
        self.script.send(ToScript::Values(vec![(alias.to_owned(), Some(whole))]));
        Ok(())
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
                if self.project.find(&gone.alias).is_none() {
                    self.values.remove(&gone.alias);
                    self.changed.remove(&gone.alias);
                }
            }
            for import in self.project.imports.clone() {
                self.mesh.attach(&import);
            }
            self.list_changed(List::Imports);
        }
        if old.variables != self.project.variables {
            for name in old.variables.iter().filter(|v| !self.project.variables.contains(v)).map(|v| v.name.clone()).collect::<Vec<_>>() {
                self.take_variable(&name);
            }
            self.list_changed(List::Variables);
            for v in self.project.variables.clone().iter().filter(|v| !old.variables.contains(v)) {
                self.start_variable(v, None, HashMap::new());
            }
        }
        if old.records != self.project.records {
            for name in old.records.iter().filter(|r| !self.project.records.contains(r)).map(|r| r.name.clone()).collect::<Vec<_>>() {
                self.take_history(&name);
            }
            self.list_changed(List::Records);
            for r in self.project.records.iter().filter(|r| !old.records.contains(r)) {
                self.broadcast(&ServerMsg::Samples { name: r.name.clone(), samples: Vec::new(), whole: true });
            }
        }
        if old.computed != self.project.computed {
            for name in old.computed.iter().filter(|c| self.project.computed(&c.name).is_none()).map(|c| c.name.clone()).collect::<Vec<_>>() {
                self.unknown(&name);
            }
            self.list_changed(List::Computed);
        }
        if old.tokens != self.project.tokens {
            self.list_changed(List::Theme);
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
            self.types_changed();
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
            self.put_values(None, values);
            // the engine has the new values before it judges by them
            self.rethink();
        }
        // a change runs the rules that wait on it, and a variable's asks the conditions anew,
        // its value already with the engine
        let moved = std::mem::take(&mut self.moved);
        for (name, previous, value) in &moved {
            if !self.waits(name) {
                continue;
            }
            let p = Value::map([("value", value.clone()), ("previous", previous.clone().unwrap_or_default())]);
            self.run_rules(|r| matches!(&r.when, When::Changes { name: n } if n == name), p);
        }
        if moved.iter().any(|(name, _, _)| self.project.variable(name).is_some()) {
            self.rethink();
        }
        self.fire_turned();
        self.sample();
        // each screen's round trip goes out as it is measured, the rest once a second
        self.publish_clients();
        if self.health_at.elapsed() >= HEALTH_EVERY {
            self.health_at = Instant::now();
            self.broadcast(&ServerMsg::Health { peers: self.mesh.peers() });
            self.publish_status();
        }
        let missed: Vec<u32> = self.sessions.iter().filter(|(_, s)| s.out.missed()).map(|(id, _)| *id).collect();
        for session in missed {
            self.put_values(Some(session), self.all_values(session));
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

    /// Publishes the screens connected on the mesh, once that changed.
    fn publish_clients(&mut self) {
        let mut clients: Vec<Client> = self
            .sessions
            .iter()
            .map(|(id, s)| Client {
                id: *id,
                address: s.remote.to_string().as_str().try_into().unwrap_or_default(),
                connected_at: s.since,
                ping_ms: s.ping.map_or(0.0, |p| p.as_secs_f64() * 1000.0),
                jitter_ms: s.jitter,
                webrtc: s.channels,
            })
            .collect();
        clients.sort_by_key(|c| c.id);
        self.mesh.publish_clients(clients);
    }

    /// Publishes the HMI's own state on the mesh, once that changed.
    fn publish_status(&mut self) {
        let missing = self.project.imports.iter().filter(|i| !self.mesh.live(i)).filter_map(|i| i.entity.as_str().try_into().ok()).collect();
        let status = HmiStatus { version: env!("CARGO_PKG_VERSION").into(), project: self.project.info.name.clone(), started_at: self.started_at, clients: self.sessions.len() as u32, missing };
        self.mesh.publish_status(status);
    }

    /// Tells the engine what each import's message is made of, and it and every screen the
    /// enums code names, once those changed. A name code already has hides an enum's.
    fn types_changed(&mut self) {
        let forms = self.mesh.forms();
        if forms != self.forms {
            self.forms = forms.clone();
            self.script.send(ToScript::Forms(forms));
        }
        let mut enums = self.mesh.enums();
        enums.retain(|e| !self.project.imports.iter().any(|i| i.alias == e.name) && !crate::script::reserved(&e.name));
        if enums != self.enums {
            self.enums = enums.clone();
            self.script.send(ToScript::Enums(enums.clone()));
            self.broadcast(&ServerMsg::Enums { enums });
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
            self.watch(session);
            self.rtc.send(ToRtc::Unlink { session });
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

    /// A screen's channels broke. What it sent on them may be lost, a release too, and so may
    /// what it was sent, so it gets every value again on its socket. Its videos end with them.
    fn unlinked(&mut self, session: u32) {
        let Some(s) = self.sessions.get_mut(&session) else { return };
        let open = std::mem::take(&mut s.channels);
        s.early.clear();
        s.plays.clear();
        if std::mem::take(&mut s.switched) {
            self.let_go(session, "lost its data channels");
        }
        if open {
            self.put_values(Some(session), self.all_values(session));
        }
        self.watch(session);
    }

    /// Runs the end of what a screen holds, as a press's release or axes at rest, so a jog never
    /// outlives its link. It brings what its filters read, or the stream at rest, and `lost`.
    fn let_go(&mut self, session: u32, why: &str) {
        let held: Vec<(Held, Value)> = self.held.iter().filter(|(h, _)| h.session == session).map(|(h, p)| (h.clone(), p.clone())).collect();
        for (h, brought) in held {
            self.held.remove(&h);
            warn!("screen {session} {why} holding {} on {}, so its {} runs", h.id, h.page, h.end);
            let Value::Map(mut fields) = brought else { continue };
            fields.push(("lost".to_owned(), true.into()));
            let p = Value::Map(fields);
            let ends = match events::ends_itself(h.end) {
                true => vec![h.by.clone()],
                false => self.taking(&h.page, &h.id, h.end, &p),
            };
            for filter in ends {
                let of = HandlerKey { page: h.page.clone(), id: h.id.clone(), index: h.index, event: h.end.into(), filter };
                self.fire(session, of, p.clone(), h.index.map(|i| (i, Value::Null)));
            }
        }
    }

    /// The imports among `aliases`, each other one refused, as only an import has video.
    fn with_video(&mut self, session: u32, aliases: impl IntoIterator<Item = String>) -> HashSet<String> {
        let (known, unknown): (HashSet<String>, HashSet<String>) = aliases.into_iter().partition(|a| self.project.find(a).is_some());
        for alias in unknown {
            self.refuse(session, format!("{alias} is not a mesh import, so it has no video"), None);
        }
        known
    }

    /// Follows the videos a screen plays, either way, or none once it is gone. The mesh
    /// watches only the sources some screen plays.
    fn watch(&mut self, session: u32) {
        let aliases: HashSet<String> = self.sessions.get(&session).map(|s| s.plays.union(&s.decodes).cloned().collect()).unwrap_or_default();
        let mesh = &mut self.mesh;
        self.playing.retain(|alias, screens| {
            if !aliases.contains(alias) {
                screens.remove(&session);
            }
            if screens.is_empty() {
                mesh.stop_playing(alias);
            }
            !screens.is_empty()
        });
        for alias in aliases {
            if let Some(import) = self.project.find(&alias).cloned() {
                self.mesh.play(&import);
                self.playing.entry(alias).or_default().insert(session);
            }
        }
    }

    /// A frame of an import's video, for the screens playing it: through the WebRTC task to
    /// those playing it there, and on the socket of each decoding it itself.
    fn frame(&self, f: Frame) {
        let Some(screens) = self.playing.get(&f.alias) else { return };
        let mut message = None;
        let mut here = false;
        for s in screens.iter().filter_map(|id| self.sessions.get(id)) {
            here |= s.plays.contains(&f.alias);
            if s.decodes.contains(&f.alias) {
                let m = message.get_or_insert_with(|| encode(&ServerMsg::Frame { alias: f.alias.clone(), keyframe: f.keyframe, pts: f.pts, data: f.data.clone() }));
                s.out.video(&f.alias, f.keyframe, m.clone(), f.at);
            }
        }
        if here {
            self.rtc.frame(f);
        }
    }

    /// What a screen's WebRTC connection brought.
    fn connection(&mut self, r: FromRtc) {
        match r {
            FromRtc::Channels { session, sdp } => self.send(session, &ServerMsg::Channels { answer: sdp }),
            FromRtc::Linked { session, open: true } => {
                if let Some(s) = self.sessions.get_mut(&session) {
                    s.channels = true;
                }
            }
            FromRtc::Linked { session, open: false } => self.unlinked(session),
            FromRtc::Heard { session, rtt } => {
                let Some(s) = self.sessions.get_mut(&session) else { return };
                s.heard = Instant::now();
                if let Some(rtt) = rtt {
                    s.timed(rtt);
                }
            }
            FromRtc::Message { session, msg } => {
                let Some(s) = self.sessions.get_mut(&session) else { return };
                match s.switched {
                    true => self.inbound(Inbound::Message { session, msg }),
                    false => {
                        s.heard = Instant::now();
                        s.early.push(msg);
                    }
                }
            }
            FromRtc::CaughtUp { session } => self.put_values(Some(session), self.all_values(session)),
            FromRtc::Candidate { session, candidate } => self.send(session, &ServerMsg::Candidate { candidate }),
        }
    }

    fn refuse(&self, session: u32, text: String, alias: Option<String>) {
        warn!("screen {session}: {text}");
        self.send(session, &ServerMsg::Refused { text, alias });
    }

    fn send(&self, session: u32, msg: &ServerMsg) {
        if let Some(s) = self.sessions.get(&session) {
            s.out.send(encode(msg));
        }
    }

    fn broadcast(&self, msg: &ServerMsg) {
        if self.sessions.is_empty() {
            return;
        }
        let text = encode(msg);
        for s in self.sessions.values() {
            s.out.send(text.clone());
        }
    }

    /// Sends values to one screen, or with None to every screen. On a socket, and on the
    /// reliable channel of a screen with channels, the values small enough share a message and
    /// each larger one goes alone in its import's lane. A screen with channels gets a best
    /// effort topic's on its best effort channel, those that fit a message there.
    fn put_values(&self, to: Option<u32>, values: Vec<ValueUpdate>) {
        let seq = self.seq.get() + 1;
        self.seq.set(seq);
        let sessions: Vec<(u32, &Session)> = match to {
            Some(id) => self.sessions.get(&id).map(|s| (id, s)).into_iter().collect(),
            None => self.sessions.iter().map(|(id, s)| (*id, s)).collect(),
        };
        let each = written(values, seq);
        let socket = sessions.iter().any(|(_, s)| !s.channels).then(|| apart(each.clone(), seq));
        let channels = sessions.iter().any(|(_, s)| s.channels).then(|| ways(each, |alias| self.mesh.best_effort(alias), seq));
        for (id, s) in sessions {
            if let (false, Some((shared, alone))) = (s.channels, &socket) {
                if let Some(bytes) = shared {
                    s.out.values(bytes.clone());
                }
                for (alias, bytes) in alone {
                    s.out.alone(alias, bytes.clone());
                }
            }
            if let (true, Some(ways)) = (s.channels, &channels) {
                for (way, bytes) in ways {
                    self.rtc.send(ToRtc::Send { session: id, way: way.clone(), bytes: bytes.clone() });
                }
            }
        }
    }
}

/// A variable's value as a screen gets it: always known.
fn known(name: &str, value: &Value) -> ValueUpdate {
    ValueUpdate { alias: name.to_owned(), value: Some(value.clone()), known: true }
}

/// Each value as a message of its own, which says how big it is. A big one is written only here.
fn written(values: Vec<ValueUpdate>, seq: u64) -> Vec<(ValueUpdate, Bytes)> {
    values.into_iter().map(|v| (v.clone(), encode(&ServerMsg::Values { values: vec![v], seq }))).collect()
}

/// Values together in one message, or the one alone as it was written.
fn together(mut each: Vec<(ValueUpdate, Bytes)>, seq: u64) -> Bytes {
    match each.len() {
        1 => each.remove(0).1,
        _ => encode(&ServerMsg::Values { values: each.into_iter().map(|(v, _)| v).collect(), seq }),
    }
}

/// Values as messages for lanes: those that fit a piece together in one, and each larger one
/// alone with its import's name.
fn apart(each: Vec<(ValueUpdate, Bytes)>, seq: u64) -> (Option<Bytes>, Vec<(String, Bytes)>) {
    let (small, alone): (Vec<_>, Vec<_>) = each.into_iter().partition(|(_, bytes)| bytes.len() <= PIECE);
    ((!small.is_empty()).then(|| together(small, seq)), alone.into_iter().map(|(v, bytes)| (v.alias, bytes)).collect())
}

/// Values as messages for a screen with channels. A best effort topic's go on the best effort
/// channel, one batch when it fits a message there, else each alone. The rest, and any too big
/// for a message there, go on the reliable channel as `apart` cuts them.
fn ways(each: Vec<(ValueUpdate, Bytes)>, best_effort: impl Fn(&str) -> bool, seq: u64) -> Vec<(Way, Bytes)> {
    let (fast, rest): (Vec<_>, Vec<_>) = each.into_iter().partition(|(v, bytes)| best_effort(&v.alias) && bytes.len() <= MESSAGE_MAX);
    let mut out = Vec::new();
    if !fast.is_empty() {
        let alone: Vec<Bytes> = fast.iter().map(|(_, bytes)| bytes.clone()).collect();
        match together(fast, seq) {
            batch if batch.len() <= MESSAGE_MAX => out.push((Way::BestEffort, batch)),
            _ => out.extend(alone.into_iter().map(|bytes| (Way::BestEffort, bytes))),
        }
    }
    let (shared, alone) = apart(rest, seq);
    out.extend(shared.map(|bytes| (Way::Values, bytes)));
    out.extend(alone.into_iter().map(|(alias, bytes)| (Way::Alone(alias), bytes)));
    out
}

/// Each record's source by name, as the engine reads them.
fn sources(records: &[Record]) -> Vec<(String, String)> {
    records.iter().map(|r| (r.name.clone(), r.source.clone())).collect()
}

/// Now, as Unix time.
fn since_epoch() -> Duration {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(alias: &str, value: Value) -> ValueUpdate {
        ValueUpdate { alias: alias.into(), value: Some(value), known: true }
    }

    #[test]
    fn a_value_too_big_to_share_goes_alone() {
        let (shared, alone) = apart(written(vec![update("Speed", Value::Float(1.5)), update("Cam", Value::Bytes(vec![0; PIECE]))], 1), 1);
        assert!(shared.is_some());
        assert_eq!(alone.iter().map(|(alias, _)| alias.as_str()).collect::<Vec<_>>(), vec!["Cam"]);
    }

    #[test]
    fn a_screen_with_channels_gets_a_best_effort_topic_s_there_and_the_rest_reliably() {
        let kinds = |values: Vec<ValueUpdate>| -> Vec<String> {
            ways(written(values, 1), |alias| alias.starts_with("Fast"), 1)
                .into_iter()
                .map(|(way, _)| match way {
                    Way::BestEffort => "best effort".into(),
                    Way::Values => "values".into(),
                    Way::Alone(alias) => alias,
                    Way::Control => "control".into(),
                })
                .collect()
        };
        let joints = update("FastJoints", Value::Float(1.0));
        let picture = update("FastCam", Value::Bytes(vec![0; MESSAGE_MAX]));
        let note = update("note", Value::Float(2.0));
        assert_eq!(kinds(vec![joints.clone(), note.clone()]), vec!["best effort", "values"]);
        // too big for a message on the best effort channel, so it goes in pieces on the other
        assert_eq!(kinds(vec![joints, picture]), vec!["best effort", "FastCam"]);
        assert_eq!(kinds(vec![note]), vec!["values"]);
    }
}

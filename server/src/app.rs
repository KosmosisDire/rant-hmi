//! The backend's one loop. It owns the project, the mesh and every screen's session, so
//! nothing is shared and nothing locks.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::net::IpAddr;
use std::ops::Deref;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use rant::types::Timestamp;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

use crate::authorize::{Who, authorize};
use crate::events;
use crate::fields::Keep;
use crate::lanes::{Lanes, PIECE};
use crate::mesh::codec;
use crate::mesh::{Delivery, Mesh};
use crate::pages::logic::{Rule, When};
use crate::pages::{Edit, Pages};
use crate::project::{Computed, Import, Kind, Per, Project, Record, Target, Token, Variable};
use crate::rules;
use crate::problems::Problems;
use crate::protocol::{Base, ClientMsg, EnumInfo, Level, Reported, Sample, ServerMsg, ValueUpdate, encode, encode_plain};
use crate::script::{CallFailure, End, Form, FromScript, Script, ToScript};
use crate::status::{self, Client, HmiStatus};
use crate::value::Value;
use crate::rtc::{Connections, Frame, FromRtc, ToRtc};

/// How often a value may go to screens, the engine judges and the mesh is checked.
const TICK: Duration = Duration::from_millis(33);
/// How long the project's files stay still after a change before the HMI reads them.
const QUIET: Duration = Duration::from_millis(150);
/// A screen silent this long lets go of what it holds, so a jog never outlives its link.
const SILENCE: Duration = Duration::from_millis(500);
/// A screen silent this long is lost. A busy page stops reading its socket a while, which
/// is no reason to start it over.
const LOST: Duration = Duration::from_secs(5);
/// A big value a screen has not said it took after this long counts as taken, so a value lost
/// on the way never stops its import for good.
const TAKE_MOST: Duration = Duration::from_secs(5);
/// The bytes a second a screen that only previews values, as the editor's Data tab does, takes
/// its big ones at, so its previews leave the link to the screens that show them.
const PREVIEW_BYTES: f64 = 250_000.0;
/// How many edits a screen can undo.
const UNDO_DEPTH: usize = 200;
const HEALTH_EVERY: Duration = Duration::from_secs(1);
/// How often every screen's problems may go out, so a fault that comes each frame is one send.
const PROBLEMS_EVERY: Duration = Duration::from_millis(250);
/// How long a screen may take to open its WebRTC link channel before `Hmi/Status` warns that it
/// has none.
const WEBRTC_GRACE: Duration = Duration::from_secs(15);

/// What a screen's connection hands the loop.
pub enum Inbound {
    /// `local` is the address the screen reached the HMI on, `remote` the one it came from.
    Open { session: u32, out: Outbox, local: IpAddr, remote: IpAddr },
    Message { session: u32, msg: ClientMsg },
    /// The screen answered the socket's ping, so it is there.
    Heard { session: u32 },
    Close { session: u32 },
    /// A screen's second way, a socket or WebTransport, opened with `key`, which `ok` hears is
    /// its session's or not.
    Bulk { session: u32, key: String, out: Outbox, ok: oneshot::Sender<bool> },
    /// A screen's second way, the one with these lanes, closed.
    BulkClosed { session: u32, lanes: Arc<Lanes> },
    /// Asks for every problem, as `GET /problems` serves them.
    Problems { answer: oneshot::Sender<Vec<Reported>> },
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

    /// Every problem there is now, None once the loop is gone.
    pub async fn problems(&self) -> Option<Vec<Reported>> {
        let (answer, heard) = oneshot::channel();
        if !self.send(Inbound::Problems { answer }) {
            return None;
        }
        heard.await.ok()
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
    /// The hash of each certificate WebTransport serves with, as it begins.
    pub wt: UnboundedReceiver<String>,
}

/// A screen's socket, in lanes that take turns (`lanes.rs`), which it sends as fast as the
/// screen confirms them. They close when the screen goes.
pub struct Outbox(Arc<Lanes>);

impl Outbox {
    pub fn new(lanes: Arc<Lanes>) -> Outbox {
        Outbox(lanes)
    }

    fn is(&self, lanes: &Arc<Lanes>) -> bool {
        Arc::ptr_eq(&self.0, lanes)
    }
}

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
    /// Its socket.
    out: Outbox,
    /// Its WebRTC link channel, which carries what the socket did once it opened.
    channel: Option<Outbox>,
    /// What came on the link channel before the screen said on its socket it switched, held
    /// so nothing it did goes out of turn, None once it switched.
    held: Option<Vec<ClientMsg>>,
    /// Its second way, which brings its big values once it opened, and the key that opens it.
    bulk: Option<Outbox>,
    key: String,
    local: IpAddr,
    remote: IpAddr,
    /// When it connected.
    since: Timestamp,
    ping: Option<Duration>,
    /// How much the round trip wavers, in ms, smoothed.
    jitter: f64,
    /// Whether its WebRTC connection, for video, is open.
    webrtc: bool,
    /// The last while of round trips and of big values' trips, for `Hmi/Clients`.
    trips: Trips,
    /// When it connected, and why its WebRTC connection did not open, as it said.
    opened: Instant,
    webrtc_problem: Option<String>,
    /// The warning on the node's status that it has no WebRTC, as last raised.
    warned: Option<String>,
    /// Whether it shows every screen's problems, as the editor does.
    shows_problems: bool,
    /// What it reads of each import and computed value it shows, the steps after the name of
    /// each path, None for all of every one.
    watch: Option<HashMap<String, Vec<Vec<String>>>>,
    /// While it only previews them, when its next big value may go, as its previews keep to
    /// PREVIEW_BYTES a second.
    previews: Option<Instant>,
    /// Each import's big values, sent at most one at a time.
    gates: HashMap<String, Gate>,
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

/// One import's big values to one screen: the one on its way and since when, the newest
/// waiting for it, and the one the screen took last, which the next goes as the change from.
#[derive(Default)]
struct Gate {
    out: Option<(Instant, Rc<Big>)>,
    parked: Option<Rc<Big>>,
    held: Option<Base>,
    /// When its last went, so the imports a screen previews take turns.
    went: Option<Instant>,
    /// The last few that lapsed, each with when it went, as a slow link may still bring one
    /// whole after the next went: the screen's word that it took it makes it the base then, else
    /// a value too big to arrive in TAKE_MOST would go whole for ever.
    lapsed: VecDeque<(Instant, Rc<Big>)>,
}

/// How many lapsed values a gate keeps.
const LAPSED_KEPT: usize = 3;

/// What became of a big value on its way to a screen.
enum Fate {
    Took,
    /// The screen no longer held the value it was the change from.
    Missed,
    /// The screen never said, so it may be lost.
    Lapsed,
}

/// An import's big value as it goes to screens, written whole, and once as the change from each
/// value a screen holds, so screens that took the same share it.
struct Big {
    seq: u64,
    update: ValueUpdate,
    /// For screens on this host, which take it whole and as it is.
    plain: bool,
    whole: Bytes,
    changes: RefCell<Vec<(u64, Bytes)>>,
}

impl Big {
    /// As a screen holding `held` gets it.
    fn written(&self, held: Option<&Base>) -> Bytes {
        let Some(base) = held.filter(|_| !self.plain) else { return self.whole.clone() };
        if let Some((_, bytes)) = self.changes.borrow().iter().find(|(seq, _)| *seq == base.seq) {
            return bytes.clone();
        }
        let update = ValueUpdate { base: Some(base.clone()), ..self.update.clone() };
        let change = encode(&ServerMsg::Values { values: vec![update], seq: self.seq });
        // a change that saved nothing goes whole, which needs no base
        let bytes = if change.len() < self.whole.len() { change } else { self.whole.clone() };
        self.changes.borrow_mut().push((base.seq, bytes.clone()));
        bytes
    }
}

impl Session {
    /// Whether the screen is on this host, so its values go as they are, never compressed.
    fn here(&self) -> bool {
        self.remote.is_loopback()
    }

    /// The lanes big values go in: the second way's once it opened, else the socket's.
    fn big_way(&self) -> &Lanes {
        self.channel.as_ref().or(self.bulk.as_ref()).unwrap_or(&self.out)
    }

    /// The way it is sent what is not big values: its link channel once that opened, else its
    /// socket.
    fn way(&self) -> &Outbox {
        self.channel.as_ref().unwrap_or(&self.out)
    }

    /// Sends an import's big value, or keeps it as the newest while the last is on its way or,
    /// on a screen that previews, until its previews' bytes allow.
    fn big(&mut self, value: Rc<Big>) {
        let alias = value.update.alias.clone();
        let now = Instant::now();
        let wait = self.previews.is_some_and(|at| at > now);
        let gate = self.gates.entry(alias.clone()).or_default();
        if gate.out.is_some() || wait {
            gate.parked = Some(value);
            return;
        }
        let bytes = value.written(gate.held.as_ref());
        gate.out = Some((now, value));
        gate.went = Some(now);
        if let Some(at) = &mut self.previews {
            *at = now + Duration::from_secs_f64(bytes.len() as f64 / PREVIEW_BYTES);
        }
        self.big_way().alone(&alias, bytes);
    }

    /// Sends small values together on the socket. A big value of one still waiting is older, so
    /// it never goes after them.
    fn small(&mut self, values: Vec<ValueUpdate>, seq: u64) {
        for u in &values {
            if let Some(gate) = self.gates.get_mut(&u.alias) {
                gate.parked = None;
            }
        }
        self.way().values(together(values, seq, self.here()));
    }

    /// Sends what waits with its way free, once a previewing screen's bytes allow, the import
    /// that went longest ago first.
    fn send_parked(&mut self) {
        while self.previews.is_none_or(|at| at <= Instant::now()) {
            let next = self.gates.iter().filter(|(_, g)| g.out.is_none() && g.parked.is_some()).min_by_key(|(_, g)| g.went).map(|(a, _)| a.clone());
            let Some(value) = next.and_then(|a| self.gates.get_mut(&a)?.parked.take()) else { return };
            self.big(value);
        }
    }

    /// What became of the big value of `alias` from batch `seq` on its way, so the newest
    /// waiting goes, or after a miss the one missed again, whole. Word of one sent before is
    /// late, as after the screen let the import go, and is passed over.
    fn took(&mut self, alias: &str, seq: u64, fate: Fate) {
        let Some(gate) = self.gates.get_mut(alias) else { return };
        if gate.out.as_ref().is_none_or(|(_, sent)| sent.seq != seq) {
            if matches!(fate, Fate::Took)
                && let Some(i) = gate.lapsed.iter().position(|(_, b)| b.seq == seq)
            {
                let (went, late) = gate.lapsed.remove(i).expect("just found");
                gate.lapsed.retain(|(_, b)| b.seq > seq);
                self.trips.big(went.elapsed());
                if gate.held.as_ref().is_none_or(|h| h.seq < seq) {
                    gate.held = late.update.value.clone().map(|value| Base { seq, value });
                }
            }
            return;
        }
        let Some((went, sent)) = gate.out.take() else { return };
        match fate {
            Fate::Took => self.trips.big(went.elapsed()),
            Fate::Lapsed => {
                self.trips.lapsed += 1;
                gate.lapsed.push_back((went, sent.clone()));
                if gate.lapsed.len() > LAPSED_KEPT {
                    gate.lapsed.pop_front();
                }
            }
            Fate::Missed => {}
        }
        gate.held = match fate {
            Fate::Took => sent.update.value.clone().map(|value| Base { seq: sent.seq, value }),
            Fate::Missed | Fate::Lapsed => None,
        };
        if let Some(next) = gate.parked.take().or(matches!(fate, Fate::Missed).then_some(sent)) {
            self.big(next);
        }
    }

    /// A new round trip, and how far it was from the last.
    fn timed(&mut self, rtt: Duration) {
        if let Some(last) = self.ping {
            self.jitter += ((rtt.as_secs_f64() - last.as_secs_f64()).abs() * 1000.0 - self.jitter) / 16.0;
        }
        self.ping = Some(rtt);
        self.trips.ping(rtt);
    }
}

/// How long `Trips` keeps what it measured.
const TRIPS_FOR: Duration = Duration::from_secs(10);

/// A screen's last while: each round trip its pings took, which go the way small values do,
/// and each big value's trip, from when it went until the screen said it took it, which is what
/// that value took to arrive, be read and be shown, and the word coming back.
#[derive(Default)]
struct Trips {
    pings: VecDeque<(Instant, f64)>,
    bigs: VecDeque<(Instant, f64)>,
    /// Big values the screen never said it took, in all.
    lapsed: u32,
    /// The bytes its ways had taken, by when.
    bytes: VecDeque<(Instant, u64)>,
    /// What `Hmi/Clients` shows of them, worked out once a second, so the list changes as each
    /// ping is measured and then, not on each turn of the loop.
    shown: Shown,
}

/// A screen's last while as `Hmi/Clients` shows it.
#[derive(Clone, Copy, Default)]
struct Shown {
    pings: [f64; 3],
    bigs: [f64; 3],
    rate: f64,
    kbps: f64,
}

impl Trips {
    fn ping(&mut self, rtt: Duration) {
        Self::keep(&mut self.pings, rtt);
    }

    fn big(&mut self, trip: Duration) {
        Self::keep(&mut self.bigs, trip);
    }

    fn keep(list: &mut VecDeque<(Instant, f64)>, d: Duration) {
        let now = Instant::now();
        list.push_back((now, d.as_secs_f64() * 1000.0));
        while list.front().is_some_and(|(at, _)| now.duration_since(*at) > TRIPS_FOR) {
            list.pop_front();
        }
    }

    /// The median, the 90th percentile and the most of a list, 0 for none.
    fn spread(list: &VecDeque<(Instant, f64)>) -> [f64; 3] {
        let now = Instant::now();
        let mut v: Vec<f64> = list.iter().filter(|(at, _)| now.duration_since(*at) <= TRIPS_FOR).map(|(_, ms)| *ms).collect();
        if v.is_empty() {
            return [0.0; 3];
        }
        v.sort_by(f64::total_cmp);
        let at = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
        [at(0.5), at(0.9), at(1.0)]
    }

    /// Works out anew what `Hmi/Clients` shows, `total` the bytes its ways took by now.
    fn refresh(&mut self, total: u64) {
        let kbps = self.kbps(total);
        self.shown = Shown { pings: Self::spread(&self.pings), bigs: Self::spread(&self.bigs), rate: self.rate(), kbps };
    }

    /// Notes the bytes its ways took by now, and gives the kilobits a second over the while kept.
    fn kbps(&mut self, total: u64) -> f64 {
        let now = Instant::now();
        self.bytes.push_back((now, total));
        while self.bytes.front().is_some_and(|(at, _)| now.duration_since(*at) > TRIPS_FOR) {
            self.bytes.pop_front();
        }
        let Some((first, from)) = self.bytes.front() else { return 0.0 };
        let span = now.duration_since(*first).as_secs_f64();
        if span < 1.0 { 0.0 } else { (total.saturating_sub(*from)) as f64 * 8.0 / 1000.0 / span }
    }

    /// Big values taken a second, over the while kept.
    fn rate(&self) -> f64 {
        let now = Instant::now();
        self.bigs.iter().filter(|(at, _)| now.duration_since(*at) <= TRIPS_FOR).count() as f64 / TRIPS_FOR.as_secs_f64()
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

/// An event waiting for its screen's run of its handler to end: what it brought and the copy of
/// a repeat it happened on.
type Waiting = (Value, Option<(u32, Value)>);

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
    /// What came from each screen while its run of the handler went on, run in order as each
    /// run ends: a stream's latest event, those before gathered in, and every end, since a held
    /// input never loses its end.
    waiting: HashMap<(u32, HandlerKey), VecDeque<Waiting>>,
    /// Screens gone whose runs, or the ends waiting for them, still go on, so the engine keeps
    /// their own variables until those end.
    leaving: HashSet<u32>,
    /// When each timer rule is next due.
    timers: HashMap<String, Instant>,
    turned: HashMap<String, Turned>,
    /// Values that changed since the last tick, with what they were before.
    moved: Vec<(String, Option<Value>, Value)>,
    node: String,
    /// The client script the backend serves.
    build: String,
    /// The hash of WebTransport's certificate, while it serves.
    wt: Option<String>,
    sessions: HashMap<u32, Session>,
    /// The last batch of values sent.
    seq: Cell<u64>,
    values: HashMap<String, Slot>,
    /// Values that changed and have not gone to screens yet.
    changed: BTreeSet<String>,
    /// Values sent since the last tick began, which wait for the next to go again.
    sent: HashSet<String>,
    /// Whether a value went at once since the last tick, so the engine judges by it then.
    hurried: bool,
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
    /// Every screen's problems and those of runs here, and when they last went out.
    problems: Problems,
    problems_at: Instant,
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
            leaving: HashSet::new(),
            timers: HashMap::new(),
            turned: HashMap::new(),
            moved: Vec::new(),
            node,
            build,
            wt: None,
            sessions: HashMap::new(),
            seq: Cell::new(0),
            values: HashMap::new(),
            changed: BTreeSet::new(),
            sent: HashSet::new(),
            hurried: false,
            shared,
            history: HashMap::new(),
            sample_at: HashMap::new(),
            epoch: None,
            started_at: Timestamp::now(),
            forms: HashMap::new(),
            enums: Vec::new(),
            health_at: Instant::now(),
            edited: None,
            problems: Problems::default(),
            problems_at: Instant::now(),
        }
    }

    /// Runs until `stop` ends.
    pub async fn run(mut self, mut from: Sources, stop: impl Future<Output = ()>) {
        let mut tick = tokio::time::interval(TICK);
        self.rules_changed();
        self.run_rules(|r| matches!(r.when, When::Starts), Value::Null);
        tokio::pin!(stop);
        let mut delivered = Vec::new();
        loop {
            tokio::select! {
                // those waiting go out together, 64 at most so screens still get a turn
                1.. = from.mesh.recv_many(&mut delivered, 64) => delivered.drain(..).for_each(|d| self.deliver(d)),
                Some(i) = from.screens.recv() => self.inbound(i),
                Some(s) = from.script.recv() => self.scripted(s),
                Some(()) = from.files.recv() => self.edited = Some(Instant::now()),
                Some(r) = from.rtc.recv() => self.connection(r),
                Some(f) = from.frames.recv() => self.frame(f),
                Some(hash) = from.wt.recv() => self.wt = Some(hash),
                _ = tick.tick() => self.tick(),
                _ = &mut stop => break,
            }
            self.hurry();
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
                let key = new_key();
                self.sessions.insert(session, Session { out, channel: None, held: None, bulk: None, key, local, remote, since: Timestamp::now(), ping: None, jitter: 0.0, webrtc: false, trips: Trips::default(), opened: Instant::now(), webrtc_problem: None, warned: None, shows_problems: false, watch: None, previews: None, gates: HashMap::new(), heard: Instant::now(), undo: Vec::new(), redo: Vec::new(), vars, plays: HashSet::new(), decodes: HashSet::new() });
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
            Inbound::Bulk { session, key, out, ok } => {
                let Some(s) = self.sessions.get_mut(&session).filter(|s| s.key == key) else {
                    let _ = ok.send(false);
                    return;
                };
                let _ = ok.send(true);
                info!("screen {session} opened its second way");
                // what was on its way on one it opened before, whose close may come later, is lost
                if s.bulk.replace(out).is_some() {
                    self.again(session);
                }
            }
            Inbound::BulkClosed { session, lanes } => {
                // one opened since takes its place
                let Some(s) = self.sessions.get_mut(&session).filter(|s| s.bulk.as_ref().is_some_and(|b| b.is(&lanes))) else { return };
                s.bulk = None;
                info!("screen {session} lost its second way");
                self.again(session);
            }
            Inbound::Problems { answer } => {
                let _ = answer.send(self.problems.all());
            }
        }
    }

    /// Sends a screen each value again, as the big ones on their way on a second way it lost may
    /// be lost too.
    fn again(&mut self, session: u32) {
        if let Some(s) = self.sessions.get_mut(&session) {
            s.gates.clear();
        }
        self.put_values(Some(session), self.all_values(session));
    }

    /// Everything a screen needs to draw, in one go.
    fn welcome(&mut self, session: u32) {
        let hello = ServerMsg::Hello {
            session,
            project: self.project.info.clone(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            node: self.node.clone(),
            build: self.build.clone(),
            key: self.sessions.get(&session).map(|s| s.key.clone()).unwrap_or_default(),
            wt: self.wt.clone(),
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

    /// The names a screen may leave out by what it shows: the imports and computed values.
    fn watched(&self) -> impl Iterator<Item = &String> {
        self.project.imports.iter().map(|i| &i.alias).chain(self.project.computed.iter().map(|c| &c.name))
    }

    /// Every value a screen shows: the imports', the computed ones', the shared variables' and
    /// its own.
    fn all_values(&self, session: u32) -> Vec<ValueUpdate> {
        let mut values: Vec<ValueUpdate> = self.watched().map(|name| self.update(name)).collect();
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
            ClientMsg::Switch => {
                let Some(held) = self.sessions.get_mut(&session).and_then(|s| s.held.take()) else { return };
                for msg in held {
                    self.handle(session, msg);
                }
            }
            ClientMsg::Unswitch => self.channel_closed(session),
            ClientMsg::WebrtcProblem { problem } => {
                let Some(s) = self.sessions.get_mut(&session) else { return };
                if let Some(p) = &problem {
                    warn!("screen {session} has no WebRTC: {}", status::webrtc_problem_words(p));
                }
                s.webrtc_problem = problem.map(|p| p.chars().take(24).collect());
            }
            ClientMsg::Problems { problems, every } => {
                self.problems.screen(session, problems);
                let Some(s) = self.sessions.get_mut(&session) else { return };
                // one that just asked hears them at once, the rest as they change
                let asked = every && !s.shows_problems;
                s.shows_problems = every;
                if asked {
                    self.send(session, &ServerMsg::Problems { problems: self.problems.all() });
                }
            }
            ClientMsg::Ping { t, rtt } => {
                let Some(s) = self.sessions.get_mut(&session) else { return };
                if let Some(rtt) = rtt.filter(|r| r.is_finite() && *r >= 0.0) {
                    s.timed(Duration::from_secs_f64(rtt / 1000.0));
                }
                s.way().pong(encode(&ServerMsg::Pong { t }));
            }
            ClientMsg::Candidate { candidate } => {
                self.rtc.send(ToRtc::Candidate { session, candidate });
            }
            ClientMsg::Play { offer, mut videos } => {
                let plays = self.with_video(session, videos.iter().map(|v| v.alias.clone()));
                videos.retain(|v| plays.contains(&v.alias));
                let Some(s) = self.sessions.get_mut(&session) else { return };
                s.plays = plays;
                let local = s.local;
                self.watch(session);
                self.rtc.send(ToRtc::Play { session, sdp: offer, videos, local, ice: self.project.info.ice.clone() });
            }
            ClientMsg::Watch { reads, previews } => {
                let reads = reads.map(|paths| {
                    let mut by_name: HashMap<String, Vec<Vec<String>>> = HashMap::new();
                    for p in paths {
                        if let Some((name, steps)) = p.split_first() {
                            by_name.entry(name.clone()).or_default().push(steps.to_vec());
                        }
                    }
                    by_name
                });
                let names: Vec<String> = self.watched().cloned().collect();
                let Some(s) = self.sessions.get_mut(&session) else { return };
                // what it reads differently from now comes at once where it still shows it
                let changed: Vec<String> = names.into_iter().filter(|n| read_of(&s.watch, n) != read_of(&reads, n)).collect();
                s.watch = reads;
                s.previews = previews.then(|| s.previews.unwrap_or_else(Instant::now));
                // the screen lets go of what it no longer shows or reads otherwise, so that comes whole
                if let Some(w) = &s.watch {
                    s.gates.retain(|alias, _| w.contains_key(alias));
                }
                for n in &changed {
                    s.gates.remove(n);
                }
                let shown: Vec<&String> = changed.iter().filter(|n| read_of(&s.watch, n).is_some()).collect();
                let values = shown.into_iter().filter(|n| self.values.contains_key(*n)).map(|n| self.update(n)).collect();
                self.put_values(Some(session), values);
            }
            ClientMsg::Took { alias, seq, missed } => {
                if missed {
                    debug!("screen {session} says it no longer held what {alias} changed from");
                }
                if let Some(s) = self.sessions.get_mut(&session) {
                    s.took(&alias, seq, if missed { Fate::Missed } else { Fate::Took });
                }
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

    /// Runs the element's handler `of` names, unless the screen's run of it from before goes on.
    /// Then a stream's event and an end wait for it, while a one off start is dropped. Each
    /// screen runs its own, so one never drops another's. `at` is the copy of a repeat it
    /// happened on, its index and item.
    fn fire(&mut self, session: u32, of: HandlerKey, payload: Value, at: Option<(u32, Value)>) {
        let Some(e) = self.pages.element(&of.page, &of.id) else { return };
        let Some(h) = e.handlers.iter().find(|h| h.event == of.event && h.filter == of.filter) else { return };
        if self.runs.values().any(|r| r.of == of && r.session == Some(session)) {
            let stream = !events::find(&of.event).is_some_and(|e| e.once);
            let end = events::ended_by(&of.event).is_some();
            if !stream && !end {
                return;
            }
            let queue = self.waiting.entry((session, of.clone())).or_default();
            match queue.back_mut() {
                // a stream's events on the same copy gather in, so no move is lost
                Some((was, a)) if stream && a.as_ref().map(|a| a.0) == at.as_ref().map(|a| a.0) => *was = events::gather(&of.event, was, payload),
                _ => queue.push_back((payload, at)),
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
                let script = self.script.clone();
                let progress = move |value| script.send(ToScript::Progress { call, value });
                match self.mesh.call(&alias, &request, call, progress) {
                    Ok(answer) => {
                        let script = self.script.clone();
                        tokio::spawn(async move { script.send(ToScript::Answer { call, outcome: answer.await }) });
                    }
                    Err(message) => self.script.send(ToScript::Answer { call, outcome: Err(CallFailure { status: "no_provider".into(), message }) }),
                }
            }
            FromScript::Cancel { run, alias, call } => {
                info!("{} cancels {}{alias}", self.label(run), if call.is_some() { "a call of " } else { "every call of " });
                if let Err(text) = self.mesh.cancel(&alias, call) {
                    self.tell(run, Level::Fault, text);
                }
            }
            FromScript::Send { run, alias, value } => {
                info!("{} sends {value} on {alias}", self.label(run));
                if let Err(text) = self.mesh.send(&alias, &value) {
                    self.tell(run, Level::Fault, text);
                }
            }
            FromScript::Notify { run, text } => self.tell(run, Level::Info, text),
            FromScript::Fault { run, text } => self.tell(run, Level::Fault, text),
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
                // the first of what waited for this run goes now, while its screen is here, and an
                // end even once it went, as a held input never loses its end
                let Some(r) = self.runs.remove(&run) else { return };
                let Some(session) = r.session else { return };
                let key = (session, r.of);
                let goes = self.sessions.contains_key(&session) || events::ended_by(&key.1.event).is_some();
                let next = self.waiting.get_mut(&key).and_then(VecDeque::pop_front);
                if !goes || self.waiting.get(&key).is_some_and(VecDeque::is_empty) {
                    self.waiting.remove(&key);
                }
                if let Some((payload, at)) = next.filter(|_| goes) {
                    self.fire(session, key.1, payload, at);
                }
                self.forget(session);
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
    fn tell(&mut self, run: u64, level: Level, text: String) {
        let Some(r) = self.runs.get(&run) else { return };
        let text = if matches!(level, Level::Info) { text } else { format!("{}: {text}", r.label) };
        if !matches!(level, Level::Info) {
            // a rule's handler key names no page, only the rule
            let (page, element) = if r.of.page.is_empty() { (None, None) } else { (Some(r.of.page.clone()), Some(r.of.id.clone())) };
            self.problems.ran(level, text.clone(), page, element);
        }
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
        let held: Vec<String> = std::mem::take(&mut self.changed).into_iter().collect();
        self.flush(&held);
        // the engine has the new values before it judges by them
        if std::mem::take(&mut self.hurried) || !held.is_empty() {
            self.rethink();
        }
        self.sent = held.into_iter().collect();
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
        self.publish_problems();
        if self.health_at.elapsed() >= HEALTH_EVERY {
            self.health_at = Instant::now();
            self.broadcast(&ServerMsg::Health { peers: self.mesh.peers() });
            for s in self.sessions.values_mut() {
                let total = s.out.taken() + s.bulk.as_ref().map_or(0, |b| b.taken()) + s.channel.as_ref().map_or(0, |c| c.taken());
                s.trips.refresh(total);
            }
            self.publish_status();
        }
        for (id, s) in &mut self.sessions {
            let late: Vec<(String, u64)> = s.gates.iter().filter_map(|(a, g)| g.out.as_ref().filter(|(t, _)| t.elapsed() > TAKE_MOST).map(|(_, b)| (a.clone(), b.seq))).collect();
            for (alias, seq) in late {
                warn!("screen {id} never said it took {alias}, so the next goes");
                s.took(&alias, seq, Fate::Lapsed);
            }
            s.send_parked();
        }
        let missed: Vec<u32> = self.sessions.iter().filter(|(_, s)| s.way().missed()).map(|(id, _)| *id).collect();
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

    /// Sends each changed value at once, but one sent since the last tick began waits for the
    /// next, so a value that changes fast still goes once a tick.
    fn hurry(&mut self) {
        let due: Vec<String> = self.changed.extract_if(.., |alias| !self.sent.contains(alias)).collect();
        self.hurried |= !due.is_empty();
        self.flush(&due);
    }

    /// Sends these values to every screen and to the engine.
    fn flush(&mut self, aliases: &[String]) {
        if aliases.is_empty() {
            return;
        }
        let values: Vec<ValueUpdate> = aliases.iter().map(|a| self.update(a)).collect();
        self.script.send(ToScript::Values(values.iter().map(|v| (v.alias.clone(), v.value.clone().filter(|_| v.known))).collect()));
        self.put_values(None, values);
        self.sent.extend(aliases.iter().cloned());
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
                kbps: s.trips.shown.kbps,
                id: *id,
                address: s.remote.to_string().as_str().try_into().unwrap_or_default(),
                connected_at: s.since,
                ping_ms: s.ping.map_or(0.0, |p| p.as_secs_f64() * 1000.0),
                jitter_ms: s.jitter,
                webrtc: s.webrtc,
                channel: s.channel.is_some() && s.held.is_none(),
                ping_spread_ms: s.trips.shown.pings,
                big_spread_ms: s.trips.shown.bigs,
                bigs_per_s: s.trips.shown.rate,
                lapsed: s.trips.lapsed,
                webrtc_problem: s.webrtc_problem.as_deref().unwrap_or("").try_into().unwrap_or_default(),
            })
            .collect();
        clients.sort_by_key(|c| c.id);
        self.mesh.publish_clients(clients);
    }

    /// Sends every problem to the screens that show them and publishes them on the mesh, once
    /// they changed, at most every PROBLEMS_EVERY.
    fn publish_problems(&mut self) {
        if self.problems_at.elapsed() < PROBLEMS_EVERY || !self.problems.take_changed() {
            return;
        }
        self.problems_at = Instant::now();
        let msg = ServerMsg::Problems { problems: self.problems.all() };
        for (id, s) in &self.sessions {
            if s.shows_problems {
                self.send(*id, &msg);
            }
        }
        self.mesh.publish_problems(self.problems.rows());
    }

    /// Publishes the HMI's own state on the mesh, once that changed.
    fn publish_status(&mut self) {
        let missing = self.project.imports.iter().filter(|i| !self.mesh.live(i)).filter_map(|i| i.entity.as_str().try_into().ok()).collect();
        let status = HmiStatus { version: env!("CARGO_PKG_VERSION").into(), project: self.project.info.name.clone(), started_at: self.started_at, clients: self.sessions.len() as u32, missing };
        self.mesh.publish_status(status);
        self.warn_webrtc();
    }

    /// Keeps a warning on the node's Rant status for each screen with no WebRTC link channel,
    /// past the while it may take to open, and why, as the screen found. A screen on this host
    /// keeps to its socket, as near, so it is never warned of.
    fn warn_webrtc(&mut self) {
        for (id, s) in &mut self.sessions {
            let text = (!s.here() && s.channel.is_none() && s.opened.elapsed() >= WEBRTC_GRACE).then(|| {
                let why = s.webrtc_problem.as_deref().map_or("it has not said why", status::webrtc_problem_words);
                format!("Screen {id} ({}) has no WebRTC connection, so its latency is increased: {why}", s.remote)
            });
            if text != s.warned {
                self.mesh.screen_warning(*id, text.as_deref());
                s.warned = text;
            }
        }
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
            base: None,
        }
    }

    /// Ends a screen's session, which closes its socket. Its pages answer nothing, what it held
    /// pressed is let go, and the rules for a lost screen run.
    fn end(&mut self, session: u32, why: &str) {
        if let Some(s) = self.sessions.remove(&session) {
            info!("screen {session} {why}");
            if s.warned.is_some() {
                self.mesh.screen_warning(session, None);
            }
            self.problems.gone(session);
            self.leaving.insert(session);
            self.watch(session);
            self.rtc.send(ToRtc::Unlink { session });
            // a page the screen showed answers nothing, so no handler waits on it for ever
            let asked: Vec<u64> = self.asks.iter().filter(|(_, s)| **s == session).map(|(ask, _)| *ask).collect();
            for ask in asked {
                self.asks.remove(&ask);
                self.script.send(ToScript::Answer { call: ask, outcome: Ok(Value::Null) });
            }
            self.let_go(session, why);
            self.forget(session);
            self.run_rules(|r| matches!(r.when, When::Leaves), Value::map([("screen", session.into())]));
        }
    }

    /// Lets the engine drop a gone screen's own variables, once nothing of its runs goes on.
    fn forget(&mut self, session: u32) {
        let busy = self.runs.values().any(|r| r.session == Some(session)) || self.waiting.keys().any(|(s, _)| *s == session);
        if !busy && self.leaving.remove(&session) {
            self.script.send(ToScript::Gone(session));
        }
    }

    /// A screen's WebRTC connection closed, and its videos with it.
    fn unlinked(&mut self, session: u32) {
        let Some(s) = self.sessions.get_mut(&session) else { return };
        s.webrtc = false;
        s.plays.clear();
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
            FromRtc::Answer { session, sdp } => self.send(session, &ServerMsg::Video { answer: sdp }),
            FromRtc::Linked { session, open: true } => {
                if let Some(s) = self.sessions.get_mut(&session) {
                    s.webrtc = true;
                }
            }
            FromRtc::Linked { session, open: false } => self.unlinked(session),
            FromRtc::Candidate { session, candidate } => self.send(session, &ServerMsg::Candidate { candidate }),
            FromRtc::Channel { session, lanes } => {
                let Some(s) = self.sessions.get_mut(&session) else { return lanes.close() };
                // a screen on this host has its socket as near, and reads big values off its
                // main thread there
                if s.here() {
                    return lanes.close();
                }
                // the marker goes last on the way in use, so the screen reads what came there first
                s.way().send(encode(&ServerMsg::Switched));
                s.channel = Some(Outbox::new(lanes));
                s.held = Some(Vec::new());
            }
            FromRtc::Message { session, msg } => {
                let Some(s) = self.sessions.get_mut(&session) else { return };
                s.heard = Instant::now();
                match &mut s.held {
                    Some(held) => held.push(msg),
                    None => self.handle(session, msg),
                }
            }
            FromRtc::ChannelClosed { session } => self.channel_closed(session),
        }
    }

    /// The link channel broke, so the socket carries all again. What was on its way there may be
    /// lost, so the screen gets every value again, big ones whole.
    fn channel_closed(&mut self, session: u32) {
        let Some(s) = self.sessions.get_mut(&session) else { return };
        if s.channel.take().is_none() {
            return;
        }
        s.held = None;
        s.gates.clear();
        info!("screen {session} goes back to its socket");
        self.put_values(Some(session), self.all_values(session));
    }

    fn refuse(&self, session: u32, text: String, alias: Option<String>) {
        warn!("screen {session}: {text}");
        self.send(session, &ServerMsg::Refused { text, alias });
    }

    fn send(&self, session: u32, msg: &ServerMsg) {
        if let Some(s) = self.sessions.get(&session) {
            s.way().send(encode(msg));
        }
    }

    fn broadcast(&self, msg: &ServerMsg) {
        if self.sessions.is_empty() {
            return;
        }
        let text = encode(msg);
        for s in self.sessions.values() {
            s.way().send(text.clone());
        }
    }

    /// Sends values to one screen, or with None to every screen, those of them it shows. The
    /// small ones share a message and each big one goes alone in its import's lane, on the
    /// second way once it opened, one at a time until the screen took the last, and as the
    /// change from that. A screen that previews takes big ones at PREVIEW_BYTES a second. A
    /// screen on this host gets them whole and as they are, any other compressed. An import's
    /// value keeps only the fields the screen reads, written once for screens that read the same.
    fn put_values(&mut self, to: Option<u32>, values: Vec<ValueUpdate>) {
        if values.is_empty() {
            return;
        }
        let seq = self.seq.get() + 1;
        self.seq.set(seq);
        let ids: Vec<u32> = match to {
            Some(id) => vec![id],
            None => self.sessions.keys().copied().collect(),
        };
        let leaves: HashSet<String> = self.watched().cloned().collect();
        let mut each: HashMap<(bool, &str, Keep), Written> = HashMap::new();
        for id in ids {
            let Some(s) = self.sessions.get_mut(&id) else { continue };
            let here = s.here();
            let mut small = Vec::new();
            let mut big = Vec::new();
            for v in &values {
                let read = read_of(&s.watch, &v.alias);
                if leaves.contains(&v.alias) && read.is_none() {
                    continue;
                }
                let keep = match (read, self.mesh.shapes(&v.alias)) {
                    (Some(paths), Some(shapes)) => Keep::typed(shapes, paths),
                    _ => Keep::All,
                };
                let w = each.entry((here, &v.alias, keep)).or_insert_with_key(|(_, _, keep)| {
                    let update = ValueUpdate { value: v.value.as_ref().map(|x| keep.cut(x)), ..v.clone() };
                    written(update, seq, here)
                });
                match w {
                    Written::Small(u) => small.push(u.clone()),
                    Written::Big(b) => big.push(b.clone()),
                }
            }
            if !small.is_empty() {
                s.small(small, seq);
            }
            for b in big {
                s.big(b);
            }
        }
    }
}

/// A variable's value as a screen gets it: always known.
fn known(name: &str, value: &Value) -> ValueUpdate {
    ValueUpdate { alias: name.to_owned(), value: Some(value.clone()), known: true, base: None }
}

/// A value small enough to share a message with others, or a big one, which goes alone.
enum Written {
    Small(ValueUpdate),
    Big(Rc<Big>),
}

/// A value as a message of its own, which says how big it is, `plain` for a screen on this host.
fn written(v: ValueUpdate, seq: u64, plain: bool) -> Written {
    let msg = ServerMsg::Values { values: vec![v.clone()], seq };
    let whole = if plain { encode_plain(&msg) } else { encode(&msg) };
    match whole.len() <= PIECE {
        true => Written::Small(v),
        false => Written::Big(Rc::new(Big { seq, update: v, plain, whole, changes: RefCell::default() })),
    }
}

/// What a screen's watch reads of `name`: the steps after it of each path, all of it with no
/// watch, or None while the screen does not show it.
fn read_of<'a>(watch: &'a Option<HashMap<String, Vec<Vec<String>>>>, name: &str) -> Option<&'a [Vec<String>]> {
    const WHOLE: &[Vec<String>] = &[Vec::new()];
    match watch {
        None => Some(WHOLE),
        Some(w) => w.get(name).map(Vec::as_slice),
    }
}

/// Small values together in one message.
fn together(values: Vec<ValueUpdate>, seq: u64, plain: bool) -> Bytes {
    let msg = ServerMsg::Values { values, seq };
    if plain { encode_plain(&msg) } else { encode(&msg) }
}

/// A new key for a screen's second way, which only that screen hears.
fn new_key() -> String {
    let mut key = [0u8; 16];
    if getrandom::fill(&mut key).is_err() {
        warn!("no random key for a screen's second way");
    }
    key.iter().map(|b| format!("{b:02x}")).collect()
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
    use crate::value::{Num, Numbers, Records};

    fn update(alias: &str, value: Value) -> ValueUpdate {
        ValueUpdate { alias: alias.into(), value: Some(value), known: true, base: None }
    }

    /// A big value whose message is `size` bytes of `first`, which goes whole when `plain`.
    fn sized(alias: &str, first: u8, size: usize, plain: bool) -> Rc<Big> {
        Rc::new(Big { seq: first.into(), update: update(alias, Value::Int(first.into())), plain, whole: Bytes::from(vec![first; size]), changes: RefCell::default() })
    }

    fn big(alias: &str, first: u8) -> Rc<Big> {
        sized(alias, first, 10, false)
    }

    fn session(remote: IpAddr) -> Session {
        let out = Outbox::new(Arc::new(Lanes::default()));
        Session { out, channel: None, held: None, bulk: None, key: new_key(), local: remote, remote, since: Timestamp::now(), ping: None, jitter: 0.0, webrtc: false, trips: Trips::default(), opened: Instant::now(), webrtc_problem: None, warned: None, shows_problems: false, watch: None, previews: None, gates: HashMap::new(), heard: Instant::now(), undo: Vec::new(), redo: Vec::new(), vars: HashMap::new(), plays: HashSet::new(), decodes: HashSet::new() }
    }

    /// The messages waiting in `lanes`, each joined from its pieces.
    fn sent(lanes: &Lanes) -> Vec<Vec<u8>> {
        let mut joining: HashMap<u16, Vec<u8>> = HashMap::new();
        let mut out = Vec::new();
        while let Some(piece) = lanes.take(true) {
            let message = joining.entry(u16::from_le_bytes([piece[0], piece[1]])).or_default();
            message.extend_from_slice(&piece[3..]);
            if piece[2] == 0 {
                out.push(std::mem::take(message));
            }
        }
        out
    }

    /// The big values waiting in `lanes`, each as its first byte.
    fn waiting(lanes: &Lanes) -> Vec<u8> {
        sent(lanes).iter().map(|m| m[0]).collect()
    }

    #[test]
    fn a_big_value_goes_once_the_screen_took_the_last_and_only_the_newest_waits() {
        let mut s = session(IpAddr::from([10, 0, 0, 2]));
        s.big(big("Cam", 1));
        s.big(big("Cam", 2));
        s.big(big("Cam", 3));
        // another import's goes beside it
        s.big(big("Map", 9));
        assert_eq!(waiting(&s.out), vec![1, 9]);
        s.took("Cam", 1, Fate::Took);
        assert_eq!(waiting(&s.out), vec![3]);
        s.took("Cam", 3, Fate::Took);
        assert!(waiting(&s.out).is_empty());
        s.big(big("Cam", 4));
        assert_eq!(waiting(&s.out), vec![4]);
        // one never said taken may be lost, so the next goes without it
        s.big(big("Cam", 5));
        s.took("Cam", 4, Fate::Lapsed);
        assert_eq!(waiting(&s.out), vec![5]);
        assert!(s.gates["Cam"].held.is_none());
        // word of it taken after all is late, and lets nothing more go
        s.big(big("Cam", 6));
        s.took("Cam", 4, Fate::Took);
        assert!(waiting(&s.out).is_empty());
        s.took("Cam", 5, Fate::Took);
        assert_eq!(waiting(&s.out), vec![6]);
    }

    #[test]
    fn a_small_value_leaves_an_older_big_one_waiting_unsent() {
        let mut s = session(IpAddr::from([10, 0, 0, 2]));
        s.big(big("Cam", 1));
        s.big(big("Cam", 2));
        s.small(vec![update("Cam", Value::Int(3))], 3);
        s.took("Cam", 1, Fate::Took);
        let went = waiting(&s.out);
        assert!(went.len() == 2 && went.contains(&1) && !went.contains(&2), "{went:?}");
    }

    #[test]
    fn a_screen_that_previews_takes_its_big_values_in_turns_at_a_rate_in_bytes() {
        let mut s = session(IpAddr::from([10, 0, 0, 2]));
        s.previews = Some(Instant::now());
        // each takes a second of the previews' bytes
        let second = PREVIEW_BYTES as usize;
        s.big(sized("Cam", 1, second, true));
        s.big(sized("Map", 9, second, true));
        assert_eq!(waiting(&s.out), vec![1]);
        s.took("Cam", 1, Fate::Took);
        s.big(sized("Cam", 2, second, true));
        s.send_parked();
        assert!(waiting(&s.out).is_empty());
        // once the bytes allow, the import that went longest ago goes first
        s.previews = Some(Instant::now());
        s.send_parked();
        assert_eq!(waiting(&s.out), vec![9]);
        // a screen that stops previewing gets at once what waits with its way free
        s.previews = None;
        s.send_parked();
        assert_eq!(waiting(&s.out), vec![2]);
    }

    #[test]
    fn big_values_take_the_second_socket_once_it_opened() {
        let mut s = session(IpAddr::from([10, 0, 0, 2]));
        let second = Arc::new(Lanes::default());
        s.bulk = Some(Outbox::new(second.clone()));
        s.big(big("Cam", 1));
        assert!(waiting(&s.out).is_empty());
        assert_eq!(waiting(&second), vec![1]);
    }

    /// A cloud of a point each number, at places no two numbers share, so it barely compresses.
    fn cloud(ids: std::ops::Range<u32>) -> Value {
        let at = |id: u32, k: u32| ((id.wrapping_mul(2_654_435_761) ^ k.wrapping_mul(40_503)) % 100_000) as f32 / 100.0;
        let column = |k| Value::Numbers(Numbers::new(Num::F32, ids.clone().flat_map(|id| at(id, k).to_le_bytes()).collect::<Vec<u8>>()).unwrap());
        let points = Records::new(ids.len(), vec![("x".into(), column(1)), ("y".into(), column(2)), ("z".into(), column(3))]).unwrap();
        Value::map([("points", Value::Records(points))])
    }

    /// The base a big value's message says it is the change from.
    fn base_of(message: &[u8]) -> Option<u64> {
        use ciborium::Value as C;
        let field = |m: &C, k: &str| m.as_map()?.iter().find(|(f, _)| f.as_text() == Some(k)).map(|(_, v)| v.clone());
        let msg = ciborium::from_reader::<C, _>(message).unwrap();
        let update = field(&msg, "values")?.as_array()?[0].clone();
        field(&update, "base")?.as_integer().map(|n| u64::try_from(n).unwrap())
    }

    #[test]
    fn a_big_value_goes_as_the_change_from_the_one_the_screen_took_and_whole_after_a_miss() {
        let each = |seq, v| match written(update("Scan", v), seq, false) {
            Written::Big(b) => b,
            Written::Small(_) => panic!("a cloud too small to go alone"),
        };
        // each moves on 100 points
        let (one, two, three) = (each(1, cloud(0..4000)), each(2, cloud(100..4100)), each(3, cloud(200..4200)));
        let mut s = session(IpAddr::from([10, 0, 0, 2]));
        s.big(one.clone());
        assert_eq!(sent(&s.out), vec![one.whole.to_vec()]);
        s.big(two.clone());
        s.took("Scan", 1, Fate::Took);
        let change = sent(&s.out).remove(0);
        assert_eq!(base_of(&change), Some(1));
        assert!(change.len() * 10 < two.whole.len(), "a change of {} bytes against {} whole", change.len(), two.whole.len());
        // a screen that no longer held the first gets the second again whole
        s.took("Scan", 2, Fate::Missed);
        assert_eq!(sent(&s.out), vec![two.whole.to_vec()]);
        s.took("Scan", 2, Fate::Took);
        s.big(three.clone());
        assert_eq!(base_of(&sent(&s.out).remove(0)), Some(2));
        // a screen that took the same shares the change, and one on this host gets it whole
        let mut other = session(IpAddr::from([10, 0, 0, 3]));
        other.gates.insert("Scan".into(), Gate { held: s.gates["Scan"].held.clone(), ..Gate::default() });
        other.big(three.clone());
        assert_eq!(three.changes.borrow().len(), 1);
        let here = match written(update("Scan", cloud(200..4200)), 3, true) {
            Written::Big(b) => b,
            Written::Small(_) => panic!("a cloud too small to go alone"),
        };
        assert_eq!(here.written(s.gates["Scan"].held.as_ref()), here.whole);
    }

    #[test]
    fn a_screen_on_this_host_gets_values_as_they_are() {
        assert!(session(IpAddr::from([127, 0, 0, 1])).here());
        assert!(!session(IpAddr::from([192, 168, 1, 7])).here());
    }

    #[test]
    fn a_value_too_big_to_share_goes_alone() {
        assert!(matches!(written(update("Speed", Value::Float(1.5)), 1, false), Written::Small(_)));
        assert!(matches!(written(update("Cam", Value::Bytes(vec![0; PIECE])), 1, false), Written::Big(_)));
    }
}

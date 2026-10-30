//! Computed values, conditions and records, worked out on threads of their own apart from the
//! handlers, so code that runs long holds up neither a press nor the rest.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rquickjs::{Context, Function, Persistent, Runtime};
use tokio::sync::mpsc::UnboundedSender;

use super::{FromScript, MEMORY, Read, Reader, Rewriter, Shared, Source, Watchdog, from_js, make_reader};
use crate::logic::When;
use crate::object::{self, Flat, owner};
use crate::protocol::{EnumInfo, Level};
use crate::rules::RATE;
use crate::value::Value;

/// How early a computed value or a condition may start before its period passed, as asks come
/// each tick of the backend and a tick wanders a little. Half a tick.
const EARLY: Duration = Duration::from_millis(16);

/// What gives a computed value or a condition its time, and a record its, in words.
const RATED: &str = "its rate gives it";
const SAMPLED: &str = "between its samples";

/// How many threads work them out: as many as the machine has besides the backend's loop and
/// the handlers, from two to four.
pub(super) fn workers() -> usize {
    std::thread::available_parallelism().map_or(2, |n| n.get()).saturating_sub(2).clamp(2, 4)
}

/// The time between two workings out at `rate` a second, the most each may take.
fn period(rate: Option<u16>) -> Duration {
    Duration::from_secs_f64(1.0 / f64::from(rate.unwrap_or(RATE.1).max(1)))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Sort {
    Computed,
    Condition,
    Record,
}

/// Expressions of one sort, as computed values or conditions, each worked out again only once
/// something it read changed, or each time while it reads the clock, at its rate at the most.
#[derive(Default)]
struct Watched {
    /// What each read, by its name. One not here was not worked out since the objects changed.
    read: HashMap<String, Read>,
    stale: HashSet<String>,
    started: HashMap<String, Instant>,
}

impl Watched {
    fn changed(&mut self, key: &str) {
        for (name, read) in &self.read {
            if read.keys.contains(key) {
                self.stale.insert(name.clone());
            }
        }
    }

    fn due(&self, name: &str) -> bool {
        self.stale.contains(name) || self.read.get(name).is_none_or(|r| r.clock)
    }

    /// Whether its period passed since it last started.
    fn ready(&self, name: &str, period: Duration) -> bool {
        self.started.get(name).is_none_or(|t| t.elapsed() + EARLY >= period)
    }

    fn worked(&mut self, name: &str, read: Read, started: Instant) {
        self.stale.remove(name);
        self.read.insert(name.to_owned(), read);
        self.started.insert(name.to_owned(), started);
    }

    fn forget(&mut self) {
        self.read.clear();
        self.stale.clear();
        self.started.clear();
    }
}

/// One being worked out: whether it knew nothing of what it reads, and each key that changed
/// since it started.
struct Flight {
    blind: bool,
    changed: HashSet<String>,
}

/// What a worker is given to work out.
struct Job {
    sort: Sort,
    key: String,
    epoch: u64,
    limit: Duration,
    /// Whether it waited over its limit for a worker, other than on its first run since the
    /// code changed, which waits on new readers.
    late: bool,
}

/// What the workers share: what there is to work out, the values it reads, and what is due.
#[derive(Default)]
struct Board {
    closed: bool,
    /// Counts the changes of the objects and enums, so what older code worked out is let go.
    epoch: u64,
    objects: Vec<object::Object>,
    enums: Vec<EnumInfo>,
    pages: Vec<(String, String)>,
    /// What each sort works out, by its key or a rule's id, in the objects' order.
    sources: [Vec<Source>; 3],
    computed: HashSet<String>,
    /// How long each may run at a time.
    limits: HashMap<String, Duration>,
    values: HashMap<String, Arc<Value>>,
    getters: Watched,
    conditions: Watched,
    /// The records due, in the order they fell due, and those sampled since the code changed.
    sample: Vec<String>,
    sampled: HashSet<String>,
    flying: HashMap<String, Flight>,
    /// Since when each that may start waited for a worker.
    queued: HashMap<String, Instant>,
    /// Those whose last run knew nothing of what they read, which go again at once once due.
    again: HashSet<String>,
    /// The keys whose value each worker has yet to take.
    dirty: Vec<HashSet<String>>,
}

impl Board {
    fn load(&mut self, list: &[object::Object]) {
        let flat = Flat::of(list);
        let own = |key: &str| Some(owner(key).to_owned());
        self.sources = [
            flat.computed.iter().map(|c| (c.name.clone(), own(&c.name), format!("() => ({}\n)", c.get))).collect(),
            flat.rules
                .iter()
                .filter_map(|(o, r)| match &r.when {
                    When::Turns { condition, .. } => Some((r.id.clone(), Some(o.clone()), format!("() => !!({condition}\n)"))),
                    _ => None,
                })
                .collect(),
            flat.records.iter().map(|r| (r.name.clone(), own(&r.name), format!("() => ({}\n)", r.source))).collect(),
        ];
        let rated = flat.rules.iter().filter_map(|(_, r)| match &r.when {
            When::Turns { rate, .. } => Some((r.id.clone(), period(*rate))),
            _ => None,
        });
        let sampled = flat.records.iter().map(|r| (r.name.clone(), Duration::from_millis(r.every_ms.into())));
        self.limits = flat.computed.iter().map(|c| (c.name.clone(), period(c.rate))).chain(rated).chain(sampled).collect();
        self.computed = flat.computed.iter().map(|c| c.name.clone()).collect();
        self.objects = list.to_vec();
        self.reload();
    }

    /// Starts over on code that changed, each worked out anew by readers made anew.
    fn reload(&mut self) {
        self.epoch += 1;
        self.getters.forget();
        self.conditions.forget();
        self.again.clear();
        self.queued.clear();
        self.sampled.clear();
        let records = &self.sources[Sort::Record as usize];
        self.sample.retain(|name| records.iter().any(|(n, _, _)| n == name));
    }

    fn limit(&self, key: &str) -> Duration {
        self.limits.get(key).copied().unwrap_or_else(|| period(None))
    }

    fn set(&mut self, key: &str, value: Option<Arc<Value>>) {
        if self.values.get(key).map(Arc::as_ref) == value.as_deref() {
            return;
        }
        match value {
            Some(v) => self.values.insert(key.to_owned(), v),
            None => self.values.remove(key),
        };
        self.changed(key);
    }

    /// The value under `key` changed, so what read it is due, and what reads it now may have
    /// read it before it did.
    fn changed(&mut self, key: &str) {
        self.getters.changed(key);
        self.conditions.changed(key);
        for f in self.flying.values_mut() {
            f.changed.insert(key.to_owned());
        }
        for d in &mut self.dirty {
            d.insert(key.to_owned());
        }
    }

    /// Whether one is due and its period passed.
    fn due(&self, watched: &Watched, key: &str) -> bool {
        watched.due(key) && (self.again.contains(key) || watched.ready(key, self.limit(key)))
    }

    /// What may start now: each record due, and each computed value and condition due that
    /// reads no computed value about to change. Where all read one, as in a loop, those go on.
    fn ready(&self) -> Vec<(Sort, String)> {
        let (mut free, mut held) = (Vec::new(), Vec::new());
        for (sort, watched) in [(Sort::Computed, &self.getters), (Sort::Condition, &self.conditions)] {
            for (key, _, _) in &self.sources[sort as usize] {
                if self.flying.contains_key(key) || !self.due(watched, key) {
                    continue;
                }
                let keys = watched.read.get(key).map(|r| &r.keys);
                if keys.is_some_and(|keys| keys.iter().any(|k| self.flying.contains_key(k))) {
                    continue;
                }
                let waits = keys.is_some_and(|keys| keys.iter().any(|k| k != key && self.computed.contains(k) && self.due(&self.getters, k)));
                (if waits { &mut held } else { &mut free }).push((sort, key.clone()));
            }
        }
        free.extend(self.sample.iter().filter(|name| !self.flying.contains_key(*name)).map(|name| (Sort::Record, name.clone())));
        if free.is_empty() { held } else { free }
    }

    /// Notes each that may start as waiting from now, unless it waited already, and gives them
    /// the longest waiting first.
    fn mark(&mut self, now: Instant) -> Vec<(Sort, String)> {
        let mut ready = self.ready();
        for (_, key) in &ready {
            self.queued.entry(key.clone()).or_insert(now);
        }
        ready.sort_by_key(|(_, key)| self.queued[key]);
        ready
    }

    fn pick(&mut self, now: Instant) -> Option<Job> {
        let (sort, key) = self.mark(now).into_iter().next()?;
        let limit = self.limit(&key);
        let waited = self.queued.remove(&key).map_or(Duration::ZERO, |t| now - t);
        let first = match sort {
            Sort::Computed => !self.getters.read.contains_key(&key),
            Sort::Condition => !self.conditions.read.contains_key(&key),
            Sort::Record => {
                self.sample.retain(|name| *name != key);
                self.sampled.insert(key.clone())
            }
        };
        self.flying.insert(key.clone(), Flight { blind: first, changed: HashSet::new() });
        Some(Job { sort, key, epoch: self.epoch, limit, late: waited > limit && !first })
    }

    /// Takes what a worker worked out, and gives what goes to the loop of it, none for code
    /// that changed since. One that read a value changed meanwhile is due again.
    fn apply(&mut self, job: Job, value: Option<Value>, read: Read, started: Instant, problems: Vec<(Level, String)>) -> Option<FromScript> {
        let flight = self.flying.remove(&job.key)?;
        if job.epoch != self.epoch {
            return None;
        }
        let missed = read.keys.iter().any(|k| flight.changed.contains(k));
        if job.sort != Sort::Record {
            let watched = if job.sort == Sort::Computed { &mut self.getters } else { &mut self.conditions };
            watched.worked(&job.key, read, started);
            if missed {
                watched.stale.insert(job.key.clone());
            }
            if flight.blind {
                self.again.insert(job.key.clone());
            } else {
                self.again.remove(&job.key);
            }
        }
        let problems = problems.into_iter().map(|(level, why)| (job.key.clone(), level, why)).collect();
        let (mut computed, mut judged, mut sampled) = (Vec::new(), Vec::new(), Vec::new());
        match job.sort {
            Sort::Computed => {
                self.set(&job.key, value.clone().map(Arc::new));
                computed.push((job.key, value));
            }
            Sort::Condition => judged.push((job.key, value == Some(Value::Bool(true)))),
            Sort::Record => sampled.push((job.key, value)),
        }
        Some(FromScript::Thought { computed, judged, sampled, problems })
    }
}

type Shelf = Arc<(Mutex<Board>, Condvar)>;

fn lock(board: &Shelf) -> MutexGuard<'_, Board> {
    board.0.lock().expect("never held through a panic")
}

/// The workers, and what they share. Dropping it lets them go.
pub(super) struct Readers {
    board: Shelf,
}

impl Readers {
    pub(super) fn start(out: UnboundedSender<FromScript>) -> Readers {
        let board = Shelf::default();
        let n = workers();
        lock(&board).dirty = vec![HashSet::new(); n];
        for index in 0..n {
            let (board, out) = (board.clone(), out.clone());
            std::thread::Builder::new().name(format!("readers {}", index + 1)).spawn(move || worker(index, &board, out)).expect("a reader thread starts");
        }
        Readers { board }
    }

    /// Changes what the workers share, and wakes them to what may start now.
    fn change(&self, f: impl FnOnce(&mut Board)) {
        let mut board = lock(&self.board);
        f(&mut board);
        board.mark(Instant::now());
        self.board.1.notify_all();
    }

    pub(super) fn objects(&self, list: &[object::Object]) {
        self.change(|b| b.load(list));
    }

    pub(super) fn enums(&self, list: &[EnumInfo]) {
        self.change(|b| {
            b.enums = list.to_vec();
            b.reload();
        });
    }

    /// The pages readers name, as made anew next.
    pub(super) fn pages(&self, list: &[(String, String)]) {
        self.change(|b| b.pages = list.to_vec());
    }

    pub(super) fn values(&self, list: &[(String, Option<Arc<Value>>)]) {
        self.change(|b| list.iter().for_each(|(key, value)| b.set(key, value.clone())));
    }

    pub(super) fn forget(&self, keys: &[String]) {
        self.change(|b| keys.iter().for_each(|key| b.set(key, None)));
    }

    /// Wakes the workers to what came due, with the records named.
    pub(super) fn think(&self, sample: Vec<String>) {
        self.change(|b| {
            for name in sample {
                if !b.sample.contains(&name) {
                    b.sample.push(name);
                }
            }
        });
    }

    /// Whether nothing runs and nothing waits for a worker, so all that was worked out went out.
    /// What came due by the clock alone since is left to the next ask, as the workers leave it.
    #[cfg(test)]
    pub(super) fn idle(&self) -> bool {
        let board = lock(&self.board);
        board.flying.is_empty() && board.queued.is_empty()
    }
}

impl Drop for Readers {
    fn drop(&mut self) {
        self.change(|b| b.closed = true);
    }
}

/// Works out one at a time what the board gives, in a runtime of its own, through readers made
/// anew whenever the code changes.
fn worker(index: usize, board: &Shelf, out: UnboundedSender<FromScript>) {
    let rt = Runtime::new().expect("QuickJS starts");
    rt.set_memory_limit(MEMORY);
    let watchdog = Rc::new(Watchdog::default());
    let w = watchdog.clone();
    rt.set_interrupt_handler(Some(Box::new(move || w.over())));
    let rw = Rewriter::new(&rt);
    let shared = Rc::new(RefCell::new(Shared::new(out.clone(), watchdog.clone())));
    let mut readers: [Reader; 3] = Default::default();
    let mut epoch = None;
    loop {
        let mut b = lock(board);
        let job = loop {
            if b.closed {
                return;
            }
            if epoch != Some(b.epoch) {
                break None;
            }
            if let Some(job) = b.pick(Instant::now()) {
                break Some(job);
            }
            b = board.1.wait(b).expect("never held through a panic");
        };
        let mut st = shared.borrow_mut();
        let Some(job) = job else {
            // the code changed, so every reader is made anew before any runs
            epoch = Some(b.epoch);
            b.dirty[index].clear();
            st.take(b.objects.clone());
            st.enums = b.enums.clone();
            st.pages = b.pages.clone();
            st.values = b.values.clone();
            let sources = b.sources.clone();
            drop((st, b));
            readers = sources.map(|list| make_reader(&rt, &rw, &shared, &list, 0));
            continue;
        };
        for key in std::mem::take(&mut b.dirty[index]) {
            match b.values.get(&key) {
                Some(v) => st.values.insert(key, v.clone()),
                None => st.values.remove(&key),
            };
        }
        drop((st, b));
        let reader = &readers[job.sort as usize];
        let found = reader.iter().find_map(|(ctx, fns)| fns.iter().find(|(k, _)| *k == job.key).map(|(_, f)| (ctx, f)));
        let started = Instant::now();
        // one that does not compile reads unknown
        let (got, read) = found.map_or((Ok(None), Read::default()), |(ctx, f)| tracked(&shared, ctx, f, job.limit));
        // what its promises do runs within its time too
        watchdog.arm(started, job.limit);
        loop {
            match rt.execute_pending_job() {
                Ok(true) => {}
                Ok(false) => break,
                Err(e) => e.0.with(|ctx| drop(ctx.catch())),
            }
        }
        watchdog.disarm();
        let span = format!("the {} ms {}", job.limit.as_millis(), if job.sort == Sort::Record { SAMPLED } else { RATED });
        let mut problems = Vec::new();
        if job.late {
            problems.push((Level::Warn, format!("it started over {} ms late, as other code held every worker", job.limit.as_millis())));
        }
        let value = match got {
            Ok(v) => {
                if started.elapsed() > job.limit / 2 {
                    problems.push((Level::Warn, format!("it ran over half {span}")));
                }
                v
            }
            Err(why) => {
                problems.push((Level::Fault, why.unwrap_or_else(|| format!("it ran all {span}, so it was stopped"))));
                None
            }
        };
        let mut b = lock(board);
        // sent while the board is held, so what is idle sent all it worked out
        if let Some(thought) = b.apply(job, value, read, started, problems) {
            let _ = out.send(thought);
        }
        b.mark(Instant::now());
        board.1.notify_all();
    }
}

/// Calls a reader's function `f`, noting what it reads, within `limit`: its value, None where it
/// reads a value that is unknown, which is no fault, or why it failed, None where it ran out of
/// time.
fn tracked(shared: &Rc<RefCell<Shared>>, ctx: &Context, f: &Persistent<Function<'static>>, limit: Duration) -> (Result<Option<Value>, Option<String>>, Read) {
    let watchdog = {
        let mut st = shared.borrow_mut();
        st.reading = Some(Read::default());
        st.version += 1;
        st.watchdog.clone()
    };
    watchdog.arm(Instant::now(), limit);
    let got = ctx.with(|ctx| match f.clone().restore(&ctx).and_then(|f| f.call::<_, rquickjs::Value>(())).and_then(from_js) {
        Ok(v) => Ok(Some(v)),
        Err(rquickjs::Error::Exception) => {
            let e = ctx.catch();
            if watchdog.fired.get() {
                return Err(None);
            }
            if e.as_object().and_then(|o| o.get::<_, String>("name").ok()).as_deref() == Some("Unknown") {
                return Ok(None);
            }
            let describe: rquickjs::Result<Function> = ctx.globals().get("__describe");
            Err(Some(describe.and_then(|d| d.call((e,))).unwrap_or_else(|e| e.to_string())))
        }
        Err(e) => Err(Some(e.to_string())),
    });
    watchdog.disarm();
    (got, shared.borrow_mut().reading.take().unwrap_or_default())
}

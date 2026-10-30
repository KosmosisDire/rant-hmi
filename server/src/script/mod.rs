//! Handlers run here, in QuickJS on a thread of its own, each run in its own context. A run's
//! writes go out when it ends or awaits, so a stopped run leaves nothing half done.

use std::cell::{Cell, RefCell};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::rc::Rc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use rquickjs::context::EvalOptions;
use rquickjs::function::Opt;
use rquickjs::{Context, Ctx, Exception, Function, Module, Object, Persistent, Promise, Runtime};
use crate::value::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::logic::When;
use crate::object::{self, Flat, owner};
use crate::project::{self, Computed, Found, Import, Intent, Kind, Per, Variable};
use crate::protocol::{EnumInfo, Mode};

/// How long code may run without waiting before it is stopped.
const BUDGET: Duration = Duration::from_millis(250);
/// How long after an operator did something on a screen its handler may still start. One later
/// is not run, as a jog that starts late moves a machine no one is steering.
pub const LATE: Duration = Duration::from_millis(500);
const MEMORY: usize = 64 << 20;
const PRELUDE: &str = include_str!("prelude.js");

pub enum ToScript {
    /// Every object, whole, after any change.
    Objects(Vec<object::Object>),
    /// What each topic's message and function's request on the mesh is made of, by alias,
    /// whole, after any change.
    Forms(HashMap<String, Form>),
    /// The mesh's enums code names, whole, after any change.
    Enums(Vec<EnumInfo>),
    /// Mesh imports and shared variables whose value changed, None while unknown.
    Values(Vec<(String, Option<Value>)>),
    /// A screen's own variables that changed.
    Screen { session: u32, values: Vec<(String, Value)> },
    /// The mode a screen draws its pages in now.
    Mode { session: u32, mode: Mode },
    /// A screen went, and its own variables with it.
    Gone(u32),
    /// State that starts over, by key, on the HMI and every screen.
    Forget(Vec<String>),
    /// Judges each rule's condition now, answered with `Judged`.
    Judge,
    /// Reads these records' sources now, by key, answered with `Sampled`.
    Sample(Vec<String>),
    /// Works every computed value out now, answered with `Computed`.
    Compute,
    /// What a write of `v` to a computed value gives its setter's target, answered with
    /// `Inverted`.
    Invert { session: Option<u32>, name: String, v: Value },
    /// Tries a computed value's setter on a few values, answered with `Tried` when one does not
    /// read back as written.
    Try { session: u32, name: String },
    /// Every page as code names it, and its id, whole, after any change.
    Pages(Vec<(String, String)>),
    /// Runs code for a screen, or for none. `p` is what its event brought, `at` the copy of a
    /// repeat it happened on, which the code reads as `index` and `item`. `bound` is the state
    /// its element sees, by key, which the code reads by name over any other. Code of an object
    /// `own` reads its members by name too, and a function's reads what it takes, nearest of all.
    /// `came` is when the operator did what it is for, None for a run that may start any time.
    Run { run: u64, session: Option<u32>, code: String, p: Value, at: Option<(u32, Value)>, bound: Vec<(String, Variable)>, own: Option<String>, came: Option<Instant>, takes: Vec<(String, Value)> },
    /// How a call ended: its answer, or why it failed.
    Answer { call: u64, outcome: Result<Value, CallFailure> },
    /// One of a task call's progress updates, for the function the call was given.
    Progress { call: u64, value: Value },
}

/// A message's type by name and its fields, none for a bare type, so code may pass the fields
/// one by one.
#[derive(Clone, Debug, PartialEq)]
pub struct Form {
    pub name: String,
    pub fields: Vec<String>,
}

pub struct CallFailure {
    /// Rant's status in snake case, such as `timeout` or `app_error`.
    pub status: String,
    pub message: String,
}

pub enum FromScript {
    /// A variable's whole new value.
    Write { run: u64, alias: String, value: Value },
    Call { run: u64, call: u64, alias: String, request: Value },
    /// A call of an object's function, by its key, which runs for the run's screen. `call`
    /// answers with what it returns.
    Run { run: u64, call: u64, function: String, args: Vec<Value> },
    /// Stops task `alias`'s call `call`, or with None each of its calls in flight.
    Cancel { run: u64, alias: String, call: Option<u64> },
    /// A message to send on a topic.
    Send { run: u64, alias: String, value: Value },
    Notify { run: u64, text: String },
    /// A fault that leaves the run going, as a throw in a task's progress function.
    Fault { run: u64, text: String },
    Log { run: u64, text: String },
    /// Opens a page on the screen that started the run, in place of the top one when `replace`.
    /// `call` answers with what the page closes with.
    Open { run: u64, page: String, replace: bool, call: u64 },
    /// Closes the top page on the screen that started the run, with an answer.
    Close { run: u64, answer: Value },
    /// Sets the mode of the screen that started the run.
    Mode { run: u64, mode: Mode },
    /// How a run ended, and what its code returned, null for nothing.
    Done { run: u64, end: End, value: Value },
    /// Each condition's truth now. One that reads an unknown value, or fails, is false.
    Judged(Vec<(String, bool)>),
    /// Each record's value now, None where it reads an unknown value or fails.
    Sampled(Vec<(String, Option<Value>)>),
    /// Each computed value now, None where it reads an unknown value or fails.
    Computed(Vec<(String, Option<Value>)>),
    /// What a write to the computed value `name` gives `target`, or why it gives nothing.
    Inverted { session: Option<u32>, name: String, target: String, value: Result<Value, String> },
    /// Why a computed value's setter does not undo its getter.
    Tried { session: u32, warning: String },
}

/// Expressions read together, in a context for each object whose code they are, that reads but
/// never writes, each a function by name.
type Reader = Vec<(Context, Vec<(String, Persistent<Function<'static>>)>)>;

/// An expression to read: its name, the object whose code it is, and the function's text.
type Source = (String, Option<String>, String);

/// The math library and the operator rewrite, the client's own files, so pages and code here
/// do the same math. Each module is named as its importers name it.
pub(crate) const ACORN: (&str, &str) = ("acorn/acorn.mjs", include_str!("../../../client/src/lang/acorn/acorn.mjs"));
pub(crate) const MATH: (&str, &str) = ("math.js", include_str!("../../../client/src/lang/math.js"));
pub(crate) const ARITH: (&str, &str) = ("arith.js", include_str!("../../../client/src/lang/arith.js"));
/// Every name code reads besides the project's own, as completion lists them.
const API: (&str, &str) = ("api.js", include_str!("../../../client/src/lang/api.js"));

/// Runs a module in `ctx` and gives its exports. One it imports must have run there first.
pub(crate) fn module<'js>(ctx: &Ctx<'js>, (name, source): (&str, &str)) -> rquickjs::Result<Object<'js>> {
    let (module, done) = Module::declare(ctx.clone(), name, source)?.eval()?;
    done.finish::<()>()?;
    module.namespace()
}

/// Whether code already has `name` or cannot bind it: JavaScript's words and globals, the math
/// library's names and every name api.js lists. No import, variable or enum may take one.
pub fn reserved(name: &str) -> bool {
    static NAMES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    let names = NAMES.get_or_init(|| {
        let rt = Runtime::new().expect("QuickJS starts");
        let ctx = Context::full(&rt).expect("QuickJS makes a context");
        ctx.with(|ctx| {
            let mut names: Vec<String> = ctx.eval("Object.getOwnPropertyNames(globalThis)")?;
            let library: Object = module(&ctx, MATH)?.get("LIBRARY")?;
            names.extend(library.keys::<String>().collect::<rquickjs::Result<Vec<_>>>()?);
            let api: Vec<Object> = module(&ctx, API)?.get("API")?;
            names.extend(api.iter().map(|a| a.get::<_, String>("name")).collect::<rquickjs::Result<Vec<_>>>()?);
            Ok::<_, rquickjs::Error>(names)
        })
        .expect("the math library and the API load")
    });
    names.iter().any(|n| n == name) || !binds(name)
}

/// What api.js exports, its names and the words for each place, for the reference sheet.
#[cfg(test)]
pub(crate) fn api() -> serde_json::Value {
    let rt = Runtime::new().expect("QuickJS starts");
    let ctx = Context::full(&rt).expect("QuickJS makes a context");
    let text = ctx
        .with(|ctx| {
            let exports = module(&ctx, API)?;
            ctx.json_stringify(exports)?.expect("api.js exports values").to_string()
        })
        .expect("api.js loads");
    serde_json::from_str(&text).expect("api.js exports JSON")
}

/// Whether a handler can declare `name`, which strict and async code asks the most of.
fn binds(name: &str) -> bool {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
        return false;
    }
    let rt = Runtime::new().expect("QuickJS starts");
    let ctx = Context::full(&rt).expect("QuickJS makes a context");
    ctx.with(|ctx| ctx.eval::<(), _>(format!("(async function () {{ \"use strict\"; let {name}; }});")).is_ok())
}

/// The operator rewrite, in a context of its own, the only one that holds acorn. Each text is
/// rewritten once.
struct Rewriter {
    ctx: Context,
    arith: Persistent<Function<'static>>,
    done: RefCell<HashMap<String, Result<String, String>>>,
}

impl Rewriter {
    fn new(rt: &Runtime) -> Rewriter {
        let ctx = Context::full(rt).expect("QuickJS makes a context");
        let arith = ctx
            .with(|ctx| {
                module(&ctx, ACORN)?;
                module(&ctx, MATH)?;
                let arith: Function = module(&ctx, ARITH)?.get("arith")?;
                Ok::<_, rquickjs::Error>(Persistent::save(&ctx, arith))
            })
            .expect("the operator rewrite loads");
        Rewriter { ctx, arith, done: RefCell::new(HashMap::new()) }
    }

    /// `src` with its arithmetic routed through the math library, or why it does not parse.
    /// Code given `before`, the lines that wrap it ahead, also says on which of its lines.
    fn rewrite(&self, src: &str, before: Option<u32>) -> Result<String, String> {
        if let Some(done) = self.done.borrow().get(src) {
            return done.clone();
        }
        let r = self.ctx.with(|ctx| {
            let arith = self.arith.clone().restore(&ctx).map_err(|e| e.to_string())?;
            arith.call::<_, String>((src, before)).map_err(|_| {
                let e = ctx.catch();
                e.as_object().and_then(|o| o.get::<_, String>("message").ok()).unwrap_or_else(|| "the code does not parse".to_owned())
            })
        });
        let mut done = self.done.borrow_mut();
        // each edit is a new text, so old ones are let go now and then
        if done.len() > 4096 {
            done.clear();
        }
        done.insert(src.to_owned(), r.clone());
        r
    }
}

#[derive(Debug, PartialEq)]
pub enum End {
    Ok,
    /// Stopped by reading this member while it was unknown.
    Unknown(String),
    Fault(String),
}

#[derive(Clone)]
pub struct Script {
    to: Sender<ToScript>,
}

impl Script {
    pub fn start(out: UnboundedSender<FromScript>) -> Script {
        let (to, from) = std::sync::mpsc::channel();
        std::thread::Builder::new().name("handlers".into()).spawn(move || engine(from, out)).expect("the handler thread starts");
        Script { to }
    }

    pub fn send(&self, msg: ToScript) {
        let _ = self.to.send(msg);
    }
}

/// What a promise waits on: a call's answer or a sleep's end.
struct Waiter {
    resolve: Persistent<Function<'static>>,
    reject: Persistent<Function<'static>>,
    /// What takes a task call's progress.
    progress: Option<Persistent<Function<'static>>>,
}

struct Shared {
    out: UnboundedSender<FromScript>,
    objects: Vec<object::Object>,
    /// The objects' members by key.
    imports: HashMap<String, Import>,
    forms: HashMap<String, Form>,
    enums: Vec<EnumInfo>,
    variables: HashMap<String, Variable>,
    computed: HashMap<String, Computed>,
    values: HashMap<String, Value>,
    /// Each screen's own variables.
    screens: HashMap<u32, HashMap<String, Value>>,
    /// The mode each screen draws in.
    modes: HashMap<u32, Mode>,
    /// The screen each live run belongs to.
    sessions: HashMap<u64, Option<u32>>,
    /// The state each live run reads, by key.
    bound: HashMap<u64, Vec<(String, Variable)>>,
    /// What each live run's code returned, once it did.
    returned: HashMap<u64, Value>,
    pages: Vec<(String, String)>,
    /// Runs not ended yet.
    live: HashSet<u64>,
    /// Each run's writes not sent yet, one per name written, in the order first made. Code a run
    /// left going without awaiting it may still write after the run ended.
    pending: HashMap<u64, Vec<(String, Value)>>,
    waiters: HashMap<u64, Waiter>,
    timers: BinaryHeap<Reverse<(Instant, u64)>>,
    next: u64,
}

impl Shared {
    fn send(&self, msg: FromScript) {
        let _ = self.out.send(msg);
    }

    /// What `key` names among the objects' members.
    fn look_up(&self, key: &str) -> Found<'_> {
        project::look_up(&self.objects, key)
    }

    /// The state the run reads under `key`.
    fn state(&self, run: u64, key: &str) -> Option<&Variable> {
        self.bound.get(&run)?.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// What the run sees: its own write not sent yet, else the latest value, its screen's
    /// for a variable each screen has, and a state's start until it has one.
    fn read(&self, run: u64, alias: &str) -> Option<&Value> {
        let own = self.pending.get(&run).and_then(|p| p.iter().find(|(a, _)| a == alias));
        if let Some((_, v)) = own {
            return Some(v);
        }
        if let Some(state) = self.state(run, alias) {
            let held = match state.per {
                Per::Screen => self.sessions.get(&run).copied().flatten().and_then(|s| self.screens.get(&s)?.get(alias)),
                Per::Hmi => self.values.get(alias),
            };
            return Some(held.unwrap_or(&state.start));
        }
        if self.variables.get(alias).is_some_and(|v| v.per == Per::Screen) {
            let session = self.sessions.get(&run).copied().flatten()?;
            return self.screens.get(&session).and_then(|m| m.get(alias));
        }
        self.values.get(alias)
    }

    fn stage(&mut self, run: u64, alias: String, value: Value) {
        let list = self.pending.entry(run).or_default();
        match list.iter_mut().find(|(a, _)| *a == alias) {
            Some(slot) => slot.1 = value,
            None => list.push((alias, value)),
        }
    }

    fn flush(&mut self, run: u64) {
        for (alias, value) in self.pending.get_mut(&run).map(std::mem::take).unwrap_or_default() {
            self.hold(run, &alias, &value);
            self.send(FromScript::Write { run, alias, value });
        }
    }

    /// Takes a write going out as the latest value, so another run's write soon after builds on
    /// it and not on what the mesh has not echoed back yet. A refused one comes back corrected.
    fn hold(&mut self, run: u64, alias: &str, value: &Value) {
        match self.variables.get(alias).or_else(|| self.state(run, alias)).map(|v| v.per) {
            Some(Per::Screen) => {
                if let Some(session) = self.sessions.get(&run).copied().flatten() {
                    self.screens.entry(session).or_default().insert(alias.to_owned(), value.clone());
                }
            }
            Some(Per::Hmi) => {
                self.values.insert(alias.to_owned(), value.clone());
            }
            None if self.imports.contains_key(alias) => {
                self.values.insert(alias.to_owned(), value.clone());
            }
            None => {}
        }
    }

    fn flush_all(&mut self) {
        let runs: Vec<u64> = self.pending.keys().copied().collect();
        runs.into_iter().for_each(|run| self.flush(run));
        let live = &self.live;
        self.pending.retain(|run, _| live.contains(run));
    }

    fn wait<'js>(&mut self, ctx: &Ctx<'js>, resolve: Function<'js>, reject: Function<'js>, progress: Option<Function<'js>>) -> u64 {
        self.next += 1;
        let progress = progress.map(|f| Persistent::save(ctx, f));
        self.waiters.insert(self.next, Waiter { resolve: Persistent::save(ctx, resolve), reject: Persistent::save(ctx, reject), progress });
        self.next
    }
}

fn engine(from: Receiver<ToScript>, out: UnboundedSender<FromScript>) {
    let rt = Runtime::new().expect("QuickJS starts");
    rt.set_memory_limit(MEMORY);
    // one shot, so the code that reports the stop is not stopped too
    let deadline = Rc::new(Cell::new(None::<Instant>));
    let d = deadline.clone();
    rt.set_interrupt_handler(Some(Box::new(move || {
        let over = d.get().is_some_and(|t| Instant::now() > t);
        if over {
            d.set(None);
        }
        over
    })));
    // calls and sleeps settle from here, whichever run made them
    let home = Context::full(&rt).expect("QuickJS makes a context");
    let rw = Rewriter::new(&rt);
    home.with(|ctx| {
        let failure: Function = ctx.eval("(status, message) => Object.assign(new Error(message), { name: 'CallError', status })").expect("the failure maker compiles");
        ctx.globals().set("__failure", failure).expect("globals take a function");
    });
    let shared = Rc::new(RefCell::new(Shared {
        out,
        objects: Vec::new(),
        imports: HashMap::new(),
        forms: HashMap::new(),
        enums: Vec::new(),
        variables: HashMap::new(),
        computed: HashMap::new(),
        values: HashMap::new(),
        screens: HashMap::new(),
        modes: HashMap::new(),
        sessions: HashMap::new(),
        bound: HashMap::new(),
        returned: HashMap::new(),
        pages: Vec::new(),
        live: HashSet::new(),
        pending: HashMap::new(),
        waiters: HashMap::new(),
        timers: BinaryHeap::new(),
        next: 0,
    }));
    // conditions, records and computed values are read each in a reader made anew when what
    // they read or say changes
    let mut conditions: Vec<Source> = Vec::new();
    let mut judge: Option<Reader> = None;
    let mut records: Vec<Source> = Vec::new();
    let mut sampler: Option<Reader> = None;
    let mut getters: Vec<Source> = Vec::new();
    let mut computer: Option<Reader> = None;
    let mut setters: Vec<Source> = Vec::new();
    let mut inverter: Option<Reader> = None;
    loop {
        let next_timer = shared.borrow().timers.peek().map(|Reverse((t, _))| t.saturating_duration_since(Instant::now()));
        let msg = match next_timer {
            Some(wait) => from.recv_timeout(wait),
            None => from.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match msg {
            Ok(ToScript::Objects(list)) => {
                let flat = Flat::of(&list);
                let own = |key: &str| Some(owner(key).to_owned());
                conditions = flat.rules.iter().filter_map(|(o, r)| match &r.when {
                    When::Turns { condition, .. } => Some((r.id.clone(), Some(o.clone()), format!("() => !!({condition}\n)"))),
                    _ => None,
                }).collect();
                records = flat.records.iter().map(|r| (r.name.clone(), own(&r.name), format!("() => ({}\n)", r.source))).collect();
                getters = flat.computed.iter().map(|c| (c.name.clone(), own(&c.name), format!("() => ({}\n)", c.get))).collect();
                setters = flat.computed.iter().filter_map(|c| c.set.as_ref().map(|s| (c.name.clone(), own(&c.name), format!("(v) => ({}\n)", s.value)))).collect();
                let mut st = shared.borrow_mut();
                st.imports = flat.imports.into_iter().map(|i| (i.alias.clone(), i)).collect();
                st.variables = flat.variables.into_iter().map(|v| (v.name.clone(), v)).collect();
                st.computed = flat.computed.into_iter().map(|c| (c.name.clone(), c)).collect();
                st.objects = list;
                // every reader knows the names there are
                (judge, sampler, computer, inverter) = (None, None, None, None);
            }
            Ok(ToScript::Judge) => {
                let judge = judge.get_or_insert_with(|| make_reader(&rt, &rw, &shared, &conditions, 0));
                let mut truths = Vec::new();
                for (ctx, fns) in judge.iter() {
                    ctx.with(|ctx| {
                        for (id, f) in fns {
                            deadline.set(Some(Instant::now() + BUDGET));
                            let truth = f.clone().restore(&ctx).and_then(|f| f.call::<_, bool>(())).unwrap_or_else(|_| {
                                ctx.catch();
                                false
                            });
                            truths.push((id.clone(), truth));
                        }
                    });
                }
                deadline.set(None);
                shared.borrow().send(FromScript::Judged(truths));
            }
            Ok(ToScript::Sample(names)) => {
                let sampler = sampler.get_or_insert_with(|| make_reader(&rt, &rw, &shared, &records, 0));
                let mut read = Vec::new();
                for (ctx, fns) in sampler.iter() {
                    ctx.with(|ctx| {
                        for (name, f) in fns.iter().filter(|(name, _)| names.contains(name)) {
                            deadline.set(Some(Instant::now() + BUDGET));
                            let got = f.clone().restore(&ctx).and_then(|f| f.call::<_, rquickjs::Value>(())).and_then(from_js);
                            let value = match got {
                                Ok(v) => Some(v),
                                Err(_) => {
                                    ctx.catch();
                                    None
                                }
                            };
                            read.push((name.clone(), value));
                        }
                    });
                }
                deadline.set(None);
                shared.borrow().send(FromScript::Sampled(read));
            }
            Ok(ToScript::Compute) => {
                let computer = computer.get_or_insert_with(|| make_reader(&rt, &rw, &shared, &getters, 0));
                // in order, each seen by those after it, and again while any moves, since one
                // may read one later in the list
                let count = computer.iter().map(|(_, fns)| fns.len()).sum::<usize>();
                let mut out = Vec::new();
                for _ in 0..count.max(1) {
                    let mut moved = false;
                    out.clear();
                    for (ctx, fns) in computer.iter() {
                        ctx.with(|ctx| {
                            for (name, f) in fns {
                                deadline.set(Some(Instant::now() + BUDGET));
                                let value = match f.clone().restore(&ctx).and_then(|f| f.call::<_, rquickjs::Value>(())).and_then(from_js) {
                                    Ok(v) => Some(v),
                                    Err(_) => {
                                        ctx.catch();
                                        None
                                    }
                                };
                                let mut st = shared.borrow_mut();
                                if st.values.get(name) != value.as_ref() {
                                    moved = true;
                                    match &value {
                                        Some(v) => st.values.insert(name.clone(), v.clone()),
                                        None => st.values.remove(name),
                                    };
                                }
                                out.push((name.clone(), value));
                            }
                        });
                    }
                    if !moved {
                        break;
                    }
                }
                deadline.set(None);
                shared.borrow().send(FromScript::Computed(out));
            }
            Ok(ToScript::Invert { session, name, v }) => {
                let target = shared.borrow().computed.get(&name).and_then(|c| c.set.as_ref()).map(|s| s.target.clone());
                let inverter = inverter.get_or_insert_with(|| make_reader(&rt, &rw, &shared, &setters, 0));
                let found = inverter.iter().find_map(|(ctx, fns)| fns.iter().find(|(n, _)| *n == name).map(|(_, f)| (ctx, f.clone())));
                let value = match (&target, found) {
                    (Some(_), Some((ctx, f))) => ctx.with(|ctx| {
                        deadline.set(Some(Instant::now() + BUDGET));
                        let got = to_js(&ctx, &v).and_then(|v| f.restore(&ctx)?.call::<_, rquickjs::Value>((v,))).and_then(from_js);
                        got.map_err(|_| {
                            let why = ctx.catch().as_exception().and_then(|e| e.message()).unwrap_or_default();
                            format!("{name}'s setter failed: {why}")
                        })
                    }),
                    _ => Err(format!("{name}'s setter does not read")),
                };
                deadline.set(None);
                shared.borrow().send(FromScript::Inverted { session, name, target: target.unwrap_or_default(), value });
            }
            Ok(ToScript::Try { session, name }) => {
                if let Some(warning) = try_setter(&rt, &rw, &shared, &deadline, &name) {
                    shared.borrow().send(FromScript::Tried { session, warning });
                }
            }
            Ok(msg @ ToScript::Enums(_)) => {
                (judge, sampler, computer, inverter) = (None, None, None, None);
                handle(&rt, &rw, &home, &shared, &deadline, msg);
            }
            Ok(msg) => handle(&rt, &rw, &home, &shared, &deadline, msg),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        loop {
            let due = {
                let mut s = shared.borrow_mut();
                match s.timers.peek() {
                    Some(Reverse((t, id))) if *t <= Instant::now() => {
                        let id = *id;
                        s.timers.pop();
                        s.waiters.remove(&id)
                    }
                    _ => break,
                }
            };
            if let Some(w) = due {
                settle(&home, w, Ok(Value::Null));
            }
        }
        loop {
            deadline.set(Some(Instant::now() + BUDGET));
            // a job that throws is a run's own fault, which its handler reports
            if matches!(rt.execute_pending_job(), Ok(false)) {
                break;
            }
        }
        deadline.set(None);
        shared.borrow_mut().flush_all();
    }
    // every persistent goes before the runtime does
    drop(judge);
    shared.borrow_mut().waiters.clear();
}

/// The run a setter's trial reads as, whose own write of the target it reads first.
const TRIAL: u64 = u64::MAX;

/// Writes `v` through a computed value's setter and reads it back through its getter, for a
/// few values like the one it has now. Why one does not come back, else None.
fn try_setter(rt: &Runtime, rw: &Rewriter, shared: &Rc<RefCell<Shared>>, deadline: &Cell<Option<Instant>>, name: &str) -> Option<String> {
    let c = shared.borrow().computed.get(name).cloned()?;
    let set = c.set.clone()?;
    let samples: Vec<Value> = match shared.borrow().values.get(name) {
        Some(Value::Bool(_)) => vec![Value::Bool(true), Value::Bool(false)],
        Some(Value::Int(_) | Value::Float(_)) => [0.0, 1.0, 7.5, 50.0, -3.0].into_iter().map(Value::Float).collect(),
        _ => Vec::new(),
    };
    let own = Some(owner(name).to_owned());
    let sources = [("get".to_owned(), own.clone(), format!("() => ({}\n)", c.get)), ("set".to_owned(), own, format!("(v) => ({}\n)", set.value))];
    let reader = make_reader(rt, rw, shared, &sources, TRIAL);
    let [(ctx, fns)] = reader.as_slice() else { return None };
    let [(_, get), (_, put)] = fns.as_slice() else { return None };
    let wrong = ctx.with(|ctx| {
        samples.into_iter().find_map(|v| {
            deadline.set(Some(Instant::now() + BUDGET));
            let t = to_js(&ctx, &v).and_then(|x| put.clone().restore(&ctx)?.call::<_, rquickjs::Value>((x,))).and_then(from_js).ok();
            let Some(t) = t else {
                ctx.catch();
                return Some(format!("{name}'s setter fails for {v}"));
            };
            shared.borrow_mut().pending.insert(TRIAL, vec![(set.target.clone(), t)]);
            let back = get.clone().restore(&ctx).and_then(|f| f.call::<_, rquickjs::Value>(())).and_then(from_js).ok();
            match back {
                Some(b) if same(&b, &v) => None,
                Some(b) => Some(format!("{name}'s setter does not undo it: writing {v} reads back as {b}")),
                None => {
                    ctx.catch();
                    Some(format!("{name}'s setter gives {} what {name} cannot read back", set.target))
                }
            }
        })
    });
    deadline.set(None);
    shared.borrow_mut().pending.remove(&TRIAL);
    wrong
}

/// Equal, numbers within a hair of each other, as a float's last digits wander.
fn same(a: &Value, b: &Value) -> bool {
    let number = |v: &Value| match v {
        Value::Int(i) => Some(*i as f64),
        Value::Float(f) => Some(*f),
        _ => None,
    };
    match (number(a), number(b)) {
        (Some(x), Some(y)) => (x - y).abs() <= 1e-9 * x.abs().max(1.0),
        _ => a == b,
    }
}

/// A reader of each source by name, a context for each object whose code they are, which reads
/// every name, as `run` when it is one, and refuses writes, calls, cancels, sends and runs. One
/// that does not compile is left out.
fn make_reader(rt: &Runtime, rw: &Rewriter, shared: &Rc<RefCell<Shared>>, sources: &[Source], run: u64) -> Reader {
    let mut owners: Vec<&Option<String>> = sources.iter().map(|(_, own, _)| own).collect();
    owners.sort();
    owners.dedup();
    owners.into_iter().map(|own| {
        let mine: Vec<(&String, &String)> = sources.iter().filter(|(_, o, _)| o == own).map(|(id, _, source)| (id, source)).collect();
        read_as(rt, rw, shared, &mine, own.as_deref(), run)
    }).collect()
}

/// The context of one object's sources in a reader, as `make_reader` gives them.
fn read_as(rt: &Runtime, rw: &Rewriter, shared: &Rc<RefCell<Shared>>, sources: &[(&String, &String)], own: Option<&str>, run: u64) -> (Context, Vec<(String, Persistent<Function<'static>>)>) {
    let sources: Vec<(&String, String)> = sources.iter().filter_map(|(id, source)| rw.rewrite(source, None).ok().map(|s| (*id, s))).collect();
    let ctx = Context::full(rt).expect("QuickJS makes a context");
    let fns = ctx.with(|ctx| {
        if install(&ctx, run, shared, &Value::Null, None, own).is_err() {
            ctx.catch();
            return Vec::new();
        }
        for name in ["__write", "__call", "__cancel", "__send", "__run"] {
            let refuse = Function::new(ctx.clone(), |ctx: Ctx<'_>| -> rquickjs::Result<()> { Err(Exception::throw_type(&ctx, "this only reads")) });
            if let Ok(f) = refuse {
                let _ = ctx.globals().set(name, f);
            }
        }
        sources
            .iter()
            .filter_map(|(id, source)| match ctx.eval::<Function, _>(source.as_str()) {
                Ok(f) => Some(((*id).clone(), Persistent::save(&ctx, f))),
                Err(_) => {
                    ctx.catch();
                    None
                }
            })
            .collect()
    });
    (ctx, fns)
}

fn handle(rt: &Runtime, rw: &Rewriter, home: &Context, shared: &Rc<RefCell<Shared>>, deadline: &Cell<Option<Instant>>, msg: ToScript) {
    match msg {
        ToScript::Forms(forms) => shared.borrow_mut().forms = forms,
        ToScript::Enums(enums) => shared.borrow_mut().enums = enums,
        // the loop takes these itself, since they need the readers it keeps
        ToScript::Objects(_) | ToScript::Judge | ToScript::Sample(_) | ToScript::Compute | ToScript::Invert { .. } | ToScript::Try { .. } => {}
        ToScript::Pages(list) => shared.borrow_mut().pages = list,
        ToScript::Screen { session, values } => shared.borrow_mut().screens.entry(session).or_default().extend(values),
        ToScript::Mode { session, mode } => drop(shared.borrow_mut().modes.insert(session, mode)),
        ToScript::Gone(session) => {
            let mut s = shared.borrow_mut();
            s.screens.remove(&session);
            s.modes.remove(&session);
        }
        ToScript::Forget(keys) => {
            let mut s = shared.borrow_mut();
            for key in &keys {
                s.values.remove(key);
                s.screens.values_mut().for_each(|m| drop(m.remove(key)));
            }
        }
        ToScript::Values(list) => {
            let mut s = shared.borrow_mut();
            for (alias, value) in list {
                match value {
                    Some(v) => s.values.insert(alias, v),
                    None => s.values.remove(&alias),
                };
            }
        }
        ToScript::Run { run, session, code, p, at, bound, own, came, takes } => {
            if let Some(late) = came.map(|c| c.elapsed()).filter(|d| *d > LATE) {
                return finish(shared, run, End::Fault(format!("not run, since it would have started {} ms after it happened", late.as_millis())));
            }
            let mut s = shared.borrow_mut();
            s.live.insert(run);
            s.sessions.insert(run, session);
            s.bound.insert(run, bound);
            drop(s);
            // rewritten first, since the rewrite runs in a context of its own and one runs at a time.
            // What the run wrote goes out as it ends, before another run goes on, unless it threw.
            let (names, args): (Vec<String>, Vec<Value>) = takes.into_iter().unzip();
            let names = names.join(", ");
            let source = match rw.rewrite(&format!("(async ({names}) => {{ try {{\n{code}\n}} catch (e) {{ __drop(); throw e; }} finally {{ __yield(); }} }})(...__args).then((r) => __end(\"ok\", r), __finish);"), Some(1)) {
                Ok(source) => source,
                Err(why) => return finish(shared, run, End::Fault(why)),
            };
            let ctx = match Context::full(rt) {
                Ok(ctx) => ctx,
                Err(e) => return finish(shared, run, End::Fault(format!("could not start: {e}"))),
            };
            let failed = ctx.with(|ctx| {
                if let Err(e) = install(&ctx, run, shared, &p, at.as_ref(), own.as_deref()).and_then(|_| ctx.globals().set("__args", to_js(&ctx, &Value::List(args))?)) {
                    return Some(format!("could not start: {e}"));
                }
                deadline.set(Some(Instant::now() + BUDGET));
                let mut options = EvalOptions::default();
                options.strict = true;
                options.filename = Some("handler".into());
                let result = ctx.eval_with_options::<(), _>(source, options);
                deadline.set(None);
                match result {
                    Ok(()) => None,
                    Err(rquickjs::Error::Exception) => {
                        let e = ctx.catch();
                        let describe: rquickjs::Result<Function> = ctx.globals().get("__describe");
                        Some(describe.and_then(|f| f.call((e,))).unwrap_or_else(|e| e.to_string()))
                    }
                    Err(e) => Some(e.to_string()),
                }
            });
            if let Some(text) = failed {
                finish(shared, run, End::Fault(text));
            }
        }
        ToScript::Answer { call, outcome } => {
            let waiter = shared.borrow_mut().waiters.remove(&call);
            if let Some(w) = waiter {
                settle(home, w, outcome);
            }
        }
        ToScript::Progress { call, value } => {
            let progress = shared.borrow().waiters.get(&call).and_then(|w| w.progress.clone());
            if let Some(f) = progress {
                home.with(|ctx| {
                    if to_js(&ctx, &value).and_then(|v| f.restore(&ctx)?.call::<_, ()>((v,))).is_err() {
                        ctx.catch();
                    }
                });
            }
        }
    }
}

/// Ends a run: an ended run's last writes go out, a stopped one's are dropped.
fn finish(shared: &Rc<RefCell<Shared>>, run: u64, end: End) {
    let mut s = shared.borrow_mut();
    if end == End::Ok {
        s.flush(run);
    }
    s.pending.remove(&run);
    s.live.remove(&run);
    s.sessions.remove(&run);
    s.bound.remove(&run);
    let value = s.returned.remove(&run).unwrap_or_default();
    s.send(FromScript::Done { run, end, value });
}

fn settle(home: &Context, w: Waiter, outcome: Result<Value, CallFailure>) {
    home.with(|ctx| {
        let settled = match outcome {
            Ok(value) => w.resolve.restore(&ctx).and_then(|f| f.call::<_, ()>((to_js(&ctx, &value)?,))),
            Err(fail) => {
                let failure: rquickjs::Result<Function> = ctx.globals().get("__failure");
                let error = failure.and_then(|f| f.call::<_, rquickjs::Value>((fail.status, fail.message)));
                error.and_then(|e| w.reject.restore(&ctx)?.call::<_, ()>((e,)))
            }
        };
        if settled.is_err() {
            ctx.catch();
        }
    });
}

/// The host side of what `prelude.js` builds on, bound to one run of the code of the object
/// `own`, if any, then the prelude itself.
fn install<'js>(ctx: &Ctx<'js>, run: u64, shared: &Rc<RefCell<Shared>>, p: &Value, at: Option<&(u32, Value)>, own: Option<&str>) -> rquickjs::Result<()> {
    let g = ctx.globals();
    // the math library first, so a name of the project's own set after it wins
    let library: Object = module(ctx, MATH)?.get("LIBRARY")?;
    for name in library.keys::<String>() {
        let name = name?;
        g.set(name.as_str(), library.get::<_, rquickjs::Value>(name.as_str())?)?;
    }
    g.set("p", to_js(ctx, p)?)?;
    if let Some((index, item)) = at {
        g.set("index", *index)?;
        g.set("item", to_js(ctx, item)?)?;
    }
    let s = shared.clone();
    let read = move |ctx: Ctx<'js>, alias: String| -> rquickjs::Result<rquickjs::Value<'js>> {
        match s.borrow().read(run, &alias) {
            Some(v) => to_js(&ctx, v),
            None => Ok(rquickjs::Value::new_undefined(ctx)),
        }
    };
    g.set("__read", Function::new(ctx.clone(), read)?)?;

    let s = shared.clone();
    let write = move |ctx: Ctx<'js>, alias: String, given: rquickjs::Value<'js>| -> rquickjs::Result<()> {
        let st = s.borrow();
        let screen = st.sessions.get(&run).copied().flatten().is_some();
        if st.state(run, &alias).is_none()
            && let Err(u) = st.look_up(&alias).target(&alias, "", screen)
        {
            return Err(if u.unknown { Exception::throw_reference(&ctx, &u.text) } else { Exception::throw_type(&ctx, &u.text) });
        }
        // read with nothing borrowed, since reading a proxy or a getter runs code that reads too
        drop(st);
        let value = from_js(given)?;
        s.borrow_mut().stage(run, alias, value);
        Ok(())
    };
    g.set("__write", Function::new(ctx.clone(), write)?)?;

    // what the run wrote goes out as it waits, and is dropped where it threw
    let s = shared.clone();
    let yielded = move |v: Opt<rquickjs::Value<'js>>| -> Option<rquickjs::Value<'js>> {
        s.borrow_mut().flush(run);
        v.0
    };
    g.set("__yield", Function::new(ctx.clone(), yielded)?)?;
    let s = shared.clone();
    let thrown = move || {
        s.borrow_mut().pending.remove(&run);
    };
    g.set("__drop", Function::new(ctx.clone(), thrown)?)?;

    let s = shared.clone();
    let call = move |ctx: Ctx<'js>, alias: String, given: rquickjs::Value<'js>, progress: Option<Function<'js>>| -> rquickjs::Result<Promise<'js>> {
        let kind = s.borrow().imports.get(&alias).map(|i| i.kind).filter(|k| matches!(k, Kind::Function | Kind::Task));
        let kind = kind.ok_or_else(|| Exception::throw_type(&ctx, &format!("{alias} is not a function or a task on the mesh")))?;
        let request = from_js(given)?;
        let (promise, resolve, reject) = ctx.promise()?;
        let mut st = s.borrow_mut();
        // what the run wrote before the call goes out before it
        st.flush(run);
        let call = st.wait(&ctx, resolve, reject, progress);
        if kind == Kind::Task {
            let (s, alias) = (s.clone(), alias.clone());
            let cancel = move || s.borrow().send(FromScript::Cancel { run, alias: alias.clone(), call: Some(call) });
            promise.set("cancel", Function::new(ctx.clone(), cancel)?)?;
        }
        st.send(FromScript::Call { run, call, alias, request });
        Ok(promise)
    };
    g.set("__call", Function::new(ctx.clone(), call)?)?;
    let s = shared.clone();
    g.set("__cancel", Function::new(ctx.clone(), move |alias: String| s.borrow().send(FromScript::Cancel { run, alias, call: None }))?)?;

    // an object's function runs on its own, answering with what it returns
    let s = shared.clone();
    let call_fn = move |ctx: Ctx<'js>, function: String, given: rquickjs::Value<'js>| -> rquickjs::Result<Promise<'js>> {
        let args = match from_js(given)? {
            Value::List(args) => args,
            _ => Vec::new(),
        };
        let (promise, resolve, reject) = ctx.promise()?;
        let mut st = s.borrow_mut();
        // what the run wrote before the call goes out before it
        st.flush(run);
        let call = st.wait(&ctx, resolve, reject, None);
        st.send(FromScript::Run { run, call, function, args });
        Ok(promise)
    };
    g.set("__run", Function::new(ctx.clone(), call_fn)?)?;

    let s = shared.clone();
    let send = move |ctx: Ctx<'js>, alias: String, given: rquickjs::Value<'js>| -> rquickjs::Result<()> {
        let intent = s.borrow().imports.get(&alias).filter(|i| i.kind == Kind::Topic).map(|i| i.intent);
        let intent = intent.ok_or_else(|| Exception::throw_type(&ctx, &format!("{alias} is not a topic, so it cannot send")))?;
        if intent != Intent::Write {
            return Err(Exception::throw_type(&ctx, &format!("{alias} is imported to read. Import it to write to send on it.")));
        }
        let value = from_js(given)?;
        let mut st = s.borrow_mut();
        // what the run wrote before goes out before the message
        st.flush(run);
        st.send(FromScript::Send { run, alias, value });
        Ok(())
    };
    g.set("__send", Function::new(ctx.clone(), send)?)?;

    let s = shared.clone();
    let form = move |ctx: Ctx<'js>, alias: String| -> rquickjs::Result<rquickjs::Value<'js>> {
        let Some(f) = s.borrow().forms.get(&alias).cloned() else { return Ok(rquickjs::Value::new_undefined(ctx)) };
        to_js(&ctx, &Value::map([("name", f.name.into()), ("fields", Value::List(f.fields.into_iter().map(Value::from).collect()))]))
    };
    g.set("__form", Function::new(ctx.clone(), form)?)?;

    let s = shared.clone();
    let sleep = move |ctx: Ctx<'js>, ms: f64| -> rquickjs::Result<Promise<'js>> {
        let (promise, resolve, reject) = ctx.promise()?;
        let mut st = s.borrow_mut();
        let id = st.wait(&ctx, resolve, reject, None);
        st.timers.push(Reverse((Instant::now() + Duration::from_secs_f64(ms.max(0.0) / 1000.0), id)));
        Ok(promise)
    };
    g.set("__sleep", Function::new(ctx.clone(), sleep)?)?;

    let s = shared.clone();
    g.set("__notify", Function::new(ctx.clone(), move |text: String| s.borrow().send(FromScript::Notify { run, text }))?)?;
    let s = shared.clone();
    g.set("__log", Function::new(ctx.clone(), move |text: String| s.borrow().send(FromScript::Log { run, text }))?)?;
    let s = shared.clone();
    g.set("__fault", Function::new(ctx.clone(), move |text: String| s.borrow().send(FromScript::Fault { run, text }))?)?;
    let s = shared.clone();
    let open = move |ctx: Ctx<'js>, page: String, replace: bool| -> rquickjs::Result<Promise<'js>> {
        let (promise, resolve, reject) = ctx.promise()?;
        let mut st = s.borrow_mut();
        let call = st.wait(&ctx, resolve, reject, None);
        st.send(FromScript::Open { run, page, replace, call });
        Ok(promise)
    };
    g.set("__open", Function::new(ctx.clone(), open)?)?;
    let s = shared.clone();
    let close = move |given: rquickjs::Value<'js>| -> rquickjs::Result<()> {
        let answer = from_js(given)?;
        s.borrow().send(FromScript::Close { run, answer });
        Ok(())
    };
    g.set("__close", Function::new(ctx.clone(), close)?)?;
    // the mode of the run's screen, as it last said, and a new one for it
    const NO_SCREEN: &str = "theme is a screen's, so it works in an element's handler or a screen's logic";
    let s = shared.clone();
    let mode = move |ctx: Ctx<'js>| -> rquickjs::Result<String> {
        let st = s.borrow();
        let session = st.sessions.get(&run).copied().flatten().ok_or_else(|| Exception::throw_type(&ctx, NO_SCREEN))?;
        Ok(if st.modes.get(&session) == Some(&Mode::Light) { "light" } else { "dark" }.to_owned())
    };
    g.set("__mode", Function::new(ctx.clone(), mode)?)?;
    let s = shared.clone();
    let set_mode = move |ctx: Ctx<'js>, given: String| -> rquickjs::Result<()> {
        let mode = match given.as_str() {
            "dark" => Mode::Dark,
            "light" => Mode::Light,
            "device" => Mode::Device,
            _ => return Err(Exception::throw_type(&ctx, &format!("theme.set takes \"dark\", \"light\" or \"device\", not {given:?}"))),
        };
        let mut st = s.borrow_mut();
        let session = st.sessions.get(&run).copied().flatten().ok_or_else(|| Exception::throw_type(&ctx, NO_SCREEN))?;
        // read back at once, till the screen says what the device gave
        if mode != Mode::Device {
            st.modes.insert(session, mode);
        }
        st.send(FromScript::Mode { run, mode });
        Ok(())
    };
    g.set("__setMode", Function::new(ctx.clone(), set_mode)?)?;
    g.set("__budget", Function::new(ctx.clone(), || BUDGET.as_millis() as f64)?)?;

    // with what the code returned, or what stopped it
    let s = shared.clone();
    let end = move |kind: String, given: Opt<rquickjs::Value<'js>>| -> rquickjs::Result<()> {
        let given = given.0;
        let text = || given.clone().and_then(|g| g.as_string().and_then(|t| t.to_string().ok())).unwrap_or_default();
        let end = match kind.as_str() {
            "ok" => match given.clone().map(from_js).transpose() {
                Ok(value) => {
                    s.borrow_mut().returned.insert(run, value.unwrap_or_default());
                    End::Ok
                }
                Err(_) => End::Fault("what it returned is not a value".into()),
            },
            "unknown" => End::Unknown(text()),
            _ => End::Fault(text()),
        };
        finish(&s, run, end);
        Ok(())
    };
    g.set("__end", Function::new(ctx.clone(), end)?)?;

    // each object's members code outside reads, then the run's own object's by name, then the
    // state its element sees, the nearest last so it wins
    let st = shared.borrow();
    let bound = st.bound.get(&run).map_or(&[][..], Vec::as_slice);
    let entry = |name: &str, alias: &str, kind: &str, object: Option<&str>| {
        let mut fields = vec![("name", name.into()), ("alias", alias.into()), ("kind", kind.into())];
        fields.extend(object.map(|o| ("object", o.into())));
        Value::map(fields)
    };
    let members = |o: &object::Object, object: Option<&str>| -> Vec<Value> {
        let seen = |name: &str| object.is_none() || o.global(name) || own == Some(o.name.as_str());
        let mut out: Vec<Value> = o.imports.iter().filter(|i| seen(&i.alias)).map(|i| entry(&i.alias, &o.key(&i.alias), &format!("{:?}", i.kind).to_lowercase(), object)).collect();
        out.extend(o.variables.iter().map(|v| &v.name).chain(o.computed.iter().map(|c| &c.name)).filter(|n| seen(n)).map(|n| entry(n, &o.key(n), "variable", object)));
        out.extend(o.functions.iter().filter(|f| seen(&f.name)).map(|f| entry(&f.name, &o.key(&f.name), "fn", object)));
        out
    };
    let mut imports: Vec<Value> = st.objects.iter().flat_map(|o| members(o, Some(&o.name))).collect();
    imports.extend(st.objects.iter().filter(|o| own == Some(o.name.as_str())).flat_map(|o| members(o, None)));
    imports.extend(bound.iter().map(|(key, v)| entry(&v.name, key, "variable", None)));
    let objects = Value::List(st.objects.iter().map(|o| o.name.as_str().into()).collect());
    drop(st);
    let pages: Vec<Value> = shared.borrow().pages.iter().map(|(key, id)| Value::map([("key", key.as_str().into()), ("id", id.as_str().into())])).collect();
    let options = |e: &EnumInfo| Value::List(e.options.iter().map(|o| o.as_str().into()).collect());
    let enums: Vec<Value> = shared.borrow().enums.iter().map(|e| Value::map([("name", e.name.as_str().into()), ("options", options(e))])).collect();
    let prelude: Function = ctx.eval(PRELUDE)?;
    prelude.call::<_, ()>((to_js(ctx, &Value::List(imports))?, to_js(ctx, &objects)?, to_js(ctx, &Value::List(pages))?, to_js(ctx, &Value::List(enums))?))
}

/// A value as JS reads it: bytes as a Uint8Array, and a whole number past JS's safe ones as a
/// BigInt, so none loses a digit.
fn to_js<'js>(ctx: &Ctx<'js>, v: &Value) -> rquickjs::Result<rquickjs::Value<'js>> {
    use rquickjs::{Array, BigInt, Object, TypedArray};
    const SAFE: i128 = 1 << 53;
    let c = ctx.clone();
    Ok(match v {
        Value::Null => rquickjs::Value::new_null(c),
        Value::Bool(b) => rquickjs::Value::new_bool(c, *b),
        Value::Int(n) => match (i32::try_from(*n), i64::try_from(*n)) {
            (Ok(small), _) => rquickjs::Value::new_int(c, small),
            _ if (-SAFE..=SAFE).contains(n) => rquickjs::Value::new_float(c, *n as f64),
            (_, Ok(big)) => BigInt::from_i64(c, big)?.into_value(),
            _ => BigInt::from_u64(c, u64::try_from(*n).unwrap_or(u64::MAX))?.into_value(),
        },
        Value::Float(f) => rquickjs::Value::new_float(c, *f),
        Value::Text(t) => rquickjs::String::from_str(c, t)?.into_value(),
        Value::Bytes(b) => TypedArray::<u8>::new_copy(c, b)?.into_value(),
        Value::List(_) | Value::Numbers(_) | Value::Records(_) => {
            let list = Array::new(c)?;
            for (i, item) in v.items().unwrap_or_default().iter().enumerate() {
                list.set(i, to_js(ctx, item)?)?;
            }
            list.into_value()
        }
        Value::Map(fields) => {
            let map = Object::new(c)?;
            for (k, field) in fields {
                map.set(k.as_str(), to_js(ctx, field)?)?;
            }
            map.into_value()
        }
    })
}

/// How deep a value JS gives may nest, which also stops one that holds itself.
const DEPTH: usize = 64;

/// A value JS gave. A field that is undefined is left out, as it is absent in JS. What is not a
/// value throws a TypeError, and what reading it throws, as an unknown import, is thrown on.
fn from_js(v: rquickjs::Value) -> rquickjs::Result<Value> {
    read_js(v, 0)
}

fn read_js(v: rquickjs::Value, depth: usize) -> rquickjs::Result<Value> {
    use rquickjs::{Object, Type};
    let ctx = v.ctx().clone();
    let not = |why: &str| Exception::throw_type(&ctx, why);
    if depth > DEPTH {
        return Err(not("a value nests too deep, or holds itself"));
    }
    Ok(match v.type_of() {
        Type::Uninitialized | Type::Undefined | Type::Null => Value::Null,
        Type::Bool => Value::Bool(v.as_bool().unwrap_or(false)),
        Type::Int => Value::Int(v.as_int().unwrap_or(0).into()),
        Type::Float => Value::Float(v.as_float().unwrap_or(f64::NAN)),
        Type::String => Value::Text(v.get::<String>()?),
        // read by its digits, since a BigInt's own to_i64 wraps past i64 without a word
        Type::BigInt => {
            let digits = v.get::<rquickjs::Coerced<String>>()?.0;
            let n = digits.parse::<i128>().ok().filter(|n| (i128::from(i64::MIN)..=i128::from(u64::MAX)).contains(n));
            Value::Int(n.ok_or_else(|| not(&format!("{digits} is past what a whole number holds, i64's least to u64's most")))?)
        }
        // a proxy, as code reads an import's objects and lists through, is read through its traps
        Type::Array | Type::Proxy if lists(&v)? => {
            let list = Object::from_value(v)?;
            let len: u32 = list.get("length")?;
            let items = (0..len).map(|i| read_js(list.get(i)?, depth + 1));
            Value::List(items.collect::<rquickjs::Result<_>>()?)
        }
        Type::Object | Type::Proxy => {
            let map = Object::from_value(v)?;
            if let Some(bytes) = map.as_typed_array::<u8>() {
                // SAFETY: the bytes are copied at once, and no JS runs while they are borrowed
                return Ok(Value::Bytes(unsafe { bytes.as_bytes() }.map(<[u8]>::to_vec).unwrap_or_default()));
            }
            let mut fields = Vec::new();
            for prop in map.props::<String, rquickjs::Value>() {
                let (k, field) = prop?;
                if !field.is_undefined() {
                    fields.push((k, read_js(field, depth + 1)?));
                }
            }
            Value::Map(fields)
        }
        other => return Err(not(&format!("a {} cannot be a value", other.as_str()))),
    })
}

/// Whether `v` is a list, as Array.isArray says: a proxy is one when what it stands for is.
fn lists(v: &rquickjs::Value) -> rquickjs::Result<bool> {
    match v.as_proxy() {
        Some(p) => lists(p.target()?.as_value()),
        None => Ok(v.is_array()),
    }
}

#[cfg(test)]
mod tests;

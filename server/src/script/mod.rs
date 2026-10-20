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
use rquickjs::{Context, Ctx, Exception, Function, Persistent, Promise, Runtime};
use crate::value::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::project::{Import, Intent, Kind, Per, Variable};

/// How long code may run without waiting before it is stopped.
const BUDGET: Duration = Duration::from_millis(250);
const MEMORY: usize = 64 << 20;
const PRELUDE: &str = include_str!("prelude.js");

pub enum ToScript {
    /// Every import, whole, after any change.
    Imports(Vec<Import>),
    /// Every variable, whole, after any change.
    Variables(Vec<Variable>),
    /// Mesh imports and shared variables whose value changed, None while unknown.
    Values(Vec<(String, Option<Value>)>),
    /// A screen's own variables that changed.
    Screen { session: u32, values: Vec<(String, Value)> },
    /// A screen went, and its own variables with it.
    Gone(u32),
    /// Every rule condition, by rule id, whole, after any change.
    Conditions(Vec<(String, String)>),
    /// Judges each condition now, answered with `Judged`.
    Judge,
    /// Every record's source, by name, whole, after any change.
    Records(Vec<(String, String)>),
    /// Reads these records' sources now, answered with `Sampled`.
    Sample(Vec<String>),
    /// Every page as code names it, and its id, whole, after any change.
    Pages(Vec<(String, String)>),
    /// Runs code for a screen, or for none. `p` is what its event brought, `at` the copy of a
    /// repeat it happened on, which the code reads as `index` and `item`.
    Run { run: u64, session: Option<u32>, code: String, p: Value, at: Option<(u32, Value)> },
    /// How a call ended: its answer, or why it failed.
    Answer { call: u64, outcome: Result<Value, CallFailure> },
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
    /// A message to send on a topic.
    Send { run: u64, alias: String, value: Value },
    Notify { run: u64, text: String },
    Log { run: u64, text: String },
    /// Opens a page on the screen that started the run, in place of the top one when `replace`.
    /// `call` answers with what the page closes with.
    Open { run: u64, page: String, replace: bool, call: u64 },
    /// Closes the top page on the screen that started the run, with an answer.
    Close { run: u64, answer: Value },
    Done { run: u64, end: End },
    /// Each condition's truth now. One that reads an unknown value, or fails, is false.
    Judged(Vec<(String, bool)>),
    /// Each record's value now, None where it reads an unknown value or fails.
    Sampled(Vec<(String, Option<Value>)>),
}

/// Expressions read together in a context of their own that reads but never writes, each a
/// function by name.
type Reader = (Context, Vec<(String, Persistent<Function<'static>>)>);

#[derive(Debug, PartialEq)]
pub enum End {
    Ok,
    /// Stopped by reading this mesh import or variable while it was unknown.
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
}

struct Shared {
    out: UnboundedSender<FromScript>,
    imports: HashMap<String, Import>,
    variables: HashMap<String, Variable>,
    values: HashMap<String, Value>,
    /// Each screen's own variables.
    screens: HashMap<u32, HashMap<String, Value>>,
    /// The screen each live run belongs to.
    sessions: HashMap<u64, Option<u32>>,
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

    /// What the run sees: its own write not sent yet, else the latest value, its screen's
    /// for a variable each screen has.
    fn read(&self, run: u64, alias: &str) -> Option<&Value> {
        let own = self.pending.get(&run).and_then(|p| p.iter().find(|(a, _)| a == alias));
        if let Some((_, v)) = own {
            return Some(v);
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
            self.send(FromScript::Write { run, alias, value });
        }
    }

    fn flush_all(&mut self) {
        let runs: Vec<u64> = self.pending.keys().copied().collect();
        runs.into_iter().for_each(|run| self.flush(run));
        let live = &self.live;
        self.pending.retain(|run, _| live.contains(run));
    }

    fn wait<'js>(&mut self, ctx: &Ctx<'js>, resolve: Function<'js>, reject: Function<'js>) -> u64 {
        self.next += 1;
        self.waiters.insert(self.next, Waiter { resolve: Persistent::save(ctx, resolve), reject: Persistent::save(ctx, reject) });
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
    home.with(|ctx| {
        let failure: Function = ctx.eval("(status, message) => Object.assign(new Error(message), { name: 'CallError', status })").expect("the failure maker compiles");
        ctx.globals().set("__failure", failure).expect("globals take a function");
    });
    let shared = Rc::new(RefCell::new(Shared {
        out,
        imports: HashMap::new(),
        variables: HashMap::new(),
        values: HashMap::new(),
        screens: HashMap::new(),
        sessions: HashMap::new(),
        pages: Vec::new(),
        live: HashSet::new(),
        pending: HashMap::new(),
        waiters: HashMap::new(),
        timers: BinaryHeap::new(),
        next: 0,
    }));
    // conditions and records are read each in a reader made anew when what they read or say
    // changes
    let mut conditions: Vec<(String, String)> = Vec::new();
    let mut judge: Option<Reader> = None;
    let mut records: Vec<(String, String)> = Vec::new();
    let mut sampler: Option<Reader> = None;
    loop {
        let next_timer = shared.borrow().timers.peek().map(|Reverse((t, _))| t.saturating_duration_since(Instant::now()));
        let msg = match next_timer {
            Some(wait) => from.recv_timeout(wait),
            None => from.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match msg {
            Ok(ToScript::Conditions(list)) => {
                conditions = list;
                judge = None;
            }
            Ok(ToScript::Judge) => {
                if judge.is_none() {
                    let sources = conditions.iter().map(|(id, c)| (id.clone(), format!("() => !!({c}\n)"))).collect::<Vec<_>>();
                    judge = Some(make_reader(&rt, &shared, &sources));
                }
                let (ctx, fns) = judge.as_ref().expect("made above");
                let truths = ctx.with(|ctx| {
                    fns.iter()
                        .map(|(id, f)| {
                            deadline.set(Some(Instant::now() + BUDGET));
                            let truth = f.clone().restore(&ctx).and_then(|f| f.call::<_, bool>(())).unwrap_or_else(|_| {
                                ctx.catch();
                                false
                            });
                            (id.clone(), truth)
                        })
                        .collect()
                });
                deadline.set(None);
                shared.borrow().send(FromScript::Judged(truths));
            }
            Ok(ToScript::Records(list)) => {
                records = list;
                sampler = None;
            }
            Ok(ToScript::Sample(names)) => {
                if sampler.is_none() {
                    let sources = records.iter().map(|(name, s)| (name.clone(), format!("() => ({s}\n)"))).collect::<Vec<_>>();
                    sampler = Some(make_reader(&rt, &shared, &sources));
                }
                let (ctx, fns) = sampler.as_ref().expect("made above");
                let read = ctx.with(|ctx| {
                    fns.iter()
                        .filter(|(name, _)| names.contains(name))
                        .map(|(name, f)| {
                            deadline.set(Some(Instant::now() + BUDGET));
                            let got = f.clone().restore(&ctx).and_then(|f| f.call::<_, rquickjs::Value>(()));
                            let value = match got {
                                Ok(v) => from_js(v).ok(),
                                Err(_) => {
                                    ctx.catch();
                                    None
                                }
                            };
                            (name.clone(), value)
                        })
                        .collect()
                });
                deadline.set(None);
                shared.borrow().send(FromScript::Sampled(read));
            }
            Ok(msg @ (ToScript::Imports(_) | ToScript::Variables(_))) => {
                judge = None;
                sampler = None;
                handle(&rt, &home, &shared, &deadline, msg);
            }
            Ok(msg) => handle(&rt, &home, &shared, &deadline, msg),
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

/// The context conditions are judged in: the imports and variables to read, writes refused,
/// and each condition compiled once. One that does not compile is never true.
/// A reader of each `source`, a function's text, by name. One that does not compile is left out.
fn make_reader(rt: &Runtime, shared: &Rc<RefCell<Shared>>, sources: &[(String, String)]) -> Reader {
    let ctx = Context::full(rt).expect("QuickJS makes a context");
    let fns = ctx.with(|ctx| {
        if install(&ctx, 0, shared, &Value::Null, None).is_err() {
            ctx.catch();
            return Vec::new();
        }
        let refuse = Function::new(ctx.clone(), |ctx: Ctx<'_>| -> rquickjs::Result<()> { Err(Exception::throw_type(&ctx, "this only reads")) });
        if let Ok(f) = refuse {
            let _ = ctx.globals().set("__write", f);
        }
        sources
            .iter()
            .filter_map(|(id, source)| match ctx.eval::<Function, _>(source.as_str()) {
                Ok(f) => Some((id.clone(), Persistent::save(&ctx, f))),
                Err(_) => {
                    ctx.catch();
                    None
                }
            })
            .collect()
    });
    (ctx, fns)
}

fn handle(rt: &Runtime, home: &Context, shared: &Rc<RefCell<Shared>>, deadline: &Cell<Option<Instant>>, msg: ToScript) {
    match msg {
        ToScript::Imports(list) => shared.borrow_mut().imports = list.into_iter().map(|i| (i.alias.clone(), i)).collect(),
        // the loop takes these itself, since they need the readers it keeps
        ToScript::Conditions(_) | ToScript::Judge | ToScript::Records(_) | ToScript::Sample(_) => {}
        ToScript::Pages(list) => shared.borrow_mut().pages = list,
        ToScript::Variables(list) => shared.borrow_mut().variables = list.into_iter().map(|v| (v.name.clone(), v)).collect(),
        ToScript::Screen { session, values } => shared.borrow_mut().screens.entry(session).or_default().extend(values),
        ToScript::Gone(session) => {
            shared.borrow_mut().screens.remove(&session);
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
        ToScript::Run { run, session, code, p, at } => {
            let mut s = shared.borrow_mut();
            s.live.insert(run);
            s.sessions.insert(run, session);
            drop(s);
            let ctx = match Context::full(rt) {
                Ok(ctx) => ctx,
                Err(e) => return finish(shared, run, End::Fault(format!("could not start: {e}"))),
            };
            let failed = ctx.with(|ctx| {
                if let Err(e) = install(&ctx, run, shared, &p, at.as_ref()) {
                    return Some(format!("could not start: {e}"));
                }
                deadline.set(Some(Instant::now() + BUDGET));
                let source = format!("(async () => {{\n{code}\n}})().then(() => __end(\"ok\"), __finish);");
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
    s.send(FromScript::Done { run, end });
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

/// The host side of what `prelude.js` builds on, bound to one run, then the prelude itself.
fn install<'js>(ctx: &Ctx<'js>, run: u64, shared: &Rc<RefCell<Shared>>, p: &Value, at: Option<&(u32, Value)>) -> rquickjs::Result<()> {
    let g = ctx.globals();
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
        let mut st = s.borrow_mut();
        if let Some(v) = st.variables.get(&alias) {
            if v.per == Per::Screen && st.sessions.get(&run).copied().flatten().is_none() {
                return Err(Exception::throw_type(&ctx, &format!("{alias} is each screen's own, and this handler runs for no screen")));
            }
        } else {
            let import = st.imports.get(&alias).ok_or_else(|| Exception::throw_reference(&ctx, &format!("{alias} names no mesh import, variable or record")))?;
            if import.kind != Kind::Variable {
                return Err(Exception::throw_type(&ctx, &format!("{alias} is not a variable, so it cannot be set")));
            }
            if import.intent != Intent::Write {
                return Err(Exception::throw_type(&ctx, &format!("{alias} is imported to read. Import it to write to change it.")));
            }
        }
        let value = from_js(given).map_err(|e| Exception::throw_type(&ctx, &e))?;
        st.stage(run, alias, value);
        Ok(())
    };
    g.set("__write", Function::new(ctx.clone(), write)?)?;

    let s = shared.clone();
    let call = move |ctx: Ctx<'js>, alias: String, given: rquickjs::Value<'js>| -> rquickjs::Result<Promise<'js>> {
        let mut st = s.borrow_mut();
        let import = st.imports.get(&alias).filter(|i| i.kind == Kind::Function);
        let import = import.ok_or_else(|| Exception::throw_type(&ctx, &format!("{alias} is not a function on the mesh")))?;
        if import.intent != Intent::Write {
            return Err(Exception::throw_type(&ctx, &format!("{alias} is imported to read. Import it to write to call it.")));
        }
        let request = from_js(given).map_err(|e| Exception::throw_type(&ctx, &e))?;
        let (promise, resolve, reject) = ctx.promise()?;
        // what the run wrote before the call goes out before it
        st.flush(run);
        let call = st.wait(&ctx, resolve, reject);
        st.send(FromScript::Call { run, call, alias, request });
        Ok(promise)
    };
    g.set("__call", Function::new(ctx.clone(), call)?)?;

    let s = shared.clone();
    let send = move |ctx: Ctx<'js>, alias: String, given: rquickjs::Value<'js>| -> rquickjs::Result<()> {
        let mut st = s.borrow_mut();
        let import = st.imports.get(&alias).filter(|i| i.kind == Kind::Topic);
        let import = import.ok_or_else(|| Exception::throw_type(&ctx, &format!("{alias} is not a topic, so it cannot send")))?;
        if import.intent != Intent::Write {
            return Err(Exception::throw_type(&ctx, &format!("{alias} is imported to read. Import it to write to send on it.")));
        }
        let value = from_js(given).map_err(|e| Exception::throw_type(&ctx, &e))?;
        // what the run wrote before goes out before the message
        st.flush(run);
        st.send(FromScript::Send { run, alias, value });
        Ok(())
    };
    g.set("__send", Function::new(ctx.clone(), send)?)?;

    let s = shared.clone();
    let sleep = move |ctx: Ctx<'js>, ms: f64| -> rquickjs::Result<Promise<'js>> {
        let (promise, resolve, reject) = ctx.promise()?;
        let mut st = s.borrow_mut();
        let id = st.wait(&ctx, resolve, reject);
        st.timers.push(Reverse((Instant::now() + Duration::from_secs_f64(ms.max(0.0) / 1000.0), id)));
        Ok(promise)
    };
    g.set("__sleep", Function::new(ctx.clone(), sleep)?)?;

    let s = shared.clone();
    g.set("__notify", Function::new(ctx.clone(), move |text: String| s.borrow().send(FromScript::Notify { run, text }))?)?;
    let s = shared.clone();
    g.set("__log", Function::new(ctx.clone(), move |text: String| s.borrow().send(FromScript::Log { run, text }))?)?;
    let s = shared.clone();
    let open = move |ctx: Ctx<'js>, page: String, replace: bool| -> rquickjs::Result<Promise<'js>> {
        let (promise, resolve, reject) = ctx.promise()?;
        let mut st = s.borrow_mut();
        let call = st.wait(&ctx, resolve, reject);
        st.send(FromScript::Open { run, page, replace, call });
        Ok(promise)
    };
    g.set("__open", Function::new(ctx.clone(), open)?)?;
    let s = shared.clone();
    let close = move |ctx: Ctx<'js>, given: rquickjs::Value<'js>| -> rquickjs::Result<()> {
        let answer = from_js(given).map_err(|e| Exception::throw_type(&ctx, &e))?;
        s.borrow().send(FromScript::Close { run, answer });
        Ok(())
    };
    g.set("__close", Function::new(ctx.clone(), close)?)?;
    g.set("__budget", Function::new(ctx.clone(), || BUDGET.as_millis() as f64)?)?;

    let s = shared.clone();
    let end = move |kind: String, text: Opt<String>| {
        let text = text.0.unwrap_or_default();
        let end = match kind.as_str() {
            "ok" => End::Ok,
            "unknown" => End::Unknown(text),
            _ => End::Fault(text),
        };
        finish(&s, run, end);
    };
    g.set("__end", Function::new(ctx.clone(), end)?)?;

    // a variable reads and takes assignment as a variable import does
    let st = shared.borrow();
    let entry = |alias: &str, kind: String| Value::map([("alias", alias.into()), ("kind", kind.into())]);
    let mut imports: Vec<Value> = st.imports.values().map(|i| entry(&i.alias, format!("{:?}", i.kind).to_lowercase())).collect();
    imports.extend(st.variables.keys().map(|name| entry(name, "variable".into())));
    drop(st);
    let pages: Vec<Value> = shared.borrow().pages.iter().map(|(key, id)| Value::map([("key", key.as_str().into()), ("id", id.as_str().into())])).collect();
    let prelude: Function = ctx.eval(PRELUDE)?;
    prelude.call::<_, ()>((to_js(ctx, &Value::List(imports))?, to_js(ctx, &Value::List(pages))?))
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
        Value::List(items) => {
            let list = Array::new(c)?;
            for (i, item) in items.iter().enumerate() {
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

/// A value JS gave. A field that is undefined is left out, as it is absent in JS.
fn from_js(v: rquickjs::Value) -> Result<Value, String> {
    read_js(v, 0)
}

fn read_js(v: rquickjs::Value, depth: usize) -> Result<Value, String> {
    use rquickjs::{Array, Object, Type};
    if depth > DEPTH {
        return Err("a value nests too deep, or holds itself".into());
    }
    Ok(match v.type_of() {
        Type::Uninitialized | Type::Undefined | Type::Null => Value::Null,
        Type::Bool => Value::Bool(v.as_bool().unwrap_or(false)),
        Type::Int => Value::Int(v.as_int().unwrap_or(0).into()),
        Type::Float => Value::Float(v.as_float().unwrap_or(f64::NAN)),
        Type::String => Value::Text(v.get::<String>().map_err(|e| e.to_string())?),
        // read by its digits, since a BigInt's own to_i64 wraps past i64 without a word
        Type::BigInt => {
            let digits = v.get::<rquickjs::Coerced<String>>().map_err(|e| e.to_string())?.0;
            let n = digits.parse::<i128>().ok().filter(|n| (i128::from(i64::MIN)..=i128::from(u64::MAX)).contains(n));
            Value::Int(n.ok_or_else(|| format!("{digits} is past what a whole number holds, i64's least to u64's most"))?)
        }
        Type::Array => {
            let list = Array::from_value(v).map_err(|e| e.to_string())?;
            let mut items = Vec::with_capacity(list.len());
            for item in list.iter::<rquickjs::Value>() {
                items.push(read_js(item.map_err(|e| e.to_string())?, depth + 1)?);
            }
            Value::List(items)
        }
        Type::Object => {
            let map = Object::from_value(v).map_err(|e| e.to_string())?;
            if let Some(bytes) = map.as_typed_array::<u8>() {
                // SAFETY: the bytes are copied at once, and no JS runs while they are borrowed
                return Ok(Value::Bytes(unsafe { bytes.as_bytes() }.map(<[u8]>::to_vec).unwrap_or_default()));
            }
            let mut fields = Vec::new();
            for prop in map.props::<String, rquickjs::Value>() {
                let (k, field) = prop.map_err(|e| e.to_string())?;
                if !field.is_undefined() {
                    fields.push((k, read_js(field, depth + 1)?));
                }
            }
            Value::Map(fields)
        }
        other => return Err(format!("a {} cannot be a value", other.as_str())),
    })
}

#[cfg(test)]
mod tests;

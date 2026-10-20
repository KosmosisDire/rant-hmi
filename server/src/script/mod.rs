//! Handlers run here, in QuickJS on a thread of its own. Each run gets a context of its own,
//! so runs never share names. The app sends what code may read and the runs to start, and
//! hears back what each run writes, calls and says. A run's writes wait until it ends or
//! awaits, then go out together, so a run stopped by an unknown value leaves nothing half done.

use std::cell::{Cell, RefCell};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::rc::Rc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use rquickjs::context::EvalOptions;
use rquickjs::function::Opt;
use rquickjs::{Context, Ctx, Exception, Function, Persistent, Promise, Runtime};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::project::{Import, Intent, Kind};

/// How long code may run without waiting before it is stopped.
const BUDGET: Duration = Duration::from_millis(250);
const MEMORY: usize = 64 << 20;
const PRELUDE: &str = include_str!("prelude.js");

pub enum ToScript {
    /// Every import, whole, after any change.
    Imports(Vec<Import>),
    /// Datapoints whose value changed, None while unknown.
    Values(Vec<(String, Option<Value>)>),
    /// Every page as code names it, and its id, whole, after any change.
    Pages(Vec<(String, String)>),
    Run { run: u64, code: String },
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
    Notify { run: u64, text: String },
    Log { run: u64, text: String },
    /// Opens a page on the screen that started the run, in place of the top one when `replace`.
    Open { run: u64, page: String, replace: bool },
    /// Closes the top page on the screen that started the run.
    Close { run: u64 },
    Done { run: u64, end: End },
}

#[derive(Debug, PartialEq)]
pub enum End {
    Ok,
    /// Stopped by reading this datapoint while it was unknown.
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
    values: HashMap<String, Value>,
    pages: Vec<(String, String)>,
    /// Runs not ended yet.
    live: HashSet<u64>,
    /// Each run's writes not sent yet, one per datapoint, in the order first made. Code a run
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

    /// What the run sees: its own write not sent yet, else the latest value.
    fn read(&self, run: u64, alias: &str) -> Option<&Value> {
        let own = self.pending.get(&run).and_then(|p| p.iter().find(|(a, _)| a == alias));
        own.map(|(_, v)| v).or_else(|| self.values.get(alias))
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
        values: HashMap::new(),
        pages: Vec::new(),
        live: HashSet::new(),
        pending: HashMap::new(),
        waiters: HashMap::new(),
        timers: BinaryHeap::new(),
        next: 0,
    }));
    loop {
        let next_timer = shared.borrow().timers.peek().map(|Reverse((t, _))| t.saturating_duration_since(Instant::now()));
        let msg = match next_timer {
            Some(wait) => from.recv_timeout(wait),
            None => from.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match msg {
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
    shared.borrow_mut().waiters.clear();
}

fn handle(rt: &Runtime, home: &Context, shared: &Rc<RefCell<Shared>>, deadline: &Cell<Option<Instant>>, msg: ToScript) {
    match msg {
        ToScript::Imports(list) => shared.borrow_mut().imports = list.into_iter().map(|i| (i.alias.clone(), i)).collect(),
        ToScript::Pages(list) => shared.borrow_mut().pages = list,
        ToScript::Values(list) => {
            let mut s = shared.borrow_mut();
            for (alias, value) in list {
                match value {
                    Some(v) => s.values.insert(alias, v),
                    None => s.values.remove(&alias),
                };
            }
        }
        ToScript::Run { run, code } => {
            shared.borrow_mut().live.insert(run);
            let ctx = match Context::full(rt) {
                Ok(ctx) => ctx,
                Err(e) => return finish(shared, run, End::Fault(format!("could not start: {e}"))),
            };
            let failed = ctx.with(|ctx| {
                if let Err(e) = install(&ctx, run, shared) {
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
    s.send(FromScript::Done { run, end });
}

fn settle(home: &Context, w: Waiter, outcome: Result<Value, CallFailure>) {
    home.with(|ctx| {
        let settled = match outcome {
            Ok(value) => w.resolve.restore(&ctx).and_then(|f| f.call::<_, ()>((ctx.json_parse(value.to_string())?,))),
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
fn install<'js>(ctx: &Ctx<'js>, run: u64, shared: &Rc<RefCell<Shared>>) -> rquickjs::Result<()> {
    let g = ctx.globals();
    let s = shared.clone();
    g.set("__read", Function::new(ctx.clone(), move |alias: String| s.borrow().read(run, &alias).map(Value::to_string))?)?;

    let s = shared.clone();
    let write = move |ctx: Ctx<'js>, alias: String, json: String| -> rquickjs::Result<()> {
        let mut st = s.borrow_mut();
        let import = st.imports.get(&alias).ok_or_else(|| Exception::throw_reference(&ctx, &format!("{alias} names no datapoint")))?;
        if import.kind != Kind::Variable {
            return Err(Exception::throw_type(&ctx, &format!("{alias} is not a variable, so it cannot be set")));
        }
        if import.intent != Intent::Write {
            return Err(Exception::throw_type(&ctx, &format!("{alias} is imported to read. Import it to write to change it.")));
        }
        let value = serde_json::from_str(&json).map_err(|e| Exception::throw_type(&ctx, &e.to_string()))?;
        st.stage(run, alias, value);
        Ok(())
    };
    g.set("__write", Function::new(ctx.clone(), write)?)?;

    let s = shared.clone();
    let call = move |ctx: Ctx<'js>, alias: String, json: String| -> rquickjs::Result<Promise<'js>> {
        let mut st = s.borrow_mut();
        let import = st.imports.get(&alias).filter(|i| i.kind == Kind::Function);
        let import = import.ok_or_else(|| Exception::throw_type(&ctx, &format!("{alias} is not a function on the mesh")))?;
        if import.intent != Intent::Write {
            return Err(Exception::throw_type(&ctx, &format!("{alias} is imported to read. Import it to write to call it.")));
        }
        let request = serde_json::from_str(&json).map_err(|e| Exception::throw_type(&ctx, &e.to_string()))?;
        let (promise, resolve, reject) = ctx.promise()?;
        // what the run wrote before the call goes out before it
        st.flush(run);
        let call = st.wait(&ctx, resolve, reject);
        st.send(FromScript::Call { run, call, alias, request });
        Ok(promise)
    };
    g.set("__call", Function::new(ctx.clone(), call)?)?;

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
    g.set("__open", Function::new(ctx.clone(), move |page: String, replace: bool| s.borrow().send(FromScript::Open { run, page, replace }))?)?;
    let s = shared.clone();
    g.set("__close", Function::new(ctx.clone(), move || s.borrow().send(FromScript::Close { run }))?)?;
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

    let imports: Vec<Value> = shared
        .borrow()
        .imports
        .values()
        .map(|i| serde_json::json!({ "alias": i.alias, "kind": format!("{:?}", i.kind).to_lowercase() }))
        .collect();
    let pages: Vec<Value> = shared.borrow().pages.iter().map(|(key, id)| serde_json::json!({ "key": key, "id": id })).collect();
    let prelude: Function = ctx.eval(PRELUDE)?;
    prelude.call::<_, ()>((ctx.json_parse(Value::Array(imports).to_string())?, ctx.json_parse(Value::Array(pages).to_string())?))
}

#[cfg(test)]
mod tests;

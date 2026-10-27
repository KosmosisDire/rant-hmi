//! The slice end to end in one process, on this host only: a line node offers a topic and a
//! variable, the HMI's mesh imports both, sees their values and sets the variable, and the HMI
//! publishes its own status.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use rant::types::Timestamp;
use rant::{Bytes, FunctionOptions, Node, NodeOptions, Qos, TaskOptions, TaskRequest, VariableOptions};
use rant_hmi::fields::Keep;
use rant_hmi::mesh::{Delivery, Mesh, MeshOptions};
use rant_hmi::project::{Import, Intent, Kind};
use rant_hmi::status::{self, Client, HmiStatus};
use rant_hmi::value::Value;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

/// Kept apart from other tests on this host.
const DOMAIN: u16 = 152;

#[derive(rant::Message, Clone)]
struct Conveyor {
    speed: f64,
    running: bool,
    part: rant::String<16>,
}

fn import(alias: &str, entity: &str, kind: Kind, intent: Intent) -> Import {
    Import { alias: alias.into(), entity: entity.into(), kind, intent, rate: None }
}

/// What reading these top level fields of an attached import keeps.
fn reading(mesh: &Mesh, alias: &str, fields: &[&str]) -> Keep {
    Keep::typed(mesh.shapes(alias).unwrap(), &fields.iter().map(|f| vec![f.to_string()]).collect::<Vec<_>>())
}

fn within(what: &str, start: Instant) {
    assert!(start.elapsed() < Duration::from_secs(10), "timed out waiting for {what}");
    std::thread::sleep(Duration::from_millis(20));
}

/// Every delivery, kept in order until a test asks for its alias.
struct Inbox {
    rx: UnboundedReceiver<Delivery>,
    kept: VecDeque<Delivery>,
}

impl Inbox {
    fn next(&mut self, alias: &str, pump: impl FnMut()) -> Value {
        self.until(alias, pump, |_| true).value
    }

    /// The first of `alias`'s deliveries that `fits`, dropping those before it.
    fn until(&mut self, alias: &str, mut pump: impl FnMut(), fits: impl Fn(&Value) -> bool) -> Delivery {
        let start = Instant::now();
        loop {
            pump();
            while let Ok(d) = self.rx.try_recv() {
                self.kept.push_back(d);
            }
            while let Some(at) = self.kept.iter().position(|d| d.alias == alias) {
                let d = self.kept.remove(at).unwrap();
                if fits(&d.value) {
                    return d;
                }
            }
            within(&format!("a value for {alias}"), start);
        }
    }
}

#[test]
fn import_watch_and_set() {
    let local = || NodeOptions::new().domain(DOMAIN).multicast_interface("127.0.0.1").max_topics(16);
    let line = Node::new("test_line", local()).unwrap();
    let speed = line.variable_definition::<f64>("Line1/Speed", VariableOptions::new().initial(0.5)).unwrap();
    let conveyor = line.publisher::<Conveyor>("Line1/Conveyor", Qos::new()).unwrap();

    let (tx, rx) = unbounded_channel();
    let mut inbox = Inbox { rx, kept: VecDeque::new() };
    let (frames, _) = unbounded_channel();
    let mut mesh = Mesh::open(&MeshOptions { name: "hmi_test".into(), domain: DOMAIN, loopback: true }, tx, frames).unwrap();
    let watch = import("Conveyor", "Line1/Conveyor", Kind::Topic, Intent::Read);
    let set = import("Speed", "Line1/Speed", Kind::Variable, Intent::Write);
    let start = Instant::now();
    while !(mesh.attach(&watch) && mesh.attach(&set)) {
        within("both entities to attach", start);
    }
    assert!(mesh.entities().iter().any(|e| e.name == "Line1/Conveyor" && e.kind == Kind::Topic));
    // what is read follows the attach, before any value came
    assert!(mesh.keep("Conveyor", Keep::All).is_none());

    let sent = Conveyor { speed: 0.75, running: true, part: "A7".parse().unwrap() };
    let got = inbox.next("Conveyor", || {
        conveyor.send(&sent).unwrap();
    });
    assert_eq!(got, Value::map([("speed", 0.75.into()), ("running", true.into()), ("part", "A7".into())]));
    // it decodes only the fields read, and the last value again at once when more are read
    assert!(mesh.keep("Conveyor", reading(&mesh, "Conveyor", &["speed"])).is_none());
    let later = Conveyor { speed: 0.8, ..sent.clone() };
    let narrow = inbox.until("Conveyor", || conveyor.send(&later).unwrap(), |v| v.get("running").is_none());
    assert_eq!(narrow.value, Value::map([("speed", 0.8.into())]));
    let again = mesh.keep("Conveyor", reading(&mesh, "Conveyor", &["speed", "part"])).unwrap();
    assert_eq!(again.value, Value::map([("speed", 0.8.into()), ("part", "A7".into())]));
    assert!(again.seq >= narrow.seq);
    assert!(mesh.keep("Conveyor", Keep::All).is_some_and(|d| d.value.get("running").is_some()));

    assert_eq!(inbox.next("Speed", || {}), Value::Float(0.5));
    mesh.set("Speed", "", Value::Float(1.25), None).unwrap();
    let start = Instant::now();
    while speed.get().unwrap() != Some(1.25) {
        within("the owner to take the write", start);
    }
    assert_eq!(inbox.next("Speed", || {}), Value::Float(1.25));

    // imported to read it cannot send, and once changed to write it can
    let part = Value::map([("speed", 0.5.into()), ("running", false.into()), ("part", "B2".into())]);
    assert!(mesh.send("Conveyor", &part).is_err());
    assert!(mesh.attach(&import("Conveyor", "Line1/Conveyor", Kind::Topic, Intent::Write)));
    mesh.send("Conveyor", &part).unwrap();
}

#[test]
fn publishes_its_own_status() {
    // a domain of its own, since every HMI node defines the same two entities
    let local = || NodeOptions::new().domain(DOMAIN + 2).multicast_interface("127.0.0.1").max_topics(16);
    let (tx, rx) = unbounded_channel();
    let mut inbox = Inbox { rx, kept: VecDeque::new() };
    let (frames, _) = unbounded_channel();
    let mut mesh = Mesh::open(&MeshOptions { name: "hmi_status".into(), domain: DOMAIN + 2, loopback: true }, tx, frames).unwrap();
    let status = HmiStatus { version: "1.2.3".into(), project: "demo".into(), started_at: Timestamp { us: 1_700_000_000_000_000 }, clients: 1, missing: vec!["Line1/Gone".try_into().unwrap()] };
    let clients = vec![Client { id: 4, address: "10.0.0.9".try_into().unwrap(), connected_at: Timestamp { us: 1_700_000_001_000_000 }, ping_ms: 2.5, jitter_ms: 0.4, webrtc: true, channel: true, ping_spread_ms: [2.4, 3.1, 4.0], big_spread_ms: [9.5, 14.0, 20.0], bigs_per_s: 11.5, lapsed: 0, kbps: 1500.0, webrtc_problem: "".try_into().unwrap() }];
    mesh.publish_status(status.clone());
    mesh.publish_clients(clients.clone());

    // the HMI's own import reads what it published, and the next change
    let own = import("Status", status::STATUS, Kind::Variable, Intent::Read);
    let start = Instant::now();
    while !mesh.attach(&own) {
        within("its own status to attach", start);
    }
    // a new import reads nothing until it is told what is read, which gives the value again
    assert_eq!(inbox.next("Status", || {}), Value::map::<&str>([]));
    assert_eq!(mesh.keep("Status", Keep::All).unwrap().value, status::status_value(&status));
    let later = HmiStatus { clients: 0, ..status.clone() };
    mesh.publish_status(later.clone());
    assert_eq!(inbox.next("Status", || {}), status::status_value(&later));
    assert!(mesh.set("Status", "", Value::Null, None).unwrap_err().contains("only it sets"));
    // one that reads some fields gets only those of its own value too, and more at once
    assert!(mesh.keep("Status", reading(&mesh, "Status", &["clients"])).is_none());
    let latest = HmiStatus { clients: 2, ..later.clone() };
    mesh.publish_status(latest.clone());
    assert_eq!(inbox.next("Status", || {}), Value::map([("clients", 2u32.into())]));
    let again = mesh.keep("Status", reading(&mesh, "Status", &["clients", "version"])).unwrap();
    assert_eq!(again.value, Value::map([("version", "1.2.3".into()), ("clients", 2u32.into())]));

    // another node reads both as the mesh carries them
    let other = Node::new("status_reader", local()).unwrap();
    let read = other.remote_variable::<HmiStatus>(status::STATUS, VariableOptions::new()).unwrap();
    let list = other.remote_variable::<Vec<Client>>(status::CLIENTS, VariableOptions::new()).unwrap();
    let start = Instant::now();
    while !(read.get().unwrap() == Some(latest.clone()) && list.get().unwrap() == Some(clients.clone())) {
        within("another node to read the status", start);
    }
}

#[test]
fn calls_a_function_that_takes_nothing() {
    let local = || NodeOptions::new().domain(DOMAIN + 4).multicast_interface("127.0.0.1").max_topics(16);
    let cam = Node::new("test_cam", local()).unwrap();
    let homed = Arc::new(AtomicU32::new(0));
    let count = homed.clone();
    // untyped both ways, as a camera's Home is
    let _home = cam
        .function_definition::<Bytes, Bytes, _>("Cam/Home", FunctionOptions::new(), move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        })
        .unwrap();

    let (tx, _rx) = unbounded_channel();
    let (frames, _) = unbounded_channel();
    let mut mesh = Mesh::open(&MeshOptions { name: "hmi_caller".into(), domain: DOMAIN + 4, loopback: true }, tx, frames).unwrap();
    let home = import("Home", "Cam/Home", Kind::Function, Intent::Write);
    let start = Instant::now();
    while !mesh.attach(&home) {
        within("the function to attach", start);
    }
    assert!(mesh.call("Home", &Value::map::<&str>([]), 1, |_| {}).is_ok());
    assert_eq!(mesh.call("Home", &Value::Float(1.0), 2, |_| {}).err().unwrap(), "Home takes nothing");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let start = Instant::now();
    loop {
        // the provider may not be known for a moment, so a first call can find none
        if runtime.block_on(mesh.call("Home", &Value::Null, 3, |_| {}).unwrap()).is_ok() {
            break;
        }
        within("a call to reach the provider", start);
    }
    assert!(homed.load(Ordering::SeqCst) >= 1);
}

#[test]
fn calls_a_task_that_reports_progress_and_cancels_it() {
    let local = || NodeOptions::new().domain(DOMAIN + 6).multicast_interface("127.0.0.1").max_topics(16);
    let line = Node::new("test_filler", local()).unwrap();
    // fills `parts` parts, each a share of the run, and hands back how many it filled
    let _fill = line
        .task_definition("Line/Fill", TaskOptions::new(), |req: TaskRequest<u32, f32, u32>| {
            let parts = *req;
            let task = req.defer();
            std::thread::spawn(move || {
                for part in 1..=parts {
                    if task.cancelled() {
                        return task.complete_cancelled("stopped", Some(&(part - 1)));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                    task.progress(&(part as f32 / parts as f32))?;
                }
                task.complete(&parts)
            });
        })
        .unwrap();

    let (tx, _rx) = unbounded_channel();
    let (frames, _) = unbounded_channel();
    let mut mesh = Mesh::open(&MeshOptions { name: "hmi_tasker".into(), domain: DOMAIN + 6, loopback: true }, tx, frames).unwrap();
    let fill = import("Fill", "Line/Fill", Kind::Task, Intent::Write);
    let start = Instant::now();
    while !mesh.attach(&fill) {
        within("the task to attach", start);
    }
    assert!(mesh.entities().iter().any(|e| e.name == "Line/Fill" && e.progress.is_some()), "a task lists its progress type");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let (shares, heard) = std::sync::mpsc::channel();
    let start = Instant::now();
    let answer = loop {
        let shares = shares.clone();
        // the provider may not be known for a moment, so a first call can find none
        if let Ok(answer) = runtime.block_on(mesh.call("Fill", &Value::Int(4), 1, move |v| drop(shares.send(v))).unwrap()) {
            break answer;
        }
        within("a call to reach the provider", start);
    };
    assert_eq!(answer, Value::Int(4));
    let got: Vec<Value> = heard.try_iter().collect();
    assert_eq!(got, [0.25, 0.5, 0.75, 1.0].map(Value::Float), "every update comes, in order, before the answer");

    // one call by its handler's id, while another goes on
    let (shares, heard) = std::sync::mpsc::channel();
    let one = mesh.call("Fill", &Value::Int(1000), 2, move |v| drop(shares.send(v))).unwrap();
    let (shares, other_heard) = std::sync::mpsc::channel();
    let other = mesh.call("Fill", &Value::Int(30), 3, move |v| drop(shares.send(v))).unwrap();
    heard.recv_timeout(Duration::from_secs(5)).expect("the long call to start");
    other_heard.recv_timeout(Duration::from_secs(5)).expect("the other call to start");
    mesh.cancel("Fill", Some(2)).unwrap();
    assert_eq!(runtime.block_on(one).err().map(|f| f.status).as_deref(), Some("cancelled"));
    assert_eq!(runtime.block_on(other).ok(), Some(Value::Int(30)), "a cancel of one call leaves the other");

    // every call in flight
    let mut calls = Vec::new();
    for call in [4, 5] {
        let (shares, heard) = std::sync::mpsc::channel();
        calls.push(mesh.call("Fill", &Value::Int(1000), call, move |v| drop(shares.send(v))).unwrap());
        heard.recv_timeout(Duration::from_secs(5)).expect("each call to start");
    }
    mesh.cancel("Fill", None).unwrap();
    for call in calls {
        assert_eq!(runtime.block_on(call).err().map(|f| f.status).as_deref(), Some("cancelled"));
    }
    assert!(mesh.cancel("Fill", Some(4)).is_ok(), "a call that ended cancels to no effect");
}

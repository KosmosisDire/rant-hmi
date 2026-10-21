//! The slice end to end in one process, on this host only: a line node offers a topic and a
//! variable, the HMI's mesh imports both, sees their values and sets the variable, and the HMI
//! publishes its own status.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use rant::{Bytes, FunctionOptions, Node, NodeOptions, Qos, VariableOptions};
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
    Import { alias: alias.into(), entity: entity.into(), kind, intent }
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
    fn next(&mut self, alias: &str, mut pump: impl FnMut()) -> Value {
        let start = Instant::now();
        loop {
            pump();
            while let Ok(d) = self.rx.try_recv() {
                self.kept.push_back(d);
            }
            if let Some(at) = self.kept.iter().position(|d| d.alias == alias) {
                return self.kept.remove(at).unwrap().value;
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

    let sent = Conveyor { speed: 0.75, running: true, part: "A7".parse().unwrap() };
    let got = inbox.next("Conveyor", || {
        conveyor.send(&sent).unwrap();
    });
    assert_eq!(got, Value::map([("speed", 0.75.into()), ("running", true.into()), ("part", "A7".into())]));

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
    let status = HmiStatus { version: "1.2.3".into(), project: "demo".into(), started_at: 1_700_000_000, clients: 1, missing: vec!["Line1/Gone".try_into().unwrap()] };
    let clients = vec![Client { id: 4, address: "10.0.0.9".try_into().unwrap(), connected_at: 1_700_000_001, ping_ms: 2.5, jitter_ms: 0.4, data_channels: true }];
    mesh.publish_status(status.clone());
    mesh.publish_clients(clients.clone());

    // the HMI's own import reads what it published, and the next change
    let own = import("Status", status::STATUS, Kind::Variable, Intent::Read);
    let start = Instant::now();
    while !mesh.attach(&own) {
        within("its own status to attach", start);
    }
    assert_eq!(inbox.next("Status", || {}), status::status_value(&status));
    let later = HmiStatus { clients: 0, ..status.clone() };
    mesh.publish_status(later.clone());
    assert_eq!(inbox.next("Status", || {}), status::status_value(&later));
    assert!(mesh.set("Status", "", Value::Null, None).unwrap_err().contains("only it sets"));

    // another node reads both as the mesh carries them
    let other = Node::new("status_reader", local()).unwrap();
    let read = other.remote_variable::<HmiStatus>(status::STATUS, VariableOptions::new()).unwrap();
    let list = other.remote_variable::<Vec<Client>>(status::CLIENTS, VariableOptions::new()).unwrap();
    let start = Instant::now();
    while !(read.get().unwrap() == Some(later.clone()) && list.get().unwrap() == Some(clients.clone())) {
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
    assert!(mesh.call("Home", &Value::map::<&str>([])).is_ok());
    assert_eq!(mesh.call("Home", &Value::Float(1.0)).err().unwrap(), "Home takes nothing");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let start = Instant::now();
    loop {
        // the provider may not be known for a moment, so a first call can find none
        if runtime.block_on(mesh.call("Home", &Value::Null).unwrap()).is_ok() {
            break;
        }
        within("a call to reach the provider", start);
    }
    assert!(homed.load(Ordering::SeqCst) >= 1);
}

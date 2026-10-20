//! The slice end to end in one process, on this host only: a line node offers a topic and a
//! variable, the HMI's mesh imports both, sees their values and sets the variable.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use rant::{Node, NodeOptions, Qos, VariableOptions};
use rant_hmi::mesh::{Delivery, Mesh, MeshOptions};
use rant_hmi::project::{Import, Intent, Kind};
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
}

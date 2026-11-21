//! What the mesh's nodes say of themselves: their log lines and the conditions on their status,
//! the HMI's own among them, as code reads them through `rant.logs()` and `rant.statuses()`.

use std::collections::{BTreeMap, VecDeque};

use rant::{DiagnosticLevel, Origin};
use rant::types::Timestamp;

use crate::value::Value;

/// How many log lines are kept, the oldest going first.
pub const LINES: usize = 1000;

/// One line of a node's log.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub node: String,
    pub level: DiagnosticLevel,
    pub origin: Origin,
    /// When it was written, in UTC microseconds.
    pub at_us: u64,
    pub text: String,
}

/// One condition on a node's status.
#[derive(Clone, Debug, PartialEq)]
pub struct Condition {
    pub key: String,
    pub level: DiagnosticLevel,
    pub origin: Origin,
    pub clearable: bool,
    /// When it was raised, in UTC microseconds, kept through its updates.
    pub since_us: u64,
    pub text: String,
}

/// Where a condition code names is.
#[derive(Debug, PartialEq)]
pub enum Holder {
    /// On the HMI's own status.
    Own(Condition),
    /// On another node's, by its peer id.
    Peer(u32, Condition),
}

pub struct Heard {
    /// The HMI's node name, which its own lines and conditions show.
    name: String,
    lines: VecDeque<Line>,
    /// Each other node's name and conditions, by its peer id.
    peers: BTreeMap<u32, (String, Vec<Condition>)>,
    /// The HMI's own conditions, by key.
    own: BTreeMap<String, Condition>,
    lines_moved: bool,
    statuses_moved: bool,
}

impl Heard {
    pub fn new(name: &str) -> Heard {
        Heard { name: name.to_owned(), lines: VecDeque::new(), peers: BTreeMap::new(), own: BTreeMap::new(), lines_moved: false, statuses_moved: false }
    }

    pub fn line(&mut self, line: Line) {
        if self.lines.len() == LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
        self.lines_moved = true;
    }

    /// A line of the HMI's own, which its node never hears back.
    pub fn own_line(&mut self, level: DiagnosticLevel, text: &str) {
        let line = Line { node: self.name.clone(), level, origin: Origin::App, at_us: now_us(), text: text.to_owned() };
        self.line(line);
    }

    /// A node's whole set, which an empty one ends, as when the node goes.
    pub fn status(&mut self, id: u32, node: &str, conditions: Vec<Condition>) {
        match conditions.is_empty() {
            true => drop(self.peers.remove(&id)),
            false => drop(self.peers.insert(id, (node.to_owned(), conditions))),
        }
        self.statuses_moved = true;
    }

    /// Raises one of the HMI's own conditions, or updates it, keeping when it was raised.
    pub fn raise(&mut self, key: &str, level: DiagnosticLevel, text: &str, clearable: bool) {
        let since_us = self.own.get(key).map_or_else(now_us, |c| c.since_us);
        let c = Condition { key: key.to_owned(), level, origin: Origin::App, clearable, since_us, text: text.to_owned() };
        if self.own.get(key) != Some(&c) {
            self.own.insert(key.to_owned(), c);
            self.statuses_moved = true;
        }
    }

    pub fn lower(&mut self, key: &str) {
        if self.own.remove(key).is_some() {
            self.statuses_moved = true;
        }
    }

    /// The condition `key` raised at `since_us` on the node called `node`, the HMI's own first.
    pub fn find(&self, node: &str, key: &str, since_us: u64) -> Option<Holder> {
        let fits = |c: &&Condition| c.key == key && c.since_us == since_us;
        if node == self.name
            && let Some(c) = self.own.get(key).filter(|c| fits(c))
        {
            return Some(Holder::Own(c.clone()));
        }
        self.peers.iter().filter(|(_, (name, _))| name == node).find_map(|(id, (_, list))| list.iter().find(fits).map(|c| Holder::Peer(*id, c.clone())))
    }

    /// Whether the node `id` still holds the condition `key` raised at `since_us`.
    pub fn holds(&self, id: u32, key: &str, since_us: u64) -> bool {
        self.peers.get(&id).is_some_and(|(_, list)| list.iter().any(|c| c.key == key && c.since_us == since_us))
    }

    /// Whether the lines changed since this was last asked.
    pub fn take_lines_moved(&mut self) -> bool {
        std::mem::take(&mut self.lines_moved)
    }

    pub fn take_statuses_moved(&mut self) -> bool {
        std::mem::take(&mut self.statuses_moved)
    }

    /// The lines as code reads them, oldest first.
    pub fn logs(&self) -> Value {
        let line = |l: &Line| Value::map([("node", l.node.as_str().into()), ("level", word(l.level).into()), ("origin", origin(l.origin).into()), ("at", ms(l.at_us)), ("text", l.text.as_str().into())]);
        Value::List(self.lines.iter().map(line).collect())
    }

    /// Every condition as code reads them, most serious first, then newest first.
    pub fn statuses(&self) -> Value {
        let mut all: Vec<(&str, &Condition)> = self.own.values().map(|c| (self.name.as_str(), c)).collect();
        all.extend(self.peers.values().flat_map(|(name, list)| list.iter().map(move |c| (name.as_str(), c))));
        all.sort_by(|a, b| b.1.level.cmp(&a.1.level).then(b.1.since_us.cmp(&a.1.since_us)));
        let condition = |(node, c): (&str, &Condition)| {
            Value::map([
                ("node", node.into()),
                ("key", c.key.as_str().into()),
                ("level", word(c.level).into()),
                ("origin", origin(c.origin).into()),
                ("clearable", c.clearable.into()),
                ("since", ms(c.since_us)),
                ("text", c.text.as_str().into()),
            ])
        };
        Value::List(all.into_iter().map(condition).collect())
    }
}

/// A level as code names it.
pub fn word(level: DiagnosticLevel) -> &'static str {
    match level {
        DiagnosticLevel::Debug => "debug",
        DiagnosticLevel::Info => "info",
        DiagnosticLevel::Warn => "warn",
        DiagnosticLevel::Error => "error",
    }
}

/// The level code names, None for a word that is none.
pub fn level(word: &str) -> Option<DiagnosticLevel> {
    [DiagnosticLevel::Debug, DiagnosticLevel::Info, DiagnosticLevel::Warn, DiagnosticLevel::Error].into_iter().find(|l| self::word(*l) == word)
}

fn origin(o: Origin) -> &'static str {
    match o {
        Origin::App => "app",
        Origin::Rant => "rant",
    }
}

/// Now, in UTC microseconds, as Rant stamps lines and conditions.
fn now_us() -> u64 {
    u64::try_from(Timestamp::now().us).unwrap_or_default()
}

/// Microseconds as the ms code reads times in, as `time.now` gives them.
fn ms(us: u64) -> Value {
    Value::Float(us as f64 / 1000.0)
}

/// The microseconds of a time code gave in ms, as `ms` wrote it.
pub fn us(ms: f64) -> u64 {
    (ms * 1000.0).round() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::value;

    fn condition(key: &str, level: DiagnosticLevel, since_us: u64) -> Condition {
        Condition { key: key.into(), level, origin: Origin::App, clearable: true, since_us, text: format!("{key} text") }
    }

    #[test]
    fn the_log_keeps_its_newest_lines() {
        let mut h = Heard::new("hmi");
        for i in 0..LINES + 5 {
            h.line(Line { node: "plc".into(), level: DiagnosticLevel::Info, origin: Origin::App, at_us: i as u64 * 1000, text: format!("line {i}") });
        }
        assert!(h.take_lines_moved() && !h.take_lines_moved());
        let Value::List(lines) = h.logs() else { panic!("not a list") };
        assert_eq!(lines.len(), LINES);
        assert_eq!(lines[0], value!({ "node": "plc", "level": "info", "origin": "app", "at": 5.0, "text": "line 5" }));
        h.own_line(DiagnosticLevel::Warn, "from a handler");
        let Value::List(lines) = h.logs() else { panic!("not a list") };
        assert_eq!(lines.last().and_then(|l| l.get("node")), Some(&Value::from("hmi")));
    }

    #[test]
    fn conditions_come_most_serious_first_then_newest() {
        let mut h = Heard::new("hmi");
        h.status(7, "plc", vec![condition("drive2", DiagnosticLevel::Error, 1000), condition("door", DiagnosticLevel::Warn, 3000)]);
        h.status(9, "arm", vec![condition("estop", DiagnosticLevel::Error, 2000)]);
        h.raise("tank", DiagnosticLevel::Warn, "tank over 90%", false);
        let keys = |h: &Heard| match h.statuses() {
            Value::List(list) => list.iter().map(|c| c.get("key").and_then(Value::as_str).unwrap_or_default().to_owned()).collect::<Vec<_>>(),
            _ => panic!("not a list"),
        };
        assert_eq!(keys(&h), ["estop", "drive2", "tank", "door"]);
        // an update keeps when it was raised, and a node gone takes its conditions with it
        let since = h.own["tank"].since_us;
        h.raise("tank", DiagnosticLevel::Error, "tank over 95%", false);
        assert_eq!(h.own["tank"].since_us, since);
        h.status(9, "arm", Vec::new());
        assert_eq!(keys(&h), ["tank", "drive2", "door"]);
        assert!(h.take_statuses_moved());
    }

    #[test]
    fn a_condition_is_found_by_its_node_key_and_raise() {
        let mut h = Heard::new("hmi");
        h.status(7, "plc", vec![condition("drive2", DiagnosticLevel::Error, 1000)]);
        h.raise("tank", DiagnosticLevel::Warn, "tank over 90%", true);
        let since = h.own["tank"].since_us;
        assert_eq!(h.find("plc", "drive2", 1000), Some(Holder::Peer(7, condition("drive2", DiagnosticLevel::Error, 1000))));
        assert!(matches!(h.find("hmi", "tank", since), Some(Holder::Own(c)) if c.key == "tank"));
        // a later raise of the key, or another node's, is not the one named
        assert_eq!(h.find("plc", "drive2", 999), None);
        assert_eq!(h.find("arm", "drive2", 1000), None);
        assert!(h.holds(7, "drive2", 1000) && !h.holds(7, "drive2", 999));
        // a time code reads in ms names the same raise
        assert_eq!(us(1_763_460_000_123.456), 1_763_460_000_123_456);
    }
}

//! The events a screen sends for an element and the settings a handler for each takes, kept
//! here once. A test writes them to the client's protocol folder as events.ts.

use serde::Serialize;
use ts_rs::TS;

/// What sends an event: the pointer, on any element but an input, an input's entry, or the
/// keyboard, on any element.
#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Sender {
    Pointer,
    Entry,
    Keyboard,
}

/// How a setting is written: an expression the screen reads, or a filter, the value its event
/// must bring in the field of its name for the handler to take it, written as it is.
#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum SettingKind {
    Expression,
    Filter,
}

/// A setting a handler takes as an attribute of its `<on>`.
#[derive(Serialize, TS, Debug)]
#[ts(export)]
pub struct SettingInfo {
    pub name: &'static str,
    /// What the editor calls it.
    pub label: &'static str,
    /// What it is when left empty.
    pub default: &'static str,
    pub kind: SettingKind,
}

/// An event an element may handle.
#[derive(Serialize, TS, Debug)]
#[ts(export)]
pub struct EventInfo {
    pub name: &'static str,
    pub from: Sender,
    /// What happens, in a few words.
    pub words: &'static str,
    /// A second one while the first still runs is dropped. Any other is a stream, as a drag,
    /// whose latest must land, so it waits for the run.
    pub once: bool,
    pub settings: &'static [SettingInfo],
    /// What its `p` holds: each field's name and words.
    pub brings: &'static [(&'static str, &'static str)],
    /// The event that ends what this one begins, as a release ends a press. It takes the same
    /// filters, and runs however the screen goes.
    pub ends_with: Option<&'static str>,
}

/// What a pointer's event brings: where it is on the element.
const AT: &[(&str, &str)] = &[
    ("x", "across it, 0 to 1"),
    ("y", "down it, 0 to 1"),
    ("angle", "degrees around its centre, 0 up"),
    ("on", "the part pressed, by name"),
    ("inside", "true while over it"),
];

/// What a key's event brings.
const KEYS: &[(&str, &str)] = &[
    ("key", "what it types, as \"a\" or \"Enter\""),
    ("code", "where it sits, as \"KeyA\""),
    ("shift", "true while Shift is down"),
    ("ctrl", "true while Ctrl is down"),
    ("alt", "true while Alt is down"),
];

const fn expression(name: &'static str, label: &'static str, default: &'static str) -> SettingInfo {
    SettingInfo { name, label, default, kind: SettingKind::Expression }
}

const AFTER: SettingInfo = expression("after", "After ms", "500");
const EVERY: SettingInfo = expression("every", "Every ms", "100");
/// The screen sends its handler's event only while this is true.
const WHILE: SettingInfo = expression("while", "While", "true");
/// A key by what it types: "a", "A" with Shift, " " for Space.
const KEY: SettingInfo = SettingInfo { name: "key", label: "Key", default: "any", kind: SettingKind::Filter };
/// A key by where it sits, "KeyA" whatever the layout makes it type.
const CODE: SettingInfo = SettingInfo { name: "code", label: "Key code", default: "any", kind: SettingKind::Filter };

/// What a handler for an event a component sends takes.
pub const SENT: &[SettingInfo] = &[WHILE];

const fn pointer(name: &'static str, words: &'static str, once: bool, settings: &'static [SettingInfo]) -> EventInfo {
    EventInfo { name, from: Sender::Pointer, words, once, settings, brings: AT, ends_with: None }
}

const fn keyboard(name: &'static str, words: &'static str, settings: &'static [SettingInfo]) -> EventInfo {
    EventInfo { name, from: Sender::Keyboard, words, once: true, settings, brings: KEYS, ends_with: None }
}

/// Every event, in the order an element lists its handlers. A component's own come after.
pub const EVENTS: &[EventInfo] = &[
    pointer("tap", "pressed and let go on it", true, &[WHILE]),
    EventInfo { ends_with: Some("release"), ..pointer("press", "pressed down", true, &[WHILE]) },
    // an end is heard whenever what it ends was, so it takes no while
    pointer("release", "let go, anywhere", true, &[]),
    pointer("hold", "held down a while", true, &[AFTER, WHILE]),
    pointer("repeat", "again and again while pressed", true, &[EVERY, WHILE]),
    pointer("drag", "moved while pressed", false, &[WHILE]),
    pointer("outside", "a press anywhere else", true, &[WHILE]),
    EventInfo { name: "change", from: Sender::Entry, words: "a value entered", once: false, settings: &[WHILE], brings: &[("value", "what was entered")], ends_with: None },
    EventInfo { ends_with: Some("keyup"), ..keyboard("keydown", "a key pressed", &[KEY, CODE, WHILE]) },
    keyboard("keyup", "a key let go", &[KEY, CODE]),
    keyboard("keyrepeat", "again and again while a key is down", &[KEY, CODE, EVERY, WHILE]),
];

/// The event `name`, unless a component sends it.
pub fn find(name: &str) -> Option<&'static EventInfo> {
    EVENTS.iter().find(|e| e.name == name)
}

/// The settings a handler for `event` takes.
pub fn settings(event: &str) -> &'static [SettingInfo] {
    find(event).map_or(SENT, |e| e.settings)
}

/// Whether `key` is a filter of `event`'s handlers.
pub fn filters(event: &str, key: &str) -> bool {
    settings(event).iter().any(|s| s.name == key && s.kind == SettingKind::Filter)
}

/// The event `event` ends, when it ends one, as a release ends a press.
pub fn ended_by(event: &str) -> Option<&'static EventInfo> {
    EVENTS.iter().find(|e| e.ends_with == Some(event))
}

/// Where a handler goes in an element's list: these events first, in order, then by name.
pub fn rank(event: &str) -> (usize, &str) {
    (EVENTS.iter().position(|e| e.name == event).unwrap_or(EVENTS.len()), event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_client_reads_the_same_events() {
        let mut ts = String::from("// Written by the backend's tests from server/src/events.rs, where they change.\n\n");
        ts += "import type { EventInfo } from \"./EventInfo\";\nimport type { SettingInfo } from \"./SettingInfo\";\n\n";
        ts += &format!("export const EVENTS: readonly EventInfo[] = {};\n\n", serde_json::to_string_pretty(EVENTS).unwrap());
        ts += &format!("export const SENT: readonly SettingInfo[] = {};\n", serde_json::to_string_pretty(SENT).unwrap());
        let path = std::path::Path::new(&std::env::var("TS_RS_EXPORT_DIR").unwrap()).join("events.ts");
        if std::fs::read_to_string(&path).ok() != Some(ts.clone()) {
            std::fs::write(&path, ts).unwrap();
        }
    }

    #[test]
    fn a_component_s_events_follow_these_in_order_and_take_a_while() {
        assert!(rank("tap") < rank("change") && rank("change") < rank("a") && rank("a") < rank("b"));
        assert!(settings("pressed")[0].name == "while" && settings("hold")[0].name == "after" && settings("release").is_empty());
    }

    #[test]
    fn an_end_takes_the_filters_of_what_it_ends_and_no_while() {
        let names = |event: &str, kind: SettingKind| settings(event).iter().filter(|s| s.kind == kind).map(|s| s.name).collect::<Vec<_>>();
        for e in EVENTS.iter().filter(|e| e.ends_with.is_some()) {
            let end = e.ends_with.unwrap();
            assert_eq!(names(e.name, SettingKind::Filter), names(end, SettingKind::Filter));
            assert!(names(end, SettingKind::Expression).is_empty() && ended_by(end).unwrap().name == e.name);
        }
        assert!(filters("keydown", "key") && !filters("keydown", "while") && ended_by("keydown").is_none());
    }
}

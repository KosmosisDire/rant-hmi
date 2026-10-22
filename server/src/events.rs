//! The events a screen sends for an element and the settings a handler for each takes, kept
//! here once. A test writes them to the client's protocol folder as events.ts.

use serde::Serialize;
use ts_rs::TS;

/// What sends an event: the pointer, on any element but an input, or an input's entry.
#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Sender {
    Pointer,
    Entry,
}

/// A setting a handler takes as an attribute of its `<on>`: an expression in ms.
#[derive(Serialize, TS, Debug)]
#[ts(export)]
pub struct SettingInfo {
    pub name: &'static str,
    /// What the editor calls it.
    pub label: &'static str,
    /// What it is when left empty.
    pub default: &'static str,
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
}

/// What a pointer's event brings: where it is on the element.
const AT: &[(&str, &str)] = &[
    ("x", "across it, 0 to 1"),
    ("y", "down it, 0 to 1"),
    ("angle", "degrees around its centre, 0 up"),
    ("on", "the part pressed, by name"),
    ("inside", "true while over it"),
];

const fn pointer(name: &'static str, words: &'static str, once: bool, settings: &'static [SettingInfo]) -> EventInfo {
    EventInfo { name, from: Sender::Pointer, words, once, settings, brings: AT }
}

/// Every event, in the order an element lists its handlers. A component's own come after.
pub const EVENTS: &[EventInfo] = &[
    pointer("tap", "pressed and let go on it", true, &[]),
    pointer("press", "pressed down", true, &[]),
    pointer("release", "let go, anywhere", true, &[]),
    pointer("hold", "held down a while", true, &[SettingInfo { name: "after", label: "After ms", default: "500" }]),
    pointer("repeat", "again and again while pressed", true, &[SettingInfo { name: "every", label: "Every ms", default: "100" }]),
    pointer("drag", "moved while pressed", false, &[]),
    pointer("outside", "a press anywhere else", true, &[]),
    EventInfo { name: "change", from: Sender::Entry, words: "a value entered", once: false, settings: &[], brings: &[("value", "what was entered")] },
];

/// The event `name`, unless a component sends it.
pub fn find(name: &str) -> Option<&'static EventInfo> {
    EVENTS.iter().find(|e| e.name == name)
}

/// The settings a handler for `event` takes.
pub fn settings(event: &str) -> &'static [SettingInfo] {
    find(event).map_or(&[], |e| e.settings)
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
        ts += "import type { EventInfo } from \"./EventInfo\";\n\n";
        ts += &format!("export const EVENTS: readonly EventInfo[] = {};\n", serde_json::to_string_pretty(EVENTS).unwrap());
        let path = std::path::Path::new(&std::env::var("TS_RS_EXPORT_DIR").unwrap()).join("events.ts");
        if std::fs::read_to_string(&path).ok() != Some(ts.clone()) {
            std::fs::write(&path, ts).unwrap();
        }
    }

    #[test]
    fn a_component_s_events_follow_these_in_order_and_take_no_settings() {
        assert!(rank("tap") < rank("change") && rank("change") < rank("a") && rank("a") < rank("b"));
        assert!(settings("pressed").is_empty() && settings("hold")[0].name == "after");
    }
}

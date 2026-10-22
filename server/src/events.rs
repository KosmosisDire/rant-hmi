//! The events a screen sends for an element and the settings a handler for each takes, kept
//! here once. A test writes them to the client's protocol folder as events.ts.

use serde::Serialize;
use ts_rs::TS;

use crate::value::Value;

/// What sends an event: the pointer, on any element but an input, an input's entry, or a
/// wheel, a trackpad or two fingers, the keyboard or a gamepad, on any element.
#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Sender {
    Pointer,
    Entry,
    Wheel,
    Keyboard,
    Gamepad,
}

impl Sender {
    /// What the editor and the docs call it, over its events.
    pub const fn label(self) -> &'static str {
        match self {
            Sender::Pointer => "Pointer",
            Sender::Entry => "Entry",
            Sender::Wheel => "Wheel and pinch",
            Sender::Keyboard => "Keyboard",
            Sender::Gamepad => "Gamepad",
        }
    }
}

/// How a number a stream brings gathers while one waits to be heard: summed, as a move, or
/// multiplied, as a zoom.
#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Gather {
    Sum,
    Product,
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
    /// The values a filter may take, each with a few words, or none for any.
    #[ts(type = "readonly [string, string][]")]
    pub options: &'static [(&'static str, &'static str)],
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
    /// The numbers a stream gathers while one waits, so none of a move is lost. The rest it
    /// brings are the latest.
    pub gathers: &'static [(&'static str, Gather)],
    /// The event that ends what this one begins, as a release ends a press. It takes the same
    /// filters, and runs however the screen goes. A stream that ends itself, as axes, ends at
    /// rest: every number it brings outside its filters 0.
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

/// What a drag brings: where it is, and how far it moved since the last.
const MOVED: &[(&str, &str)] = &[
    ("x", "across it, 0 to 1"),
    ("y", "down it, 0 to 1"),
    ("angle", "degrees around its centre, 0 up"),
    ("on", "the part pressed, by name"),
    ("inside", "true while over it"),
    ("dx", "how far it moved across since the last, as its own x counts"),
    ("dy", "how far it moved down since the last, as its own y counts"),
];

/// What a scroll brings: where it is, and how far it moves what the element shows, as a finger
/// dragging it would.
const SCROLLED: &[(&str, &str)] = &[
    ("x", "across it, 0 to 1"),
    ("y", "down it, 0 to 1"),
    ("on", "the part under it, by name"),
    ("dx", "how far across, as its own x counts"),
    ("dy", "how far down, as its own y counts, below 0 as a wheel turns down"),
];

/// What a zoom brings: where it is, and how much it grows what the element shows.
const ZOOMED: &[(&str, &str)] = &[
    ("x", "across it, 0 to 1"),
    ("y", "down it, 0 to 1"),
    ("on", "the part under it, by name"),
    ("factor", "how much bigger, below 1 smaller"),
];

const MOVES: &[(&str, Gather)] = &[("dx", Gather::Sum), ("dy", Gather::Sum)];

/// What a key's event brings.
const KEYS: &[(&str, &str)] = &[
    ("key", "what it types, as \"a\" or \"Enter\""),
    ("code", "where it sits, as \"KeyA\""),
    ("shift", "true while Shift is down"),
    ("ctrl", "true while Ctrl is down"),
    ("alt", "true while Alt is down"),
];

/// What a gamepad's button brings.
const BUTTONS: &[(&str, &str)] = &[("button", "which, by where it sits, as \"south\""), ("pad", "which pad, 0 for the first")];

/// What a gamepad's axes bring, each stick's y up as a Joystick's.
const AXES: &[(&str, &str)] = &[
    ("lx", "the left stick across, -1 to 1"),
    ("ly", "the left stick up, -1 to 1"),
    ("rx", "the right stick across, -1 to 1"),
    ("ry", "the right stick up, -1 to 1"),
    ("lt", "the left trigger, 0 to 1"),
    ("rt", "the right trigger, 0 to 1"),
    ("axes", "every axis as the pad gives it, down positive"),
    ("pad", "which pad, 0 for the first"),
];

const fn expression(name: &'static str, label: &'static str, default: &'static str) -> SettingInfo {
    SettingInfo { name, label, default, kind: SettingKind::Expression, options: &[] }
}

const fn filter(name: &'static str, label: &'static str, options: &'static [(&'static str, &'static str)]) -> SettingInfo {
    SettingInfo { name, label, default: "any", kind: SettingKind::Filter, options }
}

const AFTER: SettingInfo = expression("after", "After ms", "500");
const EVERY: SettingInfo = expression("every", "Every ms", "100");
/// The screen sends its handler's event only while this is true.
const WHILE: SettingInfo = expression("while", "While", "true");
/// A key by what it types: "a", "A" with Shift, " " for Space.
const KEY: SettingInfo = filter("key", "Key", &[]);
/// A key by where it sits, "KeyA" whatever the layout makes it type.
const CODE: SettingInfo = filter("code", "Key code", &[]);
/// A button by where it sits on the standard pad, whatever its maker prints on it.
const BUTTON: SettingInfo = filter(
    "button",
    "Button",
    &[
        ("south", "A, Cross"),
        ("east", "B, Circle"),
        ("west", "X, Square"),
        ("north", "Y, Triangle"),
        ("lb", "left bumper, L1"),
        ("rb", "right bumper, R1"),
        ("lt", "left trigger, L2"),
        ("rt", "right trigger, R2"),
        ("back", "Back, Share"),
        ("start", "Start, Options"),
        ("ls", "left stick pressed"),
        ("rs", "right stick pressed"),
        ("up", "pad up"),
        ("down", "pad down"),
        ("left", "pad left"),
        ("right", "pad right"),
        ("home", "Guide, PS"),
    ],
);
/// A pad by its place among those the screen has.
const PAD: SettingInfo = filter("pad", "Pad", &[("0", "the first"), ("1", "the second"), ("2", "the third"), ("3", "the fourth")]);
/// How far a stick or trigger moves before it counts, 0 to 1, past which it counts from 0.
const DEADBAND: SettingInfo = expression("deadband", "Deadband", "0.1");

/// What a handler for an event a component sends takes.
pub const SENT: &[SettingInfo] = &[WHILE];

const fn pointer(name: &'static str, words: &'static str, once: bool, settings: &'static [SettingInfo]) -> EventInfo {
    EventInfo { name, from: Sender::Pointer, words, once, settings, brings: AT, gathers: &[], ends_with: None }
}

/// A stream from a wheel, a trackpad or two fingers.
const fn wheel(name: &'static str, words: &'static str, brings: &'static [(&'static str, &'static str)], gathers: &'static [(&'static str, Gather)]) -> EventInfo {
    EventInfo { name, from: Sender::Wheel, words, once: false, settings: &[WHILE], brings, gathers, ends_with: None }
}

const fn keyboard(name: &'static str, words: &'static str, settings: &'static [SettingInfo]) -> EventInfo {
    EventInfo { name, from: Sender::Keyboard, words, once: true, settings, brings: KEYS, gathers: &[], ends_with: None }
}

const fn gamepad(name: &'static str, words: &'static str, settings: &'static [SettingInfo]) -> EventInfo {
    EventInfo { name, from: Sender::Gamepad, words, once: true, settings, brings: BUTTONS, gathers: &[], ends_with: None }
}

/// Every event, in the order an element lists its handlers. A component's own come after.
pub const EVENTS: &[EventInfo] = &[
    pointer("tap", "pressed and let go on it", true, &[WHILE]),
    EventInfo { ends_with: Some("release"), ..pointer("press", "pressed down", true, &[WHILE]) },
    // an end is heard whenever what it ends was, so it takes no while
    pointer("release", "let go, anywhere", true, &[]),
    pointer("hold", "held down a while", true, &[AFTER, WHILE]),
    pointer("repeat", "again and again while pressed", true, &[EVERY, WHILE]),
    EventInfo { brings: MOVED, gathers: MOVES, ..pointer("drag", "moved while pressed", false, &[WHILE]) },
    pointer("outside", "a press anywhere else", true, &[WHILE]),
    wheel("scroll", "scrolled over it", SCROLLED, MOVES),
    wheel("zoom", "pinched or zoomed over it", ZOOMED, &[("factor", Gather::Product)]),
    EventInfo { name: "change", from: Sender::Entry, words: "a value entered", once: false, settings: &[WHILE], brings: &[("value", "what was entered")], gathers: &[], ends_with: None },
    EventInfo { ends_with: Some("keyup"), ..keyboard("keydown", "a key pressed", &[KEY, CODE, WHILE]) },
    keyboard("keyup", "a key let go", &[KEY, CODE]),
    keyboard("keyrepeat", "again and again while a key is down", &[KEY, CODE, EVERY, WHILE]),
    EventInfo { ends_with: Some("buttonup"), ..gamepad("buttondown", "a gamepad button pressed", &[BUTTON, PAD, WHILE]) },
    gamepad("buttonup", "a gamepad button let go", &[BUTTON, PAD]),
    // once a frame while it moves, each handler past its own deadband, then once at rest
    EventInfo { once: false, brings: AXES, ends_with: Some("axes"), ..gamepad("axes", "a gamepad's sticks or triggers moved", &[PAD, DEADBAND, WHILE]) },
];

/// The event `name`, unless a component sends it.
pub fn find(name: &str) -> Option<&'static EventInfo> {
    EVENTS.iter().find(|e| e.name == name)
}

/// The settings a handler for `event` takes.
pub fn settings(event: &str) -> &'static [SettingInfo] {
    find(event).map_or(SENT, |e| e.settings)
}

/// The setting `key` of `event`'s handlers.
pub fn setting(event: &str, key: &str) -> Option<&'static SettingInfo> {
    settings(event).iter().find(|s| s.name == key)
}

/// Whether `key` is a filter of `event`'s handlers.
pub fn filters(event: &str, key: &str) -> bool {
    setting(event, key).is_some_and(|s| s.kind == SettingKind::Filter)
}

/// A field of what an event brings as a filter reads it: text as it is, a whole number or true
/// and false as written.
pub fn filter_text(v: &Value) -> Option<String> {
    match v {
        Value::Text(t) => Some(t.clone()),
        Value::Int(_) | Value::Bool(_) => Some(v.to_string()),
        _ => None,
    }
}

/// `next` with `was` gathered in, as when `next` comes while `was` waits to be heard: each
/// number the event gathers summed or multiplied, the rest as `next` brings them.
pub fn gather(event: &str, was: &Value, mut next: Value) -> Value {
    let (Some(e), Some(old)) = (find(event), was.as_map()) else { return next };
    let number = |fields: &[(String, Value)], name: &str| fields.iter().find(|(k, _)| k == name).and_then(|(_, v)| v.as_f64());
    if let Value::Map(fields) = &mut next {
        for (name, how) in e.gathers {
            let (Some(a), Some(b)) = (number(old, name), number(fields, name)) else { continue };
            let gathered = match how {
                Gather::Sum => a + b,
                Gather::Product => a * b,
            };
            fields.iter_mut().filter(|(k, _)| k == name).for_each(|(_, v)| *v = Value::Float(gathered));
        }
    }
    next
}

/// The event `event` ends, when it ends one, as a release ends a press.
pub fn ended_by(event: &str) -> Option<&'static EventInfo> {
    EVENTS.iter().find(|e| e.ends_with == Some(event))
}

/// Whether `event` is a stream that ends itself, at rest.
pub fn ends_itself(event: &str) -> bool {
    find(event).is_some_and(|e| e.ends_with == Some(e.name))
}

/// What `event` brings at rest: `p` with each number outside its filters 0, in lists too.
pub fn rest(event: &str, p: &Value) -> Value {
    fn zeroed(v: &Value) -> Value {
        match v {
            Value::Int(_) => Value::Int(0),
            Value::Float(_) => Value::Float(0.0),
            Value::List(items) => Value::List(items.iter().map(zeroed).collect()),
            other => other.clone(),
        }
    }
    match p {
        Value::Map(fields) => Value::Map(fields.iter().map(|(k, v)| (k.clone(), if filters(event, k) { v.clone() } else { zeroed(v) })).collect()),
        other => zeroed(other),
    }
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
        ts += "import type { EventInfo } from \"./EventInfo\";\nimport type { Sender } from \"./Sender\";\nimport type { SettingInfo } from \"./SettingInfo\";\n\n";
        ts += &format!("export const EVENTS: readonly EventInfo[] = {};\n\n", serde_json::to_string_pretty(EVENTS).unwrap());
        ts += &format!("export const SENT: readonly SettingInfo[] = {};\n\n", serde_json::to_string_pretty(SENT).unwrap());
        let senders: serde_json::Map<String, serde_json::Value> = EVENTS.iter().map(|e| (serde_json::to_value(e.from).unwrap().as_str().unwrap().to_owned(), e.from.label().into())).collect();
        ts += &format!("export const SENDERS: Readonly<Record<Sender, string>> = {};\n", serde_json::to_string_pretty(&senders).unwrap());
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
        for e in EVENTS.iter().filter(|e| e.ends_with.is_some() && !ends_itself(e.name)) {
            let end = e.ends_with.unwrap();
            assert_eq!(names(e.name, SettingKind::Filter), names(end, SettingKind::Filter));
            assert!(names(end, SettingKind::Expression).is_empty() && ended_by(end).unwrap().name == e.name);
        }
        assert!(filters("keydown", "key") && !filters("keydown", "while") && ended_by("keydown").is_none());
    }

    #[test]
    fn a_stream_that_ends_itself_rests_with_its_numbers_0_but_its_filters() {
        let p = Value::from(serde_json::json!({ "lx": 0.5, "ly": 0, "axes": [0.5, -0.25], "pad": 1 }));
        assert!(ends_itself("axes") && !ends_itself("buttondown") && ended_by("axes").unwrap().name == "axes");
        let at_rest = rest("axes", &p);
        assert_eq!(at_rest, Value::from(serde_json::json!({ "lx": 0.0, "ly": 0, "axes": [0.0, 0.0], "pad": 1 })));
        assert_eq!(rest("axes", &at_rest), at_rest);
    }

    #[test]
    fn a_stream_waiting_gathers_its_moves_and_takes_the_latest_of_the_rest() {
        let p = |v: serde_json::Value| Value::from(v);
        let was = p(serde_json::json!({ "x": 0.25, "dx": 1.5, "dy": -1 }));
        assert_eq!(gather("drag", &was, p(serde_json::json!({ "x": 0.5, "dx": 2, "dy": 0.5 }))), p(serde_json::json!({ "x": 0.5, "dx": 3.5, "dy": -0.5 })));
        assert_eq!(gather("zoom", &p(serde_json::json!({ "factor": 2 })), p(serde_json::json!({ "factor": 0.25 }))), p(serde_json::json!({ "factor": 0.5 })));
        assert_eq!(gather("axes", &p(serde_json::json!({ "lx": 1 })), p(serde_json::json!({ "lx": 0.5 }))), p(serde_json::json!({ "lx": 0.5 })));
    }

    #[test]
    fn a_filter_reads_text_and_whole_numbers() {
        assert_eq!(filter_text(&Value::from(1)), Some("1".into()));
        assert_eq!(filter_text(&Value::from("south")), Some("south".into()));
        assert_eq!(filter_text(&Value::from(0.5)), None);
        assert!(setting("buttondown", "button").unwrap().options.iter().any(|(o, _)| *o == "south"));
    }
}

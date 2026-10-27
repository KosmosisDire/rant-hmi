//! Every message between the backend and a screen, sent as CBOR. Running `cargo test`
//! writes their TypeScript twins into client/src/protocol, so the two sides never drift.

use std::collections::BTreeMap;

use axum::body::Bytes;
use serde::ser::{SerializeStruct, Serializer};
use serde::{Deserialize, Serialize};
use crate::value::{Against, Value};
use ts_rs::TS;

use crate::pages::logic::Rule;
use crate::pages::{Edit, Page};
use crate::project::{Computed, Import, Kind, ProjectInfo, Record, Token, Variable};

/// From the backend to a screen.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum ServerMsg {
    /// The first message on a connection. `build` names the client script this backend
    /// serves, so a screen running another knows to load it. `key` opens the session's second
    /// socket, at `/bulk?key=`, which brings its big values, or on https its WebTransport at
    /// the same address, whose certificate has the SHA-256 `wt` in hex while it serves.
    Hello { session: u32, project: ProjectInfo, version: String, node: String, build: String, key: String, wt: Option<String> },
    /// The project's settings, whole, after a change.
    Project { project: ProjectInfo },
    /// Every import, whole, after any change.
    Imports { imports: Vec<Import> },
    /// Every variable, whole, after any change. Their values come as values.
    Variables { variables: Vec<Variable> },
    /// Every record, whole, after any change. Their samples come as samples.
    Records { records: Vec<Record> },
    /// A record's new samples, oldest first, or its whole history when `whole`.
    Samples { name: String, samples: Vec<Sample>, whole: bool },
    /// The HMI's own handlers, whole, after any change.
    Rules { rules: Vec<Rule> },
    /// The theme's tokens, whole, after any change.
    Theme { tokens: Vec<Token> },
    /// Every entity on the mesh, whole, after the mesh changed.
    Mesh { entities: Vec<EntityInfo> },
    /// The values that changed since the last batch. `seq` counts the batches, as one may pass
    /// another on the way, so a value never gives way to an older one.
    Values {
        values: Vec<ValueUpdate>,
        #[ts(type = "number")]
        seq: u64,
    },
    /// The peers and how fast they answer, about once a second.
    Health { peers: Vec<PeerInfo> },
    /// Every page, whole, on connecting and when one is added or removed.
    Pages { pages: Vec<Page> },
    /// One page, whole, after an edit changed it.
    Page { page: Page },
    /// What an edit from this screen made, so the screen can open or select it. For a new
    /// page `id` is the page's own.
    Made { page: String, id: String },
    /// The answer to a ping, for the round trip.
    Pong { t: f64 },
    /// The last message on the socket before the screen's link channel carries what it did. The
    /// screen holds what the channel brings until this, so nothing comes out of turn.
    Switched,
    /// The answer to a screen's offer of its WebRTC connection for video, first or again. None
    /// when the backend cannot make it, so the screen decodes its video itself.
    Video { answer: Option<String> },
    /// An address of this host the screen's connection may reach it on, found after the answer,
    /// as an `a=candidate` line without its `a=`.
    Candidate { candidate: String },
    /// The computed values, whole, after a change.
    Computed { computed: Vec<Computed> },
    /// A rename moved a page's or component's id, so a screen holding the old one follows. It
    /// comes before the pages that show the new one.
    Moved { from: String, to: String },
    /// The mesh's enums code names, whole, after a change.
    Enums { enums: Vec<EnumInfo> },
    /// An action that was not done, and why, for the screen that asked.
    Refused { text: String, alias: Option<String> },
    /// Something for the person at this screen: what a handler said, or why it stopped.
    Notice { text: String, level: Level },
    /// Every screen's problems and those runs on the system met, whole, after a change, to each
    /// screen that asked for them.
    Problems { problems: Vec<Reported> },
    /// What the HMI brings of each import on the mesh and what its own code reads of it, whole,
    /// after a change, to each screen that previews values.
    Brings { imports: Vec<Brought> },
    /// A handler started from this screen opens a page, in place of the top one when `replace`.
    /// `ask` names the handler's wait for what the page closes with.
    Open {
        page: String,
        replace: bool,
        #[ts(type = "number")]
        ask: u64,
    },
    /// A handler started from this screen closes the top page with an answer, null for none.
    Close { answer: Value },
    /// A frame of an import's video for a screen that decodes it itself: one H264 access unit
    /// in Annex B, each keyframe with its parameter sets, and when to show it in microseconds.
    Frame {
        alias: String,
        keyframe: bool,
        #[ts(type = "number")]
        pts: i64,
        #[ts(type = "Uint8Array")]
        data: Bytes,
    },
}

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Level {
    Info,
    Warn,
    Fault,
}

/// What went wrong on a screen. A page's fault holds while an element shows it, the others
/// count each time they come again.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Problem {
    pub source: Source,
    pub level: Level,
    pub text: String,
    /// The stack of a fault in the HMI's own code.
    #[serde(default)]
    pub detail: Option<String>,
    /// The page or component, and its element, that shows a page's fault.
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub element: Option<String>,
    pub count: u32,
    /// When it came last, in ms since 1970.
    pub at: f64,
}

/// A problem as the backend gathers them: the screen it was found on, or None for one a run
/// on the system met.
#[derive(Serialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Reported {
    pub screen: Option<u32>,
    #[serde(flatten)]
    pub problem: Problem,
}

/// Where a problem comes from: a page's own expressions and drawing, a handler's run, or the
/// HMI's code, which is a bug in the HMI.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Source {
    Page,
    Run,
    Hmi,
}

/// From a screen to the backend.
#[derive(Deserialize, TS, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum ClientMsg {
    /// Asks for a pong, which the loop answers in turn and sends the way small values go, so
    /// the round trip is what a value waits. `rtt` is the last one the screen timed, in ms, once,
    /// and `seen` the newest batch of small values it applied, which lets those after it go.
    Ping {
        t: f64,
        #[serde(default)]
        #[ts(optional)]
        rtt: Option<f64>,
        #[serde(default)]
        #[ts(optional, type = "number")]
        seen: Option<u64>,
    },
    /// The screen's page hid, as a tab behind another, or shows again. A hidden page is sent
    /// no values, as it can show none and its browser lets it run only now and then, and one
    /// shown again gets every value anew at once, so it never replays what it missed.
    Shown { shown: bool },
    /// The last message on the socket before the screen sends on its link channel, which the
    /// backend holds what comes on until this.
    Switch,
    /// The screen lost its link channel, so the socket carries all again from now.
    Unswitch,
    /// Why the screen's WebRTC connection did not open, as one of WEBRTC_PROBLEMS, None once it
    /// did.
    WebrtcProblem {
        #[serde(default)]
        #[ts(optional)]
        problem: Option<String>,
    },
    /// The screen's problems, whole, after a change. `every` asks for every screen's, as the
    /// editor shows them.
    Problems { problems: Vec<Problem>, every: bool },
    /// An address the screen found its connection may be reached on, as its `a=candidate` line
    /// without its `a=`.
    Candidate { candidate: String },
    /// Offers the screen's WebRTC connection, first or again, with the videos it plays, each
    /// import's on the transceiver named by its mid. A video left out stops.
    Play { offer: String, videos: Vec<Played> },
    /// The paths the screen reads, as `Scan.points.[].x` split at its dots, or None for all, and
    /// only that comes. `previews` while it previews every value, as the Data tab does: each comes
    /// as the HMI brings it, `reads` adds only the fields it peeks at, and big ones come slower.
    Watch {
        reads: Option<Vec<Vec<String>>>,
        #[serde(default)]
        #[ts(optional, as = "Option<bool>")]
        previews: bool,
    },
    /// The screen took in the big value of `alias` from batch `seq`, so the next may come.
    /// `missed` when it could not, as it no longer held the value that one was the change from.
    Took {
        alias: String,
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(optional, as = "Option<bool>")]
        missed: bool,
    },
    /// The imports whose video the screen decodes itself, their frames sent on its socket, in
    /// place of those it named before. It asks while their video does not come over WebRTC.
    Frames { aliases: Vec<String> },
    /// Adds, changes or with None removes the computed value called `name`.
    SetComputed { name: String, computed: Option<Computed> },
    Import { import: Import },
    Unimport { alias: String },
    /// Renames an import or changes its intent. Every use of the old alias follows.
    ChangeImport { alias: String, import: Import },
    /// Adds, changes or with null removes the variable called `name`. A rename is followed
    /// everywhere it is used.
    SetVariable { name: String, variable: Option<Variable> },
    /// Adds, changes or with null removes the theme token called `name`. A rename is followed
    /// everywhere it is used, components too.
    SetToken { name: String, token: Option<Token> },
    /// Adds, changes or with null removes the record called `name`. A rename is followed
    /// everywhere it is used, a new source starts its history over.
    SetRecord { name: String, record: Option<Record> },
    /// Writes a mesh import or a variable, or one of its fields when `path` names one.
    Set { alias: String, path: String, value: Value },
    /// Changes the pages.
    Edit { edit: Edit },
    /// Takes back this screen's last edit, or puts back the last one it took back.
    Undo,
    Redo,
    /// Makes a page the one operators' screens open on.
    SetStart { page: String },
    /// What a page opened with `ask` closed with, null for none.
    Answer {
        #[ts(type = "number")]
        ask: u64,
        value: Value,
    },
    /// `event` happened to an element of a running page: a pointer's, or one its component
    /// sent with `payload`, which handler code reads as `p`. On a repeated element, `index` and
    /// `item` name the copy, which the code reads by those names. `heard` names the element's
    /// handlers for it the screen heard, by their filters. With none it still tells what the
    /// screen holds, as a press, for the end to run should the screen be lost.
    Fire {
        page: String,
        id: String,
        event: String,
        payload: Value,
        #[serde(default)]
        #[ts(optional)]
        index: Option<u32>,
        #[serde(default)]
        #[ts(optional)]
        item: Option<Value>,
        #[serde(default)]
        heard: Vec<BTreeMap<String, String>>,
    },
}

pub fn encode(msg: &ServerMsg) -> Bytes {
    let mut out = Vec::new();
    ciborium::into_writer(msg, &mut out).expect("every server message encodes");
    out.into()
}

/// As `encode`, but big lists of numbers as they are, never compressed, for a screen on this
/// host, which the bytes cost nothing to reach and unpacking would only cost time.
pub fn encode_plain(msg: &ServerMsg) -> Bytes {
    crate::value::plain(|| encode(msg))
}

/// One entity on the mesh.
#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct EntityInfo {
    pub name: String,
    pub kind: Kind,
    /// A variable takes sets.
    pub writable: bool,
    /// A variable's owner permits force.
    pub forceable: bool,
    /// Live publishers, owners or definitions.
    pub providers: u16,
    /// The value, message or request type.
    pub schema: Option<TypeInfo>,
    /// A function's or task's answer.
    pub response: Option<TypeInfo>,
    /// What each of a task's progress updates holds.
    pub progress: Option<TypeInfo>,
}

/// An enum the imports' types hold, which code names by its type: `Job.options`.
#[derive(Serialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct EnumInfo {
    pub name: String,
    pub options: Vec<String>,
}

/// A message type, its fields in schema order.
#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct TypeInfo {
    /// The type's name, empty for an anonymous one.
    pub name: String,
    /// One field with an empty name for a bare type such as f64.
    pub fields: Vec<FieldInfo>,
}

#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct FieldInfo {
    pub name: String,
    pub kind: FieldKind,
    /// A named type's name, such as Pose.
    pub type_name: Option<String>,
    /// An array's element kind.
    pub elem: Option<FieldKind>,
    /// A fixed array's length, 0 when the array grows.
    pub count: u16,
    /// An enum's options.
    pub options: Vec<String>,
    /// A struct's members, or those of each element of a struct array.
    pub members: Vec<FieldInfo>,
}

#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum FieldKind {
    U8,
    U16,
    U32,
    U64,
    I8,
    I16,
    I32,
    I64,
    F32,
    F64,
    Bool,
    String,
    Enum,
    Struct,
    Array,
    Map,
    Unknown,
}

/// A mesh import's or variable's latest value. `known` is false while its entity is off the
/// mesh, and the last value stays for reference. With a base, a big value goes to a screen as
/// the change from that one, which the screen holds, and says its batch as `base`.
#[derive(TS, Clone, Debug)]
#[ts(export)]
pub struct ValueUpdate {
    pub alias: String,
    pub value: Option<Value>,
    pub known: bool,
    #[ts(skip)]
    pub base: Option<Base>,
}

/// A value a screen holds, and the batch it came in.
#[derive(Clone, Debug)]
pub struct Base {
    pub seq: u64,
    pub value: Value,
}

impl Serialize for ValueUpdate {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_struct("ValueUpdate", 3 + usize::from(self.base.is_some()))?;
        m.serialize_field("alias", &self.alias)?;
        match (&self.value, &self.base) {
            (Some(v), Some(base)) => {
                m.serialize_field("value", &Against(v, &base.value))?;
                m.serialize_field("base", &base.seq)?;
            }
            _ => m.serialize_field("value", &self.value)?,
        }
        m.serialize_field("known", &self.known)?;
        m.end()
    }
}

/// One sample of a record: when, in ms since 1970, and the value then.
#[derive(Serialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Sample {
    pub t: f64,
    pub v: Value,
}

/// A video a screen plays: the import, and the mid of the transceiver it comes on.
#[derive(Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Played {
    pub mid: String,
    pub alias: String,
}

/// What the HMI brings of an import: the paths that read what it decodes, and the pieces of its
/// own code that read it. Each path is the steps after the import's name.
#[derive(Serialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Brought {
    pub alias: String,
    pub fields: Vec<Vec<String>>,
    pub readers: Vec<Reader>,
}

/// A piece of the HMI's own code and the paths it reads of an import.
#[derive(Serialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Reader {
    /// What it is, as `the Alarm rule`.
    pub who: String,
    pub paths: Vec<Vec<String>>,
}

#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct PeerInfo {
    pub id: u32,
    pub name: String,
    pub address: String,
    pub active: bool,
    /// The smoothed round trip, once measured.
    pub rtt_ms: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::value;

    fn cbor(v: &impl Serialize) -> Vec<u8> {
        let mut out = Vec::new();
        ciborium::into_writer(v, &mut out).unwrap();
        out
    }

    #[test]
    fn a_screen_message_reads_from_cbor() {
        let sent = value!({ "type": "set", "alias": "Speed", "path": "", "value": { "mode": "Auto", "target": 120 } });
        let ClientMsg::Set { alias, path, value } = ciborium::from_reader(&cbor(&sent)[..]).unwrap() else {
            panic!("not a set");
        };
        assert_eq!((alias.as_str(), path.as_str(), value), ("Speed", "", value!({ "mode": "Auto", "target": 120 })));
    }

    /// The exact bytes the client's cbor-x writes for a set, so a change on either side that
    /// breaks the other fails here.
    #[test]
    fn the_clients_own_bytes_read() {
        let hex = "b9000464747970656373657465616c6961736553706565646470617468606576616c7565b90003646d6f6465644175746f667461726765741878646761696efb3ff8000000000000";
        let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        let ClientMsg::Set { alias, value, .. } = ciborium::from_reader(&bytes[..]).unwrap() else {
            panic!("not a set");
        };
        assert_eq!((alias.as_str(), value), ("Speed", value!({ "mode": "Auto", "target": 120, "gain": 1.5 })));
    }

    #[test]
    fn a_backend_message_writes_as_cbor() {
        let msg = ServerMsg::Values {
            values: vec![ValueUpdate { alias: "Joints".into(), value: Some(value!([0.5, -1, "x"])), known: true, base: None }],
            seq: 7,
        };
        let back: Value = ciborium::from_reader(&cbor(&msg)[..]).unwrap();
        assert_eq!(back, value!({ "type": "values", "values": [{ "alias": "Joints", "value": [0.5, -1, "x"], "known": true }], "seq": 7 }));
    }
}

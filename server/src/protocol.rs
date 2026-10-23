//! Every message between the backend and a screen, sent as CBOR. Running `cargo test`
//! writes their TypeScript twins into client/src/protocol, so the two sides never drift.

use std::collections::BTreeMap;

use axum::body::Bytes;
use serde::{Deserialize, Serialize};
use crate::value::Value;
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
    /// serves, so a screen running another knows to load it.
    Hello { session: u32, project: ProjectInfo, version: String, node: String, build: String },
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
    /// The answer to a screen's offer of its WebRTC connection, first or again. None when the
    /// backend cannot make it, so the screen stays on its socket.
    Channels { answer: Option<String> },
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

#[derive(Serialize, TS, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Level {
    Info,
    Warn,
    Fault,
}

/// From a screen to the backend.
#[derive(Deserialize, TS, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum ClientMsg {
    /// Asks for a pong, which goes back the way the ping came, to time the round trip. On the
    /// channels `rtt` is the last round trip the screen timed there, in ms, once.
    Ping {
        t: f64,
        #[serde(default)]
        #[ts(optional)]
        rtt: Option<f64>,
    },
    /// Opens the screen's data channels: its WebRTC offer, which the backend answers.
    Channels { offer: String },
    /// An address the screen found its connection may be reached on, as its `a=candidate` line
    /// without its `a=`.
    Candidate { candidate: String },
    /// From here on the screen's events, sets and answers come on its reliable channel. The
    /// backend holds what the channel brings until this comes, so nothing the screen sent on
    /// its socket before comes after.
    OnChannels,
    /// The screen's channels broke, so what it sent on them may be lost.
    OffChannels,
    /// Offers the screen's data connection again with the videos it plays, each import's on the
    /// transceiver named by its mid. A video left out stops.
    Play { offer: String, videos: Vec<Played> },
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

impl ClientMsg {
    /// The pong for a ping, which the way it came answers at once, as a ping holds no order, so
    /// the round trip times the link and never the loop.
    pub fn pong(&self) -> Option<Bytes> {
        let ClientMsg::Ping { t, .. } = self else { return None };
        Some(encode(&ServerMsg::Pong { t: *t }))
    }
}

pub fn encode(msg: &ServerMsg) -> Bytes {
    let mut out = Vec::new();
    ciborium::into_writer(msg, &mut out).expect("every server message encodes");
    out.into()
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
/// mesh, and the last value stays for reference.
#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct ValueUpdate {
    pub alias: String,
    pub value: Option<Value>,
    pub known: bool,
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
            values: vec![ValueUpdate { alias: "Joints".into(), value: Some(value!([0.5, -1, "x"])), known: true }],
            seq: 7,
        };
        let back: Value = ciborium::from_reader(&cbor(&msg)[..]).unwrap();
        assert_eq!(back, value!({ "type": "values", "values": [{ "alias": "Joints", "value": [0.5, -1, "x"], "known": true }], "seq": 7 }));
    }
}

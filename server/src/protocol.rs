//! Every message between the backend and a screen, sent as CBOR. Running `cargo test`
//! writes their TypeScript twins into client/src/protocol, so the two sides never drift.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::pages::{Edit, Event, Page};
use crate::project::{Import, Kind, ProjectInfo};

/// From the backend to a screen.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum ServerMsg {
    /// The first message on a connection.
    Hello { session: u32, project: ProjectInfo, version: String, node: String },
    /// The project's settings, whole, after a change.
    Project { project: ProjectInfo },
    /// Every import, whole, after any change.
    Imports { imports: Vec<Import> },
    /// Every entity on the mesh, whole, after the mesh changed.
    Mesh { entities: Vec<EntityInfo> },
    /// The values that changed since the last batch.
    Values { values: Vec<ValueUpdate> },
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
    /// An action that was not done, and why, for the screen that asked.
    Refused { text: String, alias: Option<String> },
    /// Something for the person at this screen: what a handler said, or why it stopped.
    Notice { text: String, level: Level },
    /// A handler started from this screen opens a page, in place of the top one when `replace`.
    Open { page: String, replace: bool },
    /// A handler started from this screen closes the top page.
    Close,
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
    /// The heartbeat. A screen silent too long is lost.
    Ping { t: f64 },
    Import { import: Import },
    Unimport { alias: String },
    /// Writes a datapoint, or one of its fields when `path` names one.
    Set { alias: String, path: String, value: Value },
    /// Changes the pages.
    Edit { edit: Edit },
    /// Takes back this screen's last edit, or puts back the last one it took back.
    Undo,
    Redo,
    /// Makes a page the one operators' screens open on.
    SetStart { page: String },
    /// A pointer did `event` to an element of a running page.
    Fire { page: String, id: String, event: Event },
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

/// A datapoint's latest value. `known` is false while its entity is off the mesh, and the
/// last value stays for reference.
#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct ValueUpdate {
    pub alias: String,
    pub value: Option<Value>,
    pub known: bool,
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
    use serde_json::json;

    fn cbor(v: &impl Serialize) -> Vec<u8> {
        let mut out = Vec::new();
        ciborium::into_writer(v, &mut out).unwrap();
        out
    }

    #[test]
    fn a_screen_message_reads_from_cbor() {
        let sent = json!({ "type": "set", "alias": "Speed", "path": "", "value": { "mode": "Auto", "target": 120 } });
        let ClientMsg::Set { alias, path, value } = ciborium::from_reader(&cbor(&sent)[..]).unwrap() else {
            panic!("not a set");
        };
        assert_eq!((alias.as_str(), path.as_str(), value), ("Speed", "", json!({ "mode": "Auto", "target": 120 })));
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
        assert_eq!((alias.as_str(), value), ("Speed", json!({ "mode": "Auto", "target": 120, "gain": 1.5 })));
    }

    #[test]
    fn a_backend_message_writes_as_cbor() {
        let msg = ServerMsg::Values {
            values: vec![ValueUpdate { alias: "Joints".into(), value: Some(json!([0.5, -1, "x"])), known: true }],
        };
        let back: Value = ciborium::from_reader(&cbor(&msg)[..]).unwrap();
        assert_eq!(back, json!({ "type": "values", "values": [{ "alias": "Joints", "value": [0.5, -1, "x"], "known": true }] }));
    }
}

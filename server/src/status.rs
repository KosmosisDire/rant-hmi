//! What the HMI publishes about itself, read only: the screens connected to it and its own
//! state. Pages import them as they import any entity.

use rant::types::Timestamp;

use crate::value::Value;

pub const CLIENTS: &str = "Hmi/Clients";
pub const STATUS: &str = "Hmi/Status";

/// One screen connected to the HMI.
#[derive(rant::Message, Clone, Debug, PartialEq)]
pub struct Client {
    /// Its number, as the log and `p.screen` give it.
    pub id: u32,
    /// Where it connects from. A list holds only fixed sizes, and an IPv6 address fits.
    pub address: rant::String<48>,
    /// When it connected.
    pub connected_at: Timestamp,
    /// The last round trip to it and back, in ms, 0 until one is measured. Timed over WebRTC
    /// while that is open.
    pub ping_ms: f64,
    /// How much the round trip wavers, in ms, smoothed as RTP does: each new one moves it a
    /// sixteenth of the way to how far that round trip was from the last.
    pub jitter_ms: f64,
    /// Whether its WebRTC connection is open. Without it all goes over its socket, its video
    /// as frames the screen decodes itself.
    pub webrtc: bool,
}

/// The HMI's own state.
#[derive(rant::Message, Clone, Debug, PartialEq)]
pub struct HmiStatus {
    pub version: String,
    /// The project's name.
    pub project: String,
    /// When the HMI started.
    pub started_at: Timestamp,
    /// How many screens are connected.
    pub clients: u32,
    /// The entities imported but not on the mesh now, each as long as a name may be.
    pub missing: Vec<rant::String<64>>,
}

/// The screens as a value, as the mesh decodes them.
pub fn clients_value(list: &[Client]) -> Value {
    Value::List(
        list.iter()
            .map(|c| {
                Value::map([
                    ("id", Value::Int(c.id.into())),
                    ("address", (*c.address).into()),
                    ("connected_at", Value::Int(c.connected_at.us.into())),
                    ("ping_ms", c.ping_ms.into()),
                    ("jitter_ms", c.jitter_ms.into()),
                    ("webrtc", c.webrtc.into()),
                ])
            })
            .collect(),
    )
}

/// The state as a value, as the mesh decodes it.
pub fn status_value(s: &HmiStatus) -> Value {
    Value::map([
        ("version", s.version.as_str().into()),
        ("project", s.project.as_str().into()),
        ("started_at", Value::Int(s.started_at.us.into())),
        ("clients", Value::Int(s.clients.into())),
        ("missing", Value::List(s.missing.iter().map(|m| (**m).into()).collect())),
    ])
}

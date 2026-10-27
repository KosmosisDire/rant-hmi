//! What the HMI publishes about itself, read only: the screens connected to it and its own
//! state. Pages import them as they import any entity.

use rant::types::Timestamp;

use crate::value::Value;

pub const CLIENTS: &str = "Hmi/Clients";
pub const STATUS: &str = "Hmi/Status";
pub const PROBLEMS: &str = "Hmi/Problems";

/// A problem a screen found, or a run on the system met. A list holds only fixed sizes, so its
/// words are cut to fit, and the stack of a fault in the HMI's code is left to `GET /problems`.
#[derive(rant::Message, Clone, Debug, PartialEq)]
pub struct ProblemRow {
    /// The screen it was found on, 0 for a run on the system.
    pub screen: u32,
    /// `page`, `run` or `hmi`.
    pub source: rant::String<8>,
    /// `warn` or `fault`.
    pub level: rant::String<8>,
    pub text: rant::String<240>,
    /// The page or component, and its element, that shows a page's problem, empty for none.
    pub page: rant::String<64>,
    pub element: rant::String<32>,
    /// How many times it came.
    pub count: u32,
    /// When it came last.
    pub at: Timestamp,
}

/// The problems as a value, as the mesh decodes them.
pub fn problems_value(list: &[ProblemRow]) -> Value {
    Value::List(
        list.iter()
            .map(|p| {
                Value::map([
                    ("screen", Value::Int(p.screen.into())),
                    ("source", (*p.source).into()),
                    ("level", (*p.level).into()),
                    ("text", (*p.text).into()),
                    ("page", (*p.page).into()),
                    ("element", (*p.element).into()),
                    ("count", Value::Int(p.count.into())),
                    ("at", Value::Int(p.at.us.into())),
                ])
            })
            .collect(),
    )
}

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
    /// Whether its values, pings and actions go on its WebRTC link channel, else its socket.
    pub channel: bool,
    /// The round trips of the last 10 s, as `[median, 90th percentile, most]` in ms.
    pub ping_spread_ms: [f64; 3],
    /// The trips of the big values it took in the last 10 s, from going until it said it took
    /// each, as `[median, 90th percentile, most]` in ms.
    pub big_spread_ms: [f64; 3],
    /// How many big values it took a second, over the last 10 s.
    pub bigs_per_s: f64,
    /// The big values it never said it took, since it connected.
    pub lapsed: u32,
    /// What its ways carried to it over the last 10 s, in kilobits a second.
    pub kbps: f64,
    /// Why its WebRTC connection did not open, as the screen found, one of WEBRTC_PROBLEMS,
    /// empty while it is open or the screen has not said.
    pub webrtc_problem: rant::String<24>,
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

/// Why a screen's WebRTC connection did not open, as the screen tells it, and what each means.
pub const WEBRTC_PROBLEMS: [(&str, &str); 4] = [
    ("no_webrtc", "its browser does not support WebRTC"),
    ("browser_blocks", "check it for a VPN, a privacy extension or a policy preventing WebRTC"),
    ("network_blocks_udp", "check its network for a firewall or policy blocking UDP"),
    ("no_path", "no direct route was found between its network and the HMI"),
];

/// What a problem the screen named means, or the name itself for one this backend does not know.
pub fn webrtc_problem_words(problem: &str) -> &str {
    WEBRTC_PROBLEMS.iter().find(|(name, _)| *name == problem).map_or(problem, |(_, words)| words)
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
                    ("channel", c.channel.into()),
                    ("ping_spread_ms", Value::List(c.ping_spread_ms.iter().map(|&v| v.into()).collect())),
                    ("big_spread_ms", Value::List(c.big_spread_ms.iter().map(|&v| v.into()).collect())),
                    ("bigs_per_s", c.bigs_per_s.into()),
                    ("lapsed", Value::Int(c.lapsed.into())),
                    ("kbps", c.kbps.into()),
                    ("webrtc_problem", (*c.webrtc_problem).into()),
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

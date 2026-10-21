//! WebRTC for screens, set up over each screen's socket. A screen has one data connection, a
//! reliable ordered channel and a best effort one, which carry its messages where they open.
//! Video plays on a connection per import, which works on a plain http page where WebCodecs
//! cannot, and each H264 frame of the import's source goes out to it as it comes.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
use str0m::format::Codec;
use str0m::media::{MediaTime, Mid, Pt, Writer};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};
use tokio::net::UdpSocket;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tracing::{info, warn};

use crate::protocol::ClientMsg;

/// The labels a screen gives its two channels.
pub const RELIABLE: &str = "reliable";
pub const BEST_EFFORT: &str = "best-effort";

/// A message bigger than this goes over the socket. Losing any of its packets loses all of it
/// on the best effort channel, and on the reliable one it holds back what comes after.
pub const MESSAGE_MAX: usize = 16 * 1024;

/// A screen that missed messages, its channels full, gets everything again once one drains
/// below this. Full is str0m's 128 KiB for the two together.
const DRAINED: usize = 32 * 1024;

/// One H264 frame of an import's video, in Annex B as the mesh carries it.
pub struct Frame {
    pub alias: String,
    pub keyframe: bool,
    /// When to show it, in microseconds.
    pub pts: i64,
    pub data: Vec<u8>,
}

pub enum ToRtc {
    /// A screen offers its data connection. `local` is the address the screen reached the HMI
    /// on, so the connection comes from there too.
    Channels { session: u32, sdp: String, local: IpAddr },
    /// A screen offers to play an import.
    Offer { session: u32, alias: String, sdp: String, local: IpAddr },
    Stop { session: u32, alias: String },
    /// The screen is gone, and so is all it played.
    Gone { session: u32 },
    Frame(Frame),
    /// A message for a screen, on its reliable channel or its best effort one. It is left out
    /// while the channels are full.
    Send { session: u32, reliable: bool, bytes: Bytes },
}

pub enum FromRtc {
    /// The answer to a screen's data connection, none when it could not be made.
    Channels { session: u32, sdp: Option<String> },
    Answer { session: u32, alias: String, sdp: String },
    Failed { session: u32, alias: String, text: String },
    /// Both of a screen's channels opened, or one of them closed.
    Linked { session: u32, open: bool },
    /// What a screen sent on a channel.
    Message { session: u32, msg: ClientMsg },
    /// A screen's channels drained after it missed messages, so it needs them all.
    CaughtUp { session: u32 },
}

struct Peer {
    session: u32,
    rtc: Rtc,
    socket: Arc<UdpSocket>,
    wake: Instant,
    carries: Carries,
}

enum Carries {
    Messages(Channels),
    Video(Video),
}

#[derive(Default)]
struct Channels {
    reliable: Option<ChannelId>,
    best_effort: Option<ChannelId>,
    /// Messages were left out while the channels were full.
    missed: bool,
}

struct Video {
    alias: String,
    mid: Option<Mid>,
    pt: Option<Pt>,
    connected: bool,
    /// Frames start at a keyframe, since nothing before one decodes.
    started: bool,
}

impl Peer {
    fn plays(&self, alias: &str) -> bool {
        matches!(&self.carries, Carries::Video(v) if v.alias == alias)
    }

    fn linked(&self) -> bool {
        matches!(&self.carries, Carries::Messages(Channels { reliable: Some(_), best_effort: Some(_), .. }))
    }

    fn name(&self) -> String {
        match &self.carries {
            Carries::Messages(_) => format!("the data connection of screen {}", self.session),
            Carries::Video(v) => format!("video for screen {} ({})", self.session, v.alias),
        }
    }
}

/// A datagram one of the sockets took: the address it came to, where from, and its bytes.
type Packet = (SocketAddr, SocketAddr, Vec<u8>);

/// Starts the task that owns every connection. Frames and the loop's requests go in through
/// the sender, answers and what screens send come back through `said`.
pub fn start(said: UnboundedSender<FromRtc>) -> UnboundedSender<ToRtc> {
    str0m::crypto::from_feature_flags().install_process_default();
    let (tx, rx) = unbounded_channel();
    tokio::spawn(run(rx, said));
    tx
}

async fn run(mut requests: UnboundedReceiver<ToRtc>, said: UnboundedSender<FromRtc>) {
    let (arrived, mut packets) = unbounded_channel::<Packet>();
    let mut sockets: HashMap<IpAddr, Arc<UdpSocket>> = HashMap::new();
    let mut peers: Vec<Peer> = Vec::new();
    loop {
        let wake = peers.iter().map(|p| p.wake).min().unwrap_or_else(|| Instant::now() + Duration::from_secs(60));
        tokio::select! {
            r = requests.recv() => match r {
                None => return,
                Some(ToRtc::Channels { session, sdp, local }) => {
                    close(&mut peers, &said, |p| p.session == session && matches!(p.carries, Carries::Messages(_)));
                    // a data connection has no media, so it takes no codecs
                    let config = RtcConfig::new().set_ice_lite(true).clear_codecs();
                    match answer(&mut sockets, &arrived, config, &sdp, local).await {
                        Ok((rtc, socket, sdp)) => {
                            info!("screen {session} opens its data connection on {}", socket.local_addr().map_or_else(|_| local.to_string(), |a| a.to_string()));
                            peers.push(Peer { session, rtc, socket, wake: Instant::now(), carries: Carries::Messages(Channels::default()) });
                            let _ = said.send(FromRtc::Channels { session, sdp: Some(sdp) });
                        }
                        Err(text) => {
                            warn!("screen {session} stays on its socket: {text}");
                            let _ = said.send(FromRtc::Channels { session, sdp: None });
                        }
                    }
                }
                Some(ToRtc::Offer { session, alias, sdp, local }) => {
                    peers.retain(|p| !(p.session == session && p.plays(&alias)));
                    // ice lite: the screen finds this end, so its own hidden addresses never matter
                    let config = RtcConfig::new().set_ice_lite(true).clear_codecs().enable_h264(true);
                    match answer(&mut sockets, &arrived, config, &sdp, local).await {
                        Ok((rtc, socket, sdp)) => {
                            info!("screen {session} plays {alias}");
                            let video = Video { alias: alias.clone(), mid: None, pt: None, connected: false, started: false };
                            peers.push(Peer { session, rtc, socket, wake: Instant::now(), carries: Carries::Video(video) });
                            let _ = said.send(FromRtc::Answer { session, alias, sdp });
                        }
                        Err(text) => {
                            let _ = said.send(FromRtc::Failed { session, alias, text });
                        }
                    }
                }
                Some(ToRtc::Stop { session, alias }) => peers.retain(|p| !(p.session == session && p.plays(&alias))),
                Some(ToRtc::Gone { session }) => peers.retain(|p| p.session != session),
                Some(ToRtc::Frame(f)) => {
                    let data: Arc<[u8]> = f.data.into();
                    for p in peers.iter_mut().filter(|p| p.plays(&f.alias)) {
                        write(p, f.keyframe, f.pts, &data);
                    }
                }
                Some(ToRtc::Send { session, reliable, bytes }) => {
                    if let Some(p) = peers.iter_mut().find(|p| p.session == session && matches!(p.carries, Carries::Messages(_))) {
                        put(p, reliable, &bytes);
                    }
                }
            },
            Some((local, source, data)) = packets.recv() => {
                let Ok(contents) = data.as_slice().try_into() else { continue };
                let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: local, contents });
                if let Some(p) = peers.iter_mut().find(|p| p.rtc.accepts(&input)) {
                    if let Err(e) = p.rtc.handle_input(input) {
                        warn!("{} failed: {e}", p.name());
                        p.rtc.disconnect();
                    }
                }
            }
            _ = tokio::time::sleep_until(wake.into()) => {
                let now = Instant::now();
                for p in peers.iter_mut().filter(|p| p.wake <= now) {
                    let _ = p.rtc.handle_input(Input::Timeout(now));
                }
            }
        }
        for p in &mut peers {
            drive(p, &said).await;
        }
        close(&mut peers, &said, |p| !p.rtc.is_alive());
    }
}

/// Drops the connections `gone` picks, telling the loop of a screen whose channels close.
fn close(peers: &mut Vec<Peer>, said: &UnboundedSender<FromRtc>, gone: impl Fn(&Peer) -> bool) {
    for p in peers.iter().filter(|p| gone(p) && p.linked()) {
        let _ = said.send(FromRtc::Linked { session: p.session, open: false });
    }
    peers.retain(|p| !gone(p));
}

/// Answers a screen's offer, on a socket bound to the address the screen reached the HMI on.
async fn answer(sockets: &mut HashMap<IpAddr, Arc<UdpSocket>>, arrived: &UnboundedSender<Packet>, config: RtcConfig, sdp: &str, local: IpAddr) -> Result<(Rtc, Arc<UdpSocket>, String), String> {
    let socket = match sockets.get(&local) {
        Some(s) => s.clone(),
        None => {
            let s = bind(local, arrived.clone()).await.map_err(|e| format!("could not open a port for WebRTC on {local}: {e}"))?;
            sockets.insert(local, s.clone());
            s
        }
    };
    let mut rtc = config.build(Instant::now());
    let address = socket.local_addr().map_err(|e| e.to_string())?;
    let candidate = Candidate::host(address, "udp").map_err(|e| e.to_string())?;
    rtc.add_local_candidate(candidate);
    let offer = SdpOffer::from_sdp_string(sdp).map_err(|e| format!("the screen's offer did not read: {e}"))?;
    let answer = rtc.sdp_api().accept_offer(offer).map_err(|e| format!("the screen's offer was refused: {e}"))?;
    Ok((rtc, socket, answer.to_sdp_string()))
}

/// A socket on one address of this host, its datagrams going to the task as they come.
async fn bind(ip: IpAddr, arrived: UnboundedSender<Packet>) -> std::io::Result<Arc<UdpSocket>> {
    let socket = Arc::new(UdpSocket::bind((ip, 0)).await?);
    let local = socket.local_addr()?;
    let reader = socket.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 2048];
        loop {
            match reader.recv_from(&mut buf).await {
                Ok((n, from)) => {
                    if arrived.send((local, from, buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
                // Windows reports an earlier send's unreachable port on the next receive
                Err(e) if e.kind() == ErrorKind::ConnectionReset => {}
                Err(e) => {
                    warn!("the WebRTC port on {local} stopped: {e}");
                    return;
                }
            }
        }
    });
    Ok(socket)
}

/// Sends what the connection has to send, hands on what it took, and learns when it next
/// needs a turn.
async fn drive(p: &mut Peer, said: &UnboundedSender<FromRtc>) {
    loop {
        match p.rtc.poll_output() {
            Ok(Output::Timeout(t)) => {
                p.wake = t;
                return;
            }
            Ok(Output::Transmit(t)) => {
                let _ = p.socket.send_to(&t.contents, t.destination).await;
            }
            Ok(Output::Event(e)) => {
                let was = p.linked();
                match (e, &mut p.carries) {
                    (Event::IceConnectionStateChange(IceConnectionState::Disconnected), _) => {
                        p.rtc.disconnect();
                        return;
                    }
                    (Event::MediaAdded(m), Carries::Video(v)) => v.mid = Some(m.mid),
                    (Event::Connected, Carries::Video(v)) => v.connected = true,
                    (Event::ChannelOpen(id, label), Carries::Messages(c)) => {
                        match label.as_str() {
                            RELIABLE => c.reliable = Some(id),
                            BEST_EFFORT => c.best_effort = Some(id),
                            _ => warn!("screen {} opened a channel {label} this backend does not know", p.session),
                        }
                        if let Some(mut channel) = p.rtc.channel(id) {
                            channel.set_buffered_amount_low_threshold(DRAINED);
                        }
                    }
                    (Event::ChannelBufferedAmountLow(_), Carries::Messages(c)) => {
                        if std::mem::take(&mut c.missed) {
                            let _ = said.send(FromRtc::CaughtUp { session: p.session });
                        }
                    }
                    (Event::ChannelClose(id), Carries::Messages(c)) => {
                        for slot in [&mut c.reliable, &mut c.best_effort] {
                            if *slot == Some(id) {
                                *slot = None;
                            }
                        }
                    }
                    (Event::ChannelData(d), Carries::Messages(_)) => match ciborium::from_reader::<ClientMsg, _>(d.data.as_slice()) {
                        Ok(msg) => {
                            let _ = said.send(FromRtc::Message { session: p.session, msg });
                        }
                        Err(e) => warn!("screen {} sent what this backend cannot read: {e}", p.session),
                    },
                    _ => {}
                }
                if was != p.linked() {
                    let open = p.linked();
                    info!("screen {} {} its data channels", p.session, if open { "has" } else { "lost" });
                    let _ = said.send(FromRtc::Linked { session: p.session, open });
                }
            }
            Err(e) => {
                warn!("{} failed: {e}", p.name());
                p.rtc.disconnect();
                return;
            }
        }
    }
}

/// Writes a message on one of a screen's channels, or leaves it out while they are full.
fn put(p: &mut Peer, reliable: bool, bytes: &[u8]) {
    let Carries::Messages(c) = &mut p.carries else { return };
    let Some(id) = (if reliable { c.reliable } else { c.best_effort }) else { return };
    let Some(mut channel) = p.rtc.channel(id) else { return };
    match channel.write(true, bytes) {
        Ok(true) => {}
        Ok(false) => c.missed = true,
        Err(e) => warn!("a message for screen {} did not go: {e}", p.session),
    }
}

fn write(p: &mut Peer, keyframe: bool, pts: i64, data: &Arc<[u8]>) {
    let Carries::Video(v) = &mut p.carries else { return };
    if !v.connected || !(v.started || keyframe) {
        return;
    }
    let Some(writer) = v.mid.and_then(|mid| p.rtc.writer(mid)) else { return };
    let Some(pt) = v.pt.or_else(|| h264(&writer)) else { return };
    v.pt = Some(pt);
    v.started = true;
    if let Err(e) = writer.write(pt, Instant::now(), MediaTime::from_micros(pts.max(0) as u64), data.clone()) {
        warn!("a frame for screen {} ({}) did not go: {e}", p.session, v.alias);
    }
}

/// The H264 payload the screen took, the transcoder's constrained baseline in packetization
/// mode 1 first.
fn h264(writer: &Writer) -> Option<Pt> {
    writer
        .payload_params()
        .filter(|p| p.spec().codec == Codec::H264)
        .max_by_key(|p| {
            let f = p.spec().format;
            (f.packetization_mode == Some(1), f.profile_level_id == Some(0x42e01f))
        })
        .map(|p| p.pt())
}

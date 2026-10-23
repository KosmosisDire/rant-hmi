//! WebRTC for screens, set up over each screen's socket. A screen has one connection: a
//! reliable ordered channel and a best effort one, which carry its values where they open,
//! and the video of each import it plays, which works on a plain http page where WebCodecs
//! cannot. The reliable channel carries pieces of lanes as a socket does (`lanes.rs`), as fast
//! as the screen's acks confirm them (`flight.rs`). Each H264 frame of an import's source goes
//! out to the screens playing it here as it comes. A screen without WebRTC decodes its video
//! itself from frames on its socket (`Lanes::video`).

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr};
use std::ops::RangeInclusive;
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

use crate::flight::Flight;
use crate::lanes::{Lanes, PIECE};
use crate::project::IceServer;
use crate::protocol::{ClientMsg, Played};
use crate::stun;

/// The labels a screen gives its two channels.
pub const RELIABLE: &str = "reliable";
pub const BEST_EFFORT: &str = "best-effort";

/// A message bigger than this goes on the reliable channel in pieces. Losing any of its packets
/// loses all of it on the best effort channel.
pub const MESSAGE_MAX: usize = 16 * 1024;

/// The most the reliable channel has on its way, half of what str0m holds for the two
/// channels, so the best effort one always has room.
const RELIABLE_MAX: usize = 512 << 10;

/// A screen that missed messages on its best effort channel, the channels full, gets
/// everything again once one drains below this.
const DRAINED: usize = 32 * 1024;

/// A frame that came off the mesh longer ago than this is dropped, and its video goes on from the
/// next keyframe, so a busy backend or a slow socket makes video late by this at most, and never
/// what screens send and get.
pub const FRAME_LATE: Duration = Duration::from_millis(200);

/// How long the outside address a STUN server told for a port holds before a new screen asks
/// again, since a NAT may map the port anew once it went quiet.
const ASK_AGAIN: Duration = Duration::from_secs(30);

/// One H264 frame of an import's video, in Annex B as the mesh carries it.
pub struct Frame {
    pub alias: String,
    pub keyframe: bool,
    /// When to show it, in microseconds.
    pub pts: i64,
    pub data: Bytes,
    /// When it came off the mesh.
    pub at: Instant,
}

pub enum ToRtc {
    /// A screen offers its data connection, which replaces any it had. `local` is the address
    /// the screen reached the HMI on, which the connection offers first, and `ice` the servers
    /// that tell what a NAT shows the outside of this host.
    Channels { session: u32, sdp: String, local: IpAddr, ice: Vec<IceServer> },
    /// An address the screen found its connection may be reached on.
    Candidate { session: u32, candidate: String },
    /// A screen offers its data connection again with the videos it plays now.
    Play { session: u32, sdp: String, videos: Vec<Played> },
    /// The screen's channels broke, or the screen is gone, so its connection ends.
    Unlink { session: u32 },
    /// A message for a screen.
    Send { session: u32, way: Way, bytes: Bytes },
}

/// Where a message for a screen with channels goes: whole on its best effort channel, left out
/// while that is full, or on its reliable one in the lanes a socket has.
#[derive(Clone)]
pub enum Way {
    BestEffort,
    Control,
    Values,
    /// An import's value too big to share a message.
    Alone(String),
}

pub enum FromRtc {
    /// The answer to a screen's offer, none when it could not be taken.
    Channels { session: u32, sdp: Option<String> },
    /// Both of a screen's channels opened, or one of them or the whole connection closed.
    Linked { session: u32, open: bool },
    /// What a screen sent on a channel.
    Message { session: u32, msg: ClientMsg },
    /// The screen pinged on its channels, answered already, with the round trip it timed last.
    Heard { session: u32, rtt: Option<Duration> },
    /// A screen missed values, so it needs them all.
    CaughtUp { session: u32 },
    /// An address of this host a screen's connection may be reached on, found after its answer.
    Candidate { session: u32, candidate: String },
}

/// A screen's connection.
struct Peer {
    session: u32,
    rtc: Rtc,
    wake: Instant,
    connected: bool,
    reliable: Option<ChannelId>,
    best_effort: Option<ChannelId>,
    /// Messages were left out while the channels were full.
    missed: bool,
    /// What goes on the reliable channel, how much of it may be on the way, timed from when
    /// the connection opened, and a piece the channel had no room for yet.
    lanes: Lanes,
    flight: Flight,
    born: Instant,
    held: Option<Bytes>,
    videos: Vec<Video>,
}

struct Video {
    alias: String,
    mid: Mid,
    pt: Option<Pt>,
    /// Frames start at a keyframe, since nothing before one decodes.
    started: bool,
}

impl Peer {
    fn linked(&self) -> bool {
        self.reliable.is_some() && self.best_effort.is_some()
    }

    /// Takes the screen's offer again with the videos it plays now. A video playing on where it
    /// did goes on from the frame it is at.
    fn play(&mut self, sdp: &str, videos: Vec<Played>) -> Result<String, String> {
        let answer = accept(&mut self.rtc, sdp)?;
        let mut before = std::mem::take(&mut self.videos);
        for Played { mid, alias } in videos {
            let mid = Mid::from(mid.as_str());
            match before.iter().position(|v| v.mid == mid && v.alias == alias) {
                Some(i) => self.videos.push(before.swap_remove(i)),
                None => {
                    info!("screen {} plays {alias}", self.session);
                    self.videos.push(Video { alias, mid, pt: None, started: false });
                }
            }
        }
        Ok(answer)
    }
}

/// A datagram one of the sockets took: the address it came to, where from, and its bytes.
type Packet = (SocketAddr, SocketAddr, Vec<u8>);

/// One of this host's addresses WebRTC takes datagrams on, and the address a NAT shows the
/// outside for it, as a STUN server last told.
struct Port {
    socket: Arc<UdpSocket>,
    outside: Option<SocketAddr>,
    asked: Option<Instant>,
}

/// Where the task takes WebRTC.
pub struct Reach {
    /// Only on the address each screen reached the HMI on, else on every address of this host.
    pub loopback: bool,
    /// The ports it may take, else any.
    pub ports: Option<RangeInclusive<u16>>,
}

/// The task that owns every connection, as the loop holds it.
pub struct Connections {
    requests: UnboundedSender<ToRtc>,
    frames: UnboundedSender<Frame>,
}

impl Connections {
    pub fn send(&self, request: ToRtc) {
        let _ = self.requests.send(request);
    }

    /// A frame for the screens playing its video here.
    pub fn frame(&self, frame: Frame) {
        let _ = self.frames.send(frame);
    }
}

/// Starts the task that owns every connection. Answers and what screens send come back
/// through `said`.
pub fn start(said: UnboundedSender<FromRtc>, reach: Reach) -> Connections {
    str0m::crypto::from_feature_flags().install_process_default();
    let (requests, rx) = unbounded_channel();
    let (frames, frames_rx) = unbounded_channel();
    tokio::spawn(run(rx, frames_rx, said, reach));
    Connections { requests, frames }
}

async fn run(mut requests: UnboundedReceiver<ToRtc>, mut frames: UnboundedReceiver<Frame>, said: UnboundedSender<FromRtc>, reach: Reach) {
    let (arrived, mut packets) = unbounded_channel::<Packet>();
    let mut ports: HashMap<IpAddr, Port> = HashMap::new();
    // the STUN requests not answered yet, each with the port it went from and when
    let mut asking: HashMap<stun::Id, (IpAddr, Instant)> = HashMap::new();
    let mut servers: Vec<String> = Vec::new();
    let mut peers: Vec<Peer> = Vec::new();
    loop {
        let wake = peers.iter().map(|p| p.wake).min().unwrap_or_else(|| Instant::now() + Duration::from_secs(60));
        // frames go last, so they wait behind what screens send and get, never the other way
        tokio::select! {
            biased;
            r = requests.recv() => match r {
                None => return,
                Some(ToRtc::Channels { session, sdp, local, ice }) => {
                    close(&mut peers, &said, |p| p.session == session);
                    let ips = addresses(local, reach.loopback);
                    open(&mut ports, &ips, &reach, &arrived).await;
                    ask(&mut ports, &mut asking, &mut servers, &ice);
                    let config = RtcConfig::new().set_sctp_max_buffered_amount(2 * RELIABLE_MAX).clear_codecs().enable_h264(true);
                    let sdp = match answer(&ports, &ips, config, &sdp) {
                        Ok((rtc, sdp)) => {
                            info!("screen {session} opens its data connection");
                            peers.push(Peer { session, rtc, wake: Instant::now(), connected: false, reliable: None, best_effort: None, missed: false, lanes: Lanes::default(), flight: Flight::default(), born: Instant::now(), held: None, videos: Vec::new() });
                            Some(sdp)
                        }
                        Err(text) => {
                            warn!("screen {session} stays on its socket: {text}");
                            None
                        }
                    };
                    let _ = said.send(FromRtc::Channels { session, sdp });
                }
                // a browser names its own addresses by mDNS, which this end cannot read, and
                // reaches this end from them anyway
                Some(ToRtc::Candidate { session, candidate }) => {
                    if let Some(p) = peers.iter_mut().find(|p| p.session == session)
                        && let Ok(c) = Candidate::from_sdp_string(&candidate)
                    {
                        p.rtc.add_remote_candidate(c);
                    }
                }
                Some(ToRtc::Play { session, sdp, videos }) => {
                    let answer = match peers.iter_mut().find(|p| p.session == session) {
                        Some(p) => p.play(&sdp, videos),
                        None => Err("its data connection is gone".into()),
                    };
                    if let Err(text) = &answer {
                        warn!("screen {session} could not change the videos it plays: {text}");
                    }
                    let _ = said.send(FromRtc::Channels { session, sdp: answer.ok() });
                }
                Some(ToRtc::Unlink { session }) => close(&mut peers, &said, |p| p.session == session),
                Some(ToRtc::Send { session, way, bytes }) => {
                    if let Some(p) = peers.iter_mut().find(|p| p.session == session) {
                        match way {
                            Way::BestEffort => best_effort(p, &bytes),
                            Way::Control => p.lanes.send(bytes),
                            Way::Values => p.lanes.values(bytes),
                            Way::Alone(alias) => p.lanes.alone(&alias, bytes),
                        }
                    }
                }
            },
            Some((local, source, data)) = packets.recv() => {
                if let Some((id, outside)) = stun::answer(&data)
                    && let Some((ip, _)) = asking.remove(&id)
                {
                    found(&mut ports, &mut peers, &said, ip, outside);
                    continue;
                }
                let Ok(contents) = data.as_slice().try_into() else { continue };
                let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: local, contents });
                if let Some(p) = peers.iter_mut().find(|p| p.rtc.accepts(&input))
                    && let Err(e) = p.rtc.handle_input(input)
                {
                    warn!("the connection of screen {} failed: {e}", p.session);
                    p.rtc.disconnect();
                }
            }
            _ = tokio::time::sleep_until(wake.into()) => {
                let now = Instant::now();
                for p in peers.iter_mut().filter(|p| p.wake <= now) {
                    let _ = p.rtc.handle_input(Input::Timeout(now));
                }
            }
            Some(Frame { alias, keyframe, pts, data, at }) = frames.recv() => {
                let late = at.elapsed() > FRAME_LATE;
                let data: Arc<[u8]> = Arc::from(&data[..]);
                for p in &mut peers {
                    write(p, &alias, keyframe, pts, &data, late);
                }
            }
        }
        // what the connection brought first, as a ping's pong goes in this turn
        for p in &mut peers {
            drive(p, &ports, &said).await;
            pump(p, &said);
            drive(p, &ports, &said).await;
        }
        close(&mut peers, &said, |p| !p.rtc.is_alive());
    }
}

/// Drops the connections `gone` picks, telling the loop each screen lost its connection.
fn close(peers: &mut Vec<Peer>, said: &UnboundedSender<FromRtc>, gone: impl Fn(&Peer) -> bool) {
    for p in peers.iter().filter(|p| gone(p)) {
        let _ = said.send(FromRtc::Linked { session: p.session, open: false });
    }
    peers.retain(|p| !gone(p));
}

/// The addresses a screen that reached the HMI on `local` may find it on: that one first, and
/// unless WebRTC stays there, every other this host has.
fn addresses(local: IpAddr, loopback: bool) -> Vec<IpAddr> {
    let mut ips = vec![local];
    if loopback {
        return ips;
    }
    match if_addrs::get_if_addrs() {
        Ok(all) => ips.extend(all.iter().filter(|i| i.is_oper_up() && !i.is_loopback() && !i.is_link_local()).map(|i| i.ip()).filter(|ip| *ip != local)),
        Err(e) => warn!("could not list this host's addresses for WebRTC: {e}"),
    }
    ips
}

/// Opens a port on each of `ips` that has none yet.
async fn open(ports: &mut HashMap<IpAddr, Port>, ips: &[IpAddr], reach: &Reach, arrived: &UnboundedSender<Packet>) {
    for &ip in ips {
        if ports.contains_key(&ip) {
            continue;
        }
        match bind(ip, reach.ports.clone(), arrived.clone()).await {
            Ok(socket) => {
                ports.insert(ip, Port { socket, outside: None, asked: None });
            }
            Err(e) => warn!("could not open a port for WebRTC on {ip}: {e}"),
        }
    }
}

/// Asks each STUN server what the outside sees of each port not asked lately. A port on
/// loopback asks the servers there, and the rest the others, as each can only reach those.
/// `servers` are those last asked, since others may see another outside.
fn ask(ports: &mut HashMap<IpAddr, Port>, asking: &mut HashMap<stun::Id, (IpAddr, Instant)>, servers: &mut Vec<String>, ice: &[IceServer]) {
    let now = Instant::now();
    asking.retain(|_, (_, at)| now - *at < ASK_AGAIN);
    let named: Vec<String> = ice.iter().filter_map(|s| stun::server(&s.urls)).collect();
    if named != *servers {
        *servers = named;
        for p in ports.values_mut() {
            p.asked = None;
            p.outside = None;
        }
    }
    for (&ip, port) in ports.iter_mut().filter(|(_, p)| p.asked.is_none_or(|at| now - at >= ASK_AGAIN)) {
        port.asked = Some(now);
        for server in servers.iter() {
            let mut id = [0; 12];
            if getrandom::fill(&mut id).is_err() {
                return;
            }
            asking.insert(id, (ip, now));
            let (socket, server) = (port.socket.clone(), server.clone());
            tokio::spawn(async move {
                let Ok(found) = tokio::net::lookup_host(&server).await else { return };
                let mut found = found.filter(|a| a.is_ipv4() == ip.is_ipv4() && a.ip().is_loopback() == ip.is_loopback());
                if let Some(to) = found.next() {
                    let _ = socket.send_to(&stun::request(&id), to).await;
                }
            });
        }
    }
}

/// A STUN server told what the outside sees of the port on `ip`, which every connection now
/// offers the screen too.
fn found(ports: &mut HashMap<IpAddr, Port>, peers: &mut [Peer], said: &UnboundedSender<FromRtc>, ip: IpAddr, outside: SocketAddr) {
    let Some(port) = ports.get_mut(&ip) else { return };
    let Ok(base) = port.socket.local_addr() else { return };
    if port.outside.replace(outside) != Some(outside) && outside != base {
        info!("WebRTC on {base} shows the outside {outside}");
    }
    let Ok(candidate) = Candidate::server_reflexive(outside, base, "udp") else { return };
    for p in peers {
        // one the connection has already, or that is its port's own address, adds nothing
        if let Some(c) = p.rtc.add_local_candidate(candidate.clone()) {
            let _ = said.send(FromRtc::Candidate { session: p.session, candidate: c.to_sdp_string() });
        }
    }
}

/// Answers a screen's offer with each of `ips`' ports and what the outside sees of them.
fn answer(ports: &HashMap<IpAddr, Port>, ips: &[IpAddr], config: RtcConfig, sdp: &str) -> Result<(Rtc, String), String> {
    let mut rtc = config.build(Instant::now());
    let mut offered = 0;
    for port in ips.iter().filter_map(|ip| ports.get(ip)) {
        let Ok(base) = port.socket.local_addr() else { continue };
        if let Ok(c) = Candidate::host(base, "udp") {
            offered += usize::from(rtc.add_local_candidate(c).is_some());
        }
        if let Some(c) = port.outside.and_then(|o| Candidate::server_reflexive(o, base, "udp").ok()) {
            rtc.add_local_candidate(c);
        }
    }
    if offered == 0 {
        return Err("it has no port for WebRTC".into());
    }
    let answer = accept(&mut rtc, sdp)?;
    Ok((rtc, answer))
}

fn accept(rtc: &mut Rtc, sdp: &str) -> Result<String, String> {
    let offer = SdpOffer::from_sdp_string(sdp).map_err(|e| format!("the screen's offer did not read: {e}"))?;
    let answer = rtc.sdp_api().accept_offer(offer).map_err(|e| format!("the screen's offer was refused: {e}"))?;
    Ok(answer.to_sdp_string())
}

/// A socket on one address of this host, on the first port of `ports` free there, its
/// datagrams going to the task as they come.
async fn bind(ip: IpAddr, ports: Option<RangeInclusive<u16>>, arrived: UnboundedSender<Packet>) -> std::io::Result<Arc<UdpSocket>> {
    let socket = match ports {
        None => UdpSocket::bind((ip, 0)).await?,
        Some(range) => {
            let mut free = None;
            for port in range.clone() {
                if let Ok(s) = UdpSocket::bind((ip, port)).await {
                    free = Some(s);
                    break;
                }
            }
            free.ok_or_else(|| std::io::Error::new(ErrorKind::AddrInUse, format!("every port of {}-{} is taken", range.start(), range.end())))?
        }
    };
    let socket = Arc::new(socket);
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
async fn drive(p: &mut Peer, ports: &HashMap<IpAddr, Port>, said: &UnboundedSender<FromRtc>) {
    loop {
        match p.rtc.poll_output() {
            Ok(Output::Timeout(t)) => {
                p.wake = t;
                return;
            }
            Ok(Output::Transmit(t)) => {
                if let Some(port) = ports.get(&t.source.ip()) {
                    let _ = port.socket.send_to(&t.contents, t.destination).await;
                }
            }
            Ok(Output::Event(e)) => {
                let was = p.linked();
                match e {
                    Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                        p.rtc.disconnect();
                        return;
                    }
                    Event::Connected => p.connected = true,
                    Event::ChannelOpen(id, label) => {
                        match label.as_str() {
                            RELIABLE => p.reliable = Some(id),
                            BEST_EFFORT => p.best_effort = Some(id),
                            _ => warn!("screen {} opened a channel {label} this backend does not know", p.session),
                        }
                        if let Some(mut channel) = p.rtc.channel(id) {
                            channel.set_buffered_amount_low_threshold(DRAINED);
                        }
                    }
                    Event::ChannelBufferedAmountLow(_) => {
                        if std::mem::take(&mut p.missed) {
                            let _ = said.send(FromRtc::CaughtUp { session: p.session });
                        }
                    }
                    Event::ChannelClose(id) => {
                        for slot in [&mut p.reliable, &mut p.best_effort] {
                            if *slot == Some(id) {
                                *slot = None;
                            }
                        }
                    }
                    Event::ChannelData(d) => match ciborium::from_reader::<ClientMsg, _>(d.data.as_slice()) {
                        Ok(msg @ ClientMsg::Ping { rtt, .. }) => {
                            if let Some(pong) = msg.pong() {
                                p.lanes.send(pong);
                            }
                            // the screen times its channels, which says how long the reliable one's way is
                            let rtt = rtt.filter(|r| r.is_finite() && *r >= 0.0).map(|r| Duration::from_secs_f64(r / 1000.0));
                            if let Some(rtt) = rtt {
                                p.flight.trip(rtt.as_micros() as u64);
                            }
                            let _ = said.send(FromRtc::Heard { session: p.session, rtt });
                        }
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
                warn!("the connection of screen {} failed: {e}", p.session);
                p.rtc.disconnect();
                return;
            }
        }
    }
}

/// Writes pieces of the lanes on the reliable channel while it has room, small messages even
/// while it has none, and tells the loop when the screen missed values.
fn pump(p: &mut Peer, said: &UnboundedSender<FromRtc>) {
    if let Some(id) = p.reliable
        && let Some(mut channel) = p.rtc.channel(id)
    {
        let mut on_way = channel.buffered_amount();
        p.flight.on_way(on_way as u64, p.born.elapsed().as_micros() as u64);
        while on_way + PIECE + 3 <= RELIABLE_MAX {
            let Some(piece) = p.held.take().or_else(|| p.lanes.take(p.flight.room())) else { break };
            match channel.write(true, &piece) {
                Ok(true) => {
                    p.flight.wrote(piece.len());
                    on_way += piece.len();
                }
                Ok(false) => {
                    p.held = Some(piece);
                    break;
                }
                Err(e) => {
                    warn!("a message for screen {} did not go: {e}", p.session);
                    break;
                }
            }
        }
    }
    if p.lanes.missed() {
        let _ = said.send(FromRtc::CaughtUp { session: p.session });
    }
}

/// Writes a message on a screen's best effort channel, or leaves it out while it is full.
fn best_effort(p: &mut Peer, bytes: &[u8]) {
    let Some(id) = p.best_effort else { return };
    let Some(mut channel) = p.rtc.channel(id) else { return };
    match channel.write(true, bytes) {
        Ok(true) => {}
        Ok(false) => p.missed = true,
        Err(e) => warn!("a message for screen {} did not go: {e}", p.session),
    }
}

/// Writes a frame of an import's video to the screen, where it plays it. A late one is left
/// out, and the video waits for a keyframe, since nothing after a gap decodes until one.
fn write(p: &mut Peer, alias: &str, keyframe: bool, pts: i64, data: &Arc<[u8]>, late: bool) {
    if !p.connected {
        return;
    }
    for v in p.videos.iter_mut().filter(|v| v.alias == alias && (v.started || keyframe)) {
        if late {
            if std::mem::take(&mut v.started) {
                warn!("frames of {alias} came late for screen {}, so its video goes on from the next keyframe", p.session);
            }
            continue;
        }
        let Some(writer) = p.rtc.writer(v.mid) else { continue };
        let Some(pt) = v.pt.or_else(|| h264(&writer)) else { continue };
        v.pt = Some(pt);
        v.started = true;
        if let Err(e) = writer.write(pt, Instant::now(), MediaTime::from_micros(pts.max(0) as u64), data.clone()) {
            warn!("a frame for screen {} ({alias}) did not go: {e}", p.session);
        }
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

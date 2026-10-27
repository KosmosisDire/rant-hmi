//! WebRTC for screens' video, set up over each screen's socket. A screen opens one connection
//! once it plays a video, which carries the video of each import it plays and works on a plain
//! http page where WebCodecs cannot. Once its reliable `link` channel opens, the screen's
//! lanes go there in place of its socket (`Lanes`, as a socket sends them), since that way is
//! direct where the socket may come through a proxy. Pongs and small values go whole on its
//! reliable unordered `small` channel: SCTP sends a message of that before any ordered one
//! waiting, so none waits behind the pieces of a picture, and a packet of the `link` channel
//! lost on the way never holds it. Each H264 frame of an import's source goes out
//! to the screens playing it here as it comes. A screen without WebRTC decodes its video itself
//! from frames on its socket (`Lanes::video`).

use std::collections::{HashMap, HashSet};
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
use tokio::sync::Notify;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tracing::{debug, info, warn};

use crate::flight::Flight;
use crate::lanes::{Lanes, VALUES};
use crate::project::IceServer;
use crate::protocol::{ClientMsg, Played};
use crate::stun;

/// A frame that came off the mesh longer ago than this is dropped, and its video goes on from the
/// next keyframe, so a busy backend or a slow socket makes video late by this at most, and never
/// what screens send and get.
pub const FRAME_LATE: Duration = Duration::from_millis(200);

/// The labels of the channel a screen's lanes go on, and of the unordered one its pongs and
/// small values go on whole.
pub const LINK: &str = "link";
pub const SMALL: &str = "small";

/// The most the link channel holds unacknowledged, sent or not, as SCTP counts it. The marks'
/// flight keeps what is on the way to the link's round trip, so this only bounds a link the
/// flight has not measured yet: a far one needs its round trip's worth on the way.
const LINK_BUFFERED: usize = 2 << 20;

/// The lane of a mark on the link channel: `[u16 MARK]` then a flight's ping, which the page
/// sends back at once as `[0xFF]` then the ping, so the channel keeps on the way what the link
/// carries in its round trip, as a socket does (`flight.rs`), not all SCTP's window lets out.
pub const MARK: u16 = 0xFFFF;
const MARK_BACK: u8 = 0xFF;

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
    /// A screen offers its connection with the videos it plays now, which makes the connection
    /// when it has none. `local` is the address the screen reached the HMI on, which a new
    /// connection offers first, and `ice` the servers that tell what a NAT shows the outside of
    /// this host.
    Play { session: u32, sdp: String, videos: Vec<Played>, local: IpAddr, ice: Vec<IceServer> },
    /// An address the screen found its connection may be reached on.
    Candidate { session: u32, candidate: String },
    /// The screen's connection broke, or the screen is gone, so it ends.
    Unlink { session: u32 },
}

pub enum FromRtc {
    /// The answer to a screen's offer, none when it could not be taken.
    Answer { session: u32, sdp: Option<String> },
    /// A screen's connection opened, or closed.
    Linked { session: u32, open: bool },
    /// An address of this host a screen's connection may be reached on, found after its answer.
    Candidate { session: u32, candidate: String },
    /// The screen's link channel opened, which sends what these lanes carry until they close.
    Channel { session: u32, lanes: Arc<Lanes> },
    /// What the screen sent on its link channel.
    Message { session: u32, msg: ClientMsg },
    /// The screen's link channel closed, or its connection with it.
    ChannelClosed { session: u32 },
}

/// A screen's link channel and the lanes it sends.
struct Link {
    id: ChannelId,
    lanes: Arc<Lanes>,
    flight: Flight,
    born: Instant,
    /// A piece the channel would not take yet, which goes before any other, as a message
    /// missing one never joins.
    held: Option<Bytes>,
    /// The lanes whose message is part way through its pieces, which all go ordered.
    mid: HashSet<u16>,
}

impl Link {
    fn now(&self) -> u64 {
        self.born.elapsed().as_micros() as u64
    }
}

/// A screen's connection.
struct Peer {
    session: u32,
    rtc: Rtc,
    wake: Instant,
    connected: bool,
    videos: Vec<Video>,
    link: Option<Link>,
    /// Its unordered channel for pongs and small values, while open.
    small: Option<ChannelId>,
    /// The channels the page's probe times this way on (`probe.rs`), each echoed.
    probes: Vec<ChannelId>,
}

struct Video {
    alias: String,
    mid: Mid,
    pt: Option<Pt>,
    /// Frames start at a keyframe, since nothing before one decodes.
    started: bool,
}

impl Peer {
    /// Takes the screen's offer again with the videos it plays now.
    fn play(&mut self, sdp: &str, videos: Vec<Played>) -> Result<String, String> {
        let answer = accept(&mut self.rtc, sdp)?;
        self.take(videos);
        Ok(answer)
    }

    /// Plays these videos from now. A video playing on where it did goes on from the frame it
    /// is at.
    fn take(&mut self, videos: Vec<Played>) {
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
    // a link channel's lanes have something to send
    let kick = Arc::new(Notify::new());
    loop {
        let wake = peers.iter().map(|p| p.wake).min().unwrap_or_else(|| Instant::now() + Duration::from_secs(60));
        // frames go last, so they wait behind what screens send and get, never the other way
        tokio::select! {
            biased;
            r = requests.recv() => match r {
                None => return,
                Some(ToRtc::Play { session, sdp, videos, local, ice }) => {
                    let answer = match peers.iter_mut().find(|p| p.session == session) {
                        Some(p) => p.play(&sdp, videos),
                        None => {
                            let ips = addresses(local, reach.loopback);
                            open(&mut ports, &ips, &reach, &arrived).await;
                            ask(&mut ports, &mut asking, &mut servers, &ice);
                            // str0m refuses a write past its own bound, 128 KB at first, so it is set past the link's,
                            // with room for the probe's channels
                            let config = RtcConfig::new().clear_codecs().enable_h264(true).set_sctp_max_buffered_amount(LINK_BUFFERED + (256 << 10));
                            answer(&ports, &ips, config, &sdp).map(|(rtc, sdp)| {
                                info!("screen {session} opens its WebRTC connection");
                                let mut p = Peer { session, rtc, wake: Instant::now(), connected: false, videos: Vec::new(), link: None, small: None, probes: Vec::new() };
                                p.take(videos);
                                peers.push(p);
                                sdp
                            })
                        }
                    };
                    if let Err(text) = &answer {
                        warn!("screen {session} could not play its videos over WebRTC: {text}");
                    }
                    let _ = said.send(FromRtc::Answer { session, sdp: answer.ok() });
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
                Some(ToRtc::Unlink { session }) => close(&mut peers, &said, |p| p.session == session),
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
            _ = kick.notified() => {}
            Some(Frame { alias, keyframe, pts, data, at }) = frames.recv() => {
                let late = at.elapsed() > FRAME_LATE;
                let data: Arc<[u8]> = Arc::from(&data[..]);
                for p in &mut peers {
                    write(p, &alias, keyframe, pts, &data, late);
                }
            }
        }
        for p in &mut peers {
            drive(p, &ports, &said, &kick).await;
            if send_link(p) {
                drive(p, &ports, &said, &kick).await;
            }
        }
        close(&mut peers, &said, |p| !p.rtc.is_alive());
    }
}

/// Drops the connections `gone` picks, telling the loop each screen lost its connection.
fn close(peers: &mut Vec<Peer>, said: &UnboundedSender<FromRtc>, gone: impl Fn(&Peer) -> bool) {
    for p in peers.iter().filter(|p| gone(p)) {
        if p.link.is_some() {
            let _ = said.send(FromRtc::ChannelClosed { session: p.session });
        }
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
async fn drive(p: &mut Peer, ports: &HashMap<IpAddr, Port>, said: &UnboundedSender<FromRtc>, kick: &Arc<Notify>) {
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
            Ok(Output::Event(e)) => match e {
                Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                    p.rtc.disconnect();
                    return;
                }
                Event::Connected => {
                    p.connected = true;
                    info!("screen {} has its WebRTC connection", p.session);
                    let _ = said.send(FromRtc::Linked { session: p.session, open: true });
                }
                Event::ChannelOpen(id, label) if label == LINK => {
                    let lanes = Arc::new(Lanes::default());
                    tokio::spawn(wake_on(lanes.clone(), kick.clone()));
                    p.link = Some(Link { id, lanes: lanes.clone(), flight: Flight::default(), born: Instant::now(), held: None, mid: HashSet::new() });
                    info!("screen {} opened its link channel", p.session);
                    let _ = said.send(FromRtc::Channel { session: p.session, lanes });
                }
                Event::ChannelOpen(id, label) if label == SMALL => p.small = Some(id),
                Event::ChannelOpen(id, label) if label.starts_with("probe") => p.probes.push(id),
                Event::ChannelData(d) if d.data.first() == Some(&MARK_BACK) && p.link.as_ref().is_some_and(|l| l.id == d.id) => {
                    if let Some(link) = &mut p.link {
                        let now = link.now();
                        link.flight.pong(&d.data[1..], now);
                    }
                }
                Event::ChannelData(d) if p.link.as_ref().is_some_and(|l| l.id == d.id) => match ciborium::from_reader::<ClientMsg, _>(&d.data[..]) {
                    Ok(msg) => {
                        let _ = said.send(FromRtc::Message { session: p.session, msg });
                    }
                    Err(e) => warn!("screen {} sent on its link channel what this backend cannot read: {e}", p.session),
                },
                // the page's probe (probe.rs) times this way by its echo
                Event::ChannelData(d) if p.probes.contains(&d.id) => {
                    if let Some(mut ch) = p.rtc.channel(d.id) {
                        let _ = ch.write(d.binary, &d.data);
                    }
                }
                Event::ChannelClose(id) if p.link.as_ref().is_some_and(|l| l.id == id) => {
                    p.link = None;
                    info!("screen {} closed its link channel", p.session);
                    let _ = said.send(FromRtc::ChannelClosed { session: p.session });
                }
                // the link channel carries them until it opens again
                Event::ChannelClose(id) if p.small == Some(id) => p.small = None,
                _ => {}
            },
            Err(e) => {
                warn!("the connection of screen {} failed: {e}", p.session);
                p.rtc.disconnect();
                return;
            }
        }
    }
}

/// Writes what the link's lanes have while the channel holds less than LINK_BUFFERED unsent,
/// a whole message of pongs or small values on the unordered channel while that is open, true
/// when it wrote any. Lanes the loop closed close the channel.
fn send_link(p: &mut Peer) -> bool {
    let Some(link) = &p.link else { return false };
    if link.lanes.closed() {
        let id = link.id;
        p.rtc.direct_api().close_data_channel(id);
        p.link = None;
        return true;
    }
    let Some(link) = &mut p.link else { return false };
    let mut wrote = false;
    loop {
        let now = link.now();
        // a piece went since the last mark, so a mark at once, whose echo says it arrived
        let piece = if let Some(piece) = link.held.take() {
            piece
        } else if link.flight.ask() {
            let mut mark = MARK.to_le_bytes().to_vec();
            mark.extend_from_slice(&link.flight.ping(now));
            mark.into()
        } else {
            let Some(piece) = link.lanes.take(link.flight.room()) else { break };
            piece
        };
        let lane = u16::from_le_bytes([piece[0], piece[1]]);
        let more = lane != MARK && piece[2] == 1;
        let whole = lane == VALUES && !more && !link.mid.contains(&lane);
        let id = match p.small {
            Some(small) if whole => small,
            _ => link.id,
        };
        // a channel just closed keeps the piece for the next turn, which routes it again
        let taken = p.rtc.channel(id).is_some_and(|mut ch| ch.buffered_amount() < LINK_BUFFERED && matches!(ch.write(true, &piece), Ok(true)));
        if !taken {
            debug!("the link channel of screen {} took no piece yet", p.session);
            link.held = Some(piece);
            break;
        }
        if id == link.id && lane != MARK {
            link.flight.wrote(piece.len());
        }
        if lane != MARK {
            match more {
                true => link.mid.insert(lane),
                false => link.mid.remove(&lane),
            };
        }
        wrote = true;
    }
    wrote
}

/// Kicks the task each time `lanes` have something new, until they close.
async fn wake_on(lanes: Arc<Lanes>, kick: Arc<Notify>) {
    while !lanes.closed() {
        lanes.ready().await;
        kick.notify_one();
    }
    kick.notify_one();
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

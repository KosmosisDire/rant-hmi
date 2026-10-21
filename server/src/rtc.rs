//! WebRTC for screens, set up over each screen's socket. A screen has one connection: a
//! reliable ordered channel and a best effort one, which carry its messages where they open,
//! and the video of each import it plays, which works on a plain http page where WebCodecs
//! cannot. Each H264 frame of an import's source goes out to the screens playing it as it comes.

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

use crate::protocol::{ClientMsg, Played};

/// The labels a screen gives its two channels.
pub const RELIABLE: &str = "reliable";
pub const BEST_EFFORT: &str = "best-effort";

/// A message bigger than this goes over the socket. Losing any of its packets loses all of it
/// on the best effort channel, and on the reliable one it holds back what comes after.
pub const MESSAGE_MAX: usize = 16 * 1024;

/// A screen that missed messages, its channels full, gets everything again once one drains
/// below this. Full is str0m's 128 KiB for the two together.
const DRAINED: usize = 32 * 1024;

/// A frame that waited longer than this for the task is dropped, and its video goes on from the
/// next keyframe, so a busy backend makes video late but never what screens send and get.
const FRAME_LATE: Duration = Duration::from_millis(200);

/// One H264 frame of an import's video, in Annex B as the mesh carries it.
pub struct Frame {
    pub alias: String,
    pub keyframe: bool,
    /// When to show it, in microseconds.
    pub pts: i64,
    pub data: Vec<u8>,
    /// When it came off the mesh.
    pub at: Instant,
}

pub enum ToRtc {
    /// A screen offers its data connection, which replaces any it had. `local` is the address
    /// the screen reached the HMI on, so the connection comes from there too.
    Channels { session: u32, sdp: String, local: IpAddr },
    /// A screen offers its data connection again with the videos it plays now.
    Play { session: u32, sdp: String, videos: Vec<Played> },
    /// The screen's channels broke, or the screen is gone, so its connection ends.
    Unlink { session: u32 },
    /// A message for a screen, on its reliable channel or its best effort one. It is left out
    /// while the channels are full.
    Send { session: u32, reliable: bool, bytes: Bytes },
}

pub enum FromRtc {
    /// The answer to a screen's offer, none when it could not be taken.
    Channels { session: u32, sdp: Option<String> },
    /// Both of a screen's channels opened, or one of them or the whole connection closed.
    Linked { session: u32, open: bool },
    /// What a screen sent on a channel.
    Message { session: u32, msg: ClientMsg },
    /// A screen's channels drained after it missed messages, so it needs them all.
    CaughtUp { session: u32 },
}

/// A screen's connection.
struct Peer {
    session: u32,
    rtc: Rtc,
    socket: Arc<UdpSocket>,
    wake: Instant,
    connected: bool,
    reliable: Option<ChannelId>,
    best_effort: Option<ChannelId>,
    /// Messages were left out while the channels were full.
    missed: bool,
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

/// Starts the task that owns every connection. The loop's requests go in through the first
/// sender and video frames through the second. Answers and what screens send come back
/// through `said`.
pub fn start(said: UnboundedSender<FromRtc>) -> (UnboundedSender<ToRtc>, UnboundedSender<Frame>) {
    str0m::crypto::from_feature_flags().install_process_default();
    let (tx, rx) = unbounded_channel();
    let (frames_tx, frames) = unbounded_channel();
    tokio::spawn(run(rx, frames, said));
    (tx, frames_tx)
}

async fn run(mut requests: UnboundedReceiver<ToRtc>, mut frames: UnboundedReceiver<Frame>, said: UnboundedSender<FromRtc>) {
    let (arrived, mut packets) = unbounded_channel::<Packet>();
    let mut sockets: HashMap<IpAddr, Arc<UdpSocket>> = HashMap::new();
    let mut peers: Vec<Peer> = Vec::new();
    loop {
        let wake = peers.iter().map(|p| p.wake).min().unwrap_or_else(|| Instant::now() + Duration::from_secs(60));
        // frames go last, so they wait behind what screens send and get, never the other way
        tokio::select! {
            biased;
            r = requests.recv() => match r {
                None => return,
                Some(ToRtc::Channels { session, sdp, local }) => {
                    close(&mut peers, &said, |p| p.session == session);
                    // ice lite: the screen finds this end, so its own hidden addresses never matter
                    let config = RtcConfig::new().set_ice_lite(true).clear_codecs().enable_h264(true);
                    let sdp = match answer(&mut sockets, &arrived, config, &sdp, local).await {
                        Ok((rtc, socket, sdp)) => {
                            info!("screen {session} opens its data connection on {}", socket.local_addr().map_or_else(|_| local.to_string(), |a| a.to_string()));
                            peers.push(Peer { session, rtc, socket, wake: Instant::now(), connected: false, reliable: None, best_effort: None, missed: false, videos: Vec::new() });
                            Some(sdp)
                        }
                        Err(text) => {
                            warn!("screen {session} stays on its socket: {text}");
                            None
                        }
                    };
                    let _ = said.send(FromRtc::Channels { session, sdp });
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
                Some(ToRtc::Send { session, reliable, bytes }) => {
                    if let Some(p) = peers.iter_mut().find(|p| p.session == session) {
                        put(p, reliable, &bytes);
                    }
                }
            },
            Some((local, source, data)) = packets.recv() => {
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
                let data: Arc<[u8]> = data.into();
                for p in &mut peers {
                    write(p, &alias, keyframe, pts, &data, late);
                }
            }
        }
        for p in &mut peers {
            drive(p, &said).await;
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
    let answer = accept(&mut rtc, sdp)?;
    Ok((rtc, socket, answer))
}

fn accept(rtc: &mut Rtc, sdp: &str) -> Result<String, String> {
    let offer = SdpOffer::from_sdp_string(sdp).map_err(|e| format!("the screen's offer did not read: {e}"))?;
    let answer = rtc.sdp_api().accept_offer(offer).map_err(|e| format!("the screen's offer was refused: {e}"))?;
    Ok(answer.to_sdp_string())
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

/// Writes a message on one of a screen's channels, or leaves it out while they are full.
fn put(p: &mut Peer, reliable: bool, bytes: &[u8]) {
    let Some(id) = (if reliable { p.reliable } else { p.best_effort }) else { return };
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

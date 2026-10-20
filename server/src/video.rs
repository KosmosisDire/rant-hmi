//! Video for screens over WebRTC, which plays on a plain http page where WebCodecs cannot. A
//! screen gets one connection per import it plays, set up over its socket, and each H264
//! frame of the import's source goes out to it as it comes.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use str0m::change::SdpOffer;
use str0m::format::Codec;
use str0m::media::{MediaTime, Mid, Pt, Writer};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};
use tokio::net::UdpSocket;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tracing::{info, warn};

/// One H264 frame of an import's video, in Annex B as the mesh carries it.
pub struct Frame {
    pub alias: String,
    pub keyframe: bool,
    /// When to show it, in microseconds.
    pub pts: i64,
    pub data: Vec<u8>,
}

pub enum ToVideo {
    /// A screen offers to play an import. `local` is the address the screen reached the HMI
    /// on, so its media comes from there too.
    Offer { session: u32, alias: String, sdp: String, local: IpAddr },
    Stop { session: u32, alias: String },
    /// The screen is gone, and so is all it played.
    Gone { session: u32 },
    Frame(Frame),
}

pub enum FromVideo {
    Answer { session: u32, alias: String, sdp: String },
    Failed { session: u32, alias: String, text: String },
}

struct Peer {
    session: u32,
    alias: String,
    rtc: Rtc,
    socket: Arc<UdpSocket>,
    mid: Option<Mid>,
    pt: Option<Pt>,
    connected: bool,
    /// Frames start at a keyframe, since nothing before one decodes.
    started: bool,
    wake: Instant,
}

/// A datagram one of the sockets took: the address it came to, where from, and its bytes.
type Packet = (SocketAddr, SocketAddr, Vec<u8>);

/// Starts the task that owns every connection. Frames and the loop's requests go in through
/// the sender, answers come back through `answers`.
pub fn start(answers: UnboundedSender<FromVideo>) -> UnboundedSender<ToVideo> {
    str0m::crypto::from_feature_flags().install_process_default();
    let (tx, rx) = unbounded_channel();
    tokio::spawn(run(rx, answers));
    tx
}

async fn run(mut requests: UnboundedReceiver<ToVideo>, answers: UnboundedSender<FromVideo>) {
    let (arrived, mut packets) = unbounded_channel::<Packet>();
    let mut sockets: HashMap<IpAddr, Arc<UdpSocket>> = HashMap::new();
    let mut peers: Vec<Peer> = Vec::new();
    loop {
        let wake = peers.iter().map(|p| p.wake).min().unwrap_or_else(|| Instant::now() + Duration::from_secs(60));
        tokio::select! {
            r = requests.recv() => match r {
                None => return,
                Some(ToVideo::Offer { session, alias, sdp, local }) => {
                    peers.retain(|p| !(p.session == session && p.alias == alias));
                    match offer(&mut sockets, &arrived, session, &alias, &sdp, local).await {
                        Ok((peer, answer)) => {
                            peers.push(peer);
                            let _ = answers.send(FromVideo::Answer { session, alias, sdp: answer });
                        }
                        Err(text) => {
                            let _ = answers.send(FromVideo::Failed { session, alias, text });
                        }
                    }
                }
                Some(ToVideo::Stop { session, alias }) => peers.retain(|p| !(p.session == session && p.alias == alias)),
                Some(ToVideo::Gone { session }) => peers.retain(|p| p.session != session),
                Some(ToVideo::Frame(f)) => {
                    let data: Arc<[u8]> = f.data.into();
                    for p in peers.iter_mut().filter(|p| p.alias == f.alias) {
                        write(p, f.keyframe, f.pts, &data);
                    }
                }
            },
            Some((local, source, data)) = packets.recv() => {
                let Ok(contents) = data.as_slice().try_into() else { continue };
                let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: local, contents });
                if let Some(p) = peers.iter_mut().find(|p| p.rtc.accepts(&input)) {
                    if let Err(e) = p.rtc.handle_input(input) {
                        warn!("video for screen {} ({}) failed: {e}", p.session, p.alias);
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
            drive(p).await;
        }
        peers.retain(|p| p.rtc.is_alive());
    }
}

/// Answers a screen's offer, on a socket bound to the address the screen reached the HMI on.
async fn offer(sockets: &mut HashMap<IpAddr, Arc<UdpSocket>>, arrived: &UnboundedSender<Packet>, session: u32, alias: &str, sdp: &str, local: IpAddr) -> Result<(Peer, String), String> {
    let socket = match sockets.get(&local) {
        Some(s) => s.clone(),
        None => {
            let s = bind(local, arrived.clone()).await.map_err(|e| format!("could not open a port for video on {local}: {e}"))?;
            sockets.insert(local, s.clone());
            s
        }
    };
    let now = Instant::now();
    // ice lite: the screen finds this end, so its own hidden addresses never matter
    let mut rtc = RtcConfig::new().set_ice_lite(true).clear_codecs().enable_h264(true).build(now);
    let address = socket.local_addr().map_err(|e| e.to_string())?;
    let candidate = Candidate::host(address, "udp").map_err(|e| e.to_string())?;
    rtc.add_local_candidate(candidate);
    let offer = SdpOffer::from_sdp_string(sdp).map_err(|e| format!("the screen's offer did not read: {e}"))?;
    let answer = rtc.sdp_api().accept_offer(offer).map_err(|e| format!("the screen's offer was refused: {e}"))?;
    info!("screen {session} plays {alias} from {address}");
    let peer = Peer { session, alias: alias.to_owned(), rtc, socket, mid: None, pt: None, connected: false, started: false, wake: now };
    Ok((peer, answer.to_sdp_string()))
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
                    warn!("the video port on {local} stopped: {e}");
                    return;
                }
            }
        }
    });
    Ok(socket)
}

/// Sends what the connection has to send and learns when it next needs a turn.
async fn drive(p: &mut Peer) {
    loop {
        match p.rtc.poll_output() {
            Ok(Output::Timeout(t)) => {
                p.wake = t;
                return;
            }
            Ok(Output::Transmit(t)) => {
                let _ = p.socket.send_to(&t.contents, t.destination).await;
            }
            Ok(Output::Event(e)) => match e {
                Event::MediaAdded(m) => p.mid = Some(m.mid),
                Event::Connected => p.connected = true,
                Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                    p.rtc.disconnect();
                    return;
                }
                _ => {}
            },
            Err(e) => {
                warn!("video for screen {} ({}) failed: {e}", p.session, p.alias);
                p.rtc.disconnect();
                return;
            }
        }
    }
}

fn write(p: &mut Peer, keyframe: bool, pts: i64, data: &Arc<[u8]>) {
    if !p.connected || !(p.started || keyframe) {
        return;
    }
    let Some(writer) = p.mid.and_then(|mid| p.rtc.writer(mid)) else { return };
    let Some(pt) = p.pt.or_else(|| h264(&writer)) else { return };
    p.pt = Some(pt);
    p.started = true;
    if let Err(e) = writer.write(pt, Instant::now(), MediaTime::from_micros(pts.max(0) as u64), data.clone()) {
        warn!("a frame for screen {} ({}) did not go: {e}", p.session, p.alias);
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

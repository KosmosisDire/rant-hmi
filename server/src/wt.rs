//! A page on https takes its big values over WebTransport, on the HMI's port over UDP: the
//! lanes and the `took` of its second socket, each message on a stream of its own. Its brief
//! certificate is its own, as a page trusts one by its hash for two weeks at most, and each hello
//! gives that hash. Its congestion control keeps on the way what the socket's window does.

use std::any::Any;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use quinn_proto::RttEstimator;
use tokio::sync::mpsc::UnboundedSender;
use tracing::{debug, info, warn};
use wtransport::config::QuicTransportConfig;
use wtransport::endpoint::IncomingSession;
use wtransport::quinn::congestion::{Controller, ControllerFactory};
use wtransport::tls::{Certificate, CertificateChain, PrivateKey};
use wtransport::{Connection, Endpoint, Identity, SendStream, ServerConfig};

use crate::app::{Door, Inbound};
use crate::flight::Flight;
use crate::lanes::Lanes;
use crate::tls;
use crate::web::{self, Second};

/// How often the certificate is made anew, well before its end.
const RENEW: Duration = Duration::from_secs(7 * 24 * 3600);
/// The most a page's stream may bring, as each says only that it took a value.
const TOOK_MOST: usize = 4096;

/// Serves WebTransport at `at`, telling `hashes` each certificate's hash as it begins.
pub async fn serve(at: SocketAddr, door: Door, hashes: UnboundedSender<String>) {
    let Some((identity, hash)) = brief() else { return };
    let server = match Endpoint::server(config(at, identity)) {
        Ok(server) => server,
        Err(e) => return warn!("serving no WebTransport on udp {at}: {e}"),
    };
    info!("WebTransport on udp {at}");
    let _ = hashes.send(hash);
    let mut renew = tokio::time::interval_at(tokio::time::Instant::now() + RENEW, RENEW);
    loop {
        tokio::select! {
            incoming = server.accept() => {
                tokio::spawn(session(incoming, door.clone()));
            }
            _ = renew.tick() => {
                let Some((identity, hash)) = brief() else { continue };
                // a session open already keeps the certificate it began with
                match server.reload_config(config(at, identity), false) {
                    Ok(()) => {
                        let _ = hashes.send(hash);
                    }
                    Err(e) => warn!("WebTransport keeps its old certificate: {e}"),
                }
            }
        }
    }
}

/// A new brief certificate, and its SHA-256 in hex as a page takes it.
fn brief() -> Option<(Identity, String)> {
    let made = tls::brief().and_then(|(cert, key)| Ok(Identity::new(CertificateChain::single(Certificate::from_der(cert)?), PrivateKey::from_der_pkcs8(key))));
    match made {
        Ok(identity) => {
            let hash = identity.certificate_chain().as_slice()[0].hash().as_ref().iter().map(|b| format!("{b:02x}")).collect();
            Some((identity, hash))
        }
        Err(e) => {
            warn!("serving no WebTransport, as its certificate failed: {e:#}");
            None
        }
    }
}

fn config(at: SocketAddr, identity: Identity) -> ServerConfig {
    let mut transport = QuicTransportConfig::default();
    transport.congestion_controller_factory(Arc::new(FlightControl::default()));
    ServerConfig::builder().with_bind_address(at).with_custom_transport(identity, transport).keep_alive_interval(Some(Duration::from_secs(3))).build()
}

/// One screen's session, which its address names as the second socket's does. It ends when
/// the page closes it, or when the loop lets its lanes go.
async fn session(incoming: IncomingSession, door: Door) {
    let Ok(request) = incoming.await else { return };
    let Some(second) = request.path().strip_prefix("/bulk?").and_then(|q| serde_urlencoded::from_str::<Second>(q).ok()) else {
        debug!("a WebTransport session at {} named no screen", request.path());
        return request.not_found().await;
    };
    let session = second.session;
    let lanes = Arc::new(Lanes::default());
    if !second.open(&door, &lanes).await {
        debug!("screen {session} opened WebTransport with a key not its own");
        return request.forbidden().await;
    }
    if let Ok(conn) = request.accept().await {
        debug!("screen {session} opened WebTransport");
        tokio::select! {
            _ = write(&conn, &lanes) => {}
            _ = read(&conn, &door, session) => {}
        }
    }
    door.send(Inbound::BulkClosed { session, lanes });
}

/// Sends each message of `lanes` on a stream of its own, its pieces without their heads, as the
/// stream's end is the message's. A page that reads slowly holds the writes, as on the socket.
async fn write(conn: &Connection, lanes: &Lanes) {
    let mut open: HashMap<u16, SendStream> = HashMap::new();
    loop {
        let piece = tokio::select! {
            piece = lanes.next(true) => piece,
            _ = conn.closed() => None,
        };
        let Some(piece) = piece else { break };
        let lane = u16::from_le_bytes([piece[0], piece[1]]);
        let more = piece[2] == 1;
        let mut stream = match open.remove(&lane) {
            Some(stream) => stream,
            None => match conn.open_uni().await {
                Ok(opening) => match opening.await {
                    Ok(stream) => stream,
                    Err(_) => break,
                },
                Err(_) => break,
            },
        };
        if stream.write_all(&piece[3..]).await.is_err() {
            break;
        }
        if more {
            open.insert(lane, stream);
        } else {
            // finishing waits for the page's ack, which the next message need not
            tokio::spawn(async move {
                let _ = stream.finish().await;
            });
        }
    }
}

/// Hears each stream the page opens, each a message that it took a value.
async fn read(conn: &Connection, door: &Door, session: u32) {
    while let Ok(mut stream) = conn.accept_uni().await {
        match stream.quic_stream_mut().read_to_end(TOOK_MOST).await {
            Ok(data) => web::took(door, session, &data),
            Err(e) => debug!("screen {session} sent a stream that did not read: {e}"),
        }
    }
}

/// Keeps on the way what the socket's window does (`flight.rs`): the link's rate over its
/// shortest round trip and a margin, so nothing waits in the link's buffers. A loss is the
/// link's, not a sign to slow, as nothing piles up to overflow.
#[derive(Clone, Default)]
struct FlightControl {
    born: Option<Instant>,
    flight: Flight,
    confirmed: u64,
    /// When the newest packet acked so far left.
    left: Option<Instant>,
}

impl FlightControl {
    fn us(&self, t: Instant) -> u64 {
        self.born.map_or(0, |born| t.saturating_duration_since(born).as_micros() as u64)
    }
}

impl ControllerFactory for FlightControl {
    fn build(self: Arc<Self>, now: Instant, _mtu: u16) -> Box<dyn Controller> {
        Box::new(FlightControl { born: Some(now), ..FlightControl::default() })
    }
}

impl Controller for FlightControl {
    fn on_ack(&mut self, _now: Instant, sent: Instant, bytes: u64, _app_limited: bool, rtt: &RttEstimator) {
        self.confirmed += bytes;
        self.left = self.left.max(Some(sent));
        self.flight.trip(rtt.min().as_micros() as u64);
    }

    // QUIC's pacer may hold sends below the window, so the way is full whenever the sender had
    // more to send than it let go
    fn on_end_acks(&mut self, now: Instant, _in_flight: u64, app_limited: bool, _largest: Option<u64>) {
        let left = self.us(self.left.unwrap_or(now));
        let now = self.us(now);
        self.flight.acked(self.confirmed, left, !app_limited, now);
    }

    fn on_congestion_event(&mut self, _now: Instant, _sent: Instant, _persistent: bool, _lost: u64) {}

    fn on_mtu_update(&mut self, _mtu: u16) {}

    fn window(&self) -> u64 {
        self.flight.window()
    }

    fn clone_box(&self) -> Box<dyn Controller> {
        Box::new(self.clone())
    }

    fn initial_window(&self) -> u64 {
        self.flight.window()
    }

    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }
}

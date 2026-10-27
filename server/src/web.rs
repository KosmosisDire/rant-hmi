//! HTTP and WebSocket: the built client from one folder, one socket per screen at `/ws`, and
//! a second at `/bulk` that brings it its big values, plain or over TLS on the one port. A page
//! on https takes its big values over WebTransport instead (`wt.rs`).

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{Json, Router};
use axum::body::Bytes;
use axum::extract::connect_info::Connected;
use axum::extract::{ConnectInfo, Query, State};
use axum::serve::{IncomingStream, Listener};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{MissedTickBehavior, interval, timeout};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;
use tokio_util::either::Either;
use axum::http::{HeaderMap, HeaderValue, header};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeader;
use tracing::{debug, error, warn};

use crate::app::{Door, Inbound, Outbox};
use crate::apps::{self, Apps};
use crate::flight::Flight;
use crate::lanes::Lanes;
use crate::protocol::ClientMsg;

/// How often the socket pings its screen, to hear what arrived and that it is there. The
/// browser answers by itself, even in a hidden tab whose timers run slow, so a screen is lost
/// only when its link is.
pub const PING_EVERY: Duration = Duration::from_millis(50);

/// The built client's files, index.html for any path that names none.
pub type Files = SetResponseHeader<ServeDir<ServeFile>, HeaderValue>;

pub fn files(client: &Path) -> Files {
    let pages = ServeDir::new(client).fallback(ServeFile::new(client.join("index.html")));
    // a screen asks again each time, so after an update it loads the new client
    SetResponseHeader::overriding(pages, header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))
}

/// Serves on `listener`, https too for a connection that opens with a TLS hello when `tls`
/// answers one.
pub async fn serve(listener: TcpListener, tls: Option<TlsAcceptor>, client: &Path, door: Door, apps: Apps) {
    let port = listener.local_addr().map_or(0, |a| a.port());
    let app = Router::new().route("/ws", get(upgrade)).route("/bulk", get(upgrade_bulk)).route("/problems", get(problems)).with_state(door).merge(apps::router(apps)).merge(crate::probe::router(port)).fallback_service(files(client));
    let front = Front::open(listener, tls);
    if let Err(e) = axum::serve(front, app.into_make_service_with_connect_info::<Reached>()).await {
        error!("the web server stopped: {e}");
    }
}

/// A connection, plain or past its TLS hello.
type Conn = Either<TcpStream, TlsStream<TcpStream>>;

/// How long a connection may take to say which it is and finish its hello.
const OPENING: Duration = Duration::from_secs(30);

/// The connections ready to serve. Each opens in a task of its own, so a slow hello holds no
/// other.
struct Front {
    ready: mpsc::Receiver<(Conn, SocketAddr)>,
    local: SocketAddr,
}

impl Front {
    fn open(mut listener: TcpListener, tls: Option<TlsAcceptor>) -> Front {
        let local = listener.local_addr().unwrap_or_else(|_| SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)));
        let (ready, rx) = mpsc::channel(64);
        tokio::spawn(async move {
            loop {
                let (io, addr) = Listener::accept(&mut listener).await;
                // Nagle's wait for an ack would hold a small message, a ping or a value, until
                // the screen's delayed ack, up to tens of ms
                if let Err(e) = io.set_nodelay(true) {
                    warn!("could not send at once to {addr}: {e}");
                }
                let (ready, tls) = (ready.clone(), tls.clone());
                tokio::spawn(async move {
                    match timeout(OPENING, opened(io, tls)).await {
                        Ok(Ok(conn)) => {
                            let _ = ready.send((conn, addr)).await;
                        }
                        // a browser that does not trust the certificate hangs up mid hello
                        Ok(Err(e)) => debug!("{addr} did not finish its TLS hello: {e}"),
                        Err(_) => debug!("{addr} said nothing"),
                    }
                });
            }
        });
        Front { ready: rx, local }
    }
}

/// `io` as it opens: over TLS when its first byte begins a TLS hello and `tls` answers it.
async fn opened(io: TcpStream, tls: Option<TlsAcceptor>) -> io::Result<Conn> {
    const HANDSHAKE: u8 = 0x16;
    let mut first = [0u8; 1];
    match tls {
        Some(tls) if io.peek(&mut first).await? == 1 && first[0] == HANDSHAKE => Ok(Either::Right(tls.accept(io).await?)),
        _ => Ok(Either::Left(io)),
    }
}

impl Listener for Front {
    type Io = Conn;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Conn, SocketAddr) {
        match self.ready.recv().await {
            Some(ready) => ready,
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        Ok(self.local)
    }
}

/// The address a screen reached this host on, which it can reach again for video, and the
/// address it came from.
#[derive(Clone, Copy)]
struct Reached {
    local: IpAddr,
    remote: IpAddr,
}

impl Connected<IncomingStream<'_, Front>> for Reached {
    fn connect_info(stream: IncomingStream<'_, Front>) -> Reached {
        let tcp = match stream.io() {
            Either::Left(tcp) => tcp,
            Either::Right(tls) => tls.get_ref().0,
        };
        let local = tcp.local_addr().map_or(IpAddr::V4(Ipv4Addr::LOCALHOST), |a| a.ip().to_canonical());
        Reached { local, remote: stream.remote_addr().ip().to_canonical() }
    }
}

/// Every screen's problems and those runs on the system met, as JSON, for a person or an agent
/// to read.
async fn problems(State(door): State<Door>) -> Response {
    match door.problems().await {
        Some(list) => Json(list).into_response(),
        None => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

async fn upgrade(ws: WebSocketUpgrade, State(door): State<Door>, ConnectInfo(mut reached): ConnectInfo<Reached>, headers: HeaderMap) -> Response {
    if let Some(from) = forwarded(&reached, &headers) {
        reached.remote = from;
    }
    ws.on_upgrade(move |socket| screen(socket, door, reached))
}

/// Where a screen that came through a proxy on this host, as cloudflared is, really is: the
/// address the proxy names. Only a proxy here is believed, so a screen elsewhere cannot pass
/// for another, and one through a tunnel is never taken for one on this host, which gets its
/// values whole and uncompressed.
fn forwarded(reached: &Reached, headers: &HeaderMap) -> Option<IpAddr> {
    if !reached.remote.is_loopback() {
        return None;
    }
    let named = headers.get("cf-connecting-ip").or_else(|| headers.get("x-forwarded-for"))?.to_str().ok()?;
    named.split(',').next()?.trim().parse::<IpAddr>().ok().map(|ip| ip.to_canonical())
}

/// The second way a screen opens, a socket or WebTransport, for its session, proven by the key
/// its hello carried.
#[derive(Deserialize)]
pub(crate) struct Second {
    pub session: u32,
    key: String,
}

impl Second {
    /// Hands the loop the second way, sent what `lanes` carry, once its key is its session's.
    pub async fn open(self, door: &Door, lanes: &Arc<Lanes>) -> bool {
        let (ok, answer) = oneshot::channel();
        door.send(Inbound::Bulk { session: self.session, key: self.key, out: Outbox::new(lanes.clone()), ok }) && answer.await == Ok(true)
    }
}

/// What a screen sent on its second way, which takes only that it took a value.
pub(crate) fn took(door: &Door, session: u32, data: &[u8]) {
    match ciborium::from_reader::<ClientMsg, _>(data) {
        Ok(msg @ ClientMsg::Took { .. }) => {
            door.send(Inbound::Message { session, msg });
        }
        Ok(_) => warn!("screen {session} sent on its second way what only its socket takes"),
        Err(e) => warn!("screen {session} sent what this backend cannot read: {e}"),
    }
}

async fn upgrade_bulk(ws: WebSocketUpgrade, State(door): State<Door>, Query(second): Query<Second>) -> Response {
    ws.on_upgrade(move |socket| bulk(socket, door, second))
}

/// What a socket has on its way, shared by its reader, which hears the pongs, and its writer,
/// which waits for them when the way is full.
struct Way {
    flight: Mutex<Flight>,
    heard: Notify,
    born: Instant,
}

impl Default for Way {
    fn default() -> Way {
        Way { flight: Mutex::default(), heard: Notify::new(), born: Instant::now() }
    }
}

impl Way {
    fn now(&self) -> u64 {
        self.born.elapsed().as_micros() as u64
    }

    fn pong(&self, data: &[u8]) {
        self.flight.lock().expect("flight").pong(data, self.now());
        self.heard.notify_one();
    }
}

/// Sends what `lanes` carry in pieces, as fast as the screen confirms them (`flight.rs`),
/// pinging after each piece and every PING_EVERY. Ends once the lanes close and are sent.
async fn write(mut sink: SplitSink<WebSocket, Message>, lanes: Arc<Lanes>, way: Arc<Way>) {
    let ping = || Message::Ping(Bytes::copy_from_slice(&way.flight.lock().expect("flight").ping(way.now())));
    let mut tick = interval(PING_EVERY);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        let heard = way.heard.notified();
        let (room, ask) = {
            let f = way.flight.lock().expect("flight");
            (f.room(), f.ask())
        };
        let frame = if ask {
            // a piece went since the last ping, so a ping at once, whose pong says it arrived
            ping()
        } else {
            tokio::select! {
                piece = lanes.next(room) => match piece {
                    Some(piece) => {
                        way.flight.lock().expect("flight").wrote(piece.len());
                        Message::Binary(piece)
                    }
                    None => break,
                },
                _ = heard, if !room => continue,
                _ = tick.tick() => ping(),
            }
        };
        if sink.send(frame).await.is_err() {
            break;
        }
    }
    let _ = sink.close().await;
}

/// One screen's socket: binary CBOR frames in become messages for the loop, and what the
/// loop sends goes out in pieces of its lanes. When the loop drops the screen, its lanes close
/// and the socket closes once they are sent.
async fn screen(socket: WebSocket, door: Door, reached: Reached) {
    let lanes = Arc::new(Lanes::default());
    let Some(session) = door.open(lanes.clone(), reached.local, reached.remote) else { return };
    let (sink, mut stream) = socket.split();
    let way = Arc::new(Way::default());
    let writer = tokio::spawn(write(sink, lanes, way.clone()));
    // the loop hears the screen is there once a ping's time at most, though the writer pings more
    let mut told: Option<Instant> = None;
    while let Some(Ok(frame)) = stream.next().await {
        match frame {
            Message::Binary(data) => match ciborium::from_reader::<ClientMsg, _>(data.as_ref()) {
                Ok(msg) => {
                    door.send(Inbound::Message { session, msg });
                }
                Err(e) => warn!("screen {session} sent what this backend cannot read: {e}"),
            },
            Message::Pong(data) => {
                way.pong(&data);
                if told.is_none_or(|t| t.elapsed() >= PING_EVERY) {
                    told = Some(Instant::now());
                    door.send(Inbound::Heard { session });
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    door.send(Inbound::Close { session });
    writer.abort();
}

/// A screen's second socket, which brings it its big values as the loop sends them and hears
/// when it took each. The loop checks its key first, and closes it with the session.
async fn bulk(socket: WebSocket, door: Door, second: Second) {
    let session = second.session;
    let lanes = Arc::new(Lanes::default());
    if !second.open(&door, &lanes).await {
        return;
    }
    let (sink, mut stream) = socket.split();
    let way = Arc::new(Way::default());
    let writer = tokio::spawn(write(sink, lanes.clone(), way.clone()));
    while let Some(Ok(frame)) = stream.next().await {
        match frame {
            Message::Binary(data) => took(&door, session, &data),
            Message::Pong(data) => way.pong(&data),
            Message::Close(_) => break,
            _ => {}
        }
    }
    door.send(Inbound::BulkClosed { session, lanes });
    writer.abort();
}

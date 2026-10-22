//! HTTP and WebSocket: the built client from one folder, and one socket per screen at `/ws`.

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::connect_info::Connected;
use axum::extract::{ConnectInfo, State};
use axum::serve::{IncomingStream, Listener};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::sync::mpsc::UnboundedSender;
use tokio::time::{MissedTickBehavior, interval};
use axum::http::{HeaderValue, header};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeader;
use tracing::{error, warn};

use crate::app::{Inbound, Outbox};
use crate::flight::Flight;
use crate::lanes::Lanes;
use crate::protocol::ClientMsg;

/// How often the socket pings its screen, so its round trip is new 20 times a second. The
/// browser answers by itself, even in a hidden tab whose timers run slow, so a screen is lost
/// only when its link is.
pub const PING_EVERY: Duration = Duration::from_millis(50);

#[derive(Clone)]
struct Shared {
    inbound: UnboundedSender<Inbound>,
    next: Arc<AtomicU32>,
}

pub async fn serve(listener: TcpListener, client: PathBuf, inbound: UnboundedSender<Inbound>) {
    let pages = ServeDir::new(&client).fallback(ServeFile::new(client.join("index.html")));
    // a screen asks again each time, so after an update it loads the new client
    let pages = SetResponseHeader::overriding(pages, header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    let app = Router::new()
        .route("/ws", get(upgrade))
        .fallback_service(pages)
        .with_state(Shared { inbound, next: Arc::new(AtomicU32::new(1)) });
    if let Err(e) = axum::serve(NoDelay(listener), app.into_make_service_with_connect_info::<Reached>()).await {
        error!("the web server stopped: {e}");
    }
}

/// The listener, each connection sending at once. Nagle's wait for an ack would hold a small
/// message, a ping or a value, until the screen's delayed ack, up to tens of ms.
struct NoDelay(TcpListener);

impl Listener for NoDelay {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (TcpStream, SocketAddr) {
        let (io, addr) = Listener::accept(&mut self.0).await;
        if let Err(e) = io.set_nodelay(true) {
            warn!("could not send at once to {addr}: {e}");
        }
        (io, addr)
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.0.local_addr()
    }
}

/// The address a screen reached this host on, which it can reach again for video, and the
/// address it came from.
#[derive(Clone, Copy)]
struct Reached {
    local: IpAddr,
    remote: IpAddr,
}

impl Connected<IncomingStream<'_, NoDelay>> for Reached {
    fn connect_info(stream: IncomingStream<'_, NoDelay>) -> Reached {
        let local = stream.io().local_addr().map_or(IpAddr::V4(Ipv4Addr::LOCALHOST), |a| a.ip().to_canonical());
        Reached { local, remote: stream.remote_addr().ip().to_canonical() }
    }
}

async fn upgrade(ws: WebSocketUpgrade, State(shared): State<Shared>, ConnectInfo(reached): ConnectInfo<Reached>) -> Response {
    ws.on_upgrade(move |socket| screen(socket, shared, reached))
}

/// What a socket has on its way, shared by its reader, which hears the pongs, and its writer,
/// which waits for them when the way is full.
#[derive(Default)]
struct Way {
    flight: Mutex<Flight>,
    heard: Notify,
}

/// One screen's socket: binary CBOR frames in become messages for the loop, and what the
/// loop sends goes out in pieces of its lanes, as fast as the screen confirms them
/// (`flight.rs`). When the loop drops the screen, its lanes close and the socket closes once
/// they are sent.
async fn screen(socket: WebSocket, shared: Shared, reached: Reached) {
    let session = shared.next.fetch_add(1, Ordering::Relaxed);
    let lanes = Arc::new(Lanes::default());
    let (local, remote) = (reached.local, reached.remote);
    if shared.inbound.send(Inbound::Open { session, out: Outbox::new(lanes.clone()), local, remote }).is_err() {
        return;
    }
    let (mut sink, mut stream) = socket.split();
    let born = Instant::now();
    let now = move || born.elapsed().as_micros() as u64;
    let way = Arc::new(Way::default());
    let writing = way.clone();
    let writer = tokio::spawn(async move {
        let way = writing;
        let ping = || Message::Ping(Bytes::copy_from_slice(&way.flight.lock().expect("flight").ping(now())));
        let mut tick = interval(PING_EVERY);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            let heard = way.heard.notified();
            let (room, asking) = {
                let f = way.flight.lock().expect("flight");
                (f.room(), f.asking())
            };
            let frame = if !room && !asking {
                // the way is full, so a ping at once, whose pong opens it as soon as it can
                ping()
            } else {
                tokio::select! {
                    piece = lanes.next(), if room => match piece {
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
    });
    // the loop hears a round trip once a ping's time at most, though the writer pings more
    let mut told: Option<Instant> = None;
    while let Some(Ok(frame)) = stream.next().await {
        match frame {
            Message::Binary(data) => match ciborium::from_reader::<ClientMsg, _>(data.as_ref()) {
                Ok(msg) => {
                    let _ = shared.inbound.send(Inbound::Message { session, msg });
                }
                Err(e) => warn!("screen {session} sent what this backend cannot read: {e}"),
            },
            Message::Pong(data) => {
                let ping = way.flight.lock().expect("flight").pong(&data, now());
                way.heard.notify_one();
                if told.is_none_or(|t| t.elapsed() >= PING_EVERY) {
                    told = Some(Instant::now());
                    let _ = shared.inbound.send(Inbound::Heard { session, ping });
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = shared.inbound.send(Inbound::Close { session });
    writer.abort();
}

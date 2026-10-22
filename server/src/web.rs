//! HTTP and WebSocket: the built client from one folder, and one socket per screen at `/ws`.

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
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
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::time::{MissedTickBehavior, interval};
use axum::http::{HeaderValue, header};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeader;
use tracing::{error, warn};

use crate::app::{Inbound, Outbox};
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

/// One screen's socket: binary CBOR frames in become messages for the loop, and what the
/// loop sends goes out. When the loop drops the screen, its sender ends and the socket closes.
async fn screen(socket: WebSocket, shared: Shared, reached: Reached) {
    let session = shared.next.fetch_add(1, Ordering::Relaxed);
    let (out, mut outgoing) = unbounded_channel::<Bytes>();
    let queued = Arc::new(AtomicUsize::new(0));
    let (local, remote) = (reached.local, reached.remote);
    if shared.inbound.send(Inbound::Open { session, out: Outbox::new(out, queued.clone()), local, remote }).is_err() {
        return;
    }
    let (mut sink, mut stream) = socket.split();
    // each ping carries when it left, in us since the socket opened, which its pong brings back
    let born = Instant::now();
    let writer = tokio::spawn(async move {
        let mut ping = interval(PING_EVERY);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            let frame = tokio::select! {
                frame = outgoing.recv() => match frame {
                    Some(frame) => Message::Binary(frame),
                    None => break,
                },
                _ = ping.tick() => Message::Ping(Bytes::copy_from_slice(&(born.elapsed().as_micros() as u64).to_le_bytes())),
            };
            let sent = if let Message::Binary(b) = &frame { b.len() } else { 0 };
            let failed = sink.send(frame).await.is_err();
            queued.fetch_sub(sent, Ordering::Relaxed);
            if failed {
                break;
            }
        }
        let _ = sink.close().await;
    });
    while let Some(Ok(frame)) = stream.next().await {
        match frame {
            Message::Binary(data) => match ciborium::from_reader::<ClientMsg, _>(data.as_ref()) {
                Ok(msg) => {
                    let _ = shared.inbound.send(Inbound::Message { session, msg });
                }
                Err(e) => warn!("screen {session} sent what this backend cannot read: {e}"),
            },
            Message::Pong(data) => {
                let left = <[u8; 8]>::try_from(data.as_ref()).ok().map(|b| Duration::from_micros(u64::from_le_bytes(b)));
                let _ = shared.inbound.send(Inbound::Heard { session, ping: left.map(|l| born.elapsed().saturating_sub(l)) });
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = shared.inbound.send(Inbound::Close { session });
    writer.abort();
}

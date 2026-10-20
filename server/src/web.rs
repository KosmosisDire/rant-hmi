//! HTTP and WebSocket: the built client from one folder, and one socket per screen at `/ws`.

use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::connect_info::Connected;
use axum::extract::{ConnectInfo, State};
use axum::serve::IncomingStream;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::time::{MissedTickBehavior, interval};
use axum::http::{HeaderValue, header};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeader;
use tracing::{error, warn};

use crate::app::Inbound;
use crate::protocol::ClientMsg;

/// How often the socket pings its screen. The browser answers by itself, even in a hidden tab
/// whose timers run slow, so a screen is lost only when its link is.
const PING_EVERY: Duration = Duration::from_millis(100);

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
    if let Err(e) = axum::serve(listener, app.into_make_service_with_connect_info::<Local>()).await {
        error!("the web server stopped: {e}");
    }
}

/// The address a screen reached this host on, which it can reach again for video.
#[derive(Clone, Copy)]
struct Local(IpAddr);

impl Connected<IncomingStream<'_, TcpListener>> for Local {
    fn connect_info(stream: IncomingStream<'_, TcpListener>) -> Local {
        Local(stream.io().local_addr().map_or(IpAddr::V4(Ipv4Addr::LOCALHOST), |a| a.ip().to_canonical()))
    }
}

async fn upgrade(ws: WebSocketUpgrade, State(shared): State<Shared>, ConnectInfo(Local(local)): ConnectInfo<Local>) -> Response {
    ws.on_upgrade(move |socket| screen(socket, shared, local))
}

/// One screen's socket: binary CBOR frames in become messages for the loop, and what the
/// loop sends goes out. When the loop drops the screen, its sender ends and the socket closes.
async fn screen(socket: WebSocket, shared: Shared, local: IpAddr) {
    let session = shared.next.fetch_add(1, Ordering::Relaxed);
    let (out, mut outgoing) = unbounded_channel::<Bytes>();
    if shared.inbound.send(Inbound::Open { session, out, local }).is_err() {
        return;
    }
    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        let mut ping = interval(PING_EVERY);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            let frame = tokio::select! {
                frame = outgoing.recv() => match frame {
                    Some(frame) => Message::Binary(frame),
                    None => break,
                },
                _ = ping.tick() => Message::Ping(Bytes::new()),
            };
            if sink.send(frame).await.is_err() {
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
            Message::Pong(_) => {
                let _ = shared.inbound.send(Inbound::Heard { session });
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = shared.inbound.send(Inbound::Close { session });
    writer.abort();
}

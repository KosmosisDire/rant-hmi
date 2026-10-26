//! Echoes for timing each way a page may reach this backend, apart from the screens' own
//! traffic: a socket at `/probe/ws`, WebTransport at `/probe` (datagrams and a stream), and a
//! WebRTC channel named `probe` (rtc.rs). `/probe/info` names this host's addresses, so a page
//! that came through a proxy can try WebTransport straight to them. The page's side is
//! client/src/net/probe.ts.

use axum::Json;
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use serde_json::{Value, json};
use tracing::debug;
use wtransport::Connection;

/// The routes, beside the screens' own.
pub fn router<S: Clone + Send + Sync + 'static>(port: u16) -> Router<S> {
    Router::new().route("/probe/ws", get(upgrade)).route("/probe/info", get(move || info(port)))
}

async fn info(port: u16) -> Json<Value> {
    let ips: Vec<String> = if_addrs::get_if_addrs().unwrap_or_default().into_iter().filter(|i| !i.is_loopback() && i.ip().is_ipv4()).map(|i| i.ip().to_string()).collect();
    Json(json!({ "ips": ips, "port": port }))
}

async fn upgrade(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(echo)
}

/// Sends back each message as it comes.
async fn echo(mut socket: WebSocket) {
    while let Some(Ok(msg)) = socket.recv().await {
        let back = match msg {
            Message::Binary(b) => Message::Binary(b),
            Message::Text(t) => Message::Text(t),
            Message::Close(_) => return,
            _ => continue,
        };
        if socket.send(back).await.is_err() {
            return;
        }
    }
}

/// Sends back each datagram, and each piece of each stream the page opens, as they come.
pub async fn wt(conn: Connection) {
    debug!("a probe opened WebTransport");
    let datagrams = async {
        while let Ok(d) = conn.receive_datagram().await {
            let _ = conn.send_datagram(d.payload());
        }
    };
    let streams = async {
        while let Ok((mut send, mut recv)) = conn.accept_bi().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                while let Ok(Some(n)) = recv.read(&mut buf).await {
                    if send.write_all(&buf[..n]).await.is_err() {
                        return;
                    }
                }
            });
        }
    };
    tokio::select! {
        _ = datagrams => {}
        _ = streams => {}
    }
}

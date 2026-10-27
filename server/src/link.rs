//! A screen in this process, as rant-hmi-app's window shows one. It is served through the
//! webview's own scheme, so no socket and no port: the client's files, and at `/link` its
//! session. Each way carries messages whole and in order, each after its length as a u32.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{self, State};
use axum::http::StatusCode;
use axum::routing::post;
use tracing::warn;

use crate::app::{Door, Inbound};
use crate::lanes::Lanes;
use crate::protocol::ClientMsg;
use crate::web;

/// How long a poll waits for something to send before it answers with nothing.
const WAIT: Duration = Duration::from_secs(10);
/// About the most one poll answers with. What waits beyond goes in the next.
const BATCH: usize = 1 << 20;

#[derive(Clone)]
struct Link {
    door: Door,
    /// Each session's lanes, kept until all the loop sent is read, as a socket's writer keeps
    /// them.
    sessions: Arc<Mutex<HashMap<u32, Arc<Lanes>>>>,
}

/// What a screen in this process is served: the client's files from `client`, the project's
/// shared files, and its link.
pub fn router(client: &Path, project: &Path, door: Door) -> Router {
    Router::new()
        .route("/link", post(open))
        .route("/link/{session}", post(said).get(poll))
        .with_state(Link { door, sessions: Arc::default() })
        .merge(web::files(client, project))
}

/// Opens a session and answers its number.
async fn open(State(link): State<Link>) -> Result<String, StatusCode> {
    let lanes = Arc::new(Lanes::default());
    // the screen is on this host
    let here = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let session = link.door.open(lanes.clone(), here, here).ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let mut sessions = link.sessions.lock().expect("sessions");
    // a page that went away left its session to the loop, which has dropped it as lost
    sessions.retain(|_, lanes| !lanes.closed());
    sessions.insert(session, lanes);
    Ok(session.to_string())
}

/// Hands the loop what the screen sent, in order.
async fn said(State(link): State<Link>, extract::Path(session): extract::Path<u32>, body: Bytes) -> StatusCode {
    if lanes(&link, session).is_none() {
        return StatusCode::GONE;
    }
    for message in unframed(&body) {
        match ciborium::from_reader::<ClientMsg, _>(message) {
            Ok(msg) => {
                link.door.send(Inbound::Message { session, msg });
            }
            Err(e) => warn!("screen {session} sent what this backend cannot read: {e}"),
        }
    }
    StatusCode::NO_CONTENT
}

/// Waits for what the loop sends the screen and answers every piece ready then. A poll comes
/// once the screen has read the last, as a pong does on a socket. Gone once the loop dropped
/// the session and all it sent was read.
async fn poll(State(link): State<Link>, extract::Path(session): extract::Path<u32>) -> Result<Vec<u8>, StatusCode> {
    let lanes = lanes(&link, session).ok_or(StatusCode::GONE)?;
    link.door.send(Inbound::Heard { session });
    let mut batch = Vec::new();
    match tokio::time::timeout(WAIT, lanes.next(true)).await {
        Err(_) => return Ok(batch),
        Ok(None) => {
            link.sessions.lock().expect("sessions").remove(&session);
            return Err(StatusCode::GONE);
        }
        Ok(Some(piece)) => frame(&mut batch, &piece),
    }
    while batch.len() < BATCH
        && let Some(piece) = lanes.take(true)
    {
        frame(&mut batch, &piece);
    }
    Ok(batch)
}

fn lanes(link: &Link, session: u32) -> Option<Arc<Lanes>> {
    link.sessions.lock().expect("sessions").get(&session).cloned()
}

fn frame(batch: &mut Vec<u8>, message: &[u8]) {
    batch.extend_from_slice(&(message.len() as u32).to_le_bytes());
    batch.extend_from_slice(message);
}

/// The messages in a body, each after its length, up to the first that is cut short.
fn unframed(mut body: &[u8]) -> impl Iterator<Item = &[u8]> {
    std::iter::from_fn(move || {
        let (length, rest) = body.split_first_chunk::<4>()?;
        let n = u32::from_le_bytes(*length) as usize;
        let message = rest.get(..n)?;
        body = &rest[n..];
        Some(message)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tokio::sync::mpsc::UnboundedReceiver;
    use tower::ServiceExt;

    async fn ask(router: &Router, method: &str, path: &str, body: Vec<u8>) -> (StatusCode, Bytes) {
        let request = Request::builder().method(method).uri(path).body(Body::from(body)).unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        (status, to_bytes(response.into_body(), usize::MAX).await.unwrap())
    }

    fn cbor(msg: serde_json::Value) -> Vec<u8> {
        let mut bytes = Vec::new();
        ciborium::into_writer(&msg, &mut bytes).unwrap();
        bytes
    }

    async fn opened(router: &Router, screens: &mut UnboundedReceiver<Inbound>) -> (u32, crate::app::Outbox) {
        let (status, body) = ask(router, "POST", "/link", Vec::new()).await;
        assert_eq!(status, StatusCode::OK);
        let Some(Inbound::Open { session, out, .. }) = screens.recv().await else { panic!("no session opened") };
        assert_eq!(body, session.to_string());
        (session, out)
    }

    #[tokio::test]
    async fn a_screen_in_this_process_sends_and_gets_messages_in_order() {
        let (door, mut screens) = Door::new();
        let router = router(Path::new("."), Path::new("."), door);
        let (session, out) = opened(&router, &mut screens).await;

        // the loop gets what the screen sent in order, a ping among the rest
        let mut body = Vec::new();
        frame(&mut body, &cbor(serde_json::json!({ "type": "undo" })));
        frame(&mut body, &cbor(serde_json::json!({ "type": "ping", "t": 1.5 })));
        frame(&mut body, &cbor(serde_json::json!({ "type": "redo" })));
        let (status, _) = ask(&router, "POST", &format!("/link/{session}"), body).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(matches!(screens.recv().await, Some(Inbound::Message { msg: ClientMsg::Undo, .. })));
        assert!(matches!(screens.recv().await, Some(Inbound::Message { msg: ClientMsg::Ping { t: 1.5, .. }, .. })));
        assert!(matches!(screens.recv().await, Some(Inbound::Message { msg: ClientMsg::Redo, .. })));

        // two messages wait, so one poll answers both, each a piece as a socket's frame is
        out.send(Bytes::from_static(b"first"));
        out.send(Bytes::from_static(b"second"));
        let (status, batch) = ask(&router, "GET", &format!("/link/{session}"), Vec::new()).await;
        assert_eq!(status, StatusCode::OK);
        let pieces: Vec<&[u8]> = unframed(&batch).collect();
        assert_eq!(pieces.len(), 2);
        assert_eq!(&pieces[0][3..], b"first");
        assert_eq!(&pieces[1][3..], b"second");
        assert!(matches!(screens.recv().await, Some(Inbound::Heard { .. })));

        // the loop drops the session, which is gone once what it sent last is read
        out.send(Bytes::from_static(b"bye"));
        drop(out);
        let (status, batch) = ask(&router, "GET", &format!("/link/{session}"), Vec::new()).await;
        assert_eq!((status, unframed(&batch).count()), (StatusCode::OK, 1));
        let (status, _) = ask(&router, "GET", &format!("/link/{session}"), Vec::new()).await;
        assert_eq!(status, StatusCode::GONE);
        let (status, _) = ask(&router, "POST", &format!("/link/{session}"), cbor(serde_json::json!({ "type": "undo" }))).await;
        assert_eq!(status, StatusCode::GONE);
    }

    #[tokio::test]
    async fn a_poll_waits_for_what_is_sent() {
        let (door, mut screens) = Door::new();
        let router = router(Path::new("."), Path::new("."), door);
        let (session, out) = opened(&router, &mut screens).await;
        let polling = tokio::spawn({
            let router = router.clone();
            async move { ask(&router, "GET", &format!("/link/{session}"), Vec::new()).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!polling.is_finished());
        out.send(Bytes::from_static(b"late"));
        let (status, batch) = polling.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(&unframed(&batch).next().unwrap()[3..], b"late");
    }

    #[tokio::test]
    async fn a_page_loads_the_shared_files_and_nothing_outside_them() {
        let dir = std::env::temp_dir().join(format!("rant-hmi-test-shared-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (client, project) = (dir.join("client"), dir.join("project"));
        for (file, text) in [(client.join("index.html"), "page"), (project.join("hmi.toml"), "secret"), (project.join("files/arm.glb"), "model"), (project.join("files/maps/hall.png"), "picture"), (project.join("files/.notes"), "hidden")] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        let (door, _screens) = Door::new();
        let router = router(&client, &project, door);
        for (path, body) in [("/files/arm.glb", "model"), ("/files/maps/hall.png", "picture"), ("/hmi.toml", "page"), ("/files/", "page")] {
            assert_eq!(ask(&router, "GET", path, Vec::new()).await, (StatusCode::OK, Bytes::from(body)), "{path}");
        }
        for path in ["/files/../hmi.toml", "/files/..%2Fhmi.toml", "/files/maps/..%2F..%2Fhmi.toml", "/files/.notes", "/files/maps", "/files/gone.glb"] {
            assert_eq!(ask(&router, "GET", path, Vec::new()).await.0, StatusCode::NOT_FOUND, "{path}");
        }
        // a link in the folder that leads out of it, where this system lets a test make one
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(project.join("hmi.toml"), project.join("files/out.toml"));
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(project.join("hmi.toml"), project.join("files/out.toml"));
        if linked.is_ok() {
            assert_eq!(ask(&router, "GET", "/files/out.toml", Vec::new()).await.0, StatusCode::NOT_FOUND);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_body_cut_short_keeps_the_messages_before() {
        let mut body = Vec::new();
        frame(&mut body, b"whole");
        body.extend_from_slice(&9u32.to_le_bytes());
        body.extend_from_slice(b"cut");
        assert_eq!(unframed(&body).collect::<Vec<_>>(), vec![b"whole".as_slice()]);
    }
}

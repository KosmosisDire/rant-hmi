//! The Rant HMI backend as a Node addon. rant-hmi-app's Electron window loads it into its own
//! process and serves a screen through it, so the screen and its backend share no network.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, Once};
use std::thread::{self, JoinHandle};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::Request;
use napi::bindgen_prelude::Buffer;
use napi::{Error, Result};
use napi_derive::napi;
use rant_hmi::{Hmi, Options, link};
use tokio::runtime::{Handle, Runtime};
use tokio::sync::oneshot;
use tower::ServiceExt;
use tracing::error;
use tracing_subscriber::EnvFilter;

/// The HMI running in this process: what serves its screen, on the backend's own runtime, and
/// what stops it.
struct Running {
    router: Router,
    runtime: Handle,
    stop: oneshot::Sender<()>,
    backend: JoinHandle<()>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

/// What `start` runs, as rant-hmi takes it from its command line.
#[napi(object)]
pub struct Project {
    /// The project folder.
    pub folder: String,
    /// The built client.
    pub client: String,
    /// The Rant domain. 0 takes RANT_DOMAIN, else 0.
    pub domain: u32,
    /// Keep the mesh on this host, discovery on 127.0.0.1 only.
    pub loopback: bool,
}

/// What the HMI answers one of the window's requests with.
#[napi(object)]
pub struct Answer {
    pub status: u32,
    pub headers: HashMap<String, String>,
    pub body: Buffer,
}

/// The folder the HMI keeps its own files in on this host, where the window keeps its data too.
#[napi]
pub fn kept() -> Option<String> {
    rant_hmi::kept().map(|kept| kept.to_string_lossy().into_owned())
}

/// Opens the project and runs its backend on a thread of its own. Answers with the HMI's name
/// once it runs, or fails with why it could not start.
#[napi]
pub async fn start(p: Project) -> Result<String> {
    logging();
    if RUNNING.lock().unwrap().is_some() {
        return Err(Error::from_reason("an HMI already runs in this process"));
    }
    let domain = u16::try_from(p.domain).map_err(|_| Error::from_reason(format!("there is no Rant domain {}", p.domain)))?;
    let client = PathBuf::from(p.client);
    let options = Options { project: p.folder.into(), client: client.clone(), domain, loopback: p.loopback, rtc_ports: None, web: None };
    let (ready, started) = oneshot::channel();
    let (stop, stopped) = oneshot::channel::<()>();
    let backend = thread::spawn(move || {
        let runtime = match Runtime::new() {
            Ok(runtime) => runtime,
            Err(e) => return drop(ready.send(Err(e.to_string()))),
        };
        runtime.block_on(async {
            let hmi = match Hmi::start(options).await {
                Ok(hmi) => hmi,
                Err(e) => return drop(ready.send(Err(format!("{e:#}")))),
            };
            let router = link::router(&client, hmi.door());
            let _ = ready.send(Ok((hmi.name().to_owned(), router, Handle::current())));
            hmi.run(async {
                let _ = stopped.await;
            })
            .await;
        });
    });
    let started = started.await.unwrap_or_else(|_| Err("the HMI stopped as it started".to_owned()));
    let (name, router, runtime) = started.map_err(|why| {
        error!("{why}");
        Error::from_reason(why)
    })?;
    *RUNNING.lock().unwrap() = Some(Running { router, runtime, stop, backend });
    Ok(name)
}

/// Answers one of the window's requests on the HMI's scheme: the client's files, or the link.
#[napi]
pub async fn request(method: String, path: String, body: Buffer) -> Result<Answer> {
    let (router, runtime) = {
        let running = RUNNING.lock().unwrap();
        let running = running.as_ref().ok_or_else(|| Error::from_reason("no HMI runs in this process"))?;
        (running.router.clone(), running.runtime.clone())
    };
    let request = Request::builder().method(method.as_str()).uri(path).body(Body::from(body.to_vec())).map_err(|e| Error::from_reason(e.to_string()))?;
    // on the backend's runtime, as a poll waits on its timers
    let answered = runtime.spawn(async move {
        let Ok(response) = router.oneshot(request).await;
        let (parts, body) = response.into_parts();
        (parts, to_bytes(body, usize::MAX).await)
    });
    let (parts, body) = answered.await.map_err(|e| Error::from_reason(e.to_string()))?;
    let body = body.map_err(|e| Error::from_reason(e.to_string()))?;
    let headers = parts.headers.iter().filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_owned()))).collect();
    Ok(Answer { status: parts.status.as_u16().into(), headers, body: body.to_vec().into() })
}

/// Stops the HMI: its screens' sessions end, then its node. Resolves once it has.
#[napi]
pub async fn stop() -> Result<()> {
    let Some(running) = RUNNING.lock().unwrap().take() else {
        return Ok(());
    };
    let _ = running.stop.send(());
    tokio::task::spawn_blocking(move || running.backend.join()).await.map_err(|e| Error::from_reason(e.to_string()))?.map_err(|_| Error::from_reason("the HMI failed as it stopped"))
}

/// The backend logs as rant-hmi does, at RUST_LOG else info.
fn logging() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
        let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
    });
}

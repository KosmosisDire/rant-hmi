//! The Rant HMI backend: one Rant node on the system that serves the editor and every
//! screen. docs/design.md in the repository holds the design.

pub mod app;
pub mod authorize;
pub mod events;
pub mod lanes;
pub mod files;
pub mod flight;
pub mod library;
pub mod list;
pub mod mesh;
pub mod pages;
pub mod project;
pub mod protocol;
pub mod rtc;
pub mod rules;
pub mod script;
pub mod status;
pub mod stun;
pub mod tls;
pub mod value;
pub mod watch;
pub mod web;

use std::ops::RangeInclusive;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use tokio::net::TcpListener;
use tokio::sync::mpsc::unbounded_channel;
use tracing::{info, warn};

use app::App;
use mesh::{Mesh, MeshOptions};
use pages::Pages;
use project::Project;

pub struct Options {
    pub project: PathBuf,
    pub client: PathBuf,
    pub bind: String,
    pub port: u16,
    pub domain: u16,
    pub loopback: bool,
    /// The ports WebRTC may take, else any.
    pub rtc_ports: Option<RangeInclusive<u16>>,
    /// What https serves with, else it serves http only.
    pub certificate: Option<tls::Certificate>,
}

/// The node's name on the mesh: one plain name, as tooling nodes take.
const NODE: &str = "hmi";

pub async fn run(o: Options) -> Result<()> {
    let project = Project::open(&o.project)?;
    let pages = Pages::open(&o.project)?;
    let (deliveries, delivered) = unbounded_channel();
    let (rtc_said, rtc_heard) = unbounded_channel();
    let rtc = rtc::start(rtc_said, rtc::Reach { loopback: o.loopback, ports: o.rtc_ports });
    let (frames, framed) = unbounded_channel();
    let mesh = Mesh::open(&MeshOptions { name: NODE.to_owned(), domain: o.domain, loopback: o.loopback }, deliveries, frames)
        .map_err(|e| anyhow!("could not open the Rant node: {e}"))?;
    let listener = TcpListener::bind((o.bind.as_str(), o.port))
        .await
        .with_context(|| format!("could not listen on {}:{}", o.bind, o.port))?;
    // a real certificate must work, while the HMI's own failing leaves http
    let tls = match &o.certificate {
        None => None,
        Some(c) => match (tls::acceptor(c), c) {
            (Ok(tls), _) => Some(tls),
            (Err(e), tls::Certificate::Given { .. }) => return Err(e),
            (Err(e), tls::Certificate::Own(_)) => {
                warn!("serving no https, as the HMI's own certificate failed: {e:#}");
                None
            }
        },
    };
    let at = listener.local_addr()?;
    match tls {
        Some(_) => info!("{} on http://{at} and https://{at}", project.info.name),
        None => info!("{} on http://{at}", project.info.name),
    }
    let index = std::fs::read_to_string(o.client.join("index.html")).unwrap_or_default();
    if index.is_empty() {
        info!("no client at {}: build it with npm run build in client", o.client.display());
    }
    // the built client's script, whose name changes with each build
    let build = index.split("src=\"").nth(1).and_then(|s| s.split('"').next()).filter(|s| s.starts_with("/assets/")).unwrap_or_default().to_owned();
    let (inbound, received) = unbounded_channel();
    tokio::spawn(web::serve(listener, tls, o.client, inbound));
    let (said, heard) = unbounded_channel();
    let script = script::Script::start(said);
    let (changes, changed) = unbounded_channel();
    // without a watcher the HMI still runs, it just misses edits made elsewhere
    let _watcher = watch::watch(&o.project, changes).map_err(|e| warn!("could not watch {}: {e}", o.project.display())).ok();
    App::new(project, pages, mesh, script, rtc, NODE.to_owned(), build).run(delivered, received, heard, changed, rtc_heard, framed).await;
    Ok(())
}

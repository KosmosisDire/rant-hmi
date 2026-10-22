//! The Rant HMI backend: one Rant node on the system that serves the editor and every
//! screen. docs/files.md in the repository shows the project it runs.

pub mod app;
pub mod apps;
pub mod authorize;
pub mod events;
pub mod lanes;
pub mod files;
pub mod flight;
pub mod library;
pub mod link;
pub mod list;
pub mod mesh;
pub mod pages;
pub mod project;
pub mod protocol;
#[cfg(test)]
mod reference;
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
use notify::RecommendedWatcher;
use tokio::net::TcpListener;
use tokio::sync::mpsc::unbounded_channel;
use tracing::{info, warn};

use app::{App, Door, Sources};
use apps::Apps;
use mesh::{Mesh, MeshOptions};
use pages::Pages;
use project::Project;

pub struct Options {
    pub project: PathBuf,
    pub client: PathBuf,
    pub domain: u16,
    pub loopback: bool,
    /// The ports WebRTC may take, else any.
    pub rtc_ports: Option<RangeInclusive<u16>>,
    /// Where screens reach it over the network, else only in this process.
    pub web: Option<Web>,
}

/// Serving screens over the network.
pub struct Web {
    pub bind: String,
    pub port: u16,
    /// What https serves with, else it serves http only.
    pub certificate: Option<tls::Certificate>,
}

pub use rant_hmi_pack::kept;

/// The node's name on the mesh: one plain name, as tooling nodes take.
const NODE: &str = "hmi";

/// An HMI opened and ready to run.
pub struct Hmi {
    app: App,
    from: Sources,
    door: Door,
    name: String,
    /// Without one the HMI still runs, it just misses edits made elsewhere.
    _watcher: Option<RecommendedWatcher>,
}

impl Hmi {
    /// Opens the project, the node and the port, so whatever fails does before anything shows.
    pub async fn start(o: Options) -> Result<Hmi> {
        let project = Project::open(&o.project)?;
        let pages = Pages::open(&o.project)?;
        let (deliveries, mesh) = unbounded_channel();
        let (rtc_said, rtc) = unbounded_channel();
        let connections = rtc::start(rtc_said, rtc::Reach { loopback: o.loopback, ports: o.rtc_ports });
        let (frames_in, frames) = unbounded_channel();
        let node = Mesh::open(&MeshOptions { name: NODE.to_owned(), domain: o.domain, loopback: o.loopback }, deliveries, frames_in)
            .map_err(|e| anyhow!("could not open the Rant node: {e}"))?;
        let index = std::fs::read_to_string(o.client.join("index.html")).unwrap_or_default();
        if index.is_empty() {
            info!("no client at {}: build it with npm run build in client", o.client.display());
        }
        // the built client's script, whose name changes with each build
        let build = index.split("src=\"").nth(1).and_then(|s| s.split('"').next()).filter(|s| s.starts_with("/assets/")).unwrap_or_default().to_owned();
        let (door, screens) = Door::new();
        if let Some(web) = o.web {
            let runtimes = kept().map(|kept| kept.join("runtimes").join(env!("CARGO_PKG_VERSION"))).unwrap_or_default();
            let apps = Apps { project: o.project.clone(), runtimes, domain: o.domain, loopback: o.loopback, trust: None };
            serve(web, &project.info.name, o.client, door.clone(), apps).await?;
        }
        let (said, script) = unbounded_channel();
        let runner = script::Script::start(said);
        let (changes, files) = unbounded_channel();
        let _watcher = watch::watch(&o.project, changes).map_err(|e| warn!("could not watch {}: {e}", o.project.display())).ok();
        let name = project.info.name.clone();
        let app = App::new(project, pages, node, runner, connections, NODE.to_owned(), build);
        Ok(Hmi { app, from: Sources { mesh, screens, script, files, rtc, frames }, door, name, _watcher })
    }

    /// The door a screen in this process comes in by.
    pub fn door(&self) -> Door {
        self.door.clone()
    }

    /// The project's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Runs until `stop` ends.
    pub async fn run(self, stop: impl Future<Output = ()>) {
        let Hmi { app, from, _watcher, .. } = self;
        app.run(from, stop).await;
    }
}

/// Listens on the network for screens, the editor's included, and the apps it builds.
async fn serve(web: Web, name: &str, client: PathBuf, door: Door, mut apps: Apps) -> Result<()> {
    let listener = TcpListener::bind((web.bind.as_str(), web.port))
        .await
        .with_context(|| format!("could not listen on {}:{}", web.bind, web.port))?;
    // a real certificate must work, while the HMI's own failing leaves http
    let tls = match &web.certificate {
        None => None,
        Some(c) => match (tls::acceptor(c), c) {
            (Ok((tls, fingerprint)), _) => {
                apps.trust = Some(fingerprint);
                Some(tls)
            }
            (Err(e), tls::Certificate::Given { .. }) => return Err(e),
            (Err(e), tls::Certificate::Own(_)) => {
                warn!("serving no https, as the HMI's own certificate failed: {e:#}");
                None
            }
        },
    };
    let at = listener.local_addr()?;
    match tls {
        Some(_) => info!("{name} on http://{at} and https://{at}"),
        None => info!("{name} on http://{at}"),
    }
    tokio::spawn(async move { web::serve(listener, tls, &client, door, apps).await });
    Ok(())
}

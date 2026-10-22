//! An HMI's operator screen in a native window, its backend run in this process or reached
//! elsewhere.

#![windows_subsystem = "windows"]

mod window;

use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;

use clap::Parser;
use rant_hmi::{Hmi, Options, link};
use tokio::runtime::{Handle, Runtime};
use tokio::sync::oneshot;
use tracing::error;
use tracing_subscriber::EnvFilter;

use window::{Screen, Shell};

/// Rant HMI app: an HMI's operator screen in a window of its own.
#[derive(Parser)]
#[command(name = "rant-hmi-app", version)]
struct Args {
    /// A project folder to run here, or the address of an HMI running elsewhere, as
    /// https://host:6739.
    #[arg(default_value = ".")]
    show: String,
    /// The built client, for a project run here.
    #[arg(long, default_value = "client/dist")]
    client: PathBuf,
    /// The Rant domain. 0 takes RANT_DOMAIN, else 0.
    #[arg(long, default_value_t = 0)]
    domain: u16,
    /// Keep the mesh on this host, discovery on 127.0.0.1 only.
    #[arg(long)]
    loopback: bool,
}

fn main() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
    let a = Args::parse();
    let shell = Shell::new();
    if a.show.starts_with("http://") || a.show.starts_with("https://") {
        shell.show(Screen::There(format!("{}/run", a.show.trim_end_matches('/'))), || {});
    }
    let client = a.client.clone();
    let options = Options { project: a.show.into(), client: a.client, domain: a.domain, loopback: a.loopback, rtc_ports: None, web: None };
    let (ready, started) = mpsc::channel();
    let (stop, stopped) = oneshot::channel::<()>();
    let closer = shell.closer();
    let backend = thread::spawn(move || {
        let runtime = match Runtime::new() {
            Ok(runtime) => runtime,
            Err(e) => return drop(ready.send(Err(e.into()))),
        };
        runtime.block_on(async {
            let hmi = match Hmi::start(options).await {
                Ok(hmi) => hmi,
                Err(e) => return drop(ready.send(Err(e))),
            };
            let router = link::router(&client, hmi.door());
            let _ = ready.send(Ok(Screen::Here { title: hmi.name().to_owned(), router, runtime: Handle::current() }));
            hmi.run(async {
                tokio::select! {
                    _ = stopped => {}
                    _ = tokio::signal::ctrl_c() => {}
                }
            })
            .await;
            // stopped by Ctrl C or as the window closed, so the window goes too
            closer.close();
        });
    });
    match started.recv() {
        Ok(Ok(screen)) => shell.show(screen, move || {
            let _ = stop.send(());
            let _ = backend.join();
        }),
        Ok(Err(e)) => {
            error!("{e:#}");
            shell.show(Screen::Fault(format!("{e:#}")), || {})
        }
        Err(_) => shell.show(Screen::Fault("The HMI stopped as it started.".into()), || {}),
    }
}

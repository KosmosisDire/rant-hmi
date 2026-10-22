//! Runs a project as rant-hmi-app does, its screens served through the app's link, but over http
//! on 127.0.0.1, so a browser test drives the screen the app's window shows. WebView2 here opens
//! no debugging port to drive the window itself.

use std::path::PathBuf;

use clap::Parser;
use rant_hmi::{Hmi, Options, link};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
struct Args {
    project: PathBuf,
    #[arg(long)]
    client: PathBuf,
    #[arg(long)]
    domain: u16,
    #[arg(long)]
    loopback: bool,
    #[arg(long)]
    port: u16,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::new("info")).init();
    let a = Args::parse();
    let hmi = Hmi::start(Options { project: a.project, client: a.client.clone(), domain: a.domain, loopback: a.loopback, rtc_ports: None, web: None }).await?;
    let router = link::router(&a.client, hmi.door());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", a.port)).await?;
    tokio::spawn(async move { axum::serve(listener, router).await });
    hmi.run(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await;
    Ok(())
}

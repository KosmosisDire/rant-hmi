use std::path::PathBuf;

use clap::Parser;
use tracing_subscriber::EnvFilter;

/// Rant HMI: build and run HMIs for a Rant mesh in a browser.
#[derive(Parser)]
#[command(name = "rant-hmi", version)]
struct Args {
    /// The project folder, started empty when it holds none.
    #[arg(default_value = ".")]
    project: PathBuf,
    /// The built client to serve.
    #[arg(long, default_value = "client/dist")]
    client: PathBuf,
    /// The address to listen on. 0.0.0.0 lets other machines open it.
    #[arg(long, default_value = "127.0.0.1")]
    bind: String,
    #[arg(long, default_value_t = 6739)]
    port: u16,
    /// The Rant domain. 0 takes RANT_DOMAIN, else 0.
    #[arg(long, default_value_t = 0)]
    domain: u16,
    /// Keep the mesh on this host: discovery on 127.0.0.1 only.
    #[arg(long)]
    loopback: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
    let a = Args::parse();
    rant_hmi::run(rant_hmi::Options {
        project: a.project,
        client: a.client,
        bind: a.bind,
        port: a.port,
        domain: a.domain,
        loopback: a.loopback,
    })
    .await
}

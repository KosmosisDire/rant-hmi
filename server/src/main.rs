use std::ops::RangeInclusive;
use std::path::PathBuf;

use clap::Parser;
use rant_hmi::tls::{self, Certificate};
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
    /// Keep the mesh on this host, discovery on 127.0.0.1 only, and WebRTC on the address each
    /// screen reached the HMI on.
    #[arg(long)]
    loopback: bool,
    /// The ports WebRTC may take, as 6740-6759. Empty takes any.
    #[arg(long, default_value = "", value_parser = ports)]
    rtc_ports: Ports,
    /// A certificate for https, as PEM, in place of the HMI's own self signed one.
    #[arg(long, requires = "key")]
    cert: Option<PathBuf>,
    /// The certificate's private key, as PEM.
    #[arg(long, requires = "cert")]
    key: Option<PathBuf>,
}

/// A range of ports, or none.
#[derive(Clone)]
struct Ports(Option<RangeInclusive<u16>>);

fn ports(s: &str) -> Result<Ports, String> {
    if s.is_empty() {
        return Ok(Ports(None));
    }
    let range = s.split_once('-').and_then(|(lo, hi)| Some(lo.trim().parse::<u16>().ok()?..=hi.trim().parse::<u16>().ok()?));
    match range {
        Some(r) if *r.start() > 0 && r.start() <= r.end() => Ok(Ports(Some(r))),
        _ => Err("wants a range like 6740-6759".into()),
    }
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
        rtc_ports: a.rtc_ports.0,
        certificate: match (a.cert, a.key) {
            (Some(cert), Some(key)) => Some(Certificate::Given { cert, key }),
            _ => tls::kept().map(Certificate::Own),
        },
    })
    .await
}

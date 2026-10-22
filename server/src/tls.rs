//! https beside http on the one port: a certificate given as PEM files, or the HMI's own,
//! made once and kept per host so a browser that accepted it keeps it for every project there.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, anyhow};
use rcgen::{CertificateParams, DnType, KeyPair};
use rustls::ServerConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::TlsAcceptor;
use tracing::info;
use x509_cert::der::Decode;

/// How long the HMI's own certificate lasts, the most Apple's devices take.
const LASTS: Duration = Duration::from_secs(825 * 24 * 3600);
/// How near its end a start makes it anew, so a running HMI seldom outlives it.
const RENEW: Duration = Duration::from_secs(30 * 24 * 3600);

/// Where the certificate comes from.
pub enum Certificate {
    /// The HMI's own, kept in this folder.
    Own(PathBuf),
    /// A real one, as PEM files.
    Given { cert: PathBuf, key: PathBuf },
}

/// What answers a TLS hello.
pub fn acceptor(from: &Certificate) -> Result<TlsAcceptor> {
    let (cert, key) = match from {
        Certificate::Own(dir) => own(dir)?,
        Certificate::Given { cert, key } => (cert.clone(), key.clone()),
    };
    let chain = CertificateDer::pem_file_iter(&cert).and_then(|c| c.collect::<Result<Vec<_>, _>>()).with_context(|| format!("could not read the certificate {}", cert.display()))?;
    let key = PrivateKeyDer::from_pem_file(&key).with_context(|| format!("could not read the key {}", key.display()))?;
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider).with_safe_default_protocol_versions()?.with_no_client_auth().with_single_cert(chain, key)?;
    // the server speaks only http/1.1, which a WebSocket upgrade needs too
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// The HMI's own certificate and key files in `dir`, made anew when missing, unreadable or near
/// their end. A new one is never made for a new address, as that would undo every browser's
/// trust in the old.
fn own(dir: &Path) -> Result<(PathBuf, PathBuf)> {
    let (cert, key) = (dir.join("cert.pem"), dir.join("key.pem"));
    if !lasting(&cert) || !key.exists() {
        std::fs::create_dir_all(dir).with_context(|| format!("could not make {}", dir.display()))?;
        let (pem, key_pem) = make(SystemTime::now() + LASTS)?;
        std::fs::write(&key, key_pem).with_context(|| format!("could not write {}", key.display()))?;
        std::fs::write(&cert, pem).with_context(|| format!("could not write {}", cert.display()))?;
        info!("made the HMI's own certificate in {}", dir.display());
    }
    Ok((cert, key))
}

/// Whether the certificate at `path` reads and lasts a while yet.
fn lasting(path: &Path) -> bool {
    let end = || -> Option<Duration> {
        let der = CertificateDer::from_pem_file(path).ok()?;
        let cert = x509_cert::Certificate::from_der(&der).ok()?;
        Some(cert.tbs_certificate.validity.not_after.to_unix_duration())
    };
    end().is_some_and(|end| SystemTime::UNIX_EPOCH + end > SystemTime::now() + RENEW)
}

/// A self signed certificate until `until`, and its key, as PEM. It names this host as a screen
/// may reach it: localhost, the host's name, and its addresses now.
fn make(until: SystemTime) -> Result<(String, String)> {
    let mut names = vec!["localhost".to_owned()];
    if let Some(host) = host_name() {
        names.extend([format!("{host}.local"), host]);
    }
    let mut addresses: Vec<IpAddr> = vec![Ipv4Addr::LOCALHOST.into(), Ipv6Addr::LOCALHOST.into()];
    addresses.extend(if_addrs::get_if_addrs().unwrap_or_default().into_iter().map(|i| i.ip()));
    addresses.sort();
    addresses.dedup();
    names.extend(addresses.iter().map(IpAddr::to_string));
    let mut params = CertificateParams::new(names)?;
    params.distinguished_name.push(DnType::CommonName, "Rant HMI");
    let since = SystemTime::now() - Duration::from_secs(24 * 3600);
    params.not_before = since.into();
    params.not_after = until.into();
    let key = KeyPair::generate()?;
    let cert = params.self_signed(&key).map_err(|e| anyhow!("could not make a certificate: {e}"))?;
    Ok((cert.pem(), key.serialize_pem()))
}

/// This host's name, where the system tells it.
fn host_name() -> Option<String> {
    let name = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok();
    let name = name.or_else(|| std::fs::read_to_string("/etc/hostname").ok());
    name.map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rant-hmi-tls-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_own_certificate_is_kept_until_near_its_end() {
        let dir = temp("own");
        acceptor(&Certificate::Own(dir.clone())).unwrap();
        let first = std::fs::read(dir.join("cert.pem")).unwrap();
        acceptor(&Certificate::Own(dir.clone())).unwrap();
        assert_eq!(std::fs::read(dir.join("cert.pem")).unwrap(), first, "a second start keeps it");
        let (near, _) = make(SystemTime::now() + RENEW / 2).unwrap();
        std::fs::write(dir.join("cert.pem"), &near).unwrap();
        acceptor(&Certificate::Own(dir.clone())).unwrap();
        assert_ne!(std::fs::read_to_string(dir.join("cert.pem")).unwrap(), near, "one near its end is made anew");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_given_certificate_must_read() {
        let dir = temp("given");
        std::fs::create_dir_all(&dir).unwrap();
        let (cert, key) = make(SystemTime::now() + LASTS).unwrap();
        std::fs::write(dir.join("c.pem"), cert).unwrap();
        std::fs::write(dir.join("k.pem"), key).unwrap();
        let given = |cert: &str, key: &str| acceptor(&Certificate::Given { cert: dir.join(cert), key: dir.join(key) }).err().map(|e| e.to_string());
        assert_eq!(given("c.pem", "k.pem"), None);
        assert!(given("c.pem", "none.pem").is_some_and(|e| e.contains("could not read the key")));
        assert!(given("k.pem", "k.pem").is_some(), "a key is no certificate");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

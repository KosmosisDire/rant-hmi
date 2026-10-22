//! Apps built for a device, which the editor downloads. An app is the launcher and runtime made
//! for the device's platform, then the project or this server's address, its settings and a
//! trailer, joined as one file and streamed, so any server builds for any platform with no
//! compiler. docs/design/native-app.md weighs it.

use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{self, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use futures_util::StreamExt;
use futures_util::stream;
use rant_hmi_pack::{Settings, Shows, Trailer, archive, id};
use serde::{Deserialize, Serialize};
use tokio_util::io::ReaderStream;

use crate::project::Project;

/// The platforms an app is built for, each with what a person calls it.
const TARGETS: [(&str, &str); 4] = [("windows-x64", "Windows"), ("linux-x64", "Linux"), ("linux-arm64", "Linux on ARM"), ("macos-arm64", "macOS")];

/// What the server builds apps from.
#[derive(Clone)]
pub struct Apps {
    /// The project an app built to run on its device carries.
    pub project: PathBuf,
    /// Where the runtimes for this version are, a folder for each platform holding
    /// `launcher[.exe]`, `runtime.tar.gz` and `runtime.id`.
    pub runtimes: PathBuf,
    pub domain: u16,
    pub loopback: bool,
    /// The fingerprint of this server's certificate, which an app showing its screen trusts.
    pub trust: Option<String>,
}

/// A platform an app is built for, and whether this server has its runtime.
#[derive(Serialize)]
struct Target {
    target: &'static str,
    label: &'static str,
    ready: bool,
}

/// What an app is asked to run, from the editor's sheet.
#[derive(Deserialize)]
struct Ask {
    runs: Runs,
    #[serde(default)]
    fullscreen: bool,
    /// Where the device reached this server, which an app showing its screen goes back to.
    address: Option<String>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Runs {
    /// The HMI on the device, its backend in the app.
    Device,
    /// This server's screen.
    Screen,
}

/// `/app/targets` lists the platforms, and `/app/<platform>` downloads an app for one.
pub fn router(apps: Apps) -> Router {
    Router::new().route("/app/targets", get(targets)).route("/app/{target}", get(build)).with_state(apps)
}

async fn targets(State(apps): State<Apps>) -> Json<Vec<Target>> {
    Json(TARGETS.iter().map(|&(target, label)| Target { target, label, ready: Runtime::of(&apps.runtimes, target).is_some() }).collect())
}

async fn build(State(apps): State<Apps>, extract::Path(target): extract::Path<String>, Query(ask): Query<Ask>) -> Response {
    let Some(&(target, label)) = TARGETS.iter().find(|(t, _)| *t == target) else {
        return (StatusCode::NOT_FOUND, format!("there is no platform {target}")).into_response();
    };
    let Some(runtime) = Runtime::of(&apps.runtimes, target) else {
        return (StatusCode::NOT_FOUND, format!("this server has no runtime for {label}")).into_response();
    };
    let shows = match (&ask.runs, &ask.address) {
        (Runs::Device, _) => None,
        (Runs::Screen, Some(a)) if a.starts_with("http://") || a.starts_with("https://") => Some(a.trim_end_matches('/').to_owned()),
        (Runs::Screen, _) => return (StatusCode::BAD_REQUEST, "an app showing this server's screen needs the address it is reached at").into_response(),
    };
    match app(&apps, &runtime, shows, ask.fullscreen).await {
        Ok((name, len, body)) => {
            let file = format!("{name}{}", if target.starts_with("windows") { ".exe" } else { "" });
            ([(header::CONTENT_TYPE, "application/octet-stream".to_owned()), (header::CONTENT_LENGTH, len.to_string()), (header::CONTENT_DISPOSITION, attachment(&file))], body).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
}

/// A runtime this server builds apps from.
struct Runtime {
    launcher: PathBuf,
    archive: PathBuf,
    id: String,
}

impl Runtime {
    fn of(runtimes: &Path, target: &str) -> Option<Runtime> {
        let dir = runtimes.join(target);
        let launcher = ["launcher.exe", "launcher"].into_iter().map(|f| dir.join(f)).find(|f| f.is_file())?;
        let archive = dir.join("runtime.tar.gz");
        let id = std::fs::read_to_string(dir.join("runtime.id")).ok()?.trim().to_owned();
        (archive.is_file() && !id.is_empty()).then_some(Runtime { launcher, archive, id })
    }
}

/// The app's name, its length, and its bytes as they stream: the launcher and runtime from their
/// files, then the project, the settings and the trailer, made now.
async fn app(apps: &Apps, runtime: &Runtime, address: Option<String>, fullscreen: bool) -> Result<(String, u64, Body)> {
    let name = Project::open(&apps.project)?.info.name;
    let launcher = tokio::fs::File::open(&runtime.launcher).await.with_context(|| format!("could not open {}", runtime.launcher.display()))?;
    let archived = tokio::fs::File::open(&runtime.archive).await.with_context(|| format!("could not open {}", runtime.archive.display()))?;
    let start = launcher.metadata().await?.len();
    let runtime_range = start..start + archived.metadata().await?.len();
    let (project, shows, trust) = match address {
        Some(a) => {
            let trust = if a.starts_with("https://") { apps.trust.clone() } else { None };
            (Vec::new(), Shows::Address(a), trust)
        }
        None => {
            let mut project = Vec::new();
            archive(&apps.project, &mut project).with_context(|| format!("could not archive {}", apps.project.display()))?;
            let pack = id(&project);
            (project, Shows::Project(pack), None)
        }
    };
    let settings = Settings { name: name.clone(), runtime: runtime.id.clone(), shows, domain: domain(apps.domain), loopback: apps.loopback, fullscreen, trust };
    let settings = serde_json::to_vec(&settings)?;
    let project_range = runtime_range.end..runtime_range.end + project.len() as u64;
    let settings_range = project_range.end..project_range.end + settings.len() as u64;
    let mut tail = project;
    tail.extend(&settings);
    Trailer { runtime: runtime_range, project: project_range, settings: settings_range.clone() }.write(&mut tail)?;
    let len = settings_range.end + Trailer::LEN;
    let tail = stream::once(async move { Ok::<_, io::Error>(Bytes::from(tail)) });
    Ok((name, len, Body::from_stream(ReaderStream::new(launcher).chain(ReaderStream::new(archived)).chain(tail))))
}

/// The domain this server's node is on, as Rant reads 0: `RANT_DOMAIN`, else 0. An app joins
/// the server's domain, not one its device names.
fn domain(given: u16) -> u16 {
    if given != 0 {
        return given;
    }
    std::env::var("RANT_DOMAIN").ok().and_then(|d| d.parse().ok()).unwrap_or(0)
}

/// A download named `file`: its name as UTF-8, and plain ASCII for a browser that takes no more.
fn attachment(file: &str) -> String {
    let plain: String = file.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' }).collect();
    let encoded: String = file.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    format!("attachment; filename=\"{plain}\"; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use rant_hmi_pack::{read, unpacked};
    use std::io::Cursor;
    use tower::ServiceExt;

    /// A project, and a runtime for Windows only, in a folder of their own.
    fn apps(name: &str) -> (Apps, PathBuf) {
        let dir = std::env::temp_dir().join(format!("rant-hmi-apps-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let project = dir.join("project");
        std::fs::create_dir_all(project.join("pages")).unwrap();
        std::fs::write(project.join("hmi.toml"), "name = \"Packing line\"\n").unwrap();
        std::fs::write(project.join("pages").join("main.html"), "<page name=\"main\"/>\n").unwrap();
        let windows = dir.join("runtimes").join("windows-x64");
        std::fs::create_dir_all(dir.join("runtime").join("resources")).unwrap();
        std::fs::write(dir.join("runtime").join("electron.exe"), "ELECTRON").unwrap();
        std::fs::create_dir_all(&windows).unwrap();
        std::fs::write(windows.join("launcher.exe"), "LAUNCHER").unwrap();
        let mut runtime = Vec::new();
        archive(&dir.join("runtime"), &mut runtime).unwrap();
        std::fs::write(windows.join("runtime.id"), id(&runtime)).unwrap();
        std::fs::write(windows.join("runtime.tar.gz"), &runtime).unwrap();
        let apps = Apps { project, runtimes: dir.join("runtimes"), domain: 153, loopback: true, trust: Some("sha256/abc".into()) };
        (apps, dir)
    }

    async fn get(apps: &Apps, uri: &str) -> (StatusCode, Option<String>, Vec<u8>) {
        let response = router(apps.clone()).oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        let disposition = response.headers().get(header::CONTENT_DISPOSITION).map(|d| d.to_str().unwrap().to_owned());
        (response.status(), disposition, to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec())
    }

    #[tokio::test]
    async fn an_app_carries_the_launcher_its_runtime_and_the_project() {
        let (apps, dir) = apps("device");
        let (status, disposition, body) = get(&apps, "/app/windows-x64?runs=device&fullscreen=true").await;
        assert_eq!(status, StatusCode::OK);
        assert!(disposition.unwrap().contains("filename*=UTF-8''Packing%20line.exe"));
        assert_eq!(&body[..8], b"LAUNCHER");
        let mut file = Cursor::new(body);
        let t = Trailer::read(&mut file).unwrap().expect("a trailer");
        let settings: Settings = serde_json::from_slice(&read(&mut file, &t.settings).unwrap()).unwrap();
        let Shows::Project(pack) = &settings.shows else { panic!("an app for the device carries the project") };
        assert_eq!((settings.name.as_str(), settings.domain, settings.loopback, settings.fullscreen, &settings.trust), ("Packing line", 153, true, true, &None));
        let into = dir.join("unpacked");
        unpacked(&mut file, &t.runtime, &into.join(&settings.runtime)).unwrap();
        unpacked(&mut file, &t.project, &into.join(pack)).unwrap();
        assert_eq!(std::fs::read_to_string(into.join(&settings.runtime).join("electron.exe")).unwrap(), "ELECTRON");
        assert_eq!(std::fs::read_to_string(into.join(pack).join("pages").join("main.html")).unwrap(), "<page name=\"main\"/>\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn an_app_showing_the_screen_trusts_this_server_over_https() {
        let (apps, dir) = apps("screen");
        for (address, trust) in [("https://host:6739/", Some("sha256/abc".to_owned())), ("http://host:6739", None)] {
            let (status, _, body) = get(&apps, &format!("/app/windows-x64?runs=screen&address={}", address.replace(':', "%3A").replace('/', "%2F"))).await;
            assert_eq!(status, StatusCode::OK);
            let mut file = Cursor::new(body);
            let t = Trailer::read(&mut file).unwrap().unwrap();
            assert!(t.project.is_empty(), "no project goes with the screen");
            let settings: Settings = serde_json::from_slice(&read(&mut file, &t.settings).unwrap()).unwrap();
            assert_eq!(settings.shows, Shows::Address(address.trim_end_matches('/').to_owned()));
            assert_eq!(settings.trust, trust);
        }
        assert_eq!(get(&apps, "/app/windows-x64?runs=screen").await.0, StatusCode::BAD_REQUEST);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_platform_with_no_runtime_here_is_not_ready() {
        let (apps, dir) = apps("targets");
        let (_, _, body) = get(&apps, "/app/targets").await;
        let listed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let ready: Vec<_> = listed.as_array().unwrap().iter().filter(|t| t["ready"] == true).map(|t| t["target"].as_str().unwrap()).collect();
        assert_eq!(ready, ["windows-x64"]);
        assert_eq!(get(&apps, "/app/linux-x64?runs=device").await.0, StatusCode::NOT_FOUND);
        assert_eq!(get(&apps, "/app/amiga?runs=device").await.0, StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

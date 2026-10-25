//! Apps built for a device, which the editor downloads. An app is the launcher and runtime made
//! for the device's platform, then the project or this server's address, its settings and a
//! trailer, joined as one file and streamed, so any server builds for any platform with no
//! compiler. A platform's runtime comes from the HMI's release the first time an app needs it.
//! docs/design/native-app.md weighs it.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{self, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use futures_util::StreamExt;
use futures_util::stream;
use rant_hmi_pack::{Settings, Shows, Trailer, archive, id, id_of, unpack_whole};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;
use tokio_util::io::ReaderStream;

use crate::project::Project;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A platform an app is built for.
struct Platform {
    target: &'static str,
    /// What a person calls it.
    label: &'static str,
    /// The release attaches its runtime.
    released: bool,
}

static PLATFORMS: [Platform; 4] = [
    Platform { target: "win-x64", label: "Windows", released: true },
    Platform { target: "linux-x64", label: "Linux", released: true },
    Platform { target: "linux-arm64", label: "Linux on ARM", released: true },
    Platform { target: "osx-arm64", label: "macOS", released: false },
];

/// Where this version's release keeps the runtime files it attaches.
pub fn release() -> String {
    format!("https://github.com/KosmosisDire/rant-hmi/releases/download/v{VERSION}")
}

/// The file a release attaches for `target`: its launcher, runtime.tar.gz and runtime.id, archived.
fn release_file(target: &str) -> String {
    format!("rant-hmi-runtime-{VERSION}-{target}.tar.gz")
}

/// What the server builds apps from.
#[derive(Clone)]
pub struct Apps {
    /// The project an app built to run on its device carries.
    pub project: PathBuf,
    /// Where the runtimes for this version are: a folder for each platform holding
    /// `launcher[.exe]`, `runtime.tar.gz` and `runtime.id`, or the file its release attaches.
    pub runtimes: PathBuf,
    /// Where the files a release attaches are fetched from, `release()` but for a mirror.
    pub from: String,
    pub domain: u16,
    pub loopback: bool,
    /// The fingerprint of this server's certificate, which an app showing its screen trusts.
    pub trust: Option<String>,
    pub getting: Getting,
}

/// The runtimes being got, by platform, which each ask for one joins.
#[derive(Clone, Default)]
pub struct Getting(Arc<Mutex<HashMap<&'static str, watch::Receiver<Progress>>>>);

/// Whether this server has a platform's runtime.
#[derive(Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Has {
    /// Here, unpacked or as the file its release attaches.
    Here,
    /// On the release, which an app needing it gets it from first.
    Release,
    None,
}

/// A platform an app is built for, and whether this server has its runtime.
#[derive(Serialize)]
struct Target {
    target: &'static str,
    label: &'static str,
    runtime: Has,
}

/// How getting a runtime goes.
#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum Progress {
    /// Fetching it from the release, `got` of its `of` bytes so far.
    Fetching { got: u64, of: Option<u64> },
    /// Unpacking it and checking it is whole.
    Unpacking,
    Done,
    Failed { error: String },
}

impl Progress {
    fn ended(&self) -> bool {
        matches!(self, Progress::Done | Progress::Failed { .. })
    }
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

/// `/app/targets` lists the platforms, `/app/<platform>` downloads an app for one, and
/// `/app/<platform>/runtime` gets its runtime ahead, telling how that goes.
pub fn router(apps: Apps) -> Router {
    Router::new()
        .route("/app/targets", get(targets))
        .route("/app/{target}", get(build))
        .route("/app/{target}/runtime", post(fetch))
        .with_state(apps)
}

fn platform(target: &str) -> Option<&'static Platform> {
    PLATFORMS.iter().find(|p| p.target == target)
}

fn no_platform(target: &str) -> Response {
    (StatusCode::NOT_FOUND, format!("there is no platform {target}")).into_response()
}

async fn targets(State(apps): State<Apps>) -> Json<Vec<Target>> {
    Json(PLATFORMS.iter().map(|p| Target { target: p.target, label: p.label, runtime: apps.has(p) }).collect())
}

async fn build(State(apps): State<Apps>, extract::Path(target): extract::Path<String>, Query(ask): Query<Ask>) -> Response {
    let Some(p) = platform(&target) else { return no_platform(&target) };
    if apps.has(p) == Has::None {
        return (StatusCode::NOT_FOUND, format!("this server has no runtime for {}", p.label)).into_response();
    }
    let shows = match (&ask.runs, &ask.address) {
        (Runs::Device, _) => None,
        (Runs::Screen, Some(a)) if a.starts_with("http://") || a.starts_with("https://") => Some(a.trim_end_matches('/').to_owned()),
        (Runs::Screen, _) => return (StatusCode::BAD_REQUEST, "an app showing this server's screen needs the address it is reached at").into_response(),
    };
    let runtime = match apps.runtime(p).await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("{e:#}")).into_response(),
    };
    match app(&apps, &runtime, shows, ask.fullscreen).await {
        Ok((name, len, body)) => {
            let file = format!("{name}{}", if p.target.starts_with("win-") { ".exe" } else { "" });
            ([(header::CONTENT_TYPE, "application/octet-stream".to_owned()), (header::CONTENT_LENGTH, len.to_string()), (header::CONTENT_DISPOSITION, attachment(&file))], body).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
}

/// Gets a platform's runtime unless it is here, answering a line of JSON each time how that goes
/// changes, the last done or failed.
async fn fetch(State(apps): State<Apps>, extract::Path(target): extract::Path<String>) -> Response {
    let Some(p) = platform(&target) else { return no_platform(&target) };
    let lines = stream::unfold(Some((apps.getting(p), true)), |next| async move {
        let (mut progress, first) = next?;
        if !first {
            progress.changed().await.ok()?;
        }
        let now = progress.borrow_and_update().clone();
        let line = Bytes::from(format!("{}\n", serde_json::to_string(&now).expect("progress is JSON")));
        Some((Ok::<_, io::Error>(line), (!now.ended()).then_some((progress, false))))
    });
    ([(header::CONTENT_TYPE, "application/x-ndjson")], Body::from_stream(lines)).into_response()
}

impl Apps {
    fn has(&self, p: &Platform) -> Has {
        if Runtime::at(&self.runtimes.join(p.target)).is_some() || self.runtimes.join(release_file(p.target)).is_file() {
            Has::Here
        } else if p.released {
            Has::Release
        } else {
            Has::None
        }
    }

    /// The runtime for `p`, got first when it is not here.
    async fn runtime(&self, p: &'static Platform) -> Result<Runtime> {
        let dir = self.runtimes.join(p.target);
        if let Some(r) = Runtime::at(&dir) {
            return Ok(r);
        }
        if let Progress::Failed { error } = &*self.getting(p).wait_for(Progress::ended).await? {
            bail!("{error}");
        }
        Runtime::at(&dir).ok_or_else(|| anyhow!("there is no runtime in {}", dir.display()))
    }

    /// Starts getting the runtime for `p`, or joins the getting of it under way.
    fn getting(&self, p: &'static Platform) -> watch::Receiver<Progress> {
        let mut under_way = self.getting.0.lock().expect("never held through a panic");
        if let Some(progress) = under_way.get(p.target) {
            return progress.clone();
        }
        let (tell, progress) = watch::channel(Progress::Fetching { got: 0, of: None });
        under_way.insert(p.target, progress.clone());
        let apps = self.clone();
        tokio::spawn(async move {
            let end = match apps.get(p, &tell).await {
                Ok(()) => Progress::Done,
                Err(e) => Progress::Failed { error: format!("{e:#}") },
            };
            apps.getting.0.lock().expect("never held through a panic").remove(p.target);
            tell.send_replace(end);
        });
        progress
    }

    /// Puts the runtime for `p` here: fetched from the release unless its file is here already,
    /// unpacked beside where it goes and checked whole, then moved in.
    async fn get(&self, p: &Platform, progress: &watch::Sender<Progress>) -> Result<()> {
        let dir = self.runtimes.join(p.target);
        if Runtime::at(&dir).is_some() {
            return Ok(());
        }
        let name = release_file(p.target);
        let file = self.runtimes.join(&name);
        let fetched = !file.is_file();
        if fetched {
            if !p.released {
                bail!("this server has no runtime for {}", p.label);
            }
            let url = format!("{}/{name}", self.from.trim_end_matches('/'));
            if let Err(e) = fetch_file(&url, &file, progress).await {
                bail!("could not fetch {url}: {e:#}. Put {name} from the HMI's release in {} by hand and try again", self.runtimes.display());
            }
        }
        progress.send_replace(Progress::Unpacking);
        let (from, into) = (file.clone(), dir.clone());
        let unpacked = tokio::task::spawn_blocking(move || {
            // a folder short of a file, as one left by hand, makes way
            if into.exists() {
                std::fs::remove_dir_all(&into)?;
            }
            unpack_whole(std::fs::File::open(&from)?, &into, whole)
        })
        .await?;
        // a file put here by hand stays until it works, while a fetched one goes, as fetching again may mend it
        if fetched || unpacked.is_ok() {
            let _ = std::fs::remove_file(&file);
        }
        unpacked.with_context(|| format!("could not unpack {} into {}", file.display(), dir.display()))
    }
}

/// Whether the runtime unpacked in `dir` is whole: its archive is the one its id names.
fn whole(dir: &Path) -> io::Result<()> {
    let r = Runtime::at(dir).ok_or_else(|| io::Error::other("it holds no launcher, runtime.tar.gz and runtime.id"))?;
    if id_of(std::fs::File::open(&r.archive)?)? != r.id {
        return Err(io::Error::other("its runtime.tar.gz is not the one its runtime.id names"));
    }
    Ok(())
}

/// Fetches `url` into `file` by way of a `.part` file beside it, so it lands only whole.
async fn fetch_file(url: &str, file: &Path, progress: &watch::Sender<Progress>) -> Result<()> {
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).read_timeout(Duration::from_secs(60)).build()?;
    // the message says the address once, ahead of why
    let response = client.get(url).send().await.and_then(reqwest::Response::error_for_status).map_err(reqwest::Error::without_url)?;
    let of = response.content_length();
    let mut part = OsString::from(file);
    part.push(".part");
    let part = PathBuf::from(part);
    if let Some(dir) = file.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let written = async {
        let mut out = tokio::fs::File::create(&part).await?;
        let mut body = response.bytes_stream();
        let (mut got, mut told) = (0, Instant::now());
        while let Some(piece) = body.next().await {
            let piece = piece.map_err(reqwest::Error::without_url)?;
            out.write_all(&piece).await?;
            got += piece.len() as u64;
            // a tenth of a second apart, as a person sees it move and a slow screen keeps up
            if told.elapsed() >= Duration::from_millis(100) {
                progress.send_replace(Progress::Fetching { got, of });
                told = Instant::now();
            }
        }
        out.flush().await?;
        match of {
            Some(of) if of != got => bail!("it ended after {got} of its {of} bytes"),
            _ => anyhow::Ok(()),
        }
    }
    .await;
    match written {
        Ok(()) => Ok(tokio::fs::rename(&part, file).await?),
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(e)
        }
    }
}

/// A runtime this server builds apps from.
struct Runtime {
    launcher: PathBuf,
    archive: PathBuf,
    id: String,
}

impl Runtime {
    /// The runtime in `dir`, when all of it is there.
    fn at(dir: &Path) -> Option<Runtime> {
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    /// A project, and a runtime for Windows only, in a folder of their own.
    fn apps(name: &str) -> (Apps, PathBuf) {
        let dir = std::env::temp_dir().join(format!("rant-hmi-apps-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let project = dir.join("project");
        std::fs::create_dir_all(project.join("pages")).unwrap();
        std::fs::write(project.join("hmi.toml"), "name = \"Packing line\"\n").unwrap();
        std::fs::write(project.join("pages").join("main.html"), "<page name=\"main\"/>\n").unwrap();
        let windows = dir.join("runtimes").join("win-x64");
        std::fs::create_dir_all(dir.join("runtime").join("resources")).unwrap();
        std::fs::write(dir.join("runtime").join("electron.exe"), "ELECTRON").unwrap();
        std::fs::create_dir_all(&windows).unwrap();
        std::fs::write(windows.join("launcher.exe"), "LAUNCHER").unwrap();
        let mut runtime = Vec::new();
        archive(&dir.join("runtime"), &mut runtime).unwrap();
        std::fs::write(windows.join("runtime.id"), id(&runtime)).unwrap();
        std::fs::write(windows.join("runtime.tar.gz"), &runtime).unwrap();
        let apps = Apps { project, runtimes: dir.join("runtimes"), from: String::new(), domain: 153, loopback: true, trust: Some("sha256/abc".into()), getting: Getting::default() };
        (apps, dir)
    }

    /// The file a release attaches, as runtime.mjs packs it: a launcher, the runtime and its id,
    /// or the id `named` in place of its own.
    fn attached(dir: &Path, named: Option<&str>) -> Vec<u8> {
        let stage = dir.join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("launcher"), "LAUNCHER").unwrap();
        let mut runtime = Vec::new();
        archive(&dir.join("runtime"), &mut runtime).unwrap();
        std::fs::write(stage.join("runtime.id"), named.map(str::to_owned).unwrap_or_else(|| id(&runtime))).unwrap();
        std::fs::write(stage.join("runtime.tar.gz"), &runtime).unwrap();
        let mut file = Vec::new();
        archive(&stage, &mut file).unwrap();
        std::fs::remove_dir_all(&stage).unwrap();
        file
    }

    /// A release on loopback attaching `file` for Linux and nothing else, and how often it was asked.
    async fn release(file: Vec<u8>) -> (String, Arc<AtomicUsize>) {
        let asked = Arc::new(AtomicUsize::new(0));
        let counted = asked.clone();
        let router = Router::new().route(
            &format!("/{}", release_file("linux-x64")),
            axum::routing::get(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                std::future::ready(file.clone())
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let at = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (at, asked)
    }

    async fn get(apps: &Apps, uri: &str) -> (StatusCode, Option<String>, Vec<u8>) {
        let response = router(apps.clone()).oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        let disposition = response.headers().get(header::CONTENT_DISPOSITION).map(|d| d.to_str().unwrap().to_owned());
        (response.status(), disposition, to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec())
    }

    /// The lines a runtime's getting told, to the last.
    async fn fetched(apps: &Apps, target: &str) -> Vec<serde_json::Value> {
        let response = router(apps.clone()).oneshot(Request::post(format!("/app/{target}/runtime")).body(Body::empty()).unwrap()).await.unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        body.split(|&b| b == b'\n').filter(|l| !l.is_empty()).map(|l| serde_json::from_slice(l).unwrap()).collect()
    }

    /// Whether the server says it has `target`'s runtime.
    async fn has(apps: &Apps, target: &str) -> String {
        let listed: serde_json::Value = serde_json::from_slice(&get(apps, "/app/targets").await.2).unwrap();
        listed.as_array().unwrap().iter().find(|t| t["target"] == target).unwrap()["runtime"].as_str().unwrap().to_owned()
    }

    /// What the runtimes folder holds.
    fn holds(apps: &Apps) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(&apps.runtimes).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn an_app_carries_the_launcher_its_runtime_and_the_project() {
        let (apps, dir) = apps("device");
        let (status, disposition, body) = get(&apps, "/app/win-x64?runs=device&fullscreen=true").await;
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
            let (status, _, body) = get(&apps, &format!("/app/win-x64?runs=screen&address={}", address.replace(':', "%3A").replace('/', "%2F"))).await;
            assert_eq!(status, StatusCode::OK);
            let mut file = Cursor::new(body);
            let t = Trailer::read(&mut file).unwrap().unwrap();
            assert!(t.project.is_empty(), "no project goes with the screen");
            let settings: Settings = serde_json::from_slice(&read(&mut file, &t.settings).unwrap()).unwrap();
            assert_eq!(settings.shows, Shows::Address(address.trim_end_matches('/').to_owned()));
            assert_eq!(settings.trust, trust);
        }
        assert_eq!(get(&apps, "/app/win-x64?runs=screen").await.0, StatusCode::BAD_REQUEST);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn each_platform_says_where_its_runtime_is() {
        let (apps, dir) = apps("targets");
        for (target, runtime) in [("win-x64", "here"), ("linux-x64", "release"), ("linux-arm64", "release"), ("osx-arm64", "none")] {
            assert_eq!(has(&apps, target).await, runtime, "{target}");
        }
        assert_eq!(get(&apps, "/app/osx-arm64?runs=device").await.0, StatusCode::NOT_FOUND);
        assert_eq!(get(&apps, "/app/amiga?runs=device").await.0, StatusCode::NOT_FOUND);
        let told = fetched(&apps, "osx-arm64").await;
        assert_eq!(told.last().unwrap()["error"], "this server has no runtime for macOS");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_runtime_on_the_release_is_fetched_once_for_every_ask() {
        let (mut apps, dir) = apps("fetch");
        let (from, asked) = release(attached(&dir, None)).await;
        apps.from = from;
        let (a, b) = tokio::join!(fetched(&apps, "linux-x64"), fetched(&apps, "linux-x64"));
        for told in [a, b] {
            assert_eq!(told.last().unwrap()["state"], "done", "{told:?}");
        }
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        assert_eq!(has(&apps, "linux-x64").await, "here");
        assert_eq!(holds(&apps), ["linux-x64", "win-x64"], "nothing is left but the runtimes");
        let (status, disposition, body) = get(&apps, "/app/linux-x64?runs=device").await;
        assert_eq!(status, StatusCode::OK);
        assert!(disposition.unwrap().ends_with("UTF-8''Packing%20line"), "a Linux app has no ending");
        assert_eq!(&body[..8], b"LAUNCHER");
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_damaged_runtime_is_refused_and_leaves_nothing() {
        let (mut apps, dir) = apps("damaged");
        apps.from = release(attached(&dir, Some("00000000000000000000000000000000"))).await.0;
        let told = fetched(&apps, "linux-x64").await;
        let error = told.last().unwrap()["error"].as_str().unwrap().to_owned();
        assert!(error.ends_with("its runtime.tar.gz is not the one its runtime.id names"), "{error}");
        assert_eq!(holds(&apps), ["win-x64"]);
        assert_eq!(has(&apps, "linux-x64").await, "release", "a fetched file that failed goes, as fetching again may mend it");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_release_out_of_reach_says_which_file_goes_where() {
        let (mut apps, dir) = apps("by-hand");
        apps.from = release(attached(&dir, None)).await.0;
        let name = release_file("linux-arm64");
        let (status, _, body) = get(&apps, "/app/linux-arm64?runs=device").await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        let said = String::from_utf8(body).unwrap();
        assert!(said.contains("404") && said.contains(&format!("Put {name} from the HMI's release in {} by hand", apps.runtimes.display())), "{said}");
        // the file put there by hand, which the next app unpacks
        std::fs::write(apps.runtimes.join(&name), attached(&dir, None)).unwrap();
        assert_eq!(has(&apps, "linux-arm64").await, "here");
        assert_eq!(get(&apps, "/app/linux-arm64?runs=device").await.0, StatusCode::OK);
        assert_eq!(holds(&apps), ["linux-arm64", "win-x64"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

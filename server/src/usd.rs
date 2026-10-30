//! A USD robot as a screen draws it: its links as a glTF binary model, and its joints in the
//! scene's extras so a screen moves the links by joint values. docs/design/usd.md has the layout.

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use bytes::Bytes;
use openusd::ar::{self, Resolver};
use openusd::{gf, sdf, usd};
use openusd_schemas::geom::{Interpolation, Primvar, PrimvarsAPI, XformCache};
use openusd_schemas::shade::MaterialBindingAPI;
use serde_json::{Value, json};

/// A robot made into a model, and every file it read, whose times say when to make it again.
pub struct Made {
    pub glb: Vec<u8>,
    pub read: Vec<PathBuf>,
    /// Whether it holds the whole robot with no problems.
    pub whole: bool,
}

/// Models made from USD files, each kept until a file it read changes.
#[derive(Default)]
pub struct Robots {
    kept: Mutex<HashMap<PathBuf, Kept>>,
}

struct Kept {
    glb: Bytes,
    tag: String,
    times: Vec<(PathBuf, Option<SystemTime>)>,
}

impl Robots {
    /// The model for a USD file and a tag that changes with it. One with problems is made again
    /// each time, as a file it could not find may come. The error is for the user.
    pub fn model(&self, file: &Path, folder: &Path) -> Result<(Bytes, String), String> {
        let modified = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
        if let Some(kept) = self.kept.lock().unwrap().get(file)
            && kept.times.iter().all(|(p, t)| modified(p) == *t)
        {
            return Ok((kept.glb.clone(), kept.tag.clone()));
        }
        let made = make(file, folder)?;
        let times: Vec<_> = made.read.iter().map(|p| (p.clone(), modified(p))).collect();
        let mut hash = DefaultHasher::new();
        (file, &times, made.glb.len()).hash(&mut hash);
        let (glb, tag) = (Bytes::from(made.glb), format!("\"{:016x}\"", hash.finish()));
        let mut kept = self.kept.lock().unwrap();
        match made.whole {
            true => kept.insert(file.to_path_buf(), Kept { glb: glb.clone(), tag: tag.clone(), times }),
            false => kept.remove(file),
        };
        Ok((glb, tag))
    }
}

/// Makes the USD file a model. Only files inside `folder` are read, so a layer or texture that
/// names one outside it is left out as a problem. The error is for the user.
pub fn make(file: &Path, folder: &Path) -> Result<Made, String> {
    let folder = fs::canonicalize(folder).map_err(|e| format!("could not open the files folder: {e}"))?;
    let downloads = Arc::new(Mutex::new(Vec::new()));
    let inside = Inside::new(folder.clone(), downloads.clone());
    let stage = usd::Stage::builder()
        .resolver(inside)
        .schema_registry(openusd_schemas::schema_registry())
        .open(&file.to_string_lossy())
        .map_err(|e| format!("could not read it as USD: {e}"))?;
    let mut robot = Robot::new(&stage)?;
    let top = stage.prim("/").map_err(|e| e.to_string())?;
    for prim in children(&top) {
        robot.walk(&prim, None, false);
    }
    // a file is named from the files folder, as the page names it, a download spelled without \\?\
    let within = [folder.clone(), plain(&folder)].map(|f| format!("{}{}", f.display(), std::path::MAIN_SEPARATOR));
    let problems = stage.composition_errors().into_iter().map(|p| p.to_string());
    for problem in problems.chain(downloads.lock().unwrap().drain(..)) {
        robot.problems.insert(within.iter().fold(problem, |p, w| p.replace(w, "")));
    }
    let mut read: Vec<PathBuf> = stage.layer_identifiers().into_iter().map(PathBuf::from).filter(|p| p.is_file()).collect();
    let (glb, whole, images) = robot.finish(file)?;
    read.extend(images);
    Ok(Made { glb, read, whole })
}

/// Finds only files inside the files folder, so a robot never reads one outside it. A file on a
/// web server is downloaded into the folder's `downloaded` folder first, under its host and path.
struct Inside {
    folder: PathBuf,
    files: ar::DefaultResolver,
    /// Where downloads go, spelled as a file not there yet is.
    mirror: PathBuf,
    web: Mutex<Web>,
    problems: Arc<Mutex<Vec<String>>>,
}

/// What downloading for one model keeps.
#[derive(Default)]
struct Web {
    client: Option<reqwest::blocking::Client>,
    /// The scheme each host was named with, as the downloads folder keeps only the host.
    schemes: HashMap<String, String>,
    /// The addresses that failed and the hosts that never answered, each tried once.
    failed: HashSet<String>,
}

/// The files a model reads, the only ones worth downloading.
const FETCHED: [&str; 7] = ["usd", "usda", "usdc", "usdz", "png", "jpg", "jpeg"];

impl Inside {
    fn new(folder: PathBuf, problems: Arc<Mutex<Vec<String>>>) -> Self {
        let mirror = plain(&folder).join("downloaded");
        Inside { folder, files: ar::DefaultResolver::new(), mirror, web: Mutex::default(), problems }
    }

    /// The file a web address is downloaded to, `downloaded/<host>/<path>`, a port after `+`.
    /// None for anything but http and https.
    fn mirrored(&self, address: &str) -> Option<String> {
        // a layer's address may come with its slashes made one
        let (scheme, rest) = address.split_once(':')?;
        let scheme = scheme.to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return None;
        }
        let url = reqwest::Url::parse(&format!("{scheme}://{}", rest.trim_start_matches('/'))).ok()?;
        let host = url.host_str()?;
        let host = url.port().map_or_else(|| host.to_string(), |port| format!("{host}+{port}"));
        let mut file = self.mirror.join(&host);
        for segment in url.path_segments()? {
            if matches!(segment, "" | "." | "..") || segment.contains(['\\', ':', '*', '?', '"', '<', '>', '|']) {
                return None;
            }
            file.push(segment);
        }
        self.web.lock().unwrap().schemes.insert(host, scheme);
        Some(file.to_string_lossy().into_owned())
    }

    /// Downloads a file the downloads folder lacks from the address it stands for, by way of a
    /// `.part` file so only a whole one lands. A failure is a problem, and is not tried again.
    fn download(&self, file: &Path) {
        let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let Ok(rest) = file.strip_prefix(&self.mirror) else { return };
        let mut parts = rest.iter().map(|p| p.to_string_lossy().into_owned());
        let Some(host) = parts.next() else { return };
        let mut web = self.web.lock().unwrap();
        let scheme = web.schemes.get(&host).map_or("https", String::as_str);
        let address = format!("{scheme}://{}/{}", host.replace('+', ":"), parts.collect::<Vec<_>>().join("/"));
        if !FETCHED.contains(&ext.as_str()) || web.failed.contains(&address) || web.failed.contains(&host) {
            return;
        }
        if web.client.is_none() {
            match reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(60)).build() {
                Ok(client) => web.client = Some(client),
                Err(e) => return self.problems.lock().unwrap().push(format!("{address}: could not download it: {e}")),
            }
        }
        let Some(client) = &web.client else { return };
        tracing::info!("downloading {address}");
        if let Err((dead, why)) = fetch(client, &address, file) {
            self.problems.lock().unwrap().push(format!("{address}: could not download it: {why}"));
            web.failed.insert(if dead { host } else { address });
        }
    }
}

/// Fetches `address` into `file`. The error says whether the host never answered, and why.
fn fetch(client: &reqwest::blocking::Client, address: &str, file: &Path) -> Result<(), (bool, String)> {
    let failed = |e: reqwest::Error| (e.is_connect() || e.is_timeout(), e.without_url().to_string());
    let mut response = client.get(address).send().and_then(|r| r.error_for_status()).map_err(failed)?;
    let mut part = file.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    let written = file.parent().map_or(Ok(()), fs::create_dir_all).map_err(|e| (false, e.to_string())).and_then(|()| {
        let mut out = fs::File::create(&part).map_err(|e| (false, e.to_string()))?;
        response.copy_to(&mut out).map_err(failed)?;
        drop(out);
        fs::rename(&part, file).map_err(|e| (false, e.to_string()))
    });
    if written.is_err() {
        let _ = fs::remove_file(&part);
    }
    written
}

/// A path with its `.` and `..` worked out, never past its root.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            part => out.push(part),
        }
    }
    out
}

/// A path without Windows' `\\?\` in front, as a file not there yet is spelled.
fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

impl Resolver for Inside {
    fn create_identifier(&self, asset_path: &str, anchor: Option<&ar::ResolvedPath>) -> String {
        if let Some(file) = self.mirrored(asset_path) {
            return file;
        }
        let id = self.files.create_identifier(asset_path, anchor);
        // a bare name a download gives is the file beside it on its server, there yet or not
        let beside = anchor.map(|a| plain(a)).filter(|a| a.starts_with(&self.mirror) && Path::new(&id).is_relative());
        let id = match beside.as_deref().and_then(Path::parent) {
            Some(dir) => lexical(&dir.join(&id)).to_string_lossy().into_owned(),
            None => id,
        };
        // a download is named one way whether it is there yet or not
        let spelled = plain(Path::new(&id));
        match spelled.starts_with(&self.mirror) {
            true => spelled.to_string_lossy().into_owned(),
            false => id,
        }
    }
    fn resolve(&self, asset_path: &str) -> Option<ar::ResolvedPath> {
        let asset_path = self.mirrored(asset_path).map_or(Cow::Borrowed(asset_path), Cow::Owned);
        let wanted = plain(Path::new(&*asset_path));
        if wanted.starts_with(&self.mirror) && !wanted.exists() {
            self.download(&wanted);
        }
        let found = self.files.resolve(&asset_path)?;
        fs::canonicalize(&*found).is_ok_and(|real| real.starts_with(&self.folder)).then_some(found)
    }
    fn resolve_for_new_asset(&self, _asset_path: &str) -> Option<ar::ResolvedPath> {
        None
    }
    fn open_asset(&self, resolved_path: &ar::ResolvedPath) -> io::Result<Box<dyn ar::Asset>> {
        self.files.open_asset(resolved_path)
    }
    fn is_context_dependent_path(&self, asset_path: &str) -> bool {
        self.files.is_context_dependent_path(asset_path)
    }
    fn in_memory_identifier<'a>(&self, asset_path: &'a str) -> Cow<'a, str> {
        self.files.in_memory_identifier(asset_path)
    }
    fn identity(&self) -> String {
        format!("inside {}", self.folder.display())
    }
}

/// What reading the stage gathers into the model.
struct Robot<'s> {
    stage: &'s usd::Stage,
    xforms: XformCache,
    /// Prims a joint moves or that are rigid bodies, which become nodes under the root.
    bodies: HashSet<String>,
    joints: Vec<Joint>,
    /// The prims PhysicsArticulationRootAPI marks, each a robot's.
    roots: Vec<String>,
    /// The link nodes by prim path, each with its world transform at rest.
    links: HashMap<String, (usize, gf::Matrix4d)>,
    nodes: Vec<Value>,
    /// The root's children.
    top: Vec<usize>,
    /// The pieces read, by what makes two the same: an instance's prototype, else its prim.
    meshes: HashMap<String, usize>,
    pieces: Vec<Piece>,
    parts: Vec<Part>,
    mesh_list: Vec<Value>,
    looks: HashMap<String, Surface>,
    materials: HashMap<String, usize>,
    /// The materials by what they hold, as each copy of a prop brings its own copy of its look.
    contents: HashMap<String, usize>,
    material_list: Vec<Value>,
    images: HashMap<PathBuf, usize>,
    glb: Glb,
    problems: HashSet<String>,
}

/// A joint as the file says, with `parent` the world when it names no body.
struct Joint {
    name: String,
    path: String,
    kind: &'static str,
    parent: Option<String>,
    child: String,
    axis: [f64; 3],
    /// The joint's frame in the parent and in the child.
    frames: [(gf::Vec3f, gf::Quatf); 2],
    /// A loop's last joint, which the tree leaves out once the child has a parent.
    closes_loop: bool,
    /// The joint it follows, as a gripper's fingers follow the one driven, and how.
    mimic: Option<Mimic>,
}

/// PhysX's mimic joint: this joint's position plus `gearing` times the other's plus `offset` is 0.
struct Mimic {
    joint: String,
    gearing: f64,
    offset: f64,
}

/// A material as a glTF metallic roughness one.
#[derive(Clone)]
struct Surface {
    color: [f32; 4],
    texture: Option<PathBuf>,
    metallic: f32,
    roughness: f32,
}

/// How a part of a mesh looks: its bound material, else the mesh's display colour.
#[derive(Clone, PartialEq)]
enum Look {
    Bound(String),
    Plain([f32; 4]),
}

/// A shape's triangles before they are written, every face group with its own look.
#[derive(Default)]
struct Shape {
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    uvs: Vec<[f32; 2]>,
    colors: Vec<[f32; 3]>,
    groups: Vec<(usize, Vec<u32>)>,
}

/// A mesh or shape read once, however many places show it.
#[derive(Default)]
struct Piece {
    shape: Shape,
    looks: Vec<Look>,
    double: bool,
    name: String,
}

/// A place a piece shows: under a link node or the root, and where on it, none when its points
/// already say.
struct Part {
    piece: usize,
    link: Option<usize>,
    at: Option<gf::Matrix4d>,
}

/// What joins parts into one mesh: their link, material and attributes, and the part itself when
/// it is see through.
type Joining = (Option<usize>, usize, [bool; 3], Option<usize>);

/// A piece on a link, whose copies there are drawn as its instances.
type OnLink = (usize, Option<usize>);

const GEOMETRY: [&str; 8] = ["Mesh", "Cube", "Sphere", "Cylinder", "Cylinder_1", "Capsule", "Capsule_1", "Cone"];

impl<'s> Robot<'s> {
    fn new(stage: &'s usd::Stage) -> Result<Self, String> {
        let mut robot = Robot {
            stage,
            xforms: XformCache::new(None),
            bodies: HashSet::new(),
            joints: Vec::new(),
            roots: Vec::new(),
            links: HashMap::new(),
            nodes: vec![Value::Null],
            top: Vec::new(),
            meshes: HashMap::new(),
            pieces: Vec::new(),
            parts: Vec::new(),
            mesh_list: Vec::new(),
            looks: HashMap::new(),
            materials: HashMap::new(),
            contents: HashMap::new(),
            material_list: Vec::new(),
            images: HashMap::new(),
            glb: Glb::default(),
            problems: HashSet::new(),
        };
        let top = stage.prim("/").map_err(|e| e.to_string())?;
        robot.find_joints(&top);
        Ok(robot)
    }

    /// Gathers the joints, the bodies they join and the robots' roots, before the walk that makes
    /// nodes.
    fn find_joints(&mut self, prim: &usd::Prim) {
        for prim in children(prim) {
            let kind = type_name(&prim);
            if prim.has_api_schema("PhysicsArticulationRootAPI").unwrap_or(false) {
                self.roots.push(prim.path().as_str().to_string());
            }
            if kind.starts_with("Physics") && kind.ends_with("Joint") {
                if let Some(joint) = self.joint(&prim, &kind) {
                    self.joints.push(joint);
                }
            } else if prim.has_api_schema("PhysicsRigidBodyAPI").unwrap_or(false) {
                self.bodies.insert(prim.path().as_str().to_string());
            }
            self.find_joints(&prim);
        }
    }

    fn joint(&mut self, prim: &usd::Prim, kind: &str) -> Option<Joint> {
        let body = |n: &str| prim.relationship(n).targets().ok().and_then(|t| t.first().map(|p| p.as_str().to_string()));
        let frame = |n: char| {
            let at = prim.attribute(format!("physics:localPos{n}")).get::<gf::Vec3f>().ok().flatten().unwrap_or_default();
            let turn = prim.attribute(format!("physics:localRot{n}")).get::<gf::Quatf>().ok().flatten().unwrap_or(gf::Quatf::IDENTITY);
            (at, turn)
        };
        let axis = match prim.attribute("physics:axis").get::<sdf::Value>().ok().flatten().as_ref().and_then(sdf::Value::as_str) {
            Some("Y") => [0.0, 1.0, 0.0],
            Some("Z") => [0.0, 0.0, 1.0],
            _ => [1.0, 0.0, 0.0],
        };
        let kind = match kind {
            "PhysicsRevoluteJoint" => "revolute",
            "PhysicsPrismaticJoint" => "prismatic",
            _ => "fixed",
        };
        let closes_loop = prim.attribute("physics:excludeFromArticulation").get::<bool>().ok().flatten().unwrap_or(false);
        let name = name_of(prim);
        let path = prim.path().as_str().to_string();
        let (parent, child, frames, axis) = match (body("physics:body0"), body("physics:body1")) {
            (parent, Some(child)) => (parent, child, [frame('0'), frame('1')], axis),
            // a joint to the world named from the body's side, as Franka's root joint is
            (Some(child), None) => (None, child, [frame('1'), frame('0')], axis.map(|a: f64| -a)),
            (None, None) => return None,
        };
        self.bodies.extend(parent.iter().cloned());
        self.bodies.insert(child.clone());
        Some(Joint { name, path, kind, parent, child, axis, frames, closes_loop, mimic: mimic(prim) })
    }

    /// Makes nodes for the prim and what is under it. `link` is the link node it moves with.
    fn walk(&mut self, prim: &usd::Prim, link: Option<&str>, unseen: bool) {
        if !prim.is_active().unwrap_or(false) || !prim.is_defined().unwrap_or(false) || prim.is_abstract().unwrap_or(true) {
            return;
        }
        if token(prim, "visibility").as_deref() == Some("invisible") {
            return;
        }
        // the nearest purpose authored wins, and guides and proxies are never drawn
        let attr = prim.attribute("purpose");
        let unseen = match attr.has_authored_value().unwrap_or(false) {
            true => matches!(token(prim, "purpose").as_deref(), Some("guide" | "proxy")),
            false => unseen,
        };
        let path = prim.path().as_str().to_string();
        let mut link = link.map(str::to_string);
        if self.bodies.contains(&path) {
            let world = self.world(prim);
            let node = self.node(json!({ "name": name_of(prim), "matrix": matrix(&world), "extras": { "link": path } }));
            self.top.push(node);
            self.links.insert(path.clone(), (node, world));
            link = Some(path);
        }
        let kind = type_name(prim);
        if !unseen && GEOMETRY.contains(&kind.as_str()) {
            self.geometry(prim, &kind, link.as_deref());
        }
        for child in children(prim) {
            self.walk(&child, link.as_deref(), unseen);
        }
    }

    fn world(&mut self, prim: &usd::Prim) -> gf::Matrix4d {
        self.xforms.local_to_world_transform(prim).unwrap_or_else(|e| {
            self.problems.insert(format!("{}: {e}", prim.path().as_str()));
            gf::Matrix4d::IDENTITY
        })
    }

    fn node(&mut self, node: Value) -> usize {
        self.nodes.push(node);
        self.nodes.len() - 1
    }

    /// A part for a mesh or shape on its link, sharing the piece of every instance like it.
    fn geometry(&mut self, prim: &usd::Prim, kind: &str, link: Option<&str>) {
        let world = self.world(prim);
        let (parent, from) = match link.and_then(|l| self.links.get(l)) {
            Some(&(node, rest)) => (Some(node), rest.inverse().unwrap_or(gf::Matrix4d::IDENTITY)),
            None => (None, gf::Matrix4d::IDENTITY),
        };
        let local = world * from;
        let mut looks = vec![self.bound(prim)];
        let subsets = subsets(prim);
        looks.extend(subsets.iter().map(|(subset, _)| self.bound(subset)));
        let double = prim.attribute("doubleSided").get::<bool>().ok().flatten().unwrap_or(false);
        // a transform glTF cannot hold, scale along a turned axis, goes into the points instead
        let sheared = !decomposable(&local);
        let source = match prim.is_instance_proxy() {
            Ok(true) => prim.prim_in_prototype().ok().flatten().map(|p| p.path().as_str().to_string()),
            _ => None,
        };
        let key = match (sheared, source) {
            (false, Some(source)) => format!("{source} {double} {:?}", looks.iter().map(look_key).collect::<Vec<_>>()),
            _ => prim.path().as_str().to_string(),
        };
        let piece = match self.meshes.get(&key) {
            Some(&piece) => piece,
            None => {
                let shape = match kind {
                    "Mesh" => self.mesh(prim, &subsets, &looks),
                    _ => solid(prim, kind),
                };
                let Some(mut shape) = shape else { return };
                if sheared {
                    bake(&mut shape, &local);
                }
                self.pieces.push(Piece { shape, looks, double, name: name_of(prim) });
                self.meshes.insert(key, self.pieces.len() - 1);
                self.pieces.len() - 1
            }
        };
        let at = (!sheared && local != gf::Matrix4d::IDENTITY).then_some(local);
        self.parts.push(Part { piece, link: parent, at });
    }

    /// Puts a node under its link node, or under the root.
    fn attach(&mut self, node: usize, link: Option<usize>) {
        match link {
            Some(link) => match self.nodes[link]["children"].as_array_mut() {
                Some(list) => list.push(json!(node)),
                None => self.nodes[link]["children"] = json!([node]),
            },
            None => self.top.push(node),
        }
    }

    /// Writes the meshes and their nodes, and says whether any is drawn as instances. Parts that
    fn lay_out(&mut self) -> bool {
        let mut uses = vec![0usize; self.pieces.len()];
        for part in &self.parts {
            uses[part.piece] += 1;
        }
        let mut joined: Vec<(Joining, Shape)> = Vec::new();
        let mut into: HashMap<Joining, usize> = HashMap::new();
        let mut copies: Vec<(OnLink, Vec<Option<gf::Matrix4d>>)> = Vec::new();
        let mut copy_of: HashMap<OnLink, usize> = HashMap::new();
        for (index, part) in std::mem::take(&mut self.parts).into_iter().enumerate() {
            if uses[part.piece] > 1 {
                let at = *copy_of.entry((part.piece, part.link)).or_insert_with(|| {
                    copies.push(((part.piece, part.link), Vec::new()));
                    copies.len() - 1
                });
                copies[at].1.push(part.at);
                continue;
            }
            let Piece { mut shape, looks, double, .. } = std::mem::take(&mut self.pieces[part.piece]);
            if let Some(at) = &part.at {
                bake(&mut shape, at);
            }
            let has = [!shape.normals.is_empty(), !shape.uvs.is_empty(), !shape.colors.is_empty()];
            for (look, indices) in &shape.groups {
                let material = self.material(&looks[*look], double);
                let alone = self.material_list[material]["alphaMode"].is_string().then_some(index);
                let key = (part.link, material, has, alone);
                let at = *into.entry(key).or_insert_with(|| {
                    joined.push((key, Shape::default()));
                    joined.len() - 1
                });
                append(&mut joined[at].1, &shape, indices);
            }
        }
        for ((link, material, _, _), shape) in joined {
            let name = self.material_list[material]["name"].as_str().unwrap_or_default().to_string();
            let mesh = self.write_mesh(&shape, &[material], &name);
            let node = self.node(json!({ "name": name, "mesh": mesh }));
            self.attach(node, link);
        }
        let (mut written, mut instanced) = (HashMap::new(), false);
        for ((piece, link), places) in copies {
            let mesh = match written.get(&piece) {
                Some(&mesh) => mesh,
                None => {
                    let Piece { shape, looks, double, name } = std::mem::take(&mut self.pieces[piece]);
                    let materials: Vec<usize> = looks.iter().map(|look| self.material(look, double)).collect();
                    let mesh = self.write_mesh(&shape, &materials, &name);
                    self.pieces[piece].name = name;
                    written.insert(piece, mesh);
                    mesh
                }
            };
            let name = self.pieces[piece].name.clone();
            if places.len() > 1 {
                instanced = true;
                let (mut moves, mut turns, mut sizes) = (Vec::new(), Vec::new(), Vec::new());
                for at in &places {
                    let (t, r, s) = trs(&at.unwrap_or(gf::Matrix4d::IDENTITY));
                    moves.push(t);
                    turns.push(r);
                    sizes.push(s);
                }
                let attributes = json!({ "TRANSLATION": self.glb.values(&moves, "VEC3"), "ROTATION": self.glb.values(&turns, "VEC4"), "SCALE": self.glb.values(&sizes, "VEC3") });
                let node = self.node(json!({ "name": name, "mesh": mesh, "extensions": { "EXT_mesh_gpu_instancing": { "attributes": attributes } } }));
                self.attach(node, link);
                continue;
            }
            for at in places {
                let mut node = json!({ "name": name, "mesh": mesh });
                if let Some(at) = at {
                    node["matrix"] = matrix(&at);
                }
                let node = self.node(node);
                self.attach(node, link);
            }
        }
        instanced
    }

    /// The look bound to the prim, else its display colour, else plain grey.
    fn bound(&mut self, prim: &usd::Prim) -> Look {
        let material = MaterialBindingAPI::from_prim_unchecked(prim.clone()).compute_bound_material("").ok().flatten();
        if let Some(material) = material {
            let path = material.as_str().to_string();
            if !self.looks.contains_key(&path) {
                let surface = self.surface(&material);
                self.looks.insert(path.clone(), surface);
            }
            return Look::Bound(path);
        }
        let color = primvar(prim, "primvars:displayColor").and_then(|v| colors(&v.values).first().copied());
        let opacity = primvar(prim, "primvars:displayOpacity").and_then(|v| floats(&v.values).first().copied());
        let [r, g, b] = color.unwrap_or([0.5, 0.5, 0.5]);
        Look::Plain([r, g, b, opacity.unwrap_or(1.0)])
    }

    /// Reads a material as UsdPreviewSurface, else as Omniverse's OmniPBR, the MDL Isaac Sim
    /// writes, else by what its inputs are called. What none of them finds keeps OmniPBR's
    /// defaults.
    fn surface(&mut self, material: &sdf::Path) -> Surface {
        let mut surface = Surface { color: [0.2, 0.2, 0.2, 1.0], texture: None, metallic: 0.0, roughness: 0.5 };
        let Ok(material) = self.stage.prim(material.clone()) else { return surface };
        let Some(shader) = shader_of(self.stage, &material) else { return surface };
        let preview = token(&shader, "info:id").as_deref() == Some("UsdPreviewSurface");
        let names = match preview {
            true => ["inputs:diffuseColor", "inputs:diffuseColor", "inputs:metallic", "inputs:roughness", "inputs:opacity"],
            false => ["inputs:diffuse_color_constant", "inputs:diffuse_texture", "inputs:metallic_constant", "inputs:reflection_roughness_constant", "inputs:opacity_constant"],
        };
        let first = input(self.stage, &shader, names[0]);
        let known = first.is_some();
        if let Some(found) = first {
            match found {
                Found::Value(v) => {
                    if let Some(&[r, g, b]) = colors(&v).first() {
                        surface.color = [r, g, b, 1.0];
                    }
                }
                Found::Texture(t) => {
                    surface.color = [1.0, 1.0, 1.0, 1.0];
                    surface.texture = t;
                }
            }
        }
        if !preview {
            // OmniPBR draws its texture in place of the constant colour
            if let Some(Found::Texture(Some(t))) = input(self.stage, &shader, names[1]) {
                surface.color = [1.0, 1.0, 1.0, 1.0];
                surface.texture = Some(t);
            }
            if let Some(Found::Value(v)) = input(self.stage, &shader, "inputs:diffuse_tint")
                && let Some(&tint) = colors(&v).first()
            {
                (0..3).for_each(|i| surface.color[i] *= tint[i]);
            }
            if !known && surface.texture.is_none() && !omniverse(&shader) {
                self.by_names(&shader, &mut surface);
            }
        }
        let number = |name: &str| match input(self.stage, &shader, name) {
            Some(Found::Value(v)) => floats(&v).first().copied(),
            _ => None,
        };
        surface.metallic = number(names[2]).unwrap_or(surface.metallic);
        surface.roughness = number(names[3]).unwrap_or(surface.roughness);
        let opaque = preview || matches!(input(self.stage, &shader, "inputs:enable_opacity"), Some(Found::Value(sdf::Value::Bool(true))));
        if opaque {
            surface.color[3] = number(names[4]).unwrap_or(1.0);
        }
        surface
    }

    /// Reads an MDL of its own, as Unreal writes one, by what its inputs are called: its base
    /// colour texture times any tint, else its first colour, and its roughness and metalness.
    fn by_names(&self, shader: &usd::Prim, surface: &mut Surface) {
        let mut textures: Vec<(bool, PathBuf)> = Vec::new();
        let (mut tint, mut color, mut rough, mut range) = ([1.0f32; 3], None, None, Vec::new());
        for attr in shader.attributes_in_namespace("inputs").unwrap_or_default() {
            let name = attr.name().trim_start_matches("inputs:").replace('_', "").to_lowercase();
            let colour = ["albedo", "basecolor", "diffuse"].iter().any(|w| name.contains(w));
            match input(self.stage, shader, attr.name()) {
                Some(Found::Texture(Some(file))) => {
                    // a colour texture's file ends _D or _BC when its input's name does not say
                    let stem = file.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
                    if colour || ["_d", "_bc", "_basecolor", "_albedo", "_diffuse"].iter().any(|s| stem.ends_with(s)) {
                        textures.push((colour, file));
                    }
                }
                Some(Found::Value(v)) => match (colors(&v).first(), floats(&v).first()) {
                    (Some(c), _) if name.contains("tint") => (0..3).for_each(|i| tint[i] *= c[i]),
                    (Some(&c), _) if (colour || name.contains("color")) && !name.contains("emissi") => {
                        color.get_or_insert(c);
                    }
                    (None, Some(&n)) if name == "roughness" => rough = Some(n),
                    (None, Some(&n)) if name == "roughnessmin" || name == "roughnessmax" => range.push(n),
                    (None, Some(&n)) if name == "metallic" || name == "metalness" => surface.metallic = n,
                    _ => {}
                },
                _ => {}
            }
        }
        if let Some((_, file)) = textures.iter().find(|(named, _)| *named).or(textures.first()) {
            surface.texture = Some(file.clone());
            surface.color = [1.0, 1.0, 1.0, 1.0];
        } else if let Some([r, g, b]) = color {
            surface.color = [r, g, b, 1.0];
        }
        (0..3).for_each(|i| surface.color[i] *= tint[i]);
        // a roughness map spans the range, which its middle stands for
        if let (None, [low, high]) = (rough, range.as_slice()) {
            rough = Some(((low + high) / 2.0).clamp(0.0, 1.0));
        }
        surface.roughness = rough.unwrap_or(surface.roughness);
    }

    /// A Mesh's faces as triangles, split by the material subsets bind.
    fn mesh(&mut self, prim: &usd::Prim, subsets: &[(usd::Prim, Vec<i32>)], looks: &[Look]) -> Option<Shape> {
        let where_ = prim.path().as_str();
        let points = vec3s(&value(prim, "points")?)?;
        let counts = ints(&value(prim, "faceVertexCounts")?)?;
        let corners = ints(&value(prim, "faceVertexIndices")?)?;
        if counts.is_empty() {
            return None;
        }
        let left = token(prim, "orientation").as_deref() == Some("leftHanded");
        let holes: HashSet<i32> = value(prim, "holeIndices").and_then(|v| ints(&v)).unwrap_or_default().into_iter().collect();
        let mut normals = primvar(prim, "primvars:normals").or_else(|| {
            let values = value(prim, "normals")?;
            let interpolation = prim.attribute("normals").get_metadata::<sdf::Value>("interpolation").ok().flatten();
            let interpolation = interpolation.as_ref().and_then(sdf::Value::as_str).and_then(Interpolation::from_token).unwrap_or(Interpolation::Vertex);
            Some(Var { values, indices: None, interpolation })
        });
        // a subdivision surface with no normals is drawn smooth, a polygon mesh flat
        if normals.is_none() && token(prim, "subdivisionScheme").as_deref() != Some("none") {
            normals = Some(smooth(&points, &counts, &corners, left));
        }
        let normal_values = normals.as_ref().and_then(|n| vec3s(&n.values));
        let uv = uv_of(prim);
        let uv_values = uv.as_ref().and_then(|v| vec2s(&v.values));
        // display colour per point or face shows only where no material is bound
        let color = primvar(prim, "primvars:displayColor").filter(|c| c.interpolation != Interpolation::Constant && looks.iter().all(|l| matches!(l, Look::Plain(_))));
        let color_values = color.as_ref().map(|c| colors(&c.values));
        let mut group_of = vec![0usize; counts.len()];
        for (i, (_, faces)) in subsets.iter().enumerate() {
            for &f in faces {
                if let Some(g) = group_of.get_mut(f as usize) {
                    *g = i + 1;
                }
            }
        }
        let mut shape = Shape::default();
        let mut groups: Vec<Vec<u32>> = vec![Vec::new(); subsets.len() + 1];
        let mut seen: HashMap<[u32; 9], u32> = HashMap::new();
        let mut bad = false;
        let mut corner = 0usize;
        for (face, &count) in counts.iter().enumerate() {
            let count = count.max(0) as usize;
            let start = corner;
            corner += count;
            if count < 3 || holes.contains(&(face as i32)) || corner > corners.len() {
                bad |= corner > corners.len();
                continue;
            }
            let mut ids = Vec::with_capacity(count);
            for (c, &point) in corners.iter().enumerate().take(corner).skip(start) {
                let point = point as usize;
                let Some(&at) = points.get(point) else {
                    bad = true;
                    break;
                };
                let normal = normal_values.as_ref().and_then(|v| normals.as_ref()?.pick(v, face, point, c)).copied();
                let st = uv_values.as_ref().and_then(|v| uv.as_ref()?.pick(v, face, point, c)).copied();
                let tint = color_values.as_ref().and_then(|v| color.as_ref()?.pick(v, face, point, c)).copied();
                let n = normal.unwrap_or_default();
                let t = st.unwrap_or_default();
                let k = tint.unwrap_or_default();
                let key = [point as u32, n[0].to_bits(), n[1].to_bits(), n[2].to_bits(), t[0].to_bits(), t[1].to_bits(), k[0].to_bits(), k[1].to_bits(), k[2].to_bits()];
                let id = *seen.entry(key).or_insert_with(|| {
                    shape.positions.push(at);
                    if normal_values.is_some() {
                        shape.normals.push(normal.unwrap_or([0.0, 0.0, 1.0]));
                    }
                    if uv_values.is_some() {
                        // USD's texture origin is the bottom left, glTF's the top left
                        shape.uvs.push([t[0], 1.0 - t[1]]);
                    }
                    if color_values.is_some() {
                        shape.colors.push(k);
                    }
                    (shape.positions.len() - 1) as u32
                });
                ids.push(id);
            }
            if ids.len() < count {
                continue;
            }
            let list = &mut groups[group_of[face]];
            for i in 1..count - 1 {
                match left {
                    false => list.extend([ids[0], ids[i], ids[i + 1]]),
                    true => list.extend([ids[0], ids[i + 1], ids[i]]),
                }
            }
        }
        if bad {
            self.problems.insert(format!("{where_}: some faces name points it does not have, so they are left out"));
        }
        shape.groups = groups.into_iter().enumerate().filter(|(_, g)| !g.is_empty()).collect();
        (!shape.groups.is_empty()).then_some(shape)
    }

    /// Writes a mesh, each face group drawn in the material its look's place in `materials` names.
    fn write_mesh(&mut self, shape: &Shape, materials: &[usize], name: &str) -> usize {
        let mut attributes = json!({ "POSITION": self.glb.floats(&shape.positions, "VEC3", true) });
        if !shape.normals.is_empty() {
            attributes["NORMAL"] = json!(self.glb.floats(&shape.normals, "VEC3", false));
        }
        if !shape.uvs.is_empty() {
            attributes["TEXCOORD_0"] = json!(self.glb.floats(&shape.uvs, "VEC2", false));
        }
        if !shape.colors.is_empty() {
            attributes["COLOR_0"] = json!(self.glb.floats(&shape.colors, "VEC3", false));
        }
        let primitives: Vec<Value> = shape
            .groups
            .iter()
            .map(|(look, indices)| json!({ "attributes": attributes, "indices": self.glb.indices(indices), "material": materials[*look] }))
            .collect();
        self.mesh_list.push(json!({ "name": name, "primitives": primitives }));
        self.mesh_list.len() - 1
    }

    fn material(&mut self, look: &Look, double: bool) -> usize {
        let key = format!("{} {double}", look_key(look));
        if let Some(&index) = self.materials.get(&key) {
            return index;
        }
        let (name, surface) = match look {
            Look::Bound(path) => (path.rsplit('/').next().unwrap_or_default().to_string(), self.looks[path].clone()),
            Look::Plain(color) => ("displayColor".to_string(), Surface { color: *color, texture: None, metallic: 0.0, roughness: 0.5 }),
        };
        let mut pbr = json!({ "baseColorFactor": surface.color, "metallicFactor": surface.metallic, "roughnessFactor": surface.roughness });
        if let Some(texture) = surface.texture.as_ref().and_then(|t| self.texture(t)) {
            pbr["baseColorTexture"] = json!({ "index": texture });
        }
        let mut material = json!({ "pbrMetallicRoughness": pbr, "doubleSided": double });
        if surface.color[3] < 1.0 {
            material["alphaMode"] = json!("BLEND");
        }
        let index = match self.contents.get(&material.to_string()) {
            Some(&index) => index,
            None => {
                self.contents.insert(material.to_string(), self.material_list.len());
                material["name"] = json!(name);
                self.material_list.push(material);
                self.material_list.len() - 1
            }
        };
        self.materials.insert(key, index);
        index
    }

    /// The texture for an image file, which a browser draws only as PNG or JPEG.
    fn texture(&mut self, file: &Path) -> Option<usize> {
        if let Some(&index) = self.images.get(file) {
            return Some(index);
        }
        let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            _ => {
                self.problems.insert(format!("{}: a screen draws only PNG and JPEG textures", file.display()));
                return None;
            }
        };
        let bytes = fs::read(file).map_err(|e| self.problems.insert(format!("{}: {e}", file.display()))).ok()?;
        let view = self.glb.view(&bytes, None);
        let index = self.images.len();
        self.glb.images.push(json!({ "bufferView": view, "mimeType": mime }));
        self.images.insert(file.to_path_buf(), index);
        Some(index)
    }

    /// The joints the screen moves in the order Isaac Sim lists them, breadth first from the
    /// root, siblings in the file's order, and the robots they make. A list of positions without
    /// names follows a robot's moving joints.
    fn joint_list(&mut self, fallback: &str) -> (Vec<Value>, Vec<Value>) {
        let mut taken: HashSet<&str> = HashSet::new();
        let mut kept: Vec<(usize, &Joint)> = Vec::new();
        // a joint between two bodies first, so a tool frame fixed to the world, as UR's ee_joint
        // is, never takes its link from the arm
        let mut order: Vec<(usize, &Joint)> = self.joints.iter().enumerate().collect();
        order.sort_by_key(|(_, j)| (j.closes_loop, j.parent.is_none()));
        for (at, joint) in order {
            let known = |l: &String| self.links.contains_key(l);
            if !known(&joint.child) || joint.parent.as_ref().is_some_and(|p| !known(p) || *p == joint.child) {
                self.problems.insert(format!("{}: it joins a body that is not drawn, so it is left out", joint.name));
                continue;
            }
            if taken.insert(&joint.child) {
                kept.push((at, joint));
            }
        }
        kept.sort_by_key(|&(at, _)| at);
        // a link that no joint moves starts the tree, after the world, and a loop never does
        let mut queue: VecDeque<Option<&str>> = VecDeque::from([None]);
        for (_, joint) in &kept {
            let parent = joint.parent.as_deref();
            if parent.is_some_and(|p| !taken.contains(p)) && !queue.contains(&parent) {
                queue.push_back(parent);
            }
        }
        let mut sorted: Vec<&Joint> = Vec::new();
        while let Some(link) = queue.pop_front() {
            for (_, joint) in kept.iter().filter(|(_, j)| j.parent.as_deref() == link) {
                sorted.push(joint);
                queue.push_back(Some(&joint.child));
            }
        }
        let (robots, of) = self.robots(&sorted, fallback);
        let place = |path: &str| sorted.iter().position(|j| j.path == path);
        let frame = |(at, turn): &(gf::Vec3f, gf::Quatf)| json!({ "translation": [at.x, at.y, at.z], "rotation": [turn.x, turn.y, turn.z, turn.w] });
        let joints = sorted
            .iter()
            .zip(of)
            .map(|(j, robot)| {
                let mut joint = json!({
                    "name": j.name,
                    "kind": j.kind,
                    "parent": j.parent,
                    "child": j.child,
                    "axis": j.axis,
                    "frames": [frame(&j.frames[0]), frame(&j.frames[1])],
                    "robot": robot,
                });
                if let Some((m, at)) = j.mimic.as_ref().and_then(|m| Some((m, place(&m.joint)?))) {
                    joint["mimic"] = json!({ "joint": at, "gearing": m.gearing, "offset": m.offset });
                }
                joint
            })
            .collect();
        (joints, robots)
    }

    /// The robots the joints make, and the robot each joint is in. Joints joined through their
    /// links are one robot, placed at the articulation root on them or over them, else at the
    /// links' common prim. It is named by the nearest prim there that is neither a link nor a
    /// joint, or by that prim's path when two share a name.
    fn robots(&self, sorted: &[&Joint], fallback: &str) -> (Vec<Value>, Vec<usize>) {
        let mut up: HashMap<&str, &str> = HashMap::new();
        for joint in sorted {
            if let Some(parent) = &joint.parent {
                let (a, b) = (end(&up, parent), end(&up, &joint.child));
                if a != b {
                    up.insert(a, b);
                }
            }
        }
        let group: Vec<&str> = sorted.iter().map(|j| end(&up, &j.child)).collect();
        let joints: HashSet<&str> = self.joints.iter().map(|j| j.path.as_str()).collect();
        let mut places: Vec<String> = Vec::new();
        let mut placed: HashMap<&str, usize> = HashMap::new();
        let mut of = Vec::new();
        for &g in &group {
            if let Some(&robot) = placed.get(g) {
                of.push(robot);
                continue;
            }
            let members: Vec<&Joint> = sorted.iter().zip(&group).filter(|(_, h)| **h == g).map(|(j, _)| *j).collect();
            let links: Vec<&str> = members.iter().flat_map(|j| j.parent.as_deref().into_iter().chain([j.child.as_str()])).collect();
            // a root on a joint, as Isaac's root_joint, places the robot at the joint's link
            let on = self.roots.iter().find_map(|r| match links.contains(&r.as_str()) {
                true => Some(r.clone()),
                false => members.iter().find(|j| j.path == *r).map(|j| j.child.clone()),
            });
            let over = || self.roots.iter().filter(|r| links.iter().any(|l| l.starts_with(&format!("{r}/")))).max_by_key(|r| r.len()).cloned();
            let place = on.or_else(over).unwrap_or_else(|| common(&links));
            let mut at = place.as_str();
            while self.bodies.contains(at) || joints.contains(at) {
                at = at.rsplit_once('/').map_or("", |(p, _)| p);
            }
            let robot = match places.iter().position(|p| p == at) {
                Some(robot) => robot,
                None => {
                    places.push(at.to_string());
                    places.len() - 1
                }
            };
            placed.insert(g, robot);
            of.push(robot);
        }
        let names: Vec<&str> = places.iter().map(|p| p.rsplit_once('/').map_or(fallback, |(_, n)| n)).collect();
        let robots = places
            .iter()
            .enumerate()
            .map(|(robot, path)| {
                let path = if path.is_empty() { "/" } else { path.as_str() };
                let name = match names.iter().filter(|n| **n == names[robot]).count() {
                    1 => names[robot],
                    _ => path,
                };
                let moving: Vec<usize> = sorted.iter().enumerate().filter(|&(i, j)| of[i] == robot && j.kind != "fixed").map(|(i, _)| i).collect();
                json!({ "name": name, "path": path, "moving": moving })
            })
            .collect();
        (robots, of)
    }

    /// The model, whether it holds the whole robot with no problems, and the images it read.
    fn finish(mut self, file: &Path) -> Result<(Vec<u8>, bool, Vec<PathBuf>), String> {
        if self.parts.is_empty() {
            let mut why = String::from("it holds no mesh or shape to draw");
            if !self.problems.is_empty() {
                let mut problems: Vec<_> = self.problems.into_iter().collect();
                problems.sort();
                why = format!("{why}: {}", problems.join(", "));
            }
            return Err(why);
        }
        let instanced = self.lay_out();
        let up = self.stage.stage_metadata("upAxis").ok().flatten();
        let z_up = up.as_ref().and_then(sdf::Value::as_str) == Some("Z");
        let unit = match self.stage.stage_metadata("metersPerUnit").ok().flatten() {
            Some(sdf::Value::Double(unit)) => unit,
            Some(v) => floats(&v).first().map_or(0.01, |&u| u as f64),
            None => 0.01,
        };
        let name = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let (joints, robots) = self.joint_list(&name);
        let mut root = json!({
            "name": name,
            "scale": [unit, unit, unit],
            "children": self.top,
        });
        if z_up {
            // glTF is y up
            let half = std::f32::consts::FRAC_1_SQRT_2;
            root["rotation"] = json!([-half, 0.0, 0.0, half]);
        }
        self.nodes[0] = root;
        let whole = self.problems.is_empty();
        let mut problems: Vec<String> = self.problems.into_iter().collect();
        problems.sort();
        let textures: Vec<Value> = (0..self.glb.images.len()).map(|i| json!({ "source": i, "sampler": 0 })).collect();
        let mut doc = json!({
            "asset": { "version": "2.0", "generator": "rant-hmi" },
            "scene": 0,
            "scenes": [{ "nodes": [0], "extras": { "joints": joints, "robots": robots, "metersPerUnit": unit, "problems": problems } }],
            "nodes": self.nodes,
            "meshes": self.mesh_list,
            "materials": self.material_list,
        });
        if !textures.is_empty() {
            doc["textures"] = json!(textures);
            doc["samplers"] = json!([{ "wrapS": 10497, "wrapT": 10497 }]);
        }
        if instanced {
            doc["extensionsUsed"] = json!(["EXT_mesh_gpu_instancing"]);
        }
        Ok((self.glb.finish(doc), whole, self.images.into_keys().collect()))
    }
}

/// The joint a joint follows by PhysxMimicJointAPI, under whichever axis it is applied for.
fn mimic(prim: &usd::Prim) -> Option<Mimic> {
    let attrs = prim.attributes_in_namespace("physxMimicJoint").unwrap_or_default();
    let gearing = attrs.iter().find(|a| a.name().ends_with(":gearing"))?;
    let at = gearing.name().trim_end_matches("gearing");
    let joint = prim.relationship(format!("{at}referenceJoint")).targets().ok()?.first()?.as_str().to_string();
    let number = |name: &str| value(prim, &format!("{at}{name}")).and_then(|v| floats(&v).first().copied()).unwrap_or(0.0) as f64;
    Some(Mimic { joint, gearing: number("gearing"), offset: number("offset") })
}

/// Where a link's group ends, following `up` from it.
fn end<'a>(up: &HashMap<&'a str, &'a str>, mut at: &'a str) -> &'a str {
    while let Some(&next) = up.get(at) {
        at = next;
    }
    at
}

/// The prim that holds all of `paths`, or "" for the stage's root.
fn common(paths: &[&str]) -> String {
    let mut parts: Vec<&str> = paths.first().map_or(Vec::new(), |p| p.split('/').collect());
    for path in paths {
        let same = parts.iter().zip(path.split('/')).take_while(|(a, b)| **a == *b).count();
        parts.truncate(same);
    }
    parts.join("/")
}

/// A primvar's values, and which of them each face corner takes.
struct Var {
    values: sdf::Value,
    indices: Option<Vec<i32>>,
    interpolation: Interpolation,
}

impl Var {
    fn pick<'v, T>(&self, values: &'v [T], face: usize, point: usize, corner: usize) -> Option<&'v T> {
        let at = match self.interpolation {
            Interpolation::Constant => 0,
            Interpolation::Uniform => face,
            Interpolation::Vertex | Interpolation::Varying => point,
            Interpolation::FaceVarying => corner,
        };
        let at = match &self.indices {
            Some(indices) => usize::try_from(*indices.get(at)?).ok()?,
            None => at,
        };
        values.get(at)
    }
}

fn primvar(prim: &usd::Prim, name: &str) -> Option<Var> {
    let var = Primvar::from_attribute(prim.attribute(name))?;
    primvar_of(&var)
}

fn primvar_of(var: &Primvar) -> Option<Var> {
    let values = var.attribute().get::<sdf::Value>().ok().flatten()?;
    let indices = var.indices(None).ok().flatten().filter(|i| !i.is_empty());
    Some(Var { values, indices, interpolation: var.interpolation().unwrap_or_default() })
}

/// The texture coordinates: `st` when there, else the first set typed as coordinates, else
/// the first two number set.
fn uv_of(prim: &usd::Prim) -> Option<Var> {
    let all = PrimvarsAPI::from_prim_unchecked(prim.clone()).primvars().ok()?;
    let pairs: Vec<&Primvar> = all.iter().filter(|v| v.attribute().get::<sdf::Value>().ok().flatten().is_some_and(|v| vec2s(&v).is_some())).collect();
    let coords = |v: &&&Primvar| v.attribute().type_name().ok().flatten().is_some_and(|t| t.role() == Some(sdf::Role::TextureCoordinate));
    let chosen = pairs.iter().find(|v| v.primvar_name() == "st").or_else(|| pairs.iter().find(coords)).or(pairs.first())?;
    primvar_of(chosen)
}

/// Per point normals summed from the faces around each point.
fn smooth(points: &[[f32; 3]], counts: &[i32], corners: &[i32], left: bool) -> Var {
    let mut sums = vec![[0f32; 3]; points.len()];
    let mut corner = 0;
    for &count in counts {
        let face: Vec<usize> = corners.get(corner..corner + count.max(0) as usize).unwrap_or_default().iter().map(|&i| i as usize).collect();
        corner += count.max(0) as usize;
        if face.len() < 3 || face.iter().any(|&i| i >= points.len()) {
            continue;
        }
        let mut n = [0f32; 3];
        // Newell's method, so a face that is not flat still gets one normal
        for (i, &a) in face.iter().enumerate() {
            let (p, q) = (points[a], points[face[(i + 1) % face.len()]]);
            n[0] += (p[1] - q[1]) * (p[2] + q[2]);
            n[1] += (p[2] - q[2]) * (p[0] + q[0]);
            n[2] += (p[0] - q[0]) * (p[1] + q[1]);
        }
        if left {
            n = n.map(|v| -v);
        }
        for &i in &face {
            (0..3).for_each(|k| sums[i][k] += n[k]);
        }
    }
    let values = sums.into_iter().map(|n| {
        let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(f32::MIN_POSITIVE);
        gf::Vec3f { x: n[0] / length, y: n[1] / length, z: n[2] / length }
    });
    Var { values: sdf::Value::Vec3fVec(values.collect()), indices: None, interpolation: Interpolation::Vertex }
}

/// The GeomSubsets that bind materials to faces, with their faces.
fn subsets(prim: &usd::Prim) -> Vec<(usd::Prim, Vec<i32>)> {
    if type_name(prim) != "Mesh" {
        return Vec::new();
    }
    children(prim)
        .into_iter()
        .filter(|c| type_name(c) == "GeomSubset" && token(c, "familyName").as_deref() == Some("materialBind"))
        .filter(|c| token(c, "elementType").as_deref().is_none_or(|t| t == "face"))
        .filter_map(|c| {
            let faces = ints(&value(&c, "indices")?)?;
            Some((c, faces))
        })
        .collect()
}

/// The shader a material's surface comes from: UsdPreviewSurface's output first, then MDL's.
fn shader_of(stage: &usd::Stage, material: &usd::Prim) -> Option<usd::Prim> {
    let outputs = ["outputs:surface", "outputs:mdl:surface"];
    let linked = outputs.iter().find_map(|o| material.attribute(*o).connections().ok()?.first().map(|p| p.prim_path()));
    match linked {
        Some(path) => stage.prim(path).ok(),
        None => children(material).into_iter().find(|c| type_name(c) == "Shader"),
    }
}

/// Whether a shader is one of Omniverse's own MDLs, as OmniPBR, whose inputs keep their names.
fn omniverse(shader: &usd::Prim) -> bool {
    match value(shader, "info:mdl:sourceAsset") {
        Some(sdf::Value::AssetPath(asset)) => asset.authored_path.rsplit(['/', '\\']).next().is_some_and(|f| f.starts_with("Omni")),
        _ => false,
    }
}

enum Found {
    Value(sdf::Value),
    /// The image a texture reads, or none when it is not in the files folder.
    Texture(Option<PathBuf>),
}

/// A shader input's value, following its connections through node graphs to a value or to a
/// UsdUVTexture's file.
fn input(stage: &usd::Stage, shader: &usd::Prim, name: &str) -> Option<Found> {
    let mut attr = shader.attribute(name);
    for _ in 0..8 {
        let Some(link) = attr.connections().ok().and_then(|c| c.into_iter().next()) else {
            let value = attr.get::<sdf::Value>().ok().flatten()?;
            return Some(match value {
                sdf::Value::AssetPath(asset) => Found::Texture(asset.resolved_path().map(PathBuf::from)),
                value => Found::Value(value),
            });
        };
        let source = stage.prim(link.prim_path()).ok()?;
        if token(&source, "info:id").as_deref() == Some("UsdUVTexture") {
            return match source.attribute("inputs:file").get::<sdf::Value>().ok().flatten() {
                Some(sdf::Value::AssetPath(asset)) => Some(Found::Texture(asset.resolved_path().map(PathBuf::from))),
                _ => Some(Found::Texture(None)),
            };
        }
        attr = source.attribute(link.as_str().rsplit_once('.')?.1);
    }
    None
}

/// A shape's surface, tessellated about its axis.
fn solid(prim: &usd::Prim, kind: &str) -> Option<Shape> {
    let number = |name: &str, fallback: f32| value(prim, name).and_then(|v| floats(&v).first().copied()).unwrap_or(fallback);
    let mut shape = match kind {
        "Cube" => cube(number("size", 2.0)),
        "Sphere" => capsule(number("radius", 1.0), number("radius", 1.0), 0.0),
        "Cylinder" => tube(number("radius", 1.0), number("radius", 1.0), number("height", 2.0)),
        "Cylinder_1" => tube(number("radiusBottom", 1.0), number("radiusTop", 1.0), number("height", 2.0)),
        "Capsule" => capsule(number("radius", 0.5), number("radius", 0.5), number("height", 1.0)),
        "Capsule_1" => capsule(number("radiusBottom", 0.5), number("radiusTop", 0.5), number("height", 1.0)),
        "Cone" => tube(number("radius", 1.0), 0.0, number("height", 2.0)),
        _ => return None,
    };
    // made along z, then turned onto its axis by a cyclic swap, which keeps the winding
    let turn = |p: [f32; 3]| match token(prim, "axis").as_deref() {
        Some("X") => [p[2], p[0], p[1]],
        Some("Y") => [p[1], p[2], p[0]],
        _ => p,
    };
    shape.positions.iter_mut().for_each(|p| *p = turn(*p));
    shape.normals.iter_mut().for_each(|n| *n = turn(*n));
    Some(shape)
}

const AROUND: usize = 32;

fn cube(size: f32) -> Shape {
    let h = size / 2.0;
    let mut shape = Shape::default();
    let mut list = Vec::new();
    for axis in 0..3 {
        for side in [-1.0f32, 1.0] {
            let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
            let base = shape.positions.len() as u32;
            for (a, b) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
                let mut p = [0.0; 3];
                p[axis] = side * h;
                p[u] = a * h * side;
                p[v] = b * h;
                let mut n = [0.0; 3];
                n[axis] = side;
                shape.positions.push(p);
                shape.normals.push(n);
            }
            list.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
        }
    }
    shape.groups = vec![(0, list)];
    shape
}

/// A tube from radius `bottom` at -h/2 to `top` at h/2, with its ends closed: a cylinder or a cone.
fn tube(bottom: f32, top: f32, height: f32) -> Shape {
    let mut shape = Shape::default();
    let mut list = Vec::new();
    let h = height / 2.0;
    let slope = (bottom - top) / height.max(f32::MIN_POSITIVE);
    for i in 0..=AROUND {
        let a = i as f32 / AROUND as f32 * std::f32::consts::TAU;
        let (s, c) = a.sin_cos();
        let length = (1.0 + slope * slope).sqrt();
        for (r, z) in [(bottom, -h), (top, h)] {
            shape.positions.push([r * c, r * s, z]);
            shape.normals.push([c / length, s / length, slope / length]);
        }
    }
    for i in 0..AROUND as u32 {
        let (a, b) = (i * 2, i * 2 + 2);
        list.extend([a, b, a + 1, a + 1, b, b + 1]);
    }
    for (r, z, up) in [(bottom, -h, -1.0f32), (top, h, 1.0)] {
        if r <= 0.0 {
            continue;
        }
        let center = shape.positions.len() as u32;
        shape.positions.push([0.0, 0.0, z]);
        shape.normals.push([0.0, 0.0, up]);
        for i in 0..=AROUND {
            let (s, c) = (i as f32 / AROUND as f32 * std::f32::consts::TAU).sin_cos();
            shape.positions.push([r * c, r * s, z]);
            shape.normals.push([0.0, 0.0, up]);
        }
        for i in 0..AROUND as u32 {
            let (a, b) = (center + 1 + i, center + 2 + i);
            match up > 0.0 {
                true => list.extend([center, a, b]),
                false => list.extend([center, b, a]),
            }
        }
    }
    shape.groups = vec![(0, list)];
    shape
}

/// A sphere cut at its middle and pulled apart by `height`, the bottom half of radius `bottom`
/// and the top of `top`: a sphere at height 0.
fn capsule(bottom: f32, top: f32, height: f32) -> Shape {
    let mut shape = Shape::default();
    let rings = AROUND / 2;
    for ring in 0..=rings + 1 {
        // the ring past the equator repeats it on the top half
        let (lat, r, z0) = match ring <= rings / 2 {
            true => (ring as f32 / rings as f32 * std::f32::consts::PI - std::f32::consts::FRAC_PI_2, bottom, -height / 2.0),
            false => ((ring - 1) as f32 / rings as f32 * std::f32::consts::PI - std::f32::consts::FRAC_PI_2, top, height / 2.0),
        };
        let (sl, cl) = lat.sin_cos();
        for i in 0..=AROUND {
            let (s, c) = (i as f32 / AROUND as f32 * std::f32::consts::TAU).sin_cos();
            let n = [cl * c, cl * s, sl];
            shape.positions.push([r * n[0], r * n[1], z0 + r * n[2]]);
            shape.normals.push(n);
        }
    }
    let mut list = Vec::new();
    let row = AROUND as u32 + 1;
    for ring in 0..=rings as u32 {
        for i in 0..AROUND as u32 {
            let (a, b) = (ring * row + i, (ring + 1) * row + i);
            // a pole's ring is one point, so the triangle with two corners there is left out
            if ring > 0 {
                list.extend([a, a + 1, b]);
            }
            if ring < rings as u32 {
                list.extend([b, a + 1, b + 1]);
            }
        }
    }
    shape.groups = vec![(0, list)];
    shape
}

/// Adds the triangles `indices` picks of `from` to `to`'s one group, with only the points they use.
fn append(to: &mut Shape, from: &Shape, indices: &[u32]) {
    let mut moved = vec![u32::MAX; from.positions.len()];
    if to.groups.is_empty() {
        to.groups.push((0, Vec::new()));
    }
    for &i in indices {
        let i = i as usize;
        if moved[i] == u32::MAX {
            moved[i] = to.positions.len() as u32;
            to.positions.push(from.positions[i]);
            if !from.normals.is_empty() {
                to.normals.push(from.normals[i]);
            }
            if !from.uvs.is_empty() {
                to.uvs.push(from.uvs[i]);
            }
            if !from.colors.is_empty() {
                to.colors.push(from.colors[i]);
            }
        }
        to.groups[0].1.push(moved[i]);
    }
}

/// A transform as glTF's move, turn and scale, x y z, x y z w and x y z, a mirror in the x scale.
fn trs(m: &gf::Matrix4d) -> ([f32; 3], [f32; 4], [f32; 3]) {
    // glTF's columns are USD's rows
    let column = |c: usize| [m.0[c * 4], m.0[c * 4 + 1], m.0[c * 4 + 2]];
    let length = |v: [f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(f64::MIN_POSITIVE);
    let (x, y, z) = (column(0), column(1), column(2));
    let turned = x[0] * (y[1] * z[2] - y[2] * z[1]) - x[1] * (y[0] * z[2] - y[2] * z[0]) + x[2] * (y[0] * z[1] - y[1] * z[0]);
    let scale = [length(x) * if turned < 0.0 { -1.0 } else { 1.0 }, length(y), length(z)];
    let columns = [x, y, z].iter().zip(scale).map(|(v, k)| v.map(|n| n / k)).collect::<Vec<_>>();
    // row i of column j of the turn
    let r = |i: usize, j: usize| columns[j][i];
    let trace = r(0, 0) + r(1, 1) + r(2, 2);
    let q = if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        [(r(2, 1) - r(1, 2)) / s, (r(0, 2) - r(2, 0)) / s, (r(1, 0) - r(0, 1)) / s, s / 4.0]
    } else if r(0, 0) > r(1, 1) && r(0, 0) > r(2, 2) {
        let s = (1.0 + r(0, 0) - r(1, 1) - r(2, 2)).sqrt() * 2.0;
        [s / 4.0, (r(0, 1) + r(1, 0)) / s, (r(0, 2) + r(2, 0)) / s, (r(2, 1) - r(1, 2)) / s]
    } else if r(1, 1) > r(2, 2) {
        let s = (1.0 + r(1, 1) - r(0, 0) - r(2, 2)).sqrt() * 2.0;
        [(r(0, 1) + r(1, 0)) / s, s / 4.0, (r(1, 2) + r(2, 1)) / s, (r(0, 2) - r(2, 0)) / s]
    } else {
        let s = (1.0 + r(2, 2) - r(0, 0) - r(1, 1)).sqrt() * 2.0;
        [(r(0, 2) + r(2, 0)) / s, (r(1, 2) + r(2, 1)) / s, s / 4.0, (r(1, 0) - r(0, 1)) / s]
    };
    ([m.0[12] as f32, m.0[13] as f32, m.0[14] as f32], q.map(|n| n as f32), scale.map(|n| n as f32))
}

/// Moves a shape's points by `m`, for a transform its node cannot hold.
fn bake(shape: &mut Shape, m: &gf::Matrix4d) {
    let normal = m.inverse().map(|inv| transpose(&inv)).unwrap_or(*m);
    for p in &mut shape.positions {
        let v = m.transform_point(gf::Vec3f { x: p[0], y: p[1], z: p[2] });
        *p = [v.x, v.y, v.z];
    }
    for n in &mut shape.normals {
        let v = normal.transform_vec(gf::Vec3f { x: n[0], y: n[1], z: n[2] });
        let length = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt().max(f32::MIN_POSITIVE);
        *n = [v.x / length, v.y / length, v.z / length];
    }
    if m.0[0] * (m.0[5] * m.0[10] - m.0[6] * m.0[9]) - m.0[1] * (m.0[4] * m.0[10] - m.0[6] * m.0[8]) + m.0[2] * (m.0[4] * m.0[9] - m.0[5] * m.0[8]) < 0.0 {
        for (_, list) in &mut shape.groups {
            list.chunks_mut(3).for_each(|t| t.swap(1, 2));
        }
    }
}

fn transpose(m: &gf::Matrix4d) -> gf::Matrix4d {
    gf::Matrix4d(std::array::from_fn(|i| m.0[(i % 4) * 4 + i / 4]))
}

/// Whether a transform is a scale, then a turn, then a move, which is all a glTF node holds.
fn decomposable(m: &gf::Matrix4d) -> bool {
    let row = |r: usize| [m.0[r * 4], m.0[r * 4 + 1], m.0[r * 4 + 2]];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let (x, y, z) = (row(0), row(1), row(2));
    let scale = dot(x, x).max(dot(y, y)).max(dot(z, z)).max(f64::MIN_POSITIVE);
    let square = [dot(x, y), dot(y, z), dot(x, z)].iter().all(|d| d.abs() <= 1e-6 * scale);
    square && m.0[3].abs() + m.0[7].abs() + m.0[11].abs() < 1e-9 && (m.0[15] - 1.0).abs() < 1e-9
}

/// A USD matrix as glTF's column major array: USD's row vector layout read the other way.
fn matrix(m: &gf::Matrix4d) -> Value {
    json!(m.0)
}

fn look_key(look: &Look) -> String {
    match look {
        Look::Bound(path) => path.clone(),
        Look::Plain(c) => format!("{c:?}"),
    }
}

fn children(prim: &usd::Prim) -> Vec<usd::Prim> {
    prim.children().unwrap_or_default()
}

fn type_name(prim: &usd::Prim) -> String {
    prim.type_name().ok().flatten().map(|t| t.as_str().to_string()).unwrap_or_default()
}

fn name_of(prim: &usd::Prim) -> String {
    prim.path().name().unwrap_or_default().to_string()
}

fn value(prim: &usd::Prim, name: &str) -> Option<sdf::Value> {
    prim.attribute(name).get::<sdf::Value>().ok().flatten()
}

fn token(prim: &usd::Prim, name: &str) -> Option<String> {
    value(prim, name).as_ref().and_then(sdf::Value::as_str).map(str::to_string)
}

fn ints(v: &sdf::Value) -> Option<Vec<i32>> {
    match v {
        sdf::Value::IntVec(v) => Some(v.clone()),
        _ => None,
    }
}

fn floats(v: &sdf::Value) -> Vec<f32> {
    match v {
        sdf::Value::Float(f) => vec![*f],
        sdf::Value::Double(f) => vec![*f as f32],
        sdf::Value::Half(f) => vec![f.to_f32()],
        sdf::Value::FloatVec(v) => v.clone(),
        sdf::Value::DoubleVec(v) => v.iter().map(|f| *f as f32).collect(),
        sdf::Value::HalfVec(v) => v.iter().map(|f| f.to_f32()).collect(),
        _ => Vec::new(),
    }
}

fn vec3s(v: &sdf::Value) -> Option<Vec<[f32; 3]>> {
    Some(match v {
        sdf::Value::Vec3fVec(v) => v.iter().map(|p| [p.x, p.y, p.z]).collect(),
        sdf::Value::Vec3dVec(v) => v.iter().map(|p| [p.x as f32, p.y as f32, p.z as f32]).collect(),
        sdf::Value::Vec3hVec(v) => v.iter().map(|p| [p.x.to_f32(), p.y.to_f32(), p.z.to_f32()]).collect(),
        _ => return None,
    })
}

fn vec2s(v: &sdf::Value) -> Option<Vec<[f32; 2]>> {
    Some(match v {
        sdf::Value::Vec2fVec(v) => v.iter().map(|p| [p.x, p.y]).collect(),
        sdf::Value::Vec2dVec(v) => v.iter().map(|p| [p.x as f32, p.y as f32]).collect(),
        sdf::Value::Vec2hVec(v) => v.iter().map(|p| [p.x.to_f32(), p.y.to_f32()]).collect(),
        _ => return None,
    })
}

/// Colours from a single colour or a list of them. A colour of four numbers, as Unreal's MDLs
/// take, gives its first three.
fn colors(v: &sdf::Value) -> Vec<[f32; 3]> {
    match v {
        sdf::Value::Vec3f(p) => vec![[p.x, p.y, p.z]],
        sdf::Value::Vec3d(p) => vec![[p.x as f32, p.y as f32, p.z as f32]],
        sdf::Value::Vec3h(p) => vec![[p.x.to_f32(), p.y.to_f32(), p.z.to_f32()]],
        sdf::Value::Vec4f(p) => vec![[p.x, p.y, p.z]],
        sdf::Value::Vec4d(p) => vec![[p.x as f32, p.y as f32, p.z as f32]],
        v => vec3s(v).unwrap_or_default(),
    }
}

/// A glTF binary's buffer and the views and accessors into it.
#[derive(Default)]
struct Glb {
    bin: Vec<u8>,
    views: Vec<Value>,
    accessors: Vec<Value>,
    images: Vec<Value>,
}

impl Glb {
    fn view(&mut self, bytes: &[u8], target: Option<u32>) -> usize {
        self.bin.resize(self.bin.len().next_multiple_of(4), 0);
        let mut view = json!({ "buffer": 0, "byteOffset": self.bin.len(), "byteLength": bytes.len() });
        if let Some(target) = target {
            view["target"] = json!(target);
        }
        self.bin.extend_from_slice(bytes);
        self.views.push(view);
        self.views.len() - 1
    }

    fn floats<const N: usize>(&mut self, data: &[[f32; N]], kind: &str, bounds: bool) -> usize {
        let bytes: Vec<u8> = data.iter().flatten().flat_map(|f| f.to_le_bytes()).collect();
        let view = self.view(&bytes, Some(34962));
        let mut accessor = json!({ "bufferView": view, "componentType": 5126, "count": data.len(), "type": kind });
        if bounds {
            let min: [f32; N] = std::array::from_fn(|i| data.iter().map(|v| v[i]).fold(f32::INFINITY, f32::min));
            let max: [f32; N] = std::array::from_fn(|i| data.iter().map(|v| v[i]).fold(f32::NEG_INFINITY, f32::max));
            accessor["min"] = json!(min.to_vec());
            accessor["max"] = json!(max.to_vec());
        }
        self.accessors.push(accessor);
        self.accessors.len() - 1
    }

    /// Numbers an extension reads, as instances' transforms, which take no target.
    fn values<const N: usize>(&mut self, data: &[[f32; N]], kind: &str) -> usize {
        let bytes: Vec<u8> = data.iter().flatten().flat_map(|f| f.to_le_bytes()).collect();
        let view = self.view(&bytes, None);
        self.accessors.push(json!({ "bufferView": view, "componentType": 5126, "count": data.len(), "type": kind }));
        self.accessors.len() - 1
    }

    fn indices(&mut self, data: &[u32]) -> usize {
        let bytes: Vec<u8> = data.iter().flat_map(|i| i.to_le_bytes()).collect();
        let view = self.view(&bytes, Some(34963));
        self.accessors.push(json!({ "bufferView": view, "componentType": 5125, "count": data.len(), "type": "SCALAR" }));
        self.accessors.len() - 1
    }

    fn finish(mut self, mut doc: Value) -> Vec<u8> {
        self.bin.resize(self.bin.len().next_multiple_of(4), 0);
        doc["buffers"] = json!([{ "byteLength": self.bin.len() }]);
        doc["bufferViews"] = json!(self.views);
        doc["accessors"] = json!(self.accessors);
        if !self.images.is_empty() {
            doc["images"] = json!(self.images);
        }
        let mut text = serde_json::to_vec(&doc).unwrap_or_default();
        text.resize(text.len().next_multiple_of(4), b' ');
        let length = 12 + 8 + text.len() + 8 + self.bin.len();
        let mut out = Vec::with_capacity(length);
        out.extend_from_slice(b"glTF");
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&(length as u32).to_le_bytes());
        out.extend_from_slice(&(text.len() as u32).to_le_bytes());
        out.extend_from_slice(b"JSON");
        out.extend_from_slice(&text);
        out.extend_from_slice(&(self.bin.len() as u32).to_le_bytes());
        out.extend_from_slice(b"BIN\0");
        out.extend_from_slice(&self.bin);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rant-hmi-usd-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, file: &str, text: &str) {
        let file = dir.join(file);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }

    /// A two link arm laid out as Isaac Sim 5 writes one: the base layer a sublayer, the physics
    /// a reference in a variant, the visuals instanced and the collisions guides.
    fn arm(dir: &Path) {
        write(dir, "arm.usda", r#"#usda 1.0
(
    defaultPrim = "arm"
    metersPerUnit = 1
    upAxis = "Z"
    subLayers = [@configuration/arm_base.usda@]
)
over "arm" (
    variants = { string Physics = "PhysX" }
    prepend variantSets = "Physics"
)
{
    variantSet "Physics" = {
        "None" { }
        "PhysX" (prepend references = @configuration/arm_physics.usda@</arm>) { }
    }
}
"#);
        write(dir, "configuration/arm_base.usda", r#"#usda 1.0
(
    defaultPrim = "arm"
    metersPerUnit = 1
    upAxis = "Z"
)
def Xform "arm"
{
    def Xform "base"
    {
        def Xform "visuals" (
            instanceable = true
            prepend apiSchemas = ["MaterialBindingAPI"]
            prepend references = </parts/block>
        )
        {
            rel material:binding = </arm/Looks/Painted>
        }
        def Cube "collisions"
        {
            uniform token purpose = "guide"
        }
    }
    def Xform "link1"
    {
        double3 xformOp:translate = (0, 0, 1)
        uniform token[] xformOpOrder = ["xformOp:translate"]
        def Xform "visuals" (
            instanceable = true
            prepend apiSchemas = ["MaterialBindingAPI"]
            prepend references = </parts/block>
        )
        {
            rel material:binding = </arm/Looks/Painted>
        }
        def Mesh "plate" (prepend apiSchemas = ["MaterialBindingAPI"])
        {
            int[] faceVertexCounts = [4, 3]
            int[] faceVertexIndices = [0, 1, 2, 3, 1, 4, 2]
            point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (2, 0, 0)]
            texCoord2f[] primvars:st_0 = [(0, 0), (1, 0), (1, 1), (0, 1), (1, 0)] (interpolation = "vertex")
            color3f[] primvars:displayColor = [(0, 1, 0)]
            uniform token subdivisionScheme = "none"
            def GeomSubset "tip" (prepend apiSchemas = ["MaterialBindingAPI"])
            {
                uniform token elementType = "face"
                uniform token familyName = "materialBind"
                int[] indices = [1]
                rel material:binding = </arm/Looks/Blue>
            }
        }
    }
    def Scope "Looks"
    {
        def Material "Painted"
        {
            token outputs:mdl:surface.connect = </arm/Looks/Painted/Shader.outputs:out>
            def Shader "Shader"
            {
                uniform token info:implementationSource = "sourceAsset"
                uniform asset info:mdl:sourceAsset = @OmniPBR.mdl@
                uniform token info:mdl:sourceAsset:subIdentifier = "OmniPBR"
                color3f inputs:diffuse_color_constant = (1, 0, 0)
                asset inputs:diffuse_texture = @../textures/check.png@
                float inputs:metallic_constant = 0.25
                token outputs:out
            }
        }
        def Material "Blue"
        {
            token outputs:surface.connect = </arm/Looks/Blue/Surface.outputs:surface>
            def Shader "Surface"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (0, 0, 1)
                float inputs:roughness = 0.75
                token outputs:surface
            }
        }
    }
}
class "parts"
{
    def Xform "block"
    {
        def Mesh "mesh"
        {
            int[] faceVertexCounts = [4]
            int[] faceVertexIndices = [0, 1, 2, 3]
            point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
            normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)] (interpolation = "faceVarying")
            uniform token subdivisionScheme = "none"
        }
    }
}
"#);
        write(dir, "configuration/arm_physics.usda", r#"#usda 1.0
(
    defaultPrim = "arm"
)
over "arm"
{
    over "base" (prepend apiSchemas = ["PhysicsRigidBodyAPI"]) { }
    over "link1" (prepend apiSchemas = ["PhysicsRigidBodyAPI"]) { }
    def Scope "joints"
    {
        def PhysicsFixedJoint "root_joint"
        {
            rel physics:body0 = </arm/base>
        }
        def PhysicsRevoluteJoint "joint1"
        {
            rel physics:body0 = </arm/base>
            rel physics:body1 = </arm/link1>
            uniform token physics:axis = "Z"
            point3f physics:localPos0 = (0, 0, 1)
            quatf physics:localRot1 = (0.70710677, 0.70710677, 0, 0)
        }
        def PhysicsRevoluteJoint "loop"
        {
            rel physics:body0 = </arm/link1>
            rel physics:body1 = </arm/base>
            bool physics:excludeFromArticulation = true
        }
    }
}
"#);
        write(dir, "textures/check.png", "a picture");
    }

    #[test]
    fn layered_robot() {
        let dir = scratch("arm");
        arm(&dir);
        let made = make(&dir.join("arm.usda"), &dir).unwrap();
        let doc = json_of(&made.glb);
        let nodes = doc["nodes"].as_array().unwrap();
        let root = &nodes[0];
        assert_eq!(root["rotation"], json!([-std::f32::consts::FRAC_1_SQRT_2, 0.0, 0.0, std::f32::consts::FRAC_1_SQRT_2]));
        assert_eq!(root["scale"], json!([1.0, 1.0, 1.0]));
        let link = |path: &str| nodes.iter().find(|n| n["extras"]["link"] == path).unwrap_or_else(|| panic!("no link {path}"));
        assert_eq!(link("/arm/link1")["matrix"][14], 1.0);
        assert_eq!(nodes.iter().filter(|n| n["extras"]["link"].is_string()).count(), 2);
        // both visuals share one mesh, the plate's two looks are joined meshes of their own, and
        // the guide cube is never drawn
        let drawn: Vec<&Value> = nodes.iter().filter(|n| n["mesh"].is_number()).collect();
        assert_eq!(drawn.len(), 4);
        assert_eq!(doc["meshes"].as_array().unwrap().len(), 3);
        assert_eq!(link("/arm/base")["children"].as_array().unwrap().len(), 1);
        assert_eq!(link("/arm/link1")["children"].as_array().unwrap().len(), 3);
        let material = |p: &Value| &doc["materials"][p["material"].as_u64().unwrap() as usize];
        let plate = |name: &str| doc["meshes"].as_array().unwrap().iter().map(|m| &m["primitives"][0]).find(|p| material(p)["name"] == name).unwrap();
        let count = |p: &Value| doc["accessors"][p["indices"].as_u64().unwrap() as usize]["count"].as_u64().unwrap();
        assert_eq!((count(plate("displayColor")), count(plate("Blue"))), (6, 3));
        assert!(plate("displayColor")["attributes"]["TEXCOORD_0"].is_number());
        assert_eq!(material(plate("displayColor"))["pbrMetallicRoughness"]["baseColorFactor"], json!([0.0, 1.0, 0.0, 1.0]));
        assert_eq!(material(plate("Blue"))["pbrMetallicRoughness"]["roughnessFactor"], 0.75);
        let painted = doc["materials"].as_array().unwrap().iter().find(|m| m["name"] == "Painted").unwrap();
        assert_eq!(painted["pbrMetallicRoughness"]["baseColorFactor"], json!([1.0, 1.0, 1.0, 1.0]));
        assert_eq!(painted["pbrMetallicRoughness"]["metallicFactor"], 0.25);
        assert_eq!(painted["pbrMetallicRoughness"]["baseColorTexture"]["index"], 0);
        assert_eq!(doc["images"].as_array().unwrap().len(), 1);
        let scene = &doc["scenes"][0]["extras"];
        let joints = scene["joints"].as_array().unwrap();
        assert_eq!(joints.len(), 2, "{joints:?}");
        assert_eq!(joints[0]["name"], "root_joint");
        assert_eq!((&joints[0]["parent"], &joints[0]["child"]), (&json!(null), &json!("/arm/base")));
        assert_eq!(joints[1]["name"], "joint1");
        assert_eq!(joints[1]["kind"], "revolute");
        assert_eq!((&joints[1]["parent"], &joints[1]["child"]), (&json!("/arm/base"), &json!("/arm/link1")));
        assert_eq!(joints[1]["axis"], json!([0.0, 0.0, 1.0]));
        assert_eq!(joints[1]["frames"][0]["translation"], json!([0.0, 0.0, 1.0]));
        assert_eq!(joints[1]["frames"][1]["rotation"][3], json!(std::f32::consts::FRAC_1_SQRT_2));
        assert_eq!(scene["robots"], json!([{ "name": "arm", "path": "/arm", "moving": [1] }]));
        assert_eq!((&joints[0]["robot"], &joints[1]["robot"]), (&json!(0), &json!(0)));
        assert_eq!(scene["problems"], json!([]));
        let read: HashSet<String> = made.read.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(read, ["arm.usda", "arm_base.usda", "arm_physics.usda", "check.png"].map(String::from).into());
    }

    #[test]
    fn nothing_outside_the_folder() {
        let dir = scratch("outside");
        arm(&dir);
        let inside = dir.join("files");
        write(&inside, "robot.usda", r#"#usda 1.0
def Xform "robot" (prepend references = @../arm.usda@)
{
}
def Xform "ghost" (prepend references = </nothing>)
{
}
def Cube "box"
{
}
"#);
        let made = make(&inside.join("robot.usda"), &inside).unwrap();
        let doc = json_of(&made.glb);
        assert_eq!(doc["meshes"].as_array().unwrap().len(), 1);
        let problems = doc["scenes"][0]["extras"]["problems"].to_string();
        assert!(problems.contains("arm.usda"), "{problems}");
        // a file in the folder is named from it
        assert!(problems.contains("@robot.usda@</nothing>"), "{problems}");
        let real = fs::canonicalize(&inside).unwrap();
        assert!(made.read.iter().all(|p| p.starts_with(&real)), "{:?}", made.read);
    }

    /// Robots marked as Isaac's scenes mark them: the root on a robot's prim, on its first link,
    /// on its root joint, or nowhere.
    #[test]
    fn robots_in_a_scene() {
        let dir = scratch("robots");
        let joint = |name: &str, kind: &str, from: &str, to: &str| {
            let from = if from.is_empty() { String::new() } else { format!("rel physics:body0 = <{from}>") };
            format!("def Physics{kind}Joint \"{name}\" {{ {from}\n rel physics:body1 = <{to}> }}")
        };
        let body = |name: &str, root: bool| {
            let root = if root { ", \"PhysicsArticulationRootAPI\"" } else { "" };
            format!("def Cube \"{name}\" (prepend apiSchemas = [\"PhysicsRigidBodyAPI\"{root}]) {{ }}")
        };
        let text = format!(
            "#usda 1.0\ndef Xform \"World\" {{\n\
             def Xform \"cart\" (prepend apiSchemas = [\"PhysicsArticulationRootAPI\"]) {{ {} {} {} }}\n\
             def Xform \"left\" {{ def Xform \"arm\" {{ {} {} {} }} }}\n\
             def Xform \"right\" {{ def Xform \"arm\" {{ {} {} def Scope \"joints\" {{ {} {} }} }} }}\n\
             def Xform \"door\" {{ {} {} {} }}\n}}\n",
            body("body", false),
            body("wheel", false),
            joint("spin", "Revolute", "/World/cart/body", "/World/cart/wheel"),
            body("base", true),
            body("link", false),
            joint("spin", "Revolute", "/World/left/arm/base", "/World/left/arm/link"),
            body("base", false),
            body("link", false),
            joint("root_joint", "Fixed", "", "/World/right/arm/base").replace("Joint \"root_joint\"", "Joint \"root_joint\" (prepend apiSchemas = [\"PhysicsArticulationRootAPI\"])"),
            joint("spin", "Prismatic", "/World/right/arm/base", "/World/right/arm/link"),
            body("frame", false),
            body("leaf", false),
            joint("hinge", "Revolute", "/World/door/frame", "/World/door/leaf"),
        );
        write(&dir, "scene.usda", &text);
        let doc = json_of(&make(&dir.join("scene.usda"), &dir).unwrap().glb);
        let scene = &doc["scenes"][0]["extras"];
        let joints: Vec<(&str, u64)> = scene["joints"].as_array().unwrap().iter().map(|j| (j["name"].as_str().unwrap(), j["robot"].as_u64().unwrap())).collect();
        assert_eq!(joints, [("root_joint", 0), ("spin", 1), ("spin", 2), ("hinge", 3), ("spin", 0)]);
        let robots: Vec<(&str, &str, &Value)> = scene["robots"].as_array().unwrap().iter().map(|r| (r["name"].as_str().unwrap(), r["path"].as_str().unwrap(), &r["moving"])).collect();
        // two robots called arm go by their paths
        assert_eq!(
            robots,
            [
                ("/World/right/arm", "/World/right/arm", &json!([4])),
                ("cart", "/World/cart", &json!([1])),
                ("/World/left/arm", "/World/left/arm", &json!([2])),
                ("door", "/World/door", &json!([3])),
            ]
        );
    }

    /// Copies of one instanced prop drawn as instances of one mesh, each moved, turned and scaled
    /// as its prim is, a mirror too.
    #[test]
    fn copies_are_instances() {
        let dir = scratch("copies");
        write(&dir, "hall.usda", r#"#usda 1.0
class "parts"
{
    def Xform "crate"
    {
        def Cube "box"
        {
        }
    }
}
def Xform "hall"
{
    def Xform "a" (instanceable = true
        prepend references = </parts/crate>)
    {
    }
    def Xform "b" (instanceable = true
        prepend references = </parts/crate>)
    {
        double3 xformOp:translate = (1, 2, 3)
        float xformOp:rotateZ = 90
        double3 xformOp:scale = (2, 2, 2)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateZ", "xformOp:scale"]
    }
    def Xform "c" (instanceable = true
        prepend references = </parts/crate>)
    {
        double3 xformOp:scale = (-1, 1, 1)
        uniform token[] xformOpOrder = ["xformOp:scale"]
    }
}
"#);
        let glb = make(&dir.join("hall.usda"), &dir).unwrap().glb;
        let doc = json_of(&glb);
        assert_eq!(doc["meshes"].as_array().unwrap().len(), 1);
        assert_eq!(doc["extensionsUsed"], json!(["EXT_mesh_gpu_instancing"]));
        let node = doc["nodes"].as_array().unwrap().iter().find(|n| n["mesh"].is_number()).unwrap();
        let attributes = &node["extensions"]["EXT_mesh_gpu_instancing"]["attributes"];
        let numbers = |name: &str| numbers_of(&glb, &doc, attributes[name].as_u64().unwrap() as usize);
        let near = |got: Vec<f32>, want: &[f32]| got.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-5) && got.len() == want.len();
        let half = std::f32::consts::FRAC_1_SQRT_2;
        assert!(near(numbers("TRANSLATION"), &[0.0, 0.0, 0.0, 1.0, 2.0, 3.0, 0.0, 0.0, 0.0]), "{:?}", numbers("TRANSLATION"));
        assert!(near(numbers("ROTATION"), &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, half, half, 0.0, 0.0, 0.0, 1.0]), "{:?}", numbers("ROTATION"));
        assert!(near(numbers("SCALE"), &[1.0, 1.0, 1.0, 2.0, 2.0, 2.0, -1.0, 1.0, 1.0]), "{:?}", numbers("SCALE"));
    }

    /// The numbers an accessor of a made model holds, read from its binary chunk.
    fn numbers_of(glb: &[u8], doc: &Value, accessor: usize) -> Vec<f32> {
        let length = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        let bin = &glb[20 + length + 8..];
        let view = &doc["bufferViews"][doc["accessors"][accessor]["bufferView"].as_u64().unwrap() as usize];
        let (at, size) = (view["byteOffset"].as_u64().unwrap() as usize, view["byteLength"].as_u64().unwrap() as usize);
        bin[at..at + size].chunks(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect()
    }

    /// A gripper's finger that follows the driven one, as Isaac writes it with PhysX's mimic joint.
    #[test]
    fn mimic_joints() {
        let dir = scratch("mimic");
        write(&dir, "gripper.usda", r#"#usda 1.0
def Xform "gripper"
{
    def Cube "base" (prepend apiSchemas = ["PhysicsRigidBodyAPI"]) { }
    def Cube "left" (prepend apiSchemas = ["PhysicsRigidBodyAPI"]) { }
    def Cube "right" (prepend apiSchemas = ["PhysicsRigidBodyAPI"]) { }
    def PhysicsRevoluteJoint "finger_joint"
    {
        rel physics:body0 = </gripper/base>
        rel physics:body1 = </gripper/left>
    }
    def PhysicsRevoluteJoint "right_joint" (prepend apiSchemas = ["PhysxMimicJointAPI:rotX"])
    {
        rel physics:body0 = </gripper/base>
        rel physics:body1 = </gripper/right>
        float physxMimicJoint:rotX:gearing = -1
        float physxMimicJoint:rotX:offset = 0.25
        rel physxMimicJoint:rotX:referenceJoint = </gripper/finger_joint>
    }
}
"#);
        let doc = json_of(&make(&dir.join("gripper.usda"), &dir).unwrap().glb);
        let joints = &doc["scenes"][0]["extras"]["joints"];
        assert_eq!(joints[0]["mimic"], Value::Null);
        assert_eq!(joints[1]["mimic"], json!({ "joint": 0, "gearing": -1.0, "offset": 0.25 }));
    }

    /// Materials as Unreal writes them, each an MDL of its own read by its inputs' names.
    #[test]
    fn unreal_materials() {
        let dir = scratch("unreal");
        let material = |name: &str, inputs: &str| {
            format!(
                "def Material \"{name}\" {{\n token outputs:mdl:surface.connect = </Looks/{name}/Shader.outputs:out>\n\
                 def Shader \"Shader\" {{\n uniform token info:implementationSource = \"sourceAsset\"\n\
                 uniform asset info:mdl:sourceAsset = @MI_{name}.mdl@\n {inputs}\n token outputs:out\n }}\n}}\n"
            )
        };
        let cube = |name: &str| format!("def Cube \"{name}\" (prepend apiSchemas = [\"MaterialBindingAPI\"]) {{ rel material:binding = </Looks/{name}> }}\n");
        let text = format!(
            "#usda 1.0\ndef Scope \"Looks\" {{\n{}{}{}}}\n{}{}{}",
            material(
                "Floor",
                "float4 inputs:ColorAlbedo = (0.01, 0.02, 0.03, 0)\n asset inputs:MainNormalInput = @floor_N.png@\n\
                 asset inputs:AlbedoTexture = @floor_D.png@\n float inputs:RoughnessMin = 0.2\n float inputs:RoughnessMax = 0.6"
            ),
            material("Paper", "float4 inputs:ColorAlbedo = (1, 0.5, 0, 1)\n float4 inputs:BaseColor_Tint = (0.5, 1, 1, 1)\n float inputs:Metallic = 0.25"),
            material("Sign", "asset inputs:TextureSelection = @sign_d.png@\n float4 inputs:EmissionColor = (1, 0, 0, 1)"),
            cube("Floor"),
            cube("Paper"),
            cube("Sign"),
        );
        write(&dir, "hall.usda", &text);
        for image in ["floor_N.png", "floor_D.png", "sign_d.png"] {
            write(&dir, image, "a picture");
        }
        let made = make(&dir.join("hall.usda"), &dir).unwrap();
        let doc = json_of(&made.glb);
        let pbr = |name: &str| doc["materials"].as_array().unwrap().iter().find(|m| m["name"] == name).unwrap()["pbrMetallicRoughness"].clone();
        let floor = pbr("Floor");
        assert_eq!(floor["baseColorFactor"], json!([1.0, 1.0, 1.0, 1.0]));
        assert!(floor["baseColorTexture"].is_object());
        assert!((floor["roughnessFactor"].as_f64().unwrap() - 0.4).abs() < 1e-6);
        let paper = pbr("Paper");
        assert_eq!(paper["baseColorFactor"], json!([0.5, 0.5, 0.0, 1.0]));
        assert_eq!(paper["metallicFactor"], 0.25);
        assert!(pbr("Sign")["baseColorTexture"].is_object());
        let read: HashSet<String> = made.read.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(read, ["hall.usda", "floor_D.png", "sign_d.png"].map(String::from).into());
    }

    /// Serves `files` over http on loopback while the tests run, and 404 for anything else.
    fn serve(files: HashMap<&'static str, &'static str>) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut request = [0u8; 4096];
                let n = io::Read::read(&mut stream, &mut request).unwrap_or(0);
                let line = String::from_utf8_lossy(&request[..n]);
                let reply = match files.get(line.split_whitespace().nth(1).unwrap_or_default()) {
                    Some(body) => format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()),
                    None => "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string(),
                };
                let _ = io::Write::write_all(&mut stream, reply.as_bytes());
            }
        });
        port
    }

    /// A layer on a web server is downloaded into the files folder, and so is one it names
    /// beside it. One that is not there is a problem.
    #[test]
    fn web_files_are_downloaded() {
        let port = serve(HashMap::from([
            ("/parts/box.usda", "#usda 1.0\n(\n    subLayers = [@shape.usda@]\n)\n"),
            ("/parts/shape.usda", "#usda 1.0\ndef Cube \"box\"\n{\n}\n"),
        ]));
        let dir = scratch("web");
        let cell = format!(
            "#usda 1.0\ndef \"box\" (prepend references = @http://127.0.0.1:{port}/parts/box.usda@</box>)\n{{\n}}\n\
             def Xform \"gone\" (prepend references = @http://127.0.0.1:{port}/parts/gone.usda@)\n{{\n}}\n"
        );
        write(&dir, "cell.usda", &cell);
        let made = make(&dir.join("cell.usda"), &dir).unwrap();
        let doc = json_of(&made.glb);
        assert_eq!(doc["meshes"].as_array().unwrap().len(), 1);
        let mirror = dir.join("downloaded").join(format!("127.0.0.1+{port}")).join("parts");
        assert!(mirror.join("box.usda").is_file() && mirror.join("shape.usda").is_file());
        assert!(!mirror.join("gone.usda").exists());
        let problems = doc["scenes"][0]["extras"]["problems"].to_string();
        assert!(problems.contains(&format!("http://127.0.0.1:{port}/parts/gone.usda: could not download it")), "{problems}");
        assert!(problems.contains("404"), "{problems}");
        // the downloads are read as the folder's own files
        let read: HashSet<String> = made.read.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(read, ["cell.usda", "box.usda", "shape.usda"].map(String::from).into());
    }

    #[test]
    fn shapes_on_their_axis() {
        let dir = scratch("shapes");
        write(&dir, "shapes.usda", r#"#usda 1.0
def Cylinder "rod"
{
    uniform token axis = "X"
    double radius = 0.5
    double height = 4
}
"#);
        let doc = json_of(&make(&dir.join("shapes.usda"), &dir).unwrap().glb);
        // no units or up axis written: centimetres, y up
        assert_eq!(doc["nodes"][0]["scale"], json!([0.01, 0.01, 0.01]));
        assert!(doc["nodes"][0]["rotation"].is_null());
        let position = &doc["accessors"][doc["meshes"][0]["primitives"][0]["attributes"]["POSITION"].as_u64().unwrap() as usize];
        assert_eq!(position["min"][0], -2.0);
        assert_eq!(position["max"][0], 2.0);
        assert!((position["max"][1].as_f64().unwrap() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn no_geometry_says_so() {
        let dir = scratch("empty");
        write(&dir, "empty.usda", "#usda 1.0\ndef Xform \"nothing\"\n{\n}\n");
        assert!(make(&dir.join("empty.usda"), &dir).err().unwrap().contains("no mesh or shape"));
        assert!(make(&dir.join("missing.usda"), &dir).err().unwrap().contains("could not read it as USD"));
    }

    /// Reads a made model's JSON chunk.
    fn json_of(glb: &[u8]) -> Value {
        let length = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        serde_json::from_slice(&glb[20..20 + length]).unwrap()
    }

    /// Makes each robot USD_ROBOTS lists, a files folder and a file a line, into a model in
    /// USD_OUT, and prints what it holds to compare with what Pixar's USD reads.
    #[test]
    #[ignore]
    fn robots() {
        let list = std::env::var("USD_ROBOTS").unwrap();
        let out = PathBuf::from(std::env::var("USD_OUT").unwrap());
        for line in fs::read_to_string(list).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let (folder, file) = line.split_once('\t').unwrap();
            let start = std::time::Instant::now();
            let made = make(Path::new(file), Path::new(folder));
            let took = start.elapsed().as_millis();
            let name = Path::new(file).file_stem().unwrap().to_string_lossy().to_string();
            let made = match made {
                Ok(made) => made,
                Err(e) => {
                    println!("{name}: FAILED in {took} ms: {e}\n");
                    continue;
                }
            };
            fs::write(out.join(format!("{name}.glb")), &made.glb).unwrap();
            let doc = json_of(&made.glb);
            let scene = &doc["scenes"][0]["extras"];
            let nodes = doc["nodes"].as_array().unwrap();
            let links = nodes.iter().filter(|n| n["extras"]["link"].is_string()).count();
            let drawn = nodes.iter().filter(|n| n["mesh"].is_number()).count();
            let triangles: u64 = doc["meshes"].as_array().unwrap().iter().flat_map(|m| m["primitives"].as_array().unwrap()).map(|p| doc["accessors"][p["indices"].as_u64().unwrap() as usize]["count"].as_u64().unwrap() / 3).sum();
            println!(
                "{name}: {took} ms, {} KB, {links} links, {drawn} drawn, {} meshes, {triangles} triangles, {} materials, {} images, {} files read",
                made.glb.len() / 1024,
                doc["meshes"].as_array().unwrap().len(),
                doc["materials"].as_array().unwrap().len(),
                doc["images"].as_array().map_or(0, Vec::len),
                made.read.len()
            );
            println!("  unit {}", scene["metersPerUnit"]);
            for r in scene["robots"].as_array().unwrap() {
                println!("  robot {} at {} moving {}", r["name"], r["path"], r["moving"]);
            }
            for j in scene["joints"].as_array().unwrap() {
                println!("  joint {} {} {} -> {} axis {}", j["name"], j["kind"], j["parent"], j["child"], j["axis"]);
            }
            for m in doc["materials"].as_array().unwrap().iter().take(8) {
                println!("  material {} {}", m["name"], m["pbrMetallicRoughness"]);
            }
            for p in scene["problems"].as_array().unwrap().iter().take(8) {
                println!("  problem {p}");
            }
            println!();
        }
    }
}

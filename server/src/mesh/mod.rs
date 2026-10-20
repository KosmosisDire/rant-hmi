//! The HMI's one Rant node: what the mesh offers, and a live handle for each import.

pub mod codec;

use std::collections::HashMap;

use std::future::Future;

use rant::types::{VideoCodec, VideoFrame};
use rant::{Bytes, CallOptions, CallStatus, Entity, EntityKind, FunctionOptions, Node, NodeOptions, Publisher, Qos, RemoteFunction, RemoteVariable, Schema, Subscriber, VariableOptions};
use crate::value::Value;
use crate::video::{Frame, ToVideo};
use tokio::sync::mpsc::UnboundedSender;
use tracing::warn;

use crate::project::{Import, Intent, Kind};
use crate::protocol::{EntityInfo, PeerInfo};
use crate::script::CallFailure;
use codec::Shape;

pub struct MeshOptions {
    pub name: String,
    /// 0 takes RANT_DOMAIN, else 0.
    pub domain: u16,
    /// Discovery on 127.0.0.1 only, so nothing leaves this host.
    pub loopback: bool,
}

/// A value an import's handle delivered, sent from Rant's own thread.
pub struct Delivery {
    pub alias: String,
    pub value: Value,
}

pub struct Mesh {
    node: Node,
    deliveries: UnboundedSender<Delivery>,
    attached: HashMap<String, Attached>,
    frames: UnboundedSender<ToVideo>,
    /// The video each played import comes from, and its subscription.
    videos: HashMap<String, (String, Subscriber<VideoFrame>)>,
}

struct Attached {
    /// The import as it was attached, so a new intent remakes the handle.
    import: Import,
    generation: u64,
    schema: Schema,
    shapes: Vec<Shape>,
    handle: Handle,
}

enum Handle {
    /// The subscription is held only so it lives. A topic imported to write publishes too.
    Topic { _subscription: Subscriber<Bytes>, publisher: Option<Publisher<Bytes>> },
    Variable(RemoteVariable<Bytes>),
    /// A function: its request goes by the import's schema, its answer by `answer`'s.
    Function { remote: RemoteFunction<Bytes, Bytes>, answer: Option<(Schema, Vec<Shape>)> },
    /// A task. Handlers will start it, nothing watches it.
    Task,
}

impl Mesh {
    pub fn open(options: &MeshOptions, deliveries: UnboundedSender<Delivery>, frames: UnboundedSender<ToVideo>) -> Result<Mesh, rant::Error> {
        // fetch_details lists every entity with its schema, as an observer tool needs
        let mut o = NodeOptions::new().domain(options.domain).max_topics(256).fetch_details(true);
        if options.loopback {
            o = o.multicast_interface("127.0.0.1");
        }
        Ok(Mesh { node: Node::new(&options.name, o)?, deliveries, attached: HashMap::new(), frames, videos: HashMap::new() })
    }

    /// Changes whenever anything on the mesh does.
    pub fn epoch(&self) -> u32 {
        self.node.reflection().epoch()
    }

    /// Every entity a user can import. Rant's own `@rant/` entities and ones whose details
    /// have not arrived are left out.
    pub fn entities(&self) -> Vec<EntityInfo> {
        let mut out: Vec<EntityInfo> = self.node.reflection().mesh().iter().filter_map(entity_info).collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    pub fn peers(&self) -> Vec<PeerInfo> {
        self.node
            .reflection()
            .peers()
            .into_iter()
            .map(|p| PeerInfo {
                id: p.id,
                name: p.name,
                address: p.address,
                active: p.active,
                rtt_ms: (p.rtt_samples > 0).then(|| p.rtt_us as f64 / 1000.0),
            })
            .collect()
    }

    fn find(&self, import: &Import) -> Option<Entity> {
        self.node.reflection().find(entity_kind(import.kind), &import.entity)
    }

    /// True while the import's entity has a live provider.
    pub fn live(&self, import: &Import) -> bool {
        self.find(import).is_some_and(|e| e.providers > 0)
    }

    /// Makes or remakes an import's handle to match the import and the mesh, keeping it while
    /// neither changed. False while its entity, or its schema, is not on the mesh.
    pub fn attach(&mut self, import: &Import) -> bool {
        let Some(entity) = self.find(import) else {
            self.attached.remove(&import.alias);
            return false;
        };
        if self.attached.get(&import.alias).is_some_and(|a| a.generation == entity.generation && a.import == *import) {
            return true;
        }
        // the old handle goes first, so its name is free for the new one
        self.attached.remove(&import.alias);
        let Some(schema) = entity.schema.clone() else { return false };
        match self.handle(import, &entity, schema) {
            Ok(a) => {
                self.attached.insert(import.alias.clone(), a);
                true
            }
            Err(e) => {
                warn!("could not watch {} ({}): {e}", import.alias, import.entity);
                false
            }
        }
    }

    pub fn detach(&mut self, alias: &str) {
        self.attached.remove(alias);
    }

    fn handle(&self, import: &Import, entity: &Entity, schema: Schema) -> Result<Attached, String> {
        let shapes = codec::shapes(&schema);
        let (alias, tx, tree) = (import.alias.clone(), self.deliveries.clone(), shapes.clone());
        let deliver = move |value: Value| {
            let _ = tx.send(Delivery { alias: alias.clone(), value });
        };
        let handle = match import.kind {
            Kind::Topic => {
                let qos = Qos::new().schema(&schema).reliable(entity.reliable);
                let sub = self.node.subscriber::<Bytes>(&import.entity, qos.clone(), move |m| deliver(codec::decode(&m, &tree)));
                let publisher = match import.intent {
                    Intent::Write => Some(self.node.publisher::<Bytes>(&import.entity, qos).map_err(|e| e.to_string())?),
                    Intent::Read => None,
                };
                Handle::Topic { _subscription: sub.map_err(|e| e.to_string())?, publisher }
            }
            Kind::Variable => {
                let var = self
                    .node
                    .remote_variable::<Bytes>(&import.entity, VariableOptions::new().schema(&schema))
                    .map_err(|e| e.to_string())?;
                var.on_change(move |u| deliver(codec::decode(&u.into_inner(), &tree))).map_err(|e| e.to_string())?;
                Handle::Variable(var)
            }
            Kind::Function => {
                let mut o = FunctionOptions::new().request_schema(&schema);
                if let Some(answer) = &entity.response_schema {
                    o = o.response_schema(answer);
                }
                let remote = self.node.remote_function::<Bytes, Bytes>(&import.entity, o).map_err(|e| e.to_string())?;
                let answer = entity.response_schema.clone().map(|s| {
                    let shapes = codec::shapes(&s);
                    (s, shapes)
                });
                Handle::Function { remote, answer }
            }
            Kind::Task => Handle::Task,
        };
        Ok(Attached { import: import.clone(), generation: entity.generation, schema, shapes, handle })
    }

    /// Plays an import's video: the entity itself when it carries video frames, else its
    /// `Video` child, which rant-transcoder makes. Keeps the subscription while the source stays.
    pub fn play(&mut self, import: &Import) {
        let reflection = self.node.reflection();
        let child = format!("{}/Video", import.entity);
        let frames = |name: &str| reflection.find(EntityKind::Topic, name).filter(|e| e.schema.as_ref().is_some_and(|s| s.name() == "VideoFrame"));
        let Some(source) = frames(&child).or_else(|| frames(&import.entity)) else {
            self.videos.remove(&import.alias);
            return;
        };
        if self.videos.get(&import.alias).is_some_and(|(name, _)| *name == source.name) {
            return;
        }
        self.videos.remove(&import.alias);
        let (alias, tx) = (import.alias.clone(), self.frames.clone());
        let sub = self.node.subscriber::<VideoFrame>(&source.name, Qos::new().reliable(source.reliable), move |m| {
            if m.codec == VideoCodec::H264 {
                let f = m.into_inner();
                let _ = tx.send(ToVideo::Frame(Frame { alias: alias.clone(), keyframe: f.keyframe, pts: f.pts.us, data: f.data }));
            }
        });
        match sub {
            Ok(sub) => {
                self.videos.insert(import.alias.clone(), (source.name.clone(), sub));
            }
            Err(e) => warn!("could not play {} ({}): {e}", import.alias, source.name),
        }
    }

    pub fn stop_playing(&mut self, alias: &str) {
        self.videos.remove(alias);
    }

    fn attached(&self, alias: &str) -> Result<&Attached, String> {
        self.attached.get(alias).ok_or_else(|| format!("{alias} is not on the mesh right now"))
    }

    /// Sets a variable import, whole or one field of it. A field write starts from `last`,
    /// the value the HMI holds, else from the schema's defaults.
    pub fn set(&self, alias: &str, path: &str, value: Value, last: Option<&Value>) -> Result<(), String> {
        let a = self.attached(alias)?;
        let Handle::Variable(var) = &a.handle else {
            return Err(format!("{alias} is not a variable, so it cannot be set"));
        };
        let whole = match path.is_empty() {
            true => value,
            false => {
                let mut base = last.cloned().unwrap_or_else(|| codec::default_value(&a.schema, &a.shapes));
                codec::put(&mut base, path, value)?;
                base
            }
        };
        let bytes = codec::encode(&a.schema, &a.shapes, &whole)?;
        var.set(&bytes).map_err(|e| format!("{alias} refused the write: {e}"))
    }

    /// Sends a message on a topic imported to write.
    pub fn send(&self, alias: &str, value: &Value) -> Result<(), String> {
        let a = self.attached(alias)?;
        let Handle::Topic { publisher: Some(publisher), .. } = &a.handle else {
            return Err(format!("{alias} is not a topic imported to write, so it cannot send"));
        };
        let bytes = codec::encode(&a.schema, &a.shapes, value)?;
        publisher.send(&bytes).map_err(|e| format!("{alias} could not send: {e}"))
    }

    /// Calls a function import. The call leaves at once, the answer comes when awaited.
    pub fn call(&self, alias: &str, request: &Value) -> Result<impl Future<Output = Result<Value, CallFailure>> + Send + 'static, String> {
        let a = self.attached(alias)?;
        let Handle::Function { remote, answer } = &a.handle else {
            return Err(format!("{alias} is not a function, so it cannot be called"));
        };
        let bytes = codec::encode(&a.schema, &a.shapes, request)?;
        let pending = remote.call_async(&bytes, CallOptions::new()).map_err(|e| format!("{alias} could not be called: {e}"))?;
        let answer = answer.clone();
        Ok(async move {
            let r = pending.await;
            if !r.is_ok() {
                return Err(CallFailure { status: status_word(r.status()).to_owned(), message: r.message().to_owned() });
            }
            Ok(match (r.value(), answer) {
                (Some(bytes), Some((schema, shapes))) => codec::decode(&schema.view(bytes), &shapes),
                _ => Value::Null,
            })
        })
    }
}

fn status_word(s: CallStatus) -> &'static str {
    match s {
        CallStatus::Ok => "ok",
        CallStatus::AppError => "app_error",
        CallStatus::NoHandler => "no_handler",
        CallStatus::Timeout => "timeout",
        CallStatus::PeerLost => "peer_lost",
        CallStatus::Cancelled => "cancelled",
        CallStatus::Running => "running",
        CallStatus::NoProvider => "no_provider",
        _ => "unknown",
    }
}

fn entity_kind(kind: Kind) -> EntityKind {
    match kind {
        Kind::Topic => EntityKind::Topic,
        Kind::Variable => EntityKind::Variable,
        Kind::Function => EntityKind::Function,
        Kind::Task => EntityKind::Task,
    }
}

fn entity_info(e: &Entity) -> Option<EntityInfo> {
    if e.name.starts_with("@rant/") || e.name.starts_with("0x") || e.name.is_empty() {
        return None;
    }
    let kind = match e.kind {
        EntityKind::Topic => Kind::Topic,
        EntityKind::Variable => Kind::Variable,
        EntityKind::Function => Kind::Function,
        EntityKind::Task => Kind::Task,
        _ => return None,
    };
    Some(EntityInfo {
        name: e.name.clone(),
        kind,
        writable: e.writable,
        forceable: e.forceable,
        providers: e.providers,
        schema: e.schema.as_ref().map(codec::type_info),
        response: e.response_schema.as_ref().map(codec::type_info),
    })
}

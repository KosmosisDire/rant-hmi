//! The HMI's one Rant node: what the mesh offers, and a live handle for each import.

pub mod codec;

use std::collections::HashMap;

use rant::{Bytes, Entity, EntityKind, Node, NodeOptions, Qos, RemoteVariable, Schema, Subscriber, VariableOptions};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;
use tracing::warn;

use crate::project::{Import, Kind};
use crate::protocol::{EntityInfo, PeerInfo};
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
}

struct Attached {
    generation: u64,
    schema: Schema,
    shapes: Vec<Shape>,
    handle: Handle,
}

enum Handle {
    /// Held only so its subscription lives. Dropping it ends the subscription.
    Topic { _subscription: Subscriber<Bytes> },
    Variable(RemoteVariable<Bytes>),
    /// A function or task. Handlers will call it, nothing watches it.
    Call,
}

impl Mesh {
    pub fn open(options: &MeshOptions, deliveries: UnboundedSender<Delivery>) -> Result<Mesh, rant::Error> {
        // fetch_details lists every entity with its schema, as an observer tool needs
        let mut o = NodeOptions::new().domain(options.domain).max_topics(256).fetch_details(true);
        if options.loopback {
            o = o.multicast_interface("127.0.0.1");
        }
        Ok(Mesh { node: Node::new(&options.name, o)?, deliveries, attached: HashMap::new() })
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

    /// Makes or remakes an import's handle to match the mesh, keeping it while nothing
    /// changed. False while its entity, or its schema, is not on the mesh.
    pub fn attach(&mut self, import: &Import) -> bool {
        let Some(entity) = self.find(import) else {
            self.attached.remove(&import.alias);
            return false;
        };
        if self.attached.get(&import.alias).is_some_and(|a| a.generation == entity.generation) {
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
                let sub = self.node.subscriber::<Bytes>(&import.entity, qos, move |m| deliver(codec::decode(&m, &tree)));
                Handle::Topic { _subscription: sub.map_err(|e| e.to_string())? }
            }
            Kind::Variable => {
                let var = self
                    .node
                    .remote_variable::<Bytes>(&import.entity, VariableOptions::new().schema(&schema))
                    .map_err(|e| e.to_string())?;
                var.on_change(move |u| deliver(codec::decode(&u.into_inner(), &tree))).map_err(|e| e.to_string())?;
                Handle::Variable(var)
            }
            Kind::Function | Kind::Task => Handle::Call,
        };
        Ok(Attached { generation: entity.generation, schema, shapes, handle })
    }

    /// Sets a variable import, whole or one field of it. A field write starts from `last`,
    /// the value the HMI holds, else from the schema's defaults.
    pub fn set(&self, alias: &str, path: &str, value: Value, last: Option<&Value>) -> Result<(), String> {
        let a = self.attached.get(alias).ok_or_else(|| format!("{alias} is not on the mesh right now"))?;
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

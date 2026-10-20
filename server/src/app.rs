//! The backend's one loop. It owns the project, the mesh and every screen's session, so
//! nothing is shared and nothing locks.

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use serde_json::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tracing::{info, warn};

use crate::authorize::{Who, authorize};
use crate::mesh::{Delivery, Mesh};
use crate::pages::{Edit, Pages};
use crate::project::{Intent, Kind, Project};
use crate::protocol::{ClientMsg, ServerMsg, ValueUpdate};

/// How often changed values go out and the mesh is checked.
const TICK: Duration = Duration::from_millis(33);
/// A screen silent this long is lost.
const SILENCE: Duration = Duration::from_millis(500);
const HEALTH_EVERY: Duration = Duration::from_secs(1);

/// What a screen's connection hands the loop.
pub enum Inbound {
    /// `out` takes the screen's encoded messages.
    Open { session: u32, out: UnboundedSender<Bytes> },
    Message { session: u32, msg: ClientMsg },
    Close { session: u32 },
}

struct Session {
    out: UnboundedSender<Bytes>,
    heard: Instant,
}

#[derive(Default)]
struct Slot {
    value: Option<Value>,
    known: bool,
}

pub struct App {
    project: Project,
    pages: Pages,
    mesh: Mesh,
    node: String,
    sessions: HashMap<u32, Session>,
    values: HashMap<String, Slot>,
    changed: BTreeSet<String>,
    epoch: Option<u32>,
    health_at: Instant,
}

impl App {
    pub fn new(project: Project, pages: Pages, mesh: Mesh, node: String) -> App {
        App {
            project,
            pages,
            mesh,
            node,
            sessions: HashMap::new(),
            values: HashMap::new(),
            changed: BTreeSet::new(),
            epoch: None,
            health_at: Instant::now(),
        }
    }

    /// Runs until Ctrl C.
    pub async fn run(mut self, mut deliveries: UnboundedReceiver<Delivery>, mut inbound: UnboundedReceiver<Inbound>) {
        let mut tick = tokio::time::interval(TICK);
        let shutdown = tokio::signal::ctrl_c();
        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                Some(d) = deliveries.recv() => self.deliver(d),
                Some(i) = inbound.recv() => self.inbound(i),
                _ = tick.tick() => self.tick(),
                _ = &mut shutdown => break,
            }
        }
        for session in self.sessions.keys().copied().collect::<Vec<_>>() {
            self.end(session, "the HMI is closing");
        }
    }

    fn deliver(&mut self, d: Delivery) {
        let slot = self.values.entry(d.alias.clone()).or_default();
        slot.value = Some(d.value);
        slot.known = true;
        self.changed.insert(d.alias);
    }

    fn inbound(&mut self, i: Inbound) {
        match i {
            Inbound::Open { session, out } => {
                self.sessions.insert(session, Session { out, heard: Instant::now() });
                info!("screen {session} connected");
                self.welcome(session);
            }
            Inbound::Message { session, msg } => {
                let Some(s) = self.sessions.get_mut(&session) else { return };
                s.heard = Instant::now();
                self.handle(session, msg);
            }
            Inbound::Close { session } => {
                if self.sessions.contains_key(&session) {
                    self.end(session, "closed");
                }
            }
        }
    }

    /// Everything a screen needs to draw, in one go.
    fn welcome(&mut self, session: u32) {
        let hello = ServerMsg::Hello {
            session,
            project: self.project.info.clone(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            node: self.node.clone(),
        };
        self.send(session, &hello);
        self.send(session, &ServerMsg::Imports { imports: self.project.imports.clone() });
        self.send(session, &ServerMsg::Pages { pages: self.pages.list.clone() });
        self.send(session, &ServerMsg::Mesh { entities: self.mesh.entities() });
        let values = self.project.imports.iter().map(|i| self.update(&i.alias)).collect();
        self.send(session, &ServerMsg::Values { values });
        self.send(session, &ServerMsg::Health { peers: self.mesh.peers() });
    }

    fn handle(&mut self, session: u32, msg: ClientMsg) {
        if let Err(text) = authorize(&Who { session }, &msg) {
            return self.refuse(session, text, None);
        }
        match msg {
            ClientMsg::Ping { t } => self.send(session, &ServerMsg::Pong { t }),
            ClientMsg::Import { import } => match self.project.import(import.clone()) {
                Ok(()) => {
                    info!("imported {} as {}", import.entity, import.alias);
                    self.mesh.attach(&import);
                    self.refresh_known();
                    self.broadcast(&ServerMsg::Imports { imports: self.project.imports.clone() });
                }
                Err(text) => self.refuse(session, text, Some(import.alias)),
            },
            ClientMsg::Unimport { alias } => match self.project.unimport(&alias) {
                Ok(()) => {
                    info!("removed the import {alias}");
                    self.mesh.detach(&alias);
                    self.values.remove(&alias);
                    self.changed.remove(&alias);
                    self.broadcast(&ServerMsg::Imports { imports: self.project.imports.clone() });
                }
                Err(text) => self.refuse(session, text, Some(alias)),
            },
            ClientMsg::Set { alias, path, value } => {
                if let Err(text) = self.set(&alias, &path, value) {
                    self.refuse(session, text, Some(alias));
                }
            }
            ClientMsg::Edit { edit } => self.edit(session, edit),
        }
    }

    /// Applies an edit, saves its page and sends it to every screen. The screen that made
    /// something hears what, so it can select it.
    fn edit(&mut self, session: u32, edit: Edit) {
        match self.pages.apply(edit) {
            Ok(applied) => {
                if let Some(page) = self.pages.get(&applied.page) {
                    self.broadcast(&ServerMsg::Page { page: page.clone() });
                }
                if let Some(id) = applied.made {
                    self.send(session, &ServerMsg::Made { page: applied.page, id });
                }
            }
            Err(text) => self.refuse(session, text, None),
        }
    }

    fn set(&mut self, alias: &str, path: &str, value: Value) -> Result<(), String> {
        let import = self.project.find(alias).ok_or_else(|| format!("{alias} is not an import"))?;
        if import.intent != Intent::Write {
            return Err(format!("{alias} is imported to read. Import it to write to change it."));
        }
        if import.kind != Kind::Variable {
            return Err(format!("{alias} is a {:?}, and only variables can be set for now", import.kind).to_lowercase());
        }
        let last = self.values.get(alias).and_then(|s| s.value.as_ref());
        self.mesh.set(alias, path, value, last)
    }

    fn tick(&mut self) {
        let epoch = self.mesh.epoch();
        if self.epoch != Some(epoch) {
            self.epoch = Some(epoch);
            for import in self.project.imports.clone() {
                self.mesh.attach(&import);
            }
            self.refresh_known();
            self.broadcast(&ServerMsg::Mesh { entities: self.mesh.entities() });
        }
        if !self.changed.is_empty() {
            let values = std::mem::take(&mut self.changed).iter().map(|a| self.update(a)).collect();
            self.broadcast(&ServerMsg::Values { values });
        }
        if self.health_at.elapsed() >= HEALTH_EVERY {
            self.health_at = Instant::now();
            self.broadcast(&ServerMsg::Health { peers: self.mesh.peers() });
        }
        let lost: Vec<u32> = self.sessions.iter().filter(|(_, s)| s.heard.elapsed() > SILENCE).map(|(id, _)| *id).collect();
        for session in lost {
            self.end(session, "lost");
        }
    }

    /// A datapoint is known while its entity is live and, for one with a value, once that
    /// value arrived. The last value stays when it goes unknown.
    fn refresh_known(&mut self) {
        for import in &self.project.imports {
            let live = self.mesh.live(import);
            let slot = self.values.entry(import.alias.clone()).or_default();
            let watched = matches!(import.kind, Kind::Topic | Kind::Variable);
            let known = live && (!watched || slot.value.is_some());
            if slot.known != known {
                slot.known = known;
                self.changed.insert(import.alias.clone());
            }
        }
    }

    fn update(&self, alias: &str) -> ValueUpdate {
        let slot = self.values.get(alias);
        ValueUpdate {
            alias: alias.to_owned(),
            value: slot.and_then(|s| s.value.clone()),
            known: slot.is_some_and(|s| s.known),
        }
    }

    /// Ends a screen's session. Dropping its sender closes its socket. Holds and forces it
    /// started will be let go here once handlers exist.
    fn end(&mut self, session: u32, why: &str) {
        if self.sessions.remove(&session).is_some() {
            info!("screen {session} {why}");
        }
    }

    fn refuse(&self, session: u32, text: String, alias: Option<String>) {
        warn!("screen {session}: {text}");
        self.send(session, &ServerMsg::Refused { text, alias });
    }

    fn send(&self, session: u32, msg: &ServerMsg) {
        if let Some(s) = self.sessions.get(&session) {
            let _ = s.out.send(encode(msg));
        }
    }

    fn broadcast(&self, msg: &ServerMsg) {
        if self.sessions.is_empty() {
            return;
        }
        let text = encode(msg);
        for s in self.sessions.values() {
            let _ = s.out.send(text.clone());
        }
    }
}

fn encode(msg: &ServerMsg) -> Bytes {
    let mut out = Vec::new();
    ciborium::into_writer(msg, &mut out).expect("every server message encodes");
    out.into()
}

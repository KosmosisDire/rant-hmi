//! The project folder: `hmi.toml`, the objects in `objects/` and the theme in `data/`, as
//! `docs/project.md` shows.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use crate::value::Value;
use ts_rs::TS;

use crate::list::{self, Keyed, by_name};
use crate::logic::{Rule, When};
use crate::object::{self, Flat, Function, HMI, Object, ObjectInfo};
use crate::pages::js;
use crate::rules;
use crate::{files, library};

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct ProjectInfo {
    pub name: String,
    /// The page an operator's screen opens on, else the first page.
    #[serde(default)]
    #[ts(optional)]
    pub start: Option<String>,
    /// The STUN and TURN servers screens and the HMI find their way to each other through for
    /// WebRTC, a screen's as it connects.
    #[serde(default = "ice")]
    pub ice: Vec<IceServer>,
}

/// A STUN or TURN server, as a browser's RTCPeerConnection takes it.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct IceServer {
    pub urls: String,
    #[serde(default)]
    #[ts(optional)]
    pub username: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub credential: Option<String>,
}

/// The public STUN servers the bridge also starts with.
fn ice() -> Vec<IceServer> {
    ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"]
        .map(|urls| IceServer { urls: urls.into(), username: None, credential: None })
        .into()
}

/// Why a server a browser would refuse is, if it is. The error is for the user.
fn check_ice(s: &IceServer) -> Result<(), String> {
    let scheme = s.urls.split(':').next().unwrap_or_default();
    match scheme {
        "stun" | "stuns" => Ok(()),
        "turn" | "turns" if s.username.is_some() && s.credential.is_some() => Ok(()),
        "turn" | "turns" => Err(format!("the ice server {} is a TURN server, so it needs a username and credential", s.urls)),
        _ => Err(format!("the ice server {} needs a url starting stun:, stuns:, turn: or turns:", s.urls)),
    }
}

/// The four kinds of Rant entity.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Kind {
    Topic,
    Variable,
    Function,
    Task,
}

/// What the HMI may do with an import. Write means set, send or call.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Intent {
    Read,
    Write,
}

/// One mesh entity as a member of an object, its alias the member's name. Pages and handlers
/// see only members, never the mesh.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq, Eq)]
#[ts(export)]
pub struct Import {
    pub alias: String,
    pub entity: String,
    pub kind: Kind,
    pub intent: Intent,
    /// The most values a second a topic brings, best effort, each the newest at its turn.
    #[serde(default)]
    #[ts(optional)]
    pub rate: Option<u16>,
}

impl Keyed for Import {
    fn key(&self) -> &str {
        &self.alias
    }
}

/// Whose value a variable holds: one every screen shares, or one per screen.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Per {
    #[default]
    Hmi,
    Screen,
}

/// State, named in camelCase, with the value it starts from.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Variable {
    pub name: String,
    pub start: Value,
    #[serde(default)]
    pub per: Per,
}

/// A value's history, named in camelCase: `source` sampled every `every_ms`, each sample kept
/// for `keep_s` seconds. Pages read it as a list of `{ t, v }`, oldest first.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Record {
    pub name: String,
    /// An expression over its object's members and other objects'.
    pub source: String,
    pub every_ms: u32,
    pub keep_s: u32,
}

/// A value worked out from others, as a C# property is, named in camelCase: a pure getter,
/// and a setter when a write can go back through one target.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Computed {
    pub name: String,
    /// An expression over members, with no writes.
    pub get: String,
    #[serde(default)]
    #[ts(optional)]
    pub set: Option<Setter>,
    #[serde(default)]
    #[ts(optional)]
    pub unit: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub note: Option<String>,
}

/// Where a write to a computed value goes: `target`, a member of its own or another object's
/// written `Line.Speed`, takes `value`, an expression of the new value `v`. `Duty` takes
/// `v * 0.4`.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Setter {
    pub target: String,
    pub value: String,
}

/// A design value with one value per mode, read as `$name` anywhere, components too. Each is
/// an expression over other tokens and the math: a colour, a number or a text.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Token {
    /// camelCase, written without the `$` code puts before it.
    pub name: String,
    pub dark: String,
    /// Empty for the dark value in light too, as a radius or a spacing is.
    #[serde(default)]
    pub light: String,
}

#[derive(Serialize, Deserialize, Default)]
struct ThemeFile {
    #[serde(default, rename = "token")]
    tokens: Vec<Token>,
}

by_name!(Variable, Record, Computed, Token);

pub struct Project {
    root: PathBuf,
    pub info: ProjectInfo,
    /// Hmi first, then the rest by name.
    objects: Vec<Object>,
    /// What the objects hold by key, worked out anew at each change.
    flat: Flat,
    pub tokens: Vec<Token>,
}

impl Project {
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Opens the folder, starting an empty project there when it holds none.
    pub fn open(root: &Path) -> Result<Project> {
        let hmi = root.join("hmi.toml");
        if !hmi.exists() {
            fs::create_dir_all(root).with_context(|| format!("making {}", root.display()))?;
            let name = fs::canonicalize(root)
                .ok()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                .unwrap_or_else(|| "HMI".to_owned());
            fs::write(&hmi, toml::to_string(&ProjectInfo { name, start: None, ice: ice() })?).with_context(|| format!("writing {}", hmi.display()))?;
            library::seed(root)?;
        }
        let info: ProjectInfo = toml::from_str(&read(&hmi)?).with_context(|| format!("reading {}", files::shown(root, &hmi)))?;
        info.ice.iter().try_for_each(check_ice).map_err(|e| anyhow!("{}: {e}", files::shown(root, &hmi)))?;
        let mut objects = Vec::new();
        let dir = root.join("objects");
        let mut found: Vec<PathBuf> = match fs::read_dir(&dir) {
            Ok(entries) => entries.filter_map(|e| Some(e.ok()?.path())).filter(|p| p.extension().is_some_and(|x| x == "html")).collect(),
            Err(_) => Vec::new(),
        };
        found.sort();
        for path in found {
            let shown = files::shown(root, &path);
            let o = object::parse(&read(&path)?).map_err(|e| anyhow!("{shown}: {e}"))?;
            if path.file_name().is_none_or(|n| n.to_string_lossy() != file_of(&o.name)) {
                return Err(anyhow!("{shown} holds {}, so it is named {}", o.name, file_of(&o.name)));
            }
            objects.push(o);
        }
        if !objects.iter().any(|o| o.name == HMI) {
            objects.push(Object::hmi());
        }
        sort(&mut objects);
        check_all(&objects).map_err(|e| anyhow!("objects: {e}"))?;
        let tokens = load_theme(root)?;
        Ok(Project { root: root.to_path_buf(), info, flat: Flat::of(&objects), objects, tokens })
    }

    pub fn objects(&self) -> &[Object] {
        &self.objects
    }

    pub fn flat(&self) -> &Flat {
        &self.flat
    }

    pub fn object(&self, name: &str) -> Option<&Object> {
        self.objects.iter().find(|o| o.name == name)
    }

    /// Whether `key` names a member only its object's own code reads.
    pub fn local(&self, key: &str) -> bool {
        key.split_once('.').is_some_and(|(o, m)| self.object(o).is_some_and(|o| o.has(m) && !o.global(m)))
    }

    /// Adds, changes or with None removes the token called `name`, and saves. A change may
    /// rename it. The error is for the user.
    pub fn set_token(&mut self, name: &str, to: Option<Token>) -> Result<(), String> {
        if let Some(t) = &to {
            rules::TOKEN.check(&t.name, "a token")?;
            if list::taken(&self.tokens, &t.name, name) {
                return Err(format!("${} is already a token", t.name));
            }
        }
        list::put(&mut self.tokens, name, to, || format!("${name} is not a token"))?;
        files::write_toml(&theme_file(&self.root), &ThemeFile { tokens: self.tokens.clone() })
    }

    /// Makes `page` the one operators' screens open on, and saves.
    pub fn set_start(&mut self, page: String) -> Result<(), String> {
        self.info.start = Some(page);
        files::write_toml(&self.root.join("hmi.toml"), &self.info)
    }

    pub fn variable(&self, key: &str) -> Option<&Variable> {
        self.flat.variables.iter().find(|v| v.name == key)
    }

    pub fn record(&self, key: &str) -> Option<&Record> {
        self.flat.records.iter().find(|r| r.name == key)
    }

    pub fn computed(&self, key: &str) -> Option<&Computed> {
        self.flat.computed.iter().find(|c| c.name == key)
    }

    pub fn function(&self, key: &str) -> Option<&Function> {
        self.flat.functions.iter().find(|f| f.name == key)
    }

    pub fn find(&self, key: &str) -> Option<&Import> {
        self.flat.imports.iter().find(|i| i.alias == key)
    }

    /// What `key` names among the objects' members.
    pub fn look_up(&self, key: &str) -> Found<'_> {
        look_up(&self.objects, key)
    }

    /// Adds, changes or with None removes the object called `name`, its members kept through a
    /// change, and saves. Code that reads it follows a rename. Hmi stays as it is named.
    pub fn set_object(&mut self, name: &str, to: Option<ObjectInfo>) -> Result<(), String> {
        if name == HMI && to.as_ref().is_none_or(|o| o.name != HMI) {
            return Err("Hmi is the HMI's own object, so it stays and keeps its name".into());
        }
        let mut next = self.objects.clone();
        let renamed = to.as_ref().map(|o| o.name.clone()).filter(|n| !name.is_empty() && n != name);
        let to = to.map(|info| match self.object(name) {
            Some(o) => Object { name: info.name, mesh: info.mesh, note: info.note, ..o.clone() },
            None => Object::new(info),
        });
        list::put(&mut next, name, to, || format!("there is no object {name}"))?;
        if let Some(to) = renamed {
            follow(&mut next, name, None, &to);
        }
        self.commit(next)
    }

    /// Adds a mesh member to an object, and saves.
    pub fn import(&mut self, object: &str, mut import: Import) -> Result<(), String> {
        import.intent = callable(import.kind).unwrap_or(import.intent);
        self.edit(object, |o| {
            o.free(&import.alias, "an import", "")?;
            o.imports.push(import);
            Ok(None)
        })
    }

    /// Changes a mesh member's name, intent or rate, and saves. Its entity and kind stay.
    pub fn change(&mut self, object: &str, alias: &str, mut to: Import) -> Result<(), String> {
        to.intent = callable(to.kind).unwrap_or(to.intent);
        self.edit(object, |o| {
            let old = o.imports.iter().find(|i| i.alias == alias).ok_or_else(|| format!("{alias} is not an import of {}", o.name))?;
            if to.entity != old.entity || to.kind != old.kind {
                return Err(format!("{alias} stays an import of {}", old.entity));
            }
            put_member(o, |o| &mut o.imports, alias, Some(to), "an import")
        })
    }

    pub fn unimport(&mut self, object: &str, alias: &str) -> Result<(), String> {
        self.edit(object, |o| put_member(o, |o| &mut o.imports, alias, None, "an import"))
    }

    /// Adds, changes or with None removes an object's variable, and saves. A change may rename
    /// it. The error is for the user, as with every member below.
    pub fn set_variable(&mut self, object: &str, name: &str, to: Option<Variable>) -> Result<(), String> {
        self.edit(object, |o| put_member(o, |o| &mut o.variables, name, to, "a variable"))
    }

    pub fn set_record(&mut self, object: &str, name: &str, to: Option<Record>) -> Result<(), String> {
        self.edit(object, |o| put_member(o, |o| &mut o.records, name, to, "a record"))
    }

    pub fn set_computed(&mut self, object: &str, name: &str, to: Option<Computed>) -> Result<(), String> {
        self.edit(object, |o| put_member(o, |o| &mut o.computed, name, to, "a computed value"))
    }

    pub fn set_function(&mut self, object: &str, name: &str, to: Option<Function>) -> Result<(), String> {
        self.edit(object, |o| put_member(o, |o| &mut o.functions, name, to, "a function"))
    }

    /// Adds, changes or with None removes a rule of an object's logic, and saves. A new one,
    /// with no id, is given one. Gives back its id.
    pub fn set_rule(&mut self, object: &str, id: &str, to: Option<Rule>) -> Result<String, String> {
        let id = match id.is_empty() {
            true => {
                let highest = self.flat.rules.iter().filter_map(|(_, r)| r.id.strip_prefix('h')?.parse::<u32>().ok()).max().unwrap_or(0);
                format!("h{}", highest + 1)
            }
            false => id.to_owned(),
        };
        let to = to.map(|r| Rule { id: id.clone(), ..r });
        self.edit(object, |o| list::put(&mut o.logic, &id, to, || format!("{object} has no handler {id}")).map(|_| None))?;
        Ok(id)
    }

    /// Makes a member one only its object's own code reads, or one code outside reads too.
    pub fn set_local(&mut self, object: &str, name: &str, local: bool) -> Result<(), String> {
        self.edit(object, |o| {
            if !o.has(name) {
                return Err(format!("{name} is not a member of {}", o.name));
            }
            o.local.retain(|l| l != name);
            if local {
                o.local.push(name.to_owned());
            }
            Ok(None)
        })
    }

    /// Changes the object called `object` by `change`, then checks and saves it. A member
    /// `change` renamed, from and to, is followed in every object's code.
    fn edit(&mut self, object: &str, change: impl FnOnce(&mut Object) -> Result<Option<(String, String)>, String>) -> Result<(), String> {
        let mut next = self.objects.clone();
        let o = next.iter_mut().find(|o| o.name == object).ok_or_else(|| format!("there is no object {object}"))?;
        if let Some((from, to)) = change(o)? {
            follow(&mut next, object, Some(&from), &to);
        }
        self.commit(next)
    }

    /// Makes `next` the objects once each that changed and all together pass their checks,
    /// saving the files of those that changed and removing those of the ones gone.
    fn commit(&mut self, mut next: Vec<Object>) -> Result<(), String> {
        let changed: Vec<&Object> = next.iter().filter(|o| !self.objects.contains(o)).collect();
        for o in &changed {
            object::check(o)?;
        }
        // a new member's entity is named as the one already imported, not the other way round
        let flat = Flat::of(&next);
        for i in flat.imports.iter().filter(|i| !self.flat.imports.contains(i)) {
            if let Some(other) = flat.imports.iter().find(|o| o.entity == i.entity && o.alias != i.alias) {
                return Err(format!("{} is already imported as {}", i.entity, other.alias));
            }
        }
        check_all(&next)?;
        let dir = self.root.join("objects");
        for o in changed {
            files::write(&dir.join(file_of(&o.name)), &object::write(o))?;
        }
        for gone in self.objects.iter().map(|o| dir.join(file_of(&o.name))).filter(|f| !next.iter().any(|o| dir.join(file_of(&o.name)) == *f)) {
            if gone.exists() {
                fs::remove_file(&gone).map_err(|e| format!("could not remove {}: {e}", gone.display()))?;
            }
        }
        sort(&mut next);
        self.flat = Flat::of(&next);
        self.objects = next;
        Ok(())
    }
}

/// Writes every use of what was renamed `to` in the objects' code: the object called `object`,
/// or with `member` that member of it, which its own code reads bare.
fn follow(objects: &mut [Object], object: &str, member: Option<&str>, to: &str) {
    let (from_key, to_key) = match member {
        None => (object.to_owned(), to.to_owned()),
        Some(m) => (object::key(object, m), object::key(object, to)),
    };
    // a setter's target or a name logic waits on, written as a key or by an own member's name
    let named = |name: &mut String, own: bool| {
        if member.is_none() && let Some(rest) = name.strip_prefix(&format!("{object}.")) {
            *name = format!("{to}.{rest}");
        } else if *name == from_key || (own && member == Some(name.as_str())) {
            *name = if own && !name.contains('.') { to.to_owned() } else { to_key.clone() };
        }
    };
    for o in objects {
        let own = member.is_some() && o.name == object;
        let code = |code: &mut String, takes: &[String]| {
            *code = js::rename(code, &from_key, &to_key);
            if let Some(m) = member.filter(|m| own && !takes.iter().any(|t| t == m)) {
                *code = js::rename(code, m, to);
            }
        };
        for c in &mut o.computed {
            code(&mut c.get, &[]);
            if let Some(s) = &mut c.set {
                code(&mut s.value, &[]);
                named(&mut s.target, own);
            }
        }
        for r in &mut o.records {
            code(&mut r.source, &[]);
        }
        for f in &mut o.functions {
            code(&mut f.code, &f.takes);
        }
        for r in &mut o.logic {
            code(&mut r.code, &[]);
            match &mut r.when {
                When::Turns { condition, .. } => code(condition, &[]),
                When::Changes { name } => named(name, own),
                _ => {}
            }
        }
    }
}

/// Puts `to` in place of the member `name` in one of an object's lists, `what` saying which,
/// as `put` does a list's. Whether only its own code reads it goes with it through a rename.
fn put_member<T: Keyed>(o: &mut Object, list: fn(&mut Object) -> &mut Vec<T>, name: &str, to: Option<T>, what: &str) -> Result<Option<(String, String)>, String> {
    if let Some(t) = &to {
        o.free(t.key(), what, name)?;
    }
    let new = to.as_ref().map(|t| t.key().to_owned());
    let missing = format!("{name} is not {what} of {}", o.name);
    let added = list::put(list(o), name, to, || missing)?.is_none();
    if let Some(at) = o.local.iter().position(|l| l == name).filter(|_| new.as_deref() != Some(name)) {
        match &new {
            Some(new) => o.local[at] = new.clone(),
            None => drop(o.local.remove(at)),
        }
    }
    Ok(new.filter(|n| !added && n != name).map(|n| (name.to_owned(), n)))
}

/// The file an object is kept in, under `objects/`. Two names one letter's case apart would
/// share it, so no two objects may be.
fn file_of(name: &str) -> String {
    format!("{}.html", name.to_ascii_lowercase())
}

/// Hmi first, then the rest by name.
fn sort(objects: &mut [Object]) {
    objects.sort_by(|a, b| (a.name != HMI, &a.name).cmp(&(b.name != HMI, &b.name)));
}

/// Why the objects cannot be together as they are: each named once, each entity imported once,
/// each rule's id its own, and each setter writing what takes writes, with no computed value
/// reading itself.
fn check_all(objects: &[Object]) -> Result<(), String> {
    for (n, o) in objects.iter().enumerate() {
        if objects[..n].iter().any(|p| p.name.eq_ignore_ascii_case(&o.name)) {
            return Err(format!("{} is already an object", o.name));
        }
    }
    let flat = Flat::of(objects);
    for (n, i) in flat.imports.iter().enumerate() {
        // the mesh gives a node one handle per entity, so one member each
        if let Some(other) = flat.imports[..n].iter().find(|o| o.entity == i.entity) {
            return Err(format!("{} is already imported as {}", i.entity, other.alias));
        }
    }
    for (n, (_, r)) in flat.rules.iter().enumerate() {
        if flat.rules[..n].iter().any(|(_, x)| x.id == r.id) {
            return Err(format!("two handlers have the id {}", r.id));
        }
    }
    for c in &flat.computed {
        if let Some(s) = &c.set {
            takes_writes(objects, &s.target, &c.name)?;
        }
    }
    if let Some(cycle) = cycle(objects) {
        return Err(format!("{} reads itself through {}", cycle[0], cycle.join(", ")));
    }
    Ok(())
}

/// Whether `target` takes a computed value's writes: a variable imported to write, a variable,
/// or another computed value with a setter.
fn takes_writes(objects: &[Object], target: &str, from: &str) -> Result<(), String> {
    let ok = match look_up(objects, target) {
        Found::Import(i) => i.kind == Kind::Variable && i.intent == Intent::Write,
        Found::Variable(_) => true,
        Found::Computed(c) => target != from && c.set.is_some(),
        _ => false,
    };
    match ok {
        true => Ok(()),
        false => Err(format!("{target} takes no writes: a setter writes a variable imported to write, a variable, or a computed value with a setter")),
    }
}

/// The theme, empty while there is none.
fn load_theme(root: &Path) -> Result<Vec<Token>> {
    let file = theme_file(root);
    match file.exists() {
        true => Ok(toml::from_str::<ThemeFile>(&read(&file)?).with_context(|| format!("reading {}", files::shown(root, &file)))?.tokens),
        false => Ok(Vec::new()),
    }
}

/// A function or a task is only called, so its import is always one to write.
pub(crate) fn callable(kind: Kind) -> Option<Intent> {
    matches!(kind, Kind::Function | Kind::Task).then_some(Intent::Write)
}

/// Only a topic imported to read takes a rate, as a write starts from the latest value. The
/// error is for the user.
fn check_options(i: &Import) -> Result<(), String> {
    match i.rate {
        Some(_) if i.kind != Kind::Topic || i.intent != Intent::Read => Err(format!("{} takes no rate, as only a topic imported to read does", i.alias)),
        Some(0) => Err(format!("{} needs a rate of 1 a second or more", i.alias)),
        _ => Ok(()),
    }
}

/// A chain of computed values that reads or writes back into its first, their keys in order,
/// else None. A getter reads the computed values it names, a setter writes its target.
fn cycle(objects: &[Object]) -> Option<Vec<String>> {
    let mut next: HashMap<String, Vec<String>> = HashMap::new();
    for o in objects {
        for c in &o.computed {
            let mut out = o.reads(&c.get);
            out.extend(c.set.iter().map(|s| o.key_of(&s.target)));
            next.insert(o.key(&c.name), out);
        }
    }
    fn walk(at: &str, next: &HashMap<String, Vec<String>>, path: &mut Vec<String>) -> bool {
        if path.iter().any(|p| p == at) {
            path.push(at.to_owned());
            return true;
        }
        path.push(at.to_owned());
        let found = next.get(at).is_some_and(|reads| reads.iter().any(|n| walk(n, next, path)));
        if !found {
            path.pop();
        }
        found
    }
    let mut keys: Vec<&String> = next.keys().collect();
    keys.sort();
    keys.into_iter().find_map(|key| {
        let mut path = Vec::new();
        walk(key, &next, &mut path).then(|| {
            let start = path.iter().position(|p| p == path.last().unwrap()).unwrap();
            path[start..].to_vec()
        })
    })
}

/// What a key names among the objects' members, as the HMI and its engine each look it up.
pub enum Found<'a> {
    Computed(&'a Computed),
    Variable(&'a Variable),
    Import(&'a Import),
    Record,
    Function,
    Nothing,
}

pub fn look_up<'a>(objects: &'a [Object], key: &str) -> Found<'a> {
    let Some((object, name)) = key.split_once('.') else { return Found::Nothing };
    let Some(o) = objects.iter().find(|o| o.name == object) else { return Found::Nothing };
    if let Some(c) = o.computed.iter().find(|c| c.name == name) {
        return Found::Computed(c);
    }
    if let Some(v) = o.variables.iter().find(|v| v.name == name) {
        return Found::Variable(v);
    }
    if let Some(i) = o.imports.iter().find(|i| i.alias == name) {
        return Found::Import(i);
    }
    match (o.records.iter().any(|r| r.name == name), o.functions.iter().any(|f| f.name == name)) {
        (true, _) => Found::Record,
        (_, true) => Found::Function,
        _ => Found::Nothing,
    }
}

/// What code writing a member writes: a computed value through its setter, a variable, shared
/// or each screen's, or a mesh import.
pub enum Target {
    Computed,
    Variable(Per),
    Import,
}

/// Why code cannot write a name, for the user. `unknown` when the name names nothing.
pub struct Unwritable {
    pub text: String,
    pub unknown: bool,
}

impl Found<'_> {
    /// What code writing `name` writes, or why it cannot: the one rule the HMI and its engine
    /// share. `path` is the field written, empty for all of it, and `screen` says whether the
    /// write is a screen's.
    pub fn target(&self, name: &str, path: &str, screen: bool) -> Result<Target, Unwritable> {
        let no = |why: &str| Err(Unwritable { text: rules::say(why, name), unknown: false });
        match self {
            Found::Computed(c) if c.set.is_none() => no(rules::NO_SETTER),
            Found::Computed(_) if !path.is_empty() => no(rules::WHOLE),
            Found::Computed(_) => Ok(Target::Computed),
            Found::Variable(v) if v.per == Per::Screen && !screen => no(rules::NO_SCREEN),
            Found::Variable(v) => Ok(Target::Variable(v.per)),
            Found::Import(i) if i.kind != Kind::Variable => no(rules::NOT_VARIABLE),
            Found::Import(i) if i.intent != Intent::Write => no(rules::READ_ONLY),
            Found::Import(_) => Ok(Target::Import),
            Found::Record => no(rules::RECORD),
            Found::Function => no(rules::NOT_VARIABLE),
            Found::Nothing => Err(Unwritable { text: rules::say(rules::MISSING, name), unknown: true }),
        }
    }
}

fn theme_file(root: &Path) -> PathBuf {
    root.join("data").join("theme.toml")
}

/// A variable, a computed value, a record or a function, `what` says which. Its name hides
/// nothing code has.
pub(crate) fn check_local(name: &str, what: &str) -> Result<(), String> {
    rules::LOCAL.check(name, what)?;
    unreserved(name)
}

pub(crate) fn unreserved(name: &str) -> Result<(), String> {
    match crate::script::reserved(name) {
        true => Err(format!("{name} is a name code already uses, so pick another")),
        false => Ok(()),
    }
}

fn read(path: &Path) -> Result<String> {
    fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
}

/// A mesh member: PascalCase, hiding nothing code has, with only the options its kind takes.
pub(crate) fn check_import(i: &Import) -> Result<(), String> {
    rules::ALIAS.check(&i.alias, "an import")?;
    unreserved(&i.alias)?;
    check_options(i)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::value;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rant-hmi-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn speed() -> Import {
        Import { alias: "Speed".into(), entity: "Speed".into(), kind: Kind::Variable, intent: Intent::Write, rate: None }
    }

    /// A project with an object Line on the mesh's Line1.
    fn with_line(name: &str) -> (PathBuf, Project) {
        let dir = scratch(name);
        let mut p = Project::open(&dir).unwrap();
        p.set_object("", Some(ObjectInfo { name: "Line".into(), mesh: "Line1".into(), note: None })).unwrap();
        (dir, p)
    }

    #[test]
    fn a_new_folder_becomes_a_project_and_objects_survive_a_reopen() {
        let (dir, mut p) = with_line("reopen");
        assert_eq!(p.objects().iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Hmi", "Line"]);
        p.import("Line", speed()).unwrap();
        let again = Project::open(&dir).unwrap();
        assert_eq!(again.object("Line").unwrap().imports, vec![speed()]);
        assert_eq!(again.find("Line.Speed").unwrap().entity, "Line1/Speed");
        assert!(fs::read_to_string(dir.join("objects/line.html")).unwrap().contains("<variable name=\"Speed\" entity=\"Speed\" intent=\"write\"/>"));
        // a rename moves its file, and Hmi stays
        p.set_object("Line", Some(ObjectInfo { name: "Packing".into(), mesh: "Line1".into(), note: None })).unwrap();
        assert!(dir.join("objects/packing.html").exists() && !dir.join("objects/line.html").exists());
        assert_eq!(p.set_object("Hmi", None).unwrap_err(), "Hmi is the HMI's own object, so it stays and keeps its name");
        assert_eq!(p.set_object("", Some(ObjectInfo { name: "PACKING".into(), mesh: String::new(), note: None })).unwrap_err(), "PACKING is already an object");
        p.set_object("Packing", None).unwrap();
        assert!(!dir.join("objects/packing.html").exists());
        // a file named for another object is a mistake
        fs::write(dir.join("objects/robot.html"), "<object name=\"Arm\">\n</object>\n").unwrap();
        assert!(format!("{:#}", Project::open(&dir).err().unwrap()).contains("objects/robot.html holds Arm, so it is named arm.html"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_packing_line_example_opens() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/packing-line");
        let p = Project::open(&dir).unwrap();
        assert_eq!(p.objects().iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Hmi", "Line", "Robot"]);
        assert_eq!(p.find("Line.Labels").unwrap().entity, "Line1/LabelCam/Detections");
        assert_eq!(p.flat().rules.len(), 5);
        crate::pages::Pages::open(&dir).unwrap();
    }

    #[test]
    fn a_new_project_starts_with_the_standard_components_once() {
        let dir = scratch("library");
        Project::open(&dir).unwrap();
        let pages = crate::pages::Pages::open(&dir).unwrap();
        let mut names: Vec<&str> = pages.list.iter().filter(|p| p.interface.is_some()).map(|p| p.name.as_str()).collect();
        names.sort();
        assert_eq!(
            names,
            ["Bar", "Bars", "Button", "Dropdown", "Gauge", "Joints", "Joystick", "Joystick1D", "Knob", "Lamp", "ModeSwitch", "Plot", "Pose", "Position", "Readout", "Slider", "Swatch", "Table", "Toggle"]
        );
        // and Rant's palette, worked out as tokens
        let theme = Project::open(&dir).unwrap().tokens;
        assert!(theme.iter().any(|t| t.name == "accentBg" && t.dark == "$accent.alpha(0.15)"));
        assert!(theme.iter().any(|t| t.name == "radius" && t.light.is_empty()));
        // a project that has its own leaves them be
        fs::remove_file(dir.join("components/button.html")).unwrap();
        Project::open(&dir).unwrap();
        assert!(!dir.join("components/button.html").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn computed_values_refuse_a_taken_name_a_target_without_writes_and_a_cycle() {
        let (dir, mut p) = with_line("computed");
        p.import("Line", speed()).unwrap();
        let c = |name: &str, get: &str, set: Option<(&str, &str)>| Computed {
            name: name.into(),
            get: get.into(),
            set: set.map(|(target, value)| Setter { target: target.into(), value: value.into() }),
            unit: None,
            note: None,
        };
        p.set_computed("Line", "percent", Some(c("percent", "Speed * 100", Some(("Speed", "v / 100"))))).unwrap();
        p.set_variable("Line", "mode", Some(Variable { name: "mode".into(), start: value!("Auto"), per: Per::Hmi })).unwrap();
        assert_eq!(p.set_computed("Line", "mode", Some(c("mode", "1", None))).unwrap_err(), "mode is already a variable of Line");
        assert!(p.set_variable("Line", "percent", Some(Variable { name: "percent".into(), start: value!(1), per: Per::Hmi })).unwrap_err().contains("already a computed value"));
        assert!(p.set_computed("Line", "bad", Some(c("bad", "1", Some(("Nothing", "v"))))).unwrap_err().contains("Line.Nothing takes no writes"));
        p.set_computed("Line", "half", Some(c("half", "percent / 2", None))).unwrap();
        assert!(p.set_computed("Line", "percent", Some(c("percent", "half * 2", None))).unwrap_err().contains("reads itself"));
        // another object's, by its key, and a name in quotes is text, not a read
        p.set_computed("Hmi", "label", Some(c("label", "\"half: \" + Line.half", Some(("Line.percent", "v"))))).unwrap();
        assert!(p.set_computed("Line", "half", Some(c("half", "Hmi.label", None))).unwrap_err().contains("reads itself"));
        let again = Project::open(&dir).unwrap();
        assert_eq!(again.object("Line").unwrap().computed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["percent", "half"]);
        assert_eq!(again.computed("Hmi.label").unwrap().set.as_ref().unwrap().target, "Line.percent");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn variables_survive_a_reopen_and_keep_to_their_names() {
        let (dir, mut p) = with_line("variables");
        let mode = Variable { name: "jogMode".into(), start: value!("Joint"), per: Per::Screen };
        p.set_variable("Line", "jogMode", Some(mode.clone())).unwrap();
        let limits = Variable { name: "limits".into(), start: value!({ "low": 0.5, "high": [1, 2] }), per: Per::Hmi };
        p.set_variable("Line", "limits", Some(limits.clone())).unwrap();
        assert_eq!(Project::open(&dir).unwrap().object("Line").unwrap().variables, [mode.clone(), limits]);
        assert!(p.set_variable("Line", "Speed", Some(Variable { name: "Speed".into(), ..mode.clone() })).unwrap_err().contains("small letter"));
        assert!(p.set_variable("Line", "open", Some(Variable { name: "open".into(), ..mode.clone() })).unwrap_err().contains("already uses"));
        assert!(p.set_variable("Line", "sqrt", Some(Variable { name: "sqrt".into(), ..mode.clone() })).unwrap_err().contains("already uses"));
        assert!(p.set_variable("Line", "x", Some(Variable { name: "x".into(), start: Value::Null, per: Per::Hmi })).unwrap_err().contains("start value"));
        // a rename keeps it local
        p.set_local("Line", "jogMode", true).unwrap();
        p.set_variable("Line", "jogMode", Some(Variable { name: "mode".into(), ..mode })).unwrap();
        p.set_variable("Line", "limits", None).unwrap();
        let again = Project::open(&dir).unwrap();
        assert_eq!(again.object("Line").unwrap().variables.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["mode"]);
        assert_eq!(again.object("Line").unwrap().local, ["mode"]);
        assert_eq!(again.variable("Line.mode").unwrap().per, Per::Screen);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn records_survive_a_reopen_and_share_names_with_variables() {
        let (dir, mut p) = with_line("records");
        let record = |name: &str, every_ms: u32| Record { name: name.into(), source: "Speed".into(), every_ms, keep_s: 60 };
        p.set_record("Line", "speedHistory", Some(record("speedHistory", 100))).unwrap();
        assert_eq!(Project::open(&dir).unwrap().object("Line").unwrap().records, [record("speedHistory", 100)]);
        assert!(p.set_record("Line", "fast", Some(record("fast", 10))).unwrap_err().contains("50 ms or more"));
        p.set_variable("Line", "mode", Some(Variable { name: "mode".into(), start: value!("Auto"), per: Per::Hmi })).unwrap();
        assert!(p.set_record("Line", "mode", Some(record("mode", 100))).unwrap_err().contains("already a variable"));
        assert!(p.set_variable("Line", "speedHistory", Some(Variable { name: "speedHistory".into(), start: value!(0), per: Per::Hmi })).unwrap_err().contains("already a record"));
        // another object may have a member of the same name
        p.set_record("Hmi", "mode", Some(record("mode", 100))).unwrap();
        p.set_record("Line", "speedHistory", None).unwrap();
        assert!(Project::open(&dir).unwrap().object("Line").unwrap().records.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn functions_and_logic_survive_a_reopen_and_rules_get_ids_of_their_own() {
        let (dir, mut p) = with_line("logic");
        let f = Function { name: "restart".into(), takes: vec!["job".into()], code: "return job;".into() };
        p.set_function("Line", "restart", Some(f.clone())).unwrap();
        let rule = |name: &str, when: When| Rule { id: String::new(), name: name.into(), when, code: "x = 1;".into() };
        assert_eq!(p.set_rule("Line", "", Some(rule("Blink", When::Every { ms: 500 }))).unwrap(), "h1");
        assert_eq!(p.set_rule("Hmi", "", Some(rule("Came", When::Connects))).unwrap(), "h2");
        assert!(p.set_rule("Line", "", Some(rule("Went", When::Leaves))).unwrap_err().contains("Hmi's logic"));
        assert!(p.set_rule("Line", "", Some(rule("Fast", When::Every { ms: 5 }))).unwrap_err().contains("50 ms"));
        let again = Project::open(&dir).unwrap();
        assert_eq!(again.object("Line").unwrap().functions, [f]);
        assert_eq!(again.flat().rules.iter().map(|(o, r)| (o.as_str(), r.id.as_str())).collect::<Vec<_>>(), [("Hmi", "h2"), ("Line", "h1")]);
        p.set_rule("Line", "h1", None).unwrap();
        assert!(Project::open(&dir).unwrap().object("Line").unwrap().logic.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tokens_survive_a_reopen() {
        let dir = scratch("tokens");
        let mut p = Project::open(&dir).unwrap();
        // apart from the default theme a new project starts with
        let signal = Token { name: "signal".into(), dark: "#e04a3f".into(), light: "#c0392b".into() };
        p.set_token("signal", Some(signal.clone())).unwrap();
        let read = |dir: &Path| Project::open(dir).unwrap().tokens.into_iter().find(|t| t.name == "signal");
        assert_eq!(read(&dir), Some(signal.clone()));
        assert!(p.set_token("Signal", Some(Token { name: "Signal".into(), ..signal })).unwrap_err().contains("small letter"));
        p.set_token("signal", None).unwrap();
        assert_eq!(read(&dir), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_start_page_survives_a_reopen() {
        let dir = scratch("start");
        let mut p = Project::open(&dir).unwrap();
        assert_eq!(p.info.start, None);
        p.set_start("robot-cell".into()).unwrap();
        assert_eq!(Project::open(&dir).unwrap().info.start.as_deref(), Some("robot-cell"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_project_finds_its_way_through_the_bridge_s_stun_servers() {
        let dir = scratch("ice");
        let p = Project::open(&dir).unwrap();
        assert_eq!(p.info.ice, ice());
        assert!(read(&dir.join("hmi.toml")).unwrap().contains("urls = \"stun:stun.cloudflare.com:3478\""));
        fs::write(dir.join("hmi.toml"), "name = \"Line\"\nice = []\n").unwrap();
        assert!(Project::open(&dir).unwrap().info.ice.is_empty());
        fs::write(dir.join("hmi.toml"), "name = \"Line\"\n").unwrap();
        assert_eq!(Project::open(&dir).unwrap().info.ice, ice());
        fs::write(dir.join("hmi.toml"), "name = \"Line\"\n[[ice]]\nurls = \"turn:t.example.com:3478\"\n").unwrap();
        assert!(format!("{:#}", Project::open(&dir).err().unwrap()).contains("needs a username and credential"));
        fs::write(dir.join("hmi.toml"), "name = \"Line\"\n[[ice]]\nurls = \"t.example.com\"\n").unwrap();
        assert!(format!("{:#}", Project::open(&dir).err().unwrap()).contains("starting stun:"));
        fs::write(dir.join("hmi.toml"), "name = \"Line\"\n[[ice]]\nurls = \"turn:t.example.com\"\nusername = \"u\"\ncredential = \"s\"\n").unwrap();
        assert_eq!(Project::open(&dir).unwrap().info.ice[0].username.as_deref(), Some("u"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mesh_members_are_pascal_case_and_each_entity_imported_once() {
        let (dir, mut p) = with_line("alias");
        assert!(p.import("Line", Import { alias: "speed".into(), ..speed() }).is_err());
        assert!(p.import("Line", Import { alias: "Line-1".into(), ..speed() }).is_err());
        p.import("Line", speed()).unwrap();
        assert_eq!(p.import("Line", speed()).unwrap_err(), "Speed is already an import of Line");
        assert_eq!(p.import("Line", Import { alias: "Pace".into(), ..speed() }).unwrap_err(), "Line1/Speed is already imported as Line.Speed");
        // the same entity through another object's root, or the mesh's own
        assert_eq!(p.import("Hmi", Import { entity: "/Line1/Speed".into(), ..speed() }).unwrap_err(), "Line1/Speed is already imported as Line.Speed");
        p.unimport("Line", "Speed").unwrap();
        assert!(p.flat().imports.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_a_topic_imported_to_read_takes_a_rate() {
        let (dir, mut p) = with_line("options");
        assert_eq!(p.import("Line", Import { intent: Intent::Read, rate: Some(5), ..speed() }).unwrap_err(), "Speed takes no rate, as only a topic imported to read does");
        let cloud = Import { alias: "Lidar".into(), entity: "Lidar".into(), kind: Kind::Topic, intent: Intent::Read, rate: Some(5) };
        p.import("Line", cloud.clone()).unwrap();
        assert_eq!(p.change("Line", "Lidar", Import { rate: Some(0), ..cloud.clone() }).unwrap_err(), "Lidar needs a rate of 1 a second or more");
        assert_eq!(p.change("Line", "Lidar", Import { intent: Intent::Write, ..cloud.clone() }).unwrap_err(), "Lidar takes no rate, as only a topic imported to read does");
        let file = fs::read_to_string(dir.join("objects/line.html")).unwrap();
        assert!(file.contains("rate=\"5\""), "{file}");
        assert_eq!(Project::open(&dir).unwrap().object("Line").unwrap().imports, vec![cloud]);
        // a hand edit the editor would refuse keeps the project from opening, saying why
        fs::write(dir.join("objects/line.html"), file.replace("rate=", "intent=\"write\" rate=")).unwrap();
        assert!(format!("{:#}", Project::open(&dir).err().unwrap()).contains("objects/line.html: Lidar takes no rate"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn code_writes_what_it_may_and_hears_why_not() {
        let why = |found: Found, path: &str, screen: bool| found.target("X", path, screen).err().map(|u| (u.text, u.unknown));
        let read = Import { intent: Intent::Read, ..speed() };
        let call = Import { kind: Kind::Function, ..speed() };
        let own = Variable { name: "x".into(), start: value!(0), per: Per::Screen };
        let worked = Computed { name: "x".into(), get: "1".into(), set: None, unit: None, note: None };
        assert_eq!(why(Found::Import(&speed()), "a", false), None);
        assert_eq!(why(Found::Import(&read), "", true).unwrap().0, "X is imported to read. Import it to write to change it.");
        assert_eq!(why(Found::Import(&call), "", true).unwrap().0, "X is not a variable, so it cannot be set");
        assert_eq!(why(Found::Function, "", true).unwrap().0, "X is not a variable, so it cannot be set");
        assert_eq!(why(Found::Variable(&own), "", true), None);
        assert_eq!(why(Found::Variable(&own), "", false).unwrap().0, "X is each screen's own, and this handler runs for no screen");
        assert_eq!(why(Found::Computed(&worked), "", true).unwrap().0, "X is worked out from other values, and has no setter to write it");
        assert_eq!(why(Found::Record, "", true).unwrap().0, "X is a record, which only its source fills");
        assert_eq!(why(Found::Nothing, "", true), Some(("X names no object, member or state".into(), true)));
    }
}

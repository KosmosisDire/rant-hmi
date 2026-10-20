//! The project's pages and components, one HTML like file each in `pages/` and `components/`,
//! its own handlers in `logic/handlers.html`, and the edits that change them. A component is kept as a page with an interface, so every
//! edit works on both. Every edit goes through the backend, which saves the file and sends the
//! page to every screen, so all of them show the same page.

pub mod format;
pub mod js;
pub mod logic;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::files;
use logic::Rule;

/// A page: an artboard of `width` by `height` pixels holding elements. With an interface it
/// is a component, placed on pages as instances.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Page {
    /// The file's name without `.html`, stable while the page lives.
    pub id: String,
    /// A component's is PascalCase, as instances name it.
    pub name: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub shows: Shows,
    #[serde(default)]
    pub interface: Option<Interface>,
    pub children: Vec<Element>,
}

/// What an instance of a component fills in.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq, Default)]
#[ts(export)]
pub struct Interface {
    pub inputs: Vec<Input>,
    /// What the component sends out with `emit`, which an instance's handlers take.
    #[serde(default)]
    pub events: Vec<String>,
}

/// A value a component reads and each instance gives, camelCase like any local name.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Input {
    pub name: String,
    /// The expression it reads while an instance gives none.
    pub default: String,
    /// The component may write it back through the instance's binding.
    #[serde(default)]
    pub bindable: bool,
}

/// How an open page shows: covering what is beneath, or floating over it while the page
/// beneath stays in sight and keeps running, as a dialog does.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Shows {
    #[default]
    Full,
    Over,
}

/// One element. `props` holds its name, its placement (`x`, `y`, `w`, `h`), a span's `text`
/// and any CSS property. Every one but the name is an expression.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Element {
    pub id: String,
    pub tag: Tag,
    /// The component an instance shows, by name. Set exactly on a `use` element.
    #[serde(default)]
    pub component: Option<String>,
    /// An instance's are its placement and the inputs it fills in.
    pub props: BTreeMap<String, String>,
    /// At most one per event, in the order events are listed.
    pub handlers: Vec<Handler>,
    pub children: Vec<Element>,
}

/// Code that runs when its event happens on the element: a pointer's, or one an instance's
/// component sends. On a page it runs on the backend, in a component on the screen.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Handler {
    pub event: String,
    pub code: String,
}

/// What a pointer does to any element: goes down on it and comes up without straying, goes
/// down, comes up, or moves while down, from the press on.
pub const POINTER: [&str; 4] = ["tap", "press", "release", "drag"];

/// Where a handler goes in an element's list: the pointer's events first, then by name.
fn rank(event: &str) -> (usize, &str) {
    (POINTER.iter().position(|e| *e == event).unwrap_or(POINTER.len()), event)
}

/// An event is named in camelCase.
fn check_event(event: &str) -> Result<(), String> {
    let mut chars = event.chars();
    if chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_alphanumeric()) {
        return Ok(());
    }
    Err(format!("\"{event}\" cannot name an event: start with a small letter, then use letters and digits"))
}

/// What an element renders as. A frame is a div, a text a span, and an instance of a
/// component is written with the component's name.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Tag {
    Div,
    Span,
    Use,
}

impl Tag {
    pub fn from_word(word: &str) -> Option<Tag> {
        match word {
            "div" => Some(Tag::Div),
            "span" => Some(Tag::Span),
            _ => None,
        }
    }
}

impl Element {
    /// The tag the file writes: an instance takes its component's name.
    pub fn word(&self) -> &str {
        match self.tag {
            Tag::Div => "div",
            Tag::Span => "span",
            Tag::Use => self.component.as_deref().unwrap_or("Missing"),
        }
    }
}

/// A change to the pages, sent by a screen. Each one applied gives back the edit that undoes
/// it.
#[derive(Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum Edit {
    AddPage { name: String },
    AddComponent { name: String },
    RenamePage { page: String, name: String },
    ResizePage { page: String, width: u32, height: u32 },
    SetShows { page: String, shows: Shows },
    RemovePage { page: String },
    /// Puts a whole page back, ids and all, as undoing its removal does.
    PutPage { page: Page },
    /// Adds an element and all it holds at `index` of `parent` (the front when none), a frame
    /// or the page. Every id in it is made new, whatever it held.
    AddElement { page: String, parent: Option<String>, index: Option<usize>, element: Element },
    RemoveElement { page: String, id: String },
    /// Puts an element and all it holds at `index` of `parent`, ids and all.
    PutElement { page: String, parent: Option<String>, index: usize, element: Element },
    /// Moves an element to `index` of `parent`, counted once the element is taken out.
    MoveElement { page: String, id: String, parent: Option<String>, index: usize },
    /// Sets each property to its value, or removes it where the value is null.
    SetProps { page: String, id: String, props: BTreeMap<String, Option<String>> },
    /// Sets the code the element runs on `event`, or removes its handler where it is null.
    SetHandler { page: String, id: String, event: String, code: Option<String> },
    /// Adds, changes or with null removes a component's input called `name`. A rename is
    /// followed in the component and by its instances, a removal takes it off them.
    SetInput { page: String, name: String, input: Option<Input> },
    /// Adds the event `to` to a component when `name` is not one yet, renames `name` to it, or
    /// with null removes it. Instances' handlers follow a rename.
    SetEvent { page: String, name: String, to: Option<String> },
    /// Sets the rule `id`, puts it back under that id when it is gone, gives it a new id when
    /// `id` is empty, or with null removes it.
    SetRule { id: String, rule: Option<Rule> },
    /// Several edits as one: all apply or none do, and one undo takes them all back.
    Batch { edits: Vec<Edit> },
}

/// What an edit changed: the pages to send out, what it made, if anything, as a page and an
/// id (a page's own for a page), and the edit that undoes it.
#[derive(Debug)]
pub struct Applied {
    pub pages: Vec<String>,
    /// The rules changed.
    pub rules: bool,
    pub made: Option<(String, String)>,
    pub undo: Edit,
}

pub struct Pages {
    root: PathBuf,
    /// Pages and components in id order, as the files list.
    pub list: Vec<Page>,
    /// The HMI's own handlers, in the order they were made.
    pub rules: Vec<Rule>,
    /// Set by an edit that changed the rules, until it is saved.
    rules_changed: bool,
}

const WIDTH: u32 = 1408;
const HEIGHT: u32 = 792;
const COMPONENT_WIDTH: u32 = 264;
const COMPONENT_HEIGHT: u32 = 176;
/// The largest side a page may have, in pixels.
const LARGEST: u32 = 16384;

impl Pages {
    /// Reads every page in `pages/` and component in `components/`, starting a page called
    /// Overview when there is none.
    pub fn open(root: &Path) -> Result<Pages> {
        let mut list = Vec::new();
        for folder in ["pages", "components"] {
            let files: Vec<PathBuf> = match fs::read_dir(root.join(folder)) {
                Ok(entries) => entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "html")).collect(),
                Err(_) => Vec::new(),
            };
            for file in files {
                let id = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let text = fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?;
                let page = format::parse(&text, &id).map_err(|e| anyhow::anyhow!("{}, {e}", file.display()))?;
                if (folder == "components") != page.interface.is_some() {
                    anyhow::bail!("{} belongs in {}", file.display(), if folder == "pages" { "components" } else { "pages" });
                }
                list.push(page);
            }
        }
        list.sort_by(|a, b| a.id.cmp(&b.id));
        if let Some(twice) = list.windows(2).find(|w| w[0].id == w[1].id) {
            anyhow::bail!("pages/{0}.html and components/{0}.html share a name, which must be one of a kind", twice[0].id);
        }
        let file = root.join("logic").join("handlers.html");
        let rules = match file.exists() {
            true => logic::parse(&fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?).map_err(|e| anyhow::anyhow!("{}, {e}", file.display()))?,
            false => Vec::new(),
        };
        let mut pages = Pages { root: root.to_path_buf(), list, rules, rules_changed: false };
        if !pages.list.iter().any(|p| p.interface.is_none()) {
            pages.apply(Edit::AddPage { name: "Overview".into() }).map_err(anyhow::Error::msg)?;
        }
        Ok(pages)
    }

    pub fn component(&self, name: &str) -> Option<&Page> {
        self.list.iter().find(|p| p.interface.is_some() && p.name == name)
    }

    /// True when `component`, or a component it holds at any depth, has an instance of the
    /// component called `name`.
    fn holds(&self, component: &str, name: &str) -> bool {
        fn uses(elements: &[Element], out: &mut Vec<String>) {
            for e in elements {
                out.extend(e.component.clone());
                uses(&e.children, out);
            }
        }
        let mut seen = HashSet::new();
        let mut todo = vec![component.to_owned()];
        while let Some(c) = todo.pop() {
            if c == name {
                return true;
            }
            if seen.insert(c.clone()) {
                let mut found = Vec::new();
                uses(self.component(&c).map_or(&[][..], |p| &p.children), &mut found);
                todo.extend(found);
            }
        }
        false
    }

    /// An element tree may go into `page` when each instance in it names a component that
    /// exists and does not hold `page`, which would make it hold itself.
    fn check_uses(&self, page: &str, e: &Element) -> Result<(), String> {
        if let Some(c) = &e.component {
            if self.component(c).is_none() {
                return Err(format!("there is no component {c}"));
            }
            let host = self.get(page).filter(|p| p.interface.is_some()).map(|p| p.name.clone());
            if let Some(host) = host.filter(|h| self.holds(c, h)) {
                return Err(format!("{host} cannot hold {c}, since {c} holds {host}"));
            }
        }
        e.children.iter().try_for_each(|c| self.check_uses(page, c))
    }

    pub fn get(&self, id: &str) -> Option<&Page> {
        self.list.iter().find(|p| p.id == id)
    }

    pub fn element(&self, page: &str, id: &str) -> Option<&Element> {
        self.get(page).and_then(|p| find(&p.children, id))
    }

    /// Writes every use of the name `from` in values and handlers as `to`, as a rename needs,
    /// and saves each page that changed. Returns those pages. Components read only theirs and
    /// the theme's, so they follow only where `components` says so.
    pub fn rename(&mut self, from: &str, to: &str, components: bool) -> Result<Vec<String>, String> {
        let mut touched = Vec::new();
        for p in self.list.iter_mut().filter(|p| components || p.interface.is_none()) {
            if p.children.iter_mut().fold(false, |c, e| rename_in(e, from, to) | c) {
                touched.push(p.id.clone());
            }
        }
        for id in &touched {
            self.save(id)?;
        }
        Ok(touched)
    }

    /// Each page's name as handler code spells it, `Pages.RobotCell` for "Robot cell", and
    /// its id. A name spelled like an earlier one gets a number.
    pub fn keys(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for p in self.list.iter().filter(|p| p.interface.is_none()) {
            let words: String = p.name.split(|c: char| !c.is_ascii_alphanumeric()).map(capital).collect();
            let base = if words.starts_with(|c: char| c.is_ascii_alphabetic()) { words } else { format!("Page{words}") };
            let mut key = base.clone();
            let mut n = 2;
            while out.iter().any(|(k, _)| *k == key) {
                key = format!("{base}{n}");
                n += 1;
            }
            out.push((key, p.id.clone()));
        }
        out
    }

    /// Applies an edit and saves what it touched. The error is for the user.
    pub fn apply(&mut self, edit: Edit) -> Result<Applied, String> {
        let mut pages = Vec::new();
        let mut made = None;
        let undo = self.change(edit, &mut pages, &mut made)?;
        pages.sort();
        pages.dedup();
        for page in &pages {
            self.save(page)?;
        }
        let rules = std::mem::take(&mut self.rules_changed);
        if rules {
            self.save_rules()?;
        }
        Ok(Applied { pages, rules, made, undo })
    }

    fn change(&mut self, edit: Edit, touched: &mut Vec<String>, made: &mut Option<(String, String)>) -> Result<Edit, String> {
        if let Edit::Batch { edits } = edit {
            let mut undos = Vec::new();
            for e in edits {
                match self.change(e, touched, made) {
                    Ok(undo) => undos.push(undo),
                    Err(text) => {
                        for undo in undos.into_iter().rev() {
                            let _ = self.change(undo, &mut Vec::new(), &mut None);
                        }
                        return Err(text);
                    }
                }
            }
            undos.reverse();
            return Ok(Edit::Batch { edits: undos });
        }
        let undo = match edit {
            Edit::AddPage { name } => {
                let name = named(&name)?;
                let id = self.free_id(&slug(&name));
                self.insert_page(Page { id: id.clone(), name, width: WIDTH, height: HEIGHT, shows: Shows::Full, interface: None, children: Vec::new() });
                *made = Some((id.clone(), id.clone()));
                touched.push(id.clone());
                return Ok(Edit::RemovePage { page: id });
            }
            Edit::AddComponent { name } => {
                let name = self.component_name(&name, None)?;
                let id = self.free_id(&slug(&name));
                let interface = Some(Interface::default());
                self.insert_page(Page { id: id.clone(), name, width: COMPONENT_WIDTH, height: COMPONENT_HEIGHT, shows: Shows::Full, interface, children: Vec::new() });
                *made = Some((id.clone(), id.clone()));
                touched.push(id.clone());
                return Ok(Edit::RemovePage { page: id });
            }
            Edit::RenamePage { page, name } => {
                let old = self.get(&page).ok_or_else(|| format!("there is no page {page}"))?.name.clone();
                let component = self.get(&page).is_some_and(|p| p.interface.is_some());
                let name = if component { self.component_name(&name, Some(&page))? } else { named(&name)? };
                self.page_mut(&page)?.name = name.clone();
                // every instance of a renamed component follows it
                if component {
                    for p in &mut self.list {
                        if rename_uses(&mut p.children, &old, &name) {
                            touched.push(p.id.clone());
                        }
                    }
                }
                Edit::RenamePage { page: page.clone(), name: old }
            }
            Edit::ResizePage { page, width, height } => {
                if !(1..=LARGEST).contains(&width) || !(1..=LARGEST).contains(&height) {
                    return Err(format!("a page is 1 to {LARGEST} pixels a side"));
                }
                let p = self.page_mut(&page)?;
                let old = (std::mem::replace(&mut p.width, width), std::mem::replace(&mut p.height, height));
                Edit::ResizePage { page: page.clone(), width: old.0, height: old.1 }
            }
            Edit::SetShows { page, shows } => {
                let old = std::mem::replace(&mut self.page_mut(&page)?.shows, shows);
                Edit::SetShows { page: page.clone(), shows: old }
            }
            Edit::RemovePage { page } => {
                let at = self.list.iter().position(|p| p.id == page).ok_or_else(|| format!("there is no page {page}"))?;
                let gone = &self.list[at];
                if gone.interface.is_none() && self.list.iter().filter(|p| p.interface.is_none()).count() == 1 {
                    return Err("a project keeps at least one page".into());
                }
                if gone.interface.is_some() {
                    let user = self.list.iter().find(|p| p.id != page && uses(&p.children, &gone.name));
                    if let Some(user) = user {
                        return Err(format!("{} is placed on {}, so it stays", gone.name, user.name));
                    }
                }
                touched.push(page);
                return Ok(Edit::PutPage { page: self.list.remove(at) });
            }
            Edit::PutPage { page } => {
                if self.get(&page.id).is_some() || page.id.is_empty() || slug(&page.id) != page.id {
                    return Err(format!("{} cannot be a new page's id", page.id));
                }
                let mut ids = HashSet::new();
                for e in &page.children {
                    check_tree(e, &mut ids)?;
                }
                if page.interface.is_some() {
                    self.component_name(&page.name, None)?;
                }
                let id = page.id.clone();
                self.insert_page(page);
                *made = Some((id.clone(), id.clone()));
                touched.push(id.clone());
                return Ok(Edit::RemovePage { page: id });
            }
            Edit::AddElement { page, parent, index, mut element } => {
                self.check_uses(&page, &element)?;
                let p = self.page_mut(&page)?;
                let mut next = highest(&p.children) + 1;
                renumber(&mut element, &mut next);
                check_tree(&element, &mut HashSet::new())?;
                let id = element.id.clone();
                let list = holder(p, &parent)?;
                list.insert(index.unwrap_or(list.len()).min(list.len()), element);
                *made = Some((page.clone(), id.clone()));
                Edit::RemoveElement { page: page.clone(), id }
            }
            Edit::RemoveElement { page, id } => {
                let p = self.page_mut(&page)?;
                let (parent, index) = locate(&p.children, &id, None).ok_or_else(|| format!("{id} is not on {page}"))?;
                let element = holder(p, &parent)?.remove(index);
                Edit::PutElement { page: page.clone(), parent, index, element }
            }
            Edit::PutElement { page, parent, index, element } => {
                self.check_uses(&page, &element)?;
                let p = self.page_mut(&page)?;
                let mut ids = HashSet::new();
                p.children.iter().for_each(|e| all_ids(e, &mut ids));
                check_tree(&element, &mut ids)?;
                let id = element.id.clone();
                let list = holder(p, &parent)?;
                list.insert(index.min(list.len()), element);
                *made = Some((page.clone(), id.clone()));
                Edit::RemoveElement { page: page.clone(), id }
            }
            Edit::MoveElement { page, id, parent, index } => {
                let p = self.page_mut(&page)?;
                let (from, at) = locate(&p.children, &id, None).ok_or_else(|| format!("{id} is not on {page}"))?;
                if let Some(target) = &parent {
                    let moved = find(&p.children, &id).expect("located above");
                    if target == &id || find(&moved.children, target).is_some() {
                        return Err("a frame cannot go inside itself".into());
                    }
                    holder(p, &parent)?;
                }
                let element = holder(p, &from)?.remove(at);
                let list = holder(p, &parent)?;
                list.insert(index.min(list.len()), element);
                Edit::MoveElement { page: page.clone(), id, parent: from, index: at }
            }
            Edit::SetProps { page, id, props } => {
                check_props(props.keys())?;
                let p = self.page_mut(&page)?;
                let e = find_mut(&mut p.children, &id).ok_or_else(|| format!("{id} is not on {page}"))?;
                let mut old = BTreeMap::new();
                for (key, value) in props {
                    let before = match value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
                        Some(v) => e.props.insert(key.clone(), v),
                        None => e.props.remove(&key),
                    };
                    old.insert(key, before);
                }
                Edit::SetProps { page: page.clone(), id, props: old }
            }
            Edit::SetHandler { page, id, event, code } => {
                check_event(&event)?;
                let p = self.page_mut(&page)?;
                let e = find_mut(&mut p.children, &id).ok_or_else(|| format!("{id} is not on {page}"))?;
                let at = e.handlers.partition_point(|h| rank(&h.event) < rank(&event));
                let old = e.handlers.get(at).filter(|h| h.event == event).map(|h| h.code.clone());
                if old.is_some() {
                    e.handlers.remove(at);
                }
                if let Some(code) = code {
                    e.handlers.insert(at, Handler { event: event.clone(), code: format::dedent(&code) });
                }
                Edit::SetHandler { page: page.clone(), id, event, code: old }
            }
            Edit::SetInput { page, name, input } => {
                let p = self.get(&page).ok_or_else(|| format!("there is no page {page}"))?;
                let (component, inputs) = match &p.interface {
                    Some(i) => (p.name.clone(), &i.inputs),
                    None => return Err(format!("{} is a page, and only a component has inputs", p.name)),
                };
                let at = inputs.iter().position(|i| i.name == name);
                let old = at.map(|at| inputs[at].clone());
                if let Some(new) = &input {
                    check_input_name(&new.name)?;
                    if new.name != name && inputs.iter().any(|i| i.name == new.name) {
                        return Err(format!("{component} already has an input {}", new.name));
                    }
                } else if old.is_none() {
                    return Err(format!("{component} has no input {name}"));
                }
                let to = input.as_ref().map(|i| i.name.clone());
                let list = &mut self.page_mut(&page)?.interface.as_mut().expect("a component, checked above").inputs;
                match (at, input) {
                    (Some(at), Some(new)) => list[at] = new,
                    (Some(at), None) => drop(list.remove(at)),
                    (None, Some(new)) => list.push(new),
                    (None, None) => unreachable!("refused above"),
                }
                // the component's code and its instances follow a rename, instances drop a removal
                if to.as_deref() != Some(name.as_str()) && old.is_some() {
                    let p = self.page_mut(&page)?;
                    if let Some(to) = &to {
                        for e in &mut p.children {
                            rename_in(e, &name, to);
                        }
                    }
                    for p in &mut self.list {
                        if instance_props(&mut p.children, &component, &name, to.as_deref()) {
                            touched.push(p.id.clone());
                        }
                    }
                }
                Edit::SetInput { page: page.clone(), name: to.unwrap_or(name), input: old }
            }
            Edit::SetEvent { page, name, to } => {
                let p = self.page_mut(&page)?;
                let component = p.name.clone();
                let events = &mut p.interface.as_mut().ok_or_else(|| format!("{component} is a page, and only a component sends events"))?.events;
                let at = events.iter().position(|e| *e == name);
                if let Some(to) = &to {
                    check_event(to)?;
                    if *to != name && events.contains(to) {
                        return Err(format!("{component} already sends {to}"));
                    }
                }
                let undo = match (at, &to) {
                    (Some(at), Some(to)) => {
                        events[at] = to.clone();
                        Edit::SetEvent { page: page.clone(), name: to.clone(), to: Some(name.clone()) }
                    }
                    (Some(at), None) => {
                        events.remove(at);
                        Edit::SetEvent { page: page.clone(), name: name.clone(), to: Some(name.clone()) }
                    }
                    (None, Some(to)) if *to == name => {
                        events.push(name.clone());
                        Edit::SetEvent { page: page.clone(), name: name.clone(), to: None }
                    }
                    _ => return Err(format!("{component} sends no {name}")),
                };
                // instances' handlers for a renamed event follow it
                if let (Some(_), Some(to)) = (at, &to) {
                    for p in &mut self.list {
                        if instance_events(&mut p.children, &component, &name, to) {
                            touched.push(p.id.clone());
                        }
                    }
                }
                undo
            }
            Edit::SetRule { id, rule } => {
                let at = self.rules.iter().position(|r| r.id == id);
                let old = at.map(|at| self.rules[at].clone());
                self.rules_changed = true;
                return Ok(match (at, rule) {
                    (Some(at), Some(mut rule)) => {
                        logic::check(&rule)?;
                        rule.id = id.clone();
                        self.rules[at] = rule;
                        Edit::SetRule { id, rule: old }
                    }
                    (Some(at), None) => {
                        self.rules.remove(at);
                        Edit::SetRule { id, rule: old }
                    }
                    (None, Some(mut rule)) => {
                        logic::check(&rule)?;
                        rule.id = if id.is_empty() { self.free_rule_id() } else { id };
                        let id = rule.id.clone();
                        self.rules.push(rule);
                        Edit::SetRule { id, rule: None }
                    }
                    (None, None) => return Err(format!("there is no handler {id}")),
                });
            }
            Edit::Batch { .. } => unreachable!("taken above"),
        };
        let page = match &undo {
            Edit::RenamePage { page, .. } | Edit::ResizePage { page, .. } | Edit::SetShows { page, .. } | Edit::RemoveElement { page, .. } => page,
            Edit::PutElement { page, .. } | Edit::MoveElement { page, .. } | Edit::SetProps { page, .. } | Edit::SetHandler { page, .. } => page,
            Edit::SetInput { page, .. } | Edit::SetEvent { page, .. } => page,
            _ => unreachable!("page edits return early"),
        };
        touched.push(page.clone());
        Ok(undo)
    }

    /// A component's name: PascalCase, as code and files name it, and its own. `own` is the
    /// component's id when it is renamed.
    fn component_name(&self, name: &str, own: Option<&str>) -> Result<String, String> {
        let name = name.trim();
        let mut chars = name.chars();
        if !(chars.next().is_some_and(|c| c.is_ascii_uppercase()) && chars.all(|c| c.is_ascii_alphanumeric())) {
            return Err(format!("\"{name}\" cannot name a component: start with a capital letter, then use letters and digits"));
        }
        if self.component(name).is_some_and(|p| Some(p.id.as_str()) != own) {
            return Err(format!("{name} is already a component"));
        }
        Ok(name.to_owned())
    }

    fn free_rule_id(&self) -> String {
        let highest = self.rules.iter().filter_map(|r| r.id.strip_prefix('h')?.parse::<u32>().ok()).max().unwrap_or(0);
        format!("h{}", highest + 1)
    }

    fn save_rules(&self) -> Result<(), String> {
        files::write(&self.root.join("logic").join("handlers.html"), &logic::write(&self.rules))
    }

    fn insert_page(&mut self, page: Page) {
        let at = self.list.partition_point(|p| p.id < page.id);
        self.list.insert(at, page);
    }

    fn page_mut(&mut self, id: &str) -> Result<&mut Page, String> {
        self.list.iter_mut().find(|p| p.id == id).ok_or_else(|| format!("there is no page {id}"))
    }

    fn free_id(&self, base: &str) -> String {
        let base = if base.is_empty() { "page" } else { base };
        let mut id = base.to_owned();
        let mut n = 2;
        while self.get(&id).is_some() {
            id = format!("{base}{n}");
            n += 1;
        }
        id
    }

    /// Saves a page or component, and takes away the file of one that is gone.
    fn save(&self, id: &str) -> Result<(), String> {
        let Some(page) = self.get(id) else {
            for folder in ["pages", "components"] {
                let file = self.root.join(folder).join(format!("{id}.html"));
                match fs::remove_file(&file) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("could not remove {}: {e}", file.display())),
                    _ => {}
                }
            }
            return Ok(());
        };
        let folder = if page.interface.is_some() { "components" } else { "pages" };
        files::write(&self.root.join(folder).join(format!("{id}.html")), &format::write(page))
    }
}

fn capital(word: &str) -> String {
    let mut c = word.chars();
    c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str()).unwrap_or_default()
}

fn named(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() { Err("a page needs a name".into()) } else { Ok(name.to_owned()) }
}

fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
    }
    s.trim_end_matches('-').to_owned()
}

/// Writes every use of the name `from` in an element's values and handlers as `to`. True
/// when any changed.
fn rename_in(e: &mut Element, from: &str, to: &str) -> bool {
    let mut changed = false;
    for value in e.props.iter_mut().filter(|(k, _)| k.as_str() != "name").map(|(_, v)| v) {
        let renamed = js::rename(value, from, to);
        changed |= renamed != *value;
        *value = renamed;
    }
    for h in &mut e.handlers {
        let renamed = js::rename(&h.code, from, to);
        changed |= renamed != h.code;
        h.code = renamed;
    }
    e.children.iter_mut().fold(changed, |c, child| rename_in(child, from, to) | c)
}

/// Moves each instance of `component`'s value for the input `from` to `to`, or drops it
/// where `to` is none. True when any changed.
fn instance_props(elements: &mut [Element], component: &str, from: &str, to: Option<&str>) -> bool {
    let mut changed = false;
    for e in elements {
        if e.component.as_deref() == Some(component) {
            if let Some(v) = e.props.remove(from) {
                if let Some(to) = to {
                    e.props.insert(to.to_owned(), v);
                }
                changed = true;
            }
        }
        changed |= instance_props(&mut e.children, component, from, to);
    }
    changed
}

/// Renames the handlers of `component`'s instances for the event `from` to `to`, keeping
/// their order. True when any changed.
fn instance_events(elements: &mut [Element], component: &str, from: &str, to: &str) -> bool {
    let mut changed = false;
    for e in elements {
        if e.component.as_deref() == Some(component) {
            for h in e.handlers.iter_mut().filter(|h| h.event == from) {
                h.event = to.to_owned();
                changed = true;
            }
            e.handlers.sort_by(|a, b| rank(&a.event).cmp(&rank(&b.event)));
        }
        changed |= instance_events(&mut e.children, component, from, to);
    }
    changed
}

/// An input is named in camelCase, apart from an element's own properties.
fn check_input_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let shaped = chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_alphanumeric());
    if !shaped || ["name", "x", "y", "w", "h", "text"].contains(&name) {
        return Err(format!("\"{name}\" cannot name an input: start with a small letter, use letters and digits, and keep clear of name, x, y, w, h and text"));
    }
    Ok(())
}

/// True when an element here is an instance of the component called `name`.
fn uses(elements: &[Element], name: &str) -> bool {
    elements.iter().any(|e| e.component.as_deref() == Some(name) || uses(&e.children, name))
}

/// Writes the instances of the component `from` as `to`. True when any changed.
fn rename_uses(elements: &mut [Element], from: &str, to: &str) -> bool {
    let mut changed = false;
    for e in elements {
        if e.component.as_deref() == Some(from) {
            e.component = Some(to.to_owned());
            changed = true;
        }
        changed |= rename_uses(&mut e.children, from, to);
    }
    changed
}

/// A property is a CSS name or an instance's input: a small letter first, then letters,
/// digits and hyphens.
fn check_props<'a>(keys: impl Iterator<Item = &'a String>) -> Result<(), String> {
    for key in keys {
        let ok = key.starts_with(|c: char| c.is_ascii_lowercase()) && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !ok {
            return Err(format!("\"{key}\" is not a property name"));
        }
    }
    Ok(())
}

/// The highest number in any id on the page. New ids count up from it, so none is reused
/// while the page holds a higher one.
fn highest(elements: &[Element]) -> u32 {
    elements.iter().map(|e| e.id.strip_prefix('e').and_then(|n| n.parse().ok()).unwrap_or(0).max(highest(&e.children))).max().unwrap_or(0)
}

/// Gives an element and all it holds new ids, `e` and a number counting up from `next`.
fn renumber(e: &mut Element, next: &mut u32) {
    e.id = format!("e{next}");
    *next += 1;
    e.children.iter_mut().for_each(|c| renumber(c, next));
}

/// An element's tree from a screen: property names, no text holding elements, and ids new
/// to `ids`, which gains them.
fn check_tree(e: &Element, ids: &mut HashSet<String>) -> Result<(), String> {
    check_props(e.props.keys())?;
    if e.tag != Tag::Div && !e.children.is_empty() {
        return Err("only a frame holds other elements".into());
    }
    if (e.tag == Tag::Use) != e.component.is_some() {
        return Err("an instance, and only an instance, names a component".into());
    }
    if !ids.insert(e.id.clone()) {
        return Err(format!("the id {} is already on the page", e.id));
    }
    e.children.iter().try_for_each(|c| check_tree(c, ids))
}

fn all_ids(e: &Element, ids: &mut HashSet<String>) {
    ids.insert(e.id.clone());
    e.children.iter().for_each(|c| all_ids(c, ids));
}

/// The list an element goes into: the page's own, or a frame's.
fn holder<'a>(page: &'a mut Page, parent: &Option<String>) -> Result<&'a mut Vec<Element>, String> {
    let Some(parent) = parent else { return Ok(&mut page.children) };
    let e = find_mut(&mut page.children, parent).ok_or_else(|| format!("{parent} is not on {}", page.id))?;
    if e.tag != Tag::Div {
        return Err("only a frame holds other elements".into());
    }
    Ok(&mut e.children)
}

/// Where an element sits: its frame, None for the page, and its index there.
fn locate(elements: &[Element], id: &str, parent: Option<&str>) -> Option<(Option<String>, usize)> {
    if let Some(at) = elements.iter().position(|e| e.id == id) {
        return Some((parent.map(str::to_owned), at));
    }
    elements.iter().find_map(|e| locate(&e.children, id, Some(&e.id)))
}

fn find<'a>(elements: &'a [Element], id: &str) -> Option<&'a Element> {
    elements.iter().find_map(|e| if e.id == id { Some(e) } else { find(&e.children, id) })
}

fn find_mut<'a>(elements: &'a mut [Element], id: &str) -> Option<&'a mut Element> {
    for e in elements {
        if e.id == id {
            return Some(e);
        }
        if let Some(found) = find_mut(&mut e.children, id) {
            return Some(found);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rant-hmi-pages-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn props(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn add(page: String, parent: Option<String>, tag: Tag, props: BTreeMap<String, String>) -> Edit {
        Edit::AddElement { page, parent, index: None, element: Element { id: String::new(), tag, component: None, props, handlers: Vec::new(), children: Vec::new() } }
    }

    #[test]
    fn a_new_project_gets_an_overview_and_edits_survive_a_reopen() {
        let dir = scratch("reopen");
        let mut pages = Pages::open(&dir).unwrap();
        assert_eq!(pages.list[0].id, "overview");
        let frame = pages
            .apply(add("overview".to_string(), None, Tag::Div, props(&[("x", "44"), ("background", "#222")])))
            .unwrap()
            .made
            .unwrap()
            .1;
        let text = pages
            .apply(add("overview".to_string(), Some(frame.clone()), Tag::Span, props(&[("text", "Speed")])))
            .unwrap()
            .made
            .unwrap()
            .1;
        assert_eq!((frame.as_str(), text.as_str()), ("e1", "e2"));
        let mut change = BTreeMap::new();
        change.insert("x".to_string(), Some("88".to_string()));
        change.insert("background".to_string(), None);
        pages.apply(Edit::SetProps { page: "overview".into(), id: frame.clone(), props: change }).unwrap();

        let again = Pages::open(&dir).unwrap();
        let e1 = &again.list[0].children[0];
        assert_eq!(e1.props, props(&[("x", "88")]));
        assert_eq!(e1.children[0].props["text"], "Speed");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn edits_that_cannot_apply_say_why() {
        let dir = scratch("refuse");
        let mut pages = Pages::open(&dir).unwrap();
        let o = || "overview".to_string();
        let span = pages.apply(add(o(), None, Tag::Span, BTreeMap::new())).unwrap().made.unwrap().1;
        let into_span = add(o(), Some(span.clone()), Tag::Div, BTreeMap::new());
        assert_eq!(pages.apply(into_span).err().unwrap(), "only a frame holds other elements");
        let bad = add(o(), None, Tag::Div, props(&[("Background", "red")]));
        assert_eq!(pages.apply(bad).err().unwrap(), "\"Background\" is not a property name");
        assert!(pages.apply(Edit::RemoveElement { page: o(), id: "e9".into() }).is_err());

        let frame = pages.apply(add(o(), None, Tag::Div, BTreeMap::new())).unwrap().made.unwrap().1;
        pages.apply(Edit::MoveElement { page: o(), id: span, parent: Some(frame.clone()), index: 0 }).unwrap();
        let into_itself = Edit::MoveElement { page: o(), id: frame.clone(), parent: Some(frame), index: 0 };
        assert_eq!(pages.apply(into_itself).err().unwrap(), "a frame cannot go inside itself");

        assert_eq!(pages.apply(Edit::AddPage { name: "Overview".into() }).unwrap().made.unwrap().1, "overview2");
        assert_eq!(pages.apply(Edit::RemovePage { page: "overview2".into() }).unwrap().pages, ["overview2"]);
        assert_eq!(pages.apply(Edit::RemovePage { page: o() }).err().unwrap(), "a project keeps at least one page");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_rename_follows_every_use_but_names() {
        let dir = scratch("rename");
        let mut pages = Pages::open(&dir).unwrap();
        let o = || "overview".to_string();
        pages.apply(add(o(), None, Tag::Div, props(&[("name", "Speed"), ("x", "Speed * 2")]))).unwrap();
        pages.apply(add(o(), Some("e1".into()), Tag::Span, props(&[("text", "\"Speed \" + Speed")]))).unwrap();
        pages.apply(Edit::SetHandler { page: o(), id: "e2".into(), event: "tap".into(), code: Some("Speed = 1;".into()) }).unwrap();
        pages.apply(Edit::AddPage { name: "Other".into() }).unwrap();
        assert_eq!(pages.rename("Speed", "LineSpeed", false).unwrap(), ["overview"]);
        let again = Pages::open(&dir).unwrap();
        let e1 = &again.get("overview").unwrap().children[0];
        assert_eq!((e1.props["name"].as_str(), e1.props["x"].as_str()), ("Speed", "LineSpeed * 2"));
        assert_eq!(e1.children[0].props["text"], "\"Speed \" + LineSpeed");
        assert_eq!(e1.children[0].handlers[0].code, "LineSpeed = 1;");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn handler_code_names_pages_by_their_names() {
        let dir = scratch("keys");
        let mut pages = Pages::open(&dir).unwrap();
        for name in ["Robot cell", "robot-cell", "2nd line"] {
            pages.apply(Edit::AddPage { name: name.into() }).unwrap();
        }
        let keys: Vec<String> = pages.keys().into_iter().map(|(k, id)| format!("{k}={id}")).collect();
        assert_eq!(keys, ["Page2ndLine=2nd-line", "Overview=overview", "RobotCell=robot-cell", "RobotCell2=robot-cell2"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Applies each edit, then undoes them all newest first, then redoes them all: the pages
    /// must come back to each state exactly, files included.
    #[test]
    fn every_edit_undoes_and_redoes_exactly() {
        let dir = scratch("undo");
        let mut pages = Pages::open(&dir).unwrap();
        let o = || "overview".to_string();
        let edits = vec![
            Edit::AddPage { name: "Line two".into() },
            Edit::RenamePage { page: "line-two".into(), name: "Line 2".into() },
            Edit::ResizePage { page: "line-two".into(), width: 390, height: 844 },
            Edit::SetShows { page: "line-two".into(), shows: Shows::Over },
            add(o(), None, Tag::Div, props(&[("x", "44"), ("background", "#222")])),
            add(o(), Some("e1".into()), Tag::Span, props(&[("text", "\"a\"")])),
            add(o(), None, Tag::Span, props(&[("text", "Speed")])),
            Edit::SetProps { page: o(), id: "e1".into(), props: [("x".to_string(), Some("88".to_string())), ("background".to_string(), None)].into() },
            Edit::MoveElement { page: o(), id: "e3".into(), parent: Some("e1".into()), index: 0 },
            Edit::SetHandler { page: o(), id: "e3".into(), event: "release".into(), code: Some("  Speed = 1;\n  log(\"</on>\")".into()) },
            Edit::SetHandler { page: o(), id: "e3".into(), event: "tap".into(), code: Some("Speed = 2;".into()) },
            Edit::SetHandler { page: o(), id: "e3".into(), event: "release".into(), code: None },
            Edit::RemoveElement { page: o(), id: "e1".into() },
            Edit::Batch {
                edits: vec![
                    add(o(), None, Tag::Div, BTreeMap::new()),
                    Edit::SetProps { page: o(), id: "e1".into(), props: [("y".to_string(), Some("11".to_string()))].into() },
                ],
            },
            Edit::RemovePage { page: "line-two".into() },
        ];
        let mut states = vec![(pages.list.clone(), files(&dir))];
        let mut undos = Vec::new();
        for edit in edits.clone() {
            undos.push(pages.apply(edit.clone()).unwrap_or_else(|e| panic!("{edit:?}: {e}")).undo);
            states.push((pages.list.clone(), files(&dir)));
        }
        let mut redos = Vec::new();
        for (n, undo) in undos.into_iter().enumerate().rev() {
            redos.push(pages.apply(undo).unwrap().undo);
            assert_eq!((pages.list.clone(), files(&dir)), states[n], "undoing {:?}", edits[n]);
        }
        for (n, redo) in redos.into_iter().rev().enumerate() {
            pages.apply(redo).unwrap();
            assert_eq!((pages.list.clone(), files(&dir)), states[n + 1], "redoing {:?}", edits[n]);
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_added_tree_gets_new_ids_and_goes_where_asked() {
        let dir = scratch("tree");
        let mut pages = Pages::open(&dir).unwrap();
        let o = || "overview".to_string();
        pages.apply(add(o(), None, Tag::Div, BTreeMap::new())).unwrap();
        pages.apply(add(o(), None, Tag::Div, BTreeMap::new())).unwrap();
        let leaf = |id: &str, tag| Element { id: id.into(), tag, component: None, props: BTreeMap::new(), handlers: Vec::new(), children: Vec::new() };
        let copy = Element { id: "e1".into(), tag: Tag::Div, component: None, props: props(&[("x", "11")]), handlers: Vec::new(), children: vec![leaf("e2", Tag::Span), leaf("x", Tag::Div)] };
        let made = pages.apply(Edit::AddElement { page: o(), parent: None, index: Some(1), element: copy }).unwrap().made.unwrap().1;
        assert_eq!(made, "e3");
        let ids: Vec<_> = pages.list[0].children.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["e1", "e3", "e2"]);
        let kids: Vec<_> = pages.list[0].children[1].children.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(kids, ["e4", "e5"]);
        let bad = Element { id: String::new(), tag: Tag::Span, component: None, props: BTreeMap::new(), handlers: Vec::new(), children: vec![leaf("", Tag::Span)] };
        assert_eq!(pages.apply(Edit::AddElement { page: o(), parent: None, index: None, element: bad }).err().unwrap(), "only a frame holds other elements");
        fs::remove_dir_all(&dir).unwrap();
    }

    fn instance(component: &str) -> Element {
        Element { id: String::new(), tag: Tag::Use, component: Some(component.into()), props: props(&[("x", "0")]), handlers: Vec::new(), children: Vec::new() }
    }

    #[test]
    fn components_hold_instances_but_never_themselves() {
        let dir = scratch("components");
        let mut pages = Pages::open(&dir).unwrap();
        let o = || "overview".to_string();
        let gauge = pages.apply(Edit::AddComponent { name: "Gauge".into() }).unwrap().made.unwrap().1;
        let card = pages.apply(Edit::AddComponent { name: "Card".into() }).unwrap().made.unwrap().1;
        assert_eq!(pages.apply(Edit::AddComponent { name: "gauge".into() }).err().unwrap(), "\"gauge\" cannot name a component: start with a capital letter, then use letters and digits");
        assert_eq!(pages.apply(Edit::AddComponent { name: "Gauge".into() }).err().unwrap(), "Gauge is already a component");
        pages.apply(Edit::AddElement { page: card.clone(), parent: None, index: None, element: instance("Gauge") }).unwrap();
        pages.apply(Edit::AddElement { page: o(), parent: None, index: None, element: instance("Card") }).unwrap();
        let add = |page: &str, c: &str| Edit::AddElement { page: page.into(), parent: None, index: None, element: instance(c) };
        assert_eq!(pages.apply(add(&gauge, "Card")).err().unwrap(), "Gauge cannot hold Card, since Card holds Gauge");
        assert_eq!(pages.apply(add(&gauge, "Gauge")).err().unwrap(), "Gauge cannot hold Gauge, since Gauge holds Gauge");
        assert_eq!(pages.apply(add(&o(), "Dial")).err().unwrap(), "there is no component Dial");
        assert_eq!(pages.apply(Edit::RemovePage { page: gauge.clone() }).err().unwrap(), "Gauge is placed on Card, so it stays");

        let renamed = pages.apply(Edit::RenamePage { page: gauge.clone(), name: "Dial".into() }).unwrap();
        assert_eq!(renamed.pages, [card.clone(), gauge.clone()]);
        let again = Pages::open(&dir).unwrap();
        assert_eq!(again.get(&card).unwrap().children[0].component.as_deref(), Some("Dial"));
        assert!(fs::read_to_string(dir.join("components").join(format!("{card}.html"))).unwrap().contains("<Dial id=\"e1\" x=\"0\"/>"));
        assert_eq!(again.keys().len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn inputs_rename_and_go_with_their_instances() {
        let dir = scratch("inputs");
        let mut pages = Pages::open(&dir).unwrap();
        let gauge = pages.apply(Edit::AddComponent { name: "Gauge".into() }).unwrap().made.unwrap().1;
        let input = |name: &str| Some(Input { name: name.into(), default: "0".into(), bindable: false });
        pages.apply(Edit::SetInput { page: gauge.clone(), name: "value".into(), input: input("value") }).unwrap();
        pages.apply(add(gauge.clone(), None, Tag::Span, props(&[("text", "value.toFixed(1)")]))).unwrap();
        let mut gauge_on_page = instance("Gauge");
        gauge_on_page.props.insert("value".into(), "Speed".into());
        pages.apply(Edit::AddElement { page: "overview".into(), parent: None, index: None, element: gauge_on_page }).unwrap();

        let undo = pages.apply(Edit::SetInput { page: gauge.clone(), name: "value".into(), input: input("level") }).unwrap().undo;
        assert_eq!(pages.get(&gauge).unwrap().children[0].props["text"], "level.toFixed(1)");
        assert_eq!(pages.get("overview").unwrap().children[0].props["level"], "Speed");
        let again = Pages::open(&dir).unwrap();
        assert_eq!(again.get(&gauge).unwrap().interface.as_ref().unwrap().inputs, [input("level").unwrap()]);
        pages.apply(undo).unwrap();
        assert_eq!(pages.get("overview").unwrap().children[0].props["value"], "Speed");

        assert!(pages.apply(Edit::SetInput { page: gauge.clone(), name: "x".into(), input: input("x") }).unwrap_err().contains("keep clear"));
        assert!(pages.apply(Edit::SetInput { page: "overview".into(), name: "a".into(), input: input("a") }).unwrap_err().contains("only a component"));
        pages.apply(Edit::SetInput { page: gauge.clone(), name: "value".into(), input: None }).unwrap();
        assert!(!pages.get("overview").unwrap().children[0].props.contains_key("value"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn events_a_component_sends_rename_with_their_handlers() {
        let dir = scratch("events");
        let mut pages = Pages::open(&dir).unwrap();
        let toggle = pages.apply(Edit::AddComponent { name: "Toggle".into() }).unwrap().made.unwrap().1;
        let event = |name: &str, to: Option<&str>| Edit::SetEvent { page: toggle.clone(), name: name.into(), to: to.map(Into::into) };
        pages.apply(event("change", Some("change"))).unwrap();
        let id = pages.apply(Edit::AddElement { page: "overview".into(), parent: None, index: None, element: instance("Toggle") }).unwrap().made.unwrap().1;
        pages.apply(Edit::SetHandler { page: "overview".into(), id: id.clone(), event: "change".into(), code: Some("Running = p;".into()) }).unwrap();
        pages.apply(Edit::SetHandler { page: "overview".into(), id: id.clone(), event: "tap".into(), code: Some("log(1);".into()) }).unwrap();
        let undo = pages.apply(event("change", Some("flip"))).unwrap().undo;
        let events: Vec<_> = pages.get("overview").unwrap().children[0].handlers.iter().map(|h| h.event.as_str()).collect();
        assert_eq!(events, ["tap", "flip"]);
        assert!(fs::read_to_string(dir.join("components/toggle.html")).unwrap().contains("<event name=\"flip\"/>"));
        pages.apply(undo).unwrap();
        assert_eq!(pages.get(&toggle).unwrap().interface.as_ref().unwrap().events, ["change"]);
        assert_eq!(pages.apply(event("nope", None)).err().unwrap(), "Toggle sends no nope");
        assert!(pages.apply(Edit::SetHandler { page: "overview".into(), id, event: "On Off".into(), code: None }).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rules_are_made_changed_and_undone_and_survive_a_reopen() {
        let dir = scratch("rules");
        let mut pages = Pages::open(&dir).unwrap();
        let rule = |name: &str| Rule { id: String::new(), name: name.into(), when: logic::When::Every { ms: 500 }, code: "x = 1;".into() };
        let made = pages.apply(Edit::SetRule { id: String::new(), rule: Some(rule("Blink")) }).unwrap();
        assert!(made.rules);
        assert_eq!(pages.rules[0].id, "h1");
        let undo = pages.apply(Edit::SetRule { id: "h1".into(), rule: None }).unwrap().undo;
        assert!(pages.rules.is_empty());
        pages.apply(undo).unwrap();
        assert_eq!(Pages::open(&dir).unwrap().rules, [Rule { id: "h1".into(), ..rule("Blink") }]);
        let fast = Rule { when: logic::When::Every { ms: 5 }, ..rule("Fast") };
        assert!(pages.apply(Edit::SetRule { id: String::new(), rule: Some(fast) }).unwrap_err().contains("50 ms"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_batch_that_fails_changes_nothing() {
        let dir = scratch("batch");
        let mut pages = Pages::open(&dir).unwrap();
        let before = (pages.list.clone(), files(&dir));
        let batch = Edit::Batch {
            edits: vec![
                add("overview".to_string(), None, Tag::Div, BTreeMap::new()),
                Edit::RemoveElement { page: "overview".into(), id: "e9".into() },
            ],
        };
        assert_eq!(pages.apply(batch).err().unwrap(), "e9 is not on overview");
        assert_eq!((pages.list.clone(), files(&dir)), before);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Every file in the pages folder and its text.
    fn files(dir: &Path) -> BTreeMap<String, String> {
        fs::read_dir(dir.join("pages"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), fs::read_to_string(&p).unwrap()))
            .collect()
    }
}

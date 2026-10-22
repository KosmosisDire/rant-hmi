//! The pages and components, one file each, the HMI's own handlers, and the edits that change
//! them. A component is a page with an interface, so every edit works on both.

pub mod format;
pub mod js;
pub mod logic;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::events::{self, rank};
use crate::files;
use crate::list::{self, by_name};
use crate::rules;
use crate::value::Value;
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
    /// A page's ground, an expression. Empty is the theme's `$ground`.
    #[serde(default)]
    pub fill: String,
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
    /// Its own state, which each instance keeps on each screen.
    #[serde(default)]
    pub variables: Vec<Local>,
    #[serde(default)]
    pub sizing: Sizing,
}

/// How an instance draws its component in the box it is placed at: scaled whole to fit,
/// keeping its shape, or laid out anew in that box, so what it places in percents stretches.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Sizing {
    #[default]
    Scale,
    Fill,
}

/// A component's own variable, camelCase. Each instance starts it at `start`, an expression of
/// constants and theme tokens, and its code sets it.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Local {
    pub name: String,
    pub start: String,
}

/// A value a component reads and each instance gives, camelCase like any local name.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Input {
    pub name: String,
    /// The expression it reads while an instance gives none, of constants and theme tokens.
    pub default: String,
    /// The component may write it back through the instance's binding.
    #[serde(default)]
    pub bindable: bool,
}

by_name!(Local, Input);

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
    /// At most one per event and filter, in the order events are listed.
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
    /// Its settings read as expressions, each one its event takes, as a hold's `after`. One
    /// left out is its default.
    #[serde(default)]
    pub attrs: BTreeMap<String, String>,
    /// What its event must bring for it to run, by field, as a key's `key`. One left out takes
    /// any.
    #[serde(default)]
    pub filter: BTreeMap<String, String>,
}

impl Handler {
    pub fn new(event: &str, filter: BTreeMap<String, String>) -> Self {
        Handler { event: event.to_owned(), code: String::new(), attrs: BTreeMap::new(), filter }
    }

    /// Whether it runs for `event` bringing `p`: each of its filters equals the field of p it names.
    pub fn takes(&self, event: &str, p: &Value) -> bool {
        self.event == event && self.filter.iter().all(|(k, v)| p.get(k).and_then(events::filter_text).as_ref() == Some(v))
    }

    /// The setting `key` as written.
    pub fn setting(&self, key: &str) -> Option<&String> {
        self.filter.get(key).or_else(|| self.attrs.get(key))
    }

    /// Sets the setting `key`, a filter as it is and an expression trimmed, or removes it where
    /// that leaves it empty.
    pub fn set(&mut self, key: &str, value: Option<&str>) {
        let (map, value) = match events::filters(&self.event, key) {
            true => (&mut self.filter, value),
            false => (&mut self.attrs, value.map(str::trim)),
        };
        match value.filter(|v| !v.is_empty()) {
            Some(v) => map.insert(key.to_owned(), v.to_owned()),
            None => map.remove(key),
        };
    }
}

/// Whether `h` may join an element's `others`: its event's name fits, its settings are ones
/// its event takes, and none of the others handles its event with its filter.
pub fn check_handler<'a>(others: impl IntoIterator<Item = &'a Handler>, h: &Handler) -> Result<(), String> {
    rules::EVENT.check(&h.event, "an event")?;
    let takes = |key: &str, filter: bool| events::settings(&h.event).iter().any(|s| s.name == key) && events::filters(&h.event, key) == filter;
    if let Some(key) = h.attrs.keys().find(|k| !takes(k, false)).or_else(|| h.filter.keys().find(|k| !takes(k, true))) {
        return Err(format!("a {} handler takes no {key}", h.event));
    }
    for (key, value) in &h.filter {
        let options = events::setting(&h.event, key).map_or(&[][..], |s| s.options);
        if !options.is_empty() && !options.iter().any(|(o, _)| o == value) {
            let all: Vec<&str> = options.iter().map(|(o, _)| *o).collect();
            return Err(format!("a {} handler's {key} is one of {}, not {value:?}", h.event, all.join(", ")));
        }
    }
    match others.into_iter().any(|o| o.event == h.event && o.filter == h.filter) {
        true => Err(format!("a second {} handler{}", h.event, h.filter.iter().map(|(k, v)| format!(" for {k} {v:?}")).collect::<Vec<_>>().join(" and"))),
        false => Ok(()),
    }
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
    /// A field an operator types a value into.
    Input,
    /// A picture or a video: a URL, a mesh import's pictures as they come, or its H264 video
    /// played over WebRTC.
    Media,
    /// A diagram: placed like a frame, holding shapes drawn in its own units.
    Svg,
    /// SVG markup an expression gives as text, drawn in the element's box.
    Markup,
    /// A canvas its code draws on, in 2D or with WebGL.
    Canvas,
    Path,
    Circle,
    Ellipse,
    Rect,
    Line,
    Polyline,
    Polygon,
    /// A text in a diagram.
    #[serde(rename = "text")]
    SvgText,
    /// Shapes kept together in a diagram, moved as one by a transform.
    G,
    /// Elements kept together, picked and moved as one. It has no box, origin or place of its
    /// own, so what it holds sits where it would without it.
    Group,
}

/// Each tag and the word its file writes, but an instance, which takes its component's name.
pub(crate) const WORDS: [(Tag, &str); 17] = [
    (Tag::Div, "div"),
    (Tag::Group, "group"),
    (Tag::Span, "span"),
    (Tag::Input, "input"),
    (Tag::Media, "media"),
    (Tag::Svg, "svg"),
    (Tag::Markup, "markup"),
    (Tag::Canvas, "canvas"),
    (Tag::Path, "path"),
    (Tag::Circle, "circle"),
    (Tag::Ellipse, "ellipse"),
    (Tag::Rect, "rect"),
    (Tag::Line, "line"),
    (Tag::Polyline, "polyline"),
    (Tag::Polygon, "polygon"),
    (Tag::SvgText, "text"),
    (Tag::G, "g"),
];

impl Tag {
    pub fn from_word(word: &str) -> Option<Tag> {
        WORDS.iter().find(|(_, w)| *w == word).map(|(t, _)| *t)
    }

    /// A shape draws inside a diagram, and its every property is an SVG attribute.
    pub fn is_shape(self) -> bool {
        matches!(self, Tag::Path | Tag::Circle | Tag::Ellipse | Tag::Rect | Tag::Line | Tag::Polyline | Tag::Polygon | Tag::SvgText | Tag::G)
    }

    /// Whether this may hold a `child`: a frame or a group holds elements, a diagram or its
    /// group shapes.
    fn holds(self, child: Tag) -> Result<(), String> {
        match self {
            Tag::Div | Tag::Group if child.is_shape() => Err("a shape goes in a diagram".into()),
            Tag::Div | Tag::Group => Ok(()),
            Tag::Svg | Tag::G if child.is_shape() => Ok(()),
            Tag::Svg | Tag::G => Err("a diagram holds only shapes".into()),
            _ => Err("only a frame, a group or a diagram holds other elements".into()),
        }
    }
}

impl Element {
    /// The tag the file writes: an instance takes its component's name.
    pub fn word(&self) -> &str {
        match self.tag {
            Tag::Use => self.component.as_deref().unwrap_or("Missing"),
            tag => WORDS.iter().find(|(t, _)| *t == tag).map(|(_, w)| *w).expect("every tag but use has a word"),
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
    /// A page or component made as a copy of another, under a name of its own.
    CopyPage { page: String, name: String },
    /// Renames a page or component, whose id and file follow the name. `id` is the id it takes
    /// instead, as an undo puts the old one back.
    RenamePage {
        page: String,
        name: String,
        #[serde(default)]
        #[ts(optional)]
        id: Option<String>,
    },
    ResizePage { page: String, width: u32, height: u32 },
    SetShows { page: String, shows: Shows },
    /// How a component's instances draw it.
    SetSizing { page: String, sizing: Sizing },
    SetFill { page: String, fill: String },
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
    /// Puts elements that share a holder into a new group where the front most of them stood,
    /// in their order. Shapes go into a diagram's group.
    Group { page: String, ids: Vec<String> },
    /// Puts what a group holds in its place and removes it.
    Ungroup { page: String, id: String },
    /// Puts elements that share a holder into a new frame with `props` where the front most of
    /// them stood, in the order given, as the frame's flow lays them out.
    Wrap { page: String, ids: Vec<String>, props: BTreeMap<String, String> },
    /// Sets each property to its value, or removes it where the value is null.
    SetProps { page: String, id: String, props: BTreeMap<String, Option<String>> },
    /// Sets the code the element runs on `event`, or removes its handler where it is null.
    /// `filter` names which of its handlers for the event, none for the one that takes any.
    /// `attrs` sets each setting named, a filter too, to its default where null, and keeps the
    /// rest.
    SetHandler {
        page: String,
        id: String,
        event: String,
        #[serde(default)]
        #[ts(optional)]
        filter: Option<BTreeMap<String, String>>,
        code: Option<String>,
        #[serde(default)]
        #[ts(optional)]
        attrs: Option<BTreeMap<String, Option<String>>>,
    },
    /// Adds, changes or with null removes a component's input called `name`. A rename is
    /// followed in the component and by its instances, a removal takes it off them.
    SetInput { page: String, name: String, input: Option<Input> },
    /// Adds the event `to` to a component when `name` is not one yet, renames `name` to it, or
    /// with null removes it. Instances' handlers follow a rename.
    SetEvent { page: String, name: String, to: Option<String> },
    /// Adds, changes or with null removes a component's variable called `name`. The
    /// component's code follows a rename.
    SetLocal { page: String, name: String, local: Option<Local> },
    /// Sets the rule `id`, puts it back under that id when it is gone, gives it a new id when
    /// `id` is empty, or with null removes it.
    SetRule { id: String, rule: Option<Rule> },
    /// Several edits as one: all apply or none do, and one undo takes them all back.
    Batch { edits: Vec<Edit> },
}

/// What an edit changed: the pages to send out, what it made, if anything, as a page and an
/// id (a page's own for a page), the ids a rename moved, from and to, and the edit that undoes
/// it.
#[derive(Debug)]
pub struct Applied {
    pub pages: Vec<String>,
    /// The rules changed.
    pub rules: bool,
    pub made: Option<(String, String)>,
    pub moved: Vec<(String, String)>,
    pub undo: Edit,
}

/// Every edit that names a page or component by its id, binding the id to `$page`.
macro_rules! on_page {
    ($page:ident) => {
        Edit::CopyPage { page: $page, .. }
            | Edit::RenamePage { page: $page, .. }
            | Edit::ResizePage { page: $page, .. }
            | Edit::SetShows { page: $page, .. }
            | Edit::SetSizing { page: $page, .. }
            | Edit::SetFill { page: $page, .. }
            | Edit::RemovePage { page: $page }
            | Edit::AddElement { page: $page, .. }
            | Edit::RemoveElement { page: $page, .. }
            | Edit::PutElement { page: $page, .. }
            | Edit::MoveElement { page: $page, .. }
            | Edit::Group { page: $page, .. }
            | Edit::Ungroup { page: $page, .. }
            | Edit::Wrap { page: $page, .. }
            | Edit::SetProps { page: $page, .. }
            | Edit::SetHandler { page: $page, .. }
            | Edit::SetInput { page: $page, .. }
            | Edit::SetEvent { page: $page, .. }
            | Edit::SetLocal { page: $page, .. }
    };
}

impl Edit {
    /// Names the page `to` wherever this edit names the page `from`, as after a rename moved
    /// its id. The id a rename's undo puts back stays.
    pub fn repage(&mut self, from: &str, to: &str) {
        let page = match self {
            Edit::AddPage { .. } | Edit::AddComponent { .. } | Edit::SetRule { .. } => return,
            Edit::Batch { edits } => return edits.iter_mut().for_each(|e| e.repage(from, to)),
            Edit::PutPage { page } => &mut page.id,
            on_page!(page) => page,
        };
        if page == from {
            *page = to.to_owned();
        }
    }

    /// The ids of the pages and components the edit names, a batch's all.
    pub fn pages(&self) -> Vec<&str> {
        match self {
            Edit::AddPage { .. } | Edit::AddComponent { .. } | Edit::SetRule { .. } => vec![],
            Edit::Batch { edits } => edits.iter().flat_map(Edit::pages).collect(),
            Edit::PutPage { page } => vec![&page.id],
            on_page!(page) => vec![page],
        }
    }
}

pub struct Pages {
    root: PathBuf,
    /// Pages and components in id order, as the files list.
    pub list: Vec<Page>,
    /// The HMI's own handlers, in the order they were made.
    pub rules: Vec<Rule>,
    /// Set by an edit that changed the rules, until it is saved.
    rules_changed: bool,
    /// The ids renames moved during an edit, until it is applied.
    moved: Vec<(String, String)>,
}

/// A new page, in units of 10 px: 1280 by 720 pixels.
const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
const COMPONENT_WIDTH: u32 = 24;
const COMPONENT_HEIGHT: u32 = 16;
/// The largest side a page may have, in units of 10 px.
const LARGEST: u32 = 1600;

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
                let name = files::shown(root, &file);
                let text = fs::read_to_string(&file).with_context(|| format!("reading {name}"))?;
                let page = format::parse(&text, &id).map_err(|e| anyhow::anyhow!("{name}, {e}"))?;
                if (folder == "components") != page.interface.is_some() {
                    anyhow::bail!("{name} belongs in {}", if folder == "pages" { "components" } else { "pages" });
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
            true => logic::parse(&fs::read_to_string(&file).context("reading logic/handlers.html")?).map_err(|e| anyhow::anyhow!("logic/handlers.html, {e}"))?,
            false => Vec::new(),
        };
        let mut pages = Pages { root: root.to_path_buf(), list, rules, rules_changed: false, moved: Vec::new() };
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
        let mut seen = HashSet::new();
        let mut todo = vec![component.to_owned()];
        while let Some(c) = todo.pop() {
            if c == name {
                return true;
            }
            if seen.insert(c.clone()) {
                todo.extend(all(self.component(&c).map_or(&[][..], |p| &p.children)).filter_map(|e| e.component.clone()));
            }
        }
        false
    }

    /// An element tree may go into `page` when each instance in it names a component that
    /// exists and does not hold `page`, which would make it hold itself.
    fn check_uses(&self, page: &str, e: &Element) -> Result<(), String> {
        let host = self.get(page).filter(|p| p.interface.is_some()).map(|p| p.name.clone());
        for c in all(std::slice::from_ref(e)).filter_map(|e| e.component.as_ref()) {
            if self.component(c).is_none() {
                return Err(format!("there is no component {c}"));
            }
            if let Some(host) = host.as_ref().filter(|h| self.holds(c, h)) {
                return Err(format!("{host} cannot hold {c}, since {c} holds {host}"));
            }
        }
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&Page> {
        self.list.iter().find(|p| p.id == id)
    }

    pub fn element(&self, page: &str, id: &str) -> Option<&Element> {
        self.get(page).and_then(|p| find(&p.children, id))
    }

    /// Writes every use of `from` as `to` and saves each page that changed, which it returns.
    /// Components read only their inputs and the theme, so they follow only when `components`.
    pub fn rename(&mut self, from: &str, to: &str, components: bool) -> Result<Vec<String>, String> {
        let mut touched = Vec::new();
        for p in self.list.iter_mut().filter(|p| components || p.interface.is_none()) {
            let fill = js::rename(&p.fill, from, to);
            let mut changed = fill != p.fill;
            p.fill = fill;
            // a component's input defaults and variable starts may read a theme token
            if let Some(i) = p.interface.as_mut() {
                for code in i.inputs.iter_mut().map(|i| &mut i.default).chain(i.variables.iter_mut().map(|v| &mut v.start)) {
                    let renamed = js::rename(code, from, to);
                    changed |= renamed != *code;
                    *code = renamed;
                }
            }
            if each_mut(&mut p.children, &mut |e| rename_in(e, from, to)) | changed {
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
        Ok(Applied { pages, rules, made, moved: std::mem::take(&mut self.moved), undo })
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
                let id = self.free_id(&slug(&name), None);
                self.insert_page(Page { id: id.clone(), name, width: WIDTH, height: HEIGHT, shows: Shows::Full, fill: String::new(), interface: None, children: Vec::new() });
                *made = Some((id.clone(), id.clone()));
                touched.push(id.clone());
                return Ok(Edit::RemovePage { page: id });
            }
            Edit::AddComponent { name } => {
                let name = self.component_name(&name, None)?;
                let id = self.free_id(&slug(&name), None);
                let interface = Some(Interface::default());
                self.insert_page(Page { id: id.clone(), name, width: COMPONENT_WIDTH, height: COMPONENT_HEIGHT, shows: Shows::Full, fill: String::new(), interface, children: Vec::new() });
                *made = Some((id.clone(), id.clone()));
                touched.push(id.clone());
                return Ok(Edit::RemovePage { page: id });
            }
            Edit::CopyPage { page, name } => {
                let from = self.get(&page).ok_or_else(|| format!("there is no page {page}"))?.clone();
                let name = if from.interface.is_some() { self.component_name(&name, None)? } else { named(&name)? };
                let id = self.free_id(&slug(&name), None);
                self.insert_page(Page { id: id.clone(), name, ..from });
                *made = Some((id.clone(), id.clone()));
                touched.push(id.clone());
                return Ok(Edit::RemovePage { page: id });
            }
            Edit::RenamePage { page, name, id } => {
                let old = self.get(&page).ok_or_else(|| format!("there is no page {page}"))?.name.clone();
                let component = self.get(&page).is_some_and(|p| p.interface.is_some());
                let name = if component { self.component_name(&name, Some(&page))? } else { named(&name)? };
                // its id and file follow the name
                let to = id.unwrap_or_else(|| self.free_id(&slug(&name), Some(&page)));
                if to != page && self.get(&to).is_some() {
                    return Err(format!("{to} is already the id of another page"));
                }
                self.page_mut(&page)?.name = name.clone();
                // every instance of a renamed component follows it
                if component {
                    for p in &mut self.list {
                        if rename_uses(&mut p.children, &old, &name) {
                            touched.push(p.id.clone());
                        }
                    }
                }
                if to != page {
                    let at = self.list.iter().position(|p| p.id == page).expect("renamed above");
                    let mut p = self.list.remove(at);
                    p.id = to.clone();
                    self.insert_page(p);
                    // its old file goes
                    touched.push(page.clone());
                    self.moved.push((page.clone(), to.clone()));
                }
                Edit::RenamePage { page: to, name: old, id: Some(page) }
            }
            Edit::ResizePage { page, width, height } => {
                if !(1..=LARGEST).contains(&width) || !(1..=LARGEST).contains(&height) {
                    return Err(format!("a page is 1 to {LARGEST} units a side"));
                }
                let p = self.page_mut(&page)?;
                let old = (std::mem::replace(&mut p.width, width), std::mem::replace(&mut p.height, height));
                Edit::ResizePage { page: page.clone(), width: old.0, height: old.1 }
            }
            Edit::SetShows { page, shows } => {
                let old = std::mem::replace(&mut self.page_mut(&page)?.shows, shows);
                Edit::SetShows { page: page.clone(), shows: old }
            }
            Edit::SetSizing { page, sizing } => {
                let p = self.page_mut(&page)?;
                let name = p.name.clone();
                let i = p.interface.as_mut().ok_or_else(|| format!("{name} is a page, and only a component is placed at a size"))?;
                let old = std::mem::replace(&mut i.sizing, sizing);
                Edit::SetSizing { page: page.clone(), sizing: old }
            }
            Edit::SetFill { page, fill } => {
                let p = self.page_mut(&page)?;
                if p.interface.is_some() {
                    return Err(format!("{} draws on what holds it, so it has no fill", p.name));
                }
                let old = std::mem::replace(&mut p.fill, fill.trim().to_owned());
                Edit::SetFill { page: page.clone(), fill: old }
            }
            Edit::RemovePage { page } => {
                let at = self.list.iter().position(|p| p.id == page).ok_or_else(|| format!("there is no page {page}"))?;
                let gone = &self.list[at];
                if gone.interface.is_none() && self.list.iter().filter(|p| p.interface.is_none()).count() == 1 {
                    return Err("a project keeps at least one page".into());
                }
                if gone.interface.is_some() {
                    let user = self.list.iter().find(|p| p.id != page && all(&p.children).any(|e| e.component.as_ref() == Some(&gone.name)));
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
                each_mut(std::slice::from_mut(&mut element), &mut |e| {
                    e.id = format!("e{next}");
                    next += 1;
                    false
                });
                check_tree(&element, &mut HashSet::new())?;
                let id = element.id.clone();
                let list = holder(p, &parent, element.tag)?;
                list.insert(index.unwrap_or(list.len()).min(list.len()), element);
                *made = Some((page.clone(), id.clone()));
                Edit::RemoveElement { page: page.clone(), id }
            }
            Edit::RemoveElement { page, id } => {
                let p = self.page_mut(&page)?;
                let (parent, index) = locate(&p.children, &id, None).ok_or_else(|| format!("{id} is not on {page}"))?;
                let tag = find(&p.children, &id).expect("located above").tag;
                let element = holder(p, &parent, tag)?.remove(index);
                Edit::PutElement { page: page.clone(), parent, index, element }
            }
            Edit::PutElement { page, parent, index, element } => {
                self.check_uses(&page, &element)?;
                let p = self.page_mut(&page)?;
                let mut ids = all(&p.children).map(|e| e.id.clone()).collect();
                check_tree(&element, &mut ids)?;
                let id = element.id.clone();
                let list = holder(p, &parent, element.tag)?;
                list.insert(index.min(list.len()), element);
                *made = Some((page.clone(), id.clone()));
                Edit::RemoveElement { page: page.clone(), id }
            }
            Edit::MoveElement { page, id, parent, index } => {
                let p = self.page_mut(&page)?;
                let (from, at) = locate(&p.children, &id, None).ok_or_else(|| format!("{id} is not on {page}"))?;
                let moved = find(&p.children, &id).expect("located above");
                let tag = moved.tag;
                if let Some(target) = &parent
                    && (target == &id || find(&moved.children, target).is_some())
                {
                    return Err("a frame cannot go inside itself".into());
                }
                holder(p, &parent, tag)?;
                let element = holder(p, &from, tag)?.remove(at);
                let list = holder(p, &parent, tag)?;
                list.insert(index.min(list.len()), element);
                Edit::MoveElement { page: page.clone(), id, parent: from, index: at }
            }
            Edit::Group { page, ids } => {
                let p = self.page_mut(&page)?;
                let (holder, mut order) = sharing(&p.children, &page, &ids, "group")?;
                order.sort();
                let tag = if find(&p.children, &order[0].1).expect("located above").tag.is_shape() { Tag::G } else { Tag::Group };
                let element = Element { id: String::new(), tag, component: None, props: BTreeMap::new(), handlers: Vec::new(), children: Vec::new() };
                let edits = into_new(&page, &p.children, holder, &order, element);
                return self.change(edits, touched, made);
            }
            Edit::Wrap { page, ids, props } => {
                let p = self.page_mut(&page)?;
                let (holder, order) = sharing(&p.children, &page, &ids, "wrap")?;
                if order.iter().any(|(_, id)| find(&p.children, id).expect("located above").tag.is_shape()) {
                    return Err("a frame holds elements, and shapes stay in their diagram".into());
                }
                let element = Element { id: String::new(), tag: Tag::Div, component: None, props, handlers: Vec::new(), children: Vec::new() };
                let edits = into_new(&page, &p.children, holder, &order, element);
                return self.change(edits, touched, made);
            }
            Edit::Ungroup { page, id } => {
                let p = self.page_mut(&page)?;
                let (holder, at) = locate(&p.children, &id, None).ok_or_else(|| format!("{id} is not on {page}"))?;
                let group = find(&p.children, &id).expect("located above");
                if !matches!(group.tag, Tag::Group | Tag::G) {
                    return Err(format!("{id} is not a group"));
                }
                if let Some(key) = group.props.keys().find(|k| *k != "name") {
                    return Err(format!("the group sets {key}, which ungrouping would lose"));
                }
                if !group.handlers.is_empty() {
                    return Err("the group handles events, which ungrouping would lose".into());
                }
                let mut edits: Vec<Edit> = group.children.iter().enumerate().map(|(k, c)| Edit::MoveElement { page: page.clone(), id: c.id.clone(), parent: holder.clone(), index: at + k }).collect();
                edits.push(Edit::RemoveElement { page: page.clone(), id });
                return self.change(Edit::Batch { edits }, touched, made);
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
            Edit::SetHandler { page, id, event, filter, code, attrs } => {
                rules::EVENT.check(&event, "an event")?;
                let (filter, attrs) = (filter.unwrap_or_default(), attrs.unwrap_or_default());
                let p = self.page_mut(&page)?;
                let e = find_mut(&mut p.children, &id).ok_or_else(|| format!("{id} is not on {page}"))?;
                let at = e.handlers.iter().position(|h| h.event == event && h.filter == filter);
                let old = at.map(|n| e.handlers[n].clone());
                // the filter it has after, which its undo names
                let mut now = filter.clone();
                match (code, at) {
                    (Some(code), _) => {
                        let mut h = old.clone().unwrap_or_else(|| Handler::new(&event, filter));
                        h.code = format::dedent(&code);
                        for (key, value) in &attrs {
                            h.set(key, value.as_deref());
                        }
                        check_handler(e.handlers.iter().enumerate().filter(|(n, _)| Some(*n) != at).map(|(_, o)| o), &h)?;
                        now = h.filter.clone();
                        // in its place, so a card never moves under the pointer
                        match at {
                            Some(n) => e.handlers[n] = h,
                            None => {
                                e.handlers.push(h);
                                e.handlers.sort_by(|a, b| rank(&a.event).cmp(&rank(&b.event)));
                            }
                        }
                    }
                    (None, Some(n)) => drop(e.handlers.remove(n)),
                    (None, None) => {}
                }
                // undone, the old code comes back with each setting as it was
                let back = match &old {
                    Some(o) => o.attrs.keys().chain(o.filter.keys()).chain(attrs.keys()).map(|k| (k.clone(), o.setting(k).cloned())).collect(),
                    None => BTreeMap::new(),
                };
                Edit::SetHandler { page: page.clone(), id, event, filter: Some(now), code: old.map(|h| h.code), attrs: Some(back) }
            }
            Edit::SetInput { page, name, input } => {
                let p = self.get(&page).ok_or_else(|| format!("there is no page {page}"))?;
                let Some(i) = &p.interface else {
                    return Err(format!("{} is a page, and only a component has inputs", p.name));
                };
                let component = p.name.clone();
                if let Some(new) = &input {
                    rules::INPUT.check(&new.name, "an input")?;
                    if list::taken(&i.inputs, &new.name, &name) {
                        return Err(format!("{component} already has an input {}", new.name));
                    }
                }
                let to = input.as_ref().map(|i| i.name.clone());
                let inputs = &mut self.page_mut(&page)?.interface.as_mut().expect("a component, checked above").inputs;
                let old = list::put(inputs, &name, input, || format!("{component} has no input {name}"))?;
                // the component's code and its instances follow a rename, instances drop a removal
                if to.as_deref() != Some(name.as_str()) && old.is_some() {
                    let p = self.page_mut(&page)?;
                    if let Some(to) = &to {
                        each_mut(&mut p.children, &mut |e| rename_in(e, &name, to));
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
                if let Some(to) = &to {
                    rules::EVENT.check(to, "an event")?;
                    if list::taken(events, to, &name) {
                        return Err(format!("{component} already sends {to}"));
                    }
                    // a new event comes under its own name
                    if *to != name && !events.contains(&name) {
                        return Err(format!("{component} sends no {name}"));
                    }
                }
                let old = list::put(events, &name, to.clone(), || format!("{component} sends no {name}"))?;
                // instances' handlers for a renamed event follow it
                if let (Some(_), Some(to)) = (&old, &to) {
                    for p in &mut self.list {
                        if instance_events(&mut p.children, &component, &name, to) {
                            touched.push(p.id.clone());
                        }
                    }
                }
                Edit::SetEvent { page: page.clone(), name: to.unwrap_or(name), to: old }
            }
            Edit::SetLocal { page, name, local } => {
                let p = self.get(&page).ok_or_else(|| format!("there is no page {page}"))?;
                let Some(i) = &p.interface else {
                    return Err(format!("{} is a page, and only a component has variables of its own", p.name));
                };
                let component = p.name.clone();
                if let Some(new) = &local {
                    rules::INPUT.check(&new.name, "an input")?;
                    if list::taken(&i.variables, &new.name, &name) || i.inputs.iter().any(|x| x.name == new.name) {
                        return Err(format!("{component} already has {}", new.name));
                    }
                }
                let to = local.as_ref().map(|v| v.name.clone());
                let p = self.page_mut(&page)?;
                let variables = &mut p.interface.as_mut().expect("a component, checked above").variables;
                let old = list::put(variables, &name, local, || format!("{component} has no variable {name}"))?;
                if let (Some(_), Some(to)) = (&old, &to)
                    && *to != name
                {
                    each_mut(&mut p.children, &mut |e| rename_in(e, &name, to));
                }
                Edit::SetLocal { page: page.clone(), name: to.unwrap_or(name), local: old }
            }
            Edit::SetRule { id, mut rule } => {
                self.rules_changed = true;
                if let Some(rule) = &mut rule {
                    logic::check(rule)?;
                    rule.id = if id.is_empty() { self.free_rule_id() } else { id.clone() };
                }
                let made = rule.as_ref().map(|r| r.id.clone());
                let old = list::put(&mut self.rules, &id, rule, || format!("there is no handler {id}"))?;
                return Ok(Edit::SetRule { id: made.unwrap_or(id), rule: old });
            }
            Edit::Batch { .. } => unreachable!("taken above"),
        };
        let on_page!(page) = &undo else { unreachable!("the edits of no one page return early") };
        touched.push(page.clone());
        Ok(undo)
    }

    /// A component's name: PascalCase, as code and files name it, and its own. `own` is the
    /// component's id when it is renamed.
    fn component_name(&self, name: &str, own: Option<&str>) -> Result<String, String> {
        let name = name.trim();
        rules::COMPONENT.check(name, "a component")?;
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

    /// `base`, or it with a number, an id no page but `own` has.
    fn free_id(&self, base: &str, own: Option<&str>) -> String {
        let base = if base.is_empty() { "page" } else { base };
        let mut id = base.to_owned();
        let mut n = 2;
        while self.get(&id).is_some_and(|p| Some(p.id.as_str()) != own) {
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
        files::write(&self.root.join(folder).join(format!("{id}.html")), &format::write(page, &self.list))
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

/// Every element here and all they hold, each before what it holds.
fn all(elements: &[Element]) -> Box<dyn Iterator<Item = &Element> + '_> {
    Box::new(elements.iter().flat_map(|e| std::iter::once(e).chain(all(&e.children))))
}

/// Changes each element here and all they hold by `f`, each before what it holds. True when
/// `f` says any changed.
fn each_mut(elements: &mut [Element], f: &mut impl FnMut(&mut Element) -> bool) -> bool {
    elements.iter_mut().fold(false, |changed, e| f(e) | each_mut(&mut e.children, f) | changed)
}

/// Writes every use of the name `from` in an element's own values and handlers as `to`.
/// True when any changed.
fn rename_in(e: &mut Element, from: &str, to: &str) -> bool {
    let mut changed = false;
    for value in e.props.iter_mut().filter(|(k, _)| k.as_str() != "name").map(|(_, v)| v) {
        let renamed = js::rename(value, from, to);
        changed |= renamed != *value;
        *value = renamed;
    }
    for code in e.handlers.iter_mut().flat_map(|h| std::iter::once(&mut h.code).chain(h.attrs.values_mut())) {
        let renamed = js::rename(code, from, to);
        changed |= renamed != *code;
        *code = renamed;
    }
    changed
}

/// Moves each instance of `component`'s value for the input `from` to `to`, or drops it
/// where `to` is none. True when any changed.
fn instance_props(elements: &mut [Element], component: &str, from: &str, to: Option<&str>) -> bool {
    each_mut(elements, &mut |e| {
        if e.component.as_deref() != Some(component) {
            return false;
        }
        let Some(v) = e.props.remove(from) else { return false };
        if let Some(to) = to {
            e.props.insert(to.to_owned(), v);
        }
        true
    })
}

/// Renames the handlers of `component`'s instances for the event `from` to `to`, keeping
/// their order. True when any changed.
fn instance_events(elements: &mut [Element], component: &str, from: &str, to: &str) -> bool {
    each_mut(elements, &mut |e| {
        if e.component.as_deref() != Some(component) || !e.handlers.iter().any(|h| h.event == from) {
            return false;
        }
        e.handlers.iter_mut().filter(|h| h.event == from).for_each(|h| h.event = to.to_owned());
        e.handlers.sort_by(|a, b| rank(&a.event).cmp(&rank(&b.event)));
        true
    })
}

/// Writes the instances of the component `from` as `to`. True when any changed.
fn rename_uses(elements: &mut [Element], from: &str, to: &str) -> bool {
    each_mut(elements, &mut |e| {
        let hit = e.component.as_deref() == Some(from);
        if hit {
            e.component = Some(to.to_owned());
        }
        hit
    })
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
    all(elements).filter_map(|e| e.id.strip_prefix('e')?.parse().ok()).max().unwrap_or(0)
}

/// An element's tree from a screen: property names, no text holding elements, and ids new
/// to `ids`, which gains them.
fn check_tree(e: &Element, ids: &mut HashSet<String>) -> Result<(), String> {
    for e in all(std::slice::from_ref(e)) {
        check_props(e.props.keys())?;
        e.handlers.iter().enumerate().try_for_each(|(n, h)| check_handler(&e.handlers[..n], h))?;
        e.children.iter().try_for_each(|c| e.tag.holds(c.tag))?;
        if (e.tag == Tag::Use) != e.component.is_some() {
            return Err("an instance, and only an instance, names a component".into());
        }
        if !ids.insert(e.id.clone()) {
            return Err(format!("the id {} is already on the page", e.id));
        }
    }
    Ok(())
}

/// The list an element with `tag` goes into: the page's own, a frame's or a diagram's.
fn holder<'a>(page: &'a mut Page, parent: &Option<String>, tag: Tag) -> Result<&'a mut Vec<Element>, String> {
    let Some(parent) = parent else {
        return if tag.is_shape() { Err("a shape goes in a diagram".into()) } else { Ok(&mut page.children) };
    };
    let e = find_mut(&mut page.children, parent).ok_or_else(|| format!("{parent} is not on {}", page.id))?;
    e.tag.holds(tag)?;
    Ok(&mut e.children)
}

/// The holder elements share, None for the page, and where each sits in it.
type Shared = (Option<String>, Vec<(usize, String)>);

/// The holder elements share and where each sits in it, in the order given, each once. The
/// error says to pick elements that share one, to `what` them.
fn sharing(children: &[Element], page: &str, ids: &[String], what: &str) -> Result<Shared, String> {
    let mut holder = None;
    let mut order: Vec<(usize, String)> = Vec::new();
    for id in ids {
        let (h, at) = locate(children, id, None).ok_or_else(|| format!("{id} is not on {page}"))?;
        if order.iter().any(|(_, seen)| seen == id) {
            continue;
        }
        if !order.is_empty() && h != holder {
            return Err(format!("pick elements that sit in one frame to {what} them"));
        }
        holder = h;
        order.push((at, id.clone()));
    }
    if order.is_empty() {
        return Err(format!("pick something to {what}"));
    }
    Ok((holder, order))
}

/// The edits that put `element` in `holder` in front of the front most of `order`, and move
/// each of them into it in that order. It takes the next id, as AddElement gives it.
fn into_new(page: &str, children: &[Element], holder: Option<String>, order: &[(usize, String)], element: Element) -> Edit {
    let made = format!("e{}", highest(children) + 1);
    let front = order.iter().map(|(at, _)| *at).max().expect("one at least");
    let mut edits = vec![Edit::AddElement { page: page.to_owned(), parent: holder, index: Some(front + 1), element }];
    edits.extend(order.iter().enumerate().map(|(k, (_, id))| Edit::MoveElement { page: page.to_owned(), id: id.clone(), parent: Some(made.clone()), index: k }));
    Edit::Batch { edits }
}

/// Where an element sits: its frame, None for the page, and its index there.
fn locate(elements: &[Element], id: &str, parent: Option<&str>) -> Option<(Option<String>, usize)> {
    if let Some(at) = elements.iter().position(|e| e.id == id) {
        return Some((parent.map(str::to_owned), at));
    }
    elements.iter().find_map(|e| locate(&e.children, id, Some(&e.id)))
}

fn find<'a>(elements: &'a [Element], id: &str) -> Option<&'a Element> {
    all(elements).find(|e| e.id == id)
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
        assert_eq!(pages.apply(into_span).err().unwrap(), "only a frame, a group or a diagram holds other elements");
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
        pages.apply(Edit::SetHandler { page: o(), id: "e2".into(), event: "tap".into(), filter: None, code: Some("Speed = 1;".into()), attrs: None }).unwrap();
        let after = Some([("after".to_string(), Some("Speed * 100".to_string()))].into());
        pages.apply(Edit::SetHandler { page: o(), id: "e1".into(), event: "hold".into(), filter: None, code: Some("log(1);".into()), attrs: after }).unwrap();
        pages.apply(Edit::AddPage { name: "Other".into() }).unwrap();
        assert_eq!(pages.rename("Speed", "LineSpeed", false).unwrap(), ["overview"]);
        let again = Pages::open(&dir).unwrap();
        let e1 = &again.get("overview").unwrap().children[0];
        assert_eq!((e1.props["name"].as_str(), e1.props["x"].as_str()), ("Speed", "LineSpeed * 2"));
        assert_eq!(e1.children[0].props["text"], "\"Speed \" + LineSpeed");
        assert_eq!(e1.children[0].handlers[0].code, "LineSpeed = 1;");
        assert_eq!(e1.handlers[0].attrs["after"], "LineSpeed * 100");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_page_fill_follows_a_rename_and_a_component_has_none() {
        let dir = scratch("fill");
        let mut pages = Pages::open(&dir).unwrap();
        pages.apply(Edit::SetFill { page: "overview".into(), fill: "$ground".into() }).unwrap();
        assert_eq!(pages.rename("$ground", "$base", true).unwrap(), ["overview"]);
        assert_eq!(Pages::open(&dir).unwrap().get("overview").unwrap().fill, "$base");
        let gauge = pages.apply(Edit::AddComponent { name: "Gauge".into() }).unwrap().made.unwrap().1;
        assert_eq!(pages.apply(Edit::SetFill { page: gauge.clone(), fill: "#000".into() }).err().unwrap(), "Gauge draws on what holds it, so it has no fill");
        // a default and a start read the theme too, so they follow its renames
        let input = Some(Input { name: "tone".into(), default: "$base".into(), bindable: false });
        pages.apply(Edit::SetInput { page: gauge.clone(), name: "tone".into(), input }).unwrap();
        let local = Some(Local { name: "soft".into(), start: "$base.alpha(0.5)".into() });
        pages.apply(Edit::SetLocal { page: gauge.clone(), name: "soft".into(), local }).unwrap();
        assert_eq!(pages.rename("$base", "$floor", true).unwrap(), [gauge.as_str(), "overview"]);
        let i = Pages::open(&dir).unwrap().get(&gauge).unwrap().interface.clone().unwrap();
        assert_eq!((i.inputs[0].default.as_str(), i.variables[0].start.as_str()), ("$floor", "$floor.alpha(0.5)"));
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
            Edit::RenamePage { page: "line-two".into(), name: "Line 2".into(), id: None },
            Edit::ResizePage { page: "line-2".into(), width: 390, height: 844 },
            Edit::SetShows { page: "line-2".into(), shows: Shows::Over },
            Edit::SetFill { page: "line-2".into(), fill: "$ground".into() },
            Edit::CopyPage { page: "line-2".into(), name: "Line 3".into() },
            add(o(), None, Tag::Div, props(&[("x", "44"), ("background", "#222")])),
            add(o(), Some("e1".into()), Tag::Span, props(&[("text", "\"a\"")])),
            add(o(), None, Tag::Span, props(&[("text", "Speed")])),
            Edit::SetProps { page: o(), id: "e1".into(), props: [("x".to_string(), Some("88".to_string())), ("background".to_string(), None)].into() },
            Edit::MoveElement { page: o(), id: "e3".into(), parent: Some("e1".into()), index: 0 },
            Edit::SetHandler { page: o(), id: "e3".into(), event: "release".into(), filter: None, code: Some("  Speed = 1;\n  log(\"</on>\")".into()), attrs: None },
            Edit::SetHandler { page: o(), id: "e3".into(), event: "tap".into(), filter: None, code: Some("Speed = 2;".into()), attrs: None },
            Edit::SetHandler { page: o(), id: "e3".into(), event: "release".into(), filter: None, code: None, attrs: None },
            Edit::RemoveElement { page: o(), id: "e1".into() },
            Edit::Batch {
                edits: vec![
                    add(o(), None, Tag::Div, BTreeMap::new()),
                    Edit::SetProps { page: o(), id: "e1".into(), props: [("y".to_string(), Some("11".to_string()))].into() },
                ],
            },
            Edit::RemovePage { page: "line-2".into() },
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
        assert_eq!(pages.apply(Edit::AddElement { page: o(), parent: None, index: None, element: bad }).err().unwrap(), "only a frame, a group or a diagram holds other elements");
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

        // its id and file follow the name, and an undo kept from before follows the id
        let renamed = pages.apply(Edit::RenamePage { page: gauge.clone(), name: "Dial".into(), id: None }).unwrap();
        let dial = "dial".to_string();
        assert_eq!(renamed.pages, [card.clone(), dial.clone(), gauge.clone()]);
        assert_eq!(renamed.moved, [(gauge.clone(), dial.clone())]);
        assert!(dir.join("components").join("dial.html").exists() && !dir.join("components").join("gauge.html").exists());
        let mut kept = Edit::Batch { edits: vec![Edit::SetFill { page: gauge.clone(), fill: String::new() }, renamed.undo.clone()] };
        kept.repage(&gauge, &dial);
        let back = Edit::RenamePage { page: dial.clone(), name: "Gauge".into(), id: Some(gauge.clone()) };
        assert_eq!(kept, Edit::Batch { edits: vec![Edit::SetFill { page: dial.clone(), fill: String::new() }, back] });
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

        // what is no input is CSS on the instance's box, written as a frame's style is
        let id = pages.get("overview").unwrap().children[0].id.clone();
        pages.apply(Edit::SetProps { page: "overview".into(), id: id.clone(), props: [("opacity".to_string(), Some("0.5".to_string()))].into() }).unwrap();
        let file = fs::read_to_string(dir.join("pages").join("overview.html")).unwrap();
        assert!(file.contains(&format!("<Gauge id=\"{id}\" x=\"0\" value=\"Speed\" style=\"opacity: 0.5\"/>")), "{file}");
        assert_eq!(Pages::open(&dir).unwrap().get("overview").unwrap().children[0].props, pages.get("overview").unwrap().children[0].props);

        assert!(pages.apply(Edit::SetInput { page: gauge.clone(), name: "x".into(), input: input("x") }).unwrap_err().contains("keep clear"));
        assert!(pages.apply(Edit::SetInput { page: "overview".into(), name: "a".into(), input: input("a") }).unwrap_err().contains("only a component"));
        pages.apply(Edit::SetInput { page: gauge.clone(), name: "value".into(), input: None }).unwrap();
        assert!(!pages.get("overview").unwrap().children[0].props.contains_key("value"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_components_variables_rename_in_its_code_and_undo() {
        let dir = scratch("locals");
        let mut pages = Pages::open(&dir).unwrap();
        let menu = pages.apply(Edit::AddComponent { name: "Menu".into() }).unwrap().made.unwrap().1;
        let local = |name: &str| Some(Local { name: name.into(), start: "false".into() });
        pages.apply(Edit::SetLocal { page: menu.clone(), name: "open".into(), local: local("open") }).unwrap();
        pages.apply(add(menu.clone(), None, Tag::Div, props(&[("opacity", "open ? 1 : 0")]))).unwrap();
        let id = pages.get(&menu).unwrap().children[0].id.clone();
        pages.apply(Edit::SetHandler { page: menu.clone(), id, event: "tap".into(), filter: None, code: Some("open = !open;".into()), attrs: None }).unwrap();

        let undo = pages.apply(Edit::SetLocal { page: menu.clone(), name: "open".into(), local: local("shown") }).unwrap().undo;
        let e = &pages.get(&menu).unwrap().children[0];
        assert_eq!((e.props["opacity"].as_str(), e.handlers[0].code.as_str()), ("shown ? 1 : 0", "shown = !shown;"));
        assert_eq!(Pages::open(&dir).unwrap().get(&menu).unwrap().interface.as_ref().unwrap().variables, [local("shown").unwrap()]);
        pages.apply(undo).unwrap();
        assert_eq!(pages.get(&menu).unwrap().children[0].props["opacity"], "open ? 1 : 0");

        let input = Some(Input { name: "size".into(), default: "1".into(), bindable: false });
        pages.apply(Edit::SetInput { page: menu.clone(), name: "size".into(), input }).unwrap();
        assert!(pages.apply(Edit::SetLocal { page: menu.clone(), name: "size".into(), local: local("size") }).unwrap_err().contains("already has size"));
        assert!(pages.apply(Edit::SetLocal { page: "overview".into(), name: "a".into(), local: local("a") }).unwrap_err().contains("only a component"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn shapes_go_only_in_diagrams_and_diagrams_hold_only_shapes() {
        let dir = scratch("shapes");
        let mut pages = Pages::open(&dir).unwrap();
        let diagram = pages.apply(add("overview".into(), None, Tag::Svg, props(&[]))).unwrap().made.unwrap().1;
        let frame = pages.apply(add("overview".into(), None, Tag::Div, props(&[]))).unwrap().made.unwrap().1;
        let circle = pages.apply(add("overview".into(), Some(diagram.clone()), Tag::Circle, props(&[("r", "10")]))).unwrap().made.unwrap().1;
        assert_eq!(pages.apply(add("overview".into(), None, Tag::Circle, props(&[]))).unwrap_err(), "a shape goes in a diagram");
        assert_eq!(pages.apply(add("overview".into(), Some(frame.clone()), Tag::Rect, props(&[]))).unwrap_err(), "a shape goes in a diagram");
        assert_eq!(pages.apply(add("overview".into(), Some(diagram.clone()), Tag::Div, props(&[]))).unwrap_err(), "a diagram holds only shapes");
        let into_frame = Edit::MoveElement { page: "overview".into(), id: circle.clone(), parent: Some(frame), index: 0 };
        assert_eq!(pages.apply(into_frame).unwrap_err(), "a shape goes in a diagram");
        let group = pages.apply(add("overview".into(), Some(diagram.clone()), Tag::G, props(&[]))).unwrap().made.unwrap().1;
        pages.apply(Edit::MoveElement { page: "overview".into(), id: circle.clone(), parent: Some(group.clone()), index: 0 }).unwrap();
        let again = Pages::open(&dir).unwrap();
        assert_eq!(find(&again.get("overview").unwrap().children, &group).unwrap().children[0].id, circle);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn grouping_keeps_order_and_place_and_undoes_as_one() {
        let dir = scratch("group");
        let mut pages = Pages::open(&dir).unwrap();
        let o = || "overview".to_string();
        let ids: Vec<String> = (0..4).map(|_| pages.apply(add(o(), None, Tag::Div, props(&[]))).unwrap().made.unwrap().1).collect();
        let tops = |pages: &Pages| pages.get("overview").unwrap().children.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
        let before = tops(&pages);
        let grouped = pages.apply(Edit::Group { page: o(), ids: vec![ids[3].clone(), ids[1].clone()] }).unwrap();
        let group = grouped.made.clone().unwrap().1;
        let page = pages.get("overview").unwrap();
        assert_eq!(tops(&pages), vec![ids[0].clone(), ids[2].clone(), group.clone()]);
        assert_eq!(page.children[2].tag, Tag::Group);
        assert_eq!(page.children[2].children.iter().map(|e| e.id.clone()).collect::<Vec<_>>(), vec![ids[1].clone(), ids[3].clone()]);
        assert!(fs::read_to_string(dir.join("pages/overview.html")).unwrap().contains("<group id="));
        pages.apply(grouped.undo).unwrap();
        assert_eq!(tops(&pages), before);
        pages.apply(Edit::Group { page: o(), ids: vec![ids[1].clone(), ids[2].clone()] }).unwrap();
        let group = tops(&pages)[1].clone();
        let ungrouped = pages.apply(Edit::Ungroup { page: o(), id: group.clone() }).unwrap();
        assert_eq!(tops(&pages), before);
        pages.apply(ungrouped.undo).unwrap();
        assert_eq!(tops(&pages), vec![ids[0].clone(), group.clone(), ids[3].clone()]);
        let frame = pages.apply(add(o(), Some(group.clone()), Tag::Div, props(&[]))).unwrap().made.unwrap().1;
        assert_eq!(pages.apply(Edit::Group { page: o(), ids: vec![frame, ids[0].clone()] }).unwrap_err(), "pick elements that sit in one frame to group them");
        pages.apply(Edit::SetProps { page: o(), id: group.clone(), props: [("repeat".to_string(), Some("3".to_string()))].into() }).unwrap();
        assert_eq!(pages.apply(Edit::Ungroup { page: o(), id: group }).unwrap_err(), "the group sets repeat, which ungrouping would lose");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn wrapping_lays_out_in_the_order_given_and_undoes_as_one() {
        let dir = scratch("wrap");
        let mut pages = Pages::open(&dir).unwrap();
        let o = || "overview".to_string();
        let ids: Vec<String> = (0..3).map(|_| pages.apply(add(o(), None, Tag::Div, props(&[]))).unwrap().made.unwrap().1).collect();
        let tops = |pages: &Pages| pages.get("overview").unwrap().children.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
        let before = tops(&pages);
        let wrap = Edit::Wrap { page: o(), ids: vec![ids[2].clone(), ids[0].clone()], props: [("layout".to_string(), "\"right\"".to_string())].into() };
        let wrapped = pages.apply(wrap).unwrap();
        let frame = wrapped.made.clone().unwrap().1;
        let page = pages.get("overview").unwrap();
        assert_eq!(tops(&pages), vec![ids[1].clone(), frame.clone()]);
        assert_eq!(page.children[1].tag, Tag::Div);
        assert_eq!(page.children[1].props.get("layout").map(String::as_str), Some("\"right\""));
        assert_eq!(page.children[1].children.iter().map(|e| e.id.clone()).collect::<Vec<_>>(), vec![ids[2].clone(), ids[0].clone()]);
        pages.apply(wrapped.undo).unwrap();
        assert_eq!(tops(&pages), before);
        let diagram = pages.apply(add(o(), None, Tag::Svg, props(&[]))).unwrap().made.unwrap().1;
        let line = pages.apply(add(o(), Some(diagram), Tag::Line, props(&[]))).unwrap().made.unwrap().1;
        assert_eq!(pages.apply(Edit::Wrap { page: o(), ids: vec![line], props: BTreeMap::new() }).unwrap_err(), "a frame holds elements, and shapes stay in their diagram");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_hold_keeps_its_time_through_code_changes_and_undo() {
        let dir = scratch("hold");
        let mut pages = Pages::open(&dir).unwrap();
        pages.apply(add("overview".into(), None, Tag::Div, props(&[]))).unwrap();
        let id = pages.get("overview").unwrap().children[0].id.clone();
        let set = |code: Option<&str>, after: Option<Option<&str>>| {
            let attrs = after.map(|a| [("after".to_string(), a.map(Into::into))].into());
            Edit::SetHandler { page: "overview".into(), id: id.clone(), event: "hold".into(), filter: None, code: code.map(Into::into), attrs }
        };
        let h = |pages: &Pages| pages.get("overview").unwrap().children[0].handlers.first().map(|h| (h.code.clone(), h.attrs.get("after").cloned()));
        pages.apply(set(Some("log(1);"), Some(Some("800")))).unwrap();
        let undo = pages.apply(set(Some("log(2);"), None)).unwrap().undo;
        assert_eq!(h(&pages), Some(("log(2);".into(), Some("800".into()))));
        pages.apply(undo).unwrap();
        assert_eq!(h(&pages), Some(("log(1);".into(), Some("800".into()))));
        // emptied it is the default, and a removal undone brings the time back
        let undo = pages.apply(set(Some("log(1);"), Some(Some(" ")))).unwrap().undo;
        assert_eq!(h(&pages), Some(("log(1);".into(), None)));
        pages.apply(undo).unwrap();
        let undo = pages.apply(set(None, None)).unwrap().undo;
        assert_eq!(h(&pages), None);
        pages.apply(undo).unwrap();
        assert_eq!(h(&pages), Some(("log(1);".into(), Some("800".into()))));
        let tap = |key: &str| Edit::SetHandler { page: "overview".into(), id: id.clone(), event: "tap".into(), filter: None, code: Some("log(1);".into()), attrs: Some([(key.to_string(), Some("1".to_string()))].into()) };
        assert_eq!(pages.apply(tap("after")).err().unwrap(), "a tap handler takes no after");
        pages.apply(tap("while")).unwrap();
        let release = Edit::SetHandler { page: "overview".into(), id: id.clone(), event: "release".into(), filter: None, code: Some("log(1);".into()), attrs: Some([("while".to_string(), Some("1".to_string()))].into()) };
        assert_eq!(pages.apply(release).err().unwrap(), "a release handler takes no while");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_element_holds_one_handler_per_event_and_filter() {
        let dir = scratch("filters");
        let mut pages = Pages::open(&dir).unwrap();
        pages.apply(add("overview".into(), None, Tag::Div, props(&[]))).unwrap();
        let id = pages.get("overview").unwrap().children[0].id.clone();
        let key = |k: &str| -> BTreeMap<String, String> { [("key".to_string(), k.to_string())].into() };
        let set = |filter: Option<BTreeMap<String, String>>, code: &str, attrs: &[(&str, &str)]| Edit::SetHandler {
            page: "overview".into(),
            id: id.clone(),
            event: "keydown".into(),
            filter,
            code: Some(code.into()),
            attrs: Some(attrs.iter().map(|(k, v)| (k.to_string(), Some(v.to_string()))).collect()),
        };
        let keys = |pages: &Pages| pages.get("overview").unwrap().children[0].handlers.iter().map(|h| (h.filter.get("key").cloned().unwrap_or_default(), h.code.clone())).collect::<Vec<_>>();
        // a filter is written as it is, Space too, and an expression trimmed
        pages.apply(set(None, "log(1);", &[("key", " "), ("while", " armed ")])).unwrap();
        pages.apply(set(None, "log(2);", &[])).unwrap();
        assert_eq!(keys(&pages), vec![(" ".into(), "log(1);".into()), ("".into(), "log(2);".into())]);
        assert_eq!(pages.get("overview").unwrap().children[0].handlers[0].attrs["while"], "armed");
        assert_eq!(pages.apply(set(None, "log(3);", &[("key", " ")])).unwrap_err(), "a second keydown handler for key \" \"");
        assert_eq!(pages.apply(set(None, "log(3);", &[("shift", "true")])).unwrap_err(), "a keydown handler takes no shift");
        // a new filter keeps the handler's place, and its undo names it
        let undo = pages.apply(set(Some(key(" ")), "log(1);", &[("key", "a")])).unwrap().undo;
        assert_eq!(keys(&pages)[0], ("a".into(), "log(1);".into()));
        pages.apply(undo).unwrap();
        assert_eq!(keys(&pages)[0], (" ".into(), "log(1);".into()));
        let again = Pages::open(&dir).unwrap();
        assert_eq!(again.get("overview").unwrap().children[0].handlers, pages.get("overview").unwrap().children[0].handlers);
        // the handlers an event takes, by what it brought
        let hs = &pages.get("overview").unwrap().children[0].handlers;
        let p = |k: &str| Value::map([("key", Value::Text(k.into())), ("code", Value::Text("Space".into()))]);
        assert_eq!(hs.iter().map(|h| (h.takes("keydown", &p(" ")), h.takes("keydown", &p("b")), h.takes("keyup", &p(" ")))).collect::<Vec<_>>(), vec![(true, false, false), (true, true, false)]);
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
        pages.apply(Edit::SetHandler { page: "overview".into(), id: id.clone(), event: "change".into(), filter: None, code: Some("Running = p;".into()), attrs: None }).unwrap();
        pages.apply(Edit::SetHandler { page: "overview".into(), id: id.clone(), event: "tap".into(), filter: None, code: Some("log(1);".into()), attrs: None }).unwrap();
        let undo = pages.apply(event("change", Some("flip"))).unwrap().undo;
        let events: Vec<_> = pages.get("overview").unwrap().children[0].handlers.iter().map(|h| h.event.as_str()).collect();
        assert_eq!(events, ["tap", "flip"]);
        assert!(fs::read_to_string(dir.join("components/toggle.html")).unwrap().contains("<event name=\"flip\"/>"));
        pages.apply(undo).unwrap();
        assert_eq!(pages.get(&toggle).unwrap().interface.as_ref().unwrap().events, ["change"]);
        assert_eq!(pages.apply(event("nope", None)).err().unwrap(), "Toggle sends no nope");
        assert!(pages.apply(Edit::SetHandler { page: "overview".into(), id, event: "On Off".into(), filter: None, code: None, attrs: None }).is_err());
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

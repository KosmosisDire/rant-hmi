//! The project's pages, one HTML like file each in `pages/`, and the edits that change them.
//! Every edit goes through the backend, which saves the file and sends the page to every
//! screen, so all of them show the same page.

pub mod format;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A page: an artboard of `width` by `height` pixels holding elements.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Page {
    /// The file's name without `.html`, stable while the page lives.
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub children: Vec<Element>,
}

/// One element. `props` holds its name, its placement (`x`, `y`, `w`, `h`), a span's `text`
/// and any CSS property. Every one but the name is an expression.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Element {
    pub id: String,
    pub tag: Tag,
    pub props: BTreeMap<String, String>,
    /// At most one per event, in the order events are listed.
    pub handlers: Vec<Handler>,
    pub children: Vec<Element>,
}

/// Code the backend runs when its event happens on the element.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Handler {
    pub event: Event,
    pub code: String,
}

/// What a pointer does to an element: goes down on it, comes up, or both without straying.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Event {
    Tap,
    Press,
    Release,
}

impl Event {
    pub const ALL: [Event; 3] = [Event::Tap, Event::Press, Event::Release];

    pub fn word(self) -> &'static str {
        match self {
            Event::Tap => "tap",
            Event::Press => "press",
            Event::Release => "release",
        }
    }
}

/// What an element renders as. A frame is a div, a text a span.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Tag {
    Div,
    Span,
}

impl Tag {
    pub fn word(self) -> &'static str {
        match self {
            Tag::Div => "div",
            Tag::Span => "span",
        }
    }

    pub fn from_word(word: &str) -> Option<Tag> {
        match word {
            "div" => Some(Tag::Div),
            "span" => Some(Tag::Span),
            _ => None,
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
    RenamePage { page: String, name: String },
    ResizePage { page: String, width: u32, height: u32 },
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
    SetHandler { page: String, id: String, event: Event, code: Option<String> },
    /// Several edits as one: all apply or none do, and one undo takes them all back.
    Batch { edits: Vec<Edit> },
}

/// What an edit changed: the pages to send out, what it made, if anything, as a page and an
/// id (a page's own for a page), and the edit that undoes it.
pub struct Applied {
    pub pages: Vec<String>,
    pub made: Option<(String, String)>,
    pub undo: Edit,
}

pub struct Pages {
    dir: PathBuf,
    /// In id order, as the files list.
    pub list: Vec<Page>,
}

const WIDTH: u32 = 1408;
const HEIGHT: u32 = 792;
/// The largest side a page may have, in pixels.
const LARGEST: u32 = 16384;

impl Pages {
    /// Reads every page in `pages/`, starting one called Overview when there is none.
    pub fn open(root: &Path) -> Result<Pages> {
        let dir = root.join("pages");
        let mut files: Vec<PathBuf> = match fs::read_dir(&dir) {
            Ok(entries) => entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "html")).collect(),
            Err(_) => Vec::new(),
        };
        files.sort();
        let mut list = Vec::new();
        for file in files {
            let id = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let text = fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?;
            list.push(format::parse(&text, &id).map_err(|e| anyhow::anyhow!("{}, {e}", file.display()))?);
        }
        let mut pages = Pages { dir, list };
        if pages.list.is_empty() {
            pages.apply(Edit::AddPage { name: "Overview".into() }).map_err(anyhow::Error::msg)?;
        }
        Ok(pages)
    }

    pub fn get(&self, id: &str) -> Option<&Page> {
        self.list.iter().find(|p| p.id == id)
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
        Ok(Applied { pages, made, undo })
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
                self.insert_page(Page { id: id.clone(), name, width: WIDTH, height: HEIGHT, children: Vec::new() });
                *made = Some((id.clone(), id.clone()));
                touched.push(id.clone());
                return Ok(Edit::RemovePage { page: id });
            }
            Edit::RenamePage { page, name } => {
                let old = std::mem::replace(&mut self.page_mut(&page)?.name, named(&name)?);
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
            Edit::RemovePage { page } => {
                if self.list.len() == 1 {
                    return Err("a project keeps at least one page".into());
                }
                let at = self.list.iter().position(|p| p.id == page).ok_or_else(|| format!("there is no page {page}"))?;
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
                let id = page.id.clone();
                self.insert_page(page);
                *made = Some((id.clone(), id.clone()));
                touched.push(id.clone());
                return Ok(Edit::RemovePage { page: id });
            }
            Edit::AddElement { page, parent, index, mut element } => {
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
                let p = self.page_mut(&page)?;
                let e = find_mut(&mut p.children, &id).ok_or_else(|| format!("{id} is not on {page}"))?;
                let at = e.handlers.partition_point(|h| h.event < event);
                let old = e.handlers.get(at).filter(|h| h.event == event).map(|h| h.code.clone());
                if old.is_some() {
                    e.handlers.remove(at);
                }
                if let Some(code) = code {
                    e.handlers.insert(at, Handler { event, code: format::dedent(&code) });
                }
                Edit::SetHandler { page: page.clone(), id, event, code: old }
            }
            Edit::Batch { .. } => unreachable!("taken above"),
        };
        let page = match &undo {
            Edit::RenamePage { page, .. } | Edit::ResizePage { page, .. } | Edit::RemoveElement { page, .. } => page,
            Edit::PutElement { page, .. } | Edit::MoveElement { page, .. } | Edit::SetProps { page, .. } | Edit::SetHandler { page, .. } => page,
            _ => unreachable!("page edits return early"),
        };
        touched.push(page.clone());
        Ok(undo)
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

    /// Writes beside the file and renames over it, so a crash never leaves half a page. A
    /// page that is gone loses its file.
    fn save(&self, id: &str) -> Result<(), String> {
        let file = self.dir.join(format!("{id}.html"));
        let Some(page) = self.get(id) else {
            return match fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("could not remove {}: {e}", file.display())),
                _ => Ok(()),
            };
        };
        let partial = self.dir.join(format!("{id}.html.partial"));
        fs::create_dir_all(&self.dir)
            .and_then(|_| fs::write(&partial, format::write(page)))
            .and_then(|_| fs::rename(&partial, &file))
            .map_err(|e| format!("could not save {}: {e}", file.display()))
    }
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

/// A property is a CSS name or one of ours: lower case, digits and hyphens.
fn check_props<'a>(keys: impl Iterator<Item = &'a String>) -> Result<(), String> {
    for key in keys {
        let ok = key.starts_with(|c: char| c.is_ascii_lowercase()) && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
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
        Edit::AddElement { page, parent, index: None, element: Element { id: String::new(), tag, props, handlers: Vec::new(), children: Vec::new() } }
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
            add(o(), None, Tag::Div, props(&[("x", "44"), ("background", "#222")])),
            add(o(), Some("e1".into()), Tag::Span, props(&[("text", "\"a\"")])),
            add(o(), None, Tag::Span, props(&[("text", "Speed")])),
            Edit::SetProps { page: o(), id: "e1".into(), props: [("x".to_string(), Some("88".to_string())), ("background".to_string(), None)].into() },
            Edit::MoveElement { page: o(), id: "e3".into(), parent: Some("e1".into()), index: 0 },
            Edit::SetHandler { page: o(), id: "e3".into(), event: Event::Release, code: Some("  Speed = 1;\n  log(\"</on>\")".into()) },
            Edit::SetHandler { page: o(), id: "e3".into(), event: Event::Tap, code: Some("Speed = 2;".into()) },
            Edit::SetHandler { page: o(), id: "e3".into(), event: Event::Release, code: None },
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
        let leaf = |id: &str, tag| Element { id: id.into(), tag, props: BTreeMap::new(), handlers: Vec::new(), children: Vec::new() };
        let copy = Element { id: "e1".into(), tag: Tag::Div, props: props(&[("x", "11")]), handlers: Vec::new(), children: vec![leaf("e2", Tag::Span), leaf("x", Tag::Div)] };
        let made = pages.apply(Edit::AddElement { page: o(), parent: None, index: Some(1), element: copy }).unwrap().made.unwrap().1;
        assert_eq!(made, "e3");
        let ids: Vec<_> = pages.list[0].children.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["e1", "e3", "e2"]);
        let kids: Vec<_> = pages.list[0].children[1].children.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(kids, ["e4", "e5"]);
        let bad = Element { id: String::new(), tag: Tag::Span, props: BTreeMap::new(), handlers: Vec::new(), children: vec![leaf("", Tag::Span)] };
        assert_eq!(pages.apply(Edit::AddElement { page: o(), parent: None, index: None, element: bad }).err().unwrap(), "only a frame holds other elements");
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

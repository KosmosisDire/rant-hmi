//! The project's pages, one HTML like file each in `pages/`, and the edits that change them.
//! Every edit goes through the backend, which saves the file and sends the page to every
//! screen, so all of them show the same page.

pub mod format;

use std::collections::BTreeMap;
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
/// and any CSS property, each a literal or a `{expression}`.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Element {
    pub id: String,
    pub tag: Tag,
    pub props: BTreeMap<String, String>,
    pub children: Vec<Element>,
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

/// A change to the pages, sent by a screen.
#[derive(Deserialize, TS, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum Edit {
    AddPage { name: String },
    RenamePage { page: String, name: String },
    /// Adds an element at the end of `parent`, a div, or of the page when there is none.
    AddElement { page: String, parent: Option<String>, tag: Tag, props: BTreeMap<String, String> },
    RemoveElement { page: String, id: String },
    /// Sets each property to its value, or removes it where the value is null.
    SetProps { page: String, id: String, props: BTreeMap<String, Option<String>> },
}

/// What an edit changed: the page to send out, and what it made, if anything.
pub struct Applied {
    pub page: String,
    pub made: Option<String>,
}

pub struct Pages {
    dir: PathBuf,
    pub list: Vec<Page>,
}

const WIDTH: u32 = 1408;
const HEIGHT: u32 = 792;

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

    /// Applies an edit and saves the page. The error is for the user.
    pub fn apply(&mut self, edit: Edit) -> Result<Applied, String> {
        let applied = match edit {
            Edit::AddPage { name } => {
                let name = name.trim().to_owned();
                if name.is_empty() {
                    return Err("a page needs a name".into());
                }
                let id = self.free_id(&slug(&name));
                self.list.push(Page { id: id.clone(), name, width: WIDTH, height: HEIGHT, children: Vec::new() });
                Applied { page: id.clone(), made: Some(id) }
            }
            Edit::RenamePage { page, name } => {
                let name = name.trim().to_owned();
                if name.is_empty() {
                    return Err("a page needs a name".into());
                }
                self.page_mut(&page)?.name = name;
                Applied { page, made: None }
            }
            Edit::AddElement { page, parent, tag, props } => {
                check_props(props.keys())?;
                let p = self.page_mut(&page)?;
                let id = next_id(&p.children);
                let element = Element { id: id.clone(), tag, props, children: Vec::new() };
                match parent {
                    None => p.children.push(element),
                    Some(parent) => {
                        let holder = find_mut(&mut p.children, &parent).ok_or_else(|| format!("{parent} is not on {page}"))?;
                        if holder.tag != Tag::Div {
                            return Err("only a frame holds other elements".into());
                        }
                        holder.children.push(element);
                    }
                }
                Applied { page, made: Some(id) }
            }
            Edit::RemoveElement { page, id } => {
                let p = self.page_mut(&page)?;
                if !remove(&mut p.children, &id) {
                    return Err(format!("{id} is not on {page}"));
                }
                Applied { page, made: None }
            }
            Edit::SetProps { page, id, props } => {
                check_props(props.keys())?;
                let p = self.page_mut(&page)?;
                let e = find_mut(&mut p.children, &id).ok_or_else(|| format!("{id} is not on {page}"))?;
                for (key, value) in props {
                    match value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
                        Some(v) => e.props.insert(key, v),
                        None => e.props.remove(&key),
                    };
                }
                Applied { page, made: None }
            }
        };
        self.save(&applied.page)?;
        Ok(applied)
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

    /// Writes beside the file and renames over it, so a crash never leaves half a page.
    fn save(&self, id: &str) -> Result<(), String> {
        let page = self.get(id).ok_or_else(|| format!("there is no page {id}"))?;
        let file = self.dir.join(format!("{id}.html"));
        let partial = self.dir.join(format!("{id}.html.partial"));
        fs::create_dir_all(&self.dir)
            .and_then(|_| fs::write(&partial, format::write(page)))
            .and_then(|_| fs::rename(&partial, &file))
            .map_err(|e| format!("could not save {}: {e}", file.display()))
    }
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

/// `e` and one more than the highest number any id on the page has, so ids are never reused
/// while the page holds the higher one.
fn next_id(elements: &[Element]) -> String {
    fn highest(elements: &[Element]) -> u32 {
        elements.iter().map(|e| e.id.strip_prefix('e').and_then(|n| n.parse().ok()).unwrap_or(0).max(highest(&e.children))).max().unwrap_or(0)
    }
    format!("e{}", highest(elements) + 1)
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

fn remove(elements: &mut Vec<Element>, id: &str) -> bool {
    if let Some(at) = elements.iter().position(|e| e.id == id) {
        elements.remove(at);
        return true;
    }
    elements.iter_mut().any(|e| remove(&mut e.children, id))
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

    #[test]
    fn a_new_project_gets_an_overview_and_edits_survive_a_reopen() {
        let dir = scratch("reopen");
        let mut pages = Pages::open(&dir).unwrap();
        assert_eq!(pages.list[0].id, "overview");
        let frame = pages
            .apply(Edit::AddElement { page: "overview".into(), parent: None, tag: Tag::Div, props: props(&[("x", "44"), ("background", "#222")]) })
            .unwrap()
            .made
            .unwrap();
        let text = pages
            .apply(Edit::AddElement { page: "overview".into(), parent: Some(frame.clone()), tag: Tag::Span, props: props(&[("text", "Speed")]) })
            .unwrap()
            .made
            .unwrap();
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
        let span = pages.apply(Edit::AddElement { page: "overview".into(), parent: None, tag: Tag::Span, props: BTreeMap::new() }).unwrap().made.unwrap();
        let into_span = Edit::AddElement { page: "overview".into(), parent: Some(span), tag: Tag::Div, props: BTreeMap::new() };
        assert_eq!(pages.apply(into_span).err().unwrap(), "only a frame holds other elements");
        let bad = Edit::AddElement { page: "overview".into(), parent: None, tag: Tag::Div, props: props(&[("Background", "red")]) };
        assert_eq!(pages.apply(bad).err().unwrap(), "\"Background\" is not a property name");
        assert!(pages.apply(Edit::RemoveElement { page: "overview".into(), id: "e9".into() }).is_err());
        assert_eq!(pages.apply(Edit::AddPage { name: "Overview".into() }).unwrap().made.unwrap(), "overview2");
        fs::remove_dir_all(&dir).unwrap();
    }
}

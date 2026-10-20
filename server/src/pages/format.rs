//! A page as an HTML like file. Elements are written as the HTML they render as, a frame a
//! `div` and a text a `span`. `name`, `x`, `y`, `w` and `h` are attributes, a span's text is
//! its body, every other property goes in `style`. A value in `{ }` is an expression, read
//! raw, so `{a < b && c}` needs no escaping.
//!
//! ```html
//! <page name="Overview" size="1408x792">
//!   <div id="e1" name="Speed card" x="44" y="44" w="264" h="132" style="background: #1e2125">
//!     <span id="e2" x="22" y="22" w="220" h="44" style="font-size: 32px">{Speed.toFixed(2)}</span>
//!   </div>
//! </page>
//! ```

use std::collections::{BTreeMap, HashSet};

use super::{Element, Page, Tag};

/// The properties written as attributes, in this order. The rest go in `style`.
const ATTRS: [&str; 5] = ["name", "x", "y", "w", "h"];
const TEXT: &str = "text";

pub fn is_expression(value: &str) -> bool {
    let v = value.trim();
    v.starts_with('{') && v.ends_with('}')
}

// ------------------------------------------------------------------------------ writing

pub fn write(page: &Page) -> String {
    let mut out = format!("<page name={} size=\"{}x{}\">\n", quote(&page.name), page.width, page.height);
    for e in &page.children {
        element(&mut out, e, 1);
    }
    out.push_str("</page>\n");
    out
}

fn element(out: &mut String, e: &Element, depth: usize) {
    let tag = e.tag.word();
    out.push_str(&"  ".repeat(depth));
    out.push_str(&format!("<{tag} id={}", quote(&e.id)));
    for key in ATTRS {
        if let Some(v) = e.props.get(key) {
            out.push_str(&format!(" {key}={}", quote(v)));
        }
    }
    let style: Vec<String> = e
        .props
        .iter()
        .filter(|(k, _)| !ATTRS.contains(&k.as_str()) && k.as_str() != TEXT)
        .map(|(k, v)| format!("{k}: {v}"))
        .collect();
    if !style.is_empty() {
        out.push_str(&format!(" style={}", quote(&style.join("; "))));
    }
    match (e.tag, e.props.get(TEXT)) {
        (Tag::Span, Some(text)) => {
            let body = if is_expression(text) { text.clone() } else { escape(text) };
            out.push_str(&format!(">{body}</span>\n"));
        }
        _ if e.children.is_empty() => out.push_str("/>\n"),
        _ => {
            out.push_str(">\n");
            for child in &e.children {
                element(out, child, depth + 1);
            }
            out.push_str(&"  ".repeat(depth));
            out.push_str(&format!("</{tag}>\n"));
        }
    }
}

/// Double quotes, or single ones when the value holds a double quote, so an expression
/// with strings stays readable. Only a value holding both escapes.
fn quote(v: &str) -> String {
    if !v.contains('"') {
        format!("\"{v}\"")
    } else if !v.contains('\'') {
        format!("'{v}'")
    } else {
        format!("\"{}\"", v.replace('"', "&quot;"))
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

// ------------------------------------------------------------------------------ reading

/// A page from its file text. The error names the line.
pub fn parse(text: &str, id: &str) -> Result<Page, String> {
    let mut r = Reader { s: text, at: 0, ids: HashSet::new() };
    r.gap();
    r.expect("<page")?;
    let attrs = r.attrs()?;
    r.expect(">")?;
    let mut page = Page { id: id.to_owned(), name: id.to_owned(), width: 1408, height: 792, children: Vec::new() };
    for (k, v) in attrs {
        match k.as_str() {
            "name" => page.name = v,
            "size" => {
                let (w, h) = v.split_once('x').ok_or_else(|| r.error("size is written WxH, like 1408x792"))?;
                page.width = w.trim().parse().map_err(|_| r.error("size is written WxH, like 1408x792"))?;
                page.height = h.trim().parse().map_err(|_| r.error("size is written WxH, like 1408x792"))?;
            }
            other => return Err(r.error(&format!("<page> takes no attribute {other}"))),
        }
    }
    page.children = r.children("page")?;
    r.gap();
    if r.at < r.s.len() {
        return Err(r.error("nothing may follow </page>"));
    }
    Ok(page)
}

struct Reader<'a> {
    s: &'a str,
    at: usize,
    ids: HashSet<String>,
}

impl Reader<'_> {
    fn rest(&self) -> &str {
        &self.s[self.at..]
    }

    fn error(&self, what: &str) -> String {
        let line = self.s[..self.at].matches('\n').count() + 1;
        format!("line {line}: {what}")
    }

    /// Skips white space and comments.
    fn gap(&mut self) {
        let s = self.s;
        loop {
            let trimmed = s[self.at..].trim_start();
            self.at = s.len() - trimmed.len();
            if !trimmed.starts_with("<!--") {
                return;
            }
            match trimmed.find("-->") {
                Some(end) => self.at += end + 3,
                None => self.at = self.s.len(),
            }
        }
    }

    fn eat(&mut self, lit: &str) -> bool {
        let found = self.rest().starts_with(lit);
        if found {
            self.at += lit.len();
        }
        found
    }

    fn expect(&mut self, lit: &str) -> Result<(), String> {
        if self.eat(lit) { Ok(()) } else { Err(self.error(&format!("expected {lit}"))) }
    }

    fn word(&mut self) -> Result<String, String> {
        let n = self.rest().find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).unwrap_or(self.rest().len());
        if n == 0 {
            return Err(self.error("expected a name"));
        }
        let w = self.rest()[..n].to_owned();
        self.at += n;
        Ok(w)
    }

    /// Attributes up to the closing `>` or `/>`, which stays unread.
    fn attrs(&mut self) -> Result<Vec<(String, String)>, String> {
        let mut out = Vec::new();
        loop {
            self.gap();
            if self.rest().starts_with('>') || self.rest().starts_with("/>") {
                return Ok(out);
            }
            let key = self.word()?;
            self.expect("=")?;
            out.push((key, self.quoted()?));
        }
    }

    fn quoted(&mut self) -> Result<String, String> {
        let q = self.rest().chars().next().filter(|c| *c == '"' || *c == '\'').ok_or_else(|| self.error("expected a quoted value"))?;
        self.at += 1;
        let end = self.rest().find(q).ok_or_else(|| self.error("a value never closes its quote"))?;
        let v = self.rest()[..end].replace("&quot;", "\"");
        self.at += end + 1;
        Ok(v)
    }

    /// Elements until `</closing>`.
    fn children(&mut self, closing: &str) -> Result<Vec<Element>, String> {
        let mut out = Vec::new();
        loop {
            self.gap();
            if self.eat(&format!("</{closing}>")) {
                return Ok(out);
            }
            if self.at >= self.s.len() {
                return Err(self.error(&format!("<{closing}> never closes")));
            }
            if !self.rest().starts_with('<') {
                return Err(self.error("text goes in a span"));
            }
            out.push(self.element()?);
        }
    }

    fn element(&mut self) -> Result<Element, String> {
        self.expect("<")?;
        let word = self.word()?;
        let tag = Tag::from_word(&word).ok_or_else(|| self.error(&format!("<{word}> is not an element a page holds yet")))?;
        let mut id = None;
        let mut props = BTreeMap::new();
        for (k, v) in self.attrs()? {
            match k.as_str() {
                "id" => id = Some(v),
                "style" => {
                    for decl in split_outside(&v, ';') {
                        let (key, value) = decl.split_once(':').ok_or_else(|| self.error(&format!("\"{decl}\" in style needs a colon")))?;
                        props.insert(key.trim().to_owned(), value.trim().to_owned());
                    }
                }
                k if ATTRS.contains(&k) => {
                    props.insert(k.to_owned(), v);
                }
                other => return Err(self.error(&format!("<{word}> takes no attribute {other}"))),
            }
        }
        let id = id.ok_or_else(|| self.error(&format!("<{word}> needs an id")))?;
        if !self.ids.insert(id.clone()) {
            return Err(self.error(&format!("the id {id} is used twice")));
        }
        let mut children = Vec::new();
        if !self.eat("/>") {
            self.expect(">")?;
            match tag {
                Tag::Div => children = self.children("div")?,
                Tag::Span => {
                    let text = self.body()?;
                    if !text.is_empty() {
                        props.insert(TEXT.to_owned(), text);
                    }
                    self.expect("</span>")?;
                }
            }
        }
        Ok(Element { id, tag, props, children })
    }

    /// A span's text: one `{expression}` filling the whole body, read raw, else literal text
    /// up to the closing tag, such as `{a} b`.
    fn body(&mut self) -> Result<String, String> {
        if let Some(n) = braced(self.rest()).filter(|n| self.rest()[*n..].starts_with("</span>")) {
            let expr = self.rest()[..n].to_owned();
            self.at += n;
            return Ok(expr);
        }
        let n = self.rest().find('<').ok_or_else(|| self.error("<span> never closes"))?;
        let text = unescape(&self.rest()[..n]);
        self.at += n;
        Ok(text)
    }
}

/// The length of the `{...}` at the start of `s`, counting nested braces and skipping JS
/// strings and template literals, or None when it never closes.
fn braced(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            q @ (b'"' | b'\'' | b'`') => i = string_end(b, i, q)?,
            _ => {}
        }
        i += 1;
    }
    None
}

/// The index of the quote closing the string opened at `start`. A template literal's `${ }`
/// is skipped as an expression of its own.
fn string_end(b: &[u8], start: usize, q: u8) -> Option<usize> {
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 1,
            b'$' if q == b'`' && b.get(i + 1) == Some(&b'{') => {
                i += braced(std::str::from_utf8(&b[i + 1..]).ok()?)?;
            }
            c if c == q => return Some(i),
            _ => {}
        }
        i += 1;
    }
    None
}

/// Splits on `sep` where it is not inside braces or quotes, dropping empty parts.
fn split_outside(s: &str, sep: char) -> Vec<String> {
    let b = s.as_bytes();
    let mut parts = Vec::new();
    let mut from = 0;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'{' => {
                if let Some(n) = braced(&s[i..]) {
                    i += n - 1;
                }
            }
            q @ (b'"' | b'\'') => i = string_end(b, i, q).unwrap_or(b.len()),
            c if c as char == sep => {
                parts.push(s[from..i].to_owned());
                from = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(s[from.min(s.len())..].to_owned());
    parts.into_iter().map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<page name="Overview" size="1408x792">
  <div id="e1" name="Speed card" x="44" y="44" w="264" h="132" style="background: #1e2125; border-radius: 12px">
    <span id="e2" name="Speed" x="22" y="22" w="220" h="44" style="color: {Speed > 1 && Running ? 'red' : '#e4e6e8'}; font-size: 32px">{Speed < 1 ? "slow" : `fast ${Speed}`}</span>
    <span id="e3" x="22" y="88" w="220" h="22">Belt &lt;1&gt; &amp; rollers</span>
  </div>
  <div id="e4" x="0" y="0" w="44" h="44"/>
</page>
"#;

    #[test]
    fn a_page_reads_and_writes_back_the_same() {
        let page = parse(PAGE, "overview").unwrap();
        assert_eq!(page.name, "Overview");
        let speed = &page.children[0].children[0];
        assert_eq!(speed.props["text"], "{Speed < 1 ? \"slow\" : `fast ${Speed}`}");
        assert_eq!(speed.props["color"], "{Speed > 1 && Running ? 'red' : '#e4e6e8'}");
        assert_eq!(page.children[0].children[1].props["text"], "Belt <1> & rollers");
        assert_eq!(write(&page), PAGE);
    }

    #[test]
    fn a_value_with_double_quotes_is_written_in_single_ones() {
        let mut page = parse(PAGE, "overview").unwrap();
        page.children[1].props.insert("name".into(), "{Mode == \"Auto\" ? \"A\" : \"M\"}".into());
        let text = write(&page);
        assert!(text.contains("name='{Mode == \"Auto\" ? \"A\" : \"M\"}'"));
        assert_eq!(parse(&text, "overview").unwrap(), page);
    }

    #[test]
    fn text_that_only_starts_with_a_brace_stays_text() {
        let mut page = parse(PAGE, "overview").unwrap();
        page.children[0].children[1].props.insert("text".into(), "{a} < b".into());
        let text = write(&page);
        assert!(text.contains(">{a} &lt; b</span>"));
        assert_eq!(parse(&text, "overview").unwrap(), page);
    }

    #[test]
    fn mistakes_name_their_line() {
        assert_eq!(parse("<page>\n  <p id=\"x\"/>\n</page>", "a").unwrap_err(), "line 2: <p> is not an element a page holds yet");
        assert_eq!(
            parse("<page>\n<div id=\"a\"/>\n<div id=\"a\"/></page>", "a").unwrap_err(),
            "line 3: the id a is used twice"
        );
        assert_eq!(parse("<page>\n<div id=\"a\" colour=\"red\"/></page>", "a").unwrap_err(), "line 2: <div> takes no attribute colour");
        assert!(parse("<page><span id=\"a\">text</page>", "a").is_err());
    }

    #[test]
    fn comments_are_skipped() {
        let page = parse("<!-- the overview -->\n<page name=\"A\">\n<!-- a box -->\n<div id=\"e1\"/>\n</page>\n", "a").unwrap();
        assert_eq!(page.children.len(), 1);
    }
}

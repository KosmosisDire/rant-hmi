//! A page or component as an HTML like file, as `docs/files.md` shows. Values are kept raw,
//! so an expression needs no escaping and text keeps its quotes.

use std::collections::{BTreeMap, HashSet};

use super::js::{outside, split_outside};
use super::{Element, Handler, Input, Interface, Local, Page, Shows, Tag, rank};

/// The properties written as attributes, in this order. The rest go in `style`.
const ATTRS: [&str; 6] = ["name", "repeat", "x", "y", "w", "h"];
const TEXT: &str = "text";
/// An input's value, an attribute as HTML writes it.
const VALUE: &str = "value";
/// A drawing's view box, a picture's source, and how either fits its box, attributes as SVG
/// and HTML write them.
const VIEWBOX: &str = "viewbox";
const SRC: &str = "src";
const FIT: &str = "fit";
/// What a markup element draws, an expression kept as its body, a block as a handler's code is.
const MARKUP: &str = "markup";

/// What a tag keeps as attributes of its own, besides `ATTRS`.
fn own_attrs(tag: Tag) -> &'static [&'static str] {
    match tag {
        Tag::Input => &[VALUE],
        Tag::Svg => &[VIEWBOX, FIT],
        Tag::Img | Tag::Video => &[SRC, FIT],
        _ => &[],
    }
}

// ------------------------------------------------------------------------------ writing

pub fn write(page: &Page) -> String {
    let root = if page.interface.is_some() { "component" } else { "page" };
    let shows = if page.shows == Shows::Over { " shows=\"over\"" } else { "" };
    let fill = if page.fill.is_empty() { String::new() } else { format!(" fill={}", quote(&page.fill)) };
    let mut out = format!("<{root} name={} size=\"{}x{}\"{shows}{fill}>\n", quote(&page.name), page.width, page.height);
    for i in page.interface.iter().flat_map(|i| &i.inputs) {
        let bindable = if i.bindable { " bindable=\"true\"" } else { "" };
        out.push_str(&format!("  <prop name={} default={}{bindable}/>\n", quote(&i.name), quote(&i.default)));
    }
    for e in page.interface.iter().flat_map(|i| &i.events) {
        out.push_str(&format!("  <event name={}/>\n", quote(e)));
    }
    for v in page.interface.iter().flat_map(|i| &i.variables) {
        out.push_str(&format!("  <var name={} start={}/>\n", quote(&v.name), quote(&v.start)));
    }
    for e in &page.children {
        element(&mut out, e, 1);
    }
    out.push_str(&format!("</{root}>\n"));
    out
}

fn element(out: &mut String, e: &Element, depth: usize) {
    let tag = e.word();
    out.push_str(&"  ".repeat(depth));
    out.push_str(&format!("<{tag} id={}", quote(&e.id)));
    let body = matches!(e.tag, Tag::Span | Tag::SvgText);
    if e.tag.is_shape() {
        // a shape's every property is an SVG attribute, its name first
        let attrs = e.props.iter().filter(|(k, _)| !(body && k.as_str() == TEXT));
        for (k, v) in attrs.clone().filter(|(k, _)| k.as_str() == "name").chain(attrs.filter(|(k, _)| k.as_str() != "name")) {
            out.push_str(&format!(" {k}={}", quote(v)));
        }
    } else {
        for key in ATTRS {
            if let Some(v) = e.props.get(key) {
                out.push_str(&format!(" {key}={}", quote(v)));
            }
        }
        // an input's value and a drawing's view box and fit are attributes, as HTML and SVG write them
        let own = own_attrs(e.tag);
        for k in own {
            if let Some(v) = e.props.get(*k) {
                out.push_str(&format!(" {k}={}", quote(v)));
            }
        }
        // a text input is an instance's like any other, while a span's text is its body
        let rest = e.props.iter().filter(|(k, _)| {
            !ATTRS.contains(&k.as_str()) && (e.tag == Tag::Use || k.as_str() != TEXT) && !own.contains(&k.as_str()) && !(e.tag == Tag::Markup && k.as_str() == MARKUP)
        });
        if e.tag == Tag::Use {
            // an instance's inputs are attributes of their own
            for (k, v) in rest {
                out.push_str(&format!(" {k}={}", quote(v)));
            }
        } else {
            let style: Vec<String> = rest.map(|(k, v)| format!("{k}: {v}")).collect();
            if !style.is_empty() {
                out.push_str(&format!(" style={}", quote(&style.join("; "))));
            }
        }
    }
    let text = e.props.get(TEXT).filter(|_| body);
    let markup = e.props.get(MARKUP).filter(|_| e.tag == Tag::Markup);
    match text {
        Some(text) if e.handlers.is_empty() => out.push_str(&format!(">{text}</{tag}>\n")),
        _ if e.handlers.is_empty() && e.children.is_empty() && markup.is_none() => out.push_str("/>\n"),
        _ => {
            out.push_str(">\n");
            let inner = "  ".repeat(depth + 1);
            for h in &e.handlers {
                let after = if h.after.is_empty() { String::new() } else { format!(" after={}", quote(&h.after)) };
                block(out, &inner, &format!("<on event=\"{}\"{after}>", h.event), &h.code, "</on>");
            }
            if let Some(text) = text {
                out.push_str(&format!("{inner}{text}\n"));
            }
            if let Some(code) = markup {
                lines(out, &inner, code);
            }
            for child in &e.children {
                element(out, child, depth + 1);
            }
            out.push_str(&"  ".repeat(depth));
            out.push_str(&format!("</{tag}>\n"));
        }
    }
}

/// Code between its opening and closing tags, a step further in, blank lines left bare.
fn block(out: &mut String, inner: &str, open: &str, code: &str, close: &str) {
    out.push_str(&format!("{inner}{open}\n"));
    lines(out, &format!("{inner}  "), code);
    out.push_str(&format!("{inner}{close}\n"));
}

/// Code at `indent`, blank lines left bare.
fn lines(out: &mut String, indent: &str, code: &str) {
    for line in code.lines() {
        if !line.trim().is_empty() {
            out.push_str(&format!("{indent}{line}"));
        }
        out.push('\n');
    }
}

/// Code with its common indent and its blank first and last lines taken off, as it is kept.
pub fn dedent(code: &str) -> String {
    let lines: Vec<&str> = code.lines().collect();
    let indent = lines.iter().filter(|l| !l.trim().is_empty()).map(|l| l.len() - l.trim_start().len()).min().unwrap_or(0);
    let kept: Vec<&str> = lines.iter().map(|l| if l.trim().is_empty() { "" } else { &l[indent..] }).collect();
    let first = kept.iter().position(|l| !l.is_empty()).unwrap_or(kept.len());
    let last = kept.iter().rposition(|l| !l.is_empty()).map_or(first, |n| n + 1);
    kept[first..last].iter().map(|l| l.trim_end()).collect::<Vec<_>>().join("\n")
}

/// Double quotes, or single ones when the value holds a double quote. A value holding both,
/// or text an escape would misread, is escaped.
pub(super) fn quote(v: &str) -> String {
    if v.contains("&quot;") || v.contains("&amp;") || (v.contains('"') && v.contains('\'')) {
        format!("\"{}\"", v.replace('&', "&amp;").replace('"', "&quot;"))
    } else if v.contains('"') {
        format!("'{v}'")
    } else {
        format!("\"{v}\"")
    }
}

// ------------------------------------------------------------------------------ reading

/// A page from its file text. The error names the line.
pub fn parse(text: &str, id: &str) -> Result<Page, String> {
    let mut r = Reader::new(text);
    r.gap();
    let root = if r.eat("<component") { "component" } else { r.expect("<page").map(|_| "page")? };
    let attrs = r.attrs()?;
    r.expect(">")?;
    let interface = (root == "component").then(Interface::default);
    let mut page = Page { id: id.to_owned(), name: id.to_owned(), width: 1408, height: 792, shows: Shows::Full, fill: String::new(), interface, children: Vec::new() };
    for (k, v) in attrs {
        match k.as_str() {
            "name" => page.name = v,
            "size" => {
                let (w, h) = v.split_once('x').ok_or_else(|| r.error("size is written WxH, like 1408x792"))?;
                page.width = w.trim().parse().map_err(|_| r.error("size is written WxH, like 1408x792"))?;
                page.height = h.trim().parse().map_err(|_| r.error("size is written WxH, like 1408x792"))?;
            }
            "fill" if root == "page" => page.fill = v,
            "shows" => {
                page.shows = match v.as_str() {
                    "full" => Shows::Full,
                    "over" => Shows::Over,
                    _ => return Err(r.error("shows is full or over")),
                }
            }
            other => return Err(r.error(&format!("<{root}> takes no attribute {other}"))),
        }
    }
    if let Some(interface) = &mut page.interface {
        interface.inputs = r.props()?;
        interface.events = r.events()?;
        interface.variables = r.vars()?;
    }
    page.children = r.children(root)?;
    r.gap();
    if r.at < r.s.len() {
        return Err(r.error("nothing may follow </page>"));
    }
    Ok(page)
}

/// Reads an HTML like file from the start, saying the line of any mistake.
pub(super) struct Reader<'a> {
    s: &'a str,
    at: usize,
    ids: HashSet<String>,
}

impl<'a> Reader<'a> {
    pub(super) fn new(s: &'a str) -> Reader<'a> {
        Reader { s, at: 0, ids: HashSet::new() }
    }
}

impl Reader<'_> {
    pub(super) fn rest(&self) -> &str {
        &self.s[self.at..]
    }

    pub(super) fn error(&self, what: &str) -> String {
        let line = self.s[..self.at].matches('\n').count() + 1;
        format!("line {line}: {what}")
    }

    /// Skips white space and comments.
    pub(super) fn gap(&mut self) {
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

    pub(super) fn skip(&mut self, n: usize) {
        self.at += n;
    }

    pub(super) fn eat(&mut self, lit: &str) -> bool {
        let found = self.rest().starts_with(lit);
        if found {
            self.at += lit.len();
        }
        found
    }

    pub(super) fn expect(&mut self, lit: &str) -> Result<(), String> {
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
    pub(super) fn attrs(&mut self) -> Result<Vec<(String, String)>, String> {
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
        let v = self.rest()[..end].replace("&quot;", "\"").replace("&amp;", "&");
        self.at += end + 1;
        Ok(v)
    }

    /// A component's `<prop>` lines, its inputs.
    fn props(&mut self) -> Result<Vec<Input>, String> {
        let mut out = Vec::new();
        loop {
            self.gap();
            if !self.eat("<prop") {
                return Ok(out);
            }
            let mut input = Input { name: String::new(), default: String::new(), bindable: false };
            for (k, v) in self.attrs()? {
                match k.as_str() {
                    "name" => input.name = v,
                    "default" => input.default = v,
                    "bindable" => input.bindable = v == "true",
                    other => return Err(self.error(&format!("<prop> takes no attribute {other}"))),
                }
            }
            self.expect("/>")?;
            if input.name.is_empty() {
                return Err(self.error("<prop> needs a name"));
            }
            out.push(input);
        }
    }

    /// A component's `<event>` lines, what it sends.
    fn events(&mut self) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        loop {
            self.gap();
            if !self.eat("<event") {
                return Ok(out);
            }
            let attrs = self.attrs()?;
            self.expect("/>")?;
            match attrs.as_slice() {
                [(k, v)] if k == "name" => out.push(v.clone()),
                _ => return Err(self.error("<event> takes a name and nothing else")),
            }
        }
    }

    /// A component's `<var>` lines, its own variables.
    fn vars(&mut self) -> Result<Vec<Local>, String> {
        let mut out = Vec::new();
        loop {
            self.gap();
            if !self.eat("<var") {
                return Ok(out);
            }
            let mut v = Local { name: String::new(), start: String::new() };
            for (k, value) in self.attrs()? {
                match k.as_str() {
                    "name" => v.name = value,
                    "start" => v.start = value,
                    other => return Err(self.error(&format!("<var> takes no attribute {other}"))),
                }
            }
            self.expect("/>")?;
            if v.name.is_empty() {
                return Err(self.error("<var> needs a name"));
            }
            out.push(v);
        }
    }

    /// The `<on>` blocks at the reading point.
    fn handlers(&mut self) -> Result<Vec<Handler>, String> {
        let mut out = Vec::new();
        loop {
            self.gap();
            if !(self.rest().starts_with("<on ") || self.rest().starts_with("<on>")) {
                return Ok(out);
            }
            self.expect("<on")?;
            let mut event = None;
            let mut after = String::new();
            for (k, v) in self.attrs()? {
                match k.as_str() {
                    "event" => event = Some(v),
                    "after" => after = v,
                    other => return Err(self.error(&format!("<on> takes no attribute {other}"))),
                }
            }
            let event = event.ok_or_else(|| self.error("<on> needs an event"))?;
            self.expect(">")?;
            let n = outside(self.rest(), "</on>").ok_or_else(|| self.error("<on> never closes"))?;
            if out.iter().any(|h: &Handler| h.event == event) {
                return Err(self.error(&format!("a second {event} handler")));
            }
            out.push(Handler { event, code: dedent(&self.rest()[..n]), after });
            self.at += n;
            self.expect("</on>")?;
            out.sort_by(|a, b| rank(&a.event).cmp(&rank(&b.event)));
        }
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
        // a capital names a component, of which this is an instance
        let component = word.starts_with(|c: char| c.is_ascii_uppercase()).then(|| word.clone());
        let tag = match component {
            Some(_) => Tag::Use,
            None => Tag::from_word(&word).ok_or_else(|| self.error(&format!("<{word}> is not an element a page holds yet")))?,
        };
        let mut id = None;
        let mut props = BTreeMap::new();
        for (k, v) in self.attrs()? {
            match k.as_str() {
                "id" => id = Some(v),
                k if (tag == Tag::Use && k != "style") || tag.is_shape() => {
                    props.insert(k.to_owned(), v);
                }
                k if own_attrs(tag).contains(&k) => {
                    props.insert(k.to_owned(), v);
                }
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
        let mut handlers = Vec::new();
        if !self.eat("/>") {
            self.expect(">")?;
            handlers = self.handlers()?;
            match tag {
                Tag::Div | Tag::Svg | Tag::Group => children = self.children(&word)?,
                Tag::Span | Tag::SvgText | Tag::Markup => {
                    if tag == Tag::Markup {
                        // the gap before took the first line's indent, which dedent measures against the rest
                        self.at = self.s[..self.at].trim_end_matches([' ', '\t']).len();
                    }
                    let closing = format!("</{word}>");
                    let n = outside(self.rest(), &closing).ok_or_else(|| self.error(&format!("<{word}> never closes")))?;
                    let body = &self.rest()[..n];
                    // a text is kept on one line, markup as the block of code it may be
                    let (key, value) = if tag == Tag::Markup { (MARKUP, dedent(body)) } else { (TEXT, body.trim().to_owned()) };
                    if !value.trim().is_empty() {
                        props.insert(key.to_owned(), value);
                    }
                    self.at += n;
                    self.expect(&closing)?;
                }
                _ => self.expect(&format!("</{word}>"))?,
            }
        }
        Ok(Element { id, tag, component, props, handlers, children })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<page name="Overview" size="1408x792">
  <div id="e1" name="Speed card" x="44" y="44" w="264" h="132" style="background: #1e2125; border-radius: 12">
    <span id="e2" name="Speed" x="22" y="22" w="220" h="44" style="color: Speed > 1 && Running ? 'red' : #e4e6e8; font-size: 32">Speed < 1 ? "slow; </span>" : `fast ${Speed}`</span>
    <span id="e3" x="22" y="88" w="220" h="22">"Belt <1> & rollers"</span>
  </div>
  <div id="e4" x="0" y="0" w="44" h="44"/>
</page>
"#;

    #[test]
    fn a_page_reads_and_writes_back_the_same() {
        let page = parse(PAGE, "overview").unwrap();
        assert_eq!(page.name, "Overview");
        let speed = &page.children[0].children[0];
        assert_eq!(speed.props["text"], "Speed < 1 ? \"slow; </span>\" : `fast ${Speed}`");
        assert_eq!(speed.props["color"], "Speed > 1 && Running ? 'red' : #e4e6e8");
        assert_eq!(page.children[0].children[1].props["text"], "\"Belt <1> & rollers\"");
        assert_eq!(write(&page), PAGE);
    }

    #[test]
    fn an_input_keeps_its_value_and_handlers() {
        let text = r#"<page name="A" size="1408x792">
  <input id="e1" x="44" value="Settings.target" style="font-size: 18"/>
  <input id="e2" value="Speed">
    <on event="change">
      notify(p.value);
    </on>
  </input>
</page>
"#;
        let page = parse(text, "a").unwrap();
        assert_eq!(page.children[0].props["value"], "Settings.target");
        assert_eq!(page.children[1].handlers[0].event, "change");
        assert_eq!(write(&page), text);
    }

    #[test]
    fn a_component_keeps_its_variables_and_a_hold_its_time() {
        let text = "<component name=\"Button\" size=\"176x66\">\n  <prop name=\"holdMs\" default=\"600\"/>\n  <var name=\"open\" start=\"false\"/>\n  <div id=\"e1\">\n    <on event=\"hold\" after=\"holdMs\">\n      emit(\"hold\");\n    </on>\n  </div>\n</component>\n";
        let page = parse(text, "button").unwrap();
        let i = page.interface.as_ref().unwrap();
        assert_eq!(i.variables, [Local { name: "open".into(), start: "false".into() }]);
        assert_eq!(page.children[0].handlers[0].after, "holdMs");
        assert_eq!(write(&page), text);
    }

    #[test]
    fn a_drawing_keeps_its_shapes_with_every_value_an_attribute() {
        let text = "<page name=\"A\" size=\"1408x792\">\n  <svg id=\"e1\" name=\"Gauge\" x=\"44\" y=\"44\" w=\"176\" h=\"176\" viewbox='\"0 0 100 100\"' style=\"opacity: 0.9\">\n    <circle id=\"e2\" name=\"track\" cx=\"50\" cy=\"50\" fill='\"none\"' r=\"40\" stroke=\"#3a4046\" stroke-width=\"8\"/>\n    <g id=\"e3\" transform=\"`rotate(${Speed * 90} 50 50)`\">\n      <line id=\"e4\" x1=\"50\" x2=\"50\" y1=\"50\" y2=\"14\">\n        <on event=\"tap\">\n          log(1);\n        </on>\n      </line>\n    </g>\n    <text id=\"e5\" x=\"50\" y=\"80\">Speed.toFixed(1)</text>\n  </svg>\n</page>\n";
        let page = parse(text, "a").unwrap();
        let svg = &page.children[0];
        assert_eq!((svg.tag, svg.props["viewbox"].as_str(), svg.props["opacity"].as_str()), (Tag::Svg, "\"0 0 100 100\"", "0.9"));
        assert_eq!((svg.children[0].tag, svg.children[0].props["r"].as_str()), (Tag::Circle, "40"));
        assert_eq!(svg.children[1].children[0].handlers[0].code, "log(1);");
        assert_eq!((svg.children[2].tag, svg.children[2].props["text"].as_str()), (Tag::SvgText, "Speed.toFixed(1)"));
        assert_eq!(write(&page), text);
    }

    #[test]
    fn markup_keeps_its_code_as_its_body() {
        let text = r#"<page name="A" size="1408x792">
  <markup id="e1" x="44" style="opacity: 0.9">
    <on event="tap">
      log(1);
    </on>
    `<svg viewBox="0 0 100 100">
      ${Array.from({ length: 12 }, (_, i) => `<line x1="50" y1="4" x2="50" y2="12" transform="rotate(${i * 30} 50 50)"/>`).join("")}
    </svg>` // never "</markup>"
  </markup>
  <markup id="e2" x="0"/>
</page>
"#;
        let page = parse(text, "a").unwrap();
        let e = &page.children[0];
        assert!(e.props["markup"].starts_with("`<svg viewBox=\"0 0 100 100\">\n  ${Array.from"));
        assert!(e.props["markup"].ends_with("</svg>` // never \"</markup>\""));
        assert_eq!((e.tag, e.handlers[0].code.as_str(), e.props["opacity"].as_str()), (Tag::Markup, "log(1);", "0.9"));
        assert!(!page.children[1].props.contains_key("markup"));
        assert_eq!(write(&page), text);
    }

    #[test]
    fn a_picture_keeps_its_source_and_fit() {
        let text = "<page name=\"A\" size=\"1408x792\">\n  <img id=\"e1\" name=\"Camera\" x=\"44\" src=\"Camera\" fit='\"meet\"' style=\"border-radius: 8\"/>\n</page>\n";
        let page = parse(text, "a").unwrap();
        let e = &page.children[0];
        assert_eq!((e.tag, e.props["src"].as_str(), e.props["fit"].as_str()), (Tag::Img, "Camera", "\"meet\""));
        assert_eq!(write(&page), text);
    }

    #[test]
    fn a_video_keeps_its_source_and_fit() {
        let text = "<page name=\"A\" size=\"1408x792\">
  <video id=\"e1\" x=\"44\" src=\"Camera\" fit='\"slice\"'/>
</page>
";
        let page = parse(text, "a").unwrap();
        let e = &page.children[0];
        assert_eq!((e.tag, e.props["src"].as_str(), e.props["fit"].as_str()), (Tag::Video, "Camera", "\"slice\""));
        assert_eq!(write(&page), text);
    }

    #[test]
    fn an_instance_keeps_a_text_input() {
        let text = "<page name=\"A\" size=\"1408x792\">\n  <Button id=\"e1\" x=\"44\" text='\"Go\"'/>\n</page>\n";
        let page = parse(text, "a").unwrap();
        assert_eq!(page.children[0].props["text"], "\"Go\"");
        assert_eq!(write(&page), text);
    }

    #[test]
    fn a_page_keeps_its_fill() {
        let text = "<page name=\"A\" size=\"1408x792\" fill=\"$ground\">\n</page>\n";
        let page = parse(text, "a").unwrap();
        assert_eq!(page.fill, "$ground");
        assert_eq!(write(&page), text);
    }

    #[test]
    fn values_holding_quotes_or_entities_come_back_whole() {
        let mut page = parse(PAGE, "overview").unwrap();
        for v in ["Mode == \"Auto\" ? \"A\" : \"M\"", "a ? \"it's\" : 'b'", "\"&quot; &amp; &\""] {
            page.children[1].props.insert("x".into(), v.into());
            let text = write(&page);
            assert_eq!(parse(&text, "overview").unwrap(), page, "{v} as {text}");
        }
        page.children[1].props.insert("x".into(), "Mode == \"Auto\"".into());
        assert!(write(&page).contains("x='Mode == \"Auto\"'"));
    }

    #[test]
    fn handlers_read_and_write_back_the_same() {
        let text = r#"<page name="A" size="1408x792">
  <div id="e1" x="0">
    <on event="tap">
      if (Running) {
        Speed = Speed + 0.1; // never "</on>" here
      }

      log(`done
      </on>`);
    </on>
    <on event="release">
      Speed = 0;
    </on>
    <span id="e2">
      <on event="press">
        Jog = 1;
      </on>
      Speed.toFixed(1)
    </span>
    <span id="e3">"plain"</span>
  </div>
</page>
"#;
        let page = parse(text, "a").unwrap();
        let e1 = &page.children[0];
        assert_eq!(e1.handlers[0].code, "if (Running) {\n  Speed = Speed + 0.1; // never \"</on>\" here\n}\n\nlog(`done\n</on>`);");
        assert_eq!(e1.handlers[1].event, "release");
        assert_eq!(e1.children[0].handlers[0].code, "Jog = 1;");
        assert_eq!(e1.children[0].props["text"], "Speed.toFixed(1)");
        assert_eq!(write(&page), text);
        assert_eq!(parse("<page><div id=\"a\"><on event=\"tap\"></on><on event=\"tap\"></on></div></page>", "a").unwrap_err(), "line 1: a second tap handler");
    }

    #[test]
    fn mistakes_name_their_line() {
        assert_eq!(parse("<page>\n  <p id=\"x\"/>\n</page>", "a").unwrap_err(), "line 2: <p> is not an element a page holds yet");
        assert_eq!(
            parse("<page>\n<div id=\"a\"/>\n<div id=\"a\"/></page>", "a").unwrap_err(),
            "line 3: the id a is used twice"
        );
        assert_eq!(parse("<page>\n<div id=\"a\" colour=\"red\"/></page>", "a").unwrap_err(), "line 2: <div> takes no attribute colour");
        assert!(parse("<page><span id=\"a\">\"text\"</page>", "a").is_err());
    }

    #[test]
    fn comments_are_skipped() {
        let page = parse("<!-- the overview -->\n<page name=\"A\">\n<!-- a box -->\n<div id=\"e1\"/>\n</page>\n", "a").unwrap();
        assert_eq!(page.children.len(), 1);
    }
}

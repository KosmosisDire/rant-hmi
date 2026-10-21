//! A page or component as an HTML like file, as `docs/files.md` shows. Values are kept raw,
//! so an expression needs no escaping and text keeps its quotes.

use std::collections::{BTreeMap, HashSet};

use super::js::{outside, split_outside};
use super::{Element, Handler, Input, Interface, Local, Page, Shows, Sizing, Tag, rank};

/// The properties written as attributes, in this order. The rest go in `style`.
const ATTRS: [&str; 7] = ["name", "repeat", "x", "y", "w", "h", "origin"];
const TEXT: &str = "text";
/// An input's value, an attribute as HTML writes it.
const VALUE: &str = "value";
/// A diagram's view box, media's source, and how either fits its box, attributes as SVG and
/// HTML write them.
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
        Tag::Media => &[SRC, FIT],
        _ => &[],
    }
}

// ------------------------------------------------------------------------------ writing

/// The page as its file. `components` are the project's, whose inputs tell an instance's
/// inputs from the CSS on its box.
pub fn write(page: &Page, components: &[Page]) -> String {
    let root = if page.interface.is_some() { "component" } else { "page" };
    let shows = if page.shows == Shows::Over { " shows=\"over\"" } else { "" };
    let fill = if page.fill.is_empty() { String::new() } else { format!(" fill={}", quote(&page.fill)) };
    let sizing = if page.interface.as_ref().is_some_and(|i| i.sizing == Sizing::Fill) { " sizing=\"fill\"" } else { "" };
    let mut out = format!("<{root} name={} size=\"{}x{}\"{shows}{sizing}{fill}>\n", quote(&page.name), page.width, page.height);
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
        element(&mut out, e, 1, components);
    }
    out.push_str(&format!("</{root}>\n"));
    out
}

fn element(out: &mut String, e: &Element, depth: usize, components: &[Page]) {
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
        // an input's value and a diagram's view box and fit are attributes, as HTML and SVG write them
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
        // an instance's inputs are attributes of their own, the rest CSS on its box as a frame's
        // style is. Without its component each stays an attribute.
        let interface = e.component.as_deref().and_then(|c| components.iter().find(|p| p.interface.is_some() && p.name == c)).and_then(|p| p.interface.as_ref());
        let input = |k: &str| e.tag == Tag::Use && interface.is_none_or(|i| i.inputs.iter().any(|x| x.name == k));
        let (inputs, rest): (Vec<_>, Vec<_>) = rest.partition(|(k, _)| input(k));
        for (k, v) in inputs {
            out.push_str(&format!(" {k}={}", quote(v)));
        }
        let style: Vec<String> = rest.into_iter().map(|(k, v)| format!("{k}: {v}")).collect();
        if !style.is_empty() {
            out.push_str(&format!(" style={}", quote(&style.join("; "))));
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
                let time = match crate::pages::time_word(&h.event) {
                    Some(word) if !h.ms.is_empty() => format!(" {word}={}", quote(&h.ms)),
                    _ => String::new(),
                };
                block(out, &inner, &format!("<on event=\"{}\"{time}>", h.event), &h.code, "</on>");
            }
            if let Some(text) = text {
                out.push_str(&format!("{inner}{text}\n"));
            }
            if let Some(code) = markup {
                lines(out, &inner, code);
            }
            for child in &e.children {
                element(out, child, depth + 1, components);
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
    let mut page = Page { id: id.to_owned(), name: id.to_owned(), width: 128, height: 72, shows: Shows::Full, fill: String::new(), interface, children: Vec::new() };
    for (k, v) in attrs {
        match k.as_str() {
            "name" => page.name = v,
            "size" => {
                let (w, h) = v.split_once('x').ok_or_else(|| r.error("size is written WxH, like 128x72"))?;
                page.width = w.trim().parse().map_err(|_| r.error("size is written WxH, like 128x72"))?;
                page.height = h.trim().parse().map_err(|_| r.error("size is written WxH, like 128x72"))?;
            }
            "fill" if root == "page" => page.fill = v,
            "sizing" if root == "component" => {
                let sizing = match v.as_str() {
                    "scale" => Sizing::Scale,
                    "fill" => Sizing::Fill,
                    _ => return Err(r.error("sizing is scale or fill")),
                };
                page.interface.as_mut().expect("a component has an interface").sizing = sizing;
            }
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

/// Where a body of code ends. A block, its code on lines of its own as the writer puts it,
/// ends at the first line holding only the closing tag, so code that does not parse yet, as
/// an open quote, still reads back. A text on its opening line ends on that line.
fn block_end(s: &str, closing: &str, block: bool) -> Option<usize> {
    if block {
        let mut at = 0;
        for line in s.split_inclusive('\n') {
            if line.trim() == closing {
                return line.find(closing).map(|n| at + n);
            }
            at += line.len();
        }
        return outside(s, closing);
    }
    let first = &s[..s.find('\n').unwrap_or(s.len())];
    outside(first, closing).or_else(|| first.rfind(closing)).or_else(|| outside(s, closing))
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

    /// Whether what follows starts on a line of its own, as a block the writer puts there.
    fn opens_block(&self) -> bool {
        self.rest().trim_start_matches([' ', '\t']).starts_with(['\n', '\r'])
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
            let mut time = None;
            for (k, v) in self.attrs()? {
                match k.as_str() {
                    "event" => event = Some(v),
                    "after" | "every" => time = Some((k, v)),
                    other => return Err(self.error(&format!("<on> takes no attribute {other}"))),
                }
            }
            let event = event.ok_or_else(|| self.error("<on> needs an event"))?;
            // a hold waits after, a repeat runs every, and no other event takes a time
            let ms = match time {
                Some((k, v)) if crate::pages::time_word(&event) == Some(k.as_str()) => v,
                Some((k, _)) => return Err(self.error(&format!("a {event} handler takes no {k}"))),
                None => String::new(),
            };
            self.expect(">")?;
            let n = block_end(self.rest(), "</on>", self.opens_block()).ok_or_else(|| self.error("<on> never closes"))?;
            if out.iter().any(|h: &Handler| h.event == event) {
                return Err(self.error(&format!("a second {event} handler")));
            }
            out.push(Handler { event, code: dedent(&self.rest()[..n]), ms });
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
            let block = self.opens_block();
            handlers = self.handlers()?;
            match tag {
                Tag::Div | Tag::Group | Tag::Svg | Tag::G => children = self.children(&word)?,
                Tag::Span | Tag::SvgText | Tag::Markup => {
                    if tag == Tag::Markup {
                        // the gap before took the first line's indent, which dedent measures against the rest
                        self.at = self.s[..self.at].trim_end_matches([' ', '\t']).len();
                    }
                    let closing = format!("</{word}>");
                    let n = block_end(self.rest(), &closing, block).ok_or_else(|| self.error(&format!("<{word}> never closes")))?;
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
        assert_eq!(write(&page, &[]), PAGE);
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
        assert_eq!(write(&page, &[]), text);
    }

    #[test]
    fn a_component_keeps_its_variables_and_a_hold_its_time() {
        let text = "<component name=\"Button\" size=\"176x66\">\n  <prop name=\"holdMs\" default=\"600\"/>\n  <var name=\"open\" start=\"false\"/>\n  <div id=\"e1\">\n    <on event=\"hold\" after=\"holdMs\">\n      emit(\"hold\");\n    </on>\n  </div>\n</component>\n";
        let page = parse(text, "button").unwrap();
        let i = page.interface.as_ref().unwrap();
        assert_eq!(i.variables, [Local { name: "open".into(), start: "false".into() }]);
        assert_eq!(page.children[0].handlers[0].ms, "holdMs");
        assert_eq!(write(&page, &[]), text);
    }

    #[test]
    fn a_diagram_keeps_its_shapes_with_every_value_an_attribute() {
        let text = "<page name=\"A\" size=\"1408x792\">\n  <svg id=\"e1\" name=\"Gauge\" x=\"44\" y=\"44\" w=\"176\" h=\"176\" viewbox='\"0 0 100 100\"' style=\"opacity: 0.9\">\n    <circle id=\"e2\" name=\"track\" cx=\"50\" cy=\"50\" fill='\"none\"' r=\"40\" stroke=\"#3a4046\" stroke-width=\"8\"/>\n    <g id=\"e3\" transform=\"`rotate(${Speed * 90} 50 50)`\">\n      <line id=\"e4\" x1=\"50\" x2=\"50\" y1=\"50\" y2=\"14\">\n        <on event=\"tap\">\n          log(1);\n        </on>\n      </line>\n    </g>\n    <text id=\"e5\" x=\"50\" y=\"80\">Speed.toFixed(1)</text>\n  </svg>\n</page>\n";
        let page = parse(text, "a").unwrap();
        let svg = &page.children[0];
        assert_eq!((svg.tag, svg.props["viewbox"].as_str(), svg.props["opacity"].as_str()), (Tag::Svg, "\"0 0 100 100\"", "0.9"));
        assert_eq!((svg.children[0].tag, svg.children[0].props["r"].as_str()), (Tag::Circle, "40"));
        assert_eq!(svg.children[1].children[0].handlers[0].code, "log(1);");
        assert_eq!((svg.children[2].tag, svg.children[2].props["text"].as_str()), (Tag::SvgText, "Speed.toFixed(1)"));
        assert_eq!(write(&page, &[]), text);
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
        assert_eq!(write(&page, &[]), text);
    }

    #[test]
    fn media_keeps_its_source_and_fit() {
        let text = "<page name=\"A\" size=\"1408x792\">\n  <media id=\"e1\" name=\"Camera\" x=\"44\" src=\"Camera\" fit='\"slice\"' style=\"border-radius: 8\"/>\n</page>\n";
        let page = parse(text, "a").unwrap();
        let e = &page.children[0];
        assert_eq!((e.tag, e.props["src"].as_str(), e.props["fit"].as_str()), (Tag::Media, "Camera", "\"slice\""));
        assert_eq!(write(&page, &[]), text);
    }

    #[test]
    fn an_instance_keeps_a_text_input() {
        let text = "<page name=\"A\" size=\"1408x792\">\n  <Button id=\"e1\" x=\"44\" text='\"Go\"'/>\n</page>\n";
        let page = parse(text, "a").unwrap();
        assert_eq!(page.children[0].props["text"], "\"Go\"");
        assert_eq!(write(&page, &[]), text);
    }

    #[test]
    fn a_page_keeps_its_fill() {
        let text = "<page name=\"A\" size=\"1408x792\" fill=\"$ground\">\n</page>\n";
        let page = parse(text, "a").unwrap();
        assert_eq!(page.fill, "$ground");
        assert_eq!(write(&page, &[]), text);
    }

    #[test]
    fn values_holding_quotes_or_entities_come_back_whole() {
        let mut page = parse(PAGE, "overview").unwrap();
        for v in ["Mode == \"Auto\" ? \"A\" : \"M\"", "a ? \"it's\" : 'b'", "\"&quot; &amp; &\""] {
            page.children[1].props.insert("x".into(), v.into());
            let text = write(&page, &[]);
            assert_eq!(parse(&text, "overview").unwrap(), page, "{v} as {text}");
        }
        page.children[1].props.insert("x".into(), "Mode == \"Auto\"".into());
        assert!(write(&page, &[]).contains("x='Mode == \"Auto\"'"));
    }

    #[test]
    fn code_typed_halfway_reads_back() {
        let page = parse("<page name=\"A\" size=\"128x72\">
  <div id=\"e1\" x=\"0\"/>
</page>
", "a").unwrap();
        let mut half = page.clone();
        half.children[0].handlers.push(Handler { event: "tap".into(), code: "open(\"".into(), ms: String::new() });
        half.children.push(Element { id: "e2".into(), tag: Tag::Span, component: None, props: [("text".to_string(), "\"Hi".to_string())].into(), handlers: vec![Handler { event: "tap".into(), code: "log(`".into(), ms: String::new() }], children: Vec::new() });
        let again = parse(&write(&half, &[]), "a").unwrap();
        assert_eq!(again.children[0].handlers[0].code, "open(\"");
        assert_eq!(again.children[1].handlers[0].code, "log(`");
        assert_eq!(again.children[1].props["text"], "\"Hi");
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
        assert_eq!(write(&page, &[]), text);
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

    /// A small xorshift, so the random pages need no crate and are the same each run.
    struct Rng(u64);

    impl Rng {
        fn below(&mut self, n: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % n as u64) as usize
        }

        fn pick(&mut self, from: &[&str]) -> String {
            from[self.below(from.len())].to_owned()
        }
    }

    /// One line values as people write them, with the quotes, brackets and closing tags a
    /// reader could trip on.
    const VALUES: [&str; 16] = [
        "Speed",
        "Speed.toFixed(1)",
        r#""Running""#,
        "'it'",
        r#""a; b: c""#,
        r#"Speed < 1 ? "slow; </span>" : `fast ${Speed}`"#,
        "`t ${Speed} </on> </markup>`",
        "a && b || !c",
        r#""both ' and \" quotes""#,
        r#""x &amp; y &quot; z""#,
        "[1, 2, 3].map((x) => x * 2)",
        "#2a2f35",
        "-3.5",
        "$accent",
        "Speed > 1 && Running ? 'red' : #e4e6e8",
        r#"{ a: "}" }.a"#,
    ];

    /// Code over lines, with closing tags in its strings, templates and comments.
    const CODE: [&str; 6] = [
        "Speed = Speed + 0.1;",
        "if (Running) {\n  Speed = 0; // never \"</on>\" here\n}",
        "log(`done\n</on> </markup>`);",
        "x = 1;\n\ny = '</span>';",
        "`<svg viewBox=\"0 0 10 10\">\n  <circle r=\"${Speed}\"/>\n</svg>`",
        "/* a </on> comment */ emit(\"change\", { v: 1 });",
    ];

    const STYLE: [&str; 5] = ["background", "color", "font-size", "border-radius", "opacity"];

    fn some_props(rng: &mut Rng, keys: &[&str]) -> BTreeMap<String, String> {
        let mut props = BTreeMap::new();
        for _ in 0..rng.below(4) {
            props.insert(rng.pick(keys), rng.pick(&VALUES));
        }
        props
    }

    /// Handlers in the order a read sorts them, a hold's or a repeat's sometimes with its time.
    fn some_handlers(rng: &mut Rng, tag: Tag) -> Vec<Handler> {
        let events: &[&str] = if tag == Tag::Input { &["change"] } else { &crate::pages::POINTER };
        let mut out = Vec::new();
        for e in events {
            if rng.below(4) == 0 {
                let ms = if crate::pages::time_word(e).is_some() && rng.below(2) == 0 { rng.pick(&VALUES) } else { String::new() };
                out.push(Handler { event: (*e).to_owned(), code: rng.pick(&CODE), ms });
            }
        }
        out
    }

    fn random_shapes(rng: &mut Rng, ids: &mut usize, depth: usize) -> Vec<Element> {
        let mut out = Vec::new();
        for _ in 0..rng.below(3) {
            *ids += 1;
            let tag = [Tag::Circle, Tag::Rect, Tag::Path, Tag::SvgText, Tag::G][rng.below(5)];
            let mut props = some_props(rng, &["name", "cx", "r", "fill", "stroke", "d", "transform"]);
            if tag == Tag::SvgText {
                props.insert(TEXT.to_owned(), rng.pick(&VALUES));
            }
            let id = format!("e{ids}");
            let children = if tag == Tag::G && depth < 3 { random_shapes(rng, ids, depth + 1) } else { Vec::new() };
            out.push(Element { id, tag, component: None, props, handlers: some_handlers(rng, tag), children });
        }
        out
    }

    fn random_element(rng: &mut Rng, ids: &mut usize, depth: usize) -> Element {
        *ids += 1;
        let id = format!("e{ids}");
        let tag = [Tag::Div, Tag::Span, Tag::Input, Tag::Media, Tag::Svg, Tag::Markup, Tag::Use, Tag::Group][rng.below(8)];
        let keys: Vec<&str> = ATTRS.iter().chain(STYLE.iter()).copied().collect();
        let mut props = some_props(rng, &keys);
        let mut children = Vec::new();
        let mut component = None;
        match tag {
            Tag::Div | Tag::Group if depth < 3 => {
                for _ in 0..rng.below(3) {
                    children.push(random_element(rng, ids, depth + 1));
                }
            }
            Tag::Span if rng.below(4) > 0 => {
                props.insert(TEXT.to_owned(), rng.pick(&VALUES));
            }
            Tag::Input => {
                props.insert(VALUE.to_owned(), rng.pick(&VALUES));
            }
            Tag::Media => {
                props.insert(SRC.to_owned(), rng.pick(&VALUES));
                props.insert(FIT.to_owned(), "\"slice\"".to_owned());
            }
            Tag::Svg => {
                props.insert(VIEWBOX.to_owned(), "\"0 0 100 100\"".to_owned());
                children = random_shapes(rng, ids, depth);
            }
            Tag::Markup if rng.below(4) > 0 => {
                props.insert(MARKUP.to_owned(), rng.pick(&CODE));
            }
            Tag::Use => {
                component = Some("Meter".to_owned());
                props = some_props(rng, &["name", "x", "w", "level", "text"]);
            }
            _ => {}
        }
        let handlers = some_handlers(rng, tag);
        Element { id, tag, component, props, handlers, children }
    }

    fn random_page(rng: &mut Rng) -> Page {
        let mut ids = 0;
        let interface = (rng.below(3) == 0).then(|| Interface {
            inputs: vec![Input { name: "level".into(), default: rng.pick(&VALUES), bindable: rng.below(2) == 0 }],
            events: vec!["change".into()],
            variables: vec![Local { name: "state".into(), start: rng.pick(&VALUES) }],
            sizing: if rng.below(2) == 0 { Sizing::Fill } else { Sizing::Scale },
        });
        let shows = if rng.below(3) == 0 { Shows::Over } else { Shows::Full };
        // a component draws on what holds it, so only a page has a fill
        let fill = if interface.is_none() && rng.below(2) == 0 { rng.pick(&VALUES) } else { String::new() };
        let mut children = Vec::new();
        for _ in 0..1 + rng.below(4) {
            children.push(random_element(rng, &mut ids, 0));
        }
        Page { id: "p".into(), name: "Overview".into(), width: 1408, height: 792, shows, fill, interface, children }
    }

    #[test]
    fn random_pages_read_back_as_written() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..10000 {
            let page = random_page(&mut rng);
            let text = write(&page, &[]);
            let back = parse(&text, "p").unwrap_or_else(|e| panic!("{e} in\n{text}"));
            assert_eq!(back, page, "read back otherwise:\n{text}");
        }
    }
}

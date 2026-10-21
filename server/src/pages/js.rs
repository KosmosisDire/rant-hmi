//! Just enough JS reading for page files and renames: one tolerant tokenizer that knows where
//! names, strings, template literals and comments start and end, without parsing.

/// What a token is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    /// A name, a keyword among them.
    Word,
    /// A number or a #hex colour, which hold no names.
    Literal,
    /// A quoted string, or a template literal's own text up to and from each `${ }`.
    Text,
    Comment,
    /// Any other character but white space.
    Mark,
}

#[derive(Clone, Copy, Debug)]
pub struct Token {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
    /// Inside a template literal's `${ }`.
    pub nested: bool,
}

/// The tokens of `src` in order, white space left out. A quote never closed ends at its line's
/// end, a template or block comment never closed at the end.
pub fn tokens(src: &str) -> Vec<Token> {
    let mut out = Vec::new();
    lex(src, 0, false, &mut out);
    out
}

fn word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
}

/// Reads code from `i` to its end, or when `nested` to the brace closing a template's `${`,
/// where it stops.
fn lex(s: &str, mut i: usize, nested: bool, out: &mut Vec<Token>) -> usize {
    let b = s.as_bytes();
    let mut depth = 0usize;
    while i < b.len() {
        let start = i;
        let kind = match b[i] {
            b'}' if nested && depth == 0 => return i,
            c if c.is_ascii_whitespace() => {
                i += 1;
                continue;
            }
            b'`' => {
                i = template(s, i, nested, out);
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                i = s[i..].find('\n').map_or(b.len(), |n| i + n);
                Kind::Comment
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i = s[i + 2..].find("*/").map_or(b.len(), |n| i + n + 4);
                Kind::Comment
            }
            q @ (b'"' | b'\'') => {
                i += 1;
                while i < b.len() && b[i] != q && b[i] != b'\n' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                if b.get(i) == Some(&q) {
                    i += 1;
                }
                i = i.min(b.len());
                Kind::Text
            }
            // a #hex colour stops before a dot, which calls one of its methods
            c if c.is_ascii_digit() || (c == b'#' && b.get(i + 1).is_some_and(|&d| word(d))) => {
                i += 1;
                while i < b.len() && (word(b[i]) || (c != b'#' && b[i] == b'.')) {
                    i += 1;
                }
                Kind::Literal
            }
            c if word(c) => {
                while i < b.len() && word(b[i]) {
                    i += 1;
                }
                Kind::Word
            }
            c => {
                match c {
                    b'{' => depth += 1,
                    b'}' => depth = depth.saturating_sub(1),
                    _ => {}
                }
                i += s[i..].chars().next().map_or(1, char::len_utf8);
                Kind::Mark
            }
        };
        out.push(Token { kind, start, end: i, nested });
    }
    i
}

/// Reads the template literal at `i`: its own text as Text tokens, the code in each `${ }`
/// as nested tokens. Gives where it ends.
fn template(s: &str, mut i: usize, nested: bool, out: &mut Vec<Token>) -> usize {
    let b = s.as_bytes();
    let mut start = i;
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'`' => {
                out.push(Token { kind: Kind::Text, start, end: i + 1, nested });
                return i + 1;
            }
            b'$' if b.get(i + 1) == Some(&b'{') => {
                out.push(Token { kind: Kind::Text, start, end: i + 2, nested });
                i = lex(s, i + 2, true, out);
                // the closing brace starts the text after it
                start = i;
                i += 1;
            }
            _ => i += 1,
        }
    }
    let end = i.min(b.len());
    if start < end {
        out.push(Token { kind: Kind::Text, start, end, nested });
    }
    end
}

/// Where `what` first starts in `s` outside JS strings, template literals and comments.
pub fn outside(s: &str, what: &str) -> Option<usize> {
    let code = tokens(s).into_iter().filter(|t| !matches!(t.kind, Kind::Text | Kind::Comment));
    code.flat_map(|t| t.start..t.end).find(|&k| s.as_bytes()[k..].starts_with(what.as_bytes()))
}

/// Splits on `sep` outside brackets, strings and comments, dropping empty parts.
pub fn split_outside(s: &str, sep: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut from = 0;
    let mut depth = 0usize;
    for t in tokens(s).into_iter().filter(|t| t.kind == Kind::Mark && !t.nested) {
        match s[t.start..].chars().next() {
            Some('(' | '[' | '{') => depth += 1,
            Some(')' | ']' | '}') => depth = depth.saturating_sub(1),
            Some(c) if c == sep && depth == 0 => {
                parts.push(&s[from..t.start]);
                from = t.end;
            }
            _ => {}
        }
    }
    parts.push(&s[from..]);
    parts.into_iter().map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()).collect()
}

/// The names code reads, each where it stands: no property after a dot, nothing quoted or in
/// a comment.
pub fn names(src: &str) -> Vec<(usize, &str)> {
    let all = tokens(src);
    let mark = |t: Option<&Token>, end: usize| t.is_some_and(|t| t.kind == Kind::Mark && &src[t.start..t.end] == "." && t.end == end);
    let mut out = Vec::new();
    for (n, t) in all.iter().enumerate().filter(|(_, t)| t.kind == Kind::Word) {
        // a property follows a single dot, a spread's three do not count
        let dot = n.checked_sub(1).map(|p| &all[p]).filter(|p| mark(Some(p), p.end));
        let property = dot.is_some_and(|d| !mark(n.checked_sub(2).map(|q| &all[q]), d.start));
        if !property {
            out.push((t.start, &src[t.start..t.end]));
        }
    }
    out
}

/// `src` with each use of the name `from` written `to`. Strings, comments and a property
/// name after a dot keep it.
pub fn rename(src: &str, from: &str, to: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut at = 0;
    for (start, _) in names(src).into_iter().filter(|(_, n)| *n == from) {
        out.push_str(&src[at..start]);
        out.push_str(to);
        at = start + from.len();
    }
    out.push_str(&src[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rename_reaches_names_and_nothing_else() {
        let cases = [
            ("Speed.toFixed(1)", "LineSpeed.toFixed(1)"),
            ("Robot.Speed + Speed", "Robot.Speed + LineSpeed"),
            ("\"Speed\" + 'Speed' + `${Speed} Speed`", "\"Speed\" + 'Speed' + `${LineSpeed} Speed`"),
            ("// Speed\nSpeed = 1; /* Speed */", "// Speed\nLineSpeed = 1; /* Speed */"),
            ("SpeedLimit + Speed2 + Speed + mySpeed", "SpeedLimit + Speed2 + LineSpeed + mySpeed"),
            ("[...Speed, 1e5, 0xSpeed, #Speed]", "[...LineSpeed, 1e5, 0xSpeed, #Speed]"),
            ("#224493.mix(Speed) + 'it\\'s Speed\nSpeed", "#224493.mix(LineSpeed) + 'it\\'s Speed\nLineSpeed"),
            ("`a ${`b ${Speed} ${{ x: Speed }.x}`}`", "`a ${`b ${LineSpeed} ${{ x: LineSpeed }.x}`}`"),
            ("if (Speed > 1) {\n  Speed = Speed\n    .valueOf();\n}", "if (LineSpeed > 1) {\n  LineSpeed = LineSpeed\n    .valueOf();\n}"),
        ];
        for (src, want) in cases {
            assert_eq!(rename(src, "Speed", "LineSpeed"), want, "{src}");
        }
    }

    #[test]
    fn code_is_found_and_split_outside_strings_comments_and_braces() {
        assert_eq!(outside("a('</on>') /* </on> */ `${'</on>'}` </on>", "</on>"), Some(36));
        assert_eq!(split_outside("color: red; x: `${a; b}`; y: { a; b }; z: 'p;q'", ';'), ["color: red", "x: `${a; b}`", "y: { a; b }", "z: 'p;q'"]);
        assert_eq!(names("é + `x ${y}` + \"z\" + a.b + ...c"), [(10, "y"), (22, "a"), (31, "c")]);
    }
}

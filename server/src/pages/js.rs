//! Just enough JS reading for page files and renames: where strings, template literals and
//! comments start and end, so code can be split, ended and renamed without parsing it.

/// Where `what` first starts in `s` outside JS strings, template literals and comments.
pub fn outside(s: &str, what: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            q @ (b'"' | b'\'' | b'`') => i = string_end(b, i, q)?,
            b'/' if b.get(i + 1) == Some(&b'/') => i = s[i..].find('\n').map_or(b.len(), |n| i + n),
            b'/' if b.get(i + 1) == Some(&b'*') => i = s[i + 2..].find("*/").map_or(b.len(), |n| i + n + 3),
            _ if s[i..].starts_with(what) => return Some(i),
            _ => {}
        }
        i += 1;
    }
    None
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
pub fn split_outside(s: &str, sep: char) -> Vec<String> {
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
            q @ (b'"' | b'\'' | b'`') => i = string_end(b, i, q).unwrap_or(b.len()),
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

/// `src` with each use of the name `from` written `to`. Strings, comments and a property
/// name after a dot keep it.
pub fn rename(src: &str, from: &str, to: &str) -> String {
    let mut spots = Vec::new();
    names(src.as_bytes(), 0, false, from.as_bytes(), &mut spots);
    let mut out = String::with_capacity(src.len());
    let mut at = 0;
    for s in spots {
        out.push_str(&src[at..s]);
        out.push_str(to);
        at = s + from.len();
    }
    out.push_str(&src[at..]);
    out
}

/// Walks code from `i` to its end, or with `nested` to the brace closing a template's `${`,
/// noting where `name` stands as a name. Returns where it stopped.
fn names(b: &[u8], mut i: usize, nested: bool, name: &[u8], spots: &mut Vec<usize>) -> usize {
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    let mut depth = 0usize;
    while i < b.len() {
        match b[i] {
            b'{' => depth += 1,
            b'}' if nested && depth == 0 => return i,
            b'}' => depth = depth.saturating_sub(1),
            q @ (b'"' | b'\'') => i = string_end(b, i, q).unwrap_or(b.len()),
            b'`' => {
                i += 1;
                while i < b.len() && b[i] != b'`' {
                    match b[i] {
                        b'\\' => i += 2,
                        b'$' if b.get(i + 1) == Some(&b'{') => i = names(b, i + 2, true, name, spots) + 1,
                        _ => i += 1,
                    }
                }
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < b.len() && !b[i..].starts_with(b"*/") {
                    i += 1;
                }
                i += 1;
            }
            // a number or a #hex colour holds no names
            c if c.is_ascii_digit() || c == b'#' => {
                while i + 1 < b.len() && (word(b[i + 1]) || b[i + 1] == b'.') {
                    i += 1;
                }
            }
            c if word(c) => {
                let start = i;
                while i < b.len() && word(b[i]) {
                    i += 1;
                }
                if &b[start..i] == name && !after_dot(b, start) {
                    spots.push(start);
                }
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    i
}

/// True when the name at `start` follows a single dot, as a property does. A spread's three
/// dots do not count.
fn after_dot(b: &[u8], start: usize) -> bool {
    let mut j = start;
    while j > 0 && b[j - 1].is_ascii_whitespace() {
        j -= 1;
    }
    j > 0 && b[j - 1] == b'.' && !(j > 1 && b[j - 2] == b'.')
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
            ("`a ${`b ${Speed} ${{ x: Speed }.x}`}`", "`a ${`b ${LineSpeed} ${{ x: LineSpeed }.x}`}`"),
            ("if (Speed > 1) {\n  Speed = Speed\n    .valueOf();\n}", "if (LineSpeed > 1) {\n  LineSpeed = LineSpeed\n    .valueOf();\n}"),
        ];
        for (src, want) in cases {
            assert_eq!(rename(src, "Speed", "LineSpeed"), want, "{src}");
        }
    }
}

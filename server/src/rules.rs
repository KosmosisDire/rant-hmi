//! How each kind of name is spelled and how often a record samples, kept here once. A test
//! writes them to the client's protocol folder as rules.ts, for the editor's fields.

/// How one kind of name is spelled: its first letter's case, then letters and digits.
pub struct Shape {
    /// A capital first, else a small letter.
    pub capital: bool,
    /// Whether _ may follow as well.
    pub underscore: bool,
    /// Names it may not take.
    pub except: &'static [&'static str],
}

/// A variable, a computed value or a record: camelCase, which tells them from imports.
pub const LOCAL: Shape = Shape { capital: false, underscore: true, except: &[] };
/// An import's alias: PascalCase, which tells mesh names from the HMI's own.
pub const ALIAS: Shape = Shape { capital: true, underscore: true, except: &[] };
pub const TOKEN: Shape = Shape { capital: false, underscore: false, except: &[] };
/// A component, as code and files name it.
pub const COMPONENT: Shape = Shape { capital: true, underscore: false, except: &[] };
/// A component's input or variable, clear of what places and repeats an instance.
pub const INPUT: Shape = Shape { capital: false, underscore: false, except: &["name", "repeat", "x", "y", "w", "h", "origin", "rotate"] };
/// An event a component sends.
pub const EVENT: Shape = Shape { capital: false, underscore: false, except: &[] };

/// How often a record samples, in ms: a little slower than the backend's tick, at most daily.
pub const EVERY_MS: (u32, u32) = (50, 86_400_000);
/// How long a record keeps its samples, in seconds.
pub const KEEP_S: (u32, u32) = (1, 86_400);

impl Shape {
    pub fn fits(&self, name: &str) -> bool {
        let mut chars = name.chars();
        let first = chars.next().is_some_and(|c| if self.capital { c.is_ascii_uppercase() } else { c.is_ascii_lowercase() });
        first && chars.all(|c| c.is_ascii_alphanumeric() || (self.underscore && c == '_')) && !self.except.contains(&name)
    }

    /// The error for the user when `name` does not fit, naming `what` it was for, as "a token".
    pub fn check(&self, name: &str, what: &str) -> Result<(), String> {
        if self.fits(name) {
            return Ok(());
        }
        let case = if self.capital { "capital" } else { "small" };
        let rest = if self.underscore { "letters, digits or _" } else { "letters and digits" };
        let clear = match self.except {
            [] => String::new(),
            [some @ .., last] => format!(", and keep clear of {} and {last}", some.join(", ")),
        };
        Err(format!("\"{name}\" cannot name {what}: start with a {case} letter, then use {rest}{clear}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_client_reads_the_same_rules() {
        let pattern = |s: &Shape| format!("/^[{}][A-Za-z0-9{}]*$/", if s.capital { "A-Z" } else { "a-z" }, if s.underscore { "_" } else { "" });
        let shapes = [("LOCAL", &LOCAL), ("ALIAS", &ALIAS), ("TOKEN", &TOKEN), ("COMPONENT", &COMPONENT), ("INPUT", &INPUT), ("EVENT", &EVENT)];
        let mut ts = String::from("// Written by the backend's tests from server/src/rules.rs, where they change.\n\n");
        ts += "/** How a kind of name is spelled, and the names it may not take. */\n";
        ts += "export type Shape = { pattern: RegExp; except: readonly string[] };\n\n";
        for (name, s) in shapes {
            ts += &format!("export const {name}: Shape = {{ pattern: {}, except: {:?} }};\n", pattern(s), s.except);
        }
        ts += &format!("\nexport const EVERY_MS = [{}, {}] as const;\nexport const KEEP_S = [{}, {}] as const;\n", EVERY_MS.0, EVERY_MS.1, KEEP_S.0, KEEP_S.1);
        let path = std::path::Path::new(&std::env::var("TS_RS_EXPORT_DIR").unwrap()).join("rules.ts");
        if std::fs::read_to_string(&path).ok() != Some(ts.clone()) {
            std::fs::write(&path, ts).unwrap();
        }
    }

    #[test]
    fn a_shape_says_what_a_name_needs() {
        assert!(LOCAL.fits("jog_mode") && !TOKEN.fits("jog_mode") && ALIAS.fits("Line_1") && !ALIAS.fits("line"));
        assert!(!INPUT.fits("x") && INPUT.fits("xs") && !EVENT.fits("Pressed"));
        assert_eq!(INPUT.check("w", "an input").unwrap_err(), "\"w\" cannot name an input: start with a small letter, then use letters and digits, and keep clear of name, repeat, x, y, w, h, origin and rotate");
    }
}

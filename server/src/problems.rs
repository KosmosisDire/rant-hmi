//! The problems every screen finds and those runs on the system meet, gathered in one list that
//! the editor shows, `GET /problems` serves and `Hmi/Problems` publishes.

use std::collections::BTreeMap;

use rant::types::Timestamp;
use serde::Serialize;
use tracing::warn;

use crate::protocol::{Level, Problem, Reported, Source};
use crate::status::ProblemRow;

/// How many problems of runs on the system are kept, the oldest going first.
const KEPT: usize = 100;
/// How many problems a screen may have here, so one that sends more is cut short.
const SCREEN_MOST: usize = 200;
/// How many `Hmi/Problems` holds, the newest.
const PUBLISHED: usize = 100;

#[derive(Default)]
pub struct Problems {
    /// Each screen's as it last sent them, each stamped by this host when it came new or again.
    screens: BTreeMap<u32, Vec<Problem>>,
    /// What runs on the system met, newest last.
    ran: Vec<Problem>,
    changed: bool,
}

/// Whether two are the same problem, however often each came.
fn same(a: &Problem, b: &Problem) -> bool {
    a.source == b.source && a.page == b.page && a.element == b.element && a.text == b.text
}

fn now_ms() -> f64 {
    Timestamp::now().us as f64 / 1000.0
}

impl Problems {
    /// Takes a screen's whole list, and logs each problem new to it.
    pub fn screen(&mut self, session: u32, mut list: Vec<Problem>) {
        list.truncate(SCREEN_MOST);
        let had = self.screens.remove(&session).unwrap_or_default();
        let now = now_ms();
        for p in &mut list {
            match had.iter().find(|h| same(h, p)) {
                Some(h) if h.count == p.count => p.at = h.at,
                Some(_) => p.at = now,
                None => {
                    p.at = now;
                    log(session, p);
                }
            }
        }
        self.changed |= list != had;
        if !list.is_empty() {
            self.screens.insert(session, list);
        }
    }

    /// Notes what a run on the system met, once more when it met it before, and says whether it
    /// is new. The run's end already logged it.
    pub fn ran(&mut self, level: Level, text: String, page: Option<String>, element: Option<String>) -> bool {
        let p = Problem { source: Source::Run, level, text, detail: None, page, element, count: 1, at: now_ms() };
        self.changed = true;
        match self.ran.iter_mut().find(|h| same(h, &p)) {
            Some(h) => {
                h.count += 1;
                h.at = p.at;
                false
            }
            None => {
                self.ran.push(p);
                if self.ran.len() > KEPT {
                    self.ran.remove(0);
                }
                true
            }
        }
    }

    /// A screen went, and its problems with it.
    pub fn gone(&mut self, session: u32) {
        self.changed |= self.screens.remove(&session).is_some();
    }

    /// Whether any changed since this was last asked.
    pub fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    /// Every problem: the system's, then each screen's.
    pub fn all(&self) -> Vec<Reported> {
        let ran = self.ran.iter().map(|p| Reported { screen: None, problem: p.clone() });
        ran.chain(self.screens.iter().flat_map(|(s, list)| list.iter().map(|p| Reported { screen: Some(*s), problem: p.clone() }))).collect()
    }

    /// The newest as `Hmi/Problems` holds them.
    pub fn rows(&self) -> Vec<ProblemRow> {
        let mut all = self.all();
        all.sort_by(|a, b| b.problem.at.total_cmp(&a.problem.at));
        all.truncate(PUBLISHED);
        all.iter().map(row).collect()
    }
}

fn row(r: &Reported) -> ProblemRow {
    let p = &r.problem;
    ProblemRow {
        screen: r.screen.unwrap_or(0),
        source: fit(&word(&p.source)),
        level: fit(&word(&p.level)),
        text: fit(&p.text),
        page: fit(p.page.as_deref().unwrap_or("")),
        element: fit(p.element.as_deref().unwrap_or("")),
        count: p.count,
        at: Timestamp { us: (p.at * 1000.0) as i64 },
    }
}

/// A unit variant's word, as the wire spells it.
fn word(v: &impl Serialize) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

/// As much of `s` as a fixed string of `N` bytes holds, cut between characters.
fn fit<const N: usize>(s: &str) -> rant::String<N> {
    let mut end = s.len().min(N);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].try_into().unwrap_or_default()
}

/// Logs a problem a screen found, with the stack of one in the HMI's own code.
fn log(session: u32, p: &Problem) {
    let at = match (&p.page, &p.element) {
        (Some(page), Some(element)) => format!(" on {page} {element}"),
        (Some(page), None) => format!(" on {page}"),
        _ => String::new(),
    };
    let what = match p.source {
        Source::Page => "a page's problem",
        Source::Run => "a handler's problem",
        Source::Hmi => "a fault in the HMI",
    };
    match &p.detail {
        Some(stack) => warn!("screen {session} found {what}{at}: {}\n{stack}", p.text),
        None => warn!("screen {session} found {what}{at}: {}", p.text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(text: &str, count: u32) -> Problem {
        Problem { source: Source::Hmi, level: Level::Fault, text: text.into(), detail: None, page: None, element: None, count, at: 0.0 }
    }

    #[test]
    fn a_screen_keeps_when_each_came_until_it_comes_again() {
        let mut p = Problems::default();
        p.screen(1, vec![found("a", 1)]);
        let first = p.all()[0].problem.at;
        assert!(first > 0.0 && p.take_changed());
        p.screen(1, vec![found("a", 1)]);
        assert_eq!(p.all()[0].problem.at, first);
        assert!(!p.take_changed(), "the same list again is no change");
        p.screen(1, vec![found("a", 2)]);
        assert!(p.take_changed() && p.all()[0].problem.count == 2);
        p.gone(1);
        assert!(p.all().is_empty() && p.take_changed());
    }

    #[test]
    fn a_run_counts_each_time_and_the_oldest_go() {
        let mut p = Problems::default();
        p.ran(Level::Fault, "Start tap: x".into(), Some("main".into()), Some("e1".into()));
        p.ran(Level::Fault, "Start tap: x".into(), Some("main".into()), Some("e1".into()));
        let all = p.all();
        assert_eq!((all.len(), all[0].screen, all[0].problem.count), (1, None, 2));
        for n in 0..KEPT {
            p.ran(Level::Warn, format!("rule {n}"), None, None);
        }
        assert_eq!(p.all().len(), KEPT);
        assert!(p.all().iter().all(|r| r.problem.text != "Start tap: x"), "the oldest stays");
    }

    #[test]
    fn rows_cut_words_between_characters() {
        let cut: rant::String<8> = fit("ééééé");
        assert_eq!(&*cut, "éééé");
        let mut p = Problems::default();
        p.screen(3, vec![found("a", 1)]);
        let rows = p.rows();
        assert_eq!((rows[0].screen, &*rows[0].source, &*rows[0].level), (3, "hmi", "fault"));
    }
}

//! How much a screen's socket or reliable channel may have on its way, as the screen confirms
//! it: on the socket each ping carries the bytes written before it and its pong says they all
//! arrived, and on the channel its acks say so. The socket pings after each piece, not waiting
//! for the last pong, so it hears as pieces arrive, as the channel does. Each keeps on the way
//! what the link carries in its shortest round trip and a margin more, so what it sends next
//! waits that long at most and nothing piles up in buffers it cannot take back. The margin is
//! the least the link keeps its pace with. A link that holds acks and lets them go together, as
//! a busy access point does, needs more on the way, else the window starves it and the rate it
//! measures falls with it. So while the way fills, a wider window is tried from time to time,
//! and the margin grows to it when more arrived with it, else narrows.

use std::collections::VecDeque;
use std::time::Duration;

use crate::lanes::PIECE;

/// The least that may be on the way, so a link not measured yet still moves.
const LEAST: u64 = 2 * PIECE as u64;
/// How long past the shortest round trip what is sent may wait on the way, at first and least,
/// and at most.
const MARGIN: u64 = 2_000;
const MARGIN_MOST: u64 = 100_000;
/// A wider window is tried this often while the way fills, for as long as this at least, and
/// against as long just before it.
const TRY_EVERY: u64 = 500_000;
const TRY: u64 = 200_000;
/// A rate is measured over at least this long, in us, so confirmations that come together do
/// not inflate it.
const SPAN: u64 = 50_000;
/// The highest rate this far back, in us, is what the link carries.
const RATES: u64 = 1_000_000;

/// One way's bytes on the way. Times are in us since it opened.
#[derive(Default)]
pub struct Flight {
    written: u64,
    confirmed: u64,
    /// When the last ping left, and the bytes written by then.
    asked: u64,
    asked_for: u64,
    /// The confirmations of the last second: when the bytes confirmed had all left, how many,
    /// and when they were confirmed.
    heard: VecDeque<(u64, u64, u64)>,
    /// The shortest round trip since it opened. A busy link never shows a shorter one again,
    /// so an older one is not forgotten.
    least: Option<u64>,
    /// Bytes a us the link carried, and when each was measured.
    rates: VecDeque<(u64, f64)>,
    /// The margin, none for `MARGIN`, the wider window's try, and when the next may start.
    margin: Option<u64>,
    trying: Trying,
    next_try: u64,
    /// How long the way was full in all, by the confirmations that found it so, and when the
    /// last came.
    full_for: u64,
    last_heard: u64,
}

/// Where a try of a wider window is, each step from when and the bytes confirmed then.
#[derive(Default)]
enum Trying {
    #[default]
    Rest,
    /// Counts what arrives as it is.
    Before { from: u64, confirmed: u64, full_for: u64 },
    /// Counts what arrives with the window wider, against `before`. A step counts only when the
    /// way was full most of it, else what came says what was sent, not what the link carries.
    Wider { from: u64, confirmed: u64, full_for: u64, before: Option<u64> },
}

impl Flight {
    pub fn wrote(&mut self, bytes: usize) {
        self.written += bytes as u64;
    }

    /// The payload of a ping leaving `now`.
    pub fn ping(&mut self, now: u64) -> [u8; 16] {
        self.asked = now;
        self.asked_for = self.written;
        let mut payload = [0; 16];
        payload[..8].copy_from_slice(&now.to_le_bytes());
        payload[8..].copy_from_slice(&self.written.to_le_bytes());
        payload
    }

    /// A pong come back `now` with its ping's payload, and the round trip it took.
    pub fn pong(&mut self, payload: &[u8], now: u64) -> Option<Duration> {
        let sent = u64::from_le_bytes(payload.get(..8)?.try_into().ok()?);
        let written = u64::from_le_bytes(payload.get(8..16)?.try_into().ok()?);
        // a pong for a ping never sent says nothing
        if sent > self.asked || written > self.written {
            return None;
        }
        let trip = now.checked_sub(sent)?;
        self.trip(trip);
        self.heard(written, sent, now);
        Some(Duration::from_micros(trip))
    }

    /// A round trip of `trip` us, timed some other way.
    pub fn trip(&mut self, trip: u64) {
        self.least = Some(self.least.map_or(trip, |l| l.min(trip)));
    }

    /// How many bytes the way says are still on it `now`, the rest confirmed.
    pub fn on_way(&mut self, bytes: u64, now: u64) {
        let confirmed = self.written.saturating_sub(bytes);
        if confirmed > self.confirmed {
            self.heard(confirmed, now, now);
        }
    }

    /// `confirmed` bytes in all arrived, every one of them sent by `left`.
    fn heard(&mut self, confirmed: u64, left: u64, now: u64) {
        let full = !self.room();
        if full {
            self.full_for += now.saturating_sub(self.last_heard);
        }
        self.last_heard = now;
        self.confirmed = self.confirmed.max(confirmed);
        // the bytes since the last confirmation heard before these left, a span or more
        // earlier, over the longer of the two gaps, as a link may hold confirmations and let
        // them go together
        if let Some(&(l, w, c)) = self.heard.iter().rev().find(|(l, _, c)| *c <= left && l + SPAN <= left) {
            let over = (left - l).max(now - c);
            if confirmed > w {
                self.rates.push_back((now, (confirmed - w) as f64 / over as f64));
            }
        }
        self.heard.push_back((left, confirmed, now));
        while self.heard.front().is_some_and(|(.., c)| c + RATES < now) {
            self.heard.pop_front();
        }
        while self.rates.front().is_some_and(|(at, _)| at + RATES < now) {
            self.rates.pop_front();
        }
        self.steer(now, full);
    }

    /// Tries a wider window while the way fills, and sets the margin by what arrived with it.
    /// `full` says the way was full until these confirmations came.
    fn steer(&mut self, now: u64, full: bool) {
        let margin = self.margin.unwrap_or(MARGIN);
        let least = self.least.unwrap_or(0);
        // a step lasts long enough for what the wider window adds to have come back
        let span = TRY.max(4 * (least + margin));
        let filled = |from: u64, full_for: u64| (self.full_for - full_for) * 4 >= (now - from) * 3;
        self.trying = match std::mem::take(&mut self.trying) {
            Trying::Rest if now >= self.next_try && full => Trying::Before { from: now, confirmed: self.confirmed, full_for: self.full_for },
            Trying::Before { from, confirmed, full_for } if now >= from + span => {
                let before = filled(from, full_for).then_some(self.confirmed - confirmed);
                Trying::Wider { from: now, confirmed: self.confirmed, full_for: self.full_for, before }
            }
            Trying::Wider { from, confirmed, full_for, before } if now >= from + span => {
                let rate = self.rate();
                let more = before.is_some_and(|before| filled(from, full_for) && (self.confirmed - confirmed) * 5 > before * 6);
                // a margin that holds the wider window at the rate it reached
                let wide = (self.carried(margin) * 3 / 2) as f64 / rate.max(f64::MIN_POSITIVE);
                let next = if more { (wide as u64).saturating_sub(least).max(margin) } else { margin * 4 / 5 };
                self.margin = Some(next.clamp(MARGIN, MARGIN_MOST));
                self.next_try = now + TRY_EVERY;
                Trying::Rest
            }
            trying => trying,
        };
    }

    /// Whether more may be written.
    pub fn room(&self) -> bool {
        self.written - self.confirmed < self.window()
    }

    /// Whether the way should be asked what arrived: a piece's worth went since it was last
    /// asked. It never waits for the answer, as one piece a round trip starves a small window.
    pub fn ask(&self) -> bool {
        self.written - self.asked_for >= PIECE as u64
    }

    /// Bytes a us the link carried at most lately.
    fn rate(&self) -> f64 {
        self.rates.iter().map(|(_, r)| *r).fold(0.0, f64::max)
    }

    /// What the link carries in its shortest round trip and `margin` more.
    fn carried(&self, margin: u64) -> u64 {
        LEAST.max((self.rate() * (self.least.unwrap_or(0) + margin) as f64) as u64)
    }

    fn window(&self) -> u64 {
        let window = self.carried(self.margin.unwrap_or(MARGIN));
        match self.trying {
            Trying::Wider { .. } => window * 3 / 2,
            _ => window,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pings at `at` and hears its pong at `back`.
    fn pong(f: &mut Flight, at: u64, back: u64) -> Option<Duration> {
        let payload = f.ping(at);
        f.pong(&payload, back)
    }

    #[test]
    fn a_new_socket_may_have_two_pieces_on_the_way() {
        let mut f = Flight::default();
        f.wrote(2 * PIECE - 1);
        assert!(f.room());
        f.wrote(1);
        assert!(!f.room());
    }

    #[test]
    fn the_way_is_asked_after_each_piece_without_waiting_for_an_answer() {
        let mut f = Flight::default();
        f.wrote(PIECE - 1);
        assert!(!f.ask());
        f.wrote(1);
        assert!(f.ask());
        f.ping(10);
        assert!(!f.ask());
        f.wrote(PIECE);
        assert!(f.ask());
    }

    #[test]
    fn a_pong_confirms_what_was_written_before_its_ping() {
        let mut f = Flight::default();
        f.wrote(2 * PIECE);
        let payload = f.ping(0);
        f.wrote(PIECE);
        assert!(!f.room());
        assert_eq!(f.pong(&payload, 2_000), Some(Duration::from_millis(2)));
        assert!(f.room());
    }

    /// Runs a channel for `ms` that carries `per_ms` bytes a ms while the sender keeps it full,
    /// and confirms each `trip` ms after it went, holding the acks to let them go together each
    /// `held` ms. Gives the bytes confirmed in the last second.
    fn channel(f: &mut Flight, per_ms: u64, trip: u64, held: u64, ms: u64) -> u64 {
        f.trip(trip * 1000);
        let (mut written, mut carried, mut confirmed, mut second_ago) = (0, 0, 0, 0);
        let mut due = VecDeque::new();
        for t in 0..ms {
            while f.room() {
                f.wrote(PIECE);
                written += PIECE as u64;
            }
            carried += (written - carried).min(per_ms);
            due.push_back((t + trip, carried));
            if t % held == 0 {
                while due.front().is_some_and(|(at, _)| *at <= t) {
                    confirmed = due.pop_front().unwrap().1;
                }
            }
            f.on_way(written - confirmed, t * 1000);
            if t + 1000 == ms {
                second_ago = confirmed;
            }
        }
        confirmed - second_ago
    }

    #[test]
    fn the_window_holds_what_the_link_carries_in_its_shortest_trip_and_the_margin() {
        let mut f = Flight::default();
        // 10 MB a second with a 10 ms round trip, acked as it goes, needs no more margin than
        // the least once it is found
        let got = channel(&mut f, 10_000, 10, 1, 10_000);
        assert!(got > 9_500_000, "{got}");
        assert_eq!(f.margin, Some(MARGIN));
    }

    #[test]
    fn acks_let_go_together_widen_the_window_as_far_as_more_arrives() {
        let mut f = Flight::default();
        // an access point holds the acks and lets them go each 20 ms, which a window of the
        // round trip and the margin alone would starve
        let got = channel(&mut f, 10_000, 10, 20, 3000);
        assert!(got > 8_500_000, "{got}");
    }

    #[test]
    fn pongs_let_go_together_do_not_inflate_the_rate() {
        let mut f = Flight::default();
        pong(&mut f, 0, 1_000);
        f.wrote(10_000);
        let one = f.ping(60_000);
        f.wrote(10_000);
        let two = f.ping(120_000);
        // the link held both and let them go 10 us apart
        f.pong(&one, 500_000);
        f.pong(&two, 500_010);
        // 20000 bytes in the 499 ms since the pong heard before they left
        assert!(f.window() <= LEAST.max((20_000.0 / 499_000.0 * 101_000.0) as u64));
    }

    #[test]
    fn a_rate_is_forgotten_after_a_second() {
        let mut f = Flight::default();
        pong(&mut f, 0, 1_000);
        f.wrote(1 << 20);
        pong(&mut f, 100_000, 101_000);
        assert!(f.window() > LEAST);
        pong(&mut f, 1_200_000, 1_201_000);
        assert_eq!(f.rate(), 0.0);
    }

    #[test]
    fn a_pong_not_ours_is_ignored() {
        let mut f = Flight::default();
        assert_eq!(f.pong(b"short", 10), None);
        f.wrote(10);
        f.ping(5);
        let mut later = [0; 16];
        later[..8].copy_from_slice(&6u64.to_le_bytes());
        assert_eq!(f.pong(&later, 10), None);
        let mut more = [0; 16];
        more[..8].copy_from_slice(&5u64.to_le_bytes());
        more[8..].copy_from_slice(&11u64.to_le_bytes());
        assert_eq!(f.pong(&more, 10), None);
        assert_eq!(f.confirmed, 0);
    }
}

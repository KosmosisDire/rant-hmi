//! How much a screen's socket may have on its way, as the screen confirms it: each ping carries
//! the bytes written before it, and its pong says they all arrived. The socket keeps on the way
//! what the link carries in its shortest round trip and `MARGIN` more, so what it sends next
//! waits that long at most and nothing piles up in buffers it cannot take back.

use std::collections::VecDeque;
use std::time::Duration;

use crate::lanes::PIECE;

/// The least a socket may have on its way, so a link not measured yet still moves.
const LEAST: u64 = 2 * PIECE as u64;
/// How long past the shortest round trip what a socket sends may wait on the way.
const MARGIN: u64 = 100_000;
/// A rate is measured over at least this long, in us, so pongs that come together do not
/// inflate it.
const SPAN: u64 = 50_000;
/// The highest rate this far back, in us, is what the link carries.
const RATES: u64 = 1_000_000;

/// One socket's bytes on the way. Times are in us since the socket opened.
#[derive(Default)]
pub struct Flight {
    written: u64,
    confirmed: u64,
    /// When the last ping left, and when the newest one answered had.
    asked: u64,
    answered: u64,
    /// The pongs of the last second: when each one's ping left, the bytes written before it,
    /// and when it came back.
    pongs: VecDeque<(u64, u64, u64)>,
    /// The shortest round trip since the socket opened. A busy link never shows a shorter one
    /// again, so an older one is not forgotten.
    least: Option<u64>,
    /// Bytes a us the link carried, and when each was measured.
    rates: VecDeque<(u64, f64)>,
}

impl Flight {
    pub fn wrote(&mut self, bytes: usize) {
        self.written += bytes as u64;
    }

    /// The payload of a ping leaving `now`.
    pub fn ping(&mut self, now: u64) -> [u8; 16] {
        self.asked = now;
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
        self.least = Some(self.least.map_or(trip, |l| l.min(trip)));
        self.confirmed = self.confirmed.max(written);
        self.answered = self.answered.max(sent);
        // the bytes since the last pong heard before this ping left, a span or more earlier,
        // over the longer of the two gaps, as a link may hold pongs and let them go together
        if let Some(&(s, w, c)) = self.pongs.iter().rev().find(|(s, _, c)| *c <= sent && s + SPAN <= sent) {
            let over = (sent - s).max(now - c);
            if written > w {
                self.rates.push_back((now, (written - w) as f64 / over as f64));
            }
        }
        self.pongs.push_back((sent, written, now));
        while self.pongs.front().is_some_and(|(.., c)| c + RATES < now) {
            self.pongs.pop_front();
        }
        while self.rates.front().is_some_and(|(at, _)| at + RATES < now) {
            self.rates.pop_front();
        }
        Some(Duration::from_micros(trip))
    }

    /// Whether the socket may write more.
    pub fn room(&self) -> bool {
        self.written - self.confirmed < self.window()
    }

    /// Whether a ping is on its way, whose pong confirms more.
    pub fn asking(&self) -> bool {
        self.asked > self.answered
    }

    fn window(&self) -> u64 {
        let rate = self.rates.iter().map(|(_, r)| *r).fold(0.0, f64::max);
        let carried = rate * (self.least.unwrap_or(0) + MARGIN) as f64;
        LEAST.max(carried as u64)
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
        assert!(!f.asking());
        f.ping(10);
        assert!(f.asking());
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
        assert!(!f.asking());
    }

    #[test]
    fn the_window_holds_what_the_link_carries_in_its_shortest_trip_and_the_margin() {
        let mut f = Flight::default();
        // 150 KB/s with a 10 ms round trip: a ping each 50 ms, behind what was written since
        let rate = 150.0 * 1024.0 / 1e6;
        pong(&mut f, 0, 10_000);
        for n in 1..=20u64 {
            f.wrote((rate * 50_000.0) as usize);
            pong(&mut f, n * 50_000, n * 50_000 + 10_000);
        }
        let want = rate * 110_000.0;
        assert!((f.window() as f64 - want).abs() < want * 0.05, "{} against {want}", f.window());
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
        assert_eq!(f.window(), LEAST);
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
        assert!(f.asking());
    }
}

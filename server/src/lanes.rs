//! What a screen is sent, in lanes that take turns, as Rant's transport sends a peer's topics:
//! each message is cut into pieces and each lane with work sends a piece's worth in its turn,
//! so a small message never waits behind a whole picture, nor small ones behind each other.
//! What is not values, then small values, go first when they have work, so a picture slows to
//! leave them room. A piece is a binary frame, `[u16 lane][u8 more]` then its share of the
//! message, `more` 1 while pieces of it follow. A lane that keeps only the latest holds one message waiting at
//! most, as Rant's KEEP_LAST does, so a camera on a slow link sends what is newest at the
//! rate the link carries.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use axum::body::Bytes;
use tokio::sync::Notify;

/// The most of a message one piece carries.
pub const PIECE: usize = 8 << 10;
/// Everything but values: pages, edits, answers. It goes first whenever it has work.
pub const CONTROL: u16 = 0;
/// Values small enough to share a message. They go next whenever they have work.
pub const VALUES: u16 = 1;

#[derive(Default)]
struct Inner {
    /// Each lane's messages, its first one sent as far as `at`.
    lanes: HashMap<u16, VecDeque<Bytes>>,
    at: HashMap<u16, usize>,
    /// The lanes with work, in their turn, and what the first has sent in its turn.
    turn: VecDeque<u16>,
    spent: usize,
    closed: bool,
}

/// One screen's lanes, filled by the app's loop and emptied by its socket's writer.
#[derive(Default)]
pub struct Lanes {
    inner: Mutex<Inner>,
    ready: Notify,
}

impl Lanes {
    /// Puts a message on a lane. With `latest` it replaces those waiting there, but not one
    /// that has begun to go.
    pub fn put(&self, lane: u16, message: Bytes, latest: bool) {
        let mut l = self.inner.lock().expect("lanes");
        let Inner { lanes, at, turn, spent, .. } = &mut *l;
        let queue = lanes.entry(lane).or_default();
        if latest {
            queue.truncate(usize::from(at.contains_key(&lane)));
        }
        queue.push_back(message);
        if !turn.contains(&lane) {
            let at = match lane {
                CONTROL => 0,
                VALUES => usize::from(turn.front() == Some(&CONTROL)),
                _ => turn.len(),
            };
            turn.insert(at, lane);
            if at == 0 {
                *spent = 0;
            }
        }
        drop(l);
        self.ready.notify_one();
    }

    /// How many messages wait on a lane, not counting one begun.
    pub fn waiting(&self, lane: u16) -> usize {
        let l = self.inner.lock().expect("lanes");
        l.lanes.get(&lane).map_or(0, |q| q.len() - usize::from(l.at.contains_key(&lane)))
    }

    /// Drops the messages waiting on a lane, but not one begun.
    pub fn clear(&self, lane: u16) {
        let mut l = self.inner.lock().expect("lanes");
        let Inner { lanes, at, turn, spent, .. } = &mut *l;
        if let Some(queue) = lanes.get_mut(&lane) {
            queue.truncate(usize::from(at.contains_key(&lane)));
            if queue.is_empty() && turn.front() == Some(&lane) {
                *spent = 0;
            }
            if queue.is_empty() {
                turn.retain(|l| *l != lane);
            }
        }
    }

    /// No more messages: the writer ends once it has sent what waits.
    pub fn close(&self) {
        self.inner.lock().expect("lanes").closed = true;
        self.ready.notify_one();
    }

    /// The next piece, taken from the lane whose turn it is. Waits for one, or None once
    /// closed and empty.
    pub async fn next(&self) -> Option<Bytes> {
        loop {
            let ready = self.ready.notified();
            if let Some(piece) = self.take() {
                return Some(piece);
            }
            if self.inner.lock().expect("lanes").closed {
                return None;
            }
            ready.await;
        }
    }

    pub(crate) fn take(&self) -> Option<Bytes> {
        let mut l = self.inner.lock().expect("lanes");
        let Inner { lanes, at, turn, spent, .. } = &mut *l;
        let lane = *turn.front()?;
        let queue = lanes.get_mut(&lane)?;
        let message = queue.front()?.clone();
        let from = at.get(&lane).copied().unwrap_or(0);
        let end = (from + PIECE).min(message.len());
        let more = end < message.len();
        let mut piece = Vec::with_capacity(3 + end - from);
        piece.extend_from_slice(&lane.to_le_bytes());
        piece.push(more as u8);
        piece.extend_from_slice(&message[from..end]);
        if more {
            at.insert(lane, end);
        } else {
            queue.pop_front();
            at.remove(&lane);
        }
        // a lane that has sent a piece's worth waits for the others' turns
        *spent += end - from;
        if queue.is_empty() || *spent >= PIECE {
            turn.pop_front();
            *spent = 0;
            if !queue.is_empty() {
                turn.push_back(lane);
            }
        }
        Some(piece.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lane_of(piece: &[u8]) -> (u16, bool, usize) {
        (u16::from_le_bytes([piece[0], piece[1]]), piece[2] == 1, piece.len() - 3)
    }

    #[test]
    fn a_large_message_goes_in_pieces_that_join_back_into_it() {
        let lanes = Lanes::default();
        let message: Vec<u8> = (0..PIECE * 2 + 5).map(|i| i as u8).collect();
        lanes.put(5, message.clone().into(), false);
        let mut joined = Vec::new();
        let mut pieces = 0;
        while let Some(piece) = lanes.take() {
            let (lane, more, _) = lane_of(&piece);
            assert_eq!(lane, 5);
            joined.extend_from_slice(&piece[3..]);
            pieces += 1;
            assert_eq!(more, joined.len() < message.len());
        }
        assert_eq!((pieces, joined), (3, message));
    }

    #[test]
    fn control_then_small_values_go_before_the_lanes_taking_turns() {
        let lanes = Lanes::default();
        lanes.put(7, vec![0; PIECE * 3].into(), false);
        lanes.put(VALUES, vec![1; 10].into(), false);
        lanes.put(CONTROL, vec![2; 10].into(), false);
        let order: Vec<(u16, bool, usize)> = std::iter::from_fn(|| lanes.take()).map(|p| lane_of(&p)).collect();
        assert_eq!(order, vec![(CONTROL, false, 10), (VALUES, false, 10), (7, true, PIECE), (7, true, PIECE), (7, false, PIECE)]);
    }

    #[test]
    fn a_small_value_waits_for_the_piece_being_sent_at_most() {
        let lanes = Lanes::default();
        lanes.put(7, vec![0; PIECE * 4].into(), false);
        lanes.put(8, vec![0; PIECE * 4].into(), false);
        assert_eq!(lane_of(&lanes.take().unwrap()).0, 7);
        lanes.put(VALUES, vec![1; 10].into(), false);
        let next: Vec<u16> = std::iter::from_fn(|| lanes.take()).take(3).map(|p| lane_of(&p).0).collect();
        assert_eq!(next, vec![VALUES, 8, 7]);
    }

    #[test]
    fn a_lane_of_small_messages_sends_a_piece_s_worth_in_its_turn() {
        let lanes = Lanes::default();
        lanes.put(7, vec![0; PIECE * 2].into(), false);
        for _ in 0..3 {
            lanes.put(VALUES, vec![1; PIECE / 2].into(), false);
        }
        let order: Vec<u16> = std::iter::from_fn(|| lanes.take()).map(|p| lane_of(&p).0).collect();
        assert_eq!(order, vec![VALUES, VALUES, 7, VALUES, 7]);
    }

    #[test]
    fn a_latest_lane_keeps_the_newest_waiting_and_finishes_the_one_begun() {
        let lanes = Lanes::default();
        lanes.put(7, vec![1; PIECE * 2].into(), true);
        lanes.put(7, vec![2; 10].into(), true);
        assert_eq!(lanes.take().map(|p| p[3]), Some(2));
        lanes.put(7, vec![3; PIECE * 2].into(), true);
        assert_eq!(lanes.take().map(|p| (p[2], p[3])), Some((1, 3)));
        // begun, so it stays, and only the newest of those after it waits
        lanes.put(7, vec![4; 10].into(), true);
        lanes.put(7, vec![5; 10].into(), true);
        assert_eq!(lanes.waiting(7), 1);
        let rest: Vec<u8> = std::iter::from_fn(|| lanes.take()).map(|p| p[3]).collect();
        assert_eq!(rest, vec![3, 5]);
    }

    #[test]
    fn clearing_a_lane_keeps_the_message_begun() {
        let lanes = Lanes::default();
        lanes.put(VALUES, vec![1; PIECE * 2].into(), false);
        lanes.put(VALUES, vec![2; 10].into(), false);
        lanes.take();
        lanes.clear(VALUES);
        assert_eq!(lanes.waiting(VALUES), 0);
        let rest: Vec<(bool, u8)> = std::iter::from_fn(|| lanes.take()).map(|p| (p[2] == 1, p[3])).collect();
        assert_eq!(rest, vec![(false, 1)]);
        lanes.put(VALUES, vec![3; 10].into(), false);
        lanes.clear(VALUES);
        assert!(lanes.take().is_none());
    }

    #[tokio::test]
    async fn the_writer_ends_once_closed_and_empty() {
        let lanes = Lanes::default();
        lanes.put(CONTROL, vec![1].into(), false);
        lanes.close();
        assert!(lanes.next().await.is_some());
        assert!(lanes.next().await.is_none());
    }
}

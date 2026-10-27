//! What a screen is sent on its socket or its second way, in lanes that take turns, as
//! Rant's transport sends a peer's topics: each message is cut into pieces and each lane with
//! work sends a piece's worth in its turn, so a small message never waits behind a whole
//! picture, nor small ones behind each other. What is not values, then small values, go first
//! when they have work, so a picture slows to leave them room, and a message of theirs that fits
//! a piece goes even while the way is full. A piece is a binary frame, `[u16 lane][u8 more]`
//! then its share of the message, `more` 1 while pieces of it follow. A big value's lane has
//! `BIG` set, so the page hands its messages to its data worker unread. A lane that keeps only
//! the latest holds one message waiting at most, as Rant's KEEP_LAST does, so a camera on a slow
//! link sends what is newest at the rate the link carries. A video's lane keeps every frame,
//! since each needs those before it. Small values go only as fast as the page says it applied
//! them, which its pings tell, so a page that stalls or hides gets what is newest when it goes
//! on, never all it missed from the link's buffers.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use tokio::sync::Notify;

use crate::rtc::FRAME_LATE;

/// The most of a message one piece carries, and the most a value may be to share a message.
/// Bigger pieces cost less on both ends, and past this a slow link falls behind.
pub const PIECE: usize = 16 << 10;
/// Everything but values: pages, edits, answers. It goes first whenever it has work.
pub const CONTROL: u16 = 0;
/// Values small enough to share a message. They go next whenever they have work.
pub const VALUES: u16 = 1;
/// Set on the lane of each import's value too big to share a message.
pub const BIG: u16 = 0x8000;
/// A screen with this many batches of small values waiting gets no more, and then all values
/// at once in place of those waiting, so a link that stalls a while never carries what is no
/// longer so.
const BEHIND: usize = 8;
/// A batch of small values the page has not said it applied this long after it went holds the
/// batches after it, so the link's buffers never fill with values a stalled page reads late.
/// A link whose round trip and the page's ping are within this is never held, and a farther
/// one is allowed its round trip (`allow`).
pub const LAG: Duration = Duration::from_millis(250);

#[derive(Default)]
struct Inner {
    /// Each lane's messages with when each came and, for a batch of small values, its number,
    /// its first one sent as far as `at`.
    lanes: HashMap<u16, VecDeque<(Bytes, Instant, Option<u64>)>>,
    at: HashMap<u16, usize>,
    /// The batches of small values sent that the page has not said it applied, each with when
    /// it went, oldest first, and how long one may go unsaid, LAG for None.
    sent: VecDeque<(u64, Instant)>,
    lag: Option<Duration>,
    /// The lanes with work, in their turn, and what the first has sent in its turn.
    turn: VecDeque<u16>,
    spent: usize,
    closed: bool,
    /// The lane of each import whose value is too big to share a message.
    own: HashMap<String, u16>,
    /// The lane of each import whose video the screen decodes itself.
    videos: HashMap<String, Video>,
    /// Small values were left out while too many waited, so the screen needs them all.
    stale: bool,
}

/// A lane of H264 frames. A frame decodes only after those before it back to a keyframe, so
/// once any is left out the lane waits for the next keyframe.
struct Video {
    lane: u16,
    /// It left frames out, or has sent none yet.
    skipping: bool,
}

impl Inner {
    /// A lane of its own for an import, as neither kind of own lane is ever given back.
    fn new_lane(&self) -> u16 {
        VALUES + 1 + (self.own.len() + self.videos.len()) as u16
    }

    /// Puts a message on a lane. With `latest` it replaces those waiting there, but not one
    /// that has begun to go. `batch` numbers a batch of small values.
    fn push(&mut self, lane: u16, message: Bytes, came: Instant, latest: bool, batch: Option<u64>) {
        let Inner { lanes, at, turn, spent, .. } = self;
        let queue = lanes.entry(lane).or_default();
        if latest {
            queue.truncate(usize::from(at.contains_key(&lane)));
        }
        queue.push_back((message, came, batch));
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
    }

    /// The first message waiting on a lane, not one begun.
    fn first_waiting(&self, lane: u16) -> Option<&(Bytes, Instant, Option<u64>)> {
        self.lanes.get(&lane)?.get(usize::from(self.at.contains_key(&lane)))
    }

    /// Whether the page is behind on small values: a batch it has not said it applied went
    /// over LAG ago.
    fn behind(&self) -> bool {
        self.sent.front().is_some_and(|(_, went)| went.elapsed() > self.lag.unwrap_or(LAG))
    }

    /// Drops the messages waiting on a lane, but not one begun.
    fn clear(&mut self, lane: u16) {
        let Inner { lanes, at, turn, spent, .. } = self;
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
}

/// One screen's lanes, filled by the app's loop and emptied by its socket's writer or the
/// task that owns its channels.
#[derive(Default)]
pub struct Lanes {
    inner: Mutex<Inner>,
    ready: Notify,
    /// The bytes its way has taken from them, for the rate `Hmi/Clients` shows.
    taken: AtomicU64,
}

impl Lanes {
    /// Sends what is not values.
    pub fn send(&self, message: Bytes) {
        self.put(CONTROL, message, false);
    }

    /// Sends batch `seq` of small values, but leaves it out while too many wait.
    pub fn values(&self, seq: u64, message: Bytes) {
        if self.waiting(VALUES) >= BEHIND {
            self.inner.lock().expect("lanes").stale = true;
            return;
        }
        self.inner.lock().expect("lanes").push(VALUES, message, Instant::now(), false, Some(seq));
        self.ready.notify_one();
    }

    /// The page's word of a batch takes the link's round trip and the ping after it, so a link
    /// with this round trip is allowed that long, LAG at least, before its batches are held.
    pub fn allow(&self, rtt: Duration) {
        self.inner.lock().expect("lanes").lag = Some(LAG.max(rtt * 2 + Duration::from_millis(100)));
    }

    /// The page said it applied batch `seen` of small values, and so every one before it, which
    /// lets the batches after go.
    pub fn confirm(&self, seen: u64) {
        let mut l = self.inner.lock().expect("lanes");
        while l.sent.front().is_some_and(|(seq, _)| *seq <= seen) {
            l.sent.pop_front();
        }
        drop(l);
        self.ready.notify_one();
    }

    /// Sends the answer to a ping in the values' lane, so it times what values wait, but never
    /// leaves it out, so a way that falls behind shows in it.
    pub fn pong(&self, message: Bytes) {
        self.put(VALUES, message, false);
    }

    /// Sends one import's value too big to share a message, in that import's own lane, which
    /// keeps only the latest.
    pub fn alone(&self, alias: &str, message: Bytes) {
        let lane = {
            let mut l = self.inner.lock().expect("lanes");
            let next = l.new_lane() | BIG;
            *l.own.entry(alias.to_owned()).or_insert(next)
        };
        self.put(lane, message, true);
    }

    /// Sends a frame of an import's video in that video's own lane, which keeps every frame in
    /// order from a keyframe on. A keyframe replaces the frames waiting, as nothing after it
    /// needs them. A frame that would wait behind one that came over FRAME_LATE ago is left out
    /// with those waiting, and the lane goes on from the next keyframe, so a link too slow for
    /// the video shows it late by that at most.
    pub fn video(&self, alias: &str, keyframe: bool, message: Bytes, came: Instant) {
        let mut l = self.inner.lock().expect("lanes");
        let next = l.new_lane();
        let lane = l.videos.entry(alias.to_owned()).or_insert(Video { lane: next, skipping: true }).lane;
        let behind = l.first_waiting(lane).is_some_and(|(_, came, _)| came.elapsed() > FRAME_LATE);
        let video = l.videos.get_mut(alias).expect("its lane was just found");
        video.skipping = !keyframe && (video.skipping || behind);
        if video.skipping {
            l.clear(lane);
            return;
        }
        l.push(lane, message, came, keyframe, None);
        drop(l);
        self.ready.notify_one();
    }

    /// Stops sending an import's video. Frames waiting are dropped, and the video starts from a
    /// keyframe if it plays again.
    pub fn stop_video(&self, alias: &str) {
        let mut l = self.inner.lock().expect("lanes");
        let Some(video) = l.videos.get_mut(alias) else { return };
        video.skipping = true;
        let lane = video.lane;
        l.clear(lane);
    }

    /// True once for a screen that missed small values. Those still waiting are dropped, as
    /// all values follow.
    pub fn missed(&self) -> bool {
        let mut l = self.inner.lock().expect("lanes");
        let missed = std::mem::take(&mut l.stale);
        if missed {
            l.clear(VALUES);
        }
        missed
    }

    /// Puts a message on a lane. With `latest` it replaces those waiting there, but not one
    /// that has begun to go.
    fn put(&self, lane: u16, message: Bytes, latest: bool) {
        self.inner.lock().expect("lanes").push(lane, message, Instant::now(), latest, None);
        self.ready.notify_one();
    }

    /// How many messages wait on a lane, not counting one begun.
    fn waiting(&self, lane: u16) -> usize {
        let l = self.inner.lock().expect("lanes");
        l.lanes.get(&lane).map_or(0, |q| q.len() - usize::from(l.at.contains_key(&lane)))
    }

    /// Whether a big value of an import waits on its own lane, not begun, which a newer one put
    /// there would replace.
    pub fn holds(&self, alias: &str) -> bool {
        let lane = self.inner.lock().expect("lanes").own.get(alias).copied();
        lane.is_some_and(|lane| self.waiting(lane) > 0)
    }

    /// No more messages: the writer ends once it has sent what waits.
    pub fn close(&self) {
        self.inner.lock().expect("lanes").closed = true;
        self.ready.notify_one();
    }

    /// Closed with nothing left to send.
    fn done(&self) -> bool {
        let l = self.inner.lock().expect("lanes");
        l.closed && l.turn.is_empty()
    }

    /// The bytes taken from them so far.
    pub fn taken(&self) -> u64 {
        self.taken.load(AtomicOrdering::Relaxed)
    }

    /// Waits until something was put on them, or they closed.
    pub async fn ready(&self) {
        self.ready.notified().await;
    }

    /// Whether the loop is done with them.
    pub fn closed(&self) -> bool {
        self.inner.lock().expect("lanes").closed
    }

    /// The next piece, taken from the lane whose turn it is, and without `room` only a small
    /// message of control or values, values only while the page keeps up. Waits for one, or
    /// None once closed and empty.
    pub async fn next(&self, room: bool) -> Option<Bytes> {
        loop {
            let ready = self.ready.notified();
            if let Some(piece) = self.take(room) {
                return Some(piece);
            }
            if self.done() {
                return None;
            }
            ready.await;
        }
    }

    pub(crate) fn take(&self, room: bool) -> Option<Bytes> {
        let mut l = self.inner.lock().expect("lanes");
        // values held take no turn, so the other lanes go on past them
        let next = l.turn.iter().position(|&lane| lane != VALUES || !l.behind())?;
        if next > 0 {
            let lane = l.turn.remove(next).expect("it was just found");
            l.turn.push_front(lane);
            l.spent = 0;
        }
        let Inner { lanes, at, turn, spent, sent, .. } = &mut *l;
        let lane = *turn.front()?;
        let queue = lanes.get_mut(&lane)?;
        let (message, _, batch) = queue.front()?.clone();
        if !room && (lane > VALUES || message.len() > PIECE) {
            return None;
        }
        let from = at.get(&lane).copied().unwrap_or(0);
        let end = (from + PIECE).min(message.len());
        let more = end < message.len();
        let mut piece = Vec::with_capacity(3 + end - from);
        piece.extend_from_slice(&lane.to_le_bytes());
        piece.push(more as u8);
        piece.extend_from_slice(&message[from..end]);
        self.taken.fetch_add(piece.len() as u64, AtomicOrdering::Relaxed);
        if more {
            at.insert(lane, end);
        } else {
            queue.pop_front();
            at.remove(&lane);
            if let Some(seq) = batch {
                sent.push_back((seq, Instant::now()));
            }
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
        while let Some(piece) = lanes.take(true) {
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
        let order: Vec<(u16, bool, usize)> = std::iter::from_fn(|| lanes.take(true)).map(|p| lane_of(&p)).collect();
        assert_eq!(order, vec![(CONTROL, false, 10), (VALUES, false, 10), (7, true, PIECE), (7, true, PIECE), (7, false, PIECE)]);
    }

    #[test]
    fn only_small_control_and_values_go_without_room() {
        let lanes = Lanes::default();
        lanes.put(7, vec![0; PIECE * 2].into(), false);
        assert!(lanes.take(false).is_none());
        lanes.put(VALUES, vec![1; 10].into(), false);
        lanes.put(CONTROL, vec![2; PIECE + 1].into(), false);
        // control too big for a piece waits for room, then the small value goes without
        assert!(lanes.take(false).is_none());
        assert_eq!(lanes.take(true).map(|p| lane_of(&p)), Some((CONTROL, true, PIECE)));
        assert_eq!(lanes.take(false).map(|p| lane_of(&p)), Some((VALUES, false, 10)));
        assert!(lanes.take(false).is_none());
    }

    #[test]
    fn a_small_value_waits_for_the_piece_being_sent_at_most() {
        let lanes = Lanes::default();
        lanes.put(7, vec![0; PIECE * 4].into(), false);
        lanes.put(8, vec![0; PIECE * 4].into(), false);
        assert_eq!(lane_of(&lanes.take(true).unwrap()).0, 7);
        lanes.put(VALUES, vec![1; 10].into(), false);
        let next: Vec<u16> = std::iter::from_fn(|| lanes.take(true)).take(3).map(|p| lane_of(&p).0).collect();
        assert_eq!(next, vec![VALUES, 8, 7]);
    }

    #[test]
    fn a_lane_of_small_messages_sends_a_piece_s_worth_in_its_turn() {
        let lanes = Lanes::default();
        lanes.put(7, vec![0; PIECE * 2].into(), false);
        for _ in 0..3 {
            lanes.put(VALUES, vec![1; PIECE / 2].into(), false);
        }
        let order: Vec<u16> = std::iter::from_fn(|| lanes.take(true)).map(|p| lane_of(&p).0).collect();
        assert_eq!(order, vec![VALUES, VALUES, 7, VALUES, 7]);
    }

    #[test]
    fn a_latest_lane_keeps_the_newest_waiting_and_finishes_the_one_begun() {
        let lanes = Lanes::default();
        lanes.put(7, vec![1; PIECE * 2].into(), true);
        lanes.put(7, vec![2; 10].into(), true);
        assert_eq!(lanes.take(true).map(|p| p[3]), Some(2));
        lanes.put(7, vec![3; PIECE * 2].into(), true);
        assert_eq!(lanes.take(true).map(|p| (p[2], p[3])), Some((1, 3)));
        // begun, so it stays, and only the newest of those after it waits
        lanes.put(7, vec![4; 10].into(), true);
        lanes.put(7, vec![5; 10].into(), true);
        assert_eq!(lanes.waiting(7), 1);
        let rest: Vec<u8> = std::iter::from_fn(|| lanes.take(true)).map(|p| p[3]).collect();
        assert_eq!(rest, vec![3, 5]);
    }

    #[test]
    fn clearing_a_lane_keeps_the_message_begun() {
        let lanes = Lanes::default();
        lanes.put(VALUES, vec![1; PIECE * 2].into(), false);
        lanes.put(VALUES, vec![2; 10].into(), false);
        lanes.take(true);
        lanes.inner.lock().unwrap().clear(VALUES);
        assert_eq!(lanes.waiting(VALUES), 0);
        let rest: Vec<(bool, u8)> = std::iter::from_fn(|| lanes.take(true)).map(|p| (p[2] == 1, p[3])).collect();
        assert_eq!(rest, vec![(false, 1)]);
        lanes.put(VALUES, vec![3; 10].into(), false);
        lanes.inner.lock().unwrap().clear(VALUES);
        assert!(lanes.take(true).is_none());
    }

    /// What waits, each message small enough for one piece.
    fn sent(lanes: &Lanes) -> Vec<Bytes> {
        std::iter::from_fn(|| lanes.take(true)).map(|piece| piece.slice(3..)).collect()
    }

    #[test]
    fn a_screen_behind_misses_small_values_until_all_go_in_their_place() {
        let lanes = Lanes::default();
        for n in 0..BEHIND + 1 {
            lanes.values(n as u64, Bytes::from(vec![n as u8]));
        }
        assert_eq!(lanes.waiting(VALUES), BEHIND);
        // a picture and what is not values still go
        lanes.alone("Cam", Bytes::from_static(b"picture"));
        lanes.send(Bytes::from_static(b"page"));
        assert!(lanes.missed());
        assert!(!lanes.missed());
        lanes.values(9, Bytes::from_static(b"all"));
        let all = [Bytes::from_static(b"page"), Bytes::from_static(b"all"), Bytes::from_static(b"picture")];
        assert_eq!(sent(&lanes), all);
    }

    /// Makes the oldest batch sent and not applied look older than LAG.
    fn aged(lanes: &Lanes) {
        lanes.inner.lock().unwrap().sent[0].1 = Instant::now() - LAG - Duration::from_millis(1);
    }

    #[test]
    fn small_values_wait_once_the_page_is_behind_by_lag_until_it_says_it_applied_them() {
        let lanes = Lanes::default();
        lanes.values(1, Bytes::from_static(b"one"));
        lanes.values(2, Bytes::from_static(b"two"));
        assert_eq!(sent(&lanes), [Bytes::from_static(b"one"), Bytes::from_static(b"two")]);
        // batch 1 went over LAG ago and the page said nothing, so the next waits
        aged(&lanes);
        lanes.values(3, Bytes::from_static(b"three"));
        assert!(lanes.take(true).is_none());
        // what is not values, and a picture, still go, past the values held
        lanes.send(Bytes::from_static(b"page"));
        lanes.alone("Cam", Bytes::from_static(b"picture"));
        assert_eq!(sent(&lanes), [Bytes::from_static(b"page"), Bytes::from_static(b"picture")]);
        // it applied batch 1 only, and batch 2 is not old yet, so the next goes
        lanes.confirm(1);
        assert_eq!(sent(&lanes), [Bytes::from_static(b"three")]);
        // once batch 2 is old too, nothing goes until it says it applied that
        aged(&lanes);
        lanes.values(4, Bytes::from_static(b"four"));
        assert!(lanes.take(true).is_none());
        lanes.confirm(3);
        assert_eq!(sent(&lanes), [Bytes::from_static(b"four")]);
        // a pong waits with them, so the round trip shows the page is behind
        aged(&lanes);
        lanes.pong(Bytes::from_static(b"pong"));
        assert!(lanes.take(true).is_none());
        lanes.confirm(4);
        assert_eq!(sent(&lanes), [Bytes::from_static(b"pong")]);
    }

    #[test]
    fn a_far_link_is_allowed_its_round_trip_before_its_values_are_held() {
        let lanes = Lanes::default();
        lanes.allow(Duration::from_secs(1));
        lanes.values(1, Bytes::from_static(b"one"));
        assert_eq!(sent(&lanes), [Bytes::from_static(b"one")]);
        lanes.inner.lock().unwrap().sent[0].1 = Instant::now() - Duration::from_secs(2);
        lanes.values(2, Bytes::from_static(b"two"));
        assert_eq!(sent(&lanes), [Bytes::from_static(b"two")]);
        // past two round trips and the ping the page is behind
        lanes.inner.lock().unwrap().sent[0].1 = Instant::now() - Duration::from_millis(2200);
        lanes.values(3, Bytes::from_static(b"three"));
        assert!(lanes.take(true).is_none());
        // a near link keeps LAG
        lanes.allow(Duration::from_millis(5));
        lanes.inner.lock().unwrap().sent[0].1 = Instant::now() - LAG + Duration::from_millis(50);
        assert_eq!(sent(&lanes), [Bytes::from_static(b"three")]);
    }

    #[test]
    fn each_import_s_value_too_big_to_share_has_its_own_lane() {
        let lanes = Lanes::default();
        lanes.alone("Cam", Bytes::from_static(b"one"));
        lanes.alone("Other", Bytes::from_static(b"two"));
        // the newer replaces the one waiting
        lanes.alone("Cam", Bytes::from_static(b"three"));
        let lanes_of: Vec<(u16, Bytes)> = std::iter::from_fn(|| lanes.take(true)).map(|p| (lane_of(&p).0, p.slice(3..))).collect();
        assert_eq!(lanes_of, vec![((VALUES + 1) | BIG, Bytes::from_static(b"three")), ((VALUES + 2) | BIG, Bytes::from_static(b"two"))]);
    }

    /// Puts a frame of the video Cam, as `name`, which came `ago` ms back.
    fn frame(lanes: &Lanes, name: &'static str, ago: u64) {
        let came = Instant::now() - std::time::Duration::from_millis(ago);
        lanes.video("Cam", name.starts_with('k'), Bytes::from_static(name.as_bytes()), came);
    }

    #[test]
    fn a_video_starts_at_a_keyframe_and_keeps_every_frame_after_it() {
        let lanes = Lanes::default();
        lanes.alone("Cam", Bytes::from_static(b"picture"));
        for name in ["d0", "k1", "d1", "d2"] {
            frame(&lanes, name, 0);
        }
        let lanes_of: Vec<u16> = std::iter::from_fn(|| lanes.take(true)).map(|p| lane_of(&p).0).collect();
        assert_eq!(lanes_of, vec![(VALUES + 1) | BIG, VALUES + 2, VALUES + 2, VALUES + 2]);
        for name in ["k1", "d1", "d2"] {
            frame(&lanes, name, 0);
        }
        assert_eq!(sent(&lanes), [Bytes::from_static(b"k1"), Bytes::from_static(b"d1"), Bytes::from_static(b"d2")]);
    }

    #[test]
    fn a_keyframe_replaces_the_frames_waiting_but_not_one_begun() {
        let lanes = Lanes::default();
        lanes.video("Cam", true, vec![1; PIECE * 2].into(), Instant::now());
        lanes.take(true);
        for name in ["d1", "d2", "k2", "d3"] {
            frame(&lanes, name, 0);
        }
        let rest: Vec<Bytes> = std::iter::from_fn(|| lanes.take(true)).map(|p| p.slice(3..)).collect();
        assert_eq!(rest[0].len(), PIECE);
        assert_eq!(rest[1..], [Bytes::from_static(b"k2"), Bytes::from_static(b"d3")]);
    }

    #[test]
    fn a_frame_behind_one_too_old_leaves_the_video_waiting_for_a_keyframe() {
        let lanes = Lanes::default();
        let late = FRAME_LATE.as_millis() as u64 + 50;
        frame(&lanes, "k1", late);
        frame(&lanes, "d1", 0);
        frame(&lanes, "d2", 0);
        assert!(sent(&lanes).is_empty());
        frame(&lanes, "k2", 0);
        frame(&lanes, "d3", 0);
        assert_eq!(sent(&lanes), [Bytes::from_static(b"k2"), Bytes::from_static(b"d3")]);
    }

    #[test]
    fn a_stopped_video_drops_what_waits_and_starts_again_at_a_keyframe() {
        let lanes = Lanes::default();
        frame(&lanes, "k1", 0);
        frame(&lanes, "d1", 0);
        lanes.stop_video("Cam");
        frame(&lanes, "d2", 0);
        assert!(sent(&lanes).is_empty());
        frame(&lanes, "k2", 0);
        assert_eq!(sent(&lanes), [Bytes::from_static(b"k2")]);
    }

    #[tokio::test]
    async fn the_writer_ends_once_closed_and_empty() {
        let lanes = Lanes::default();
        lanes.put(CONTROL, vec![1].into(), false);
        lanes.close();
        assert!(lanes.next(true).await.is_some());
        assert!(lanes.next(true).await.is_none());
    }
}

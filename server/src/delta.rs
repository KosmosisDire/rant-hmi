//! A big list as the change from one a screen holds: runs of the old list's rows, and the new
//! rows between them. Rows are matched by their bytes wherever they moved, so a map that grew,
//! lost points or was reordered goes as little more than what is new.

/// A list's rows as the matcher reads them: each column's bytes and width, every column as long.
pub struct Rows<'a> {
    pub len: usize,
    pub cols: Vec<(&'a [u8], usize)>,
}

impl Rows<'_> {
    pub fn width(&self) -> usize {
        self.cols.iter().map(|c| c.1).sum()
    }

    /// Row `i`'s hash, each column's value read whole.
    fn hash(&self, i: usize) -> u64 {
        let mut h = 0x243F_6A88_85A3_08D3u64;
        for &(bytes, w) in &self.cols {
            let v = &bytes[i * w..(i + 1) * w];
            h = match w {
                1 => mix(h, v[0] as u64),
                2 => mix(h, u16::from_le_bytes([v[0], v[1]]) as u64),
                4 => mix(h, u32::from_le_bytes([v[0], v[1], v[2], v[3]]) as u64),
                _ => v.chunks(8).fold(h, |h, part| {
                    let mut word = [0u8; 8];
                    word[..part.len()].copy_from_slice(part);
                    mix(h, u64::from_le_bytes(word))
                }),
            };
        }
        let z = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z ^ (z >> 31)
    }

    /// Whether `n` rows from `i` hold the bytes that `o`'s do from `j`.
    fn same(&self, i: usize, o: &Rows, j: usize, n: usize) -> bool {
        self.cols.iter().zip(&o.cols).all(|(&(a, w), &(b, _))| a[i * w..(i + n) * w] == b[j * w..(j + n) * w])
    }
}

fn mix(h: u64, v: u64) -> u64 {
    (h ^ v).wrapping_mul(0x9E37_79B9_7F4A_7C15).rotate_left(23)
}

/// How a list is made from the one a screen holds.
#[derive(Debug, PartialEq)]
pub struct Matched {
    /// In turn: how many new rows, then where a run of the old list's rows starts and how long
    /// it is. The last has no run.
    pub ops: Vec<(usize, usize, usize)>,
    /// The new rows, as ranges.
    pub fresh: Vec<(usize, usize)>,
}

impl Matched {
    /// The ops as varints, each run's start as its distance from where the last run ended.
    pub fn code(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.ops.len() * 4 + 4);
        varint(&mut out, self.ops.len() as u64);
        let mut next = 0i64;
        for &(fresh, at, len) in &self.ops {
            varint(&mut out, fresh as u64);
            let d = at as i64 - next;
            varint(&mut out, ((d << 1) ^ (d >> 63)) as u64);
            varint(&mut out, len as u64);
            next = (at + len) as i64;
        }
        out
    }
}

fn varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push(v as u8 | 0x80);
        v >>= 7;
    }
    out.push(v as u8)
}

/// How `new` is made from `base`, both of the same columns, or None once more than half its rows
/// are new, as the whole list then costs about as much. Every 16th window of `base`'s rows is
/// indexed, and after each run the search resumes where `base` left off, for an insertion or a
/// deletion, before the index is asked.
pub fn matched(base: &Rows, new: &Rows) -> Option<Matched> {
    const P: u64 = 0x0000_0100_0000_01B3;
    let width = new.width();
    // a window of about 32 bytes is found in the index, a run of about 16 goes on one
    let k = 32usize.div_ceil(width).max(1);
    let least = 16usize.div_ceil(width).max(1);
    let stride = 256usize.div_ceil(width).max(1);
    let pk = (1..k).fold(1u64, |a, _| a.wrapping_mul(P));
    let window = |t: &Rows, at: usize| (at..at + k).fold(0u64, |a, i| a.wrapping_mul(P).wrapping_add(t.hash(i)));
    let mut index = Index::new(base.len / stride + 1);
    let mut b = 0;
    while b + k <= base.len {
        index.insert(window(base, b), b);
        b += stride;
    }
    let most = new.len / 2;
    let (mut ops, mut fresh) = (Vec::new(), Vec::new());
    let (mut i, mut from, mut fresh_rows) = (0usize, 0usize, 0usize);
    let mut shift: Option<isize> = None;
    // the window's hash at i, made when first needed after a run
    let mut h: Option<u64> = None;
    while i + k <= new.len {
        let fits = |b: isize| b >= 0 && b as usize + least <= base.len && i + least <= new.len && base.same(b as usize, new, i, least);
        let resumed = shift.and_then(|s| {
            let at = i as isize + s;
            if fits(at) {
                return Some(at as usize);
            }
            // rows gone from the old list just here, or new rows put in before it goes on
            if i == from {
                return (1..=64).map(|d| at + d).find(|&b| fits(b)).map(|b| b as usize);
            }
            let left = from as isize + s;
            (i - from <= 64 && fits(left)).then_some(left as usize)
        });
        let hit = resumed.or_else(|| {
            let wh = *h.get_or_insert_with(|| window(new, i));
            index.get(wh).filter(|&b| b + k <= base.len && base.same(b, new, i, k))
        });
        let Some(b) = hit else {
            if let Some(wh) = h.as_mut()
                && i + k < new.len
            {
                *wh = wh.wrapping_sub(new.hash(i).wrapping_mul(pk)).wrapping_mul(P).wrapping_add(new.hash(i + k));
            }
            i += 1;
            if fresh_rows + (i - from) > most {
                return None;
            }
            continue;
        };
        // the run reaches back as far as it matches, then on 64 rows at a time
        let (mut bb, mut ii) = (b, i);
        while ii > from && bb > 0 && base.same(bb - 1, new, ii - 1, 1) {
            bb -= 1;
            ii -= 1;
        }
        let mut len = i - ii + if resumed.is_some() { least } else { k };
        loop {
            let step = 64.min(new.len - (ii + len)).min(base.len - (bb + len));
            if step == 0 {
                break;
            }
            if base.same(bb + len, new, ii + len, step) {
                len += step;
                continue;
            }
            while base.same(bb + len, new, ii + len, 1) {
                len += 1;
            }
            break;
        }
        if ii > from {
            fresh.push((from, ii));
        }
        fresh_rows += ii - from;
        ops.push((ii - from, bb, len));
        shift = Some(bb as isize - ii as isize);
        i = ii + len;
        from = i;
        h = None;
    }
    if new.len > from {
        fresh.push((from, new.len));
    }
    fresh_rows += new.len - from;
    ops.push((new.len - from, 0, 0));
    (fresh_rows <= most).then_some(Matched { ops, fresh })
}

/// A flat table from a window's hash to where it first starts, open addressed.
struct Index {
    keys: Vec<u64>,
    at: Vec<u32>,
    shift: u32,
}

impl Index {
    fn new(n: usize) -> Index {
        let cap = (n * 2).next_power_of_two().max(16);
        Index { keys: vec![0; cap], at: vec![0; cap], shift: 64 - cap.trailing_zeros() }
    }

    fn slot(&self, k: u64) -> usize {
        (k.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize
    }

    /// Keeps the first start of each hash. A key is never 0, which marks a free slot.
    fn insert(&mut self, k: u64, v: usize) {
        let k = k | 1;
        let mask = self.keys.len() - 1;
        let mut i = self.slot(k);
        loop {
            match self.keys[i] {
                0 => {
                    self.keys[i] = k;
                    self.at[i] = v as u32;
                    return;
                }
                x if x == k => return,
                _ => i = (i + 1) & mask,
            }
        }
    }

    fn get(&self, k: u64) -> Option<usize> {
        let k = k | 1;
        let mask = self.keys.len() - 1;
        let mut i = self.slot(k);
        loop {
            match self.keys[i] {
                0 => return None,
                x if x == k => return Some(self.at[i] as usize),
                _ => i = (i + 1) & mask,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Points of 12 bytes, each made from its number, so equal numbers make equal rows.
    fn points(ids: &[u32]) -> Vec<u8> {
        ids.iter().flat_map(|&n| [n as f32, (n * 3) as f32, (n % 7) as f32]).flat_map(f32::to_le_bytes).collect()
    }

    fn rows(bytes: &[u8]) -> Rows<'_> {
        Rows { len: bytes.len() / 12, cols: vec![(bytes, 12)] }
    }

    /// Checks `m` makes `new` from `base`, and how many of its rows are new.
    fn check(base: &[u8], new: &[u8], m: &Matched) -> usize {
        let mut out = Vec::new();
        let mut fresh = m.fresh.iter().flat_map(|&(a, b)| a..b);
        for &(n, at, len) in &m.ops {
            for _ in 0..n {
                let r = fresh.next().expect("as many new rows as the ops take");
                out.extend_from_slice(&new[r * 12..(r + 1) * 12]);
            }
            out.extend_from_slice(&base[at * 12..(at + len) * 12]);
        }
        assert!(fresh.next().is_none());
        assert!(out == new, "the ops do not make the new list");
        m.ops.iter().map(|o| o.0).sum()
    }

    #[test]
    fn a_list_that_lost_and_gained_rows_goes_as_the_new_ones() {
        let old: Vec<u32> = (0..5000).collect();
        // some gone from the middle, some new at the end and in the middle, and a block moved
        let mut now: Vec<u32> = old.iter().copied().filter(|n| !(1000..1040).contains(n)).collect();
        now.splice(3000..3000, 90_000..90_025);
        now.extend(100_000..100_100);
        let moved: Vec<u32> = now.drain(200..400).collect();
        now.extend(moved);
        let (base, new) = (points(&old), points(&now));
        let m = matched(&rows(&base), &rows(&new)).expect("a change of a few rows");
        assert_eq!(check(&base, &new, &m), 125);
    }

    #[test]
    fn a_list_mostly_new_goes_whole() {
        let old: Vec<u32> = (0..4000).collect();
        let now: Vec<u32> = (0..4000).map(|n| if n % 3 == 0 { n } else { n + 50_000 }).collect();
        assert_eq!(matched(&rows(&points(&old)), &rows(&points(&now))), None);
        // and one the same goes as one run
        let m = matched(&rows(&points(&old)), &rows(&points(&old))).unwrap();
        assert_eq!(m.ops, vec![(0, 0, 4000), (0, 0, 0)]);
    }

    #[test]
    fn the_code_counts_the_ops_and_each_run_from_the_last() {
        let m = Matched { ops: vec![(2, 10, 5), (0, 3, 1), (1, 0, 0)], fresh: vec![(0, 3)] };
        // 2 new then 5 from 10, then 1 from 3, 12 back from 15, then 1 new and no run
        assert_eq!(m.code(), vec![3, 2, 20, 5, 0, 23, 1, 1, 7, 0]);
    }
}

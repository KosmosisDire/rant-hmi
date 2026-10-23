# Large payloads

How a big value, such as a lidar cloud, a map or a picture, reaches a screen as fast as the link
allows, while small messages (pongs, small values, answers) still arrive in about a millisecond.

## The problem

Measured on 2026-10-23 with a sim publishing 15000 lidar points (x, y, z and intensity as f32)
at 10 Hz, on loopback, the release backend and a current client:

- Ping: 1 ms without the lidar, p50 23 ms and p95 66 ms with it.
- A cloud is 234 KB on the mesh and 473 KB as CBOR, 34 bytes a point, so 5 MB/s.
- Backend, per cloud: the mesh value read into a Value takes 13 ms on Rant's thread. The app
  loop copies the whole Value about five times at 2.9 ms each and encodes it twice at 1 ms each,
  so it is busy about 16 ms, and a ping waits behind it.
- Channels: str0m's SCTP carries about 17 MB/s on loopback, so a cloud takes 30 ms to cross, and
  a pong written after it waits for all of it. The socket carries the same cloud in 4 ms.
- Page, per cloud: CBOR decode 4.3 ms (keys read 60000 times) and `shared()` 4.3 ms, on the main
  thread. Drawing is small.
- Pongs that fall between clouds come back in 1 to 2 ms.

On the user's WiFi to arna the same traffic, with cameras, keeps ICMP ping at 165 to 390 ms.

## Parts

1. Format: how a value is written for a screen, and how much work reading it is.
2. Compression: whether a smaller payload pays for its CPU, and on which links.
3. Transport: how much may wait ahead of a small message, and which way bulk goes.
4. Backend work: copies, encodes and the mesh read, and where they run.
5. Page work: decode, `shared()`, and where they run.

## Shapes

| Shape | Example | Why |
| --- | --- | --- |
| Records of numbers | lidar, depth cloud, path of poses | most of the volume, compresses only once shuffled |
| List of numbers | laser scan ranges, joint arrays | a single typed array |
| Grid of small integers | occupancy map | huge and very compressible |
| Bytes | a raw picture | already bytes |
| Records with text | a table of parts | strings and mixed fields |
| Small values | a speed, a state | must never get slower |

## Experiments

### 1. Formats and compression, offline

A Rust bench writes each shape in each format and times the encode, then Chrome times the
decode. Shapes are realistic: a lidar ray cast in a room with 1 cm range noise and integer
intensities (1k, 15k and 100k points), an 80 by 45 depth grid, a 1080 ray scan, a 1000 by
1000 occupancy map, a 640 by 480 RGB picture with sensor noise, a 1000 pose path, a 2000 row
table with text, and one small number.

Formats:

- `generic`: today, a CBOR map a record, as ciborium writes the backend's Value.
- `typed`: a list of numbers as one RFC 8746 typed array, a list of records as columns, each a
  typed array or a list of strings, under one tag.
- `shuf`: each column's bytes transposed before compressing, `dshuf` each element less the one
  before first.
- `q1mm`: positions to whole millimetres, lossy.
- Compressors: LZ4 (lz4_flex, a 40 line JS decoder), zstd 1 and 3 (fzstd in JS), deflate 1 and
  6 (flate2, the browser's DecompressionStream).

The lidar at 15k points, with what each would take over a link (encode, transfer, unpack, decode
and turning columns into frozen records):

| Format | Bytes | WiFi 3 MB/s | LAN 12 MB/s | SCTP 17 MB/s | Gbit 110 MB/s |
| --- | --- | --- | --- | --- | --- |
| generic | 525 KB | 179 ms | 48 ms | 35 ms | 8.7 ms |
| typed | 240 KB | 84 ms | 24 ms | 18 ms | 6.3 ms |
| typed, shuffle, LZ4 | 149 KB | 54 ms | 16 ms | 13 ms | 5.3 ms |
| typed, shuffle, zstd 1 | 143 KB | 53 ms | 17 ms | 13 ms | 6.3 ms |
| 1 mm, delta, shuffle, zstd 1 | 78 KB | 32 ms | 13 ms | 11 ms | 6.7 ms |

Findings:

- Typed columns win on every shape: 2 to 3 times smaller, about free to encode since the
  columns are Rant's own packed bytes, and 0.1 ms to decode against 2 ms (30 ms at 100k).
- Turning columns back into frozen plain records is then most of the page's work: 3 ms at 15k
  points, 20 ms at 100k, 52 ms for the map as a list of numbers. A big list should stay columns
  on the page and become records only where an expression walks it.
- Shuffle then LZ4 is the best default for numbers: about 38% smaller than typed, 0.2 ms to
  encode and 0.4 ms to decode at 15k. It wins on every link up to about gigabit, where it
  breaks even. Delta before the shuffle does not help these floats.
- zstd shrinks the map (2 KB against 6 KB from 1 MB), text tables (16 KB against 28 KB) and raw
  pictures (528 KB against 833 KB) much more, but fzstd decodes only about 50 MB/s, 10 ms for
  the picture. A wasm decoder would change that.
- Deflate is never best: slower to encode than zstd and no smaller.
- Lossy millimetres halve the lidar again, inside any lidar's own noise, but they change the data,
  so only as a choice per import.
- A small value never gains: compression only pays above a few KB.

Narrower numbers, each column shuffled then LZ4, the lidar at 15k:

| Positions as | Bytes | Most it rounds away |
| --- | --- | --- |
| f32 | 149 KB | nothing |
| f16 | 81 KB | 2 mm at 5 m, 4 mm at 10 m, 8 mm at 20 m, 16 mm at 50 m, 31 mm at 100 m |
| whole mm in an i16, to 32 m | 62 KB | 0.5 mm anywhere |

- Narrowing without loss almost never applies to a sensor's numbers: no lidar, depth or scan
  position fits an f16 exactly, as noise fills the low bits. Only whole numbers, such as the
  intensity, and constant fields fit, and shuffling already leaves their empty bytes to LZ4,
  which then packs the f32 intensity smaller (18 KB) than the exact f16 (22 KB). So detecting
  it saves nothing once columns are compressed.
- Narrowing with loss pays, but a fixed step beats f16: smaller, and the same error at any
  range, as point cloud codecs such as Cloudini quantize. It changes the data, so only as a
  choice per import, never by itself.

### 2. End to end, with a link shaper

A relay on this host stands for the link: the backend's sends limited to a rate through a
bounded queue, a delay each way, TCP for the page and its socket, UDP for WebRTC with the
page's view of the backend's candidate pointed at it, dropping when its queue is full as an
access point does. LAN is 12 MB/s, 0.5 ms and 128 KB, WiFi 3 MB/s, 3 ms and 256 KB, and a
jittery WiFi holds each packet up to 10 ms more, those after it waiting behind, as a busy
access point does. The relay spins while it holds packets, since a timer on Windows fires only
each 15 ms, which first made every link 15 to 30 ms slower and bursty. The sim stamps each
cloud, so the page tells its age when its last piece arrives. Besides the ping the page times
an echo: it writes a screen variable every 100 ms and waits for its value to come back, the
way any small value goes, through the loop. Today's backend, 15k points at 10 Hz, channels
then socket:

| Link | Ping p50, p95 | Echo p50 | Clouds a second | MB/s |
| --- | --- | --- | --- | --- |
| loopback | 57, 116 ms / 22, 65 ms | 68 / 35 ms | 10 / 10 | 5.3 |
| LAN | 64, 94 ms / 43, 87 ms | most lost / 17 ms | 6.9, 622 dropped / 9.9 | 3.7 / 5.3 |
| WiFi | 93, 615 ms / 81, 152 ms | most lost / 65 ms | 3.8, 571 dropped / 5.3 | 2.1 / 2.8 |
| jittery WiFi | 93, 259 ms / 117, 1016 ms | most lost / 109 ms | 3.4, 408 dropped / 4.7 | 2.0 / 2.5 |

On the channels most echoes never came back: small values waited behind the full window
until eight batches stood waiting, and then the screen got every value again in their place.

Timing a pong's stages inside the backend showed where it waits:

- The app loop: from its ping arriving to its pong in the lanes, p50 26 to 40 ms, p95 up to
  460 ms, before the transport is involved.
- The loop is busy about 70 ms of every cloud's 100 ms, all in `tick`: `put_values` 32 ms (the
  cloud encoded and copied again for each way and each cut), the rule parameters 19 ms (two
  copies, built though no rule waits on the lidar), dropping the old value 6 ms, the update's
  and the script engine's copies 5 ms each.
- The pacing believes the shortest round trip is the screen's ping, which the loop inflates, so
  the window grows far past what the link needs: with a 5 ms margin on WiFi 220 KB still sat
  in SCTP ahead of each pong. The queue then inflates the pings further.
- When the window is full a pong waits in the lanes for acks, though it goes first among them:
  p95 255 ms on WiFi at today's 100 ms margin.
- The loop sends changed values on a 33 ms tick, which adds up to 33 ms to every value.

### 3. Stage 1: transport

Built, on the branch:

- A ping is answered where it comes in: the channel task, the socket's reader, the app's link.
  The pong goes in the control lane, and the loop only hears that the screen was heard, with
  the round trip it timed. A ping holds no order, so nothing waits on the loop for it.
- A message of control or of small values that fits a piece goes even while the window is
  full. Only bulk waits for room, and small messages wait behind what is in SCTP at most.
- The margin is found per link. It starts at 2 ms. Every half second while the way is full,
  what arrives in a step is counted, then in a step with the window half again as wide. When
  the wider one brought a fifth more, the margin grows to hold it, else it narrows by a fifth.
  A step counts only when the way was full most of it, so a cloud's burst is not taken for the
  link. The socket asks for a pong once half its window is out, not only when full, so it
  never idles a round trip waiting.

Why the margin is found and not fixed, from sweeps of fixed margins:

| Margin | Loopback ping p95 | WiFi ping p50 | Jittery WiFi ping p50, MB/s |
| --- | --- | --- | --- |
| 100 ms, as before | 42 ms | 52 ms, 252 dropped | 60 ms, 1.93, 346 dropped |
| 20 ms | 20 ms | 29 ms | 39 ms, 2.81 |
| 5 ms | 3.4 ms | 15 ms | 22 ms, 0.82 |
| 2 ms | 1.6 ms | 12 ms | 24 ms, 1.17 |

A small margin is best wherever acks come back steadily, and a big one only fills the access
point until it drops. But where acks come in bursts the window must cover the burst, else it
starves the link, the rate it measures falls, and the window with it, down to two pieces.
Adding the most a burst ran ahead of the rate, as BBR does, did not help: when acks come in
regular clumps each clump is the rate times the gap. What shows the need is the link's answer
to a wider window.

Results, channels then socket:

| Link | Ping p50, p95 | Echo p50 | Clouds a second | MB/s | Margin found |
| --- | --- | --- | --- | --- | --- |
| loopback | 1.0, 3.1 ms / 0.7, 2.0 ms | 30 / 1 ms | 10 / 10 | 5.3 | 2 ms |
| LAN | 3.8, 7.7 ms / 2.2, 4.6 ms | 4.5 / 2.8 ms | 9.9 / 9.9 | 5.3 | 2 ms |
| WiFi | 11.6, 15 ms / 11.5, 19 ms | 37 / 30 ms | 5.3 / 5.2 | 2.8 / 2.8 | 2 to 9 ms |
| jittery WiFi | 29, 41 ms / 54, 119 ms | 47 / 57 ms | 5.0 / 5.3 | 2.7 / 2.9 | 3 to 19 ms / to 100 ms |

- No drops, no lost echoes, and the full link everywhere.
- The echo is now mostly the loop, which stage 2 takes on.
- The socket over the jittery link overshoots its margin at first and then narrows it. It is
  the fallback when WebRTC does not open, so it is left for now.
- WiFi carries 5.3 clouds a second of 10: the cloud is too big for 3 MB/s until it is smaller.

### 4. Stage 2: backend

Built, on the branch:

- A list of numbers is one `Numbers`: its kind and Rant's packed bytes behind an `Arc`. A list
  of records whose fields are all numbers, nested structs too, is one `Records`: a column a
  field, cut from the packed elements in one pass. A copy of either shares the bytes.
- Records with any other field (bool, enum, text, a list), and 64 bit whole numbers, stay a
  list of values, as before.
- A member's place in an element comes from the schema's flat table. Every writer has the same
  element, since nested structs match exactly, and a list whose bytes are not count times the
  element's size is read record by record.
- Screens still get the same plain CBOR, written from the columns without making records.
- `put_values` writes each changed value once and cuts the batches from those bytes. Before, the
  cloud was written up to four times, for the whole batch, alone, and per way.

Results, channels then socket:

| Link | Ping p50, p95 | Echo p50 | Clouds a second | Age p50 | MB/s |
| --- | --- | --- | --- | --- | --- |
| loopback | 1.0, 3.2 ms / 0.9, 4.2 ms | 0.9 / 2.2 ms | 9.9 / 10 | 54 / 43 ms | 5.3 |
| LAN | 3.5, 9.0 ms / 2.6, 6.2 ms | 2.4 / 2.1 ms | 9.9 / 9.9 | 76 / 79 ms | 5.3 |
| WiFi | 9.3, 15 ms / 11.6, 19 ms | 10.5 / 12 ms | 5.3 / 5.2 | 262 / 274 ms | 2.8 |
| jittery WiFi | 29, 43 ms / 30, 46 ms | 30 / 30 ms | 4.9 / 4.8 | 289 / 314 ms | 2.7 / 2.5 |

- The echo now equals the ping on every link: a small value no longer waits on the loop. It was
  30 ms on loopback and 37 ms on WiFi after stage 1.
- A cloud is about 60 ms younger when it arrives, 118 then 54 ms on loopback.
- `put_values` takes 3.4 ms a cloud, from 32 ms before stage 1 and 12.6 ms with columns but
  four writes. The loop is busy about 5% of the time, nearly all of it that one write, which
  stage 3 makes a copy.

### 5. Stage 3: page

Built, on the branch:

- To screens, a list of numbers goes as one RFC 8746 typed array, little endian. A list of
  number records goes under tag 41000, which no one has registered, as a map of its columns.
  Files and JSON still get plain lists.
- The page reads each as a frozen list over its columns, a proxy over an empty array, so
  `Array.isArray` holds and every array method works. An item is read when asked for, and a
  record is made the first time and kept, so it is the same one each read.
- `shared()` compares two packed lists byte for byte instead of walking them, and handlers
  read them as they are, as they cannot be copied.
- The scene draws points from the x, y and z columns.

The e2e harness now also times the page: how long the socket or channel's message handler
takes for the piece that completes a cloud (decode, `shared()`, the effects it runs), and how
busy the main thread is in all, from Chrome's own task time. The harness scans every message
itself, about 2% of the main thread.

Results, channels then socket, each the median of three runs, as this machine's own load moved
single runs by up to a factor of two (loopback ping p50 1.0 to 2.4 ms):

| Link | Ping p50, p95 | Echo p50 | Clouds a second | Age p50 | MB/s | Page a cloud |
| --- | --- | --- | --- | --- | --- | --- |
| loopback | 1.2, 8.4 ms / 0.8, 2.0 ms | 0.9 / 1.2 ms | 10 / 10 | 38 / 30 ms | 2.4 | 0.9 / 1.0 ms |
| LAN | 2.8, 5.9 ms / 2.3, 4.9 ms | 2.9 / 2.0 ms | 10 / 10 | 56 / 62 ms | 2.4 | 1.0 / 0.9 ms |
| WiFi | 11.8, 18 ms / 9.8, 15 ms | 11.8 / 10.5 ms | 9.9 / 9.8 | 111 / 130 ms | 2.4 | 0.8 / 0.8 ms |
| jittery WiFi | 28, 45 ms / 29, 52 ms | 29 / 31 ms | 9.9 / 9.8 | 126 / 127 ms | 2.4 | 0.9 / 0.9 ms |

Against stage 2, with the same harness:

- A cloud is 240 KB, from 525 KB. WiFi now carries all 10 clouds a second, from 5.3, and
  each arrives 111 ms old rather than 263 ms. The jittery link likewise, 126 ms from 284 ms.
- The page takes under 1 ms a cloud, from 8.8 ms on loopback and 9.9 ms on WiFi. Its main
  thread is busy 6 to 11%, from 20% on loopback, though it now draws twice the clouds on WiFi.
- Of what is left a cloud, decoding is 0.1 ms and the columns into the scene's buffer 0.1 ms.
  The rest is joining the pieces, three.js taking the new buffer and the garbage collector.
- An expression that walks a packed list pays for it through the proxy, measured in Node: 4 ms
  for the 15k points the first time, records made, and 2 ms each time after. Before, every
  cloud cost 9 ms whether walked or not.

A stall the harness made: on the jittery link the channels' ping now and then stood still for
0.2 to 0.9 s, which stage 2 never showed in 2 minutes. Timing each ping both ways put all of
it on the way down, after the backend wrote the pong: messages written 50 ms apart arrived
together, waiting on one resent piece. The shaper's sockets had Windows' default 64 KB receive
buffer, which loses about half of a 144 KB burst before Node reads it, and its own count of
drops never sees that. Stage 3 leaves the link idle between clouds, so each cloud starts with
a whole window sent at once, up to 175 KB, where stage 2 kept the link full and sent as acks
came. With 8 MB buffers, 4 minutes showed no stall, the slowest ping 79 ms.

What it shows of the backend stays true on a real link: a lost piece holds every message on
the ordered channel, pongs and small values too, until SCTP resends it, and a lost tail waits
for the retransmission timeout.

### 6. Stage 4: compression

Built, on the branch:

- To screens, numbers of 4 KB or more go shuffled then LZ4 compressed, under tag 41001, also
  unregistered, as their typed array's tag and the block with its size first. A column of records is
  compressed on its own. When the block is no smaller, as for noise, the typed array goes as
  it is.
- The page unpacks with the 40 line block decoder, into one kept buffer, then puts each number
  back together into the list's own array.
- Bytes go as they are: LZ4 saves a raw picture a tenth, for 2.9 ms to pack and 2.1 ms to
  unpack, and pictures go as video anyway.

The sim's points were smooth curves, which pack far better than a real lidar's, so it now adds
1 cm of range noise and intensities that vary as a surface's, as experiment 1's ray cast did.
A cloud then packs to 145 KB from 240 KB, as experiment 1 found (149 KB). Encoding it, shuffle
and LZ4 too, takes 0.28 ms, so `put_values` goes over 2 ms for up to a third of the clouds,
from under a tenth.

Two changes made the decoder twice as fast as the one experiment 1 timed, 0.3 ms for the
cloud's four columns run back to back:

- A match that overlaps what it writes was copied byte by byte. Shuffled exponent bytes repeat,
  so such matches carry 135 KB of the 240 KB. Copied in chunks that double, LZ4 takes 0.13 ms
  rather than 0.23 ms.
- Putting a number back together a 32 bit word at a time rather than a byte takes 0.15 ms
  rather than 0.25 ms.

Results, channels then socket, each the median of three runs, stage 3 and 4 run in turn with
the same sim:

| Link | Ping p50, p95 | Echo p50 | Clouds a second | MB/s | Page a cloud |
| --- | --- | --- | --- | --- | --- |
| loopback | 1.9, 7.9 ms / 1.2, 4.7 ms | 1.5 / 1.6 ms | 10 / 10 | 1.45 | 1.9 / 2.0 ms |
| LAN | 3.7, 8.4 ms / 2.9, 5.6 ms | 5.2 / 2.8 ms | 10 / 10 | 1.45 | 2.3 / 1.9 ms |
| WiFi | 9.4, 16 ms / 9.9, 17 ms | 12 / 8.9 ms | 10 / 10 | 1.45 | 2.2 / 1.8 ms |
| jittery WiFi | 25, 32 ms / 23, 38 ms | 26 / 25 ms | 9.9 / 9.8 | 1.45 | 2.1 / 1.9 ms |

A cloud's age, p50 and p95, channels then socket:

| Link | Stage 3 | Stage 4 |
| --- | --- | --- |
| loopback | 52, 79 ms / 36, 59 ms | 39, 63 ms / 30, 53 ms |
| LAN | 74, 100 ms / 74, 106 ms | 54, 78 ms / 60, 84 ms |
| WiFi | 110, 131 ms / 121, 194 ms | 78, 101 ms / 89, 119 ms |
| jittery WiFi | 127, 172 ms / 143, 234 ms | 110, 163 ms / 112, 166 ms |

- A cloud is 40% smaller and arrives 7 to 32 ms younger on every link, by the most on WiFi.
  Its p95 falls by 6 to 75 ms, and on the jittery link the ping's p95 too, 32 ms from 47 ms.
- The page takes about 1 ms more a cloud: unpacking it, 0.3 ms run back to back, is 1.2 to 1.7
  ms at 10 a second, timed in the page and alone in Chrome, as the CPU idles between clouds.
  Both run optimized at either pace. The main thread is busy as much as before, 9 to 15%, as
  fewer pieces arrive.

## Plan

Each stage is measured on loopback, LAN and WiFi before the next.

1. Done: transport, above.
2. Done: backend, above.
3. Done: page, above.
4. Done: compression, above.
5. The tick: whether a big value should go at once rather than wait for it.
6. Loss: the shaper dropping a share of packets at random, as WiFi does, then whether small
   messages should have a channel of their own, so a lost piece of bulk never holds them, and
   whether a window should be paced over the round trip rather than sent at once.
7. A worker: whether decoding a big message off the main thread pays, now that unpacking it
   costs 1 to 2 ms there.

Experiment code, never committed: `HMI_MARGIN_US` and the margin log in `flight.rs`, the `EXP`
timings in `rtc.rs` and `app.rs`.

## Decisions

- A pong is answered where its ping came in, so the round trip shown is the link's. The loop's
  own delay shows in how fast values come back, not in the ping.
- Small messages skip the window, bulk alone is paced.
- The pacing margin is found per link by trying a wider window, from 2 ms up to 100 ms.
- No lossless narrowing of numbers: shuffle and LZ4 already take what it would.
- Lossy narrowing only as a choice per import, a fixed step rather than f16.
- A list of numbers, and a list of records of numbers, stay packed as columns in the backend.
  64 bit whole numbers stay one by one, as a page reads them as BigInts.
- Packed lists go to screens as typed arrays, records as tag 41000 over their columns, and
  to files as plain lists. A page reads them as frozen lists whose records are made only
  when read.
- Numbers of 4 KB or more go to screens shuffled then LZ4 compressed, as tag 41001, when that
  makes them smaller. Bytes go as they are.

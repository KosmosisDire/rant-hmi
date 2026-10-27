# Data paths

Which way each kind of data should reach a screen, in what size of piece, on which thread of
the page, and how much of it needs to go at all. Builds on `large-payloads.md`.

Stages 1 to 12 ran on branch data-paths, each option an experiment switch. The final design,
built on branch paths-final from what they found, drops the switches. `The final design` at the
end says what it is, and `As built` what each step of it measured.

## The questions

The user's, on 2026-10-23:

1. How are queue sizes and memory managed on the backend and the page, and can an overwhelmed
   queue cause trouble?
2. What size should a piece be, and does that depend on WebRTC or the socket?
3. Should a kind of data, or a size, or a kind of link, take the socket or the channels?
4. Can the page take what comes in on another thread, or split incoming and outgoing on
   separate connections and threads?
5. Can less go: only the fields a page uses, a rate cap on the data page's previews, and an
   import that asks for a lower rate?
6. Is WebTransport worth a prototype?

And on 2026-10-24:

7. Is a worker worth more than decoding: drawing a scene, a screen's own processing of a cloud,
   and sends through a worker of their own?
8. Can a big value go as what changed since the last, for maps above all, deletions too? Is an
   id per row worth its bytes, or a delta of everything after a shift, and does it serve big
   values in general?

## Queues today

Backend:

- Rant's callback decodes each sample on Rant's thread and sends it to the loop on an unbounded
  channel, which the loop takes 64 at a time. What screens send, the channel task's news and
  video frames reach the loop the same way.
- Lanes to each screen: control has no cap, small values at most 8 batches (then left out and
  sent whole once drained), a big value only its newest, video drops frames over 200 ms old.
- Lanes to the wire: the flight window, the link's rate over its shortest round trip and a
  margin. On channels SCTP holds 512 KB at most and the small channel 64 KB.

Page:

- Each WebSocket or data channel message is a task on the main thread.
- On the socket Chrome stops reading TCP while the page is behind, so the backend's flight
  window fills and the lanes keep only what is newest (stage 1).
- On a channel SCTP acks from its own thread in the renderer, so a main thread slower than
  its data queues messages in the browser without end, older and older (stage 10).
- On WebTransport Chrome's network process acks and buffers the streams whether the page
  reads them or not, about 2.5 s of clouds before QUIC pushes back (stage 10).
- A message's pieces wait in the joiner until its last arrives.

## Pieces

A message goes in pieces of 8 KB, each with `[u16 lane][u8 more]`, the lanes taking turns a
piece at a time. TCP cuts a piece into segments of about 1460 bytes and SCTP into chunks of
about 1200. A piece sets how long a small message waits behind a big one and how many messages
the page handles: 0.12 to 0.15 ms each on the socket, 0.04 ms on a channel.

## Less data

- The client knows which names a page reads (`state/usage.ts`), not which fields.
- Every screen gets every import at its full rate, shown or not, the Design and Data screens too.
- Rant's `max_rate_hz` caps a best effort subscriber's deliveries per publisher, and the
  publisher applies it, so the network carries less too. A reliable publisher serves a best
  effort subscriber.

## Precedent

- Foxglove sends everything, point clouds too, over one WebSocket.
- No common practice splits a page's data between a WebSocket and WebRTC by size.
- WebTransport (QUIC) has streams that never hold each other, datagrams, pushback on a slow
  reader once the browser's buffers fill, and runs in workers. QUIC's loss recovery has no 1 s
  floor. Chrome, Firefox and Safari 26.4 have it, a certificate taken by its hash too.

## Plan

Each option is an experiment switch, an environment variable on the backend or a parameter on
the page. Each stage runs loopback, LAN, WiFi, jittery WiFi and WiFi at 1% loss, 15k and 100k
points, and measures ping, echo, cloud and clock age, the page's busy time, how late its event
loop runs and its memory, backend and sim CPU, and bytes.

1. Overload: the page's CPU slowed 4 and 6 times, as a phone's.
2. Piece size: 2 to 64 KB, socket and channels.
3. Hybrid: big values on the socket, small on the channels, and the other mixes.
4. Page threads: a worker that joins pieces, or joins and decodes, and incoming apart from outgoing.
5. Less data: used fields only, shown imports only, a downsampled import, a preview cap.
6. Permutations of what wins.
7. WebTransport, a prototype beside the socket and the channels.
8. The slowed page again, held to a share of a core, as DevTools' throttle fails with WebRTC.
9. The slowed page a third way: its main thread kept busy by the page, its other threads free.
10. Linux, and two real devices over a wired LAN and over WiFi.
11. Drawing and work in a worker, and sends through a worker of their own.
12. Deltas, offline: sequences of maps, clouds, paths and tables, each update sent every way.

## Slowing a page

DevTools' CPU throttle, which stages 1 to 7 use for a slowed page, stalls a page far more than
asked once it has negotiated WebRTC. The main thread's wall time against its CPU time, in a
trace at 4x:

| Page | Wall over CPU |
| --- | --- |
| one socket (so) | 4.2 |
| clouds on the socket, channels open (bigso) | 19 |
| channels open, nothing sent | 33 |

- A bare page shows it with only `createOffer` and `setLocalDescription`, no channel and no
  peer: a fixed loop of 8 ms takes 21 ms at 4x without them and 121 ms with them. At 1x both
  take 8 ms. Why Chrome does this is not traced.
- On Linux the stall does not show, in Chrome 150 or Chrome for Testing 155 against 155 here:
  the loop takes 13 ms at 4x with or without the offer. So it is Chrome's on Windows, and on
  Linux the throttle's slowed rows hold for every way (stage 10).
- The throttle slows only the main thread, on both. A fixed loop of 24 ms takes 109 ms at 4x on
  the main thread and 24 ms in a worker, so the slowed rows give a worker a core at full speed.
- So the slowed rows with channels open overstate their cost, those with a worker understate
  it, and only the rest compare: so, so16, bulkso, splitmain and wtso.
- `--cap` in the harness holds the page's renderer to a share of one core with a Windows job
  object, which slows every thread of it alike, WebRTC's too. It is a budget, not a slower
  clock: a page within it runs at full speed. Stage 8 redoes the slowed rows so.
- The cap models one slow core that every thread shares, so a worker gets no core of its own.
  A phone lies between the two: slower cores, but several.
- Spinners sharing the page's pinned cores do not model a phone either. With one spinner a
  core, Windows' scheduler slowed the main thread 3 times and a worker 7 times.
- Uncapped at loopback and 100k the renderer takes 48% of a core on channels against 38% on
  the socket. Chrome runs DTLS and SCTP in the page's renderer, while a socket's TCP and TLS
  run in its network process, so the channels cost a phone that much more. Held to half a core
  it takes 46% on channels, 32% on the socket and 20% on WebTransport (stage 8).

## Stage 1: a slowed page

The lidar sim at 10 clouds a second on loopback, the page's CPU slowed by DevTools, 20 s a
run, medians of 2. The gate holds a screen's next big value of an alias until the page says
it took the last (`took`), with 1 or 2 in flight. Cloud age at the page:

| Page | Points | Channels | Socket | Channels, gate 1 | Channels, gate 2 |
| --- | --- | --- | --- | --- | --- |
| full speed | 15k | 13 ms | 8 ms | 13 ms | 16 ms |
| full speed | 100k | 68 ms | 34 ms | 68 ms | 71 ms |
| 4x slower | 15k | 143 ms | 11 ms | 89 ms | 161 ms |
| 4x slower | 100k | 30 s | 147 ms | 156 ms | 355 ms |
| 6x slower | 15k | 6.6 s | 12 ms | 238 ms | 342 ms |
| 6x slower | 100k | never caught up | 77 ms | 303 ms | 1.1 s |

- The socket bounds itself, and a gate on it changes nothing.
- Under DevTools' throttle the channels grow without end. At 6x and 100k the page had not
  caught up 120 s after the sim stopped, and at 4x its pings took 27 s.
- A gate of 1 bounds the channels, but the slowed page shows far fewer clouds: at 4x and 100k
  3.6 a second against the socket's 8.3, at 6x 2.2 against 9.6. A gate of 2 lets a backlog
  form again.
- A slowed page spends more main thread time a cloud on channels: at 4x and 100k busy 97% for
  3.6 clouds a second, against 72% for 8.3 on the socket. Stage 4 looks at why.
- At full speed and 100k the channels cost more too: cloud age 68 against 34 ms, backend CPU
  49% against 22% of a core.
- On WiFi at full speed the gate costs nothing (cloud age 60 ms either way). On jittery WiFi a
  gate of 1 on channels costs a round trip a cloud: 120 against 94 ms, 9.2 against 10.1 clouds
  a second. A gate of 2 matches none.

So an overwhelmed queue does cause trouble for any page slower than its data, a phone or a busy
laptop, and most on the channels. DevTools' throttle on Windows stalls a page with WebRTC, so
these rows overstate how soon (see Slowing a page). On Linux, where the throttle is fair, the
channels grow without end once the main thread cannot keep up, 34 s at 14x (stage 10), so the
missing pushback is real. The fixes to weigh are a gate of 1 on the channels, or big values off
them (stage 3).

## Stage 2: piece size

`HMI_PIECE` from 2 to 64 KB, the page at full speed, medians of 2. Cloud age at the page, and
backend CPU on loopback:

| Piece | Loopback 100k, channels | Loopback 100k, socket | Backend CPU, channels and socket | LAN 100k, socket | WiFi 100k, socket | Loopback 15k, socket |
| --- | --- | --- | --- | --- | --- | --- |
| 2 KB | 85 ms | 61 ms | 56% and 28% | 89 ms | 398 ms | 14 ms |
| 4 KB | 93 ms | 57 ms | 63% and 23% | 91 ms | 379 ms | 10 ms |
| 8 KB | 83 ms | 46 ms | 52% and 23% | 89 ms | 380 ms | 8 ms |
| 16 KB | 84 ms | 38 ms | 56% and 18% | 90 ms | 389 ms | 6 ms |
| 32 KB | 73 ms | 28 ms | 54% and 16% | 86 ms | 549 ms, 2 a second | 5 ms |
| 64 KB | 83 ms | 29 ms | 56% and 14% | 168 ms | 451 ms, 2.5 a second | 4.5 ms |

- On the socket bigger pieces cost less on both ends: the page's busy time at loopback and 100k
  falls from 39% at 2 KB to 27% at 16 KB and 22% at 32 KB, as it handles fewer messages.
- Past 16 KB the socket falls behind on slower links. WiFi at 100k carries 2 clouds a second
  at 32 KB against 3 at 16 KB, and LAN's age doubles at 64 KB. The cause is not traced: the
  window learns the link from a ping after each piece, so fewer pieces teach it less.
- On the channels the piece barely matters, as SCTP cuts every piece into its own chunks:
  age and CPU stay flat from 2 to 64 KB.
- WiFi, jittery WiFi and 15k on any link show no clear trend, within noise.
- WiFi at 1% loss hurts the channels at every size, age p95 550 ms to 1.1 s and 7.5 to 8.8
  clouds a second, against 83 to 107 ms and 10 a second on the socket. That is SCTP's 1 s
  resend floor, not the piece.

So the best size depends on the way: the socket wants pieces as big as its slowest link takes,
and the channels do not care. 16 KB suits the socket on every link measured, so one size of
16 KB serves both. Stages 3 to 5 keep 8 KB, and stage 6 tries 16 KB with the winners.

## From stage 3 on

- The shaped links carry every way on one queue at the link's rate, so traffic split over two
  ways shares one link's bandwidth, as it would on a real one. Before, each way had a rate of
  its own.
- A cloud's age counts once the page has handled its message, on every way and thread. Before,
  the main thread's count stopped on arrival, before decoding.
- Rows marked rto run a backend whose SCTP resend minimum is 200 ms, not the 1 s that
  sctp-proto takes from RFC 4960. str0m does not expose it, so the build patches the crate.

The ways tried, 8 KB pieces, 20 s a run, medians of 2 rounds:

| Name | Small values and pongs | Big values | Read on |
| --- | --- | --- | --- |
| ch | channels | channels | main thread |
| so | socket | socket | main thread |
| bigso | channels | socket | main thread |
| smallso | socket | channels | main thread |
| bulk | channels | a second socket | main thread |
| bulkso | socket | a second socket | main thread |
| wjoin, wdec | channels | channels | a worker joins the pieces, or joins and decodes |
| bulkwj, bulkwd | channels | a second socket | a worker joins, or joins and decodes |
| splitmain, split | a second socket | a second socket | main thread, or a worker that decodes |
| wt, wtwd | channels | WebTransport | main thread, or a worker that decodes |
| wtso | socket | WebTransport | main thread |
| chrto, bigsorto | as ch and bigso, the resend minimum at 200 ms | | |

In splitmain and split the first socket carries what the page sends and the control messages,
and the second brings everything else.

## Stage 3: which way

Cloud age p50 and p95 at the page, in ms:

| Way | Loopback 15k | Loopback 100k | WiFi 15k | Jittery 15k | WiFi 1% loss 15k | 4x slower 100k | 6x slower 15k |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ch | 17, 34 | 90, 135 | 66, 73 | 91, 176 | 147, 1008 | 18.5 s, 35 s | 5.1 s, 10 s |
| chrto | 19, 33 | 88, 136 | 61, 74 | 92, 169 | 128, 251 | 25 s, 39 s | 12 s, 21 s |
| so | 10, 17 | 52, 73 | 63, 74 | 89, 155 | 71, 89 | 66, 207 | 29, 107 |
| bigso | 12, 23 | 66, 92 | 63, 69 | 84, 144 | 71, 89 | 1.5 s, 3.5 s | 2.2 s, 4.0 s |
| bigsorto | 13, 23 | 74, 95 | 64, 70 | 85, 139 | 72, 87 | 2.9 s, 3.6 s | 2.8 s, 3.5 s |
| smallso | 17, 31 | 90, 125 | 64, 71 | 97, 187 | 147, 930 | 3.0 s, 7.8 s | 7.4 s, 11 s |
| bulk | 13, 24 | 73, 91 | 64, 69 | 94, 162 | 71, 92 | 3.2 s, 4.2 s | 1.8 s, 3.0 s |
| bulkso | 11, 19 | 51, 76 | 64, 71 | 90, 144 | 73, 90 | 119, 247 | 20, 86 |

- Big values off the channels win at full speed. On channels they cost the backend twice the
  CPU, 52% of a core against 21 to 23% at loopback and 100k, and 25 to 40 ms of age.
- WiFi at 100k carries 3 to 3.3 clouds a second on every way but WebTransport, age 370 to 400
  ms: the link sets it.
- At 1% loss every way with big values on stock channels shows the 1 s floor, p95 750 to 1010
  ms and 7.6 to 9 clouds a second. Both rounds agree: ch p95 1020 and 996, chrto 256 and 246.
- The 200 ms minimum cuts that p95 four times and brings 9.3 clouds a second, still behind the
  socket's 10 at 89 ms. It changes nothing where big values go another way (bigso against
  bigsorto), as steady small values reveal a lost chunk at once. The floor bites only at the end
  of a burst, where no later chunk shows the gap.
- One 15 s run cannot tell the floor apart: p95 of 150 clouds is the 8th worst, and a run with
  fewer stalls hides them. Single runs of ch at loss ranged 250 to 1100 ms. Clouds a second is
  the steadier sign.
- Small values gain nothing on channels on these links. At 1% loss pings on channels have p95
  40 to 46 ms against 18 to 23 on the socket. The shaper models the socket's resends as Linux
  TCP does them, while SCTP's are real code, so a real lossy link has the last word.
- Small values on the socket and big on channels (smallso) has the faults of both.
- On a slowed page every way with channels open falls behind, even with every cloud on a
  socket: bigso at 4x and 100k shows 0.9 clouds a second at 1.5 s, against 9.8 at 66 ms for
  so. That is DevTools' throttle stalling a page with WebRTC, not the channels' own cost (see
  Slowing a page).

So big values belong on a socket on every link measured. With the resend minimum at 200 ms the
channels come within reach of the socket at loss, but not past it.

## Stage 4: page threads

Cloud age p50 and p95 in ms, and the main thread's busy time at loopback and 100k:

| Way | Loopback 100k | Busy | WiFi 1% loss 15k | 4x slower 100k | 6x slower 15k |
| --- | --- | --- | --- | --- | --- |
| ch | 90, 135 | 19% | 147, 1008 | 18.5 s, 35 s | 5.1 s, 10 s |
| wjoin | 92, 155 | 14% | 122, 755 | 2.8 s, 5.8 s | 2.9 s, 4.0 s |
| wdec | 99, 248 | 10% | 130, 924 | 136, 274 | 597, 1102 |
| bulk | 73, 91 | 44% | 71, 92 | 3.2 s, 4.2 s | 1.8 s, 3.0 s |
| bulkwj | 56, 85 | 18% | 72, 91 | 2.7 s, 4.3 s | 2.8 s, 3.6 s |
| bulkwd | 51, 82 | 12% | 74, 90 | 69, 242 | 182, 680 |
| so | 52, 73 | 30% | 71, 89 | 66, 207 | 29, 107 |
| splitmain | 54, 78 | 30% | 72, 90 | 63, 220 | 14, 87 |
| split | 56, 82 | 10% | 73, 92 | 31, 49 | 8, 25 |

- A worker that only joins pieces gains little, as the main thread still decodes.
- A worker that joins and decodes cuts the main thread's busy time two to four times at full
  speed, and on a slowed page brings every cloud: bulkwd 69 ms at 4x where bulk took 3.2 s.
- The channels in a worker (wdec) keep a slowed page at 10 clouds a second, but at full speed
  their p95 grows to 248 ms and the backend's CPU to 62% of a core.
- Incoming apart from outgoing (split) is the best of all on a slowed page: 31 and 49 ms at 4x
  and 100k, 8 and 25 at 6x and 15k, every cloud. Read on the main thread (splitmain) it matches
  one socket, so the gain is the worker, not the second socket.
- One socket read in a worker, which sends what the page sends too, was not tried.
- The slowed columns carry two faults of DevTools' throttle (see Slowing a page): the stall of
  every way with channels open (ch, wjoin, wdec, bulk, bulkwj, bulkwd), and a worker at full
  speed beside a slowed main thread. So split's gain on a slowed page is the throttle's as much
  as the worker's.
- Held to one share of a core (stage 8) a worker brings no more clouds, split 7.7 a second
  against so's 6.6 at a quarter core, as the worker and the main thread share the budget. It
  still frees the main thread: busy 29% against 43%.

So a worker should decode what comes in: it frees the main thread two to four times, and on a
phone with a spare core it brings that core to the work. Joining alone is not worth it.

## Stage 5: less data

Every value on the channels, as today. The modes:

- fields: only x, y and z of the cloud's four fields (`HMI_FIELDS=Lidar:x,y,z`).
- rate5: the import asks Rant for 5 a second of the 10 the sim sends (`HMI_MAX_RATE=Lidar:5`).
- hidden: the screen does not show the lidar. hidden0 sends a hidden import nothing, as a
  backend that sends only what a screen shows would.
- second: the editor's Data tab open beside the screen, previewing every import. second2hz caps
  its previews at 2 a second, secondbytes at 250 KB a second.

Cloud age p50 and p95 at the screen, in ms, with clouds a second where below 10:

| Mode | Loopback 15k | Loopback 100k | WiFi 15k | WiFi 100k | 4x slower 100k |
| --- | --- | --- | --- | --- | --- |
| base | 20, 35 | 90, 119 | 60, 65 | 397, 443, 3 | 16 s, 28 s |
| fields | 16, 29 | 79, 206 | 55, 61 | 353, 398, 3.5 | 15 s, 27 s |
| rate5 | 71, 112 | 138, 204 | 108, 154 | 493, 595, 3 | 3.0 s, 4.4 s |
| fields and rate5 | 71, 111 | 123, 195 | 106, 151 | 452, 561, 3.5 | 768, 1401 |
| hidden | 19, 32 | 93, 145 | 59, 66 | 393, 441, 3 | 2.2 s, 4.6 s |
| second | 25, 44 | 81, 117 | 93, 126 | 607, 1099, 1.7 | 3.5 s, 10 s |
| second2hz | 23, 45 | 78, 160 | 63, 90 | 830, 1867, 1.35 | 16 s, 31 s |
| secondbytes | 21, 40 | 78, 107 | 65, 93 | 416, 641, 2.8 | 20 s, 37 s |

What each costs at loopback and 100k, and pings p95 at WiFi and 100k:

| Mode | MB a second | Backend CPU | Screen busy | Data tab busy | Pings p95 at WiFi 100k |
| --- | --- | --- | --- | --- | --- |
| base | 9.3 | 51% | 20% | | 17 ms |
| fields | 7.9 | 49% | 18% | | 16 ms |
| rate5 | 4.6 | 30% | 13% | | 18 ms |
| fields and rate5 | 4.0 | 26% | 12% | | 15 ms |
| hidden | 9.3 | 54% | 15% | | 16 ms |
| hidden0 | 0 | 12% | 4% | | 9 ms |
| second | 9.3 | 58% | 19% | 28% | 71 ms |
| second2hz | 9.0 | 54% | 18% | 9% | 148 ms |
| secondbytes | 9.3 | 49% | 19% | 6% | 66 ms |

- A hidden import comes at its full rate today: hidden costs what base does. Sending it nothing
  (hidden0) takes the backend from 51% of a core to 12% and the screen from 20% busy to 4%. Of
  all the levers this saves the most, wherever a screen does not show an import.
- Used fields only cut the bytes 15% here, with one field of four dropped, and the age with
  them where the link is the limit: WiFi at 100k 353 ms and 3.5 clouds a second against 397
  and 3.
- A downsampled import halves the bytes and the backend's CPU but adds age, p50 up 50 ms at
  15k. Rant's publisher holds a sample that comes before its tick, then sends the newest
  (`writer.c`), so a sample waits half the publisher's period on average. It cannot help where
  the link already carries fewer than the cap: WiFi at 100k carries 3 either way.
- The Data tab's previews cost their own page 28% busy at loopback and 100k, and on WiFi at
  100k halve the screen's clouds, as both share the link. A cap in previews a second is the
  wrong unit for a big value: 2 a second of 0.9 MB clouds is 1.8 MB a second, more than the
  previews took uncapped from WiFi's 3, so the screen fell to 1.35 clouds a second. A cap in
  bytes a second holds whatever the size: at 250 KB the screen keeps 2.8 clouds a second and
  the Data tab's page falls to 6% busy.
- On a slowed page every mode falls behind but for those that cut most of the data: fields
  and rate5 together bring 4x and 100k from 16 s to 768 ms. These run on channels, so DevTools'
  stall inflates the column (see Slowing a page), but the order of the modes stands.

So a screen should get only the imports it shows, the Data tab's previews a cap in bytes a
second, and an import may offer used fields and a lower rate, the rate with its cost in age.

## Stage 6: permutations

Run after stage 7: 16 KB pieces on the socket ways, and settings for WebTransport, which stage
7 found queues on a slow link. The page at full speed, or slowed by DevTools on the ways
without WebRTC, medians of 2.

Cloud age p50 and p95 in ms, with clouds a second where below 10, and the backend's CPU:

| Way | Loopback 100k | LAN 100k | WiFi 100k | Jittery 15k | WiFi 1% loss 15k | 4x slower 100k | 6x slower 15k | Backend CPU, loopback and LAN 100k |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| so | 44, 70 | 93, 119 | 377, 431, 3.2 | 89, 155 | 73, 93 | 75, 286, 9.5 | 15, 75 | 22% and 21% |
| so16 | 44, 62 | 92, 133 | 399, 447, 3 | 87, 161 | 69, 86 | 50, 152, 9.9 | 12, 42 | 18% and 14% |
| split | 54, 80 | 96, 129 | 375, 424, 3.3 | 91, 153 | 70, 93 | 30, 42 | 8, 20 | 23% and 22% |
| split16 | 42, 65 | 96, 144 | 419, 471, 3 | 88, 170 | 71, 86 | 27, 42 | 6, 18 | 18% and 15% |

- 16 KB pieces cut the backend's CPU by a sixth to a third, and nearly halve a slowed page's
  p95 on one socket, 152 against 286 ms at 4x and 100k, as the page handles half the messages.
- They cost WiFi at 100k a little, 3 clouds a second against 3.2, as stage 2 found. Elsewhere
  the two sizes are within noise.

WebTransport for big values beside the socket (wtso), with:

- fifo: QUIC sends its streams in turn, not round robin.
- w256k: QUIC's send window 256 KB, not 10 MB.
- g1, g2: no big message starts while 1 or 2 wait for the page's ack, and the lanes keep only
  the newest meanwhile.
- bbr, flight: BBR, or the socket's window, as QUIC's congestion control in place of Cubic.
- wtall: every value on WebTransport, small ones too, and wd read in a worker that decodes.

Cloud age p50 and p95 in ms, with clouds a second where below 10, and pings p95:

| Way | WiFi 100k | Pings, WiFi 100k | LAN 100k | Jittery 15k | Pings, jittery 15k | WiFi 1% loss 15k |
| --- | --- | --- | --- | --- | --- | --- |
| so | 377, 431, 3.2 | 17 | 93, 119 | 89, 155 | 41 | 73, 93 |
| wtso | 6.8 s, 7.1 s | 93 | 95, 193 | 66, 76 | 57 | 70, 171 |
| fifo | 3.7 s, 4.1 s | 92 | 96, 150 | 66, 77 | 55 | 69, 290 |
| w256k | 463, 502 | 90 | 94, 114 | 65, 68 | 55 | 71, 262 |
| g1 | 380, 427 | 93 | 95, 110 | 65, 71 | 52 | 69, 124 |
| g2 | 675, 722 | 93 | 94, 112 | 65, 70 | 54 | 71, 129 |
| g1 bbr | 379, 423 | 76 | 97, 118 | 64, 68 | 37 | 58, 83 |
| flight | 7.3 s, 7.6 s | 14 | 98, 408 | 98, 713 | 29 | 77, 120 |
| g1 flight | 395, 446, 3 | 14 | 99, 138 | 145, 222, 8.6 | 26 | 79, 111 |
| wtall g1 flight | 393, 445, 3 | 16 | 96, 129 | 115, 229, 8.8 | 35 | 89, 100 |
| wtall wd g1 flight | 403, 450, 3 | 15 | 97, 131 | 144, 222, 8.5 | 36 | 75, 90 |

- The queue on a slow link is QUIC's send window. quinn holds 10 MB unsent or unacked by
  default, over 3 s of WiFi's 3 MB a second, and sends its streams round robin, so each cloud
  shares the link with every one queued: 6.8 s. In turn (fifo) halves that. A window of 256 KB
  brings 463 ms, and a gate of 1 the socket's age. A gate of 2 lets a second cloud queue.
- The congestion control sets the pings. Cubic and BBR fill the link's queue, pings p95 76 to
  93 ms on WiFi at 100k against 17 on the socket. The socket's window as QUIC's controller
  keeps them at 14, but alone it leaves the send window's queue: 7.3 s.
- A gate of 1 with the socket's window matches the socket on WiFi and LAN, 395 against 377 ms
  and pings 14 against 17. On jittery WiFi it brings 8.6 clouds a second against 10. quinn
  paces 1.25 windows a smoothed round trip (`pacing.rs`), and this window holds the shortest
  round trip's worth, so where jitter lifts the smoothed one the pacer sends below the link's
  rate. The socket's window has no pacer over it.
- Cubic's gain on jittery WiFi holds with a gate, 65 against 89 ms, but costs the pings on a
  slow link.
- BBR with a gate is best at loss, 58 and 83 ms, but costs the backend 31% of a core on LAN
  against 19%, and the pings 29 ms there against 13.
- Every value on WebTransport (wtall) keeps up with the socket on these links, small values
  too. Read in a worker its main thread is 4 to 11% busy.
- On the slowed rows the worker ways lead: split 30, 42 at 4x and 100k, wtall wd 29, 42. A
  worker there runs at full speed (see Slowing a page), so this overstates them.

So the socket should cut 16 KB pieces. WebTransport needs a gate of 1 and the socket's window as
its congestion control to keep the socket's pings on a slow link, and that window paced by the
shortest round trip before it serves jittery WiFi.

## Stage 7: WebTransport

Cloud age p50 and p95 in ms:

| Way | Loopback 15k | Loopback 100k | WiFi 15k | WiFi 100k | Jittery 15k | WiFi 1% loss 15k | 4x slower 100k | 6x slower 15k |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| so | 10, 17 | 52, 73 | 63, 74 | 373, 421 | 89, 155 | 71, 89 | 66, 207 | 29, 107 |
| wt | 8, 14 | 44, 61 | 58, 61 | 6.8 s, 7.3 s | 68, 75 | 67, 164 | 3.6 s, 6.1 s | 15 s, 23 s |
| wtwd | 8, 14 | 45, 62 | 58, 62 | 6.8 s, 7.2 s | 65, 69 | 65, 180 | 481, 916 | 1.1 s, 2.3 s |
| wtso | 7, 12 | 45, 63 | 58, 62 | 6.8 s, 7.2 s | 65, 72 | 67, 145 | 32, 72 | 10, 47 |

- Where the link keeps up, WebTransport has the lowest age of any way: 2 to 8 ms below the
  socket, and on jittery WiFi 20 below and p95 72 against 155. The backend spends 21% of a core at
  loopback and 100k, as on the socket, and the page reads a cloud in one go, not in 8 KB pieces.
- Where the link is slower than the clouds, it queues: WiFi at 100k 6.8 s, and pings p95 92 ms
  against 15. The prototype hands QUIC each cloud as it comes. quinn's send window holds 10 MB
  of them, over 3 s on WiFi, and sends them round robin, so each waits behind all the others,
  and Cubic fills the link's queue, where the pings wait (stage 6).
- Its gain on jittery WiFi holds with a gate (stage 6), so it comes from Cubic, not from the
  missing window.
- At 1% loss its p95 is 145 to 180 ms, against 89 on the socket and 1 s on stock channels.
- On a slowed page wtso holds, 32 ms at 4x and 100k and 10 at 6x and 15k, as the page reads a
  cloud in one go. A page slower than its data holds seconds of streams in the browser's
  buffers before QUIC pushes back (stage 10). With channels open beside it (wt) it falls
  behind, as DevTools' throttle stalls a page with WebRTC (see Slowing a page). Held to a
  quarter core (stage 8) it is the one way that brings every cloud, channels open or not.

- A browser offers WebTransport only to a secure page. A page on http at a LAN address has no
  WebTransport at all, while localhost counts as secure. A page on https with the HMI's own
  certificate, taken past the browser's warning (Advanced, then Proceed), is secure and opens
  WebTransport by a certificate's hash, though not without one. A certificate taken by its
  hash must last 14 days at most, so the session needs one of its own beside the HMI's. A
  page on plain http keeps the socket, which serves a wired LAN well.

So WebTransport wins on a slow page and loses on a slow link until it has a window, which stage
6 finds.

## Stage 8: a fair cap

The slowed page again, its renderers held together to a share of one core by `--cap` (see
Slowing a page), on loopback, 20 s a run, medians of 2. Cloud age p50 and p95 in ms, with
clouds a second where below 10, and the page's CPU at half a core:

| Way | Half a core, 100k | Quarter core, 100k | Tenth of a core, 15k | Page CPU, half a core |
| --- | --- | --- | --- | --- |
| ch | 67, 153 | 288, 929, 4.2 | 76, 479, 7 | 46% |
| wdec | 82, 197 | 429, 792, 4.7 | 30, 423, 7.8 | 46% |
| bigso | 50, 68 | 161, 678, 7.3 | 53, 376, 9 | 34% |
| bulkwd | 34, 59 | 133, 509, 6.2 | 56, 353, 9.1 | 31% |
| so | 36, 87 | 84, 441, 6.6 | 41, 393, 9 | 32% |
| split | 52, 83 | 91, 427, 7.7 | 105, 663, 8.7 | 35% |
| wt | 38, 59 | 37, 54 | 8, 188 | 20% |
| wtso | 42, 63 | 40, 61 | 8, 145 | 21% |
| wtall wd g1 flight | 36, 64, of 5 runs | 39, 61 | 59, 296 | 23% |

- At a quarter core only WebTransport brings every cloud, p95 54 to 61 ms and pings p95 17 to
  18. The socket brings 6.6 a second at p95 441 and pings 115, the channels 4.2 at 929 and
  pings 393.
- WebTransport costs the page least: 20% of a core at 100k against 32% on the socket and 46%
  on channels. A cloud comes as one stream, about 60 messages a second on the main thread,
  against 1200 pieces of 8 KB on the socket or the channels. QUIC runs in the browser's
  network process, as the socket's TCP does.
- No way piles up without end. Age holds level from a run's first fifth to its last, and every
  page drains within a quarter second of the sim's stop. Under DevTools the channels' backlog
  grew because only the main thread slowed while the renderer's SCTP acked at full speed. Held
  to a cap SCTP slows with the page, likely so its acks hold back the backend's sends.
- A worker brings no more clouds under a cap: split 7.7 a second against so's 6.6, wdec 4.7
  against ch's 4.2, as the worker and the main thread share one budget. It frees the main
  thread, busy 29% against 43% on the socket.
- Every value on WebTransport through a worker costs most at a tenth of a core, p95 296 ms and
  pings 292. One run of it at half a core stalled its main thread for 2 s, which three runs
  more did not repeat. Not traced.

So a page slower than its data falls behind on every way but WebTransport, which also costs the
page least. The channels fall furthest, but under a cap no way piles up without end.

## Stage 9: a busy main thread

The page keeps its own main thread busy, a timer spinning 8, 9 or 9.5 ms of every 10, with no
throttle and no cap (`--burn`), on loopback, medians of 2. Cloud age p50 and p95 in ms:

| Way | 8 ms of 10, 100k | 9 ms of 10, 100k | 9.5 ms of 10, 15k |
| --- | --- | --- | --- |
| so | 108, 150 | 165, 232 | 32, 38 |
| so16 | 89, 126 | 173, 226 | 30, 36 |
| bigso | 113, 147 | 165, 236 | 32, 39 |
| ch | 57, 69 | 68, 239 | 17, 25 |
| chg1 | 60, 71 | 62, 89 | 17, 26 |
| wdec | 59, 79 | 61, 82 | 16, 23 |
| bulkwd | 34, 50 | 34, 58 | 12, 18 |
| split | 37, 51 | 37, 53 | 11, 17 |
| wt | 39, 58 | 50, 66 | 11, 17 |
| wtso | 42, 58 | 52, 65 | 10, 16 |
| wtall wd g1 flight | 33, 51 | 38, 53 | 14, 19 |

- The timer yields: it runs late while messages wait, so it shares the main thread rather
  than holding it, as a screen's own drawing on timers and frames does. Every way brings every
  cloud, and none piles up.
- Big values on the main thread's socket wait most, 165 ms at 9 ms of 10, as each cloud's 115
  pieces of 8 KB wait for a gap each. 16 KB pieces do not help here.
- One message a cloud waits once: WebTransport 50 ms. A worker that decodes waits least, 34 to
  38 ms, as the main thread takes the cloud read.
- The channels sit between, 68 ms with p95 239, and a gate of 1 brings their p95 to 89.
- A main thread truly slower, its other threads free, is DevTools' throttle on Linux (stage 10).

So a screen busy with its own work hurts big values on the socket most, and a worker or
WebTransport least.

## Stage 10: Linux and real networks

Linux: page, backend and sim all on karbon (Ubuntu 22.04, 20 cores, Chrome 150 on the GPU by
Vulkan), shaped links on loopback, medians of 2. Cloud age p50 and p95 in ms, with clouds a
second where below 10:

| Way | Loopback 100k | WiFi 100k | Jittery 15k | WiFi 1% loss 15k | 4x slower 100k | 6x slower 15k |
| --- | --- | --- | --- | --- | --- | --- |
| ch | 31, 38 | 401, 446, 3 | 95, 137 | 111, 237, 9.6 | 53, 63 | 12, 17 |
| chg1 | 32, 40 | 392, 438, 2.9 | 89, 179 | 106, 205, 9.3 | 53, 62 | 14, 19 |
| so | 21, 26 | 397, 445, 3 | 91, 137 | 64, 81 | 57, 74 | 16, 24 |
| so16 | 20, 24 | 396, 441, 3 | 83, 151 | 64, 78 | 52, 65 | 15, 21 |
| bigso | 22, 27 | 398, 449, 3 | 94, 129 | 65, 79 | 57, 74 | 18, 25 |
| bulkwd | 21, 26 | 397, 453, 3 | 96, 148 | 66, 79 | 27, 33 | 8, 11 |
| split16 | 20, 25 | 391, 436, 3 | 82, 152 | 64, 75 | 27, 32 | 7, 11 |
| wtso | 20, 24 | 6.8 s, 6.9 s | 63, 65 | 63, 111 | 41, 48 | 13, 17 |
| wtso g1 flight | 21, 25 | 396, 441, 3 | 106, 207, 9 | 68, 81 | 40, 48 | 13, 19 |
| wtall wd g1 flight | 22, 25 | 392, 444, 3 | 119, 218, 8.9 | 67, 74 | 27, 33 | 8, 12 |

- Under DevTools' throttle, fair on Linux, no way falls behind at 4x and 100k or 6x and 15k,
  the channels too: 53 and 63 ms at 4x, where Windows took 18.5 s. The main thread is 45 to
  53% busy there, so the throttle does not fill it on this machine.
- A worker that decodes halves a slowed page's age, 27 against 57 ms at 4x, as the throttle
  leaves the worker at full speed here too.
- The rest matches Windows. The channels cost the backend twice the socket's CPU, 24% of a
  core against 11% at loopback and 100k, and the page the most, 34% against 24% on the socket
  and 17% on WebTransport. WebTransport without a gate queues seconds on a slow link, and with
  the socket's window loses a cloud a second on jittery WiFi.
- At 1% loss the channels, with the 200 ms resend minimum, show p95 237 ms, as chrto did.

Slower still, so the main thread cannot keep up while its other threads run free:

| Way | 10x slower 100k | 14x slower 100k |
| --- | --- | --- |
| ch | 252, 426 | 19 s, 31 s, 5.7 |
| chg1 | 152, 203, 8.6 | 190, 245, 6.1 |
| so | 307, 361, 6 | 433, 502, 3.8 |
| so16 | 290, 338, 6.4 | 423, 478, 4.1 |
| bigso | 306, 353, 6.1 | 447, 529, 3.8 |
| bulkwd | 38, 48 | 46, 64 |
| split16 | 37, 47 | 46, 70 |
| wtso | 332, 527 | 2.5 s, 2.9 s, 9.4 |
| wtso g1 flight | 318, 455 | 2.7 s, 3.2 s, 9.2 |
| wtall wd g1 flight | 38, 47 | 47, 67 |
| wtso g1 flight, took 1 | 142, 194, 9 | 196, 251, 5.8 |
| wtso g1 flight, took 2 | 233, 299, 9.5 | 329, 442, 6.6 |

- Here the channels' missing pushback shows: at 14x their age grows from 10 s to 34 s through
  a run, and the page takes 32 s to drain. A gate of 1 bounds them, 190 and 245 ms at 6.1
  clouds a second. Windows' stall only made this show sooner.
- The socket bounds itself, 433 ms at 3.8 clouds a second, as the lanes keep only the newest.
- WebTransport read on the main thread holds a backlog of about 2.5 s, level through the run.
  Chrome's network process acks and buffers the streams whether the page reads them or not,
  so QUIC pushes back only once those buffers fill, and the gate, which waits on QUIC's acks,
  never sees the page.
- Gated on the page's `took` instead (`HMI_ACK=1`), WebTransport stays bounded: 196 and 251 ms
  at 14x with 5.8 clouds a second, against the socket's 433 at 3.8, and 142 ms with 9 a
  second at 10x. It costs nothing where the page keeps up: 22 ms at full speed, 387 on shaped
  WiFi and 105 on jittery WiFi, as without it. A gate of 2 lets a second cloud queue.
- A worker that decodes keeps every cloud at 37 to 47 ms, as the throttle leaves it at full
  speed. On a phone the worker's core is slow too, so this is its best case.

Real WiFi: the sim and backend on karbon, wired, and the page on this machine over the cage's
WiFi (2.4 GHz, 802.11ax, 287 Mbps, signal 87%, ping p50 7 and max 45 ms), forced there by a host
route. Every byte came in on the WiFi adapter. A TCP clock echo lines up the two clocks to a
few ms. WebTransport opens the page on https past the warning. These runs read the CPU and the
adapters over ssh at either end of the 20 s, which stretched the window the clouds were counted
in, so their counts are scaled here to make 10 a second every cloud. Cloud age p50 and p95 in
ms, with clouds a second where below 10:

| Way | 15k | 100k | 400k | 100k, quarter core | Pings p95, 100k |
| --- | --- | --- | --- | --- | --- |
| so | 44, 96 | 207, 291, 7.2 | 596, 731, 2.1 | 237, 472, 5.4 | 39 |
| so on https | 41, 116 | 206, 291, 8.6 | 667, 917, 1.7 | 250, 501, 6.4 | 139 |
| so16 | 44, 129 | 214, 325, 6.8 | 615, 898, 2 | 231, 427, 6.1 | 55 |
| bigso | 44, 111 | 221, 353, 6.4 | 730, 1066, 1.6 | 242, 492, 5.6 | 62 |
| ch | 48, 111 | 268, 450, 5.3 | 874, 1161, 1.2 | 401, 595, 3.9 | 76 |
| split16 | 42, 100 | 224, 310, 6.7 | 642, 835, 1.9 | 242, 454, 6.1 | 47 |
| wtso | 23, 69 | 2.2 s, 2.9 s, 9.1 | 2.8 s, 3.2 s, 2.4 | 2.2 s, 2.6 s, 9.3 | 90 |
| wtso g1 flight | 42, 134 | 205, 332, 6.6 | 611, 924, 1.9 | 202, 343, 6.8 | 51 |
| wtall wd g1 flight | 51, 137 | 207, 297, 6.6 | 641, 1054, 1.7 | 223, 348, 6.4 | 57 |

- The WiFi carries 6 to 9 MB a second on the socket and WebTransport and 4 to 5 on the
  channels, varying from run to run with the air, so at 100k every way brings 5 to 9 clouds a
  second, where the shaped WiFi brought 3.
- The channels fall furthest on a real link too: 5.3 clouds a second at 268 ms against the
  socket's 7.2 at 207, at 400k 1.2 against 2.1, and their backend CPU 22% of a core against 9%.
- WebTransport without a gate queues seconds here as on the shaped link, 2.2 s at 100k. With a
  gate of 1 and the socket's window it matches the socket, 205 against 207 ms and 6.6 clouds a
  second against 7.2.
- Held to a quarter core WebTransport with the gate leads: 202 ms and pings p95 56 against the
  socket's 237 and 138.
- https costs the socket nothing measurable.

A wired LAN, the same two machines over gigabit Ethernet with WiFi off, counts scaled the same
way. Cloud age p50 and p95 in ms, with clouds a second where below 10, and CPU:

| Way | 15k | 100k | 400k | 100k, quarter core | Pings p95, quarter core | Backend CPU, 400k | Page CPU, 100k |
| --- | --- | --- | --- | --- | --- | --- | --- |
| so | 11, 18 | 47, 66 | 113, 182 | 97, 420, 7.3 | 212 | 34% | 45% |
| so on https | 12, 18 | 45, 63 | 111, 171 | 95, 417, 7.3 | 119 | 35% | 45% |
| so16 | 10, 16 | 37, 52 | 95, 131 | 62, 387, 7.8 | 183 | 26% | 37% |
| bigso | 13, 24 | 54, 93 | 202, 328, 8.7 | 94, 410, 7.3 | 141 | 31% | 43% |
| ch | 15, 27 | 79, 132 | 323, 760, 4.4 | 113, 455, 6.3 | 243 | 86% | 46% |
| split16 | 10, 18 | 40, 57 | 99, 168 | 73, 397, 7.3 | 265 | 26% | 39% |
| wtso | 8, 14 | 32, 45 | 98, 128 | 33, 55 | 13 | 30% | 25% |
| wtso g1 flight | 11, 17 | 38, 56 | 100, 133 | 42, 139 | 14 | 39% | 26% |
| wtall wd g1 flight | 12, 18 | 37, 50 | 107, 142 | 41, 162 | 29 | 41% | 27% |

- Every way but the channels carries 400k, 37 MB a second. The channels bring 4.4 clouds a
  second at p95 760 ms with the backend at 86% of a core against the socket's 34%, so SCTP's
  CPU limits them, not the link.
- WebTransport has the lowest age at every size, 32 ms at 100k against the socket's 47, and
  costs the page least, 25% of a core against 45%.
- 16 KB pieces help the socket here: 37 against 47 ms at 100k, 95 against 113 at 400k, and the
  backend 26% of a core against 34% at 400k.
- Held to a quarter core only WebTransport brings every cloud, 33 and 55 ms with pings p95 13,
  where the socket brings 7.3 a second at p95 420 and pings 212. The gate costs a slow page on
  a fast link a little, p95 139 with it.

So the findings hold on Linux and between real machines: the channels cost most and fall
furthest, the socket bounds itself, and WebTransport, gated on the page's `took` and windowed
as the socket is, has the lowest age and page cost where the link is fast or the page slow,
and matches the socket where the link is slow.

## Stage 11: drawing and work in a worker

Ways, every value on the second socket (`HMI_BULK=all`) where there is one:

| Name | Reads and decodes | Lays out the points | Draws | Sends and hears small messages |
| --- | --- | --- | --- | --- |
| so | main thread | main thread | main thread | main thread |
| split | a worker, second socket | main thread | main thread | main thread, first socket |
| own | a worker, the one socket | main thread | main thread | that worker |
| outw | a worker, second socket | main thread | main thread | a second worker, first socket |
| prep | a worker, second socket | that worker | main thread | main thread, first socket |
| draw | a worker, second socket | that worker | that worker | main thread, first socket |
| drawoutw | a worker, second socket | that worker | that worker | a second worker, first socket |
| owndraw | a worker, the one socket | that worker | that worker | that worker |

- In draw the page hands the scene's canvas to the worker (`transferControlToOffscreen`). The
  worker keeps each cloud and leaves a ref in its place, which the page's expression passes
  to the points part. The part then follows that cloud, and the worker draws each new one as
  it decodes it, so the cloud never reaches the main thread. The experiment draws grids and
  points only.
- `work=ms` holds the thread that lays out a cloud that long, as a screen's own processing of
  a cloud would.
- `bounds=1` gives three.js each cloud's bounding sphere, found as its points are laid out.
- A cloud's age counts once it is drawn.

Windows, loopback, medians of 2. Cloud age p50 and p95 in ms when drawn, with clouds a second
where below 10:

| Way | 100k | 400k | Busy 9 ms of 10, 100k | 20 ms of work a cloud, 100k | Quarter core, 100k |
| --- | --- | --- | --- | --- | --- |
| so | 47, 72 | 102, 127, 9.7 | 198, 255, 9.1 | 72, 97 | 107, 439, 7.2 |
| split | 51, 85 | 115, 128, 9.6 | 38, 61 | 68, 102 | 124, 475, 6.6 |
| own | 53, 85 | 111, 126, 9.8 | 36, 60 | 68, 100 | 108, 464, 6.9 |
| prep | 52, 83 | 105, 124, 9.7 | 38, 58 | 66, 96 | 88, 410, 7.6 |
| draw | 50, 78 | 95, 131, 9.1 | 28, 53 | 69, 99 | 72, 364, 8.1 |
| owndraw | 54, 82 | 92, 124, 9.5 | 28, 53 | 64, 97 | 69, 369, 8.2 |

The main thread's busy time, how late a 20 ms timer runs at p95 in ms, which is how long input
waits, and the page's CPU:

| Way | Busy, 100k | Busy, 400k | Late, 400k | Late, 20 ms of work | Late, quarter core | Page CPU, 400k |
| --- | --- | --- | --- | --- | --- | --- |
| so | 28% | 51% | 26 | 27 | 283 | 80% |
| split | 11% | 20% | 12 | 23 | 278 | 81% |
| own | 10% | 19% | 12 | 22 | 248 | 81% |
| prep | 9% | 10% | 8 | 8 | 140 | 75% |
| draw | 5% | 3% | 8 | 9 | 130 | 64% |
| owndraw | 4% | 3% | 8 | 8 | 96 | 67% |

Linux, page, backend and sim on karbon, DevTools' throttle, 100k. Cloud age p50 and p95 in ms
when drawn, and at 10x how late the timer runs and how busy the main thread is:

| Way | Full speed | 4x slower | 10x slower | 4x slower, 10 ms of work | Late, 10x | Busy, 10x |
| --- | --- | --- | --- | --- | --- | --- |
| so | 24, 29 | 65, 80 | 341, 397, 5.7 | 77, 95 | 101 | 87% |
| split | 24, 29 | 38, 46 | 62, 76 | 47, 53 | 43 | 62% |
| own | 25, 29 | 38, 47 | 64, 74 | 47, 54 | 46 | 58% |
| prep | 22, 27 | 30, 36 | 44, 54 | 40, 46 | 23 | 44% |
| draw | 22, 27 | 23, 28 | 24, 27 | 34, 38 | 6.5 | 21% |
| owndraw | 22, 27 | 23, 28 | 24, 28 | 33, 38 | 4.2 | 16% |

Where the main thread's time goes, a CPU profile at 400k with everything on it (so), per cloud:
LZ4 unpacking 16 ms, laying out the points 7.6, three.js's bounding sphere 7.7, joining the
pieces 1.2, and the harness's own reading of each piece 1.6. With the layout in a worker (prep)
the hand-over costs the main thread 0.2 ms a cloud, as its arrays are transferred, not copied,
and the bounding sphere is most of what is left, 6 ms.

Giving three.js the bounds, the main thread's busy time and the page's CPU:

| Way | Busy, 100k | Busy, 400k | Page CPU, 400k |
| --- | --- | --- | --- |
| so | 29% | 51% | 80% |
| so, bounds given | 26% | 43% | 76% |
| prep | 9% | 11% | 81% |
| prep, bounds given | 7% | 6% | 74% |
| draw | 5% | 3% | 72% |
| draw, bounds given | 5% | 3% | 65% |

- Where the main thread is slow and a core is spare, drawing in the worker keeps full speed's
  age: 24 ms at 10x on Linux, against 341 at 5.7 clouds a second on the main thread, 62 with
  only the decoding in a worker and 44 with the layout there too. Input waits 6.5 ms at p95
  against 101.
- A main thread busy with the screen's own work, 9 ms of 10 on Windows: 28 ms drawn in the
  worker, 38 with the decoding there and 198 on the main thread.
- A cloud's own processing belongs with the cloud: 20 ms of it in the worker leaves input
  waiting 8 ms at p95, against 23 to 27 on the main thread, at the same age.
- At full speed age is alike, but the main thread is 3 to 5% busy against 28 to 51%, and the
  page costs least in all where the worker draws, 64% of a core against 80% at 400k, as the
  cloud never becomes a page value or crosses threads.
- Held to a quarter of one core, drawing in the worker brings the most clouds, 8.1 a second
  over four runs against 7.0 with only the decoding there, and input waits about half as long.
  Single capped runs spread widely, 7 to 9.4 clouds a second for one way. The pings and writes
  the main thread handles wait longer beside a busy worker, p95 167 to 365 ms against 25 to 44
  with everything on the main thread, as stage 8 found too. Under one shared core the worker
  takes the turns the main thread's messages would have had.
- Unpacking is the biggest single cost at 400k, 16 ms a cloud on this machine, where
  large-payloads timed 0.3 ms at 15k. It belongs off the main thread with the rest.
- three.js walks every point of a new geometry for its bounding sphere before it draws. Found
  as the points are laid out it saves about 7 ms a cloud at 400k, wherever the cloud is drawn.
- The copy three.js made of each cloud before this stage measured nothing: busy 25% before it
  was dropped, 28% after, within the runs' spread.
- Drawing in a worker needs every part kind there, and a part's colour read without CSS, which
  a worker lacks. An expression that computes over a cloud, not only passes it along, needs
  the cloud on the main thread or evaluated in the worker.

Sends through a worker of their own, the first socket read and written there (outw, drawoutw),
against the main thread's own socket (split, draw). A write's echo p50 and p95 in ms, and the
main thread's busy time:

| Way | Windows 100k | Windows 400k | Windows, busy 9 ms of 10 | Linux 4x slower | Linux 10x slower | Busy, Linux 10x |
| --- | --- | --- | --- | --- | --- | --- |
| split | 2.2, 12.5 | 2.4, 26.4 | 9.6, 12.1 | 1.1, 2.4 | 3.2, 7.3 | 62% |
| outw | 1.4, 12.6 | 5.2, 21.9 | 11.4, 12.8 | 0.9, 1.8 | 2.5, 9.1 | 59% |
| draw | 1.5, 6.5 | 1.9, 16.9 | 9.5, 10.2 | 1.0, 2.4 | 2.6, 5.5 | 21% |
| drawoutw | 1.4, 9.8 | 4.8, 22.4 | 9.4, 10.2 | 1.0, 1.9 | 2.2, 4.4 | 16% |

- A worker of their own changes a write's round trip by no more than the runs' spread, and
  takes 1 to 4 points of busy time off the main thread, the decoding of its small messages.
- It cannot help a busy main thread. A write is made there, by a person's action or the
  screen's code, so it waits for the main thread either way: 9 to 11 ms at 9 ms of 10.
- Through the worker that reads the big values (own) a write waits while it decodes a cloud:
  p50 4.8 ms against 1.2 on Windows at 100k.

So a worker should do all of a big value's work: read it on its own way, unpack it, lay it
out, process it and draw it, the page passing a ref along. That keeps full speed's age on a
slowed main thread and costs the page least. Sends and small values stay on the main thread's
socket, as a worker of their own gains nothing measurable. three.js should be given each
cloud's bounds.

## Stage 12: deltas

Offline, as large-payloads' first experiment was (`delta30` in the scratchpad): 20 updates of
each value, each sent every way against the one before, timed on the backend in Rust and applied
in node as the page's worker would, every result checked against the true value.

Values:

- Grid: an occupancy grid of 2000 by 2000 cells, a robot seeing 8 m round it each update, cells
  at a wall's edge flickering. And one that grows 100 cells on a side every 4 updates, as a
  SLAM map does, so every row moves.
- Map: 1.24 million points, x y z and intensity, the new area added and about 1100 points
  removed each update, clusters where something moved and single outliers. Kept four ways: gaps
  closed, so all after a removal move up, a removed point's place taken by the last, sorted by
  voxel, so new points land everywhere, and voxel blocks in a hash map's order, which changes as
  it grows. And two more: points within 8 m refined each update, as a map that averages does,
  and a loop closure at update 10 that moves every point.
- Lidar: 128 by 1024, still, 1 cm of noise. Path: poses, 10 more each update, a window of 10,000
  or growing. Detections: 2000 rows, a twentieth moving, a hundredth gone and as many new.

Ways:

- full: shuffle and LZ4, as today.
- xor: each byte against the one at its place in the base, everything after a shift too.
- ends: the rows shared at either end, and the new rows between.
- match: rows matched against the base, sent as copies and new rows. No ids. It indexes every
  16th row's window of the base by hash, and at each break tries the last copy's alignment,
  then up to 64 rows removed, then rows inserted since the break, before the index. Runs grow
  by comparing the rows' bytes 64 rows at a time, and rows are hashed only where the index
  starts a window and where no run is found yet.
- ids: an id a row, sent as the ids gone and the rows new or changed.
- patch: zstd with the base as its reference, a diff of bytes.

KB an update, medians, and for the loop closure its largest:

| Value | Full | xor | ends | match | ids | patch |
| --- | --- | --- | --- | --- | --- | --- |
| Grid, exploring | 40 | 18 | 12 | 5.2 | | 3.1 |
| Grid that grows | 22 | 8.8, 43 as it grows | 7.1 | 3.1 | | 2.6 |
| Map, gaps closed | 12,294 | 12,662 | 12,260 | 126 | 126 | 180 |
| Map, last into the gap | 12,373 | 227 | 12,331 | 141 | 126 | 182 |
| Map, sorted by voxel | 12,245 | 13,090 | 12,158 | 126 | 128 | 180 |
| Map, blocks in hash order | 12,241 | 13,058 | 12,173 | 126 | 130 | 182 |
| Map, refined in range | 12,309 | 12,670 | 12,271 | 1,664 | 1,674 | 2,097 |
| Map, loop closure | 13,440 | 13,933 | 13,415 | 12,238 | 12,287 | 7,448 |
| Lidar | 1,223 | 1,183 | 1,223 | 1,227 | 1,231 | 1,489 |
| Path, window | 101 | 104 | 101 | 0.3 | 0.3 | 0.3 |
| Path, growing | 54 | 0.9 | 0.3 | 0.3 | 0.3 | 0.3 |
| Detections | 31 | 30 | 31 | 2.2 | 2.1 | 2.1 |

The map's update, the backend's encoding and the page's applying in ms:

| Way | Encode | Apply |
| --- | --- | --- |
| full | 21 to 43 | 15 to 18, unpacking |
| match | 10 to 14, 25 refined | 4.0 to 4.4, 6.5 refined |
| ids | 199 to 212 | 5.5 to 6.6, 39 refined, and 58 to 68 once for its map of ids |
| patch | 27 to 37 | 22 to 26 in Rust, no page decoder takes a base |

- A delta of everything after a shift (xor) is the full value again once a gap closes or rows
  land in the middle. Only a removal that moves the last row into the gap keeps it small, 227
  KB, as each moves one row.
- Ids buy nothing over matching: the same bytes, a slower apply on the page, which keeps a map
  of 1.2 million ids (60 ms to build, 39 ms an update when 80,000 points refine), and an id
  column every publisher must send. Sequential ids add 0.4% to a full value, random ones would
  add a quarter.
- Matching needs no ids and no knowledge of the order. Closed gaps, swaps, sorted inserts and
  reshuffled blocks all come to the new points, 126 to 141 KB against 12.3 MB.
- A map that refines what it sees again still gains seven times, 1.7 MB against 12.3.
- What changes everywhere gains nothing: a lidar frame, or a map at a loop closure. A delta
  no smaller than the full value goes as the full value.
- Beyond maps, any list that keeps most of its rows gains: a path in a window 101 KB to 0.3, a
  list of detections 31 KB to 2.2.
- patch is a general diff of bytes, smallest on grids and quickest to encode, but 40% larger
  than matching on point maps. The page has no zstd decoder that takes a base (fzstd does not),
  so it would need one in wasm.
- Matching costs the backend less than sending the full value: 10 to 14 ms for 1.24 million
  points, where shuffle and LZ4 take 21 to 43. A first version that hashed every row a byte at
  a time and indexed every row took 130 to 160 ms. Hashing a row's values whole and reusing
  the base's hashes brought 74 to 95, an index of every 16th row with the search at each break
  20 to 31, and comparing bytes rather than hashes 10 to 14, each with the same bytes sent. Of
  those, building the base's index is 5 to 7 ms, which can be done once as the value arrives
  and shared by every screen on that base, and matching 3 to 5.
- On a byte grid matching sends 6.8 KB against 40 for the full value, but the page applies its
  many small copies in 13 ms against 1 to unpack the full one. LZ4 already makes a grid small,
  so a grid is best sent whole.
- The base is the value the screen last took. The took gate keeps one value in flight, so the
  backend knows it exactly, and keeps a copy a screen, 18 MB for this map. A screen without it,
  after a reconnect, gets the full value.
- At 1 Hz this map's 12 MB does not fit real WiFi's 6 to 9 MB a second, and its 126 KB deltas
  do.

So a big list of records should go as rows matched against the value the screen last took, and
as the full value when that is not much smaller. No ids. A grid of bytes goes whole.

## Stage 13: a page that falls behind

Seen on karbon's HMI across the LAN on 2026-10-27: a tab brought back after a while hidden
showed a ping of 33 s and then 37 s, answered inputs, and drew values that were plainly old
as they streamed in, so it was a page far behind, not a slow link. The same page at rest had
pings of 1 to 9 ms with runs of several seconds at 100 to 135 ms.

The pings the page times run through its own main thread, so they also show how Chrome's
renderer is scheduled: with this machine's CPU at 85 to 90% from test systems left running,
the page's pings sat at 30 to 100 ms while a WebSocket echo through the backend from Node on
the same machine ran at 0.5 ms median and 11 ms at the 99th percentile, and focusing the tab,
which Windows boosts, brought the page back to 5 ms.

Why:

- Small values and pongs went whole past the window on purpose, and the only guard, eight
  batches waiting in the lane, counted what the backend held, not what the link's buffers did.
  A page whose main thread stalled, as a hidden tab's does, kept its socket's pongs going from
  the browser's network process, so the window stayed open and the lane drained into the
  channel's 2 MB and the socket's TCP buffers, minutes of batches at 30 a second. Back, the
  page read them in order, each a pong among them timing the backlog.
- Stage 6 put pongs and small values on an unordered channel, and the second way then took big
  values off the channels. When the link channel took big values back, they shared its one
  ordered SCTP queue with every pong, which waited behind the window's worth of a picture's
  pieces, up to the margin's 100 ms.
- A screen's silence was judged by its socket's pongs, which a stalled page still answers, so a
  press held on it stayed held.

Built:

- The lanes send a batch of small values only while the page keeps up: each ping names the
  newest batch the page applied (`seen`), and a batch sent 250 ms ago (`LAG`) that it has not
  named holds those after it, a link with a longer round trip allowed twice that and the ping
  after it (`allow`), so a slow link is never held for being slow (`run-screen-handlers` drags
  through a 1 s delay each way). What is not values goes on past them. The lane's eight batch
  guard then fills, and all values go in their place once the page catches up
  (`run-stalled-page`: a main thread stalled 3 s shows at most 15 of the 60 counts it missed,
  31 without this).
- Pongs and small values go whole again on an unordered `small` channel beside the link
  channel, the rest in the lanes on the link channel as before, and the link channel carries
  them while the small one is not open. The page joins each channel's pieces apart: with one
  joiner, a pong that overtook the pieces of a batch of small values on the LAN landed in that
  batch, and the page read nothing (the first build on karbon faulted on every screen until
  this). `run-big-batch` drives a far screen (the between helper's `far` names it as a proxy
  would) through 120 KB batches beside a scan on the link channel, which no scenario had done,
  as every test screen was on loopback and so took its socket. The overtaking itself did not
  show on loopback, where the ordered queue drains as fast as it fills.
- A hidden page says so (`shown`), and is sent no values and no frames until it shows again,
  when it gets every value anew at once, big ones whole, and starts its round trips afresh.
  Recorded on the user's Chrome with the pacing alone: a tab hidden 6 minutes had its main
  thread run only every 10 to 16 s, each run applying the burst its ping let out, and on
  showing again it stayed dead about 5 s, then replayed the last burst and the pongs of the
  hidden period, which read as a ping of seconds. Nothing sent to a hidden page can be shown,
  so nothing is (`run-hidden-values`).
- A screen lets go of what it holds once its page has sent nothing for half a second, by its
  own pings, while it is lost only once its link stops answering for 5 s. A hidden tab's pings
  slow to one a second, so a hold never outlives a tab the operator left (`run-hidden-tab`,
  which held the opposite until now at the user's earlier choice).

## Recommendations

For the user to decide. Each rests on the stages above.

1. Queues. The backend bounds its lanes, and the socket pushes back. The channels do not, and
   WebTransport only after seconds in the browser's buffers. Hold a screen's next big value of
   an alias until the page took the last (`took`, 1 in flight) on whatever way carries big
   values. It bounds a slow page and costs nothing where the page keeps up, but a round trip a
   value on the channels on jittery WiFi.
2. Pieces. 16 KB on the socket: a sixth to a third less backend CPU, half the page's messages,
   lower age on a LAN, at a little cost on a slow WiFi. The channels do not care, and
   WebTransport needs none, a message a stream.
3. Which way. Big values off the channels on every link: they cost the backend two to three
   times the socket's CPU, cannot carry 37 MB a second even on wired gigabit, cost the page the
   most and fall furthest on real WiFi and at loss. That is the rule of 2026-10-21, values over
   16 KiB on the socket, which large-payloads moved onto the channels. Small values measured no
   gain and no loss on the channels, so their QoS channels can stay, though at 1% loss the
   shaper gave their pings twice the socket's p95.
4. Threads. One worker takes each big value from its way to the screen: reads, unpacks, lays
   out, processes and draws it, on the scene's canvas handed to it, the page passing a ref
   along. It keeps full speed's age on a slowed main thread, 24 ms at 10x against 341, keeps
   input's wait under 10 ms, and costs the page least. Sends and small values stay on the main
   thread's socket: a worker of their own gains nothing measurable, and through the big values'
   worker a write waits behind a cloud. Give three.js each cloud's bounds, 7 ms a cloud at
   400k. Under one shared core a busy worker delays the main thread's small messages.
5. Less data. Send a screen only the imports it shows, the biggest lever (backend 51% of a core
   to 12%). Cap the Data tab's previews in bytes a second, not in values. Offer used fields,
   and a lower rate with its cost in age, half the publisher's period.
6. WebTransport, for a page on https. Big values on it, small ones on the socket, the page's
   worker reading, decoding and drawing them: lowest age on a fast link, least page CPU, the
   one way that kept every cloud on a capped page. It needs the `took` gate, the socket's
   window as QUIC's congestion control, its pacing fixed for jitter, and a certificate of its
   own of at most 14 days, given to the page by hash. A page on plain http keeps the socket.
7. Testing. DevTools' throttle on Windows stalls a page with WebRTC, so slowed rows run on
   Linux, or under the job object cap, and a worker's gain under a throttle is its best case.
8. Deltas. A big list of records goes as rows matched against the value the screen last took,
   which the took gate makes known: copies of the base's runs and the new rows, no ids. It
   costs the backend less than the full value, 10 to 14 ms for 1.24 million points. The full
   value goes when the delta is not much smaller, as for a lidar frame or a loop closure, when
   the screen has no base, and for a grid of bytes. The page's worker applies it, 4 ms for a
   1.24 million point map against 15 to unpack it whole. Maps gain about a hundred times, paths
   and lists ten to three hundred.

## The final design

The user's decisions of 2026-10-24, on the recommendations:

- WebRTC carries video alone.
- Small values, replies, pings and writes go on the socket, read on the main thread.
- Big values, over 16 KiB, go on a second way: a second socket for a page on http, WebTransport
  for one on https. One data worker per screen reads them.
- Where expressions compute, the backend or the page, is left for later.

Built in six steps on branch paths-final, off data-paths:

1. The data path.
   - A screen says which imports and computed values its pages show (`watch`), and gets only
     those. The editor's Data tab previews every one.
   - Big values come on the screen's second way, `/bulk?session=&key=`, the key from its hello,
     so no other screen can open it. Where it cannot open they come on the socket, which hands
     them to the worker unread.
   - One big value of an import is on its way at a time. The newest waits until the screen says
     it took the last (`took`, naming its batch), or 5 s pass.
   - Pieces of 16 KB.
   - A screen on the HMI's own host gets values as they are, any other compressed.
   - The channels are gone. WebRTC opens once a screen plays a video, with one inactive
     transceiver, so an offer with every video stopped still bundles.
2. Scenes in the worker. Each scene's canvas goes to the worker, which draws every part kind
   with three.js, models too. The page reads each part's properties and posts them. Points that
   are a big value go as its ref, and the worker draws each new one itself, laid out there with
   its bounds. The main thread gets a big value's lists only where something there reads it
   whole. Elsewhere a list is far, its length alone.
3. Deltas. A big list beside one of its kind in the value the screen took last goes as the runs
   of that one's rows it kept and its new rows (tag 41002, `delta.rs`, the bench's match4). It
   goes whole under 4096 bytes, with rows narrower than 4 bytes, to a screen on the HMI's host,
   or when most rows are new. Screens that took the same value share each change. The worker
   applies it, and says it missed when it no longer holds the base, so it comes whole.
4. WebTransport for https, on the HMI's address and port over UDP. Its own certificate lasts
   14 days less an hour, is renewed every 7, and reaches the page by its hash. QUIC's congestion
   control is the socket's window (`FlightControl`), a stream a message. The page tries it
   first and takes the second socket where it has not opened in 5 s.
5. Fields, rate and the preview cap.
   - An import that reads may keep some fields (`fields`, paths such as `points.x`), pruned on
     the codec's shape tree so decode reads only those.
   - A topic imported to read may take a `rate`, Rant's `max_rate_hz` on its subscription.
   - The Data tab takes at most 250 KB a second of big values, its imports taking turns.
6. Edge cases, below.

Where it differs from the recommendations:

- Recommendation 3 kept the small values' channels. WebRTC carries video alone.
- Recommendation 6's jitter pacing fix was built and dropped: pacing by the shortest round
  trip brought fewer clouds on jittery WiFi, 7.4 a second against 9.1 to 10.1 stock, and lost
  some from the shaper's queue.
- Recommendation 5 put a rate's cost at half the publisher's period. Measured it was 11 to 19
  ms at the median for a 10 Hz lidar at a rate of 5, so the docs give only its bound, one
  period of the source.

## As built

Step 3, karbon's map (100k points, 50 lost and 50 gained each time, 5 a second) to pages here
across the LAN:

- 1.25 MB whole, then about 1 KB a change. One page took 13.6 KB a second.
- 121 of 121 maps equal to those of a page taking them whole through an ssh tunnel.
- A page slowed 20 times got changes 2 to 12 batches behind, all equal.

Step 4, WebTransport across the LAN:

- The map over WebTransport took 12.4 KB a second, 120 of 120 equal, and a reload opens it
  again.
- The lidar's 100k clouds at 10 a second, wired: WebTransport p50 35 to 39 ms and p95 49 to 51,
  the second socket 35 to 36 and 52.

Step 5, the lidar's 100k clouds at 10 a second to an http page across the LAN:

| Import | Bytes a second | Backend CPU | Age p50 |
| --- | --- | --- | --- |
| Every field | 9.5 MB | 15% | 40 to 45 ms |
| x, y and z | 8.4 MB | 13% | 35 to 41 ms |
| A rate of 5 | 4.7 MB | 8% | 56 to 64 ms |
| Both | 4.1 MB | 7% | 46 to 57 ms |

The editor's Data tab beside that screen took 271 KB a second and left the screen's age as it
was, where its Run tab took 9.5 MB a second more and the screen's p50 went from 46 to 56 ms.

## Edge cases

Step 6 tried each way a value can be on its way while something changes.

Scenarios on this host, kept in the suite:

- `run-big-turns`: a screen on a link of 600 KB a second showing the cell's scan, 1.2 MB a
  second, has its page left and opened 12 times, its second socket cut mid value, its link cut,
  and the HMI restarted. The editor's Design tab draws the scene as its pages and tabs switch.
  The scan comes again each time, never 1.5 s between two values, none lapsing.
- `run-big-import-edit`: a scene's import has its fields narrowed so its points lack z, which
  the editor's scene says, then widened, renamed, and removed and made again.
- `run-webtransport` and `run-second-socket` count a camera's pictures against those the HMI
  sent meanwhile, as a camera a busy machine slows once failed the first under the full suite.
- The suite passes 147 of 149, the two of the app lacking Electron on this host.

Across the LAN and on Linux (scratchpad harness `edges-karbon.mjs`): karbon's map to five
pages, each map's checksum compared stamp by stamp with a page taking it whole through an ssh
tunnel, or on loopback on karbon itself. One page goes direct, one through a proxy that cuts
its connections, one slowed 20 times, and one through a shaper on karbon at 3 MB a second with
1% loss and up to 10 ms of jitter. Phases: steady, the page left and opened 10 times, the
second way cut (http), the link cut or every connection cut (https), the import without
intensity and with it again, reloads, and the HMI restarted. Run from Windows across the LAN
and on karbon itself in Chrome for Testing 155, each over http and https:

- Every map a page showed equalled the whole page's, in every phase of every run, the four on
  the final code too, after the fixes below.
- On the final code no change missed its base, so no map went again whole.
- WebTransport opened on every https page with UDP to the HMI, the shaped one through its loss,
  and held 215 s there without a break. A page whose UDP goes nowhere took the second socket.
- The slowed page lapses now and then, as its main thread takes over 5 s for a map it reads
  whole. Nothing else lapses.

Found and fixed:

- A took named no batch, so word of a value sent before a page was left could free the value
  sent after it opened again. It names its batch now, and a late one is passed over.
- A small value went ahead of an older big one of the same import still waiting, which then
  followed it. A small value now leaves an older one waiting unsent.
- A value a scene drew and the main thread read whole was taken once drawn, so the main thread
  could fall seconds behind, the worker queuing a copy of each map for it. Taken where the main
  thread reads it, the next waits for the slower of the two.
- A screen leaving a page let go of its import's values in the worker before the backend heard,
  so a change on its way missed and the whole value went again to a screen no longer showing
  it. The worker now passes over a value of an import it no longer shows, and the backend lets
  it go.
- The demo line slept 50 ms after each round, so its 20 a second fell to 13 with its work, and
  `data-import-fields` failed. It keeps a 50 ms beat now.

Then a pass for races, and one for screens at the same time, asked by the user. Each place two
ways, two threads or two screens meet was walked through for what can come in between.

- A handler's run was shared by every screen, so while one screen's run of a button's handler
  went on, the same tap from another was dropped. Two screens tapping at once counted 21 of 40
  taps, and with `await open(...)` a button did nothing on other screens until the first closed
  that page. Each screen now runs its own, and what waits for a run is the screen's own, so a
  start still drops only while that screen's run goes on (`run-screens-at-once`). This is on
  main too, and is a change in how handlers run for the user to review.
- Runs going on at once lost each other's writes. A run's writes went out only once every run
  ready to go on had gone, so two waking from a sleep together both read the value before
  either wrote, and two screens adding 1 each made it 1. Any two handlers waiting in turn could
  do it, and screens running their own made it likelier. Each await now sends what the run
  wrote first (`__yield`, which the operator rewrite puts on every await), and so does its end,
  unless it threw, which drops what it wrote since it last waited as before. An engine test
  fails without it.
- A screen that went told the engine to drop its own variables before its held inputs' ends
  ran, so a release with `p.lost` that read one of them stopped as unknown. The engine now
  hears a screen went only once its runs, and the ends waiting for them, are done. An
  end waiting for its screen's run still runs once the screen went, as a held input never loses
  its end (`run-lost-screen` cuts a screen's link mid press for it).
- A screen that opened a second way while the HMI still held its last, as when WebTransport
  opened on the HMI's side too late for the page, lost what was on its way there, and the last
  one's close no longer counted, so the next waited 5 s. Opening another now sends each value
  again, as losing one does (`run-second-again`, which fails on the old code).
- The worker's posts named no session, so one read before the link came again, landing after
  the new hello, set the page's batch for an import from the last session. After the HMI
  restarted, its batches counting from 1 again, that import would show nothing new until its
  batches passed the old one. Each post names its session now, and one from the last is passed
  over.
- The worker could take an older big value after a newer one, as one still on a way the screen
  let go, and a scene drew it. It passes over one older than the newest it handed on in the
  session, as the main thread does.

Found, not fixed:

- Rant: a subscriber with no `max_rate_hz` replacing one with it on the same topic can stay
  throttled, as the announce's rate section lists only topics with a rate. Clearing an import's
  rate may not take effect until the publisher matches again. Seen on karbon and here.
- A page slower than 5 s a value lapses, and each lapse sends the next while the last is still
  queued for its main thread.
- Chrome said ERR_METHOD_NOT_SUPPORTED opening WebTransport twice in step 4's first runs, on a
  slowed or reloaded page. Not seen since, in runs with reloads, a page slowed 20 times and
  Chrome's net log on.

Not run:

- The app's scenarios, as this host lacks room to build its addon. Its link is unchanged, and
  its big values take the path of a screen whose second socket is refused, which
  `run-scene-worker` and `run-second-socket` cover.
- Real WiFi, as forcing the page's traffic onto it takes an elevated route. Stage 10 measured
  every way on it, and the shaped link covers loss and jitter.

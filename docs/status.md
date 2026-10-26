# Status

The HMI publishes two read only variables about itself. Other nodes read them, and pages
import them like any entity. Each is set only when it changed: the clients as each screen's
round trip is measured, 20 times a second, and the status once a second.

## Hmi/Clients

The screens connected, a list. Each holds:

- `id`: its number, as the log and `p.screen` give it
- `address`: where it connects from
- `connected_at`: when it connected, a Rant Timestamp: microseconds since the Unix epoch
- `ping_ms`: the last round trip the screen timed, 0 until one is measured: a ping through the
  HMI in turn with what the screen sends, and back the way its values come, so on its WebRTC
  link channel once that carries them.
- `jitter_ms`: how much the round trip wavers, smoothed as RTP does: each new round trip
  moves it a sixteenth of the way to how far that one was from the last
- `webrtc`: whether its WebRTC connection is open. Without it the screen gets its video as
  frames over its socket and decodes them itself, which only a page on https or localhost can
  do.
- `channel`: whether its values, pings and actions go on its WebRTC link channel, else its
  socket
- `ping_spread_ms`: its round trips of the last 10 s, as `[median, 90th percentile, most]`
- `big_spread_ms`: the trips of the big values it took in the last 10 s, from going until it
  said it took each, so what each took to arrive, be read and be shown, the same way
- `bigs_per_s`: how many big values it took a second, over the last 10 s
- `lapsed`: the big values it never said it took within 5 s, since it connected
- `kbps`: what its socket, second way and link channel carried to it over the last 10 s, in
  kilobits a second, its WebRTC video apart
- `webrtc_problem`: why its WebRTC connection did not open, as the screen found, empty while
  it is open: `no_webrtc`, `browser_blocks` (no address gathered at all, as a VPN or a privacy
  extension makes so), `network_blocks_udp` (no public address) or `no_path`

## Hmi/Status

- `version`: the HMI's version
- `project`: the project's name
- `started_at`: when the HMI started, a Timestamp too
- `clients`: how many screens are connected
- `missing`: the entities imported but not on the mesh now

```js
`${Screens.length} screens, ${HmiStatus.missing.length} imports missing`
```

## The node's status

A screen still without its WebRTC link channel 15 s after it connected raises a warning on the
HMI node's Rant status, `screen-<id>-webrtc`, naming its address and what to check, which clears
once the channel opens or the screen goes. A screen on the HMI's own host keeps to its socket and
is never warned of. The screen shows the same in its banner, which the person may dismiss.

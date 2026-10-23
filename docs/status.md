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
  HMI in turn with what the screen sends, and back the way its values come.
- `jitter_ms`: how much the round trip wavers, smoothed as RTP does: each new round trip
  moves it a sixteenth of the way to how far that one was from the last
- `webrtc`: whether its WebRTC connection is open, which carries its values and video too.
  Without it the screen gets everything over its socket, its video as frames it decodes
  itself, which only a page on https or localhost can do.

## Hmi/Status

- `version`: the HMI's version
- `project`: the project's name
- `started_at`: when the HMI started, a Timestamp too
- `clients`: how many screens are connected
- `missing`: the entities imported but not on the mesh now

```js
`${Screens.length} screens, ${HmiStatus.missing.length} imports missing`
```

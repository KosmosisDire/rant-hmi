# Status

The HMI publishes three read only variables about itself: `Hmi/Status`, `Hmi/Clients` and
`Hmi/Problems`. Every project's `Hmi` object reads them as `Hmi.Status`, `Hmi.Clients` and
`Hmi.Problems`, and any node on the mesh may read them too.

```js
`${Hmi.Clients.length} screens, ${Hmi.Status.missing.length} members missing`
Hmi.Problems.filter((p) => p.level === "fault").length
```

Times are Rant Timestamps, microseconds since 1970.

## Hmi/Status

| Field | Is |
| --- | --- |
| `version` | the HMI's version |
| `project` | the project's name |
| `started_at` | when it started |
| `clients` | how many screens are connected |
| `missing` | the mesh members whose entities are not on the mesh now |

## Hmi/Clients

A list, one per screen connected:

| Field | Is |
| --- | --- |
| `id` | its number, as the log and `p.screen` give it |
| `address` | where it connects from |
| `connected_at` | when it connected |
| `ping_ms` | its last round trip to the HMI and back, 0 until one is measured |
| `jitter_ms` | how much its round trip wavers |
| `ping_spread_ms` | its round trips over the last 10 s, as `[median, 90th percentile, most]` |
| `webrtc` | true while its WebRTC connection is open |
| `channel` | true while its values go over WebRTC rather than its socket |
| `webrtc_problem` | why WebRTC did not open, empty while it is open: `no_webrtc`, `browser_blocks` (no address at all, as a VPN or a privacy extension makes), `network_blocks_udp` (no public address) or `no_path` |
| `kbps` | what it was sent over the last 10 s in kilobits a second, video apart |
| `big_spread_ms` | how long its large values, as pictures and point clouds, took to show over the last 10 s, as `[median, 90th percentile, most]` |
| `bigs_per_s` | how many large values it showed a second, over the last 10 s |
| `lapsed` | how many large values never showed within 5 s, since it connected |

## Hmi/Problems

What is wrong now, as the editor's list shows them:

| Field | Is |
| --- | --- |
| `screen` | the screen that found it, 0 for the HMI itself |
| `source` | `page` for a value or drawing that fails, `run` for a handler or logic that stopped, `hmi` for a fault in the HMI itself |
| `level` | `warn` or `fault` |
| `text` | what went wrong |
| `page`, `element` | where it is, empty for none |
| `count` | how many times it came |
| `at` | when it came last |

`GET /problems` on the HMI's port gives every problem as JSON with the same fields, but
`screen` null for the HMI itself, `detail` holding the stack where there is one, and `at` in
ms since 1970.

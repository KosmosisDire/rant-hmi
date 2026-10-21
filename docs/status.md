# Status

The HMI publishes two read only variables about itself. Other nodes read them, and pages
import them like any entity. Each is set only when it changed: the clients as each screen's
round trip is measured, 20 times a second, and the status once a second.

## Hmi/Clients

The screens connected, a list. Each holds:

- `id`: its number, as the log and `p.screen` give it
- `address`: where it connects from
- `connected_at`: when it connected, in Unix seconds
- `ping_ms`: the last round trip to it and back, 0 until one is measured

## Hmi/Status

- `version`: the HMI's version
- `project`: the project's name
- `started_at`: when the HMI started, in Unix seconds
- `clients`: how many screens are connected
- `missing`: the entities imported but not on the mesh now

```js
`${Screens.length} screens, ${HmiStatus.missing.length} imports missing`
```

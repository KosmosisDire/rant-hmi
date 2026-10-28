# Deploy

## Screens on other computers

Open `http://<host>:6739/run` on any computer that reaches the HMI's host. A screen that uses
a gamepad, or plays video without WebRTC, needs `https://<host>:6739/run`.

- The HMI's own certificate is in `~/.rant/hmi`, to trust on a screen.
- `--cert` and `--key` on `rant-hmi` take a real certificate and its key, as PEM files.

## Networks

Screens use WebRTC where they can, and it carries video.

- `rtc_ports=6740-6759` on `rant run Hmi` pins the ports WebRTC uses, to open them in a
  firewall or forward them.
- STUN servers tell the HMI the address the outside sees it at. A new project has two public
  ones, and `ice = []` in `hmi.toml` uses none.
- A TURN server relays for a screen that reaches the HMI no other way.

```toml
[[ice]]
urls = "stun:stun.l.google.com:19302"

[[ice]]
urls = "turn:turn.example.com:3478"
username = "user"
credential = "secret"
```

## Apps

The download button in the editor's top bar makes the HMI an app for a device: open the
editor on the device, pick what the app does, and download it.

| Choice | Takes |
| --- | --- |
| Platform | Windows, Linux or Linux on ARM, this device's when you open it |
| Runs | in the app: the HMI and its logic run on the device, on the server's domain, with no server. On this server: the app shows the server's screen |
| Opens | in a window or full screen. F11 switches |

On Linux, mark the file as a program first, with `chmod +x` or in its properties.

Without the editor:

```console
$ curl -o line.exe "http://host:6739/app/win-x64?runs=device"
```

| Part | Takes |
| --- | --- |
| the path's last part | `win-x64`, `linux-x64` or `linux-arm64` |
| `runs` | `device` to run in the app, or `screen` to show a server's screen |
| `address` | with `runs=screen`, the server, as `http://host:6739` |
| `fullscreen` | `true` to open full screen |

### With no way to GitHub

An app is built from a runtime the server fetches from the
[HMI's release](https://github.com/KosmosisDire/rant-hmi/releases) of its own version.

- Get `rant-hmi-runtime-<version>-<platform>.tar.gz` from that release yourself and put it in
  `~/.rant/hmi/runtimes/<version>/` as it is.
- Or `--runtimes-from <url>` on `rant-hmi` fetches them from a mirror of the release's files.

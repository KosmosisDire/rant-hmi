# Deploy

## Screens on other computers

Open `http://<host>:6739/run` on any computer that reaches the HMI's host. Browsers allow
gamepads only on https, and video without WebRTC too, so use `https://<host>:6739/run` for
those.

- The HMI makes its own certificate and keeps it in `~/.rant/hmi`. A browser warns about it
  until you trust it.
- `--cert` and `--key` on `rant-hmi` take a real certificate and its key, as PEM files.

## Networks

A screen talks to the HMI over its socket, and over WebRTC where it can, which goes straight
between the two and carries video. A screen without WebRTC keeps working over its socket.

- `rtc_ports=6740-6759` on `rant run Hmi` pins the ports WebRTC uses, to open them in a
  firewall or forward them.
- STUN servers tell the HMI the address the outside sees it at. A new project has two public
  ones, and `ice = []` in `hmi.toml` uses none.
- A TURN server relays for a screen that reaches the HMI no other way.
- A screen whose WebRTC did not open says why in a banner. A browser that found no address at
  all is kept from UDP, often by a VPN or a privacy extension.
- A proxy in front of the HMI, as a Cloudflare tunnel, works: the socket comes through it and
  WebRTC goes straight.

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
editor on the device, pick what the app does, and download it. The app is one file, so
nothing is installed first.

| Choice | Takes |
| --- | --- |
| Platform | Windows, Linux or Linux on ARM, this device's when you open it |
| Runs | in the app: the HMI and its logic run on the device, on the server's domain, with no server. On this server: the app shows the server's screen |
| Opens | in a window or full screen. F11 switches |

- Windows warns about an app from an unknown publisher: choose More info, then Run anyway.
- On Linux, mark the file as a program first, with `chmod +x` or in its properties.
- The first start takes a few seconds to unpack.
- An app is the HMI as it was when downloaded. Download it again for a newer one.

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

The server builds an app from its platform's runtime, which it fetches from the
[HMI's release](https://github.com/KosmosisDire/rant-hmi/releases) of its own version the
first time, about 170 MB.

- Get `rant-hmi-runtime-<version>-<platform>.tar.gz` from that release yourself and put it in
  `~/.rant/hmi/runtimes/<version>/` as it is.
- Or `--runtimes-from <url>` on `rant-hmi` fetches them from a mirror of the release's files.

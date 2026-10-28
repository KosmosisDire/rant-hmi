# Getting started

Rant HMI makes screens for the machines on a Rant mesh. You design pages in the browser, and
the HMI runs them. A project is a folder of plain text files, which you may also edit by hand.

## Run it

```console
$ rant install hmi
$ rant run Hmi project=my-hmi
```

Open http://localhost:6739 to design, and http://localhost:6739/run on an operator's screen.

| Param | Default | Is |
| --- | --- | --- |
| `project` | | the project folder. A new folder starts a new project |
| `port` | `6739` | the port it serves on |
| `bind` | `0.0.0.0` | the address it listens on, `127.0.0.1` for this computer only |
| `rtc_ports` | any | the ports WebRTC may use, as `6740-6759` ([Deploy](deploy.md#networks)) |

| To | Run |
| --- | --- |
| stop it | `rant stop Hmi` |
| see its output | `rant log Hmi` |
| run it at every boot | `rant enable Hmi project=my-hmi` |

## A first screen

A new project opens on an empty page.

1. In **Objects**, find your machine's folder in the mesh list and press its **+**. That makes
   an object for the machine.
2. Press **+** on each entity the screen needs, as its speed.
3. In **Design**, press **+** beside Layers, then **Show an import**, and pick the entity and a
   component to show it.
4. Open **Run** to try it.

The counts at the bottom right of the editor list anything that goes wrong.

## More

| Page | Holds |
| --- | --- |
| [Project](project.md) | the files, objects, logic, settings and theme |
| [Pages](pages.md) | every element and property a page uses |
| [Components](components.md) | making components, and the standard ones |
| [Events](events.md) | what a handler hears and what its `p` holds |
| [Code](code.md) | every name and function code reads, and the math |
| [Deploy](deploy.md) | screens on other computers, networks and apps |
| [Status](status.md) | what the HMI publishes about itself |

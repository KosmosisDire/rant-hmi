# Getting started

Rant HMI makes screens for the machines on a Rant mesh. You design pages in a browser editor,
and the HMI runs them and their logic. A project is a folder of plain text files. The editor
writes them, and you may write them too.

## Run it

```console
$ rant install hmi
$ rant run Hmi project=line-hmi
```

Open http://localhost:6739 to design the project, and http://localhost:6739/run on an
operator's screen.

| Param | Default | Is |
| --- | --- | --- |
| `project` | | the project folder, from where you run the command. An empty folder becomes a new project |
| `port` | `6739` | the port it serves http and https on |
| `bind` | `0.0.0.0` | the address it listens on, `127.0.0.1` for this computer only |
| `rtc_ports` | any | the ports WebRTC may use, as `6740-6759` ([Deploy](deploy.md#networks)) |

| To | Run |
| --- | --- |
| stop it | `rant stop Hmi` |
| run it at every boot | `rant enable Hmi project=line-hmi`, and `rant disable Hmi` to stop that |
| see its output | `rant log Hmi`, `-f` to follow |

## A first screen

1. Find what the machine offers. `rant ls entities` lists the mesh, and
   `rant info Line1/Speed` shows an entity's type and fields.
2. Make an object for the machine, `objects/Line.html`, naming the entities the HMI uses:

   ```html
   <object name="Line" mesh="Line1">
     <variable name="Speed" entity="Speed"/>
     <function name="Reset" entity="Reset"/>
   </object>
   ```

3. Show it on a page, `pages/overview.html`:

   ```html
   <page name="Overview" size="128x72">
     <Readout id="e1" name="Speed" x="4" y="4" w="24" h="8" label='"Speed"' value="Line.Speed" unit='"m/s"'/>
     <Button id="e2" name="Reset" x="4" y="14" w="24" h="6" text='"Reset"'>
       <on event="confirm">
         await Line.Reset();
       </on>
     </Button>
   </page>
   ```

4. Save. Every open screen shows the change at once.

The editor writes the same files, so each step works there too.

## Find problems

- A file with a mistake is refused, and the last good one stays. `rant log Hmi` names the file
  and the reason.
- The editor's status bar counts what goes wrong on any screen and opens the list: a value that
  cannot be worked out, a handler or logic that stopped, a video that cannot play.
- `curl http://localhost:6739/problems` gives the same list as JSON
  ([Status](status.md#hmi-problems) lists its fields).

## Good to know

- Try a project against a simulator on a domain of its own, as `--domain 5`, never on the
  domain of a machine in use.
- There are no logins yet. Whoever reaches the port can change the project and press its
  buttons. Use `bind=127.0.0.1` on a shared network, or put access control in front.

## Pages

| Page | Holds |
| --- | --- |
| [Project](project.md) | the files, objects, logic, settings and theme |
| [Pages](pages.md) | every element and property a page uses |
| [Components](components.md) | making components, and the standard ones |
| [Events](events.md) | what a handler hears and what its `p` holds |
| [Code](code.md) | every name and function code reads, and the math |
| [Deploy](deploy.md) | screens on other computers, networks and apps |
| [Status](status.md) | what the HMI publishes about itself |

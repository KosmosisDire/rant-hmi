// A finished HMI runs in rant-hmi-app, its backend in the same process as its window. The window's
// screen reads and writes the mesh with no socket, opens a new session on a reload, and the editor
// says it is in the app. F11 fills the screen and gives it back, and --fullscreen opens it so.
// Started as a person starts it, the screen keeps its one session and the
// process listens on no port, and closing the window ends the HMI, then the app. Given an HMI's
// address the window shows that HMI's screen, which connects to it as a browser's does. A project
// that cannot open leaves the window saying why, and so does nothing to show.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveApp, openApp, ROOT } from "../harness.mjs";

const PAGE = `<page name="main" size="64x36">
  <span id="e1" name="reading" x="1" y="1" w="30" h="4">Speed.toFixed(2)</span>
  <div id="e2" name="slower" x="1" y="6" w="20" h="6" style="background: $panel">
    <on event="tap">
      Speed = 0.25;
    </on>
  </div>
</page>
`;

/** A domain no worker's system takes. */
const DOMAIN = 198;

/** Whether a driven app's window fills the screen. */
const fullscreen = (driven) => driven.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());

/** Presses F11 in a driven app's window as a keyboard does. Playwright's keys go straight to the
 *  page, past the window, which never sees them. */
const pressF11 = (driven) =>
  driven.app.evaluate(({ BrowserWindow }) => {
    const { webContents } = BrowserWindow.getAllWindows()[0];
    webContents.sendInputEvent({ type: "keyDown", keyCode: "F11" });
    webContents.sendInputEvent({ type: "keyUp", keyCode: "F11" });
  });

export default async function ({ sys, check, eventually }) {
  const temp = mkdtempSync(join(tmpdir(), "rant-hmi-app-"));
  const project = join(temp, "project");
  const home = join(temp, "home");
  mkdirSync(join(project, "data"), { recursive: true });
  mkdirSync(join(project, "pages"));
  writeFileSync(join(project, "hmi.toml"), 'name = "App line"\nstart = "main"\nice = []\n');
  cpSync(join(ROOT, "client", "tests", "project", "data", "imports.toml"), join(project, "data", "imports.toml"));
  cpSync(join(ROOT, "server", "library", "theme.toml"), join(project, "data", "theme.toml"));
  writeFileSync(join(project, "pages", "main.html"), PAGE);
  try {
    const driven = await driveApp(project, { home, domain: DOMAIN });
    try {
      const screen = driven.window;
      const errors = [];
      screen.on("pageerror", (e) => errors.push(e.message));
      screen.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      const sockets = [];
      screen.on("websocket", (ws) => sockets.push(ws.url()));
      const el = (id) => screen.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
      const reading = el("e1");
      await eventually(async () => (await reading.textContent())?.trim() === "0.50", "the demo line's speed in the window");
      check((await screen.title()) === "App line", `the screen is titled ${await screen.title()}`);
      check(screen.url() === "hmi://localhost/run", `the window shows ${screen.url()}`);
      await el("e2").click();
      await eventually(async () => (await reading.textContent())?.trim() === "0.25", "the speed written from the window");
      await screen.reload();
      await eventually(async () => (await reading.textContent())?.trim() === "0.25", "the speed after a reload");
      // F11 fills the screen with the window and gives it back
      await pressF11(driven);
      await eventually(() => fullscreen(driven), "the window to fill the screen on F11");
      await pressF11(driven);
      await eventually(async () => !(await fullscreen(driven)), "the window to leave full screen on F11");
      // the editor takes the same link, and its status bar says so
      await screen.goto("hmi://localhost/");
      await screen.locator(".statusbar", { hasText: "System" }).waitFor();
      const way = await screen.locator(".statusbar .stat").first().getAttribute("title");
      check(way === "Reached in this app, with no network", `the status bar says ${way}`);
      check(sockets.length === 0, `the screen opened sockets to ${sockets.join(", ")}`);
      check(errors.length === 0, `the screen logged errors:\n  ${errors.join("\n  ")}`);
      check(await driven.close(), `the app did not end as its window closed:\n${driven.process.log}`);
    } finally {
      driven.stop();
    }

    const app = await openApp(project, { home, domain: DOMAIN });
    try {
      // the backend and its screen share the process with no socket between them
      const listening = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" })
        .split(/\r?\n/)
        .filter((line) => /LISTENING/.test(line) && line.trim().split(/\s+/).at(-1) === String(app.app.pid));
      check(listening.length === 0, `the app listens on\n${listening.join("\n")}`);
      // past the 5 s a silent screen is lost in, the window's screen still has its one session
      await new Promise((r) => setTimeout(r, 6000));
      const said = app.app.log.match(/screen \d+ .*/g) ?? [];
      check(said.length === 1 && said[0].trim() === "screen 1 connected", `the window's screen went ${said.join(", ")}`);
      // closed, the app ends its screen's session and its node, then itself
      check(await app.close(), `the app did not end as its window closed:\n${app.app.log}`);
      check(/screen 1 the HMI is closing/.test(app.app.log), `the app's screen went ${app.app.log.match(/screen \d+ .*/g)}`);
    } finally {
      app.stop();
    }

    const connected = () => sys.backend.log.match(/screen \d+ connected/g)?.length ?? 0;
    const before = connected();
    // as a panel or a handheld opens it
    const remote = await driveApp(sys.url, { home, more: ["--fullscreen"] });
    try {
      await eventually(() => connected() > before, "the window's screen to connect to the HMI elsewhere", 20000);
      check(await fullscreen(remote), "the app opened with --fullscreen left the screen showing");
      // a browser's screen there, never told it is in the app
      check((await remote.window.evaluate(() => window.rantHmiApp)) === undefined, "the HMI elsewhere was told it is in the app");
      check(await remote.close(), `the app showing the HMI elsewhere did not end as its window closed:\n${remote.process.log}`);
    } finally {
      remote.stop();
    }

    // a project that cannot open leaves the window saying why until it is closed
    const failed = await driveApp(join(project, "hmi.toml"), { home });
    try {
      await failed.window.getByText("This HMI could not start").waitFor();
      const why = await failed.window.locator("pre").textContent();
      check(/hmi\.toml/.test(why), `the window says ${why}`);
      await new Promise((r) => setTimeout(r, 2000));
      check(failed.process.exitCode === null, "the app ended before its window was closed");
      check(await failed.close(), `the failed app did not end as its window closed:\n${failed.process.log}`);
    } finally {
      failed.stop();
    }

    // given nothing to show it says what to give it, and never makes the folder it runs in a project
    const here = join(temp, "here");
    mkdirSync(here);
    const bare = await driveApp(null, { home, cwd: here });
    try {
      await bare.window.getByText("Give it a project folder or an HMI's address").waitFor();
      check(readdirSync(here).length === 0, `the app made ${readdirSync(here).join(", ")} where it ran`);
      check(await bare.close(), `the app given nothing did not end as its window closed:
${bare.process.log}`);
    } finally {
      bare.stop();
    }
  } finally {
    // the window's browser lets go of its files a while after the app ends
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

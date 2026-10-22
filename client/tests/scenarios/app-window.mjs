// A finished HMI runs in rant-hmi-app, its backend in the same process as its screen. Driven in a
// browser through the app's link, the screen reads and writes the mesh with no socket and opens
// a new session on a reload. In the app's own window the screen loads from the window's scheme,
// opens its session and keeps it, and the process listens on no port. Given an HMI's address
// the window shows that HMI's screen, which connects to it as a browser's does. A project that
// cannot open leaves the window saying why.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, showApp, startApp } from "../harness.mjs";

const PAGE = `<page name="main" size="64x36">
  <span id="e1" name="reading" x="1" y="1" w="30" h="4">Speed.toFixed(2)</span>
  <div id="e2" name="slower" x="1" y="6" w="20" h="6" style="background: $panel">
    <on event="tap">
      Speed = 0.25;
    </on>
  </div>
</page>
`;

/** A domain and port no worker's system takes. */
const DOMAIN = 198;
const PORT = 6798;

export default async function ({ page, sys, check, eventually }) {
  const temp = mkdtempSync(join(tmpdir(), "rant-hmi-app-"));
  const project = join(temp, "project");
  mkdirSync(join(project, "data"), { recursive: true });
  mkdirSync(join(project, "pages"));
  writeFileSync(join(project, "hmi.toml"), 'name = "App line"\nstart = "main"\nice = []\n');
  cpSync(join(ROOT, "client", "tests", "project", "data", "imports.toml"), join(project, "data", "imports.toml"));
  cpSync(join(ROOT, "server", "library", "theme.toml"), join(project, "data", "theme.toml"));
  writeFileSync(join(project, "pages", "main.html"), PAGE);
  try {
    const linked = await startApp(project, { domain: DOMAIN, port: PORT });
    const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
    try {
      // what rant-hmi-app's window says before the page loads
      await context.addInitScript(() => (window.rantHmiApp = true));
      const screen = await context.newPage();
      const errors = [];
      screen.on("pageerror", (e) => errors.push(e.message));
      screen.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      const sockets = [];
      screen.on("websocket", (ws) => sockets.push(ws.url()));
      await screen.goto(`${linked.url}/run`);
      const el = (id) => screen.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
      const reading = el("e1");
      await eventually(async () => (await reading.textContent())?.trim() === "0.50", "the demo line's speed through the link");
      check((await screen.title()) === "App line", `the screen is titled ${await screen.title()}`);
      await el("e2").click();
      await eventually(async () => (await reading.textContent())?.trim() === "0.25", "the speed written through the link");
      await screen.reload();
      await eventually(async () => (await reading.textContent())?.trim() === "0.25", "the speed after a reload");
      // the editor takes the same link, and its status bar says so
      await screen.goto(linked.url);
      await screen.locator(".statusbar", { hasText: "System" }).waitFor();
      const way = await screen.locator(".statusbar .stat").first().getAttribute("title");
      check(way === "Reached in this app, with no network", `the status bar says ${way}`);
      check(sockets.length === 0, `the screen opened sockets to ${sockets.join(", ")}`);
      check(errors.length === 0, `the screen logged errors:\n  ${errors.join("\n  ")}`);
    } finally {
      await context.close();
      linked.stop();
    }

    const app = await startApp(project, { domain: DOMAIN });
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
    const remote = showApp(sys.url, join(temp, "remote"));
    try {
      await eventually(() => connected() > before, "the window's screen to connect to the HMI elsewhere", 20000);
      check(await remote.close(), `the app showing the HMI elsewhere did not end as its window closed:\n${remote.app.log}`);
    } finally {
      remote.stop();
    }

    // a project that cannot open leaves the window saying why until it is closed
    const failed = showApp(join(project, "hmi.toml"), join(temp, "failed"));
    try {
      await eventually(() => /ERROR.*hmi\.toml/.test(failed.app.log), "the app to say why the project did not open", 20000);
      await new Promise((r) => setTimeout(r, 2000));
      check(failed.app.exitCode === null, "the app ended before its window was closed");
      check(await failed.close(), `the failed app did not end as its window closed:\n${failed.app.log}`);
    } finally {
      failed.stop();
    }
  } finally {
    // the webview lets go of its files a while after the app ends
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

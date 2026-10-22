// Starts what a test needs: the demo line, the cage cell, the transcoder and a backend on their
// own loopback domain and port, with a fresh copy of the test project, and a headless Chrome to
// drive.

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, chromium } from "playwright-core";
import { built } from "../../app/addon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..", "..");
const exe = process.platform === "win32" ? ".exe" : "";

/** The build the scenarios run, and the client it serves. HMI_BUILD and HMI_CLIENT name others,
 *  so they can run while a backend from target/debug is open, serving client/dist. */
const BUILD = resolve(process.env.HMI_BUILD ?? join(ROOT, "target", "debug"));
const CLIENT = resolve(process.env.HMI_CLIENT ?? join(ROOT, "client", "dist"));

/** rant-transcoder, which makes the H264 a video plays, as its crate builds it in the RANT folder
 *  this sits in. HMI_TRANSCODER names another. Without one the video scenarios fail and say so. */
function transcoder() {
  if (process.env.HMI_TRANSCODER) return resolve(process.env.HMI_TRANSCODER);
  for (let d = ROOT; d !== dirname(d); d = dirname(d)) {
    const path = join(d, "transcoder-rant", "target", "release", `rant-transcoder${exe}`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Each system's domain and port by its slot: 153 and 6761, then 155 and 6762 on, kept apart
 *  from the cargo tests' 152 and 154 and from a running backend's port. */
const domainOf = (slot) => (slot === 0 ? 153 : 154 + slot);
const portOf = (slot) => 6761 + slot;

/** This process's environment for a child, `extra` over it. A variable given as undefined is left out. */
function environment(extra) {
  return Object.fromEntries(Object.entries({ ...process.env, RUST_BACKTRACE: "1", NO_COLOR: "1", ...extra }).filter(([, v]) => v !== undefined));
}

/** Starts a program, its console hidden. A program with a window of its own passes `shown`, since
 *  Windows may start that window hidden too, and a hidden window never hears it is closed. */
function run(path, args, env = {}, { shown = false } = {}) {
  const child = spawn(path, args, { cwd: ROOT, windowsHide: !shown, stdio: ["ignore", "pipe", "pipe"], env: environment(env) });
  child.log = "";
  child.stdout.on("data", (d) => (child.log += d));
  child.stderr.on("data", (d) => (child.log += d));
  return child;
}

/** The project each scenario starts from: the demo line's imports in the library's theme, with
 *  no pages, as each scenario makes its own. */
function testProject(into) {
  cpSync(join(here, "project"), into, { recursive: true });
  cpSync(join(ROOT, "server", "library", "theme.toml"), join(into, "data", "theme.toml"));
}

/** With `empty` named, the backend starts a new project in a folder of that name, as it would
 *  anywhere, in place of the demo's copy. Systems in different slots run side by side. */
export async function startSystem({ empty, slot = 0 } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "rant-hmi-test-"));
  const project = empty ? join(temp, basename(empty)) : temp;
  if (!empty) testProject(project);
  const domain = String(domainOf(slot));
  const line = run(join(BUILD, "examples", `demo${exe}`), ["--loopback", "--domain", domain]);
  const cage = run(join(BUILD, "examples", `cage${exe}`), ["--loopback", "--domain", domain]);
  const transcoding = transcoder();
  const video = transcoding && run(transcoding, ["--domain", domain, "--interface", "127.0.0.1"]);
  await new Promise((r) => setTimeout(r, 300));
  // a home of its own, where the backend keeps its certificate, never the user's
  const home = join(temp, "home");
  const backend = run(join(BUILD, `rant-hmi${exe}`), [
    project,
    "--port", String(portOf(slot)),
    "--domain", domain,
    "--loopback",
    "--client", CLIENT,
  ], { HOME: home, USERPROFILE: home });
  const url = `http://127.0.0.1:${portOf(slot)}`;
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() - start > 10000) throw new Error(`the backend never answered:\n${backend.log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    ws: `ws://127.0.0.1:${portOf(slot)}/ws`,
    project,
    home,
    backend,
    transcoder: video,
    stop() {
      backend.kill();
      video?.kill();
      line.kill();
      cage.kill();
      rmSync(temp, { recursive: true, force: true });
    },
  };
}

/** rant-hmi-app's Electron, which `npm install` in app fetches, and the backend addon it loads,
 *  as cargo builds it for tests. HMI_ADDON names another. */
const APP = join(ROOT, "app");
const ADDON = resolve(process.env.HMI_ADDON ?? built(join(ROOT, "target"), "debug"));
function electron() {
  try {
    return createRequire(join(APP, "package.json"))("electron");
  } catch {
    throw new Error("no Electron for rant-hmi-app: run npm install in app");
  }
}

/** What rant-hmi-app takes to run `project` here, with a demo line of its own on `domain`. */
function appRunning(project, domain) {
  const line = run(join(BUILD, "examples", `demo${exe}`), ["--loopback", "--domain", String(domain)]);
  return { line, args: [project, "--domain", String(domain), "--loopback", "--client", CLIENT] };
}

/** What the app's environment adds: the addon, and a home of its own, where the window keeps its
 *  data. Electron runs as plain Node where ELECTRON_RUN_AS_NODE is set, as a VS Code extension's
 *  children inherit it. */
const appEnv = (home) => ({ HMI_ADDON: ADDON, HOME: home, USERPROFILE: home, ELECTRON_RUN_AS_NODE: undefined });

/** rant-hmi-app showing `what`, a project with a demo line on `domain`, an HMI's address or null for
 *  nothing, in a window Playwright drives, started in `cwd` with `more` arguments. Its debugging
 *  ports listen, so `openApp` checks what the app does alone. */
export async function driveApp(what, { home, domain = null, more = [], cwd = ROOT }) {
  const { line, args } = domain === null ? { line: null, args: what === null ? [] : [what] } : appRunning(what, domain);
  const app = await _electron.launch({ executablePath: electron(), args: [APP, ...args, ...more], cwd, env: environment(appEnv(home)) });
  const child = app.process();
  child.log = "";
  child.stdout.on("data", (d) => (child.log += d));
  child.stderr.on("data", (d) => (child.log += d));
  return {
    app,
    process: child,
    window: await app.firstWindow(),
    /** Closes the window as a person does, true once the app ended by itself. */
    async close() {
      const ended = exited(child);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      line?.kill();
      return ended;
    },
    stop() {
      // Playwright starts Electron through cmd.exe here, so only ending that tree ends the app
      if (child.exitCode === null) execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
      line?.kill();
    },
  };
}

/** rant-hmi-app running `project` with a demo line on `domain`, started as a person starts it,
 *  once its screen has connected. Its log tells what the window did. */
export async function openApp(project, { home, domain }) {
  const { line, args } = appRunning(project, domain);
  const app = run(electron(), [APP, ...args], appEnv(home), { shown: true });
  const start = Date.now();
  while (!app.log.includes("screen 1 connected")) {
    if (Date.now() - start > 20000) {
      app.kill();
      line.kill();
      throw new Error(`the app never served its screen:\n${app.log}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    app,
    /** Closes the window as a person does, true once the app ended by itself. */
    async close() {
      const ended = exited(app);
      execFileSync("taskkill", ["/PID", String(app.pid)], { stdio: "ignore" });
      line.kill();
      return ended;
    },
    stop() {
      app.kill();
      line.kill();
    },
  };
}

/** True once `child` ends by itself with nothing wrong, false if it has not within 10 s. */
function exited(child) {
  return new Promise((r) => {
    if (child.exitCode !== null) return r(child.exitCode === 0);
    child.once("exit", (code) => r(code === 0));
    setTimeout(() => r(false), 10000);
  });
}

export function startBrowser() {
  return chromium.launch({ channel: "chrome", headless: true });
}

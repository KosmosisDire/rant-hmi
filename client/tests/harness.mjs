// Starts what a test needs: the demo line, the cage cell, the transcoder and a backend on their
// own loopback domain and port, with a fresh copy of the test project, and a headless Chrome to
// drive.

import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { cp, readdir, readFile, readlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron, chromium } from "playwright-core";
import { built, platform, program, version } from "../../app/addon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..", "..");
const exe = process.platform === "win32" ? ".exe" : "";

/** The build the scenarios run, and the client it serves. HMI_BUILD and HMI_CLIENT name others,
 *  so they can run while a backend from target/debug is open, serving client/dist. */
export const BUILD = resolve(process.env.HMI_BUILD ?? join(ROOT, "target", "debug"));
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

/** The project each scenario starts from: objects for the demo line and robot in the library's
 *  theme, with no pages, as each scenario makes its own. */
function testProject(into) {
  cpSync(join(here, "project"), into, { recursive: true });
  cpSync(join(ROOT, "server", "library", "theme.toml"), join(into, "data", "theme.toml"));
}

/** With `empty` named, the backend starts a new project in a folder of that name, as it would
 *  anywhere, in place of the demo's copy. Systems in different slots run side by side. With
 *  `video` false no transcoder runs. */
export async function startSystem({ empty, slot = 0, video: transcodes = true } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "rant-hmi-test-"));
  const project = empty ? join(temp, basename(empty)) : temp;
  if (!empty) testProject(project);
  const domain = String(domainOf(slot));
  const line = run(join(BUILD, "examples", `demo${exe}`), ["--loopback", "--domain", domain]);
  const cage = run(join(BUILD, "examples", `cage${exe}`), ["--loopback", "--domain", domain]);
  const transcoding = transcodes ? transcoder() : null;
  const video = transcoding && run(transcoding, ["--domain", domain, "--interface", "127.0.0.1"]);
  await new Promise((r) => setTimeout(r, 300));
  // a home of its own, where the backend keeps its certificate, never the user's
  const home = join(temp, "home");
  const url = `http://127.0.0.1:${portOf(slot)}`;
  const launch = async (more = []) => {
    const backend = run(join(BUILD, `rant-hmi${exe}`), [
      project,
      "--port", String(portOf(slot)),
      "--domain", domain,
      "--loopback",
      "--client", CLIENT,
      ...more,
    ], { HOME: home, USERPROFILE: home });
    const start = Date.now();
    for (;;) {
      try {
        if ((await fetch(url)).ok) return backend;
      } catch {
        // not listening yet
      }
      if (Date.now() - start > 10000) throw new Error(`the backend never answered:\n${backend.log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return {
    url,
    ws: `ws://127.0.0.1:${portOf(slot)}/ws`,
    domain: Number(domain),
    project,
    home,
    backend: await launch(),
    transcoder: video,
    /** Ends the backend and starts it again on the same project, as a restarted HMI, with the
     *  flags `more` too. */
    async restart(more = []) {
      const was = this.backend;
      const ended = new Promise((r) => was.once("exit", r));
      was.kill();
      await ended;
      this.backend = await launch(more);
    },
    stop() {
      this.backend.kill();
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
  return { line, args: [project, `--domain=${domain}`, "--loopback", `--client=${CLIENT}`] };
}

/** What the app's environment adds: `addon`, or none for a runtime that brings its own, and a home
 *  of its own, where the window keeps its data. Electron runs as plain Node where
 *  ELECTRON_RUN_AS_NODE is set, as a VS Code extension's children inherit it. */
const appEnv = (home, addon) => ({ HMI_ADDON: addon, HOME: home, USERPROFILE: home, ELECTRON_RUN_AS_NODE: undefined });

/** rant-hmi-app showing `what`, a project with a demo line on `domain`, an HMI's address or null for
 *  nothing, in a window Playwright drives, started in `cwd` with `more` arguments. It runs from
 *  source, or from `runtime`, a runtime an app unpacked. Its debugging ports listen, so `openApp`
 *  checks what the app does alone. */
export async function driveApp(what, { home, domain = null, more = [], cwd = ROOT, runtime = null }) {
  const { line, args } = domain === null ? { line: null, args: what === null ? [] : [what] } : appRunning(what, domain);
  const from = runtime ? { executablePath: join(runtime, program("electron")), args: [...args, ...more], env: environment(appEnv(home)) } : { executablePath: electron(), args: [APP, ...args, ...more], env: environment(appEnv(home, ADDON)) };
  const app = await _electron.launch({ ...from, cwd });
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
    async stop() {
      if (child.exitCode === null) await end(child.pid);
      line?.kill();
    },
  };
}

/** rant-hmi-app running `project` with a demo line on `domain`, started as a person starts it,
 *  once its screen has connected. Its log tells what the window did. */
export async function openApp(project, { home, domain }) {
  const { line, args } = appRunning(project, domain);
  const app = run(electron(), [APP, ...args], appEnv(home, ADDON), { shown: true });
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
      await close(app.pid);
      line.kill();
      return ended;
    },
    stop() {
      app.kill();
      line.kill();
    },
  };
}

/** A program run to its end without blocking, as the runner standing still stalls every worker. */
const run$ = promisify(execFile);

/** Asks the program `pid` to close its window as a person does: taskkill without /F sends that on
 *  Windows. Elsewhere SIGTERM, as a session ending sends, which the window takes as its close. */
async function close(pid) {
  if (process.platform === "win32") await run$("taskkill", ["/PID", String(pid)]);
  else process.kill(pid, "SIGTERM");
}

/** Ends the program `pid` at once. On Windows Playwright starts Electron through cmd.exe, so the
 *  whole tree goes. Elsewhere Chromium's helpers end with their window. */
async function end(pid) {
  if (process.platform === "win32") await run$("taskkill", ["/F", "/T", "/PID", String(pid)]);
  else process.kill(pid, "SIGKILL");
}

/** The Electron windows started from under `home`, leaving out Chromium's helpers, which say their `--type=`.
 *  On Linux Chromium writes its command line over its first argument, so the program is read from its link. */
async function windowsIn(home) {
  if (process.platform === "win32") {
    const find = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${home}*' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.ProcessId }`;
    return (await run$("powershell", ["-NoProfile", "-Command", find])).stdout.split(/\s+/).filter(Boolean).map(Number);
  }
  const found = [];
  for (const pid of (await readdir("/proc")).filter((d) => /^\d+$/.test(d))) {
    const program = await readlink(`/proc/${pid}/exe`).catch(() => "");
    if (basename(program) !== "electron" || !program.startsWith(home)) continue;
    if (!(await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).includes("--type=")) found.push(Number(pid));
  }
  return found;
}

/** This host's runtime for apps, which `npm run runtime` in app builds, put where the server
 *  keeping its files in `home` builds apps from. */
export async function giveRuntime(home) {
  const from = join(ROOT, "target", "app", platform);
  if (!existsSync(join(from, "runtime.id"))) throw new Error(`no ${platform} runtime for apps: run npm run runtime in app`);
  // copied without blocking, as the runner standing still stalls every worker
  await cp(from, join(home, ".rant", "hmi", "runtimes", version, platform), { recursive: true });
}

/** An app the editor downloaded, started as a person starts it, on a device whose home is `home`.
 *  Its window is Electron's, from the runtime it unpacks there, a child of the app. */
export function startDownloaded(file, home) {
  const app = run(file, [], { HOME: home, USERPROFILE: home, ELECTRON_RUN_AS_NODE: undefined }, { shown: true });
  return {
    app,
    /** Closes its window as a person does, true once the app ended by itself. */
    async close() {
      const ended = exited(app);
      const found = await windowsIn(home);
      for (const pid of found) await close(pid);
      return found.length > 0 && (await ended);
    },
    /** Ends the app and its window, which outlives the app when only the app is ended. */
    async stop() {
      for (const pid of [app.exitCode === null ? app.pid : null, ...(await windowsIn(home))]) {
        try {
          if (pid !== null) await end(pid);
        } catch {
          // ended already
        }
      }
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

/** The headless Chrome the scenarios drive, or the Chromium HMI_BROWSER names where Chrome has no
 *  build, as Linux on ARM. */
export function startBrowser() {
  const named = process.env.HMI_BROWSER;
  return chromium.launch(named ? { executablePath: named, headless: true } : { channel: "chrome", headless: true });
}

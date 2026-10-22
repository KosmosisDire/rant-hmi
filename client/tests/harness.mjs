// Starts what a test needs: the demo line, the cage cell, the transcoder and a backend on their
// own loopback domain and port, with a fresh copy of the test project, and a headless Chrome to
// drive.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

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

function run(path, args, env = {}) {
  const child = spawn(path, args, { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RUST_BACKTRACE: "1", NO_COLOR: "1", ...env } });
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

export function startBrowser() {
  return chromium.launch({ channel: "chrome", headless: true });
}

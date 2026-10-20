// Starts what a test needs: the demo line, the transcoder and a backend on their own loopback
// domain and port, with a fresh copy of the demo project, and a headless Chrome to drive.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..", "..");
const exe = process.platform === "win32" ? ".exe" : "";

/** The build the scenarios run, and the client it serves. HMI_BUILD and HMI_CLIENT name others,
 *  so they can run while a backend from target/debug is open, serving client/dist. */
const BUILD = resolve(process.env.HMI_BUILD ?? join(ROOT, "target", "debug"));
const CLIENT = resolve(process.env.HMI_CLIENT ?? join(ROOT, "client", "dist"));

/** rant-transcoder, which makes the H264 a video plays, from the RANT folder this sits in.
 *  HMI_TRANSCODER names another. Without one the video scenarios fail and say so. */
function transcoder() {
  if (process.env.HMI_TRANSCODER) return resolve(process.env.HMI_TRANSCODER);
  for (let d = ROOT; d !== dirname(d); d = dirname(d)) {
    const path = join(d, "transcoder-rant", "bin", `rant-transcoder${exe}`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Kept apart from the cargo tests' domain and from a running backend's port. */
export const DOMAIN = 153;
export const PORT = 6761;

function run(path, args) {
  const child = spawn(path, args, { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RUST_BACKTRACE: "1", NO_COLOR: "1" } });
  child.log = "";
  child.stdout.on("data", (d) => (child.log += d));
  child.stderr.on("data", (d) => (child.log += d));
  return child;
}

/** The demo project as committed, never the working copy someone may be trying things in.
 *  Its pages stay out, as each scenario makes its own. */
function demoProject(into) {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT });
  const files = git("ls-tree", "-r", "--name-only", "HEAD", "examples/demo").toString().split("\n");
  for (const file of files.filter((f) => f && !f.includes("/pages/"))) {
    const to = join(into, relative("examples/demo", file));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, git("show", `HEAD:${file}`));
  }
}

export async function startSystem() {
  const project = mkdtempSync(join(tmpdir(), "rant-hmi-test-"));
  demoProject(project);
  const line = run(join(BUILD, "examples", `demo${exe}`), ["--loopback", "--domain", String(DOMAIN)]);
  const transcoding = transcoder();
  const video = transcoding && run(transcoding, ["--domain", String(DOMAIN), "--interface", "127.0.0.1"]);
  await new Promise((r) => setTimeout(r, 300));
  const backend = run(join(BUILD, `rant-hmi${exe}`), [
    project,
    "--port", String(PORT),
    "--domain", String(DOMAIN),
    "--loopback",
    "--client", CLIENT,
  ]);
  const url = `http://127.0.0.1:${PORT}`;
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
    ws: `ws://127.0.0.1:${PORT}/ws`,
    project,
    backend,
    transcoder: video,
    stop() {
      backend.kill();
      video?.kill();
      line.kill();
      rmSync(project, { recursive: true, force: true });
    },
  };
}

export function startBrowser() {
  return chromium.launch({ channel: "chrome", headless: true });
}

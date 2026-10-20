// Starts what a test needs: the demo line and a backend on their own loopback domain and
// port, with a fresh copy of the demo project, and a headless Chrome to drive.

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..", "..");
const exe = process.platform === "win32" ? ".exe" : "";

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

export async function startSystem() {
  const project = mkdtempSync(join(tmpdir(), "rant-hmi-test-"));
  cpSync(join(ROOT, "examples", "demo"), project, { recursive: true, filter: (p) => !p.includes("pages") });
  const line = run(join(ROOT, "target", "debug", "examples", `demo${exe}`), ["--loopback", "--domain", String(DOMAIN)]);
  await new Promise((r) => setTimeout(r, 300));
  const backend = run(join(ROOT, "target", "debug", `rant-hmi${exe}`), [
    project,
    "--port", String(PORT),
    "--domain", String(DOMAIN),
    "--loopback",
    "--client", join(ROOT, "client", "dist"),
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
    stop() {
      backend.kill();
      line.kill();
      rmSync(project, { recursive: true, force: true });
    },
  };
}

export function startBrowser() {
  return chromium.launch({ channel: "chrome", headless: true });
}

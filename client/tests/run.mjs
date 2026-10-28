// Runs the scenarios in tests/scenarios, or those whose file name holds one of the arguments, each
// on a fresh page. `--workers n` runs them n at a time, 4 by default, each worker against its own
// backend, demo line and cage cell. A console error fails one, as does a fault the HMI finds in
// its own code.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { designer } from "./designer.mjs";
import { ROOT, startBrowser, startSystem } from "./harness.mjs";
import { Hmi } from "./hmi.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });

export function check(ok, what) {
  if (!ok) throw new Error(what);
}

/** Waits until `fn` returns something truthy, for what arrives over time. */
export async function eventually(fn, what, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${typeof what === "function" ? await what() : what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const only = args.filter((a, n) => !a.startsWith("--") && !["--into", "--workers"].includes(args[n - 1]));
const files = readdirSync(join(here, "scenarios")).filter((f) => f.endsWith(".mjs") && (only.length === 0 || only.some((o) => f.includes(o))));
// with --into a folder, the scenarios start on a new project and it becomes that folder
const into = value("--into") ? resolve(ROOT, value("--into")) : null;
// what keeps one system's project runs on one worker
const one = !!into || args.includes("--library");
const workers = one ? 1 : Math.max(1, Math.min(files.length, Number(value("--workers") ?? 4)));

// the longest first by the last run's times, so no worker is left with a long one at the end
const timesFile = join(out, "times.json");
const lastTimes = existsSync(timesFile) ? JSON.parse(readFileSync(timesFile, "utf8")) : {};
const queue = [...files].sort((a, b) => (lastTimes[b] ?? Infinity) - (lastTimes[a] ?? Infinity) || a.localeCompare(b));
const times = { ...lastTimes };
let failed = 0;
const running = new Set();
// this process standing still, as when the machine pauses it, fails scenarios not at fault, as a
// backend drops a test client silent 5 s, so a stall is told with what ran through it
let beat = Date.now();
setInterval(() => {
  const still = Date.now() - beat - 250;
  if (still > 1000) console.log(`STALL the runner stood still ${still} ms during ${[...running].join(", ")}`);
  beat = Date.now();
}, 250).unref();
let slots = 0;
let kept = null;

/** Runs scenarios from the queue until it is empty, on a system and browser of its own. A
 *  scenario that exports `fresh` gets a system of its own too, started on a new project as a
 *  new HMI starts, with the standard components, and one that exports `video` as false gets one
 *  with no transcoder, so no camera has video of its own. */
async function worker() {
  const browser = await startBrowser();
  let shared = null;
  while (queue.length > 0) {
    const file = queue.shift();
    const name = file.replace(/\.mjs$/, "");
    const { default: run, fresh, video } = await import(pathToFileURL(join(here, "scenarios", file)).href);
    const own = (fresh && !into) || video === false;
    const sys = own ? await startSystem({ empty: name, slot: slots++, video }) : (shared ??= await startSystem({ empty: into, slot: slots++ }));
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    const hmi = await Hmi.connect(sys.ws);
    const started = Date.now();
    running.add(name);
    try {
      await page.goto(sys.url);
      await page.locator(".statusbar", { hasText: "System" }).waitFor();
      await run({ page, hmi, d: designer(page), sys, check, eventually });
      if (errors.length) throw new Error(`the console logged errors:\n  ${errors.join("\n  ")}`);
      // what the console never hears, as a fault an error boundary caught, the HMI still lists
      const own = (await (await fetch(`${sys.url}/problems`)).json()).filter((p) => p.source === "hmi" && p.level === "fault" && p.at >= started);
      if (own.length) throw new Error(`the HMI found faults in its own code:\n  ${own.map((p) => p.text).join("\n  ")}`);
      times[file] = Date.now() - started;
      console.log(`ok    ${name} (${times[file]} ms)`);
    } catch (e) {
      failed++;
      // the scenario's line, else the helper's, since an awaited helper can lose its caller
      const at = /scenarios[\/]([\w-]+\.mjs:\d+)/.exec(e.stack ?? "")?.[1] ?? /tests[\/](designer\.mjs:\d+)/.exec(e.stack ?? "")?.[1];
      // the backend's and transcoder's last words often say why, printed whole so workers never mix them
      const tail = (who, log = "") => log.trim().split(/\r?\n/).filter(Boolean).slice(-12).map((line) => `        ${who}: ${line}`);
      console.log([`FAIL  ${name}: ${e.message}${at ? ` (${at})` : ""}`, ...tail("backend", sys.backend.log), ...tail("transcoder", sys.transcoder?.log)].join("\n"));
      // the whole log too, kept now in case the run dies before its end
      writeFileSync(join(out, `${name}.backend.log`), sys.backend.log);
    }
    running.delete(name);
    // a page that hangs fails its scenario, never the run
    await page.screenshot({ path: join(out, `${name}.png`) }).catch((e) => {
      failed++;
      console.log(`FAIL  ${name}: the page took no screenshot, ${e.message.split("\n")[0]}`);
    });
    hmi.close();
    // with any a scenario opened, as a phone's, so a failed one leaves no screen behind
    for (const c of browser.contexts()) await c.close();
    if (own) sys.stop();
  }
  await browser.close();
  if (one) kept = shared;
  else shared?.stop();
}

await Promise.all(Array.from({ length: workers }, worker));
writeFileSync(timesFile, JSON.stringify(times, null, 2));
// with --library, the components the scenarios made by hand become those a new project starts with
if (args.includes("--library") && !failed && kept) {
  rmSync(join(ROOT, "server", "library", "components"), { recursive: true, force: true });
  cpSync(join(kept.project, "components"), join(ROOT, "server", "library", "components"), { recursive: true });
  console.log(`kept ${readdirSync(join(ROOT, "server", "library", "components")).length} components in server/library/components`);
}
if (into && !failed && kept) {
  rmSync(into, { recursive: true, force: true });
  cpSync(kept.project, into, { recursive: true });
  console.log(`kept the project in ${relative(ROOT, into)}`);
}
kept?.stop();
console.log(failed ? `${failed} of ${files.length} failed` : `all ${files.length} passed`);
process.exit(failed ? 1 : 0);

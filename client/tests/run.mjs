// Runs the scenarios in tests/scenarios against one backend and the demo line, each on a fresh
// page, as `docs/testing.md` says. A console error fails a scenario.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

const only = process.argv[2] ?? "";
const files = readdirSync(join(here, "scenarios")).filter((f) => f.endsWith(".mjs") && f.includes(only)).sort();
const sys = await startSystem();
const browser = await startBrowser();
let failed = 0;
for (const file of files) {
  const name = file.replace(/\.mjs$/, "");
  const { default: run } = await import(pathToFileURL(join(here, "scenarios", file)).href);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const hmi = await Hmi.connect(sys.ws);
  const started = Date.now();
  try {
    await page.goto(sys.url);
    await page.locator(".statusbar", { hasText: "System" }).waitFor();
    await run({ page, hmi, d: designer(page), sys, check, eventually });
    if (errors.length) throw new Error(`the console logged errors:\n  ${errors.join("\n  ")}`);
    console.log(`ok    ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    failed++;
    // the scenario's line, else the helper's, since an awaited helper can lose its caller
    const at = /scenarios[\\/]([\w-]+\.mjs:\d+)/.exec(e.stack ?? "")?.[1] ?? /tests[\\/](designer\.mjs:\d+)/.exec(e.stack ?? "")?.[1];
    console.log(`FAIL  ${name}: ${e.message}${at ? ` (${at})` : ""}`);
    // the backend's last words often say why
    const tail = sys.backend.log.trim().split(/\r?\n/).slice(-12);
    for (const line of tail) console.log(`        backend: ${line}`);
  }
  await page.screenshot({ path: join(out, `${name}.png`) });
  hmi.close();
  await context.close();
}
await browser.close();
// with --library, the components the scenarios made by hand become those a new project starts with
if (process.argv.includes("--library") && !failed) {
  const [made, kept] = [join(sys.project, "components"), join(ROOT, "server", "library", "components")];
  rmSync(kept, { recursive: true, force: true });
  mkdirSync(kept, { recursive: true });
  // each file named for its component, which is all an instance refers to it by
  for (const file of readdirSync(made)) {
    const text = readFileSync(join(made, file), "utf8");
    writeFileSync(join(kept, `${/^<component name="(\w+)"/.exec(text)[1].toLowerCase()}.html`), text);
  }
  console.log(`kept ${readdirSync(kept).length} components in server/library/components`);
}
writeFileSync(join(out, "backend.log"), sys.backend.log);
sys.stop();
console.log(failed ? `${failed} of ${files.length} failed` : `all ${files.length} passed`);
process.exit(failed ? 1 : 0);

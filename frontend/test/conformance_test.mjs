/* THE CONFORMANCE RUNNER: the language's fixture cases, executed by the SECOND
 * interpreter. fixture_test runs every case through the C++ VM; this runner asks the
 * same binary for its --dump — the view-legal cases compiled by the view emitter,
 * with their env cells and wanted values rendered in the view's own spellings — and
 * executes each program through the REAL built interpreter (dist/program.js) over a
 * plain-map host. One fixture suite, two executors, forever: an arithmetic
 * difference between vm.cpp and program.ts fails here by value, not by eyeball.
 *
 * Values compare the way fixture_test compares them: numbers to a relative 1e-9,
 * everything else exactly. The dump is regenerated on every run (it is a build
 * product, never checked in), and a hollow dump — few cases surviving the view
 * compile — fails loudly rather than passing on nothing.
 *
 * usage: node conformance_test.mjs <hmi_fixture_test exe> <fixtures dir> */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const exe = process.argv[2];
const fixtures = process.argv[3];
if (!exe || !fixtures) {
  console.error("usage: conformance_test.mjs <hmi_fixture_test> <fixtures-dir>");
  process.exit(1);
}

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { run } = await import(pathToFileURL(join(dist, "program.js")).href);

const dump = join(tmpdir(), `hmi_conformance_${process.pid}.json`);
const dumped = spawnSync(exe, [fixtures, "--dump", dump], { encoding: "utf8" });
if (dumped.status !== 0) {
  console.error((dumped.stdout ?? "") + (dumped.stderr ?? ""));
  console.error("conformance: the fixture dump failed");
  process.exit(1);
}
const cases = JSON.parse(readFileSync(dump, "utf8"));
rmSync(dump, { force: true });

const close = (got, want) =>
  typeof got === "number" && Number.isFinite(got) &&
  Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));

let failed = 0;
for (const item of cases) {
  const got = run(item.program, (cell) => item.cells[cell] ?? null);
  const ok = item.want_type === "nil" ? got === null
           : item.want_type === "Num" ? close(got, item.want)
           : got === item.want;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${item.file}:${item.line}  ${item.name}  came to ` +
                  `${JSON.stringify(got)}, expected ${JSON.stringify(item.want)}`);
  }
}
/* the floor: the shared vocabulary is most of the fixture suite, so a dump this
   hollow means the view compile broke, not that the language shrank */
if (cases.length < 40) {
  failed += 1;
  console.error(`conformance: only ${cases.length} cases survived the view ` +
                "compile; the dump went hollow");
}
console.log(`conformance: ${cases.length} fixture cases through the view ` +
            `interpreter, ${failed} failed`);
process.exit(failed ? 1 : 0);

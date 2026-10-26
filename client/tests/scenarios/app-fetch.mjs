// A server with no runtime for a platform gets it from the HMI's release the first time an app for
// it is asked for. The sheet shows the runtime coming, then downloads the app, and the next app for
// it fetches nothing. A release with no file for a platform says which file to put where.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack, version } from "../../../app/addon.mjs";
import { BUILD } from "../harness.mjs";

export const fresh = true;

/** The file a release attaches for `target` as runtime.mjs packs it, with 3 MB that do not compress. */
function attached(temp, target) {
  const runtime = join(temp, "runtime");
  const stage = join(temp, "stage");
  mkdirSync(runtime);
  mkdirSync(stage);
  writeFileSync(join(runtime, "electron"), randomBytes(3_000_000));
  writeFileSync(join(stage, "launcher"), "LAUNCHER");
  writeFileSync(join(stage, "runtime.id"), pack(BUILD, runtime, join(stage, "runtime.tar.gz")));
  const file = join(temp, `rant-hmi-runtime-${version}-${target}.tar.gz`);
  pack(BUILD, stage, file);
  return readFileSync(file);
}

export default async function ({ page, sys, check, eventually }) {
  const temp = mkdtempSync(join(tmpdir(), "rant-hmi-fetch-"));
  const name = `rant-hmi-runtime-${version}-linux-arm64.tar.gz`;
  const file = attached(temp, "linux-arm64");
  // a release with that file alone, sent a piece every 20 ms so the sheet sees it come
  let asked = 0;
  const release = createServer(async (req, res) => {
    if (req.url !== `/${name}`) return res.writeHead(404).end();
    asked++;
    res.writeHead(200, { "content-length": file.length });
    for (let at = 0; at < file.length; at += 65536) {
      res.write(file.subarray(at, at + 65536));
      await new Promise((r) => setTimeout(r, 20));
    }
    res.end();
  });
  await new Promise((r) => release.listen(0, "127.0.0.1", r));
  try {
    await sys.restart(["--runtimes-from", `http://127.0.0.1:${release.address().port}`]);
    await page.reload();
    await page.getByTitle("Get this HMI as an app for a device").click();
    const sheet = page.locator(".popover.get-app");
    const option = (words) => sheet.locator(".choice button", { hasText: new RegExp(`^${words}$`) });
    await option("Linux on ARM").click();
    await sheet.getByText("This server gets the Linux on ARM runtime from the HMI's release first, once.").waitFor();
    check(await option("macOS").isDisabled(), "the sheet offered macOS, which the release attaches no runtime for");

    const downloaded = page.waitForEvent("download", { timeout: 20000 });
    await sheet.getByText("Download", { exact: true }).click();
    await sheet.getByText(/^Getting the Linux on ARM runtime: \d of 3 MB\.$/).waitFor();
    check(await sheet.getByText("Download", { exact: true }).isDisabled(), "the download can be asked for again while the runtime comes");
    const width = await sheet.locator(".getting > div").evaluate((bar) => parseFloat(bar.style.width));
    check(width >= 0 && width <= 100, `the bar is ${width}% long`);
    const got = await downloaded;
    const app = join(temp, "app");
    await got.saveAs(app);
    check(readFileSync(app).subarray(0, 8).toString() === "LAUNCHER", "the app downloaded is not built from the fetched runtime");
    check(asked === 1, `the release was asked ${asked} times`);
    const runtimes = join(sys.home, ".rant", "hmi", "runtimes", version);
    check(existsSync(join(runtimes, "linux-arm64", "runtime.id")), "the runtime was not unpacked where apps are built from");
    check(readdirSync(runtimes).join() === "linux-arm64", `more is left with the runtime: ${readdirSync(runtimes).join(", ")}`);
    await sheet.getByText("Mark it as a program first", { exact: false }).waitFor();

    const [again] = await Promise.all([page.waitForEvent("download"), sheet.getByText("Download", { exact: true }).click()]);
    await again.saveAs(join(temp, "again"));
    check(asked === 1, "the second app fetched its runtime again");

    await option("Windows").click();
    await sheet.getByText("Download", { exact: true }).click();
    const error = sheet.locator(".error-line");
    await error.waitFor();
    const said = await error.textContent();
    check(said.includes(`rant-hmi-runtime-${version}-win-x64.tar.gz from the HMI's release in ${runtimes} by hand`), `the sheet said ${said}`);
    check(said.includes("404"), `the sheet did not say why: ${said}`);
  } finally {
    release.close();
    await rm(temp, { recursive: true, force: true });
  }
}

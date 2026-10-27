// A topic imported to read takes a rate from the Data tab's inspector: it brings that many values
// a second at most, saved with the import. Imported to write, it comes at its full rate again,
// and the backend refuses a rate for an import to write.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export default async function ({ page, hmi, sys, d, check, eventually }) {
  await hmi.import("Conveyor", "Line1/Conveyor");
  const conveyor = () => hmi.state.imports.find((i) => i.alias === "Conveyor");
  await eventually(() => hmi.state.values.Conveyor?.known, "the conveyor's value");
  // the demo sends 20 a second
  const full = await hmi.count("Conveyor", 1000);
  check(full >= 14, `the conveyor came ${full} times a second at its full rate`);

  await d.tab("Data");
  await (await d.meshRow("Line1/Conveyor")).click();
  const side = page.locator(".screen:not([hidden]) .sidebar.right");
  await eventually(async () => (await side.locator(".head-title").textContent()).includes("Conveyor"), "the inspector to show the import");
  const rate = side.locator(".field", { has: page.locator("label", { hasText: /^Rate$/ }) }).locator("input");
  await rate.fill("4");
  await rate.press("Enter");
  await eventually(() => conveyor()?.rate === 4, "the rate");
  await side.locator(".field-hint", { hasText: "At most 4 a second" }).waitFor();
  // the new subscription settles before it is timed
  await page.waitForTimeout(500);
  const slow = await hmi.count("Conveyor", 2000);
  check(slow >= 6 && slow <= 10, `at 4 a second the conveyor came ${slow} times in 2 s`);
  const file = readFileSync(join(sys.project, "data", "imports.toml"), "utf8");
  check(file.includes("rate = 4"), `imports.toml holds ${file}`);

  await rate.fill("");
  await rate.press("Enter");
  await eventually(() => conveyor()?.rate == null, "the rate to clear");
  const again = await hmi.count("Conveyor", 1000);
  check(again >= 14, `with no rate the conveyor came ${again} times a second`);

  // imported to write, it drops its rate
  await rate.fill("4");
  await rate.press("Enter");
  await eventually(() => conveyor()?.rate === 4, "the rate set again");
  await side.locator(".choice button", { hasText: /^Read and / }).click();
  await eventually(() => conveyor()?.intent === "write" && conveyor()?.rate == null, () => `the import to write to drop its rate, not ${JSON.stringify(conveyor())}`);
  await eventually(async () => !(await rate.isVisible()), "the rate to go");
  hmi.send({ type: "change_import", alias: "Conveyor", import: { ...conveyor(), rate: 4 } });
  const refused = await hmi.next(() => false).then(() => "nothing", (e) => e.message);
  check(refused === "Conveyor takes no rate, as only a topic imported to read does", `the backend answered ${refused}`);
}

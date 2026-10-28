// An editor or an AI changes the project's files while the designer is open: the page and the
// theme follow, a file with a mistake keeps the last good page and says why, and nothing is lost.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default async function ({ page, hmi, d, sys, check, eventually }) {
  const pageId = await hmi.addPage("Outside");
  const id = await hmi.addElement(pageId, "span", { name: "Note", x: "44", y: "44", w: "264", h: "44", text: '"Before"', color: "#e4e6e8" });
  await d.openPage("Outside");
  await eventually(async () => (await d.el(id).textContent()) === "Before", "the page as made");

  const file = join(sys.project, "pages", `${pageId}.html`);
  const good = readFileSync(file, "utf8");
  writeFileSync(file, good.replace('"Before"', '"After"'));
  await eventually(async () => (await d.el(id).textContent()) === "After", "the page to follow its file");

  writeFileSync(file, good.replace("</page>", ""));
  await page.locator(".notice", { hasText: "The HMI keeps what it had" }).waitFor({ timeout: 4000 });
  check((await d.el(id).textContent()) === "After", "a broken file changed the page");

  writeFileSync(file, good.replace('"Before"', '"Fixed"'));
  await eventually(async () => (await d.el(id).textContent()) === "Fixed", "the mended file to show");
  await hmi.setProps(pageId, id, { x: "88" });
  await eventually(() => readFileSync(file, "utf8").includes('x="88"'), "the designer's edit to save");
  check(readFileSync(file, "utf8").includes('"Fixed"'), "the designer's save lost the outside edit");

  // added to the theme, which the scenarios after this one still read
  const theme = join(sys.project, "data", "theme.toml");
  writeFileSync(theme, `${readFileSync(theme, "utf8")}\n[[token]]\nname = "outside"\ndark = "#123456"\nlight = "#abcdef"\n`);
  await d.openObject("");
  await page.locator(".object-sheet tr", { hasText: "$outside" }).waitFor({ timeout: 4000 });
}

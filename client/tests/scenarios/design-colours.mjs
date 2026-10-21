// A user reads code in colour: an import in its kind's colour, the HMI's own names blue, text
// green and comments faint, the colours follow a long line as it scrolls, and a template's code
// reads as code.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.send({ type: "set_variable", name: "presses", variable: { name: "presses", start: 0, per: "hmi" } });
  hmi.send({ type: "set_computed", name: "step", computed: { name: "step", get: "1" } });
  const pageId = await hmi.addPage("Colours");
  const id = await hmi.addElement(pageId, "span", { name: "Speed", x: "44", y: "44", w: "264", h: "44", text: 'Running ? Speed.toFixed(1) + " m/s, going steady on the line" : "Stopped"' });
  await hmi.setHandler(pageId, id, "tap", "// count\npresses = presses + step;");
  await d.openPage("Colours");
  await d.el(id).click();

  const runs = (sel) => page.locator(`.screen:not([hidden]) .sidebar.right ${sel} .hl span`).evaluateAll((s) => s.map((e) => `${e.className}:${e.textContent}`));
  const text = await runs(".field:has(label:text-is('Text'))");
  check(text.includes("hl-variable:Running") && text.includes("hl-variable:Speed"), `the imports are not in their colour: ${text}`);
  check(text.includes('hl-str:" m/s, going steady on the line"'), "the text is not green");
  check(!text.some((r) => r.endsWith(":toFixed")), "a field after a dot took a name's colour");
  const code = await runs(".event");
  check(code.includes("hl-com:// count") && code.includes("hl-local:presses") && code.includes("hl-local:step"), `the handler is not in colour: ${code}`);

  const field = d.field("Text");
  await field.click();
  await page.keyboard.press("End");
  const scrolls = () => field.evaluate((f) => [f.scrollLeft, f.parentElement.querySelector(".hl").scrollLeft]);
  await eventually(async () => {
    const [own, colours] = await scrolls();
    return own > 0 && own === colours;
  }, "the colours to follow the line's scroll");
  await page.keyboard.press("Escape");

  // a template's code is coloured as code, a backtick inside its ${ } included
  await d.setField("Text", '`${Running ? `on ${Speed}` : "off"} m/s`');
  let t = [];
  const coloured = async () => {
    t = await runs(".field:has(label:text-is('Text'))");
    return t.includes("hl-variable:Running") && t.includes("hl-variable:Speed") && t.at(-1) === 'hl-str:"off"} m/s`';
  };
  await eventually(coloured, "the template's code in colour").catch(() => check(false, `the template's code is not in colour: ${t.join(" | ")}`));
}

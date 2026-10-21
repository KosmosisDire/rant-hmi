// An expression reads the clock as time.now, ms since 1970: completion offers now after the
// dot, a text showing it counts on, a light blinks with it, and once nothing shows it the
// screen asks for no more frames.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Clock");
  const shown = await hmi.addElement(pageId, "span", { name: "Shown", x: "4", y: "4", w: "40", h: "4", text: '"start"', color: "#e4e6e8" });
  const light = await hmi.addElement(pageId, "div", { name: "Light", x: "4", y: "10", w: "6", h: "6", background: "#d64a4a", opacity: "Math.floor(time.now / 150) % 2" });

  await d.openPage("Clock");
  await d.el(shown).click();
  const text = d.field("Text");
  await text.click();
  await text.fill("");
  await page.keyboard.type("String(time.");
  await eventually(async () => (await page.locator(".suggest .suggest-name").allTextContents()).join() === "now", "now offered after time.");
  await page.keyboard.type("now)");
  await page.keyboard.press("Enter");
  const props = (id) => hmi.page(pageId).children.find((e) => e.id === id).props;
  await eventually(() => props(shown).text === "String(time.now)", () => `the text to read the clock, it is ${props(shown).text}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await d.tab("Run");
  const el = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const read = async () => Number(await el(shown).textContent());
  const first = await read();
  const now = await page.evaluate(() => Date.now());
  check(Math.abs(first - now) < 5000, `the time shown, ${first}, to be the screen's, ${now}`);
  await eventually(async () => (await read()) > first + 50, "the time shown to count on");
  const seen = new Set();
  await eventually(async () => {
    seen.add(await el(light).evaluate((e) => getComputedStyle(e).opacity));
    return seen.has("0") && seen.has("1");
  }, () => `the light to blink, seen ${[...seen]}`);

  // frames asked for in half a second
  const frames = () =>
    page.evaluate(
      () =>
        new Promise((done) => {
          const real = window.requestAnimationFrame;
          let asked = 0;
          window.requestAnimationFrame = (f) => (asked++, real.call(window, f));
          setTimeout(() => {
            window.requestAnimationFrame = real;
            done(asked);
          }, 500);
        }),
    );
  const showing = await frames();
  check(showing > 10, `${showing} frames asked for while the clock shows`);
  await hmi.setProps(pageId, shown, { text: '"still"' });
  await hmi.setProps(pageId, light, { opacity: "1" });
  await eventually(async () => (await el(shown).textContent()) === "still", "the text fixed");
  const still = await frames();
  check(still === 0, `${still} frames asked for with nothing showing the clock`);
}

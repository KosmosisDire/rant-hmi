// Two handlers write fields of one mesh variable close together: one sets a flag, waits and
// clears it, and the other flips another field while it waits. The later write builds on the
// earlier one, though the mesh has not echoed that back yet, so neither undoes the other.

export default async function ({ page, hmi, d, check, eventually }) {
  await hmi.import("Cage.SafetyCmd", "Cage/Plc/gSafetyCmd", "write");
  const cmd = () => hmi.state.values["Cage.SafetyCmd"]?.value;
  await eventually(() => cmd() !== undefined && cmd() !== null, "the safety command on the mesh");
  hmi.set("Cage.SafetyCmd", { ...cmd(), stop: false, reset: false, slow_mode: false, chirp: false });
  await eventually(() => cmd()?.slow_mode === false && cmd()?.stop === false, "the safety command at rest");

  const pageId = await hmi.addPage("Write race");
  const pulse = await hmi.addElement(pageId, "div", { name: "Pulse", x: "4", y: "4", w: "20", h: "20", background: "#4a8fd6" });
  const flip = await hmi.addElement(pageId, "div", { name: "Flip", x: "40", y: "4", w: "20", h: "20", background: "#d64a4a" });
  await hmi.setHandler(pageId, pulse, "tap", "Cage.SafetyCmd.reset = true;\nawait sleep(100);\nCage.SafetyCmd.reset = false;");
  await hmi.setHandler(pageId, flip, "tap", "Cage.SafetyCmd.slow_mode = !Cage.SafetyCmd.slow_mode;");
  await d.openPage("Write race");
  await d.tab("Run");
  const middle = async (id) => {
    const b = await page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`).boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  const [p, f] = [await middle(pulse), await middle(flip)];

  // the flip lands late in the pulse's wait, at another point of the app's tick each round
  for (const [round, gap] of [70, 80, 90, 95, 75, 85, 90, 95].entries()) {
    const slow = !cmd().slow_mode;
    await page.mouse.click(...p);
    await page.waitForTimeout(gap);
    await page.mouse.click(...f);
    await eventually(() => cmd()?.reset === false && cmd()?.slow_mode === slow, () => `round ${round + 1}: slow mode to become ${slow} and stay, it is ${cmd()?.slow_mode} with reset ${cmd()?.reset}`, 1000);
    await page.waitForTimeout(150);
    check(cmd()?.slow_mode === slow, `round ${round + 1}: the pulse's last write undid the flip`);
  }
  hmi.set("Cage.SafetyCmd", { ...cmd(), reset: false, slow_mode: false });
  await eventually(() => cmd()?.slow_mode === false, "the safety command back at rest");
}

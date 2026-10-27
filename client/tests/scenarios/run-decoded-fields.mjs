// The backend decodes of each import only what screens and its own code read. A rule and a
// computed value get the fields they read though no screen shows them, and a page shown later
// gets a field nothing read before at once, decoded again from the last value, as the settings
// never change on their own.

// a system of its own, so no other scenario's page reads the settings
export const fresh = true;

export default async function ({ hmi, d, eventually }) {
  // this client reads only what it checks, so it has the backend decode nothing more
  hmi.send({ type: "watch", reads: [["moving"]] });
  await hmi.import("Settings", "Line1/Settings");
  await hmi.import("Conveyor", "Line1/Conveyor");
  hmi.send({ type: "set_variable", name: "partSeen", variable: { name: "partSeen", start: "", per: "hmi" } });
  hmi.send({ type: "set_computed", name: "moving", computed: { name: "moving", get: "Conveyor.running" } });
  await hmi.setRule("", { id: "", name: "Part seen", when: { kind: "every", ms: 100 }, code: "partSeen = Conveyor.part;" });
  const value = (name) => hmi.state.values[name]?.value;
  await eventually(() => /^\S+$/.test(value("partSeen") ?? ""), () => `the rule to read the part, not ${JSON.stringify(value("partSeen"))}`);
  await eventually(() => typeof value("moving") === "boolean", () => `the computed value to read running, not ${JSON.stringify(value("moving"))}`);

  const mode = await hmi.addPage("Mode");
  const modeText = await hmi.addElement(mode, "span", { name: "mode", x: "2", y: "2", w: "20", h: "4", text: "Settings.mode" });
  const target = await hmi.addPage("Target");
  const targetText = await hmi.addElement(target, "span", { name: "target", x: "2", y: "2", w: "20", h: "4", text: "String(Settings.target)" });
  const text = async (id) => ((await d.el(id).textContent()) ?? "").trim();
  await d.openPage("Mode");
  await eventually(async () => (await text(modeText)) === "Auto", async () => `the mode shown, not "${await text(modeText)}"`);
  // the settings stay as they are, so their target comes only from the last value decoded again
  await d.openPage("Target");
  await eventually(async () => (await text(targetText)) === "120", async () => `the target shown at once, not "${await text(targetText)}"`, 3000);
}

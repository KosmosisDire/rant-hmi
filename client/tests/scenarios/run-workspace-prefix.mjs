// An HMI that a workspace starts under a prefix reads and writes each member's entity where the
// mesh shows it, never under its own prefix, and keeps Hmi/Status where the Hmi object finds it.

export const prefix = "Cell9";

export default async function ({ hmi, check, eventually }) {
  await eventually(() => hmi.state.entities.some((e) => e.name === "Hmi/Status"), "Hmi/Status on the mesh");
  const under = hmi.state.entities.filter((e) => e.name.startsWith(`${prefix}/`)).map((e) => e.name);
  check(under.length === 0, `under the prefix: ${under}`);

  await hmi.import("Line.Speed", "Line1/Speed", "write");
  await hmi.import("Line.Conveyor", "Line1/Conveyor");
  await hmi.import("Hmi.Info", "Hmi/Status");
  await eventually(() => hmi.state.values["Line.Speed"]?.value === 0.5, () => `the speed reads ${JSON.stringify(hmi.state.values["Line.Speed"])}`);
  await eventually(() => typeof hmi.state.values["Line.Conveyor"]?.value?.speed === "number", "the conveyor read");
  await eventually(() => typeof hmi.state.values["Hmi.Info"]?.value?.version === "string", "the status read");

  hmi.set("Line.Speed", 1.25);
  await eventually(() => hmi.state.values["Line.Speed"]?.value === 1.25, () => `the speed reads ${JSON.stringify(hmi.state.values["Line.Speed"])} after the set`);
}

// A designer builds a Table in the editor alone: a heading per column and a row per item of a
// list of structs or of lists, each cell repeating over the row's columns, the rows striped and
// scrolling inside whatever box it gets. Its columns are every key of the first row unless it
// names them, and its look is inputs that start at the theme's tokens.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addComponent("Table", 40, 16);
  await d.sizing("Fill");
  await d.addInput("rows", '[{ part: "P1", weight: 1.25 }, { part: "P2", weight: 0.8 }]', { type: "struct[]" });
  await d.addInput("columns", "[]");
  await d.addInput("digits", "2");
  await d.addInput("fill", "$panel");
  await d.addInput("stripe", "$panel2");
  await d.addInput("headColour", "$dim");
  await d.addInput("textColour", "$text");
  await d.addInput("textSize", "1.4");
  await d.addInput("radius", "$radius");
  await d.add("frame", { Name: "card", x: "0", y: "0", w: "100%", h: "100%", Fill: "fill", Radius: "radius", Overflow: '"hidden"' });
  await d.layOut("Top to bottom", undefined, "0");
  await d.setField("Padding", "1");
  await d.add("frame", { Name: "head", w: "fill", h: "hug", Fill: "", Radius: "" });
  await d.layOut("Left to right", undefined, "1");
  await d.setField("Padding", "0.6");
  await d.add("text", { Name: "heading", Repeat: "columns.length ? columns : Object.keys(rows[0] ?? {})", w: "fill", h: "hug", Text: "item", Colour: "headColour", Size: "textSize", Weight: "600" });
  await d.select("card");
  await d.add("frame", { Name: "body", w: "fill", h: "fill", Fill: "", Radius: "", Overflow: '"auto"' });
  await d.layOut("Top to bottom", undefined, "0");
  await d.add("frame", { Name: "row", Repeat: "rows", w: "fill", h: "hug", Fill: 'index % 2 ? stripe : "transparent"', Radius: "$radiusSmall" });
  await d.layOut("Left to right", undefined, "1");
  await d.setField("Padding", "0.6");
  // the cells read the row as item, before each cell's own item takes its name
  await d.add("text", {
    Name: "cell",
    Repeat: "(columns.length ? columns : Object.keys(item)).map((c) => item[c])",
    w: "fill",
    h: "hug",
    Text: 'typeof item === "number" ? (Number.isInteger(item) ? String(item) : item.toFixed(digits)) : typeof item === "object" ? JSON.stringify(item) : String(item)',
    Colour: "textColour",
    Size: "textSize",
  });

  await d.addPage("Tables");
  const rows = '[{ part: "P1", weight: 1.25, ok: true }, { part: "P2", weight: 0.8, ok: false }]';
  const parts = await d.place("Table", { x: "4", y: "4", w: "40", h: "12", rows });
  const chosen = await d.place("Table", { x: "48", y: "4", w: "30", h: "12", rows, columns: '["weight", "part"]' });
  const matrix = await d.place("Table", { x: "4", y: "20", w: "30", h: "12", rows: "[[1, 2.5], [3, Line.Speed]]" });
  const long = await d.place("Table", { x: "48", y: "20", w: "30", h: "16", rows: "Array.from({ length: 40 }, (_, i) => ({ n: i }))" });

  await hmi.set("Line.Speed", 1);
  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const words = async (id, name) => (await inst(id).locator(`.el[data-name="${name}"]`).allTextContents()).join();
  await eventually(async () => (await words(parts, "heading")) === "part,weight,ok", "a heading per key of the first row");
  check((await words(parts, "cell")) === "P1,1.25,true,P2,0.80,false", `the cells read ${await words(parts, "cell")}`);
  // each column's cells line up under its heading
  const lefts = (name) => inst(parts).locator(`.el[data-name="${name}"]`).evaluateAll((es) => es.map((e) => Math.round(e.getBoundingClientRect().x)));
  const [heads, cells] = [await lefts("heading"), await lefts("cell")];
  check(cells.every((x, i) => Math.abs(x - heads[i % 3]) <= 1), `the cells start at ${cells}, not under the headings at ${heads}`);
  // the second row striped, the first clear
  const fills = await inst(parts).locator('.el[data-name="row"]').evaluateAll((es) => es.map((e) => getComputedStyle(e).backgroundColor));
  check(fills[0] === "rgba(0, 0, 0, 0)" && fills[1] === "rgb(33, 33, 33)", `the rows are filled ${fills}`);

  check((await words(chosen, "heading")) === "weight,part", `the named columns head ${await words(chosen, "heading")}`);
  check((await words(chosen, "cell")) === "1.25,P1,0.80,P2", `the named columns read ${await words(chosen, "cell")}`);
  await eventually(async () => (await words(matrix, "cell")) === "1,2.50,3,1", "a list of lists, whole numbers as they are");
  check((await words(matrix, "heading")) === "0,1", `the matrix's columns head ${await words(matrix, "heading")}`);

  // more rows than fit scroll inside the table, which keeps its box
  const [box, body] = [await inst(long).boundingBox(), await inst(long).locator('.el[data-name="body"]').evaluate((e) => [e.scrollHeight, e.clientHeight])];
  const card = await inst(long).locator('.el[data-name="card"]').boundingBox();
  check(body[0] > body[1] * 2 && Math.abs(card.height - box.height) < 1, `the long table's body holds ${body[0]} in ${body[1]}, its card ${card.height} in ${box.height}`);
}

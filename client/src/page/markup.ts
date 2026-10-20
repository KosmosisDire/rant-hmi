// SVG markup a drawing's code gives, made safe to draw: the browser reads it, and what could
// run script or restyle the app is taken out, since a value from the mesh may end up in it.

const SVG = "http://www.w3.org/2000/svg";

/** Elements that run script, hold other documents or restyle the whole page. */
const UNSAFE = "script, foreignObject, iframe, object, embed, style";

/** The markup's nodes to draw, or why it does not read. */
export function svgNodes(markup: string): { nodes: Node[]; error?: string } {
  const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG}">${markup}</svg>`, "image/svg+xml");
  const fault = doc.querySelector("parsererror");
  if (fault) return { nodes: [], error: `the drawn SVG does not read: ${(fault.textContent ?? "").trim().split("\n")[0]}` };
  for (const el of [...doc.querySelectorAll(UNSAFE)]) el.remove();
  for (const el of doc.querySelectorAll("*")) {
    // an animation that sets a link can set one to run script
    if (/^(set|animate)$/i.test(el.localName) && /href/i.test(el.getAttribute("attributeName") ?? "")) {
      el.remove();
      continue;
    }
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/href$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  }
  return { nodes: [...doc.documentElement.childNodes].map((n) => document.importNode(n, true)) };
}

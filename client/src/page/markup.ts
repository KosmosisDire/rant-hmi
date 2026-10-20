// The SVG markup a markup element's code gives, made safe to draw: the browser reads it, and
// what could run script or restyle the app is taken out, since a value from the mesh may end
// up in it.

const SVG = "http://www.w3.org/2000/svg";

/** Elements that run script, hold other documents or restyle the whole page. */
const UNSAFE = "script, foreignObject, iframe, object, embed, style";

/** The markup as an SVG filling its box: its own root when it is one, so a file pastes in as
 *  it is, else an SVG holding it, drawn in pixels. Or why it does not read. */
export function svgOf(markup: string): { svg?: SVGSVGElement; error?: string } {
  const bare = markup.replace(/^\s*<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/i, "");
  const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG}">${bare}</svg>`, "image/svg+xml");
  const fault = doc.querySelector("parsererror");
  if (fault) return { error: `the SVG does not read: ${(fault.textContent ?? "").trim().split("\n")[0]}` };
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
  const top = [...doc.documentElement.children];
  const root = top.length === 1 && top[0].localName === "svg" ? top[0] : doc.documentElement;
  const svg = document.importNode(root, true) as unknown as SVGSVGElement;
  // a size with no view box would keep it at that size, where a view box scales it to the box
  const [w, h] = [svg.getAttribute("width"), svg.getAttribute("height")].map(Number);
  if (!svg.hasAttribute("viewBox") && w > 0 && h > 0) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.classList.add("markup");
  return { svg };
}

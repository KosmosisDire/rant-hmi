// The HMI draws its own light and dark, and its colours mean something, so the editor and the
// operator's screen both tell Dark Reader to leave them as they are. Recoloured, a live screen
// also paid for the extension watching every change it made.

export default async function ({ sys, check }) {
  for (const path of ["/", "/run"]) {
    const html = await (await fetch(`${sys.url}${path}`)).text();
    check(/<meta name="darkreader-lock"/.test(html), `${path} lets Dark Reader recolour it`);
  }
}

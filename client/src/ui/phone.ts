// Whether this screen is a phone's, by the width shell.css's phone rules start at.

import { createSignal } from "solid-js";

const query = matchMedia("(max-width: 600px)");
const [narrow, setNarrow] = createSignal(query.matches);
query.addEventListener("change", (e) => setNarrow(e.matches));

/** True on a screen as narrow as a phone's. */
export const phone = narrow;

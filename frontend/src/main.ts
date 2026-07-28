/* Bootstrap. The sync channel is on the origin that served this page, so the whole
 * application is one URL and there is nothing to configure. */

import { App } from "./shell.js";
import { syncUrl } from "./endpoint.js";

const url = syncUrl(location);
const app = new App(document.getElementById("app") as HTMLElement, url);
app.start();
/* exposed for headless drives and console debugging; nothing in the app reads it */
(window as any).app = app;

/* dev only: ?pick fetches the element picker, which turns a click on any part of the running
   UI into a text handle for it. Never loaded otherwise, and the app never references it. */
if (/[?&]pick(&|=|$)/.test(location.search))
  import("./pick.js").then((mod) => mod.installPicker());

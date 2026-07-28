/* Bootstrap. The sync channel is on the origin that served this page, so the whole
 * application is one URL and there is nothing to configure. */

import { App } from "./shell.js";
import { syncUrl } from "./endpoint.js";

const url = syncUrl(location);
const app = new App(document.getElementById("app") as HTMLElement, url);
app.start();
/* exposed for headless drives and console debugging; nothing in the app reads it */
(window as any).app = app;

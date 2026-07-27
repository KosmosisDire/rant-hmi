/* Bootstrap. The sync channel is on the origin that served this page, so the whole
 * application is one URL and there is nothing to configure. */

import { App } from "./shell.js";

const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const url = protocol + "//" + location.host + "/sync";
const app = new App(document.getElementById("app") as HTMLElement, url);
app.start();

/* Bootstrap. The sync channel is on the origin that served this page, so the whole
 * application is one URL and there is nothing to configure. */

import { App } from "./shell.js";
import { syncUrl } from "./endpoint.js";
import { installInputGuard } from "./input.js";

/* before anything renders or binds: every native gesture is refused for the whole document
   and the app opts back in where it means to (input.ts) */
installInputGuard();

/* ?operate is the deployed view: the same app under a minimal frame (no topbar, no
   sidebars), started straight in operate mode. Reached by the topbar's play button. */
const operate = /[?&]operate(&|=|$)/.test(location.search);
const url = syncUrl(location);
const app = new App(document.getElementById("app") as HTMLElement, url, operate);
app.start();
/* exposed for headless drives and console debugging; nothing in the app reads it */
(window as any).app = app;

import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/page.css";
import "./styles/design.css";
import "./ui/touch";

import { render } from "solid-js/web";
import { connect, send } from "./net/connection";
import { App } from "./shell/App";
import { Operator } from "./shell/Operator";
import { onAnswer } from "./state/stack";

// /run is the operator's screen, every other path the editor
const operator = location.pathname.replace(/\/+$/, "") === "/run";
connect();
onAnswer((ask, value) => send({ type: "answer", ask, value }));
render(() => (operator ? <Operator /> : <App />), document.getElementById("root")!);

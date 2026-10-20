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

import { render } from "solid-js/web";
import { connect } from "./net/connection";
import { App } from "./shell/App";

connect();
render(() => <App />, document.getElementById("root")!);

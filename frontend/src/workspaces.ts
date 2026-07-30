/* The frame's workspaces: what the topbar tabs switch between. Every workspace's DOM is
 * built ONCE and kept alive; switching hides the others instead of tearing them down, so
 * the content workspace's viewport transform, selection overlay and reconciled sidebars
 * survive a round trip through Data or Style. Nothing here touches the connection or the
 * document: a tab is pure view routing. */

import { el } from "./dom.js";

export type WorkspaceId = "content" | "data" | "style";

export interface Workspace {
  id: WorkspaceId;
  label: string;
  root: HTMLElement;
}

/* a workspace that has not landed yet: an honest empty state under a real tab */
function placeholder(id: WorkspaceId, label: string, note: string): Workspace {
  return {
    id,
    label,
    root: el("main", { class: "workspace-empty" }, [
      el("div", { class: "empty-note", text: note }),
    ]),
  };
}

/* content is the three-column editor the shell builds; the rest land in later steps */
export function buildWorkspaces(content: HTMLElement): Workspace[] {
  return [
    { id: "content", label: "Content", root: content },
    placeholder("data", "Data", "DATA — network explorer lands here"),
    placeholder("style", "Style", "STYLE — theme editor lands here"),
  ];
}

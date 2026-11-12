// A tree list as the sidebars show one: rows stepped in by their depth, each opened and closed by
// its caret, folders of a kind that open as this browser remembers and take what is dragged onto
// them, and a picture of what a row is while the pointer rests on it.

import { createSignal, For, type JSX, Show, splitProps } from "solid-js";
import { Portal } from "solid-js/web";
import { send } from "../net/connection";
import type { FolderKind } from "../protocol/FolderKind";
import { rememberedWords } from "../state/remember";
import { DraftInput } from "./DraftInput";
import { ChevronDown, ChevronRight, Folder, FolderInput, FolderPlus, Pencil, Trash } from "./icons";
import { type MenuEntry, type MenuItem, openMenu } from "./Menu";
import { follow } from "./press";

/** How far each level of a tree steps in, in px. */
export const INDENT = 12;

/** How long the pointer rests on a row before its picture shows, in ms. */
const REST = 350;

/** How far a press moves before it drags its row. */
const SLOP = 6;

export type RowProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  depth: number;
  /** Whether what it holds shows, none for a row that holds nothing. */
  open?: boolean;
  onFold?: () => void;
  icon: JSX.Element;
  label: JSX.Element;
  /** What its row ends with, as marks or a button. */
  end?: JSX.Element;
  /** A picture of what it is, shown beside it while the pointer rests on it. */
  preview?: () => JSX.Element;
};

/** One row of a tree: stepped in by its depth, a caret when it holds rows, its icon, its label
 *  and what it ends with. Any other attribute goes on the row. */
export function TreeRow(props: RowProps) {
  const [p, rest] = splitProps(props, ["depth", "open", "onFold", "icon", "label", "end", "preview", "class", "classList"]);
  const [, others] = splitProps(rest, ["onPointerDown"]);
  const [at, setAt] = createSignal<DOMRect | null>(null);
  let resting = 0;
  return (
    <button
      {...others}
      // all its classes in one list, as a spread sets `class` after `classList` and would wipe it
      classList={{ "list-row": true, "tree-row": true, ...Object.fromEntries((p.class ?? "").split(" ").filter(Boolean).map((c) => [c, true])), ...p.classList }}
      onPointerEnter={(e) => {
        if (!p.preview || e.pointerType === "touch") return;
        const row = e.currentTarget;
        resting = window.setTimeout(() => setAt(row.getBoundingClientRect()), REST);
      }}
      onPointerLeave={() => {
        clearTimeout(resting);
        setAt(null);
      }}
      // a press is no rest, so the picture waits for the pointer to come back
      onPointerDown={(e) => {
        clearTimeout(resting);
        setAt(null);
        (rest.onPointerDown as ((e: PointerEvent) => void) | undefined)?.(e);
      }}
    >
      <Show when={p.depth > 0}>
        <span style={{ width: `${p.depth * INDENT}px` }} />
      </Show>
      <Show when={p.open !== undefined} fallback={<span class="caret" />}>
        <span
          class="caret open-caret"
          title={p.open ? "Hide what it holds" : "Show what it holds"}
          onClick={(c) => {
            c.stopPropagation();
            p.onFold?.();
          }}
          onDblClick={(c) => c.stopPropagation()}
        >
          <Show when={p.open} fallback={<ChevronRight size={14} />}>
            <ChevronDown size={14} />
          </Show>
        </span>
      </Show>
      <span class="layer-icon">{p.icon}</span>
      <span class="list-label">{p.label}</span>
      <Show when={p.end}>
        <span class="row-end">{p.end}</span>
      </Show>
      <Show when={at()}>
        {(r) => (
          <Portal>
            <div class="tree-preview" style={{ left: `${r().right + 8}px`, top: `${r().top}px` }}>
              {p.preview!()}
            </div>
          </Portal>
        )}
      </Show>
    </button>
  );
}

/** The folders closed in every tree, each as `kind:path`. Folders start open. */
const [shut, setShut] = rememberedWords("tree-shut");
const isShut = (key: string) => shut().includes(key);
const toggle = (key: string) => setShut(isShut(key) ? shut().filter((k) => k !== key) : [...shut(), key]);

/** `name` inside `folder`, `/` between them. */
export const inFolder = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** The folder around `path`, empty at the top. */
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

/** When a dragged row was let go, so the click that follows does nothing. */
let dropped = -Infinity;

/** Whether a row was just let go of after a drag, so its click is no press. */
export const justDragged = () => performance.now() - dropped < 300;

/** The folder of a tree under a point of the screen, by its kind and path, if any. */
function folderAt(x: number, y: number): { kind: string; path: string; row: HTMLElement } | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-folder-kind]");
  return row ? { kind: row.dataset.folderKind!, path: row.dataset.folder ?? "", row } : null;
}

/** Drags a row of `kind` called `name` from a press: let go on a folder of its kind, it moves
 *  there, else `elsewhere` takes the point, as a component dropped on a page is placed there.
 *  Escape lets go of it, moving and placing nothing. */
export function dragToFolder(e: PointerEvent, it: { kind: FolderKind; name: string; label: string; elsewhere?: (x: number, y: number) => void; onStart?: () => void }) {
  if (e.button !== 0) return;
  const [sx, sy] = [e.clientX, e.clientY];
  const row = e.currentTarget as HTMLElement;
  let ghost: HTMLDivElement | null = null;
  let lit: HTMLElement | null = null;
  let cancelled = false;
  const escape = (k: KeyboardEvent) => {
    if (k.key !== "Escape" || !ghost) return;
    cancelled = true;
    stop();
  };
  const stop = () => {
    window.removeEventListener("keydown", escape);
    ghost?.remove();
    light(null);
  };
  const light = (to: HTMLElement | null) => {
    lit?.classList.remove("drop-inside");
    lit = to;
    lit?.classList.add("drop-inside");
  };
  follow(e, {
    move: (m) => {
      if (!ghost) {
        if (Math.hypot(m.clientX - sx, m.clientY - sy) < SLOP) return;
        row.setPointerCapture(m.pointerId);
        window.addEventListener("keydown", escape);
        it.onStart?.();
        ghost = document.body.appendChild(document.createElement("div"));
        ghost.className = "tree-ghost";
        ghost.textContent = it.label;
      }
      if (cancelled) return;
      Object.assign(ghost.style, { left: `${m.clientX + 10}px`, top: `${m.clientY + 6}px` });
      const f = folderAt(m.clientX, m.clientY);
      light(f && f.kind === it.kind ? f.row : null);
    },
    end: (u) => {
      if (!ghost) return;
      stop();
      dropped = performance.now();
      if (cancelled || u?.type !== "pointerup") return;
      const f = folderAt(u.clientX, u.clientY);
      if (f && f.kind === it.kind) send({ type: "move_to_folder", kind: it.kind, name: it.name, folder: f.path });
      else if (!f) it.elsewhere?.(u.clientX, u.clientY);
    },
  });
}

/** A row of an item's menu that moves it into any folder of its kind, or to the top. */
export function moveRow(kind: FolderKind, name: string, now: string, folders: string[]): MenuItem {
  const to = (folder: string) => send({ type: "move_to_folder", kind, name, folder });
  return {
    label: "Move to",
    icon: <FolderInput size={13} />,
    items: [{ label: "The top", disabled: now === "", run: () => to("") }, ...folders.map((f) => ({ label: f, disabled: f === now, run: () => to(f) }))],
  };
}

/** The folders of `kind` as rows under one named `title` for its top, the empty ones too, each
 *  item in the folder `folderOf` gives it, folders before items. `end` ends the top's row. */
export function FolderTree<T>(p: {
  kind: FolderKind;
  title: string;
  folders: string[];
  items: T[];
  folderOf: (t: T) => string;
  row: (t: T, depth: number) => JSX.Element;
  end?: JSX.Element;
  depth?: number;
}) {
  /** The folder whose name is being typed, by its path. */
  const [naming, setNaming] = createSignal<string | null>(null);
  /** Every folder, those the items are in too, should the list come later than they do. */
  const all = () => {
    const out = new Set(p.folders);
    for (const t of p.items) for (let f = p.folderOf(t); f; f = parentOf(f)) out.add(f);
    return [...out].sort();
  };
  const key = (path: string) => `${p.kind}:${path}`;
  const make = (inside: string) => {
    let n = 1;
    const free = (k: number) => inFolder(inside, k === 1 ? "New folder" : `New folder ${k}`);
    while (all().includes(free(n))) n++;
    if (isShut(key(inside))) toggle(key(inside));
    send({ type: "make_folder", kind: p.kind, folder: free(n) });
    setNaming(free(n));
  };
  const menu = (e: MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    const rows: MenuEntry[] = [{ label: "New folder", icon: <FolderPlus size={13} />, run: () => make(path) }];
    if (path) rows.push({ label: "Rename", icon: <Pencil size={13} />, run: () => setNaming(path) }, "-", { label: "Remove the folder", icon: <Trash size={13} />, run: () => send({ type: "remove_folder", kind: p.kind, folder: path }) });
    openMenu(e, rows);
  };
  const rename = (path: string, name: string) => {
    setNaming(null);
    const to = inFolder(parentOf(path), name.trim());
    if (name.trim() && to !== path) send({ type: "move_folder", kind: p.kind, from: path, to });
  };

  const Level = (l: { path: string; depth: number }) => (
    <>
      <For each={all().filter((f) => parentOf(f) === l.path)}>
        {(f) => (
          <>
            <TreeRow
              depth={l.depth}
              class="folder"
              open={!isShut(key(f))}
              onFold={() => toggle(key(f))}
              onClick={() => toggle(key(f))}
              onContextMenu={(e) => menu(e, f)}
              data-folder-kind={p.kind}
              data-folder={f}
              icon={<Folder size={14} />}
              label={
                <Show when={naming() === f} fallback={f.split("/").at(-1)}>
                  <DraftInput value={f.split("/").at(-1)!} focus={1} onCommit={(name) => rename(f, name)} />
                </Show>
              }
            />
            <Show when={!isShut(key(f))}>
              <Level path={f} depth={l.depth + 1} />
            </Show>
          </>
        )}
      </For>
      <For each={p.items.filter((t) => p.folderOf(t) === l.path)}>{(t) => p.row(t, l.depth)}</For>
    </>
  );

  return (
    <>
      <TreeRow
        depth={p.depth ?? 0}
        class="folder"
        open={!isShut(key(""))}
        onFold={() => toggle(key(""))}
        onClick={() => toggle(key(""))}
        onContextMenu={(e) => menu(e, "")}
        data-folder-kind={p.kind}
        data-folder=""
        icon={<Folder size={14} />}
        label={p.title}
        end={p.end}
      />
      <Show when={!isShut(key(""))}>
        <Level path="" depth={(p.depth ?? 0) + 1} />
      </Show>
    </>
  );
}

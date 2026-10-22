import { createSignal, For, Show } from "solid-js";
import type { Tag } from "../../protocol/Tag";
import { Plus } from "../../ui/icons";
import { Popover } from "../../ui/Popover";
import { TAG_WORDS, TagIcon } from "./TagIcon";

/** An inspector's section that adds one of `kinds` where the element picked says, as a shape
 *  to a diagram or a part to a scene: a button naming the first few, and a list of all. */
export function AddRow<T extends Tag>(p: { section: string; label: string; kinds: T[]; onAdd: (tag: T) => void }) {
  const [open, setOpen] = createSignal(false);
  let ghost!: HTMLButtonElement;
  const add = (tag: T) => {
    setOpen(false);
    p.onAdd(tag);
  };
  return (
    <>
      <div class="section">{p.section}</div>
      <button ref={ghost} class="ghost" classList={{ on: open() }} onClick={() => setOpen(!open())}>
        <Plus size={13} />
        {p.label}
        <span class="ghost-trail">{p.kinds.slice(0, 5).map((t) => TAG_WORDS[t]).join(", ")}</span>
      </button>
      <Show when={open()}>
        <Popover anchor={ghost} onClose={() => setOpen(false)} class="choice-list">
          <For each={p.kinds}>
            {(tag) => (
              <button class="menu-item" onClick={() => add(tag)}>
                <TagIcon tag={tag} size={13} />
                <span>{TAG_WORDS[tag]}</span>
              </button>
            )}
          </For>
        </Popover>
      </Show>
    </>
  );
}

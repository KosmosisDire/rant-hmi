// A handler as one card: what starts it and, in a few words, what it does, then its code.

import { type JSX, Show } from "solid-js";
import { complete, type Place, type Suggestion } from "../../state/complete";
import { summary, uses } from "../../state/uses";
import { DraftInput } from "../../ui/DraftInput";
import { X, Zap } from "../../ui/icons";

export function EventCard(p: {
  name: string;
  icon?: JSX.Element;
  code: string;
  onCode: (code: string) => void;
  onRemove?: () => void;
  removeTitle?: string;
  place: Place;
  /** What completion offers in place of the datapoints, as a component offers its inputs. */
  names?: Suggestion[];
  /** A component's inputs, which its code reads and sets by name. */
  inputs?: string[];
  placeholder?: string;
  /** The trigger's settings, between the head and the code. */
  children?: JSX.Element;
}) {
  const meta = () => summary(uses(p.code, p.inputs));
  return (
    <div class="event">
      <div class="event-head">
        <span class="event-icon">{p.icon ?? <Zap size={13} />}</span>
        <span class="event-name">{p.name}</span>
        <span class="event-meta" title={meta()}>
          {meta()}
        </span>
        <Show when={p.onRemove}>
          <button class="icon-btn" title={p.removeTitle} onClick={() => p.onRemove?.()}>
            <X size={13} />
          </button>
        </Show>
      </div>
      {p.children}
      <DraftInput
        multiline
        code
        class="editor code"
        value={p.code}
        placeholder={p.placeholder}
        onCommit={p.onCode}
        complete={(t, c) => complete(t, c, p.place, p.names)}
      />
    </div>
  );
}

import { ErrorBoundary, type JSX, onMount } from "solid-js";
import { faultOf } from "../state/caught";
import { report } from "../state/problems";

/** What it holds, or once that throws, what broke in its place with a way to draw it again. */
export function Guard(p: { children: JSX.Element; hidden?: boolean }) {
  return <ErrorBoundary fallback={(error, reset) => <Broken error={error} reset={reset} hidden={p.hidden} />}>{p.children}</ErrorBoundary>;
}

function Broken(p: { error: unknown; reset: () => void; hidden?: boolean }) {
  const found = faultOf([p.error]);
  onMount(() => report(found));
  return (
    <div class="broken" role="alert" hidden={p.hidden}>
      <div class="error-line">This part of the HMI broke: {found.text}</div>
      <button class="button" onClick={() => p.reset()}>
        Draw it again
      </button>
    </div>
  );
}

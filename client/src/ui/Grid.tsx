import { For, type JSX } from "solid-js";

/** Rows under column heads. On a phone a row wraps under its first cell and each other cell
 *  reads its column's head as a small label, given to the styles as --col-2 and on. */
export function Grid(p: { cols: string[]; children: JSX.Element }) {
  const labels = () => Object.fromEntries(p.cols.map((c, i) => [`--col-${i + 1}`, JSON.stringify(c)]));
  return (
    <table class="grid" style={labels()}>
      <thead>
        <tr>
          <For each={p.cols}>{(c) => <th>{c}</th>}</For>
        </tr>
      </thead>
      <tbody>{p.children}</tbody>
    </table>
  );
}

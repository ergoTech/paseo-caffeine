/**
 * A hand-off between the surface, which learns when the switch moved, and `contribute()`,
 * which owns the sidebar registration. A component cannot reach the client context, and
 * `contribute()` cannot hold React state, so the two meet here.
 *
 * The last value is remembered so a listener registered after the first report still
 * learns it, and so a status poll every five seconds does not re-register anything.
 */
type Listener = (hidden: boolean) => void;

let listener: Listener | null = null;
let last: boolean | null = null;

export function onHiddenChange(fn: Listener): () => void {
  listener = fn;
  if (last !== null) fn(last);
  return () => {
    if (listener === fn) listener = null;
  };
}

export function reportHidden(hidden: boolean): void {
  if (hidden === last) return;
  last = hidden;
  listener?.(hidden);
}

// apps/web/src/modules/08-encounters/review — a value that keeps its identity while its content does not. The composer rebuilds the review
// summary from the whole draft, and a keystroke in a free-text box changes the draft without changing anything the summary says (only
// whether the box is empty matters), so the memoised review panel would be re-rendered for nothing.
import { useMemo } from "react";

export function useStableValue<T>(value: T): T {
  const content = JSON.stringify(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `content` is the dependency by design: `value` is read only when its content changed.
  return useMemo(() => value, [content]);
}

// packages/ui/src/web/hooks — a value that follows its source only after it has been still for `delayMs`.
//
// A free-text filter that feeds a fetch (`load` depends on the typed text) refetches on every keystroke, and the list
// flashes a spinner under the operator's hands. Feed the debounced value to the fetch and the raw value to the input.
import { useEffect, useState } from "react";

export const DEFAULT_DEBOUNCE_MS = 350;

export function useDebouncedValue<T>(value: T, delayMs: number = DEFAULT_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

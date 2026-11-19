// apps/web/src/modules/08-encounters — move focus to an element after React has committed the change that should have put it there.
// Focus moved in the click handler lands on the element as it was BEFORE the state change: when the change replaces that element (a
// section that empties, a heading that takes the next section's text) the focus goes to a node that is gone. The request is a counter,
// so asking again for the same element still moves focus (a reader who pressed the same link twice expects to be taken there twice).
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

export function useFocusRequest<T extends HTMLElement>(): readonly [RefObject<T>, () => void] {
  const target = useRef<T>(null);
  const [requests, setRequests] = useState(0);
  useEffect(() => {
    if (requests > 0) target.current?.focus();
  }, [requests]);
  const request = useCallback(() => setRequests((count) => count + 1), []);
  return [target, request];
}

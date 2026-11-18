// apps/web/src/modules/08-encounters — a clock that ticks, for a countdown printed from the client's own time ("Due in 3h"). The server
// decides every stage and deadline; only the hours left until a deadline are worked out here, so they must not freeze at the moment the
// screen last re-rendered.
import { useEffect, useState } from "react";

export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

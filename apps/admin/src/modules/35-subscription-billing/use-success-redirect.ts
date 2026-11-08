// apps/admin/src/modules/35-subscription-billing — after a gated POST succeeds the form locks (`done`) and the page
// navigates away on a short delay. Locking matters: `busy` alone clears before the delay ends, so a second Enter
// would send another POST under a fresh Idempotency-Key. The pending redirect is cancelled if the page unmounts first.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

/** How long a subscription-level write (apply promo, pause) leaves its confirmation up before returning to the subscription. */
export const SUBSCRIPTION_REDIRECT_DELAY_MS = 800;
/** The same for the refund screens, which return to the queue and show a longer four-eyes confirmation. */
export const REFUND_REDIRECT_DELAY_MS = 1000;

export function useSuccessRedirect(): {
  done: boolean;
  finish: (to: string, delayMs: number) => void;
} {
  const navigate = useNavigate();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const finish = useCallback(
    (to: string, delayMs: number): void => {
      // Idempotent: a second `finish` replaces the pending redirect rather than stacking another.
      clearTimeout(timer.current);
      setDone(true);
      timer.current = setTimeout(() => navigate(to), delayMs);
    },
    [navigate],
  );
  return { done, finish };
}

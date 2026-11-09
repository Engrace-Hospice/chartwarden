// apps/admin/src/modules/35-subscription-billing — after a gated POST succeeds the form locks (`done`), the confirmation is
// raised as a toast and the page navigates away at once. The toast lives in the app-root ToastProvider, so it survives the
// navigation and is announced by the destination's live region (an inline banner inserted just before a redirect is torn
// down before a screen reader reads it). Locking matters: `busy` alone clears before the page is gone, so a second Enter
// would send another POST under a fresh Idempotency-Key. The navigation REPLACES the form's entry, so Back does not return to
// a form that could be submitted again.
import { useToast } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

export function useSuccessRedirect(): {
  done: boolean;
  finish: (to: string, message: string) => void;
} {
  const navigate = useNavigate();
  const toast = useToast();
  const [done, setDone] = useState(false);
  const finished = useRef(false);
  // Re-armed on every mount: StrictMode mounts, cleans up and mounts again.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const finish = useCallback(
    (to: string, message: string): void => {
      if (finished.current) return;
      finished.current = true;
      toast.show(message, { tone: "success" });
      // A POST that resolves after the operator left the page still landed, so it is announced; but it must not pull them back.
      if (!mounted.current) return;
      setDone(true);
      navigate(to, { replace: true });
    },
    [navigate, toast],
  );
  return { done, finish };
}

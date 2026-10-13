// M36 WP 2.8 - the caller's saved-reply picker data. Loaded when a consumer first needs it (the composer's picker
// opens, or the management screen mounts) and re-read on demand, so an edit made on the management screen shows up the
// next time the picker opens. A stale answer from an older request never overwrites a newer one.
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SavedReply } from "./saved-replies-types";

export type SavedRepliesState =
  | { readonly status: "idle" | "loading"; readonly items: readonly SavedReply[] }
  | { readonly status: "ready"; readonly items: readonly SavedReply[] }
  | { readonly status: "error"; readonly items: readonly SavedReply[] };

export function useSavedReplies(active: boolean): SavedRepliesState & { reload: () => void } {
  const client = useApiClient();
  const [state, setState] = useState<SavedRepliesState>({ status: "idle", items: [] });
  const [tick, setTick] = useState(0);
  const sequence = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger, not a value read inside
  useEffect(() => {
    if (!active) return;
    const mine = ++sequence.current;
    // Keep what we have while re-reading: the picker never flashes empty on a refresh.
    setState((current) => ({ status: "loading", items: current.items }));
    void client
      .GET("/api/v1/messaging/templates")
      .then(({ data, error }) => {
        if (mine !== sequence.current) return;
        if (error || !data) {
          setState((current) => ({ status: "error", items: current.items }));
          return;
        }
        setState({ status: "ready", items: data.items as readonly SavedReply[] });
      })
      .catch(() => {
        if (mine === sequence.current) setState((c) => ({ status: "error", items: c.items }));
      });
    return () => {
      sequence.current += 1;
    };
  }, [active, client, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload };
}

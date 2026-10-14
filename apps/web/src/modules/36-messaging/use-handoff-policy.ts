// M36 WP 3.5 - the organization's effective handoff expiry (tighten-only). Hidden unless the GET answers: 404 means
// handoffs are off, 403 or anything unreadable means "do not offer the control". The server decides; this infers nothing.
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { HandoffPolicy } from "./use-handoff-compose";

export type HandoffPolicyState =
  | { readonly status: "loading" | "unavailable" }
  | { readonly status: "ready"; readonly policy: HandoffPolicy };

const usable = (value: unknown): value is HandoffPolicy => {
  const candidate = value as Partial<HandoffPolicy> | null;
  return (
    typeof candidate?.expiry_minutes === "number" &&
    typeof candidate.platform_max_minutes === "number"
  );
};

export function useHandoffPolicy(): HandoffPolicyState & { reload: () => void } {
  const client = useApiClient();
  const [state, setState] = useState<HandoffPolicyState>({ status: "loading" });
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger
  useEffect(() => {
    let current = true;
    client
      .GET("/api/v1/messaging/handoffs/policy")
      .then(({ data }) => {
        if (!current) return;
        setState(usable(data) ? { status: "ready", policy: data } : { status: "unavailable" });
      })
      .catch(() => {
        if (current) setState({ status: "unavailable" });
      });
    return () => {
      current = false;
    };
  }, [client, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload };
}

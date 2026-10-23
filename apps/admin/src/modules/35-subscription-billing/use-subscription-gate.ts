// apps/admin/src/modules/35-subscription-billing — the pause and apply-promo screens used to render their form for any id,
// including a subscription that does not exist, and only found out on submit (#597). This reads the subscription first so
// the form appears only for a real one; a 404 is final (no retry), any other failure can be retried.
import { useApiClient, useRequestGuard } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import { isNotFound } from "./ui";

export type SubscriptionGate = "loading" | "ready" | "missing" | "error";

export function useSubscriptionGate(id: string | undefined): {
  gate: SubscriptionGate;
  retry: () => void;
} {
  const client = useApiClient();
  const guard = useRequestGuard();
  const [gate, setGate] = useState<SubscriptionGate>("loading");

  const load = useCallback(async () => {
    const isCurrent = guard();
    if (!id) {
      setGate("missing");
      return;
    }
    setGate("loading");
    const res = await client.GET("/api/admin/subscriptions/{id}", { params: { path: { id } } });
    if (!isCurrent()) return;
    setGate(res.error ? (isNotFound(res) ? "missing" : "error") : "ready");
  }, [client, guard, id]);

  useEffect(() => {
    void load();
  }, [load]);

  return { gate, retry: () => void load() };
}

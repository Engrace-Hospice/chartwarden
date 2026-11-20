// apps/web/src/modules/07-care-plan/change-proposals — how many proposed changes wait on a plan's review list, for the tab badge.
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import { listPlanProposals } from "./change-proposals-api";

/**
 * The number of proposals waiting for review on `planId`, or null until it is known (and when the read failed: a badge that cannot be
 * trusted is left off rather than showing 0). `refreshKey` re-reads it: pass whatever changes when the plan was re-read.
 */
export function usePendingChangeProposalCount(
  planId: string | undefined,
  refreshKey: unknown,
): number | null {
  const client = useApiClient();
  const [count, setCount] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey re-reads the count after the plan was re-read.
  useEffect(() => {
    if (!planId) {
      setCount(null);
      return;
    }
    let active = true;
    void listPlanProposals(client, planId, "pending").then((res) => {
      if (active) setCount(res.ok ? res.value.proposals.length : null);
    });
    return () => {
      active = false;
    };
  }, [client, planId, refreshKey]);
  return count;
}

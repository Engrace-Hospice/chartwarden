// apps/web/src/modules/24-billing-medicaid — the reads behind the Medicaid work queue. Claims are read one state at a time
// through the same list endpoint the claim workbench uses, and the org-wide validation worklist on its own. Each source
// lands as it answers; one that fails or is refused is reported as that, never as an empty list, so a failed read can
// never look like "no work". The server stays the only authz point (RLS + permission keys).
import type { ApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import { QUEUE_PAGE_SIZE, combine, readPage } from "../23-billing-medicare/use-work-queue-sources";
import type { SourceState } from "../23-billing-medicare/work-queue-model";
import {
  type BlockedClaim,
  MEDICAID_WORK_STATES,
  type MedicaidClaimRow,
} from "./medicaid-work-model";

export interface MedicaidWorkSources {
  claims: SourceState<MedicaidClaimRow>;
  blocked: SourceState<BlockedClaim>;
}

const LOADING: MedicaidWorkSources = {
  claims: { status: "loading" },
  blocked: { status: "loading" },
};

interface WorklistBody {
  groups?: { claims?: BlockedClaim[] }[];
  truncated?: boolean;
}

/** The worklist groups claims by rule, so one claim can appear under several; it is one blocked claim. */
async function readBlocked(call: Promise<unknown>): Promise<SourceState<BlockedClaim>> {
  try {
    const r = (await call) as { data?: unknown; error?: unknown; response?: { status?: number } };
    if (r.error || !r.data) return { status: r.response?.status === 403 ? "denied" : "error" };
    const body = r.data as WorklistBody;
    if (!Array.isArray(body.groups)) return { status: "error" };
    const byId = new Map<string, BlockedClaim>();
    for (const g of body.groups)
      for (const c of g.claims ?? []) if (!byId.has(c.claimId)) byId.set(c.claimId, c);
    // A truncated scan hit the server's cap: more claims exist than were returned, so counts show "N+".
    return { status: "ok", items: [...byId.values()], hasMore: body.truncated === true };
  } catch {
    return { status: "error" };
  }
}

export function useMedicaidWorkSources(client: ApiClient): {
  sources: MedicaidWorkSources;
  reload: () => void;
} {
  const [sources, setSources] = useState<MedicaidWorkSources>(LOADING);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs every read after "Try again".
  useEffect(() => {
    let active = true;
    setSources(LOADING);
    const land = <K extends keyof MedicaidWorkSources>(
      key: K,
      read: Promise<MedicaidWorkSources[K]>,
    ) =>
      void read.then((state) => {
        if (active) setSources((prev) => ({ ...prev, [key]: state }));
      });
    land(
      "claims",
      Promise.all(
        MEDICAID_WORK_STATES.map((state) =>
          readPage<MedicaidClaimRow>(
            client.GET("/api/v1/medicaid-claims", {
              params: { query: { limit: QUEUE_PAGE_SIZE, state } },
            } as never),
          ),
        ),
      ).then(combine),
    );
    land("blocked", readBlocked(client.GET("/api/v1/medicaid-validation-worklist", {} as never)));
    return () => {
      active = false;
    };
  }, [client, reloadKey]);

  return { sources, reload };
}

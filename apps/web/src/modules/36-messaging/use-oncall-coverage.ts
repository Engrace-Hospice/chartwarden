// M36 WP 4.12 (ADR-0080) - reads the on-call directory for one role and one patient's team. The safety-net poll (the thread's own timer)
// re-reads it because who is covering changes at a shift boundary; a failed refresh keeps the last answer and says it may be stale. An
// answer for an old role is dropped as superseded. After a 401/403/404 no further request is made (a changed role asks again).
import type { OnCallCoverageDto, OnCallDirectoryRole } from "@chartwarden/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";
import { useLatestPolling } from "./use-latest-polling";

export type OnCallView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  /** 401/403/404: not permitted, or the tenant flag is off (one identical 404); fail closed and offer no retry. */
  | { readonly status: "denied"; readonly code: 401 | 403 | 404 }
  | { readonly status: "ready"; readonly coverage: OnCallCoverageDto; readonly stale: boolean };

const DENIED = new Set([401, 403, 404]);

export function useOnCallCoverage(
  role: OnCallDirectoryRole,
  patientId: string | null,
): { readonly view: OnCallView; readonly retry: () => void } {
  const client = useOptionalApiClient();
  const [view, setView] = useState<OnCallView>({ status: "loading" });
  const generation = useRef(0);
  const denied = useRef(false);

  const read = useCallback(async (): Promise<boolean | undefined> => {
    if (!client || !patientId || denied.current) return undefined;
    const gen = generation.current;
    try {
      const { data, response } = await client.GET("/api/v1/messaging/oncall/coverage", {
        params: { query: { role, patient_id: patientId } },
      });
      if (gen !== generation.current) return undefined; // superseded: not a failure
      if (data) {
        setView({ status: "ready", coverage: data as OnCallCoverageDto, stale: false });
        return true;
      }
      const code = response?.status ?? 0;
      if (DENIED.has(code)) {
        denied.current = true;
        setView({ status: "denied", code: code as 401 | 403 | 404 });
        return undefined;
      }
    } catch {
      if (gen !== generation.current) return undefined;
    }
    setView((prev) => (prev.status === "ready" ? { ...prev, stale: true } : { status: "error" }));
    return false;
  }, [client, role, patientId]);

  useEffect(() => {
    generation.current += 1;
    denied.current = false;
    setView({ status: "loading" });
    void read();
    return () => {
      generation.current += 1;
    };
  }, [read]);

  useLatestPolling(read, false);

  const retry = useCallback(() => {
    setView((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    void read();
  }, [read]);

  return { view, retry };
}

// M36 role-based send (ADR-0081, PROPOSED) - reads who covers a role NOW for the sender to confirm. It is read when the sender asks
// ("Check who is on call") and again after a changed-resolution refusal; it is never cached between opens (a shift boundary changes the
// answer). A 401/403/404 is a definitive "not available" (fail closed, no retry); a thrown/5xx failure is "failed" and may be retried.
// An answer for an older request (a different role, or a retry that overtook it) is dropped.
import type { OnCallDirectoryRole, RoleSendResolutionDto } from "@wardenx/types";
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";

export type RoleResolutionView =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "denied" }
  | { readonly status: "ready"; readonly resolution: RoleSendResolutionDto };

const DENIED = new Set([401, 403, 404]);

export function useRoleResolution(
  channelId: string,
  patientId: string,
  role: OnCallDirectoryRole | null,
  active: boolean,
): { readonly view: RoleResolutionView; readonly reload: () => void } {
  const client = useApiClient();
  const [view, setView] = useState<RoleResolutionView>({ status: "idle" });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-read trigger
  useEffect(() => {
    latest.current += 1;
    const requestId = latest.current;
    if (!active || !role) {
      setView({ status: "idle" });
      return;
    }
    setView({ status: "loading" });
    const settle = (next: RoleResolutionView): void => {
      if (requestId === latest.current) setView(next);
    };
    // Deferred a tick so a client that throws (not just rejects) fails the same way.
    void Promise.resolve()
      .then(() =>
        client.GET("/api/v1/messaging/channels/{id}/role-send/resolution", {
          params: { path: { id: channelId }, query: { role, patient_id: patientId } },
        }),
      )
      .then(
        (result) => {
          const status = result?.response?.status;
          if (result?.data) {
            settle({ status: "ready", resolution: result.data as RoleSendResolutionDto });
          } else if (status !== undefined && DENIED.has(status)) settle({ status: "denied" });
          else settle({ status: "failed" });
        },
        () => settle({ status: "failed" }),
      );
    return () => {
      latest.current += 1;
    };
  }, [client, channelId, patientId, role, active, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { view, reload };
}

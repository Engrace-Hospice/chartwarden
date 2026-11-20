// apps/web/src/modules/15-discipline-care-plans — the patient's ACTIVE IPOC problems, for the goal form's picker.
//
// A discipline goal refines a problem owned by the interdisciplinary plan of care (M7); the goal's
// `parentProblemId` is that problem's id. The editor used to ask for the uuid as free text. This reads the
// patient's care plan through the typed client (an RN holds `care_plan.read`; M7's own caseload scope applies)
// and keeps only problems still being worked, so a resolved problem cannot be picked.
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";

export interface IpocProblemOption {
  readonly id: string;
  readonly description: string;
}

export interface IpocProblems {
  readonly problems: readonly IpocProblemOption[];
  readonly loading: boolean;
  /** Why the problems could not be read; the goal form must not fall back to a pasted id. */
  readonly error: string | null;
}

const LOADING: IpocProblems = { problems: [], loading: true, error: null };
const LOAD_ERROR = "The IPOC problems could not be loaded.";

/** Narrow the care-plan body to its active problems; anything malformed degrades to an empty list. */
export function activeProblemsOf(body: unknown): readonly IpocProblemOption[] {
  const raw = (body as { problems?: unknown } | null | undefined)?.problems;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p): IpocProblemOption[] => {
    const row = p as { id?: unknown; description?: unknown; status?: unknown } | null;
    if (!row || row.status !== "active") return [];
    if (typeof row.id !== "string" || typeof row.description !== "string") return [];
    return [{ id: row.id, description: row.description }];
  });
}

/** Load the patient's active IPOC problems once (nothing is requested until the patient id is known). */
export function useIpocProblems(patientId: string | undefined): IpocProblems {
  const client = useApiClient();
  const [state, setState] = useState<IpocProblems>(LOADING);

  useEffect(() => {
    if (!patientId) return;
    let cancelled = false;
    setState(LOADING);
    void (async () => {
      try {
        const res = await client.GET("/api/v1/patients/{patientId}/care-plan", {
          params: { path: { patientId } },
        });
        if (cancelled) return;
        if (res.error) {
          setState({ problems: [], loading: false, error: LOAD_ERROR });
          return;
        }
        setState({ problems: activeProblemsOf(res.data), loading: false, error: null });
      } catch {
        if (!cancelled) setState({ problems: [], loading: false, error: LOAD_ERROR });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, patientId]);

  return state;
}

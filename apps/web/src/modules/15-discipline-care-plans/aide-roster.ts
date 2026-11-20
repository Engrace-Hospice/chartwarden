// apps/web/src/modules/15-discipline-care-plans — the Aide POC's staff roster: the aides and RN supervisors active
// at a plan's location, read once through the plan-scoped `GET /discipline-plans/{planId}/aide-supervision-roster`
// (an RN cannot reach the org-admin member list). It feeds the supervisory-visit pickers and turns the plan's
// bound membership ids into names.
import { useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./discipline-api";
import { shortId } from "./discipline-status";

/** What the Assignment panel and the ledger show when the plan binds nobody. */
export const NOT_ASSIGNED = "Not assigned";

export interface AideRosterMember {
  readonly membershipId: string;
  readonly displayName: string;
  readonly roleKey: string;
}

export interface AideRoster {
  readonly aides: readonly AideRosterMember[];
  readonly supervisors: readonly AideRosterMember[];
  readonly loading: boolean;
  /** Why the roster could not be loaded; the pickers must not fall back to free-text ids. */
  readonly error: string | null;
  /** A person's name for a bound membership id: "Not assigned" for none, the short id when unknown. */
  readonly nameOf: (membershipId: string | null | undefined) => string;
  /** Read the roster again (the modal's "Retry"); a no-op while a read is in flight. */
  readonly reload: () => void;
}

type RosterState = Pick<AideRoster, "aides" | "supervisors" | "loading" | "error">;

const LOADING: RosterState = { aides: [], supervisors: [], loading: true, error: null };
const ROSTER_ERROR = "The staff list could not be loaded.";

/** A malformed body degrades to an empty list rather than crashing the screen that shows it. */
const asMembers = (value: unknown): readonly AideRosterMember[] =>
  Array.isArray(value) ? (value as readonly AideRosterMember[]) : [];

/** Pure name lookup (the rules the screens share): none bound → "Not assigned"; unlisted → the short id. */
export function rosterNameOf(
  members: readonly AideRosterMember[],
  membershipId: string | null | undefined,
): string {
  if (!membershipId) return NOT_ASSIGNED;
  return members.find((m) => m.membershipId === membershipId)?.displayName ?? shortId(membershipId);
}

/** Load the roster for `planId` once (nothing is requested until the plan id is known). */
export function useAideRoster(planId: string | undefined): AideRoster {
  const client = useApiClient();
  const [state, setState] = useState<RosterState>(LOADING);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger
  useEffect(() => {
    if (!planId) return;
    let cancelled = false;
    setState(LOADING);
    void (async () => {
      try {
        const res = await client.GET("/api/v1/discipline-plans/{planId}/aide-supervision-roster", {
          params: { path: { planId } },
        });
        if (cancelled) return;
        if (res.error || !res.data) {
          setState({
            aides: [],
            supervisors: [],
            loading: false,
            error: errorMessage(res.error, ROSTER_ERROR),
          });
          return;
        }
        setState({
          aides: asMembers(res.data.aides),
          supervisors: asMembers(res.data.supervisors),
          loading: false,
          error: null,
        });
      } catch {
        if (!cancelled) {
          setState({ aides: [], supervisors: [], loading: false, error: ROSTER_ERROR });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, planId, attempt]);

  const { aides, supervisors } = state;
  const nameOf = useCallback(
    (membershipId: string | null | undefined) =>
      rosterNameOf([...aides, ...supervisors], membershipId),
    [aides, supervisors],
  );

  return { ...state, nameOf, reload };
}

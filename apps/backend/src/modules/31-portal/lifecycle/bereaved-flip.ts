// apps/backend/src/modules/31-portal/lifecycle/bereaved-flip.ts — M31-T03 (§2.2.1, §2.2.2, §7.5, D6).
//
// The bereaved-mode lateral flip (D4/D6) as a PURE planner. On `m16.bereavement.plan_opened` (consumed in
// M31-T06), each bereaved contact's portal account has its live care-time grant REVOKED with
// `revoke_cascade_source='patient_deceased'` and a NEW `bereaved_family` grant inserted with the narrow D6
// scope (bereavement messaging + resource library; live-patient categories floor-denied). The account row
// identity is preserved — same login, same TOTP; only the grant scope flips (§7.5). On
// `m16.bereavement.plan_closed_completed` the bereaved grant is revoked with
// `revoke_cascade_source='bereavement_window_expired'`.
//
// M16 owns the truth of WHETHER an account is in the bereavement window; M31 reads it via
// `BereavedPortalScopeProvider`, resolved OPAQUELY from the M1 registry (M16/M22 seam-consumption idiom) so
// M31 stays off a `@wardenx/bereavement` import edge even though M16 is in `dependsOn`. The planner is pure
// (grants + resolved scope in, a revoke/insert plan out); the impure resolver + the DB write land in
// M31-T06's consumer. `patient_deceased`/`bereavement_window_expired` are the exact
// `PortalGrantRevokeCascadeSource` members the T01 leaf + the §3.3 CHECK name.
import type {
  PatientId,
  PortalAccessGrantId,
  PortalAccessGrantKind,
  PortalGrantRevokeCascadeSource,
  PortalScopeSet,
} from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";
import { requirePortal } from "./errors";
import { platformFloorScopeSet } from "./scope-set";

/** An active grant on the flipping account, as the planner reads it. */
export interface FlipCandidateGrant {
  readonly grantId: PortalAccessGrantId;
  readonly patientId: PatientId;
  readonly grantKind: PortalAccessGrantKind;
  readonly revoked: boolean;
}

/** One grant to revoke in the plan (the route/consumer executes it inside one transaction, M31-T06). */
export interface GrantRevocation {
  readonly grantId: PortalAccessGrantId;
  readonly revokeCascadeSource: PortalGrantRevokeCascadeSource;
}

/** One grant to insert in the plan. */
export interface GrantInsertion {
  readonly patientId: PatientId;
  readonly grantKind: PortalAccessGrantKind;
  readonly scopeSet: PortalScopeSet;
}

/** The declarative flip plan for one account against one decedent patient. */
export interface BereavedFlipPlan {
  readonly revoke: readonly GrantRevocation[];
  readonly insert: readonly GrantInsertion[];
}

/**
 * §7.5 / D6 — plan the lateral flip for a decedent patient's grants on one account. The account's ACTIVE
 * grant(s) for `decedentPatientId` are revoked (`patient_deceased`) and one `bereaved_family` grant is
 * inserted with the D6 floor scope. `bereavedInWindow` is M16's resolution — false / no scope means the
 * contact is not (or no longer) in the bereavement window, so there is nothing to grant and orphan cleanup
 * (plain revocation) is the correct path, not a flip. Fails CLOSED on both: no active grant to flip
 * (`BEREAVED_FLIP_GRANT_NOT_ACTIVE`) and no in-window bereaved scope (`BEREAVED_SCOPE_UNAVAILABLE`).
 */
export function planBereavedFlip(input: {
  decedentPatientId: PatientId;
  accountGrants: readonly FlipCandidateGrant[];
  bereavedInWindow: boolean;
  floorVersion: string;
}): BereavedFlipPlan {
  const liveForDecedent = input.accountGrants.filter(
    (g) => g.patientId === input.decedentPatientId && !g.revoked,
  );
  requirePortal(
    liveForDecedent.length > 0,
    "BEREAVED_FLIP_GRANT_NOT_ACTIVE",
    "no active grant for the decedent patient to flip to bereaved mode",
  );
  requirePortal(
    input.bereavedInWindow,
    "BEREAVED_SCOPE_UNAVAILABLE",
    "M16 returned no in-window bereaved scope for this account",
  );
  return {
    revoke: liveForDecedent.map((g) => ({
      grantId: g.grantId,
      revokeCascadeSource: "patient_deceased" as const,
    })),
    insert: [
      {
        patientId: input.decedentPatientId,
        grantKind: "bereaved_family" as const,
        scopeSet: platformFloorScopeSet("bereaved_family", input.floorVersion),
      },
    ],
  };
}

/**
 * §7.5 — plan the window-close revocation. Every non-revoked `bereaved_family` grant for the decedent
 * patient on the account is revoked with `bereavement_window_expired`. The account stays active (account ≠
 * grant); it may hold other patients' grants (§7.5 step 2-3).
 */
export function planBereavedWindowClose(input: {
  decedentPatientId: PatientId;
  accountGrants: readonly FlipCandidateGrant[];
}): BereavedFlipPlan {
  const liveBereaved = input.accountGrants.filter(
    (g) =>
      g.patientId === input.decedentPatientId && g.grantKind === "bereaved_family" && !g.revoked,
  );
  return {
    revoke: liveBereaved.map((g) => ({
      grantId: g.grantId,
      revokeCascadeSource: "bereavement_window_expired" as const,
    })),
    insert: [],
  };
}

/** The M31-side structural projection of M16's `BereavedPortalScopeProvider` (the arm M31 calls). */
export interface BereavedPortalScopePort {
  scopeForPortalAccount(
    orgId: string,
    portalAccountId: string,
  ): Promise<readonly { readonly inBereavementWindow: boolean }[]>;
}

/**
 * §7.5 / D6 — is the account in an OPEN bereavement window per M16? Reads `BereavedPortalScopeProvider`
 * OPAQUELY from the M1 registry. FAIL-CLOSED: an unreadable / empty scope is treated as "not in window",
 * which routes to orphan cleanup rather than granting bereaved access on a read failure.
 */
export async function resolveBereavedInWindow(input: {
  orgId: string;
  portalAccountId: string;
}): Promise<boolean> {
  try {
    const provider = getSeam("BereavedPortalScopeProvider") as BereavedPortalScopePort;
    const scopes = await provider.scopeForPortalAccount(input.orgId, input.portalAccountId);
    return scopes.some((s) => s.inBereavementWindow);
  } catch {
    return false;
  }
}

// apps/backend/src/modules/31-portal/seams/readers.ts — M31-T06 the SEVEN published reader seams (§4.3).
//
// Each factory returns the T01 leaf interface (`@wardenx/types`) over an injected port (Drizzle at boot; slice
// in tests). The consumers — M28 SMART user-launch, M30 patient-engagement + §4004 + §164.528, M33 dashboards,
// M34 SaaS console, M8 encounter-attach, M17 room back-ref, M35 Phase-2 billing — import ONLY the interface
// type, never an M31 schema. Registration into the M1 SeamRegistry is port-injected at the composition root
// (./registration + T07), NOT here (the M27/M30 `seams.ts` precedent). Every projection is PHI-minimal by
// construction (ids, scope categories, aggregate counts — never a name or cipher column).
import type {
  IsoInstant,
  PatientId,
  PortalAccessGrantReader,
  PortalAccountReader,
  PortalDisclosureAccountingProvider,
  PortalEngagementProvider,
  PortalSessionMinter,
  TelehealthMetricsProvider,
  TelehealthVisitReader,
} from "@wardenx/types";
import { PortalStateError } from "../lifecycle/errors";
import type {
  PortalAccountStore,
  PortalDisclosureStore,
  PortalEngagementStore,
  PortalGrantStore,
  PortalSessionCreatePort,
  TelehealthVisitStore,
} from "./stores";

/** §4.3 seam 1 — `PortalAccountReader`. Consumed by M28 / M30 / M33 / M34. */
export function createPortalAccountReader(store: PortalAccountStore): PortalAccountReader {
  return {
    tenantPortalAccountCount: (orgId) => store.countByStatus(orgId),
    accountsForPatient: (orgId, patientId) => store.accountsForPatient(orgId, patientId),
    accountByUserId: (orgId, userId) => store.accountByUserId(orgId, userId),
  };
}

/** §4.3 seam 2 — `PortalAccessGrantReader`. Consumed by M28 SMART user-launch + M30 §4004 access-rate. */
export function createPortalAccessGrantReader(store: PortalGrantStore): PortalAccessGrantReader {
  return {
    activeGrantsForAccount: (orgId, portalAccountId) =>
      store.activeGrantsForAccount(orgId, portalAccountId),
    activeGrantForAccountAndPatient: (orgId, portalAccountId, patientId) =>
      store.activeGrantForAccountAndPatient(orgId, portalAccountId, patientId),
    patientsWithActiveGrantsInOrg: (orgId, asOf) =>
      store.patientsWithActiveGrantsInOrg(orgId, asOf),
  };
}

/** §4.3 seam 3 — `PortalEngagementProvider`. Consumed by M30 patient-engagement measure + M33 dashboards. */
export function createPortalEngagementProvider(
  store: PortalEngagementStore,
): PortalEngagementProvider {
  return {
    engagementForPatient: (orgId, patientId, withinDays) =>
      store.engagementForPatient(orgId, patientId, withinDays),
    engagementMetricsForOrg: (orgId, fromIso, toIso) =>
      store.engagementMetricsForOrg(orgId, fromIso, toIso),
  };
}

/** §4.3 seam 4 — `TelehealthMetricsProvider`. Consumed by M30 completion measure + M33 + M35 Phase-2 billing. */
export function createTelehealthMetricsProvider(
  store: TelehealthVisitStore,
): TelehealthMetricsProvider {
  return {
    metricsForOrg: (orgId, fromIso, toIso) => store.metricsForOrg(orgId, fromIso, toIso),
    minutesByTenant: (orgId, fromIso, toIso) => store.minutesByTenant(orgId, fromIso, toIso),
  };
}

/** §4.3 seam 5 — `TelehealthVisitReader`. Consumed by M8 (encounter attach) + M17 (visit reconciliation). */
export function createTelehealthVisitReader(store: TelehealthVisitStore): TelehealthVisitReader {
  return {
    getById: (orgId, telehealthVisitId) => store.getById(orgId, telehealthVisitId),
    getByM17VisitId: (orgId, m17VisitId) => store.getByM17VisitId(orgId, m17VisitId),
  };
}

/**
 * §4.3 seam 6 — `PortalSessionMinter`. Consumed by M28 Phase-2 SMART user-launch to mint a patient-context
 * FHIR session. Resolves the active grant for (account, patient); FAILS CLOSED (`SESSION_PATIENT_UNREACHABLE`)
 * when the account holds no active grant for the patient — a launch cannot mint a session for a patient the
 * account cannot reach (§8.1). Scope NARROWING against the SMART scope grammar (`patient/*.read`) is M28's
 * concern; this seam returns the requested scopes verbatim as the resolved set, gated by the grant's existence.
 */
export function createPortalSessionMinter(deps: {
  grants: PortalGrantStore;
  sessions: PortalSessionCreatePort;
}): PortalSessionMinter {
  return {
    async mintSessionForSmartLaunch(input) {
      const grant = await deps.grants.activeGrantForAccountAndPatient(
        input.orgId,
        input.portalAccountId,
        input.patientId,
      );
      if (grant === null)
        throw new PortalStateError(
          "SESSION_PATIENT_UNREACHABLE",
          "No active portal grant links this account to the requested patient.",
        );
      const { sessionId } = await deps.sessions.createSmartLaunchSession({
        orgId: input.orgId,
        portalAccountId: input.portalAccountId,
        patientId: input.patientId,
        activeGrantId: grant.grantId,
        launchTokenHash: input.smartLaunchContext.launchTokenHash,
      });
      return {
        sessionId,
        activeGrantId: grant.grantId,
        resolvedScopes: [...input.requestedScopes],
      };
    },
  };
}

/** §4.3 seam 7 — `PortalDisclosureAccountingProvider`. Consumed by M30 §164.528 scorecard + M22 amendment
 *  disclosure-tracking. */
export function createPortalDisclosureAccountingProvider(
  store: PortalDisclosureStore,
): PortalDisclosureAccountingProvider {
  return {
    disclosuresForPatient: (
      orgId: string,
      patientId: PatientId,
      fromIso: IsoInstant,
      toIso: IsoInstant,
    ) => store.disclosuresForPatient(orgId, patientId, fromIso, toIso),
  };
}

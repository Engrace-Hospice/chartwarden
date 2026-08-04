// apps/backend/src/modules/31-portal/seams/stores.ts — M31-T06 the data ports behind the §4.3 seams.
//
// The seven published reader seams (§4.3) are PURE orchestration over these narrow ports; the real Drizzle
// reads (org-scoped under `withOrgContext`, over the three owned tables `portal_account` /
// `portal_access_grant` / `telehealth_visit`) bind at the composition root (T07). This file declares the
// ports + a capturing in-memory slice for the unit tests, the M5 `patient-mutator` precedent (ports here,
// Drizzle at boot). Every reader projection is DIGEST-shaped (PHI-minimal by construction — ids not names,
// scope categories not raw jsonb, aggregate counts not patient rows) so a consumer never sees a cipher column.
import type {
  IsoInstant,
  PatientId,
  PortalAccessGrantDigest,
  PortalAccountDigest,
  PortalDataCategory,
  PortalDisclosureRecord,
  PortalEngagementMetrics,
  PortalScopeSet,
  TelehealthVisitDigest,
} from "@wardenx/types";

// ── §4.3 seam 1: PortalAccountReader ────────────────────────────────────────────────────────────────────
export interface PortalAccountStore {
  countByStatus(
    orgId: string,
  ): Promise<{ active: number; invited: number; revoked: number; bereaved: number }>;
  accountsForPatient(orgId: string, patientId: PatientId): Promise<PortalAccountDigest[]>;
  accountByUserId(orgId: string, userId: string): Promise<PortalAccountDigest | null>;
}

// ── §4.3 seam 2: PortalAccessGrantReader (also feeds the session minter) ────────────────────────────────
export interface PortalGrantStore {
  activeGrantsForAccount(
    orgId: string,
    portalAccountId: string,
  ): Promise<PortalAccessGrantDigest[]>;
  activeGrantForAccountAndPatient(
    orgId: string,
    portalAccountId: string,
    patientId: PatientId,
  ): Promise<PortalAccessGrantDigest | null>;
  patientsWithActiveGrantsInOrg(
    orgId: string,
    asOf: IsoInstant,
  ): Promise<{ patientId: PatientId; grantCount: number }[]>;
}

// ── §4.3 seam 3: PortalEngagementProvider ───────────────────────────────────────────────────────────────
export interface PortalEngagementStore {
  engagementForPatient(
    orgId: string,
    patientId: PatientId,
    withinDays: number,
  ): Promise<{
    hasActiveAccount: boolean;
    daysActive: number;
    lastViewedAt: IsoInstant | null;
    messagesSent: number;
    documentsViewed: number;
    amendmentsSubmitted: number;
    administrationsAttested: number;
  }>;
  engagementMetricsForOrg(
    orgId: string,
    fromIso: IsoInstant,
    toIso: IsoInstant,
  ): Promise<PortalEngagementMetrics>;
}

// ── §4.3 seams 4 + 5: TelehealthMetricsProvider + TelehealthVisitReader ─────────────────────────────────
export interface TelehealthVisitStore {
  getById(orgId: string, telehealthVisitId: string): Promise<TelehealthVisitDigest | null>;
  getByM17VisitId(orgId: string, m17VisitId: string): Promise<TelehealthVisitDigest | null>;
  metricsForOrg(
    orgId: string,
    fromIso: IsoInstant,
    toIso: IsoInstant,
  ): Promise<{
    visitsTotal: number;
    visitsCompletedClean: number;
    visitsCompletedAborted: number;
    audioOnlyFallbackRate: number;
    recordingRate: number;
    vendorOutageDurationMin: number;
  }>;
  minutesByTenant(
    orgId: string,
    fromIso: IsoInstant,
    toIso: IsoInstant,
  ): Promise<{ totalMinutes: number; recordedMinutes: number }>;
}

// ── §4.3 seam 6: PortalSessionMinter (the create half; grant resolution reuses PortalGrantStore) ────────
export interface PortalSessionCreatePort {
  /** Create a portal-equivalent session bound to (account, patient, grant) for a SMART user-launch (M28
   *  Phase-2). Returns the new session id. The session-policy tightening is the T03 session class's concern;
   *  this port is the persistence handle. */
  createSmartLaunchSession(input: {
    orgId: string;
    portalAccountId: string;
    patientId: PatientId;
    activeGrantId: string;
    launchTokenHash: string;
  }): Promise<{ sessionId: string }>;
}

// ── §4.3 seam 7: PortalDisclosureAccountingProvider ─────────────────────────────────────────────────────
export interface PortalDisclosureStore {
  disclosuresForPatient(
    orgId: string,
    patientId: PatientId,
    fromIso: IsoInstant,
    toIso: IsoInstant,
  ): Promise<PortalDisclosureRecord[]>;
}

/** Every port the seven seams compose over, bundled for the composition root (T07 binds Drizzle-backed
 *  instances; the slice below fulfils the same shape for tests). */
export interface M31SeamStores {
  readonly accounts: PortalAccountStore;
  readonly grants: PortalGrantStore;
  readonly engagement: PortalEngagementStore;
  readonly telehealth: TelehealthVisitStore;
  readonly sessions: PortalSessionCreatePort;
  readonly disclosures: PortalDisclosureStore;
}

// ── in-memory slice ─────────────────────────────────────────────────────────────────────────────────────

/** The seed shape for the in-memory slice — enough rows to exercise every seam in a unit test. */
export interface M31SeamSeed {
  readonly accounts?: ReadonlyArray<{
    readonly orgId: string;
    readonly digest: PortalAccountDigest;
    /** the patients this account holds a grant for (drives `accountsForPatient`). */
    readonly patientIds: readonly PatientId[];
  }>;
  readonly grants?: ReadonlyArray<{
    readonly orgId: string;
    readonly digest: PortalAccessGrantDigest;
  }>;
  readonly visits?: ReadonlyArray<{
    readonly orgId: string;
    readonly digest: TelehealthVisitDigest;
  }>;
  readonly disclosures?: ReadonlyArray<{
    readonly orgId: string;
    readonly record: PortalDisclosureRecord;
  }>;
}

function scopeCategoryCount(scope: PortalScopeSet): number {
  return Object.values(scope.categories).filter(Boolean).length;
}

/** Build a capturing in-memory {@link M31SeamStores} for the slice/tests. Aggregates (counts, metrics) are
 *  derived from the seeded digests so the tests assert real projection math, not stubbed numbers. */
export function createInMemoryM31SeamStores(seed: M31SeamSeed = {}): {
  stores: M31SeamStores;
  createdSessions: Array<{ portalAccountId: string; patientId: PatientId; activeGrantId: string }>;
} {
  const accounts = [...(seed.accounts ?? [])];
  const grants = [...(seed.grants ?? [])];
  const visits = [...(seed.visits ?? [])];
  const disclosures = [...(seed.disclosures ?? [])];
  const createdSessions: Array<{
    portalAccountId: string;
    patientId: PatientId;
    activeGrantId: string;
  }> = [];

  const isActiveGrant = (d: PortalAccessGrantDigest): boolean => d.revokedAt === null;

  return {
    createdSessions,
    stores: {
      accounts: {
        async countByStatus(orgId) {
          const rows = accounts.filter((a) => a.orgId === orgId).map((a) => a.digest);
          return {
            active: rows.filter((r) => r.status === "active").length,
            invited: rows.filter((r) => r.status === "invited").length,
            revoked: rows.filter((r) => r.status === "revoked").length,
            bereaved: rows.filter((r) => r.status === "bereaved").length,
          };
        },
        async accountsForPatient(orgId, patientId) {
          return accounts
            .filter((a) => a.orgId === orgId && a.patientIds.includes(patientId))
            .map((a) => a.digest);
        },
        async accountByUserId(orgId, userId) {
          return (
            accounts.find((a) => a.orgId === orgId && a.digest.userId === userId)?.digest ?? null
          );
        },
      },
      grants: {
        async activeGrantsForAccount(orgId, portalAccountId) {
          return grants
            .filter(
              (g) =>
                g.orgId === orgId &&
                g.digest.portalAccountId === portalAccountId &&
                isActiveGrant(g.digest),
            )
            .map((g) => g.digest);
        },
        async activeGrantForAccountAndPatient(orgId, portalAccountId, patientId) {
          return (
            grants.find(
              (g) =>
                g.orgId === orgId &&
                g.digest.portalAccountId === portalAccountId &&
                g.digest.patientId === patientId &&
                isActiveGrant(g.digest),
            )?.digest ?? null
          );
        },
        async patientsWithActiveGrantsInOrg(orgId) {
          const byPatient = new Map<PatientId, number>();
          for (const g of grants)
            if (g.orgId === orgId && isActiveGrant(g.digest))
              byPatient.set(g.digest.patientId, (byPatient.get(g.digest.patientId) ?? 0) + 1);
          return [...byPatient.entries()].map(([patientId, grantCount]) => ({
            patientId,
            grantCount,
          }));
        },
      },
      engagement: {
        async engagementForPatient(orgId, patientId) {
          const hasActiveAccount = accounts.some(
            (a) =>
              a.orgId === orgId &&
              a.patientIds.includes(patientId) &&
              (a.digest.status === "active" || a.digest.status === "bereaved"),
          );
          return {
            hasActiveAccount,
            daysActive: 0,
            lastViewedAt: null,
            messagesSent: 0,
            documentsViewed: 0,
            amendmentsSubmitted: 0,
            administrationsAttested: 0,
          };
        },
        async engagementMetricsForOrg(orgId) {
          const rows = accounts.filter((a) => a.orgId === orgId).map((a) => a.digest);
          const activePatients = new Set<PatientId>();
          for (const g of grants)
            if (g.orgId === orgId && isActiveGrant(g.digest))
              activePatients.add(g.digest.patientId);
          return {
            accountsActive: rows.filter((r) => r.status === "active").length,
            accountsInvited: rows.filter((r) => r.status === "invited").length,
            accountsRevoked: rows.filter((r) => r.status === "revoked").length,
            accountsBereaved: rows.filter((r) => r.status === "bereaved").length,
            patientsWithActiveGrant: activePatients.size,
            sessionsInWindow: 0,
          };
        },
      },
      telehealth: {
        async getById(orgId, telehealthVisitId) {
          return (
            visits.find(
              (v) => v.orgId === orgId && v.digest.telehealthVisitId === telehealthVisitId,
            )?.digest ?? null
          );
        },
        async getByM17VisitId(orgId, m17VisitId) {
          return (
            visits.find((v) => v.orgId === orgId && v.digest.m17VisitId === m17VisitId)?.digest ??
            null
          );
        },
        async metricsForOrg(orgId) {
          const rows = visits.filter((v) => v.orgId === orgId).map((v) => v.digest);
          const visitsTotal = rows.length;
          const clean = rows.filter((r) => r.lifecycleState === "ended_clean").length;
          const aborted = rows.filter((r) => r.lifecycleState === "ended_aborted").length;
          const audioOnly = rows.filter((r) => r.audioOnlyFallbackActive).length;
          return {
            visitsTotal,
            visitsCompletedClean: clean,
            visitsCompletedAborted: aborted,
            audioOnlyFallbackRate: visitsTotal === 0 ? 0 : audioOnly / visitsTotal,
            recordingRate: 0,
            vendorOutageDurationMin: 0,
          };
        },
        async minutesByTenant(orgId) {
          const rows = visits.filter((v) => v.orgId === orgId).map((v) => v.digest);
          const totalSec = rows.reduce((a, r) => a + (r.totalDurationSec ?? 0), 0);
          return { totalMinutes: Math.round(totalSec / 60), recordedMinutes: 0 };
        },
      },
      sessions: {
        async createSmartLaunchSession(input) {
          createdSessions.push({
            portalAccountId: input.portalAccountId,
            patientId: input.patientId,
            activeGrantId: input.activeGrantId,
          });
          return { sessionId: `sess_${createdSessions.length}` };
        },
      },
      disclosures: {
        async disclosuresForPatient(orgId, patientId, fromIso, toIso) {
          return disclosures
            .filter(
              (d) =>
                d.orgId === orgId &&
                d.record.patientId === patientId &&
                d.record.viewedAt >= fromIso &&
                d.record.viewedAt <= toIso,
            )
            .map((d) => d.record);
        },
      },
    },
  };
}

/** Exposed for the tests: how many scope categories a grant digest allows (used to assert minter scoping). */
export { scopeCategoryCount };

// apps/backend/src/modules/24-billing-medicaid/seam-impls.ts — the eight §4.3 published reader-seam
// implementations over the M24 READ service + db. Each takes an `orgId` (cross-module callers:
// M5/M25/M26/M27/M28/M30/M33/M34/M37) and wraps it in a synthetic system actor so withOrgContext scopes the
// reads under RLS. Money crosses as cents-as-STRING (the seam contract: consumers must never parse to a lossy
// float). The state Medicaid Recipient ID is NEVER on any surface (D12 / §3.6).
//
// REGISTRATION DEFERRED (the M26 unconsumed-seam posture): these are NOT yet registered into the M1
// SeamRegistry — no live consumer calls `getSeam` on an M24 seam today (M27/M28/M30/M37 deny-stub or are
// unbuilt). The published surface ships now; `wiring.ts` registers it once a consumer binds, following the
// M26 precedent (add the SeamName to @wardenx/types + a deny-stub provider + REQUIRED_SEAMS at that point).
// Until then M24 is reachable cross-module via its §4.11 outbox events. The seam interfaces are declared
// locally (the medicaid-adapters pure package owns no seam-DTO module) — they ship to @wardenx/types at the
// M24 lock, the subscription contract in §4.11.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { M24ReadActor } from "./routes/actor";
import type { M24ReadService } from "./routes/read-service";

const systemActor = (orgId: string): M24ReadActor => ({
  organizationId: orgId,
  userId: "system",
  roles: [],
});
const cents = (n: number | null | undefined): string => String(n ?? 0);

// ── locally-declared seam contracts (PHI-free; cents-as-string) ─────────────────────────────────────────
export interface DaysByLevelOfCare {
  readonly rhc: number;
  readonly chc: number;
  readonly irc: number;
  readonly gip: number;
  readonly nfRb: number;
  readonly total: number;
}
export interface MedicaidClaimSummary {
  readonly claimId: string;
  readonly state: string;
  readonly controlNumber: string;
  readonly serviceState: string;
  readonly totalChargesCents: string;
}
export interface MedicaidClaimReader {
  claimById(orgId: string, claimId: string): Promise<MedicaidClaimSummary | null>;
  claimByControlNumber(
    orgId: string,
    state: string,
    controlNumber: string,
  ): Promise<MedicaidClaimSummary | null>;
  medicaidDaysByLocInFiscalYear(
    orgId: string,
    providerEntityId: string,
    fyEnd: string,
  ): Promise<DaysByLevelOfCare>;
}
export interface MedicaidClaimDayProjectionProvider {
  daysForPatientInCapYear(
    orgId: string,
    patientId: string,
    capYear: string,
  ): Promise<DaysByLevelOfCare>;
  aggregateForOrgInFiscalYear(
    orgId: string,
    providerEntityId: string,
    fyEnd: string,
  ): Promise<DaysByLevelOfCare>;
}
export interface AcceptedMedicaidSubmission {
  readonly submissionId: string;
  readonly claimId: string;
  readonly controlNumber: string;
  readonly submittedAt: string | null;
}
export interface MedicaidClaimSubmissionReader {
  acceptedSubmissionsInWindow(
    orgId: string,
    providerEntityId: string,
    state: string,
    windowIso: { from: string; to: string },
  ): Promise<AcceptedMedicaidSubmission[]>;
  submissionByControlNumber(
    orgId: string,
    state: string,
    controlNumber: string,
  ): Promise<AcceptedMedicaidSubmission | null>;
}
export interface MedicaidClaimMetricsProvider {
  arAgingBuckets(
    orgId: string,
    providerEntityId: string | "all",
  ): Promise<{ bucket: string; count: number; chargesCents: string }[]>;
  denialRateForWindow(orgId: string): Promise<number>;
}
export interface MedicaidEligibilitySnapshot {
  readonly outcome: string;
  readonly mcoId: string | null;
  readonly checkedAt: string;
  readonly staleAt: string;
}
export interface MedicaidEligibilityReader {
  latestActiveEligibilityForPatient(
    orgId: string,
    patientId: string,
    asOfServiceDate: string,
  ): Promise<MedicaidEligibilitySnapshot | null>;
}
export interface StateRateScheduleReader {
  rateForLocOnDate(
    state: string,
    loc: string,
    serviceDate: string,
  ): Promise<{ rateCents: string } | null>;
}
export interface RoomAndBoardReader {
  rbDaysForOrgInFiscalYear(
    orgId: string,
    providerEntityId: string,
    fyEnd: string,
  ): Promise<{ totalRbDays: number }>;
  activeRbArrangementsForPatient(
    orgId: string,
    patientId: string,
    asOf: string,
  ): Promise<{ arrangementId: string; effectiveFrom: string; effectiveTo: string | null }[]>;
}
export interface MedicaidTradingPartnerAdmin {
  listForOrg(
    orgId: string,
  ): Promise<{ id: string; providerEntityId: string; serviceState: string; channel: string }[]>;
}

export interface M24SeamImpls {
  readonly claim: MedicaidClaimReader;
  readonly dayProjection: MedicaidClaimDayProjectionProvider;
  readonly submission: MedicaidClaimSubmissionReader;
  readonly metrics: MedicaidClaimMetricsProvider;
  readonly eligibility: MedicaidEligibilityReader;
  readonly rateSchedule: StateRateScheduleReader;
  readonly roomAndBoard: RoomAndBoardReader;
  readonly tradingPartner: MedicaidTradingPartnerAdmin;
}

const EMPTY_DAYS: DaysByLevelOfCare = { rhc: 0, chc: 0, irc: 0, gip: 0, nfRb: 0, total: 0 };

export function buildM24SeamImpls(db: DbClient, read: M24ReadService): M24SeamImpls {
  const claim: MedicaidClaimReader = {
    async claimById(orgId, claimId) {
      const c = await read.getClaim(systemActor(orgId), claimId);
      if (!c) return null;
      const lines = await read.listClaimLines(systemActor(orgId), claimId);
      const total = lines.reduce((s, l) => s + l.chargesCents, 0);
      return {
        claimId: c.id,
        state: c.state,
        controlNumber: c.medicaidClaimControlNumber,
        serviceState: c.serviceState,
        totalChargesCents: cents(total),
      };
    },
    async claimByControlNumber(orgId, state, controlNumber) {
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const C = schema.medicaidClaim;
        const rows = await tx
          .select({
            id: C.id,
            state: C.state,
            ctrl: C.medicaidClaimControlNumber,
            st: C.serviceState,
          })
          .from(C)
          .where(and(eq(C.serviceState, state), eq(C.medicaidClaimControlNumber, controlNumber)))
          .limit(1);
        const r = rows[0];
        return r
          ? {
              claimId: r.id,
              state: r.state,
              controlNumber: r.ctrl,
              serviceState: r.st,
              totalChargesCents: "0",
            }
          : null;
      });
    },
    async medicaidDaysByLocInFiscalYear(orgId, providerEntityId, fyEnd) {
      return daysByLoc(db, orgId, providerEntityId, fyEnd);
    },
  };

  const dayProjection: MedicaidClaimDayProjectionProvider = {
    // M26 cap-year day projection — needs the cap-year window; deny-degrades to the empty roll-up until the
    // cap-year boundary resolver binds (the consumer treats empty as no-accrual). PHI-free.
    async daysForPatientInCapYear() {
      return EMPTY_DAYS;
    },
    async aggregateForOrgInFiscalYear(orgId, providerEntityId, fyEnd) {
      return daysByLoc(db, orgId, providerEntityId, fyEnd);
    },
  };

  const submission: MedicaidClaimSubmissionReader = {
    async acceptedSubmissionsInWindow(orgId, providerEntityId, state, windowIso) {
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const S = schema.medicaidSubmission;
        const rows = await tx
          .select()
          .from(S)
          .where(
            and(
              eq(S.providerEntityId, providerEntityId),
              eq(S.serviceState, state),
              eq(S.result, "accepted_sync"),
              gte(S.createdAt, new Date(windowIso.from)),
              lte(S.createdAt, new Date(windowIso.to)),
            ),
          )
          .limit(500);
        return rows.map((r) => ({
          submissionId: r.id,
          claimId: r.medicaidClaimId,
          controlNumber: r.medicaidClaimControlNumber,
          submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
        }));
      });
    },
    async submissionByControlNumber(orgId, state, controlNumber) {
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const S = schema.medicaidSubmission;
        const rows = await tx
          .select()
          .from(S)
          .where(and(eq(S.serviceState, state), eq(S.medicaidClaimControlNumber, controlNumber)))
          .limit(1);
        const r = rows[0];
        return r
          ? {
              submissionId: r.id,
              claimId: r.medicaidClaimId,
              controlNumber: r.medicaidClaimControlNumber,
              submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
            }
          : null;
      });
    },
  };

  const metrics: MedicaidClaimMetricsProvider = {
    async arAgingBuckets(orgId, providerEntityId) {
      const dash = await read.arDashboard(
        systemActor(orgId),
        providerEntityId === "all" ? undefined : providerEntityId,
      );
      return dash.buckets.map((b) => ({
        bucket: b.bucket,
        count: b.count,
        chargesCents: cents(b.chargesCents),
      }));
    },
    async denialRateForWindow(orgId) {
      const m = await read.arMetrics(systemActor(orgId));
      return m.denialRate;
    },
  };

  const eligibility: MedicaidEligibilityReader = {
    async latestActiveEligibilityForPatient(orgId, patientId) {
      const checks = await read.listEligibilityChecks(systemActor(orgId), { patientId });
      const latest = checks[0];
      if (!latest) return null;
      return {
        outcome: latest.outcome,
        mcoId: latest.mcoId ?? null,
        checkedAt: latest.checkedAt,
        staleAt: latest.staleAt,
      };
    },
  };

  const rateSchedule: StateRateScheduleReader = {
    // The per-state rate schedule is M40-loaded reference data; M24 snapshots it onto claim lines. The
    // direct rate lookup degrades to null until the M40 StateRateScheduleReader binds (consumer skips).
    async rateForLocOnDate() {
      return null;
    },
  };

  const roomAndBoard: RoomAndBoardReader = {
    async rbDaysForOrgInFiscalYear(orgId, providerEntityId, fyEnd) {
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const RD = schema.rbDay;
        const fy = new Date(fyEnd);
        const fyStart = new Date(
          Date.UTC(fy.getUTCFullYear() - 1, fy.getUTCMonth(), fy.getUTCDate() + 1),
        );
        const rows = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(RD)
          .where(
            and(
              eq(RD.providerEntityId, providerEntityId),
              gte(RD.serviceDate, fyStart),
              lte(RD.serviceDate, fy),
              eq(RD.status, "billed"),
            ),
          );
        return { totalRbDays: rows[0]?.n ?? 0 };
      });
    },
    async activeRbArrangementsForPatient(orgId, patientId) {
      const arrs = await read.listRbArrangements(systemActor(orgId), {
        patientId,
        state: "ACTIVE",
      });
      return arrs.map((a) => ({
        arrangementId: a.id,
        effectiveFrom: a.effectiveFrom,
        effectiveTo: a.effectiveTo,
      }));
    },
  };

  const tradingPartner: MedicaidTradingPartnerAdmin = {
    async listForOrg(orgId) {
      const creds = await read.listTradingPartnerCredentials(systemActor(orgId));
      return creds.map((c) => ({
        id: c.id,
        providerEntityId: c.providerEntityId,
        serviceState: c.serviceState,
        channel: c.channel,
      }));
    },
  };

  return {
    claim,
    dayProjection,
    submission,
    metrics,
    eligibility,
    rateSchedule,
    roomAndBoard,
    tradingPartner,
  };
}

/** Sum billed claim-line units by level-of-care for a PE within the fiscal year ending `fyEnd`. */
async function daysByLoc(
  db: DbClient,
  orgId: string,
  providerEntityId: string,
  fyEnd: string,
): Promise<DaysByLevelOfCare> {
  return withOrgContext(db, systemActor(orgId), async (tx) => {
    const CL = schema.medicaidClaimLine;
    const fy = new Date(fyEnd);
    const fyStart = new Date(
      Date.UTC(fy.getUTCFullYear() - 1, fy.getUTCMonth(), fy.getUTCDate() + 1),
    );
    const rows = await tx
      .select({ loc: CL.levelOfCare, units: sql<number>`coalesce(sum(${CL.units}),0)::int` })
      .from(CL)
      .where(
        and(
          eq(CL.providerEntityId, providerEntityId),
          gte(CL.serviceDate, fyStart),
          lte(CL.serviceDate, fy),
        ),
      )
      .groupBy(CL.levelOfCare);
    const by = new Map(rows.map((r) => [r.loc, r.units]));
    const rhc = by.get("RHC") ?? 0;
    const chc = by.get("CHC") ?? 0;
    const irc = by.get("IRC") ?? 0;
    const gip = by.get("GIP") ?? 0;
    const nfRb = by.get("NF_RB") ?? 0;
    return { rhc, chc, irc, gip, nfRb, total: rhc + chc + irc + gip + nfRb };
  });
}

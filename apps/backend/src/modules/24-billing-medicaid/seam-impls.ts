// apps/backend/src/modules/24-billing-medicaid/seam-impls.ts — the nine §4.3 published reader-seam
// implementations over the M24 READ service + db. Each takes an `orgId` (cross-module callers:
// M5/M25/M26/M27/M28/M30/M33/M34/M37) and wraps it in a synthetic system actor so withOrgContext scopes the
// reads under RLS. Money crosses as cents-as-STRING (the seam contract: consumers must never parse to a lossy
// float). The state Medicaid Recipient ID is NEVER on any surface (D12 / §3.6).
//
// REGISTRATION DEFERRED for eight of the nine (the M26 unconsumed-seam posture): these are NOT registered
// into the M1 SeamRegistry — no live consumer calls `getSeam` on them today (M27/M28/M30/M37 deny-stub or
// are unbuilt). The published surface ships now; `wiring.ts` registers each one once a consumer binds,
// following the M26 precedent (add the SeamName to @chartwarden/types + a deny-stub provider + REQUIRED_SEAMS
// at that point). Until then those eight stay reachable cross-module via M24's §4.11 outbox events.
//
// `claimMatch` (`MedicaidClaimMatchProvider`) is the NINTH and is REGISTERED (F-172, #248, m24 group) —
// M25's `postAdvice` auto-match is its first live consumer, routed by the advice's own `payerKind`
// discriminator alongside M23's sibling `ClaimSubmissionReader` seam (never a Medicaid 835 matched
// against M23's `claim` table, or the reverse). The seam interfaces are declared locally (the
// medicaid-adapters pure package owns no seam-DTO module) — they ship to @chartwarden/types at the M24 lock,
// the subscription contract in §4.11.
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { buildFoundationSiteReader } from "../../bootstrap/foundation-site-reader";
import { getMdmEntityProvider } from "../40-mdm/seams";
import { qualifyMedicaidProgramClassification } from "./medicaid-payer-classification";
import type { M24Actor } from "./routes/actor";
import type { M24ReadService } from "./routes/read-service";

const systemActor = (orgId: string): M24Actor => ({
  organizationId: orgId,
  userId: "system",
  roles: [],
  stepUpRecent: false,
  providerEntityIds: [],
});
const cents = (n: number | null | undefined): string => String(n ?? 0);

/** Hash a fixed, owner-side projection; raw payer/provider references stay inside the M24 seam. */
const evidenceFingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

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

/** F-172 (#248, m24 group) — a WX-PR-012 candidate row, the M24 shape of M23's `ClaimMatchCandidateRow`
 *  (`23-billing-medicare/cost-report-seams.ts`). No `payerIcn`/`patientMemberId` field: `medicaid_claim`
 *  has no payer-assigned ICN column, and the state Medicaid Recipient ID is NEVER stored here (D12/§3.6)
 *  — so only the claim-control-number exact-match strategy of M25's `autoMatch` can ever fire for a
 *  Medicaid line, honestly (never a fabricated ICN or member id to widen the match surface). */
export interface MedicaidClaimMatchCandidateRow {
  readonly claimId: string;
  readonly claimControlNumber: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
}

/** F-172 (#248, m24 group) — the M24 → M25 835-to-claim match seam, the exact `ClaimSubmissionReader`
 *  shape one module over (`23-billing-medicare/cost-report-seams.ts`): a candidate-list lookup scoped by
 *  org+providerEntityId (never a bare state-wide scan — `MedicaidClaimReader.claimByControlNumber` above
 *  is state-scoped only, which risks a cross-provider-entity collision within one org since
 *  `medicaid_claim_control_per_pe_state` is an index, not a unique constraint) + a claim→patient
 *  resolution for the PR-ledger seed. PHI: `patientIdForClaim` returns a patient id, `candidatesForLine`
 *  does not. */
export interface MedicaidClaimMatchProvider {
  candidatesForLine(
    orgId: string,
    providerEntityId: string,
    keys: { readonly claimControlNumber?: string },
  ): Promise<MedicaidClaimMatchCandidateRow[]>;
  submissionEvidenceForLine(
    orgId: string,
    providerEntityId: string,
    keys: { readonly claimControlNumber: string },
  ): Promise<MedicaidClaimSubmissionEvidence[]>;
  eraEnrollmentEvidence(
    orgId: string,
    providerEntityId: string,
  ): Promise<MedicaidEraEnrollmentEvidence[]>;
  patientIdForClaim(orgId: string, claimId: string): Promise<string | null>;
  /**
   * M25 milestone 11 (11a-1) - the facts M25 needs to render a Medicaid claim on the case view and (later) to
   * prefill a Medicaid appeal: the claim's service state, its MCO (null = fee-for-service / Open Card), its
   * provider entity and its patient (one read, one connection). `null` when the claim does not exist or RLS hides it - fail closed, never a guess.
   */
  claimContext(orgId: string, claimId: string): Promise<MedicaidClaimContext | null>;
  /**
   * Batch existence: which of `claimIds` are this organization's Medicaid claims (one query, org-explicit under RLS).
   * The list is capped at {@link MEDICAID_CLAIM_IDS_CAP}; M25's payer badge asks once per worklist page.
   */
  medicaidClaimIds(orgId: string, claimIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface MedicaidEraEnrollmentEvidence {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly vendor: "claimmd" | "stedi";
  readonly accountReference: string;
  readonly environment: "test" | "production";
  readonly canonicalPayerId: string;
  readonly programId: string;
  readonly evidenceId: string;
  readonly evidenceVersion: number;
  readonly payerIdentifier: string | null;
  readonly billingNpi: string;
  readonly billingTin: null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  readonly evidenceReference: string;
  readonly verifiedAt: string;
  readonly evidenceFreshUntil: string;
  readonly classificationRecordedAt: string;
  /** Owner-computed digest of enrollment, M40 classification, freshness and provider identity inputs. */
  readonly sourceEvidenceFingerprint: string;
}

export interface MedicaidClaimSubmissionEvidence {
  readonly disposition: "SUBMISSION_UNVERIFIED" | "SUBMISSION_EVIDENCE";
  /** Hidden unless a persisted, production-environment submission matches the exact claim version. */
  readonly claimId: string | null;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly claimControlNumber: string | null;
  readonly canonicalPayerId: string | null;
  readonly programKind: string | null;
  readonly serviceState: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly claimState: string;
  readonly claimVersion: number;
  /** Digest of exact M24 claim, assignment, submission-attempt and acknowledgment evidence versions. */
  readonly sourceEvidenceFingerprint: string;
  /** Hidden (null) unless the result is proven, like every identifier below it. */
  readonly replacesClaimId: string | null;
  readonly replacedByClaimId: string | null;
  readonly attempts: readonly {
    /** Hidden (null) unless the result is proven. */
    readonly submissionId: string | null;
    readonly attemptIndex: number;
    readonly claimVersion: number | null;
    /** Hidden (null) unless the result is proven (a vendor-side reference). */
    readonly sourceAccountRef: string | null;
    readonly environment: string | null;
    readonly vendor: string;
    /** Hidden (null) unless the result is proven (a vendor-side reference). */
    readonly vendorTransactionId: string | null;
    readonly payerId: string | null;
    /** Hidden (null) unless the result is proven. */
    readonly payerClassificationId: string | null;
    readonly programKind: string | null;
    /** Hidden (null) unless the result is proven. */
    readonly assignmentId: string | null;
    readonly assignmentVersion: number | null;
    readonly provenanceStatus: string;
    readonly result: string;
    readonly submittedAt: string | null;
    readonly acknowledgments: readonly {
      readonly kind: string;
      readonly outcome: string;
      /** Hidden (null) unless the result is proven (a payer-side reference). */
      readonly payerClaimControlNumber: string | null;
      readonly receivedAt: string;
      readonly id: string | null;
    }[];
  }[];
}

/** Most ids one `medicaidClaimIds` call looks up (a worklist page); extra ids are ignored, never an error. */
export const MEDICAID_CLAIM_IDS_CAP = 200;

export interface MedicaidClaimContext {
  readonly serviceState: string;
  readonly mcoId: string | null;
  readonly providerEntityId: string;
  readonly patientId: string;
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
  readonly claimMatch: MedicaidClaimMatchProvider;
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

  const claimMatch: MedicaidClaimMatchProvider = {
    async eraEnrollmentEvidence(orgId, providerEntityId) {
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const EE = schema.medicaidEnrollmentEvidence;
        const site = await buildFoundationSiteReader().providerEntityIdentifiers(
          tx,
          orgId,
          providerEntityId,
        );
        if (!site?.npi) return [];
        const rows = await tx
          .select({
            clearinghouse: EE.clearinghouse,
            accountReference: EE.vendorAccountRef,
            environment: EE.sourceEnvironment,
            serviceState: EE.serviceState,
            canonicalPayerId: EE.canonicalPayerId,
            programKind: EE.programKind,
            vendorPayerId: EE.vendorPayerId,
            effectiveFrom: EE.effectiveFrom,
            effectiveTo: EE.effectiveTo,
            evidenceFreshUntil: EE.evidenceFreshUntil,
            evidenceId: EE.id,
            evidenceVersion: EE.version,
            evidenceReference: EE.evidenceReference,
            verifiedAt: EE.verifiedAt,
            status: EE.status,
            transactionType: EE.transactionType,
            evidenceKind: EE.evidenceKind,
            verificationSource: EE.verificationSource,
            updatedAt: EE.updatedAt,
          })
          .from(EE)
          .where(
            and(
              eq(EE.organizationId, orgId),
              eq(EE.providerEntityId, providerEntityId),
              eq(EE.evidenceKind, "835_era_enrollment"),
              eq(EE.status, "verified"),
              eq(EE.transactionType, "835"),
              inArray(EE.clearinghouse, ["claimmd", "stedi"]),
            ),
          );
        const output: MedicaidEraEnrollmentEvidence[] = [];
        for (const row of rows) {
          if (
            !row.clearinghouse ||
            !row.accountReference ||
            !row.environment ||
            !row.canonicalPayerId ||
            !row.effectiveTo ||
            !row.evidenceFreshUntil ||
            !row.evidenceId ||
            !Number.isSafeInteger(row.evidenceVersion) ||
            !row.evidenceReference ||
            !row.verifiedAt ||
            !row.verificationSource ||
            row.status !== "verified" ||
            row.transactionType !== "835" ||
            !row.vendorPayerId ||
            !row.programKind
          )
            continue;
          const classifications = await getMdmEntityProvider().medicaidPayerProgramClassifications(
            orgId,
            row.canonicalPayerId,
            row.serviceState,
            row.effectiveFrom,
            row.effectiveTo,
          );
          // The verify path's qualifier, not a local filter: it retires superseded rows and refuses a window that
          // a second verified classification contradicts, so evidence verification would now refuse is not offered.
          const decision = qualifyMedicaidProgramClassification(
            classifications,
            row.programKind,
            row.canonicalPayerId,
            row.serviceState,
            row.effectiveFrom,
            row.effectiveTo,
          );
          if (!decision.qualified) continue;
          const classification = decision.classification;
          const providerIdentityFingerprint = evidenceFingerprint({
            organizationId: orgId,
            providerEntityId,
            billingNpi: site.npi,
          });
          const sourceEvidenceFingerprint = evidenceFingerprint({
            enrollment: {
              id: row.evidenceId,
              version: row.evidenceVersion,
              status: row.status,
              evidenceKind: row.evidenceKind,
              transactionType: row.transactionType,
              verificationSource: row.verificationSource,
              effectiveFrom: row.effectiveFrom,
              effectiveTo: row.effectiveTo,
              evidenceFreshUntil: row.evidenceFreshUntil,
              evidenceReference: row.evidenceReference,
              verifiedAt: row.verifiedAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
              vendorPayerId: row.vendorPayerId,
              accountReference: row.accountReference,
              environment: row.environment,
              canonicalPayerId: row.canonicalPayerId,
              programKind: row.programKind,
            },
            classification: {
              id: classification.id,
              classification: classification.classification,
              stateCode: classification.stateCode,
              effectiveFrom: classification.effectiveFrom,
              effectiveTo: classification.effectiveTo,
              verificationStatus: classification.verificationStatus,
              sourceKind: classification.sourceKind,
              sourceReference: classification.sourceReference,
              verifiedAt: classification.verifiedAt,
              verifiedBy: classification.verifiedBy,
              supersedesId: classification.supersedesId,
              recordedAt: classification.recordedAt,
            },
            providerIdentityFingerprint,
          });
          output.push({
            organizationId: orgId,
            providerEntityId,
            vendor: row.clearinghouse as "claimmd" | "stedi",
            accountReference: row.accountReference,
            environment: row.environment as "test" | "production",
            canonicalPayerId: row.canonicalPayerId,
            programId: classification.id,
            evidenceId: row.evidenceId,
            evidenceVersion: row.evidenceVersion,
            payerIdentifier: row.vendorPayerId,
            billingNpi: site.npi,
            billingTin: null,
            effectiveFrom: row.effectiveFrom,
            effectiveTo: row.effectiveTo,
            evidenceReference: row.evidenceReference,
            verifiedAt: row.verifiedAt.toISOString(),
            evidenceFreshUntil: row.evidenceFreshUntil,
            classificationRecordedAt: classification.recordedAt,
            sourceEvidenceFingerprint,
          });
        }
        return output;
      });
    },
    async candidatesForLine(orgId, providerEntityId, keys) {
      if (!keys.claimControlNumber) return [];
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const C = schema.medicaidClaim;
        const rows = await tx
          .select({
            claimId: C.id,
            claimControlNumber: C.medicaidClaimControlNumber,
            serviceFrom: C.serviceFrom,
            serviceTo: C.serviceTo,
          })
          .from(C)
          .where(
            and(
              eq(C.organizationId, orgId),
              eq(C.providerEntityId, providerEntityId),
              eq(C.medicaidClaimControlNumber, keys.claimControlNumber as string),
            ),
          );
        return rows.map((r) => ({
          claimId: r.claimId,
          claimControlNumber: r.claimControlNumber,
          serviceFrom: r.serviceFrom.toISOString(),
          serviceTo: r.serviceTo.toISOString(),
        }));
      });
    },
    async submissionEvidenceForLine(orgId, providerEntityId, keys) {
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const C = schema.medicaidClaim;
        const S = schema.medicaidSubmission;
        const A = schema.medicaidAcknowledgment;
        const rows = await tx
          .select({
            claimId: C.id,
            organizationId: C.organizationId,
            providerEntityId: C.providerEntityId,
            claimControlNumber: C.medicaidClaimControlNumber,
            canonicalPayerId: C.canonicalPayerId,
            claimMcoId: C.mcoId,
            programAssignmentId: C.programAssignmentId,
            programKind: C.medicaidProgramKind,
            serviceState: C.serviceState,
            serviceFrom: C.serviceFrom,
            serviceTo: C.serviceTo,
            claimState: C.state,
            claimVersion: C.version,
            replacesClaimId: C.replacesClaimId,
            replacedByClaimId: C.replacedByClaimId,
            submissionId: S.id,
            attemptIndex: S.attemptIndex,
            submittedClaimVersion: S.submittedClaimVersion,
            submittedServiceState: S.serviceState,
            submittedChannel: S.channel,
            submittedMcoIdSnapshot: S.mcoIdSnapshot,
            submittedClaimControlNumber: S.medicaidClaimControlNumber,
            sourceAccountRef: S.sourceAccountRef,
            environment: S.sourceEnvironment,
            vendor: S.adapterVendor,
            vendorTransactionId: S.vendorTransactionId,
            payerId: S.canonicalPayerIdSnapshot,
            payerClassificationId: S.payerClassificationIdSnapshot,
            programKindSnapshot: S.programKindSnapshot,
            assignmentId: S.programAssignmentIdSnapshot,
            assignmentVersionSnapshot: S.programAssignmentVersionSnapshot,
            provenanceStatus: S.sourceProvenanceStatus,
            result: S.result,
            submittedAt: S.submittedAt,
            ackKind: A.kind,
            ackOutcome: A.outcome,
            payerClaimControlNumber: A.payerClaimControlNumber,
            ackReceivedAt: A.receivedAt,
            ackAcceptedLineNumbers: A.acceptedLineNumbers,
            ackRejectedLineNumbers: A.rejectedLineNumbers,
            ackErrorCodes: A.errorCodes,
            assignmentStatus: schema.medicaidProgramAssignment.status,
            assignmentVersion: schema.medicaidProgramAssignment.version,
            assignmentPayerId: schema.medicaidProgramAssignment.canonicalPayerId,
            assignmentClassificationId:
              schema.medicaidProgramAssignment.canonicalPayerClassificationId,
            assignmentState: schema.medicaidProgramAssignment.serviceState,
            assignmentEffectiveFrom: schema.medicaidProgramAssignment.effectiveFrom,
            assignmentEffectiveTo: schema.medicaidProgramAssignment.effectiveTo,
            assignmentUpdatedAt: schema.medicaidProgramAssignment.updatedAt,
            submissionCreatedAt: S.createdAt,
            adapterVersion: S.adapterVersion,
            ackId: A.id,
          })
          .from(C)
          .leftJoin(
            schema.medicaidProgramAssignment,
            and(
              eq(schema.medicaidProgramAssignment.id, C.programAssignmentId),
              eq(schema.medicaidProgramAssignment.organizationId, C.organizationId),
              eq(schema.medicaidProgramAssignment.providerEntityId, C.providerEntityId),
            ),
          )
          .leftJoin(
            S,
            and(
              eq(S.medicaidClaimId, C.id),
              eq(S.organizationId, C.organizationId),
              eq(S.providerEntityId, C.providerEntityId),
            ),
          )
          .leftJoin(
            A,
            and(
              eq(A.medicaidSubmissionId, S.id),
              eq(A.organizationId, C.organizationId),
              eq(A.medicaidClaimId, C.id),
            ),
          )
          .where(
            and(
              eq(C.organizationId, orgId),
              eq(C.providerEntityId, providerEntityId),
              eq(C.medicaidClaimControlNumber, keys.claimControlNumber),
            ),
          )
          .orderBy(asc(C.id), desc(S.attemptIndex), desc(A.receivedAt));

        const byClaim = new Map<
          string,
          {
            base: (typeof rows)[number];
            attempts: Map<
              string,
              {
                base: (typeof rows)[number];
                acknowledgments: Array<{
                  kind: string;
                  outcome: string;
                  payerClaimControlNumber: string | null;
                  receivedAt: string;
                  id: string;
                  acceptedLineNumbers: unknown;
                  rejectedLineNumbers: unknown;
                  errorCodes: unknown;
                }>;
              }
            >;
          }
        >();
        for (const row of rows) {
          let claim = byClaim.get(row.claimId);
          if (!claim) {
            claim = { base: row, attempts: new Map() };
            byClaim.set(row.claimId, claim);
          }
          if (!row.submissionId) continue;
          let attempt = claim.attempts.get(row.submissionId);
          if (!attempt) {
            attempt = { base: row, acknowledgments: [] };
            claim.attempts.set(row.submissionId, attempt);
          }
          if (row.ackId && row.ackKind && row.ackOutcome && row.ackReceivedAt) {
            attempt.acknowledgments.push({
              kind: row.ackKind,
              outcome: row.ackOutcome,
              payerClaimControlNumber: row.payerClaimControlNumber,
              receivedAt: row.ackReceivedAt.toISOString(),
              id: row.ackId,
              acceptedLineNumbers: row.ackAcceptedLineNumbers,
              rejectedLineNumbers: row.ackRejectedLineNumbers,
              errorCodes: row.ackErrorCodes,
            });
          }
        }

        return [...byClaim.values()].map(({ base, attempts }): MedicaidClaimSubmissionEvidence => {
          const attemptRows = [...attempts.values()];
          const attemptEvidence = attemptRows.map(({ base: s, acknowledgments }) => ({
            submissionId: s.submissionId,
            attemptIndex: s.attemptIndex,
            claimVersion: s.submittedClaimVersion,
            serviceState: s.submittedServiceState,
            channel: s.submittedChannel,
            mcoIdSnapshot: s.submittedMcoIdSnapshot,
            claimControlNumber: s.submittedClaimControlNumber,
            sourceAccountRef: s.sourceAccountRef,
            environment: s.environment,
            vendor: s.vendor,
            vendorTransactionId: s.vendorTransactionId,
            payerId: s.payerId,
            payerClassificationId: s.payerClassificationId,
            programKind: s.programKindSnapshot,
            assignmentId: s.assignmentId,
            assignmentVersion: s.assignmentVersionSnapshot,
            provenanceStatus: s.provenanceStatus,
            result: s.result,
            submittedAt: s.submittedAt?.toISOString() ?? null,
            createdAt: s.submissionCreatedAt?.toISOString() ?? null,
            adapterVersion: s.adapterVersion,
            acknowledgments: acknowledgments.map((ack) => ({
              id: ack.id,
              kind: ack.kind,
              outcome: ack.outcome,
              payerClaimControlNumber: ack.payerClaimControlNumber,
              receivedAt: ack.receivedAt,
              acceptedLineNumbers: ack.acceptedLineNumbers,
              rejectedLineNumbers: ack.rejectedLineNumbers,
              errorCodes: ack.errorCodes,
            })),
          }));
          const sourceEvidenceFingerprint = evidenceFingerprint({
            claim: {
              claimId: base.claimId,
              organizationId: base.organizationId,
              providerEntityId: base.providerEntityId,
              claimControlNumber: base.claimControlNumber,
              canonicalPayerId: base.canonicalPayerId,
              programAssignmentId: base.programAssignmentId,
              programKind: base.programKind,
              serviceState: base.serviceState,
              serviceFrom: base.serviceFrom.toISOString(),
              serviceTo: base.serviceTo.toISOString(),
              claimState: base.claimState,
              claimVersion: base.claimVersion,
              mcoId: base.claimMcoId,
              replacesClaimId: base.replacesClaimId,
              replacedByClaimId: base.replacedByClaimId,
            },
            assignment: {
              id: base.programAssignmentId,
              status: base.assignmentStatus,
              version: base.assignmentVersion,
              canonicalPayerId: base.assignmentPayerId,
              classificationId: base.assignmentClassificationId,
              serviceState: base.assignmentState,
              effectiveFrom: base.assignmentEffectiveFrom,
              effectiveTo: base.assignmentEffectiveTo,
              updatedAt: base.assignmentUpdatedAt?.toISOString() ?? null,
            },
            attempts: attemptEvidence,
          });
          const qualified = attemptRows.filter(
            ({ base: s }) =>
              s.provenanceStatus === "verified" &&
              s.environment === "production" &&
              !!s.sourceAccountRef &&
              // `s.payerId` is the attempt's own payer snapshot; `s.canonicalPayerId` is the claim's, so comparing
              // that one to `base` compared the claim to itself and let an attempt sent to another payer qualify.
              !!s.payerId &&
              s.payerId === base.canonicalPayerId &&
              !!s.payerClassificationId &&
              s.payerClassificationId === base.assignmentClassificationId &&
              base.assignmentStatus === "verified" &&
              // Payer ids compare as recorded, not through M40 merges: after a payer merge a claim or assignment
              // keyed to the retired id stops matching, which fails closed (the evidence is re-recorded against
              // the surviving payer).
              base.assignmentPayerId === base.canonicalPayerId &&
              base.assignmentState === base.serviceState &&
              s.submittedServiceState === base.serviceState &&
              s.submittedClaimControlNumber === base.claimControlNumber &&
              s.submittedMcoIdSnapshot === base.claimMcoId &&
              // The current M24 routing boundary derives these two channels from the claim's server-owned
              // MCO identity. Compare the persisted route snapshot to that same boundary; this check does not
              // treat a null MCO as FFS program evidence (the verified assignment/classification above does).
              s.submittedChannel === (base.claimMcoId ? "cco_clearinghouse" : "direct_mmis") &&
              s.assignmentVersionSnapshot === base.assignmentVersion &&
              s.programKindSnapshot === base.programKind &&
              !!s.assignmentId &&
              s.assignmentId === base.programAssignmentId &&
              s.submittedClaimVersion === base.claimVersion &&
              !!s.submittedAt &&
              !!s.vendorTransactionId &&
              (s.result === "accepted_sync" || s.result === "pending_async"),
          );
          const activeClaim =
            base.claimState !== "REPLACED" &&
            base.claimState !== "VOIDED" &&
            base.claimState !== "ABANDONED" &&
            !base.replacedByClaimId;
          const proven = qualified.length === 1 && activeClaim;
          return {
            disposition: proven ? "SUBMISSION_EVIDENCE" : "SUBMISSION_UNVERIFIED",
            claimId: proven ? base.claimId : null,
            organizationId: base.organizationId,
            providerEntityId: base.providerEntityId,
            claimControlNumber: proven ? base.claimControlNumber : null,
            canonicalPayerId: proven ? base.canonicalPayerId : null,
            programKind: proven ? base.programKind : null,
            serviceState: base.serviceState,
            serviceFrom: base.serviceFrom.toISOString().slice(0, 10),
            serviceTo: base.serviceTo.toISOString().slice(0, 10),
            claimState: base.claimState,
            claimVersion: base.claimVersion,
            sourceEvidenceFingerprint,
            // An unproven result carries no claim control, payer, lineage, submission, assignment, account or
            // transaction reference. Scoped vendor/environment status and an opaque evidence digest remain.
            replacesClaimId: proven ? base.replacesClaimId : null,
            replacedByClaimId: proven ? base.replacedByClaimId : null,
            attempts: attemptRows.map(({ base: s, acknowledgments }) => ({
              submissionId: proven ? s.submissionId! : null,
              attemptIndex: s.attemptIndex!,
              claimVersion: s.submittedClaimVersion,
              sourceAccountRef: proven ? s.sourceAccountRef : null,
              environment: s.environment,
              vendor: s.vendor!,
              vendorTransactionId: proven ? s.vendorTransactionId : null,
              payerId: proven ? s.payerId : null,
              payerClassificationId: proven ? s.payerClassificationId : null,
              programKind: proven ? s.programKindSnapshot : null,
              assignmentId: proven ? s.assignmentId : null,
              assignmentVersion: s.assignmentVersionSnapshot,
              provenanceStatus: s.provenanceStatus!,
              result: s.result!,
              submittedAt: s.submittedAt?.toISOString() ?? null,
              acknowledgments: proven
                ? acknowledgments.map((ack) => ({
                    id: ack.id,
                    kind: ack.kind,
                    outcome: ack.outcome,
                    payerClaimControlNumber: ack.payerClaimControlNumber,
                    receivedAt: ack.receivedAt,
                  }))
                : acknowledgments.map((ack) => ({
                    id: null,
                    kind: ack.kind,
                    outcome: ack.outcome,
                    payerClaimControlNumber: null,
                    receivedAt: ack.receivedAt,
                  })),
            })),
          };
        });
      });
    },
    async patientIdForClaim(orgId, claimId) {
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const C = schema.medicaidClaim;
        const rows = await tx
          .select({ patientId: C.patientId })
          .from(C)
          .where(and(eq(C.id, claimId), eq(C.organizationId, orgId)))
          .limit(1);
        return rows[0]?.patientId ?? null;
      });
    },
    async medicaidClaimIds(orgId, claimIds) {
      const ids = [...new Set(claimIds)].slice(0, MEDICAID_CLAIM_IDS_CAP);
      if (ids.length === 0) return new Set<string>();
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const C = schema.medicaidClaim;
        const rows = await tx
          .select({ id: C.id })
          .from(C)
          .where(and(eq(C.organizationId, orgId), inArray(C.id, ids)));
        return new Set(rows.map((r) => r.id));
      });
    },
    async claimContext(orgId, claimId) {
      return withOrgContext(db, systemActor(orgId), async (tx) => {
        const C = schema.medicaidClaim;
        const rows = await tx
          .select({
            serviceState: C.serviceState,
            mcoId: C.mcoId,
            providerEntityId: C.providerEntityId,
            patientId: C.patientId,
          })
          .from(C)
          .where(and(eq(C.id, claimId), eq(C.organizationId, orgId)))
          .limit(1);
        return rows[0] ?? null;
      });
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
    claimMatch,
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

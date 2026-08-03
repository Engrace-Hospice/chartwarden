// apps/backend/src/modules/06-admission/routes/service.ts — M6-T06 the AdmissionRouteService + an
// in-memory slice (§4.1–4.2). The route handlers compose over this; production injects a Drizzle-
// backed service (writes under withOrgContext so RLS scopes by app.org_id). The slice also exposes
// an AdmissionAbacResolver over the SAME dataset so M6's §4.6 ABAC predicates resolve a resource's
// owner facts (patient / signer ids) without a cross-module schema import. Pure-ish: no clock except
// the injected `now()` so version/date math is deterministic in tests.
import type { LocalDate } from "@wardenx/types";
import { WardenXError } from "@wardenx/types";
import {
  DEFAULT_ORG_TIME_ZONE,
  computeF2fWindow,
  computeWrittenCertDeadline,
  decideRecertSign,
  isF2fScheduledWithinWindow,
} from "../certification";
import {
  type DischargeReason,
  type TransferInInput,
  checkDischargeNarrative,
  decideBereavementEligibility,
  dischargeRequiresCosign,
  fileForCauseDischarge,
  planTransferIn,
  resolveForCauseDischarge,
} from "../discharge";
import { type ActivationGap, type ActivationGate, computeActivationGate } from "../intake";
import { AdmissionStateError } from "../state-machines/errors";
import { daysBetween } from "../state-machines/validation";

/** 409 VERSION_MISMATCH — an optimistic-lock failure on a state-change route (§4 intro). */
export class VersionMismatchError extends WardenXError {
  constructor(id: string, current: number, attempted: number) {
    super(
      "VERSION_MISMATCH",
      `stale write on ${id} (current v${current}, sent v${attempted})`,
      409,
    );
  }
}

/** 404 NOT_FOUND — the resource is absent or cross-tenant (§6.6 non-leak). */
export class ResourceNotFoundError extends WardenXError {
  constructor(id: string) {
    super("NOT_FOUND", `${id} not found`, 404);
  }
}

/** 409 EXTERNAL_REFERRAL_ALREADY_INGESTED — re-ingest of a known `externalReferralId` (W-RF-02). */
export class ExternalReferralAlreadyIngestedError extends WardenXError {
  constructor(externalReferralId: string) {
    super(
      "EXTERNAL_REFERRAL_ALREADY_INGESTED",
      `external referral ${externalReferralId} was already ingested`,
      409,
    );
  }
}

/** 409 INVALID_STATE — a referral transition attempted from the wrong state (§4.2.1 / W-RF-03). */
export class InvalidReferralStateError extends WardenXError {
  constructor(id: string, state: string, action: string) {
    super("INVALID_STATE", `referral ${id} cannot ${action} from state '${state}'`, 409);
  }
}

/** 409 INELIGIBLE_NOT_TRIAGED — accept attempted on a referral that is not yet `triaged` (§4.2.1). */
export class ReferralNotTriagedError extends WardenXError {
  constructor(id: string) {
    super(
      "INELIGIBLE_NOT_TRIAGED",
      `referral ${id} must be triaged before it can be accepted`,
      409,
    );
  }
}

/**
 * 422 F2F_OUTSIDE_WINDOW — a scheduled F2F date falls outside the CMS 418.22 prior-to window
 * `[period_start − 30, period_start − 1]` (§7.4 W-F2F-01). The window is server-computed in org TZ.
 */
export class F2fScheduleOutOfWindowError extends WardenXError {
  constructor(scheduledDate: string, windowStart: string, windowEnd: string) {
    super(
      "F2F_OUTSIDE_WINDOW",
      `F2F date ${scheduledDate} is outside the recert window [${windowStart}, ${windowEnd}]`,
      422,
    );
  }
}

/**
 * 412 PRECONDITION_FAILED — the R-AC-01 activation gate is not satisfied (§4.2.2 / §7.2 W-AD-05). The
 * unmet gate codes ride in the envelope `details` (one entry per gap) so the §5.2.5 checklist can
 * re-render against server truth without a bespoke field on the envelope.
 */
export class ActivationPreconditionError extends WardenXError {
  constructor(public readonly missing: readonly ActivationGap[]) {
    super(
      "PRECONDITION_FAILED",
      `admission activation blocked; missing: ${missing.join(", ")}`,
      412,
      missing.map((gap) => ({
        field: gap,
        code: "PRECONDITION_FAILED",
        message: `${gap} required`,
      })),
    );
  }
}

/** A minimal mutation result every state-change route returns (§4.2 `{ id, state, version }`). */
export interface MutationResult {
  readonly id: string;
  readonly state: string;
  readonly version: number;
}

/** The org-scoped owner facts M6's §4.6 ABAC predicates evaluate against (never client input). */
export interface ReferralFacts {
  readonly locationId: string | null;
  readonly providerEntityId: string | null;
}
export interface AdmissionFacts {
  readonly patientId: string;
  readonly providerEntityId: string | null;
}
export interface CtiFacts {
  readonly hospiceMedicalDirectorId: string;
  readonly attendingPhysicianId: string | null;
}
export interface F2fFacts {
  readonly scheduledClinicianId: string;
}
export interface ComplianceWindowFacts {
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string | null;
}

/**
 * The read-side resolver M6's ABAC predicates (§4.6) load a resource's owner facts through. Every
 * method is org-scoped (RLS backstops in prod) and returns `null` when the resource is absent /
 * cross-tenant — the predicate then fails closed. Kept separate from the write service so a predicate
 * never reaches a mutation method.
 */
export interface AdmissionAbacResolver {
  loadReferral(organizationId: string, id: string): Promise<ReferralFacts | null>;
  loadAdmission(organizationId: string, id: string): Promise<AdmissionFacts | null>;
  loadCti(organizationId: string, id: string): Promise<CtiFacts | null>;
  loadF2f(organizationId: string, id: string): Promise<F2fFacts | null>;
  loadComplianceWindow(organizationId: string, id: string): Promise<ComplianceWindowFacts | null>;
}

/** The capture contracts the routes hand the service (§4.2; abbreviated to the load-bearing fields). */
export interface ReferralCreateInput {
  readonly source: string;
  readonly receivedAt: string;
  readonly receivingUserId: string;
  readonly patientNameAtReceipt: string;
  readonly externalReferralId?: string;
}
export interface AdmissionCreateInput {
  readonly patientId: string;
  readonly referralId?: string;
  readonly intakeMethod: string;
  readonly attendingPhysicianId?: string;
  readonly hospiceMedicalDirectorId: string;
}
/** §4.2.1 accept body — links/creates the M5 patient and supplies the primary dx (W-RF-04). */
export interface AcceptReferralInput {
  readonly patientId?: string;
  readonly primaryDiagnosisIcd10: string;
  readonly attendingPhysicianId?: string;
}
export interface CtiDraftInput {
  readonly electionPeriodId: string;
  readonly hospiceMedicalDirectorId: string;
  readonly attendingPhysicianId?: string;
  readonly isRecert: boolean;
}
/**
 * §4.2.2 route 41 body (NorAcknowledgeSchema), narrowed to the two fields the
 * `notice_of_rights_acknowledgment` table can actually store (`acknowledgment_method`/`signer_kind`).
 * `formVersionId`/`acknowledgedByName` are validated by the route but have no column to land in today —
 * TASK-034 fixes the ones that do rather than widening this type to fields that would still be dropped.
 */
export interface NorAcknowledgeInput {
  readonly deliveryMethod: "wet_ink_scanned" | "electronic_witnessed" | "verbal_with_witness";
  readonly acknowledgedByRole: "patient" | "legal_representative";
}
export interface F2fScheduleInput {
  readonly admissionId: string;
  readonly electionPeriodId: string;
  readonly scheduledClinicianId: string;
  readonly clinicianRole: string;
  /** Org-local F2F date (§7.4 W-F2F-01) — validated against the server-computed recert window. */
  readonly scheduledDate?: LocalDate;
}
export interface DischargeInput {
  readonly reason: DischargeReason;
  readonly dischargeDate: string;
  readonly narrative: string;
  readonly forCauseReason?: string;
}

/** The discharge outcome the route returns (§4.2 — `requiresMedicalDirectorCosign` drives route 40). */
export interface DischargeResult extends MutationResult {
  readonly requiresMedicalDirectorCosign: boolean;
  readonly reason: DischargeReason;
}

/** A cursor-paginated page (§4: `?cursor=&limit=` → `{ items, nextCursor }`). */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** A summary row for the list routes (state + version + the resource's create instant). */
export interface SummaryRow {
  readonly id: string;
  readonly state: string;
  readonly version: number;
}

/** The admission aggregate (route 10) — summary + the R-AC-01 activation gate (§7.2 / §5.2.5). */
export interface AdmissionDetail extends SummaryRow {
  readonly activationGate: ActivationGate;
}

/**
 * The patient-scoped Election & Certification aggregate — the read that backs the patient-chart
 * "Election & Certification" tab (§5.2/§5.3). Resolves the patient's current admission, then its
 * benefit-period ladder with each period's election statement / CTI / F2F recert bundle, plus the
 * admission's compliance windows. `admission` is `null` (with empty ladders) when the patient has no
 * admission yet — a truthful empty, never a 404. All fields are read-only projections (no PHI narrative);
 * SUD/consent gating is not applicable here (election/cert metadata is not Part-2 content).
 */
export interface PatientElectionCertificationView {
  readonly admission: {
    readonly id: string;
    readonly state: string;
    readonly admissionAt: string | null;
    readonly activatedAt: string | null;
    readonly dischargedAt: string | null;
    readonly version: number;
  } | null;
  readonly periods: readonly {
    readonly id: string;
    readonly sequenceNumber: number;
    readonly periodKind: string;
    readonly effectiveAt: string | null;
    readonly scheduledEndAt: string | null;
    readonly actualEndAt: string | null;
    readonly status: string;
    readonly electionStatement: {
      readonly id: string;
      readonly status: string;
      readonly signerKind: string;
      readonly signedAt: string | null;
    } | null;
    readonly cti: {
      readonly id: string;
      readonly status: string;
      readonly hospiceMdSigned: boolean;
      readonly attendingMdSigned: boolean;
      readonly signedLate: boolean;
      readonly periodStart: string | null;
      readonly periodEnd: string | null;
    } | null;
    readonly faceToFace: {
      readonly id: string;
      readonly status: string;
      readonly performerRole: string;
      readonly encounterDate: string | null;
      readonly withinWindow: boolean | null;
      readonly windowOverride: boolean;
      readonly attested: boolean;
    } | null;
  }[];
  readonly complianceWindows: readonly {
    readonly id: string;
    readonly windowKind: string;
    readonly severity: string;
    readonly status: string;
    readonly mustCompleteBy: string;
    readonly closedAt: string | null;
  }[];
}

/**
 * The §4.1 route surface. One method per state-change / read route; org binding is server-side
 * (`organizationId` is the request context, never the body). `actorUserId` is the staff member
 * capturing the action (D-AUTHZ-01: patient-side signatures are evidence on the row, not identities).
 */
export interface AdmissionRouteService {
  // Referral (routes 1–7)
  createReferral(
    organizationId: string,
    input: ReferralCreateInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  listReferrals(
    organizationId: string,
    query: { cursor?: string; limit?: number },
  ): Promise<Page<SummaryRow>>;
  getReferral(organizationId: string, id: string): Promise<SummaryRow | null>;
  updateReferral(organizationId: string, id: string, ifVersion: number): Promise<MutationResult>;
  triageReferral(
    organizationId: string,
    id: string,
    outcome: "eligible" | "ineligible",
    ifVersion: number,
  ): Promise<MutationResult>;
  acceptReferral(
    organizationId: string,
    id: string,
    input: AcceptReferralInput,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult & { admissionId: string }>;
  declineReferral(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  // Admission (routes 8–14)
  createAdmission(
    organizationId: string,
    input: AdmissionCreateInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  listAdmissions(
    organizationId: string,
    query: { state?: string; cursor?: string; limit?: number },
  ): Promise<Page<SummaryRow>>;
  getAdmission(organizationId: string, id: string): Promise<AdmissionDetail | null>;
  /** Patient-scoped Election & Certification aggregate (patient-chart tab); empty admission when none. */
  getPatientElectionCertification(
    organizationId: string,
    patientId: string,
  ): Promise<PatientElectionCertificationView>;
  updateAdmission(organizationId: string, id: string, ifVersion: number): Promise<MutationResult>;
  holdAdmission(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  resumeAdmission(organizationId: string, id: string, ifVersion: number): Promise<MutationResult>;
  activateAdmission(organizationId: string, id: string, ifVersion: number): Promise<MutationResult>;
  // Election (routes 15–21)
  draftElectionStatement(
    organizationId: string,
    admissionId: string,
    electionPeriodId: string,
  ): Promise<MutationResult>;
  getElectionStatement(organizationId: string, id: string): Promise<SummaryRow | null>;
  signElection(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  voidElection(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  listElectionPeriods(
    organizationId: string,
    admissionId: string,
  ): Promise<readonly SummaryRow[] | null>;
  createElectionPeriod(organizationId: string, admissionId: string): Promise<MutationResult>;
  patchElectionPeriod(
    organizationId: string,
    id: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  // CTI (routes 22–27)
  draftCti(
    organizationId: string,
    input: CtiDraftInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  getCti(organizationId: string, id: string): Promise<SummaryRow | null>;
  signCtiHospiceMd(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  signCtiAttending(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  voidCti(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  markCtiLate(
    organizationId: string,
    id: string,
    ifVersion: number,
  ): Promise<MutationResult & { writtenCertDeadlineAt: string }>;
  // F2F (routes 28–32)
  scheduleF2f(organizationId: string, input: F2fScheduleInput): Promise<MutationResult>;
  getF2f(organizationId: string, id: string): Promise<SummaryRow | null>;
  completeF2f(organizationId: string, id: string, ifVersion: number): Promise<MutationResult>;
  attestF2f(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  overrideF2fWindow(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  // LOC (routes 33–35)
  changeLoc(organizationId: string, admissionId: string, newLevel: string): Promise<MutationResult>;
  listLoc(organizationId: string, admissionId: string): Promise<readonly SummaryRow[] | null>;
  patchLoc(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  // Revocation / transfer / discharge (routes 36–40)
  createRevocation(
    organizationId: string,
    admissionId: string,
    actorUserId: string,
  ): Promise<MutationResult>;
  transferOut(
    organizationId: string,
    admissionId: string,
    actorUserId: string,
  ): Promise<MutationResult>;
  transferIn(
    organizationId: string,
    admissionId: string,
    input: TransferInInput,
    actorUserId: string,
  ): Promise<MutationResult & { currentElectionPeriodSequence: number }>;
  discharge(
    organizationId: string,
    admissionId: string,
    input: DischargeInput,
    actorUserId: string,
  ): Promise<DischargeResult>;
  cosignDischarge(
    organizationId: string,
    id: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
  // NOR (routes 41–42)
  acknowledgeNor(
    organizationId: string,
    admissionId: string,
    input: NorAcknowledgeInput,
    actorUserId: string,
  ): Promise<MutationResult>;
  getNor(organizationId: string, admissionId: string): Promise<SummaryRow | null>;
  // Compliance windows (routes 43–46)
  listComplianceWindowsForAdmission(
    organizationId: string,
    admissionId: string,
  ): Promise<readonly SummaryRow[] | null>;
  listComplianceWindows(
    organizationId: string,
    query: { state?: string; cursor?: string; limit?: number },
  ): Promise<Page<SummaryRow>>;
  closeComplianceWindow(
    organizationId: string,
    id: string,
    ifVersion: number,
  ): Promise<MutationResult>;
  overrideComplianceWindow(
    organizationId: string,
    id: string,
    reason: string,
    ifVersion: number,
    actorUserId: string,
  ): Promise<MutationResult>;
}

// ── in-memory backend ────────────────────────────────────────────────────────────────────────────

interface Rec {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: string;
  state: string;
  version: number;
  // owner facts for ABAC (§4.6)
  patientId?: string;
  providerEntityId?: string | null;
  locationId?: string | null;
  admissionId?: string;
  hospiceMedicalDirectorId?: string;
  attendingPhysicianId?: string | null;
  scheduledClinicianId?: string;
  // intake/wizard linkage (§7.1/§7.2) — referral idempotency + the period-1 activation bundle
  externalReferralId?: string;
  electionPeriodId?: string;
  sequence?: number;
  primaryDiagnosisIcd10?: string;
  // recert/F2F linkage (§7.3/§7.4) — the period start date drives the D4 deadline + F2F window math
  periodStartDate?: LocalDate;
  // discharge linkage (§6.3/§7.6) — for-cause stays active until cosign (D11); opt-out gates W-DC-01
  pendingForCauseDischarge?: boolean;
  bereavementOptOut?: boolean;
  reason?: DischargeReason;
  // NOR acknowledgment facts (TASK-034) — what was actually submitted, not a hardcoded default.
  deliveryMethod?: NorAcknowledgeInput["deliveryMethod"];
  acknowledgedByRole?: NorAcknowledgeInput["acknowledgedByRole"];
}

/** A seed record for the slice (lets a test pre-populate a resource with owner facts for ABAC). */
export interface AdmissionSeedRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: string;
  readonly state?: string;
  readonly patientId?: string;
  readonly providerEntityId?: string | null;
  readonly locationId?: string | null;
  readonly admissionId?: string;
  readonly hospiceMedicalDirectorId?: string;
  readonly attendingPhysicianId?: string | null;
  readonly scheduledClinicianId?: string;
  /** §7.3/§7.4 — the benefit-period sequence + start date (lets a test seed a recert / F2F window). */
  readonly sequence?: number;
  readonly periodStartDate?: LocalDate;
  /** §7.6 W-DC-01 — the M5 per-patient bereavement opt-out flag (suppresses `m6.bereavement.eligible`). */
  readonly bereavementOptOut?: boolean;
}

export interface AdmissionBackendSeed {
  readonly records?: readonly AdmissionSeedRecord[];
  readonly now?: () => Date;
  /** Org timezone (M2 `organization.timezone`; D8) — drives the D4 deadline + F2F window math. */
  readonly orgTimeZone?: string;
}

/**
 * Build an in-memory {@link AdmissionRouteService} + {@link AdmissionAbacResolver} over ONE dataset
 * (M40-style backend) so the slice's route writes and the ABAC predicate reads stay consistent. The
 * `events` array records emitted outbox event names for assertion. Deterministic — no I/O, injected
 * clock.
 */
export function createInMemoryAdmissionBackend(seed: AdmissionBackendSeed = {}): {
  service: AdmissionRouteService;
  resolver: AdmissionAbacResolver;
  events: string[];
} {
  const events: string[] = [];
  const byId = new Map<string, Rec>();
  for (const r of seed.records ?? []) {
    byId.set(r.id, {
      id: r.id,
      organizationId: r.organizationId,
      kind: r.kind,
      state: r.state ?? "pending",
      version: 1,
      patientId: r.patientId,
      providerEntityId: r.providerEntityId ?? null,
      locationId: r.locationId ?? null,
      admissionId: r.admissionId,
      hospiceMedicalDirectorId: r.hospiceMedicalDirectorId,
      attendingPhysicianId: r.attendingPhysicianId ?? null,
      scheduledClinicianId: r.scheduledClinicianId,
      sequence: r.sequence,
      periodStartDate: r.periodStartDate,
      bereavementOptOut: r.bereavementOptOut,
    });
  }
  const now = seed.now ?? (() => new Date("2026-06-20T00:00:00Z"));
  const orgTimeZone = seed.orgTimeZone ?? DEFAULT_ORG_TIME_ZONE;
  let seq = 0;
  // Mint uuid-shaped synthetic ids so a created id round-trips through a uuid-validated request body
  // (e.g. the wizard posts a server-created electionPeriodId back on the CTI draft, §7.2). The id is
  // deterministic in `seq` — the slice stands in for the Drizzle backend's uuid PKs.
  const nextId = (_kind: string) =>
    // biome-ignore lint/suspicious/noAssignInExpressions: in-memory monotonic id counter.
    `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`;

  const insert = (
    kind: string,
    organizationId: string,
    state: string,
    facts: Partial<Rec> = {},
  ): Rec => {
    const id = nextId(kind);
    const rec: Rec = { id, organizationId, kind, state, version: 1, ...facts };
    byId.set(id, rec);
    return rec;
  };
  const get = (organizationId: string, id: string, kind?: string): Rec | null => {
    const rec = byId.get(id);
    if (!rec || rec.organizationId !== organizationId) return null; // §6.6 cross-tenant non-leak
    if (kind && rec.kind !== kind) return null;
    return rec;
  };
  /** Apply a state transition with optimistic-lock check; bumps version + emits `event`. */
  const transition = (
    rec: Rec,
    state: string,
    ifVersion: number,
    event?: string,
  ): MutationResult => {
    if (rec.version !== ifVersion) {
      throw new VersionMismatchError(rec.id, rec.version, ifVersion);
    }
    rec.state = state;
    rec.version += 1;
    if (event) events.push(event);
    return { id: rec.id, state: rec.state, version: rec.version };
  };
  const summary = (rec: Rec): SummaryRow => ({
    id: rec.id,
    state: rec.state,
    version: rec.version,
  });
  const page = <T extends SummaryRow>(
    rows: T[],
    query: { cursor?: string; limit?: number },
  ): Page<T> => {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
    const slice = rows.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    return { items: slice, nextCursor: nextOffset < rows.length ? String(nextOffset) : null };
  };
  const listOfKind = (organizationId: string, kind: string): Rec[] =>
    [...byId.values()].filter((r) => r.organizationId === organizationId && r.kind === kind);

  /**
   * Compute the R-AC-01 activation gate (§7.2 / §5.2.5) over an admission's period-1 bundle. Both the
   * read aggregate (route 10) and `activateAdmission` (route 14) call this ONE helper so the §5.2.5
   * checklist and the server gate can never disagree. CTI signature progress is read off the CTI
   * state (`awaiting_attending` = hospice-MD signed; `signed` = both signed).
   */
  const gateFor = (adm: Rec): ActivationGate => {
    const childrenOf = (kind: string): Rec[] =>
      listOfKind(adm.organizationId, kind).filter((r) => r.admissionId === adm.id);
    const periods = childrenOf("election_period");
    const ctis = childrenOf("cti");
    return computeActivationGate({
      periodSequence: periods.length ? Math.min(...periods.map((p) => p.sequence ?? 1)) : 1,
      electionSigned: childrenOf("election_statement").some((s) => s.state === "signed"),
      norAcknowledged: childrenOf("nor").some((n) => n.state === "acknowledged"),
      ctiHospiceMdSigned: ctis.some(
        (c) => c.state === "awaiting_attending" || c.state === "signed",
      ),
      ctiAttendingSigned: ctis.some((c) => c.state === "signed"),
    });
  };

  const notFound = (id: string): never => {
    throw new ResourceNotFoundError(id);
  };

  const service: AdmissionRouteService = {
    async createReferral(organizationId, input, actorUserId) {
      void actorUserId;
      // W-RF-02: re-ingest of a known externalReferralId is a no-op-with-409, never a duplicate row.
      if (input.externalReferralId) {
        const dup = listOfKind(organizationId, "referral").find(
          (r) => r.externalReferralId === input.externalReferralId,
        );
        if (dup) throw new ExternalReferralAlreadyIngestedError(input.externalReferralId);
      }
      const rec = insert("referral", organizationId, "received", {
        locationId: null,
        externalReferralId: input.externalReferralId,
      });
      events.push("m6.referral.received");
      return summary(rec);
    },
    async listReferrals(organizationId, query) {
      return page(listOfKind(organizationId, "referral").map(summary), query);
    },
    async getReferral(organizationId, id) {
      const rec = get(organizationId, id, "referral");
      return rec ? summary(rec) : null;
    },
    async updateReferral(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      return transition(rec, rec.state, ifVersion);
    },
    async triageReferral(organizationId, id, outcome, ifVersion) {
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      // Optimistic lock first (§7.1 concurrency edge): a stale write is a VERSION_MISMATCH, even when
      // the winning write already advanced the state out of `received`.
      if (rec.version !== ifVersion) throw new VersionMismatchError(id, rec.version, ifVersion);
      if (rec.state !== "received") throw new InvalidReferralStateError(id, rec.state, "triage");
      const next = outcome === "eligible" ? "triaged" : "ineligible";
      return transition(rec, next, ifVersion, "m6.referral.triaged");
    },
    async acceptReferral(organizationId, id, input, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      if (rec.state !== "triaged") throw new ReferralNotTriagedError(id); // W-RF-04 precondition
      const res = transition(rec, "accepted", ifVersion, "m6.referral.accepted");
      // §4.3 `admission.draft_from_referral` job: draft admission + draft period-1 + open NOR window.
      const patientId = input.patientId ?? `pat_from_${rec.id}`;
      const adm = insert("admission", organizationId, "pending", {
        patientId,
        providerEntityId: null,
        attendingPhysicianId: input.attendingPhysicianId ?? null,
        primaryDiagnosisIcd10: input.primaryDiagnosisIcd10,
      });
      insert("election_period", organizationId, "pending", {
        admissionId: adm.id,
        patientId,
        sequence: 1,
        primaryDiagnosisIcd10: input.primaryDiagnosisIcd10,
      });
      insert("compliance_window", organizationId, "open", { admissionId: adm.id, patientId }); // NOR window
      events.push("m6.admission.draft_created");
      return { ...res, admissionId: adm.id };
    },
    async declineReferral(organizationId, id, reason, ifVersion) {
      void reason;
      const rec = get(organizationId, id, "referral") ?? notFound(id);
      return transition(rec, "declined", ifVersion, "m6.referral.declined");
    },

    async createAdmission(organizationId, input, actorUserId) {
      void actorUserId;
      const rec = insert("admission", organizationId, "pending", {
        patientId: input.patientId,
        providerEntityId: null,
        hospiceMedicalDirectorId: input.hospiceMedicalDirectorId,
        attendingPhysicianId: input.attendingPhysicianId ?? null,
      });
      return summary(rec);
    },
    async listAdmissions(organizationId, query) {
      let rows = listOfKind(organizationId, "admission");
      if (query.state) rows = rows.filter((r) => r.state === query.state);
      return page(rows.map(summary), query);
    },
    async getAdmission(organizationId, id) {
      const rec = get(organizationId, id, "admission");
      return rec ? { ...summary(rec), activationGate: gateFor(rec) } : null;
    },
    async getPatientElectionCertification(organizationId, patientId) {
      // Newest admission for the patient (ids are monotonic in insert order → last is newest).
      const admissions = listOfKind(organizationId, "admission").filter(
        (r) => r.patientId === patientId,
      );
      const adm = admissions.length ? admissions[admissions.length - 1] : null;
      if (!adm) return { admission: null, periods: [], complianceWindows: [] };
      const childrenOf = (kind: string): Rec[] =>
        listOfKind(organizationId, kind).filter((r) => r.admissionId === adm.id);
      // Election statement / CTI / F2F link to a period via `electionPeriodId`.
      const byPeriod = (kind: string): Map<string, Rec> => {
        const m = new Map<string, Rec>();
        for (const r of listOfKind(organizationId, kind)) {
          if (r.electionPeriodId) m.set(r.electionPeriodId, r);
        }
        return m;
      };
      const esBy = byPeriod("election_statement");
      const ctiBy = byPeriod("cti");
      const f2fBy = byPeriod("face_to_face");
      const periods = childrenOf("election_period")
        .slice()
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map((p) => {
          const es = esBy.get(p.id);
          const cti = ctiBy.get(p.id);
          const f2f = f2fBy.get(p.id);
          return {
            id: p.id,
            sequenceNumber: p.sequence ?? 1,
            periodKind: "initial",
            effectiveAt: p.periodStartDate ?? null,
            scheduledEndAt: null,
            actualEndAt: null,
            status: p.state,
            electionStatement: es
              ? { id: es.id, status: es.state, signerKind: "patient", signedAt: null }
              : null,
            cti: cti
              ? {
                  id: cti.id,
                  status: cti.state,
                  hospiceMdSigned: cti.state === "awaiting_attending" || cti.state === "signed",
                  attendingMdSigned: cti.state === "signed",
                  signedLate: false,
                  periodStart: p.periodStartDate ?? null,
                  periodEnd: null,
                }
              : null,
            faceToFace: f2f
              ? {
                  id: f2f.id,
                  status: f2f.state,
                  performerRole: "hospice_physician",
                  encounterDate: null,
                  withinWindow: null,
                  windowOverride: false,
                  attested: f2f.state === "attested",
                }
              : null,
          };
        });
      const complianceWindows = childrenOf("compliance_window").map((w) => ({
        id: w.id,
        windowKind: "recert",
        severity: "warning",
        status: w.state,
        mustCompleteBy: new Date(0).toISOString(),
        closedAt: null,
      }));
      return {
        admission: {
          id: adm.id,
          state: adm.state,
          admissionAt: null,
          activatedAt: null,
          dischargedAt: null,
          version: adm.version,
        },
        periods,
        complianceWindows,
      };
    },
    async updateAdmission(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "admission") ?? notFound(id);
      return transition(rec, rec.state, ifVersion);
    },
    async holdAdmission(organizationId, id, reason, ifVersion) {
      void reason;
      const rec = get(organizationId, id, "admission") ?? notFound(id);
      return transition(rec, "on_hold", ifVersion, "m6.admission.on_hold");
    },
    async resumeAdmission(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "admission") ?? notFound(id);
      return transition(rec, "active", ifVersion, "m6.admission.resumed");
    },
    async activateAdmission(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "admission") ?? notFound(id);
      // R-AC-01 (§7.2 W-AD-05): the gate is server-truth; a stale UI checklist cannot bypass it.
      const gate = gateFor(rec);
      if (!gate.ready) throw new ActivationPreconditionError(gate.missing);
      return transition(rec, "active", ifVersion, "m6.admission.activated");
    },

    async draftElectionStatement(organizationId, admissionId, electionPeriodId) {
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      const rec = insert("election_statement", organizationId, "drafted", {
        admissionId: adm.id,
        patientId: adm.patientId,
        electionPeriodId,
      });
      events.push("m6.election.drafted");
      return summary(rec);
    },
    async getElectionStatement(organizationId, id) {
      const rec = get(organizationId, id, "election_statement");
      return rec ? summary(rec) : null;
    },
    async signElection(organizationId, id, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "election_statement") ?? notFound(id);
      return transition(rec, "signed", ifVersion, "m6.election.signed");
    },
    async voidElection(organizationId, id, reason, ifVersion) {
      void reason;
      const rec = get(organizationId, id, "election_statement") ?? notFound(id);
      return transition(rec, "voided", ifVersion);
    },
    async listElectionPeriods(organizationId, admissionId) {
      if (!get(organizationId, admissionId, "admission")) return null;
      return listOfKind(organizationId, "election_period")
        .filter((r) => r.admissionId === admissionId)
        .map(summary);
    },
    async createElectionPeriod(organizationId, admissionId) {
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      const rec = insert("election_period", organizationId, "pending", {
        admissionId: adm.id,
        patientId: adm.patientId,
      });
      events.push("m6.election.drafted");
      return summary(rec);
    },
    async patchElectionPeriod(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "election_period") ?? notFound(id);
      return transition(rec, rec.state, ifVersion);
    },

    async draftCti(organizationId, input, actorUserId) {
      void actorUserId;
      // Resolve the period → admission so the activation gate can find this CTI in the period-1 bundle.
      const period = get(organizationId, input.electionPeriodId, "election_period");
      const rec = insert("cti", organizationId, "drafted", {
        admissionId: period?.admissionId,
        electionPeriodId: input.electionPeriodId,
        hospiceMedicalDirectorId: input.hospiceMedicalDirectorId,
        attendingPhysicianId: input.attendingPhysicianId ?? null,
        // §7.3 — carry the period sequence + start date so the recert sign can advance the period
        // (W-CTI-03) and mark-late can compute the D4 written-cert deadline off the period start.
        sequence: period?.sequence,
        periodStartDate: period?.periodStartDate,
      });
      events.push("m6.cti.drafted");
      return summary(rec);
    },
    async getCti(organizationId, id) {
      const rec = get(organizationId, id, "cti");
      return rec ? summary(rec) : null;
    },
    async signCtiHospiceMd(organizationId, id, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "cti") ?? notFound(id);
      // W-CTI-03/04: period 1 with an attending needs the co-sign (→ awaiting_attending); a recert
      // (period ≥ 2) is fully signed on the MD signature alone and advances its period to `active`.
      const outcome = decideRecertSign({
        sequence: rec.sequence ?? 1,
        patientHasAttending: rec.attendingPhysicianId != null,
        hospiceMdSigned: true,
        attendingSigned: false,
      });
      const res = transition(
        rec,
        outcome.progress,
        ifVersion,
        outcome.fullySigned ? "m6.cti.signed" : undefined,
      );
      if (outcome.activatesPeriod && rec.electionPeriodId) {
        const period = get(organizationId, rec.electionPeriodId, "election_period");
        if (period && period.state !== "active") {
          period.state = "active";
          period.version += 1;
          events.push("m6.election.period_started");
        }
      }
      return res;
    },
    async signCtiAttending(organizationId, id, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "cti") ?? notFound(id);
      return transition(rec, "signed", ifVersion, "m6.cti.signed");
    },
    async voidCti(organizationId, id, reason, ifVersion) {
      void reason;
      const rec = get(organizationId, id, "cti") ?? notFound(id);
      return transition(rec, "voided", ifVersion, "m6.cti.voided");
    },
    async markCtiLate(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "cti") ?? notFound(id);
      const res = transition(rec, rec.state, ifVersion, "m6.cti.late_flagged");
      // D4 (§7.3 late-cert path): written-cert deadline = period_start + 2 calendar days at 23:59
      // org-TZ. Fall back to the org-local day of `now()` only when no period start is on file.
      const periodStart = rec.periodStartDate ?? now().toISOString().slice(0, 10);
      const writtenCertDeadlineAt = computeWrittenCertDeadline(periodStart, orgTimeZone);
      return { ...res, writtenCertDeadlineAt };
    },

    async scheduleF2f(organizationId, input) {
      // W-F2F-01: the scheduled date must fall inside the CMS 418.22 prior-to window, computed
      // server-side in org TZ off the period start. Validated only when the period start is on file.
      const period = get(organizationId, input.electionPeriodId, "election_period");
      if (input.scheduledDate && period?.periodStartDate) {
        const window = computeF2fWindow(period.periodStartDate, orgTimeZone);
        if (!isF2fScheduledWithinWindow(input.scheduledDate, window)) {
          throw new F2fScheduleOutOfWindowError(
            input.scheduledDate,
            window.windowStart,
            window.windowEnd,
          );
        }
      }
      const rec = insert("f2f", organizationId, "scheduled", {
        admissionId: input.admissionId,
        electionPeriodId: input.electionPeriodId,
        scheduledClinicianId: input.scheduledClinicianId,
        periodStartDate: period?.periodStartDate,
      });
      events.push("m6.f2f.scheduled");
      return summary(rec);
    },
    async getF2f(organizationId, id) {
      const rec = get(organizationId, id, "f2f");
      return rec ? summary(rec) : null;
    },
    async completeF2f(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "f2f") ?? notFound(id);
      return transition(rec, "completed", ifVersion);
    },
    async attestF2f(organizationId, id, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "f2f") ?? notFound(id);
      return transition(rec, "attested", ifVersion, "m6.f2f.attested");
    },
    async overrideF2fWindow(organizationId, id, reason, ifVersion, actorUserId) {
      void reason;
      void actorUserId;
      const rec = get(organizationId, id, "f2f") ?? notFound(id);
      return transition(rec, rec.state, ifVersion, "m6.f2f.window_overridden");
    },

    async changeLoc(organizationId, admissionId, newLevel) {
      void newLevel;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      const rec = insert("loc", organizationId, "active", {
        admissionId: adm.id,
        patientId: adm.patientId,
      });
      events.push("m6.loc.changed");
      return summary(rec);
    },
    async listLoc(organizationId, admissionId) {
      if (!get(organizationId, admissionId, "admission")) return null;
      return listOfKind(organizationId, "loc")
        .filter((r) => r.admissionId === admissionId)
        .map(summary);
    },
    async patchLoc(organizationId, id, reason, ifVersion) {
      void reason;
      const rec = get(organizationId, id, "loc") ?? notFound(id);
      return transition(rec, rec.state, ifVersion);
    },

    async createRevocation(organizationId, admissionId, actorUserId) {
      void actorUserId;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      adm.state = "discharged";
      adm.version += 1;
      const rec = insert("revocation", organizationId, "created", {
        admissionId: adm.id,
        patientId: adm.patientId,
      });
      events.push("m6.revocation.created");
      events.push("m6.admission.discharged");
      return summary(rec);
    },
    async transferOut(organizationId, admissionId, actorUserId) {
      void actorUserId;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      adm.state = "discharged";
      adm.version += 1;
      const rec = insert("transfer", organizationId, "created", {
        admissionId: adm.id,
        patientId: adm.patientId,
      });
      events.push("m6.transfer.created");
      events.push("m6.admission.discharged");
      return summary(rec);
    },
    async transferIn(organizationId, admissionId, input, actorUserId) {
      void actorUserId;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      // W-DC-03 / D9: the receiving hospice inherits the carried sequence as the ACTIVE period (no CTI
      // required from us) and opens the next PENDING period (our CTI required). No counter restart.
      const plan = planTransferIn(input);
      insert("election_period", organizationId, plan.inherited.state, {
        admissionId: adm.id,
        patientId: adm.patientId,
        sequence: plan.inherited.sequence,
        periodStartDate: input.priorElectionStartDate,
      });
      insert("election_period", organizationId, plan.next.state, {
        admissionId: adm.id,
        patientId: adm.patientId,
        sequence: plan.next.sequence,
      });
      const rec = insert("transfer", organizationId, "created", {
        admissionId: adm.id,
        patientId: adm.patientId,
      });
      events.push("m6.transfer.created");
      events.push("m6.election.period_started");
      return { ...summary(rec), currentElectionPeriodSequence: plan.inherited.sequence };
    },
    async discharge(organizationId, admissionId, input, actorUserId) {
      void actorUserId;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      // §6.3 — the per-reason narrative gates (D11 tightens no_longer_terminal/other; for_cause needs a
      // forCauseReason). The reason→permission key is already enforced at the route preHandler.
      const issue = checkDischargeNarrative(input.reason, input.narrative, input.forCauseReason);
      if (issue) throw new AdmissionStateError(issue.code, issue.message);
      const requiresMedicalDirectorCosign = dischargeRequiresCosign(input.reason);
      events.push("m6.discharge.created");
      if (requiresMedicalDirectorCosign) {
        // W-DC-02 / D11 — filing a for-cause discharge does NOT discharge the admission; it stays
        // `active` with a pending flag until the medical director cosigns via route 40.
        const filing = fileForCauseDischarge();
        adm.pendingForCauseDischarge = true;
        const rec = insert("discharge", organizationId, filing.dischargeState, {
          admissionId: adm.id,
          patientId: adm.patientId,
          reason: input.reason,
        });
        return { ...summary(rec), requiresMedicalDirectorCosign, reason: input.reason };
      }
      // Every other reason discharges immediately. `death` routes the admission to `bereavement`
      // (§2.3.1) and runs the M6-owned bereavement-eligibility rule (W-DC-01); the rest → `discharged`.
      const isDeath = input.reason === "death";
      adm.state = isDeath ? "bereavement" : "discharged";
      adm.version += 1;
      events.push("m6.admission.discharged");
      const rec = insert("discharge", organizationId, "completed", {
        admissionId: adm.id,
        patientId: adm.patientId,
        reason: input.reason,
      });
      if (isDeath) {
        events.push("m6.discharge.death");
        // W-DC-01: days on active election = earliest active period start → discharge date (≥1 day);
        // default to eligible when no period start is on file. Opt-out (M5) suppresses the event.
        const periodStart = listOfKind(organizationId, "election_period")
          .filter((p) => p.admissionId === adm.id && p.periodStartDate)
          .map((p) => p.periodStartDate as LocalDate)
          .sort()[0];
        const days = periodStart ? daysBetween(periodStart, input.dischargeDate) : 1;
        const { eligible } = decideBereavementEligibility({
          reason: input.reason,
          daysOnActiveElectionBeforeDeath: days,
          bereavementOptOut: adm.bereavementOptOut ?? false,
        });
        if (eligible) events.push("m6.bereavement.eligible");
      }
      return { ...summary(rec), requiresMedicalDirectorCosign, reason: input.reason };
    },
    async cosignDischarge(organizationId, id, ifVersion, actorUserId) {
      void actorUserId;
      const rec = get(organizationId, id, "discharge") ?? notFound(id);
      // W-DC-02 — the medical-director cosign completes the discharge AND discharges the admission that
      // was held `active` with the pending flag while awaiting governance sign-off (D11).
      const outcome = resolveForCauseDischarge("cosign");
      const res = transition(rec, outcome.dischargeState, ifVersion, "m6.discharge.cosigned");
      if (rec.admissionId) {
        const adm = get(organizationId, rec.admissionId, "admission");
        if (adm) {
          adm.state = outcome.admissionState;
          adm.pendingForCauseDischarge = outcome.pendingForCauseDischarge;
          adm.version += 1;
          events.push("m6.admission.discharged");
        }
      }
      return res;
    },

    async acknowledgeNor(organizationId, admissionId, input, actorUserId) {
      void actorUserId;
      const adm = get(organizationId, admissionId, "admission") ?? notFound(admissionId);
      const rec = insert("nor", organizationId, "acknowledged", {
        admissionId: adm.id,
        patientId: adm.patientId,
        deliveryMethod: input.deliveryMethod,
        acknowledgedByRole: input.acknowledgedByRole,
      });
      events.push("m6.nor.acknowledged");
      // W-AD-04: acknowledging the NOR closes its open compliance window (admission.recompute_windows).
      const window = listOfKind(organizationId, "compliance_window").find(
        (w) => w.admissionId === adm.id && w.state === "open",
      );
      if (window) {
        window.state = "closed";
        window.version += 1;
        events.push("m6.compliance.window.closed");
      }
      return summary(rec);
    },
    async getNor(organizationId, admissionId) {
      if (!get(organizationId, admissionId, "admission")) return null;
      const rec = listOfKind(organizationId, "nor").find((r) => r.admissionId === admissionId);
      return rec ? summary(rec) : null;
    },

    async listComplianceWindowsForAdmission(organizationId, admissionId) {
      if (!get(organizationId, admissionId, "admission")) return null;
      return listOfKind(organizationId, "compliance_window")
        .filter((r) => r.admissionId === admissionId)
        .map(summary);
    },
    async listComplianceWindows(organizationId, query) {
      let rows = listOfKind(organizationId, "compliance_window");
      if (query.state) rows = rows.filter((r) => r.state === query.state);
      return page(rows.map(summary), query);
    },
    async closeComplianceWindow(organizationId, id, ifVersion) {
      const rec = get(organizationId, id, "compliance_window") ?? notFound(id);
      return transition(rec, "closed", ifVersion, "m6.compliance.window.closed");
    },
    async overrideComplianceWindow(organizationId, id, reason, ifVersion, actorUserId) {
      void reason;
      void actorUserId;
      const rec = get(organizationId, id, "compliance_window") ?? notFound(id);
      return transition(rec, "closed", ifVersion, "m6.compliance.window.overridden");
    },
  };

  const resolver: AdmissionAbacResolver = {
    async loadReferral(organizationId, id) {
      const rec = get(organizationId, id, "referral");
      return rec
        ? { locationId: rec.locationId ?? null, providerEntityId: rec.providerEntityId ?? null }
        : null;
    },
    async loadAdmission(organizationId, id) {
      const rec = get(organizationId, id, "admission");
      return rec?.patientId
        ? { patientId: rec.patientId, providerEntityId: rec.providerEntityId ?? null }
        : null;
    },
    async loadCti(organizationId, id) {
      const rec = get(organizationId, id, "cti");
      return rec?.hospiceMedicalDirectorId
        ? {
            hospiceMedicalDirectorId: rec.hospiceMedicalDirectorId,
            attendingPhysicianId: rec.attendingPhysicianId ?? null,
          }
        : null;
    },
    async loadF2f(organizationId, id) {
      const rec = get(organizationId, id, "f2f");
      return rec?.scheduledClinicianId ? { scheduledClinicianId: rec.scheduledClinicianId } : null;
    },
    async loadComplianceWindow(organizationId, id) {
      const rec = get(organizationId, id, "compliance_window");
      return rec?.admissionId && rec.patientId
        ? {
            admissionId: rec.admissionId,
            patientId: rec.patientId,
            providerEntityId: rec.providerEntityId ?? null,
          }
        : null;
    },
  };

  return { service, resolver, events };
}

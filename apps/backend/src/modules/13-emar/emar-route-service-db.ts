// apps/backend/src/modules/13-emar — PRODUCTION EmarRouteService + §4.7 ABAC resolver (M13L reads + writes
// over Drizzle+RLS). No route is left at 501.
//
// The screen-driving READS (administration record + census, IV-continuous session, scheduled/missed doses,
// reconciliation worksheets + decisions, comfort-kit deployments, administration policy) run as real Drizzle
// queries over the M13-owned `emar/*` tables inside `withOrgContext`, so RLS scopes every row by `app.org_id`
// as the unprivileged `wardenx_app` role. `administration_record` is PARTITIONED BY RANGE(administered_at);
// reads query the parent, inserts route to the current-month leaf.
//
// Like M12, M13 has NO state-transition triggers (only the M4 audit triggers) — the service does every
// administration/worksheet/deployment transition itself via INSERT/UPDATE, composing the PURE `@wardenx/emar`
// deciders: the §2.5 D8 late-entry tier (`resolveLateEntryTier`), the §2.6 D7 witness-attestation token
// (`buildWitnessAttestationToken`/`verifyWitnessAttestationToken`, HMAC + scope-bound), and the §2.9 BCMA
// verifier (`evaluateBarcodeScan`/`barcodeScanBlocks`). Every mutation emits its strict `m13.*` catalog
// payload on the bound transactional outbox (the publisher Value.Checks each and rolls back on mismatch), so
// the payloads here are the exact events-by-m13.ts shapes.
//
// Documented compromises (the M8–M12 convention; the interface threads no seams into the DB backend):
//   (1) `withOrgContext` runs with `userId:""` → the M4 write-audit trigger fires with a NULL actor (the
//       acting membership is the passed `userId`, stored where a column exists);
//   (2) siting (provider_entity_id + location_id) is sourced from the `scheduled_dose` when a scheduledDoseId
//       is supplied, else null (mig 0133). [PARTLY CLOSED, F-031] patient/admission USED to fall back to a
//       hard-coded sentinel pair whenever no scheduled dose was named — and nothing in production ever
//       materializes a `scheduled_dose` (the `m12.medication_order.active` -> `m13.materialize-schedule`
//       consumer is declared and unbound; see scripts/outbox-deferred-consumers.ts), so EVERY administration
//       this platform can record today took that branch. The row committed, and then
//       `listAdministrations(patient)` filters on `patient_id` — so it was invisible on the patient's own
//       eMAR, invisible to every seam consumer that joins by patient, and its witness-attestation scope
//       compare (which binds the resolved patient) could never match a token a witness minted against the
//       REAL patient, making the §2.6 D7 controlled-substance path unsatisfiable. The identity facts now
//       resolve through M12's already-published `MedicationOrderProvider.getAdministrationContext` — the seam
//       the §2.9 D6 note below was already written against — and an order that resolves to nothing is
//       REFUSED rather than filed under a sentinel: without the order there is no answer to "which patient
//       received this dose", and inventing one is worse than declining to record;
//   (3) [CLOSED, F-058] the M12 `MedicationOrderProvider` seam is threaded and the §2.9 D6 order-context
//       gate (`allowAdministration`/`blockedReasons` — not_active / discontinued / replaced /
//       expired_unsigned / transmission_failed) is APPLIED. It was threaded-but-unarmed for exactly one
//       release, because only `status = "active"` cleared M12's verdict and nothing in the platform ever
//       activated an order — arming it then would have refused every administration the system could
//       produce. F-058 fixed the producer side (a signed order that is not being e-prescribed activates
//       on signature; a verbal order is administrable per M12 §2.3), so the verdict now separates "ready
//       to give" from "discontinued / replaced / never signed" instead of refusing everything. The §5.11
//       five-rights validation against the order projection remains open. A supplied barcodeScan is
//       evaluated + persisted against a permissive order context (an honest scan reads `match`; an
//       expired scan still hard-blocks);
//   (4) the M8 `SignedEncountersReader` is NOT threaded → encounter auto-linkage is skipped (the caller may
//       still pass an explicit encounterId);
//   (5) [CLOSED, TASK-008] the witness-attestation secret is externalized via `M13_WITNESS_SIGNING_KEY`
//       (bootstrap/env.ts, prod fail-closed) and the single-use burn is enforced via a unique index on
//       `administration_witness.attestation_token_digest` (mig 0160) — Postgres, not an optional Valkey
//       dependency, so it holds cluster-wide without a Redis requirement this deployment doesn't have;
//   (6) the PRN wrapper row (`prn_administration`) is materialized by M9's reassessment consumer in prod —
//       the write path emits `m13.prn_administration_recorded` with a fresh id (the in-mem posture);
//   (7) the reconciliation worksheet stores no expected-line count, so `finalize` requires ≥1 recorded
//       decision rather than the in-mem's all-lines-decided gate (the per-line completeness set is deferred).
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import {
  ADMINISTRATION_MODE_CATALOG,
  AdministrationStateError,
  type BarcodeMatchResult,
  type IvSegment,
  type IvSegmentMode,
  WITNESS_ELIGIBLE_DISCIPLINES,
  barcodeScanBlocks,
  buildWitnessAttestationToken,
  composeIvSession,
  deriveIvSessionState,
  evaluateBarcodeScan,
  planIvSegment,
  resolveLateEntryTier,
  verifyWitnessAttestationToken,
  witnessTokenDigest,
} from "@wardenx/emar";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, ValidationError } from "@wardenx/types";
import { and, asc, eq, gt, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { CaregiverReviewAbacFacts, WitnessAbacFacts } from "./abac-predicates";
import type {
  AdministrationPolicyView,
  AdministrationView,
  DeploymentView,
  EmarRouteService,
  IvSessionView,
  MissedDoseView,
  ReconciliationDecisionView,
  RecordAdministrationArgs,
  RecordCaregiverAttestedArgs,
  RecordDecisionArgs,
  RecordRefusalArgs,
  ScheduledDoseView,
  WitnessAttestArgs,
  WorksheetView,
} from "./routes/service";

/** Sentinel patient/admission anchors when no scheduled dose supplies them (the in-mem `findPatient` values). */
const PATIENT_SENTINEL = "00000000-0000-4000-8000-0000000000aa";
const ADMISSION_SENTINEL = "00000000-0000-4000-8000-0000000000bb";
/**
 * §7.4 witness-attestation HMAC secret (TASK-008, SEC-001). Externalized via `M13_WITNESS_SIGNING_KEY`
 * (validated ≥32 chars at boot by `bootstrap/env.ts` in production); a fixed dev-only value covers
 * dev/test so mint + verify still round-trip without the var set. Read once at module load — mirrors
 * the existing module-level `WITNESS_SECRET` shape, and doubles as a second, defense-in-depth
 * fail-closed check in case this module is ever imported before `assertProductionEnv()` runs.
 */
function resolveWitnessSigningKey(): string {
  const configured = process.env.M13_WITNESS_SIGNING_KEY;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("M13_WITNESS_SIGNING_KEY is required in production (TASK-008)");
  }
  return "wardenx-m13-witness-secret-dev-only-do-not-use-in-prod";
}
const WITNESS_SECRET = resolveWitnessSigningKey();

/** The transactional-outbox port (§4.4): the bound publisher validates every emit against the boot catalog
 * and writes the `outbox_event` row on the CALLER'S tx. The no-op default lets the slice/tests commit without
 * a dispatcher. Mirrors M7/M8/M9/M10/M11/M12. */
export interface EmarWriteOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}
const NOOP_OUTBOX: EmarWriteOutboxPort = { async publish() {} };

/**
 * The M5 care-team reach M13's §2.9 D10 caregiver-review gate needs (GAP-022): who is this patient's RN
 * CASE MANAGER? Restated locally as a one-method port (the `CareTeamProvider` seam's `primaryRnUserId`
 * half) so this module takes no compile edge on M5 — the composition root passes a thunk over
 * `getSeam("CareTeamProvider")`.
 */
export interface EmarCaseManagerPort {
  primaryRnUserId(input: {
    organizationId: string;
    patientId: string;
  }): Promise<string | null>;
}

/**
 * Fail-closed default: no patient has a resolvable case manager, so `caregiver_attested_review_required`
 * denies. This is what the slice/unit tests get, and it is the SAME answer the old hardcoded `false`
 * produced — the difference is that production now binds a real reader instead of inheriting the stub.
 */
const UNBOUND_CASE_MANAGER: EmarCaseManagerPort = {
  async primaryRnUserId() {
    return null;
  },
};

/**
 * F-031 — the M12 medication-order reach every administration write needs: WHICH PATIENT is this order for?
 *
 * Restated locally as a one-method port (the `MedicationOrderProvider` seam's `getAdministrationContext`
 * half, narrowed to the identity facts M13 files the row under) so this module takes no compile edge on
 * M12 — the composition root passes a thunk over `getSeam("MedicationOrderProvider")`, exactly the shape
 * {@link EmarCaseManagerPort} already uses for M5.
 *
 * Narrowed on purpose: the seam also answers `allowAdministration`/`blockedReasons`, and this port does not
 * carry them. Arming that gate is a separate decision with a real blast radius (see compromise (3) in the
 * file header) — quietly importing it alongside the identity fix would have coupled a correctness repair to
 * a policy change nobody reviewed.
 */
export interface EmarMedicationOrderPort {
  administrationIdentity(input: {
    organizationId: string;
    medicationOrderId: string;
  }): Promise<{
    readonly patientId: string;
    readonly admissionId: string;
    readonly drugName: string;
    readonly route: string;
    /**
     * §2.11 D11 — the titration bounds the order authorises, or null when it authorises none. The IV
     * branch hands this to `planIvSegment`, which refuses a `rate_change` against a null policy
     * (`IV_RATE_OUT_OF_RANGE`): an infusion rate nobody bounded is a rate nobody prescribed.
     */
    readonly ivContinuousPolicy: { readonly minRate: number; readonly maxRate: number } | null;
    /** §2.9 D6 — may this order be administered at all? M12's `getAdministrationContext` verdict. */
    readonly allowAdministration: boolean;
    /** The reasons behind a `false` verdict, echoed to the caller so the refusal names itself. */
    readonly blockedReasons: readonly string[];
  } | null>;
}

/**
 * Fail-closed default: no order resolves, so an administration that names no scheduled dose is REFUSED.
 * That is a behaviour change from the sentinel fallback it replaces, and it is the point — the sentinel
 * made an unresolvable order look like a successful write. Callers that supply a `scheduledDoseId` are
 * unaffected: the dose already carries the patient and admission, and this port is never consulted.
 */
const UNBOUND_MEDICATION_ORDER: EmarMedicationOrderPort = {
  async administrationIdentity() {
    return null;
  },
};

/** The §2.1 per-mode `data` fields the IV branch reads. The mode catalog names them: `iv_continuous_start`
 *  carries `infusionRate`, `iv_continuous_rate_change` carries `previousRate`/`newRate`/`titrationReason`,
 *  `iv_continuous_stop` may carry `wastageAmount`. Read defensively — `data` is `Type.Unknown()` at the
 *  route boundary by design (the server discriminates on `mode`). */
function ivBodyOf(data: unknown): { newRate: number | null; wastageAmount: number | null } {
  const d = (data ?? {}) as { newRate?: unknown; wastageAmount?: unknown };
  return {
    newRate: typeof d.newRate === "number" ? d.newRate : null,
    wastageAmount: typeof d.wastageAmount === "number" ? d.wastageAmount : null,
  };
}

/** The rate a stored segment carries, per the same mode catalog. Mirrors `segmentRateOf` in the seam store
 *  — the projection and the write path must read the same keys or the derived session state disagrees with
 *  the one the seam publishes. */
function ivRateOf(data: unknown): { rate?: number; rateUnit?: string } {
  const d = (data ?? {}) as Record<string, unknown>;
  const rate = [d.infusionRate, d.newRate, d.rate].find((v) => typeof v === "number") as
    | number
    | undefined;
  const rateUnit = [d.rateUnit, d.infusionRateUnit].find((v) => typeof v === "string") as
    | string
    | undefined;
  return {
    ...(rate !== undefined ? { rate } : {}),
    ...(rateUnit !== undefined ? { rateUnit } : {}),
  };
}

const ADM = schema.administrationRecords;
const SD = schema.scheduledDoses;
const MD = schema.missedDoses;
const WS = schema.medicationReconciliationWorksheets;
const RD = schema.medicationReconciliationDecisions;
const CKD = schema.comfortKitDeployments;
const POL = schema.administrationPolicy;
const BSE = schema.barcodeScanEvents;
const WIT = schema.administrationWitnesses;
const MEM = schema.memberships;
const MEM_ROLE = schema.membershipRoles;
const ROLE = schema.roles;

/** The in-memory slice's default policy (returned when the org has no `administration_policy` row). */
const DEFAULT_POLICY: AdministrationPolicyView = {
  graceWindowMinutes: 30,
  prnMinimumIntervalMinutes: 60,
  emarPdfOnCommit: false,
};

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

/** Map an `administration_record` row (+ its captured barcode match) to the read projection. */
type AdminRow = typeof ADM.$inferSelect;
const toAdminView = (r: AdminRow, match: BarcodeMatchResult | null): AdministrationView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  medicationOrderId: r.medicationOrderId,
  mode: r.mode,
  status: r.status,
  actorKind: r.actorKind,
  administeredAt: iso(r.administeredAt)!,
  recordedAt: iso(r.recordedAt)!,
  lateEntryTier: r.lateEntryTier,
  administeringClinicianMembershipId: r.administeringClinicianMembershipId ?? null,
  witnessMembershipId: r.witnessMembershipId ?? null,
  encounterId: r.encounterId ?? null,
  scheduledDoseId: r.scheduledDoseId ?? null,
  comfortKitDeploymentId: r.comfortKitDeploymentId ?? null,
  ivSessionId: r.ivSessionId ?? null,
  isControlledSubstance: r.isControlledSubstance,
  isComfortKitDrawdown: r.isComfortKitDrawdown,
  requiresRnReview: r.requiresRnReview,
  // No forward "superseded_by" pointer exists on the row (only `corrects_administration_id`, the inverse).
  supersededById: null,
  barcodeMatchResult: match,
});

const toWorksheetView = (
  w: typeof WS.$inferSelect,
  decisions: readonly ReconciliationDecisionView[],
): WorksheetView => ({
  id: w.id,
  patientId: w.patientId,
  admissionId: w.admissionId,
  triggerKind: w.triggerKind,
  status: w.status,
  lineCount: decisions.length,
  decisions,
});

const toDecisionView = (d: typeof RD.$inferSelect): ReconciliationDecisionView => ({
  lineId: d.id,
  lineKind: d.lineKind,
  sourceId: d.m12MedicationOrderId ?? d.m12MedicationHistoryRecordId ?? d.id,
  decision: d.decisionKind,
  resultingMedicationOrderId: d.resultingMedicationOrderId ?? null,
});

/**
 * The production, RLS-backed EmarRouteService + EmarAbacResolver. Reads + the write lifecycle are live over
 * Drizzle+RLS; every mutation emits `m13.*` on the bound transactional `outbox`. Org is bound from the request
 * context by the caller and passed as `orgId` — never the body.
 */
export function createDbEmarBackend(
  db: DbClient,
  outbox: EmarWriteOutboxPort = NOOP_OUTBOX,
  /**
   * GAP-022 — the M5 case-manager reader. A THUNK, not an instance: seams are registered by the
   * composition root's `wireModuleSeams()`, which runs after the route mount, so resolving at
   * construction time would capture the pre-registration state.
   */
  caseManager: () => EmarCaseManagerPort = () => UNBOUND_CASE_MANAGER,
  /**
   * F-031 — the M12 order reader, a THUNK for the same reason `caseManager` is one: seams register after
   * the route mount, so resolving at construction time would capture the pre-registration deny-stub.
   */
  medicationOrder: () => EmarMedicationOrderPort = () => UNBOUND_MEDICATION_ORDER,
): EmarRouteService {
  const withOrg = <T>(orgId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: orgId, userId: "" }, fn as never) as Promise<T>;
  const careTeam = caseManager;
  const medOrder = medicationOrder;

  /** Emit one `m13.*` event on the caller's tx (validated + persisted by the bound publisher). */
  async function emit(
    tx: unknown,
    orgId: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, {
      eventName,
      payload,
      organizationId: orgId,
      aggregateKind,
      aggregateId,
    });
  }

  /** Load a single administration_record (RLS-scoped) or the non-leaking 404. */
  async function loadAdmin(tx: DbClient, id: string): Promise<AdminRow> {
    const [r] = await tx.select().from(ADM).where(eq(ADM.id, id)).limit(1);
    if (!r) throw new NotFoundError("administration not found");
    return r;
  }
  /** Re-read one administration (post-write) as the wire view (with its captured barcode match). */
  async function readAdmin(tx: DbClient, id: string): Promise<AdministrationView> {
    const r = await loadAdmin(tx, id);
    const m = await matchResults(tx, [r.id]);
    return toAdminView(r, m.get(r.id) ?? null);
  }
  /** Load the worksheet (RLS-scoped) or the non-leaking 404. */
  async function loadWorksheet(tx: DbClient, id: string): Promise<typeof WS.$inferSelect> {
    const [w] = await tx.select().from(WS).where(eq(WS.id, id)).limit(1);
    if (!w) throw new NotFoundError("reconciliation worksheet not found");
    return w;
  }
  /** Re-read one worksheet (post-write) as the wire view (with its decision lines). */
  async function readWorksheet(tx: DbClient, id: string): Promise<WorksheetView> {
    const w = await loadWorksheet(tx, id);
    const decisions = await tx.select().from(RD).where(eq(RD.worksheetId, id));
    return toWorksheetView(w, decisions.map(toDecisionView));
  }
  /** The scheduled_dose row as the wire view. */
  const toScheduledView = (s: typeof SD.$inferSelect): ScheduledDoseView => ({
    id: s.id,
    patientId: s.patientId,
    medicationOrderId: s.medicationOrderId,
    dueAt: iso(s.dueAt)!,
    status: s.status,
  });

  /** Batch-load the captured barcode `match_result` for a set of administration ids. */
  async function matchResults(
    tx: DbClient,
    ids: readonly string[],
  ): Promise<Map<string, BarcodeMatchResult>> {
    const out = new Map<string, BarcodeMatchResult>();
    if (ids.length === 0) return out;
    const rows = await tx
      .select({ adminId: BSE.administrationRecordId, match: BSE.matchResult })
      .from(BSE)
      .where(inArray(BSE.administrationRecordId, ids as string[]));
    for (const row of rows) {
      if (row.adminId && !out.has(row.adminId))
        out.set(row.adminId, row.match as BarcodeMatchResult);
    }
    return out;
  }

  return {
    // ── EmarAbacResolver (§4.7 predicate facts) ────────────────────────────────────────────────────────
    async loadWitnessFacts(orgId: string, witnessUserId: string): Promise<WitnessAbacFacts | null> {
      // GAP-021 — the M2 organization_membership + M3 membership_role read the TODO deferred (the M30
      // `loadMemberRoleKeys` precedent: membership_role → role, LIVE i.e. unexpired grants only).
      return withOrg(orgId, async (tx) => {
        const [mem] = await tx
          .select({ id: MEM.id, status: MEM.status })
          .from(MEM)
          .where(and(eq(MEM.organizationId, orgId), eq(MEM.userId, witnessUserId)))
          .limit(1);
        if (!mem) return null; // no membership on this tenant → fail closed
        const roleRows = await tx
          .select({ key: ROLE.key })
          .from(MEM_ROLE)
          .innerJoin(ROLE, eq(MEM_ROLE.roleId, ROLE.id))
          .where(
            and(
              eq(MEM_ROLE.organizationId, orgId),
              eq(MEM_ROLE.membershipId, mem.id),
              // time-bound roles (on-call elevation, §7.2): only the live, unexpired grants count.
              or(isNull(MEM_ROLE.expiresAt), gt(MEM_ROLE.expiresAt, new Date())),
            ),
          );
        const roleKeys = roleRows.map((r) => r.key);
        // The pure eligibility check needs ONE discipline value; prefer a WITNESS_ELIGIBLE_DISCIPLINES
        // match (a clinician often holds several roles) so an ineligible-discipline witness still renders
        // the precise `discipline_ineligible` reason rather than an arbitrary held role.
        const witnessDiscipline =
          roleKeys.find((k) =>
            (WITNESS_ELIGIBLE_DISCIPLINES as readonly string[]).includes(k.toLowerCase()),
          ) ??
          roleKeys[0] ??
          "";
        return {
          witnessMembershipId: mem.id,
          witnessDiscipline,
          witnessMembershipActive: mem.status === "active",
          // The query above is already scoped to `orgId` — a resolved row is same-tenant by construction.
          sameTenant: true,
          // Portal caregivers are never `organization_membership` rows (a distinct M31 actor kind) — a
          // resolved staff membership can never BE a caregiver.
          witnessIsCaregiver: false,
          // Not resolvable from (orgId, userId) alone — a genuine break-glass grant is a per-request /
          // per-predicate-evaluation fact (requireAbac's own branch), not a queryable session-wide one.
          // Documented gap: a break-glass witness is still correctly ELIGIBLE here (the security control
          // is real), it just never gets the extra warn-audit event a true break-glass witness should.
          witnessIsBreakGlass: false,
        };
      });
    },
    async loadCaregiverReviewFacts(
      orgId,
      administrationId,
      actorUserId,
    ): Promise<CaregiverReviewAbacFacts | null> {
      // GAP-022 — `actorIsRnCaseManager` was hardcoded `false` here, and since the predicate is
      // `requiresRnReview && actorIsRnCaseManager`, BOTH §2.9 D10 caregiver-review routes
      // (acknowledge-caregiver / dispute-caregiver) returned 404-on-deny for every caller in every
      // tenant — the RN review step M31's caregiver-attested doses require had no reachable actor.
      const row = await withOrg(orgId, async (tx) => {
        const [r] = await tx
          .select({ requiresRnReview: ADM.requiresRnReview, patientId: ADM.patientId })
          .from(ADM)
          .where(eq(ADM.id, administrationId))
          .limit(1);
        return r ?? null;
      });
      if (!row) return null;
      // The case-manager read is a SEPARATE org-scoped call, not folded into the tx above: the answer
      // lives on M5's `patient_assignment` and M13 must not read that table (`arch:tables`), so it comes
      // through M5's published CareTeamProvider seam. Resolved lazily per call — the composition root
      // registers seams after the route mount, so a construction-time resolve would capture nothing.
      const caseManagerUserId = await careTeam().primaryRnUserId({
        organizationId: orgId,
        patientId: row.patientId,
      });
      return {
        requiresRnReview: row.requiresRnReview,
        // Both id spaces are USER ids: `patient_assignment.clinician_user_id` references `user`, and the
        // ABAC context's `userId` is what `loadWitnessFacts` already resolves memberships by. An unassigned
        // patient (null case manager) can never match, so an absent assignment still fails closed.
        actorIsRnCaseManager: caseManagerUserId !== null && caseManagerUserId === actorUserId,
      };
    },
    async loadWorksheetTriggerKind(orgId, worksheetId) {
      return withOrg(orgId, async (tx) => {
        const [w] = await tx
          .select({ triggerKind: WS.triggerKind })
          .from(WS)
          .where(eq(WS.id, worksheetId))
          .limit(1);
        return w ? w.triggerKind : null;
      });
    },

    // ── administration reads ─────────────────────────────────────────────────────────────────────────
    async getAdministration(orgId, id): Promise<AdministrationView> {
      return withOrg(orgId, async (tx) => {
        const [r] = await tx.select().from(ADM).where(eq(ADM.id, id)).limit(1);
        if (!r) throw new NotFoundError("administration not found");
        const m = await matchResults(tx, [r.id]);
        return toAdminView(r, m.get(r.id) ?? null);
      });
    },
    async listAdministrations(orgId, q): Promise<AdministrationView[]> {
      return withOrg(orgId, async (tx) => {
        const conds = [eq(ADM.patientId, q.patient)];
        if (q.since) conds.push(gte(ADM.administeredAt, new Date(q.since)));
        if (q.until) conds.push(lte(ADM.administeredAt, new Date(q.until)));
        const rows = await tx
          .select()
          .from(ADM)
          .where(and(...conds));
        const m = await matchResults(
          tx,
          rows.map((r) => r.id),
        );
        return rows.map((r) => toAdminView(r, m.get(r.id) ?? null));
      });
    },
    async getIvSession(orgId, sessionId): Promise<IvSessionView> {
      return withOrg(orgId, async (tx) => {
        // F-031/#134 — ordered by the clinical `administered_at`, which is the order the §2.11 graph is
        // legal in, and voided segments dropped (entered-in-error). This used to select unordered and
        // project `recorded_at`, so the sequence a reader saw was the SERVER-RECEIVE order — fine while
        // nothing could create a session, wrong the moment one exists and a segment is back-dated.
        const segs = await tx
          .select()
          .from(ADM)
          .where(and(eq(ADM.ivSessionId, sessionId), ne(ADM.status, "voided")))
          .orderBy(asc(ADM.administeredAt), asc(ADM.recordedAt), asc(ADM.id));
        if (segs.length === 0) throw new NotFoundError("iv session not found");
        const ordered: IvSegment[] = segs.map((r) => ({
          mode: r.mode as IvSegmentMode,
          administeredAt: iso(r.administeredAt) as string,
          ...ivRateOf(r.data),
        }));
        // `composeIvSession` is the pure projection the seam consumers already read; the route DTO now
        // derives from the same core rather than a second, looser reading of the same rows. It requires
        // the first segment to be a `start`, which is the invariant the write path enforces.
        const session = composeIvSession(sessionId, segs[0]!.medicationOrderId, ordered, null);
        return {
          sessionId,
          medicationOrderId: session.medicationOrderId,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          state: deriveIvSessionState(ordered),
          segments: session.segments.map((seg) => ({
            kind: seg.mode,
            recordedAt: seg.administeredAt,
            rate: seg.rate,
            rateUnit: seg.rateUnit,
          })),
        };
      });
    },

    // ── scheduled / missed dose reads ──────────────────────────────────────────────────────────────────
    async listScheduledDoses(orgId, q): Promise<ScheduledDoseView[]> {
      return withOrg(orgId, async (tx) => {
        const conds = [eq(SD.patientId, q.patient)];
        if (q.from) conds.push(gte(SD.dueAt, new Date(q.from)));
        if (q.to) conds.push(lte(SD.dueAt, new Date(q.to)));
        const rows = await tx
          .select({
            id: SD.id,
            patientId: SD.patientId,
            medicationOrderId: SD.medicationOrderId,
            dueAt: SD.dueAt,
            status: SD.status,
          })
          .from(SD)
          .where(and(...conds));
        return rows.map((s) => ({
          id: s.id,
          patientId: s.patientId,
          medicationOrderId: s.medicationOrderId,
          dueAt: iso(s.dueAt)!,
          status: s.status,
        }));
      });
    },
    async listMissedDoses(orgId, q): Promise<MissedDoseView[]> {
      return withOrg(orgId, async (tx) => {
        // `missed_dose` carries no due_at — it is the scheduled dose's; join to source it (and filter `since`).
        const conds = [eq(MD.patientId, q.patient)];
        if (q.since) conds.push(gte(SD.dueAt, new Date(q.since)));
        const rows = await tx
          .select({
            id: MD.id,
            patientId: MD.patientId,
            scheduledDoseId: MD.scheduledDoseId,
            medicationOrderId: MD.medicationOrderId,
            dueAt: SD.dueAt,
            acknowledgedAt: MD.acknowledgedAt,
          })
          .from(MD)
          .innerJoin(SD, eq(MD.scheduledDoseId, SD.id))
          .where(and(...conds));
        return rows.map((m) => ({
          id: m.id,
          patientId: m.patientId,
          scheduledDoseId: m.scheduledDoseId,
          medicationOrderId: m.medicationOrderId,
          dueAt: iso(m.dueAt)!,
          acknowledgedAt: iso(m.acknowledgedAt),
        }));
      });
    },

    // ── reconciliation worksheet reads (worksheet + its decision lines) ──────────────────────────────────
    async listWorksheets(orgId, patient): Promise<WorksheetView[]> {
      return withOrg(orgId, async (tx) => {
        const sheets = await tx.select().from(WS).where(eq(WS.patientId, patient));
        if (sheets.length === 0) return [];
        const decisions = await tx
          .select()
          .from(RD)
          .where(
            inArray(
              RD.worksheetId,
              sheets.map((w) => w.id),
            ),
          );
        const byWorksheet = new Map<string, ReconciliationDecisionView[]>();
        for (const d of decisions) {
          const list = byWorksheet.get(d.worksheetId) ?? [];
          list.push(toDecisionView(d));
          byWorksheet.set(d.worksheetId, list);
        }
        return sheets.map((w) => toWorksheetView(w, byWorksheet.get(w.id) ?? []));
      });
    },
    async getWorksheet(orgId, id): Promise<WorksheetView> {
      return withOrg(orgId, async (tx) => {
        const [w] = await tx.select().from(WS).where(eq(WS.id, id)).limit(1);
        if (!w) throw new NotFoundError("reconciliation worksheet not found");
        const decisions = await tx.select().from(RD).where(eq(RD.worksheetId, id));
        return toWorksheetView(w, decisions.map(toDecisionView));
      });
    },

    // ── comfort-kit deployment reads ─────────────────────────────────────────────────────────────────
    async listDeployments(orgId, patient): Promise<DeploymentView[]> {
      return withOrg(orgId, async (tx) => {
        const rows = await tx
          .select({
            id: CKD.id,
            patientId: CKD.patientId,
            admissionId: CKD.admissionId,
            disposalStatus: CKD.disposalStatus,
          })
          .from(CKD)
          .where(eq(CKD.patientId, patient));
        return rows.map((d) => ({
          id: d.id,
          patientId: d.patientId,
          admissionId: d.admissionId,
          disposalStatus: d.disposalStatus,
        }));
      });
    },
    async getDeployment(orgId, id): Promise<DeploymentView> {
      return withOrg(orgId, async (tx) => {
        const [d] = await tx
          .select({
            id: CKD.id,
            patientId: CKD.patientId,
            admissionId: CKD.admissionId,
            disposalStatus: CKD.disposalStatus,
          })
          .from(CKD)
          .where(eq(CKD.id, id))
          .limit(1);
        if (!d) throw new NotFoundError("comfort-kit deployment not found");
        return {
          id: d.id,
          patientId: d.patientId,
          admissionId: d.admissionId,
          disposalStatus: d.disposalStatus,
        };
      });
    },

    // ── administration policy read (org singleton; slice defaults when unset) ────────────────────────────
    async getPolicy(orgId): Promise<AdministrationPolicyView> {
      return withOrg(orgId, async (tx) => {
        const [p] = await tx
          .select({
            grace: POL.defaultGraceWindowMinutes,
            prn: POL.defaultPrnReassessmentWindowMinutes,
            pdf: POL.emarPerAdministrationPdfEnabled,
          })
          .from(POL)
          .limit(1);
        return p
          ? {
              graceWindowMinutes: p.grace,
              prnMinimumIntervalMinutes: p.prn,
              emarPdfOnCommit: p.pdf,
            }
          : { ...DEFAULT_POLICY };
      });
    },

    // ── administration writes (§2.2 lifecycle; the service does the transitions, no DB triggers) ─────────
    async recordAdministration(
      orgId,
      userId,
      args: RecordAdministrationArgs,
    ): Promise<AdministrationView> {
      return withOrg(orgId, async (tx) => {
        const recordedAt = new Date();
        const lateEntryTier = resolveLateEntryTier(args.administeredAt, recordedAt.toISOString());
        const isControlled = args.medClass === "controlled_substance";
        const isComfortKitDrawdown = Boolean(args.comfortKitDeploymentId);

        // Siting + patient/admission anchor come from the scheduled dose when named; else null siting +
        // sentinels (compromise #2). The M12 order-context gates (D6/five-rights) are skipped (compromise #3).
        const sched = args.scheduledDoseId
          ? (await tx.select().from(SD).where(eq(SD.id, args.scheduledDoseId)).limit(1))[0]
          : undefined;
        // F-031 — the dose, when there is one, is the anchor for patient/admission (it carries siting as
        // well). The ORDER is what answers everything else, through `getAdministrationContext` — the seam
        // written for exactly this question. Resolved UNCONDITIONALLY, not only on the no-dose path: the
        // §2.11 IV branch needs the order's titration bounds whether or not a scheduled dose named the row,
        // and the drug-name snapshot is worth having on both paths. Nothing is invented — an order that
        // resolves to nothing on the no-dose path refuses, because a row filed under a placeholder patient
        // is not a weaker record, it is a record of a different patient.
        const identity = await medOrder().administrationIdentity({
          organizationId: orgId,
          medicationOrderId: args.medicationOrderId,
        });
        if (!sched && identity === null)
          throw new ValidationError(
            "the medication order for this administration is unresolvable",
            [
              {
                field: "medicationOrderId",
                code: "MEDICATION_ORDER_UNRESOLVED",
                message:
                  "no scheduled dose was named and the medication order could not be read, so the patient this dose was given to is unknown",
              },
            ],
          );
        // §2.9 D6 — is this order administrable at all? ARMED (F-058). It was threaded for the identity
        // facts and deliberately left off, because only `status = "active"` clears M12's verdict and
        // nothing in the platform activated an order — so arming it would have refused every
        // administration the system could produce. A signed order that is not being e-prescribed now
        // activates on signature and a verbal order is administrable per §2.3, so the verdict finally
        // distinguishes "ready to give" from "discontinued / replaced / never signed". A caller who
        // supplies a scheduled dose is NOT exempt: the dose was materialized from this same order.
        if (identity && !identity.allowAdministration)
          throw new AdministrationStateError(
            "ADMINISTRATION_BLOCKED",
            `the medication order is not administrable: ${identity.blockedReasons.join(", ") || "not_active"}`,
          );
        const patientId = sched?.patientId ?? identity?.patientId ?? PATIENT_SENTINEL;
        const admissionId = sched?.admissionId ?? identity?.admissionId ?? ADMISSION_SENTINEL;

        // ── §2.11 D11 — the IV-continuous session (F-031/#134) ────────────────────────────────────────
        //
        // `administration_record.iv_session_id` used to be written NOWHERE: the production path never set
        // it and the in-memory slice hard-coded it null, so no session could exist, `getIvSession` 404'd
        // for every input, and `IV_SESSION_GRAPH` / `assertIvSegmentLegal` / `checkIvRateBounds` — all
        // real, all unit-tested in @wardenx/emar — were called by nothing. The ordering graph and the
        // titration bounds were enforced at runtime by no one.
        //
        // `planIvSegment` is that core, and it is the authority here rather than a re-derivation: it
        // asserts the segment is legal from the state the PRIOR segments derive, validates the rate
        // against the order's bounds, and returns the two facts the §2.2 commit needs — whether this
        // segment mints the session, and whether it requires the D7 witness. Note the witness rule it
        // returns is NARROWER than "controlled": a controlled infusion is witnessed at the segments that
        // begin, alter or end administration (start / rate_change / stop) and NOT at pause/resume, which
        // change no dose. Applying the blanket controlled-substance rule to a pause would demand a second
        // clinician at the bedside to stop a running pump.
        const modeMeta = ADMINISTRATION_MODE_CATALOG[args.mode];
        let ivSessionId: string | null = null;
        let ivPlan: ReturnType<typeof planIvSegment> | null = null;
        if (modeMeta.isIvContinuous) {
          const ivMode = args.mode as IvSegmentMode;
          if (modeMeta.ivSessionRole === "mint") {
            if (args.ivSessionId)
              throw new ValidationError("an IV-continuous start mints its own session", [
                {
                  field: "ivSessionId",
                  code: "INVALID",
                  message: "iv_continuous_start must not name an existing session",
                },
              ]);
          } else if (!args.ivSessionId) {
            throw new ValidationError("this IV segment must name its session", [
              {
                field: "ivSessionId",
                code: "REQUIRED",
                message: `${args.mode} continues an existing IV session and requires its ivSessionId`,
              },
            ]);
          }
          // The prior sequence, in the clinical `administered_at` order the graph is legal in (the
          // `admin_rec_iv_session_idx` ascending order). A voided segment is entered-in-error and drops
          // out, exactly as the seam projection already treats it.
          //
          // `recorded_at` is the tiebreak, and it is load-bearing rather than tidy: a clinician enters
          // `administered_at` from a datetime-local control, which has MINUTE resolution, so a start and
          // the titration that follows it a few seconds later carry the identical clinical instant. With
          // only `id` to break the tie the order was a random uuid comparison — which meant the derived
          // session state was a coin flip, and `composeIvSession` could refuse a perfectly good session
          // for "not beginning with a start". When two segments share an instant, the order they were
          // RECORDED in is the only evidence of sequence there is.
          const priorSegments: IvSegment[] = args.ivSessionId
            ? (
                await tx
                  .select()
                  .from(ADM)
                  .where(and(eq(ADM.ivSessionId, args.ivSessionId), ne(ADM.status, "voided")))
                  .orderBy(asc(ADM.administeredAt), asc(ADM.id))
              ).map((r) => ({
                mode: r.mode as IvSegmentMode,
                administeredAt: iso(r.administeredAt) as string,
                ...ivRateOf(r.data),
              }))
            : [];
          if (args.ivSessionId && priorSegments.length === 0)
            throw new NotFoundError("iv session not found");
          const body = ivBodyOf(args.data);
          ivPlan = planIvSegment(deriveIvSessionState(priorSegments), {
            mode: ivMode,
            isControlled,
            newRate: body.newRate,
            policy: identity?.ivContinuousPolicy ?? null,
            wastageAmount: body.wastageAmount,
          });
          ivSessionId = ivPlan.mintsSession ? randomUUID() : (args.ivSessionId ?? null);
        }
        // Non-IV: every controlled administration is witnessed. IV: the pure core's narrower rule.
        const requiresWitness = ivPlan ? ivPlan.requiresWitness : isControlled;

        // D7 — a controlled administration requires a valid, in-scope, unexpired witness-attestation token.
        let witnessMembershipId: string | null = null;
        let witnessDigest: string | null = null;
        if (requiresWitness) {
          const verify = args.witnessToken
            ? verifyWitnessAttestationToken({
                token: args.witnessToken,
                secret: WITNESS_SECRET,
                expectedScope: {
                  patientId,
                  medicationOrderId: args.medicationOrderId,
                  administeringClinicianMembershipId: userId,
                },
                nowMs: Date.now(),
              })
            : ({ ok: false, reason: "WITNESS_TOKEN_INVALID" } as const);
          if (!verify.ok)
            throw new ValidationError(
              "a controlled-substance administration requires a witness attestation",
              [
                {
                  field: "X-Witness-Attestation",
                  code: "WITNESS_REQUIRED",
                  message: `witness attestation ${verify.reason}`,
                },
              ],
            );
          // Single-use burn (TASK-008): a valid, unexpired, in-scope token can still be a REPLAY of one
          // already consumed by an earlier administration. The `administration_witness` unique index on
          // `attestation_token_digest` (mig 0160) is the structural, cluster-wide backstop; this pre-check
          // turns the would-be 23505 into the same friendly D7 rejection as an invalid/expired token
          // (mirrors the M15 `volunteer_compliance_gate` precedent).
          const priorBurn = await tx
            .select({ id: WIT.id })
            .from(WIT)
            .where(eq(WIT.attestationTokenDigest, verify.digest))
            .limit(1);
          if (priorBurn.length > 0)
            throw new ValidationError(
              "a controlled-substance administration requires a witness attestation",
              [
                {
                  field: "X-Witness-Attestation",
                  code: "WITNESS_REQUIRED",
                  message: "witness attestation WITNESS_TOKEN_ALREADY_USED",
                },
              ],
            );
          witnessMembershipId = verify.claims.witnessMembershipId;
          witnessDigest = verify.digest;
        }

        // §2.9 BCMA — evaluate the scan against a permissive order context (compromise #3); a wrong/expired
        // scan still hard-blocks. Persisted after the administration row (it back-refs the new id).
        let barcodeMatchResult: BarcodeMatchResult | null = null;
        if (args.barcodeScan) {
          barcodeMatchResult = evaluateBarcodeScan(
            args.barcodeScan,
            { orderActive: true, rxnormRxcui: null, ndc: null },
            { wristbandPayloadDigest: null },
            args.administeredAt.slice(0, 10),
          );
          if (barcodeScanBlocks(barcodeMatchResult))
            throw new AdministrationStateError(
              "BARCODE_VERIFICATION_FAILED",
              `barcode verification failed: ${barcodeMatchResult}`,
            );
        }

        const inserted = (
          await tx
            .insert(ADM)
            .values({
              organizationId: orgId,
              providerEntityId: sched?.providerEntityId ?? null,
              locationId: sched?.locationId ?? null,
              patientId,
              admissionId,
              medicationOrderId: args.medicationOrderId,
              scheduledDoseId: args.scheduledDoseId ?? null,
              encounterId: args.encounterId ?? null,
              comfortKitDeploymentId: args.comfortKitDeploymentId ?? null,
              ivSessionId,
              mode: args.mode,
              status: "committed",
              // F-031 — the per-mode body is PERSISTED now; it used to be written as `{}` on every row. The
              // §3.3 schema puts each mode's own fields there by design (infusionRate / titrationReason /
              // pauseReason / stopReason / wastageAmount / siteOfAdministration), the §3.6 audit trigger
              // already scrubs the denylisted json-paths inside it, and the IV session projection reads the
              // rate straight out of it — so an empty `data` was not a safe default, it was the reason a
              // recorded segment could carry no rate.
              data: typeof args.data === "object" && args.data !== null ? args.data : {},
              // F-031 — the drug AS ADMINISTERED, snapshotted from the order at commit time. It used to be
              // the empty string on every row, which is the one value a medication administration record
              // must never carry: the order can later be corrected or discontinued, and the MAR is supposed
              // to say what was given, not what the order says today.
              drugNameSnapshot: identity?.drugName ?? "",
              routeSnapshot: args.route ?? identity?.route ?? "",
              doseAmountSnapshot: args.doseAmount != null ? String(args.doseAmount) : null,
              doseUnitSnapshot: args.doseUnit ?? null,
              isControlledSubstance: isControlled,
              isComfortKitDrawdown,
              administeredAt: new Date(args.administeredAt),
              recordedAt,
              actorKind: "clinician",
              administeringClinicianMembershipId: userId,
              witnessMembershipId,
              witnessAttestationTokenDigest: witnessDigest,
              witnessAttestedAt: witnessMembershipId ? recordedAt : null,
              lateEntryTier,
              lateEntryReason: args.lateEntryReason ?? null,
              offlineCapture: Boolean(args.offlineCapture),
              deviceId: args.offlineCapture?.deviceId ?? null,
              localId: args.offlineCapture?.localId ?? null,
            })
            .returning()
        )[0]!;

        if (args.scheduledDoseId)
          await tx
            .update(SD)
            .set({ status: "administered", administeredAt: new Date(args.administeredAt) })
            .where(eq(SD.id, args.scheduledDoseId));

        if (requiresWitness && witnessMembershipId)
          await tx.insert(schema.administrationWitnesses).values({
            organizationId: orgId,
            administrationRecordId: inserted.id,
            witnessMembershipId,
            witnessesScope: "administration_only",
            attestationText:
              "I attest I observed the controlled-substance administration (§2.6 D7).",
            attestationTokenDigest: witnessDigest ?? "",
          });

        if (args.barcodeScan)
          await tx.insert(BSE).values({
            organizationId: orgId,
            administrationRecordId: inserted.id,
            scannedNdc: args.barcodeScan.scannedNdc ?? null,
            scannedRxnormRxcui: args.barcodeScan.scannedRxnormRxcui ?? null,
            scannedExpirationDate: args.barcodeScan.scannedExpirationDate ?? null,
            patientWristbandPayloadDigest: args.barcodeScan.patientWristbandPayloadDigest ?? null,
            matchResult: barcodeMatchResult ?? "match",
          });

        await emit(tx, orgId, "m13.administration.recorded", "administration_record", inserted.id, {
          administrationRecordId: inserted.id,
          patientId,
          admissionId,
          medicationOrderId: args.medicationOrderId,
          mode: args.mode,
          administeredAt: args.administeredAt,
          isControlled,
          isComfortKitDrawdown,
          encounterId: args.encounterId ?? null,
          scheduledDoseId: args.scheduledDoseId ?? null,
        });
        if (requiresWitness && witnessMembershipId)
          await emit(
            tx,
            orgId,
            "m13.administration.controlled_witnessed",
            "administration_record",
            inserted.id,
            {
              administrationRecordId: inserted.id,
              witnessMembershipId,
              witnessesScope: "administration_only",
            },
          );
        // §2.11 — a controlled infusion stopped with drug left in the bag destroys the remainder, and the
        // destruction carries its own witness. `planIvSegment` is what decides this happened; the event has
        // been catalogued since M13-T08 with no emitter, so the DEA-relevant wastage of a controlled
        // infusion was recorded in the row's `data` and announced to nobody.
        if (ivPlan?.hasControlledWastage && witnessMembershipId) {
          const body = ivBodyOf(args.data);
          await emit(
            tx,
            orgId,
            "m13.administration.controlled_wasted",
            "administration_record",
            inserted.id,
            {
              administrationRecordId: inserted.id,
              wastageAmount: body.wastageAmount ?? 0,
              wastageUnit: args.doseUnit ?? identity?.route ?? "unit",
              witnessMembershipId,
            },
          );
        }
        if (args.prn)
          await emit(
            tx,
            orgId,
            "m13.prn_administration_recorded",
            "administration_record",
            inserted.id,
            {
              prnAdministrationId: randomUUID(),
              administrationRecordId: inserted.id,
              patientId,
              medicationOrderId: args.medicationOrderId,
              administeredAt: args.administeredAt,
              reassessmentDueAt: new Date(
                Date.parse(args.administeredAt) + 60 * 60000,
              ).toISOString(),
              recommendedReassessmentScale: "esas_r",
            },
          );
        return toAdminView(inserted, barcodeMatchResult);
      });
    },

    async mintWitnessToken(
      orgId,
      userId,
      args: WitnessAttestArgs,
    ): Promise<{ token: string; expiresInSeconds: number }> {
      // Stateless HMAC token (compromise #5): mint + verify share the process-fixed secret; the witness's
      // membership is the passed `userId`. No DB write (the single-use Valkey burn is deferred).
      const token = buildWitnessAttestationToken(
        {
          patientId: args.patientId,
          medicationOrderId: args.medicationOrderId,
          administeringClinicianMembershipId: args.administeringClinicianMembershipId,
          witnessMembershipId: userId,
          issuedAtMs: Date.now(),
          nonce: randomUUID(),
        },
        WITNESS_SECRET,
      );
      return { token, expiresInSeconds: 60 };
    },

    async recordCaregiverAttested(
      orgId,
      args: RecordCaregiverAttestedArgs,
    ): Promise<AdministrationView> {
      // §2.9 D10 — the caregiver path records pending_caregiver_review (requires_rn_review=true); the double-
      // witness rule does not apply and encounter_id stays null (D9). The M12 five-rights gate is skipped
      // (compromise #3, no order projection threaded).
      return withOrg(orgId, async (tx) => {
        const inserted = (
          await tx
            .insert(ADM)
            .values({
              organizationId: orgId,
              patientId: args.patientId,
              admissionId: ADMISSION_SENTINEL,
              medicationOrderId: args.medicationOrderId,
              mode: "single_dose",
              status: "pending_caregiver_review",
              data: {},
              drugNameSnapshot: "",
              routeSnapshot: args.route,
              doseAmountSnapshot: String(args.doseAmount),
              doseUnitSnapshot: args.doseUnit,
              administeredAt: new Date(args.administeredAt),
              actorKind: "caregiver_attested",
              actorCaregiverSessionId: args.caregiverSessionId,
              requiresRnReview: true,
            })
            .returning()
        )[0]!;
        await emit(
          tx,
          orgId,
          "m13.administration.recorded_caregiver_attested",
          "administration_record",
          inserted.id,
          {
            administrationRecordId: inserted.id,
            patientId: args.patientId,
            medicationOrderId: args.medicationOrderId,
            caregiverSessionId: args.caregiverSessionId,
            requiresRnReview: true,
          },
        );
        return toAdminView(inserted, null);
      });
    },

    async acknowledgeCaregiver(orgId, userId, id): Promise<AdministrationView> {
      return withOrg(orgId, async (tx) => {
        await loadAdmin(tx, id);
        await tx
          .update(ADM)
          .set({
            requiresRnReview: false,
            status: "committed",
            acknowledgedByMembershipId: userId,
            acknowledgedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(ADM.id, id));
        await emit(
          tx,
          orgId,
          "m13.caregiver_administration.acknowledged",
          "administration_record",
          id,
          {
            administrationRecordId: id,
            acknowledgedBy: userId,
          },
        );
        return readAdmin(tx, id);
      });
    },

    async disputeCaregiver(orgId, userId, id, reason): Promise<AdministrationView> {
      return withOrg(orgId, async (tx) => {
        await loadAdmin(tx, id);
        await tx
          .update(ADM)
          .set({
            requiresRnReview: false,
            disputed: true,
            disputeReason: reason,
            updatedAt: new Date(),
          })
          .where(eq(ADM.id, id));
        await emit(
          tx,
          orgId,
          "m13.caregiver_administration.disputed",
          "administration_record",
          id,
          {
            administrationRecordId: id,
            disputedBy: userId,
            disputeReason: reason,
          },
        );
        return readAdmin(tx, id);
      });
    },

    async correctAdministration(orgId, userId, id, reason): Promise<AdministrationView> {
      return withOrg(orgId, async (tx) => {
        const orig = await loadAdmin(tx, id);
        const inserted = (
          await tx
            .insert(ADM)
            .values({
              organizationId: orgId,
              providerEntityId: orig.providerEntityId,
              locationId: orig.locationId,
              patientId: orig.patientId,
              admissionId: orig.admissionId,
              medicationOrderId: orig.medicationOrderId,
              scheduledDoseId: orig.scheduledDoseId,
              encounterId: orig.encounterId,
              comfortKitDeploymentId: orig.comfortKitDeploymentId,
              mode: orig.mode,
              status: "committed",
              data: orig.data,
              drugNameSnapshot: orig.drugNameSnapshot,
              rxnormRxcuiSnapshot: orig.rxnormRxcuiSnapshot,
              routeSnapshot: orig.routeSnapshot,
              doseAmountSnapshot: orig.doseAmountSnapshot,
              doseUnitSnapshot: orig.doseUnitSnapshot,
              isControlledSubstance: orig.isControlledSubstance,
              isComfortKitDrawdown: orig.isComfortKitDrawdown,
              administeredAt: orig.administeredAt,
              actorKind: orig.actorKind,
              administeringClinicianMembershipId: orig.administeringClinicianMembershipId,
              witnessMembershipId: orig.witnessMembershipId,
              lateEntryTier: orig.lateEntryTier,
              correctsAdministrationId: id,
              correctionReason: reason,
            })
            .returning()
        )[0]!;
        await tx
          .update(ADM)
          .set({ status: "superseded", updatedAt: new Date() })
          .where(eq(ADM.id, id));
        await emit(
          tx,
          orgId,
          "m13.administration.corrected",
          "administration_record",
          inserted.id,
          {
            originalAdministrationId: id,
            newAdministrationId: inserted.id,
            reason,
          },
        );
        return toAdminView(inserted, null);
      });
    },

    async voidAdministration(orgId, userId, id, reason): Promise<AdministrationView> {
      return withOrg(orgId, async (tx) => {
        await loadAdmin(tx, id);
        await tx
          .update(ADM)
          .set({
            status: "voided",
            voidedAt: new Date(),
            voidedBy: userId,
            voidReason: reason,
            updatedAt: new Date(),
          })
          .where(eq(ADM.id, id));
        await emit(tx, orgId, "m13.administration.voided", "administration_record", id, {
          administrationRecordId: id,
          voidReason: reason,
          voidedBy: userId,
        });
        return readAdmin(tx, id);
      });
    },

    async recordRefusal(orgId, userId, args: RecordRefusalArgs): Promise<AdministrationView> {
      return withOrg(orgId, async (tx) => {
        // F-031 — a refusal carried the real patient (the body supplies it) but a SENTINEL admission, so it
        // was filed on the chart and missing from every admission-scoped rollup that reads it. Same seam,
        // same answer; the refusal itself is never blocked on it (the patient is already known).
        const identity = await medOrder().administrationIdentity({
          organizationId: orgId,
          medicationOrderId: args.medicationOrderId,
        });
        const inserted = (
          await tx
            .insert(ADM)
            .values({
              organizationId: orgId,
              patientId: args.patientId,
              admissionId: identity?.admissionId ?? ADMISSION_SENTINEL,
              medicationOrderId: args.medicationOrderId,
              scheduledDoseId: args.scheduledDoseId ?? null,
              mode: "single_dose",
              status: "committed",
              data: {},
              drugNameSnapshot: identity?.drugName ?? "",
              routeSnapshot: identity?.route ?? "",
              isControlledSubstance: args.medClass === "controlled_substance",
              refused: true,
              administeredAt: new Date(args.refusedAt),
              actorKind: "clinician",
              administeringClinicianMembershipId: userId,
            })
            .returning()
        )[0]!;
        await emit(tx, orgId, "m13.administration.refused", "administration_record", inserted.id, {
          administrationRecordId: inserted.id,
          patientId: args.patientId,
          medicationOrderId: args.medicationOrderId,
          refusalAt: args.refusedAt,
        });
        return toAdminView(inserted, null);
      });
    },

    async offlineSync(
      orgId,
      userId,
      rows,
    ): Promise<{ synced: number; results: AdministrationView[] }> {
      const results: AdministrationView[] = [];
      for (const r of rows) results.push(await this.recordAdministration(orgId, userId, r));
      return { synced: results.length, results };
    },

    // ── scheduled / missed dose writes ────────────────────────────────────────────────────────────────
    async intentionalHold(orgId, userId, id): Promise<ScheduledDoseView> {
      return withOrg(orgId, async (tx) => {
        const [s] = await tx.select().from(SD).where(eq(SD.id, id)).limit(1);
        if (!s) throw new NotFoundError("scheduled dose not found");
        await tx.update(SD).set({ status: "intentionally_held" }).where(eq(SD.id, id));
        await emit(tx, orgId, "m13.scheduled_dose.intentionally_held", "scheduled_dose", id, {
          scheduledDoseId: id,
          recordedBy: userId,
          missedKind: "intentionally_held",
        });
        return toScheduledView({ ...s, status: "intentionally_held" });
      });
    },

    async acknowledgeMissed(orgId, userId, id): Promise<MissedDoseView> {
      return withOrg(orgId, async (tx) => {
        const [m] = await tx
          .select({
            id: MD.id,
            patientId: MD.patientId,
            scheduledDoseId: MD.scheduledDoseId,
            medicationOrderId: MD.medicationOrderId,
            dueAt: SD.dueAt,
          })
          .from(MD)
          .innerJoin(SD, eq(MD.scheduledDoseId, SD.id))
          .where(eq(MD.id, id))
          .limit(1);
        if (!m) throw new NotFoundError("missed dose not found");
        const acknowledgedAt = new Date();
        await tx
          .update(MD)
          .set({ acknowledgedAt, acknowledgedByMembershipId: userId })
          .where(eq(MD.id, id));
        await emit(tx, orgId, "m13.missed_dose.acknowledged", "missed_dose", id, {
          missedDoseId: id,
          acknowledgedBy: userId,
        });
        return {
          id: m.id,
          patientId: m.patientId,
          scheduledDoseId: m.scheduledDoseId,
          medicationOrderId: m.medicationOrderId,
          dueAt: iso(m.dueAt)!,
          acknowledgedAt: iso(acknowledgedAt),
        };
      });
    },

    // ── reconciliation worksheet writes ───────────────────────────────────────────────────────────────
    async recordDecision(orgId, userId, id, args: RecordDecisionArgs): Promise<WorksheetView> {
      return withOrg(orgId, async (tx) => {
        await loadWorksheet(tx, id);
        const decision = (
          await tx
            .insert(RD)
            .values({
              organizationId: orgId,
              worksheetId: id,
              lineKind: args.lineKind,
              m12MedicationOrderId: args.lineKind === "m12_active" ? args.sourceId : null,
              m12MedicationHistoryRecordId: args.lineKind === "m12_medhx" ? args.sourceId : null,
              decisionKind: args.decision,
              decisionMadeByMembershipId: userId,
            })
            .returning({ id: RD.id })
        )[0]!;
        await tx.update(WS).set({ status: "in_progress" }).where(eq(WS.id, id));
        if (args.decision === "carry_forward" || args.decision === "new_order")
          await emit(
            tx,
            orgId,
            "m13.reconciliation.draft_order_requested",
            "reconciliation_worksheet",
            id,
            {
              worksheetId: id,
              decisionId: decision.id,
              medicationOrderDraftPayload: {},
              lineKind: args.lineKind,
            },
          );
        if (args.decision === "discontinue")
          await emit(
            tx,
            orgId,
            "m13.reconciliation.discontinue_requested",
            "reconciliation_worksheet",
            id,
            {
              worksheetId: id,
              decisionId: decision.id,
              medicationOrderId: args.sourceId,
              reason: "reconciled_discontinue",
            },
          );
        return readWorksheet(tx, id);
      });
    },

    async updateDecision(
      orgId,
      userId,
      id,
      lineId,
      decision,
      resultingMedicationOrderId,
    ): Promise<WorksheetView> {
      return withOrg(orgId, async (tx) => {
        await loadWorksheet(tx, id);
        const updated = await tx
          .update(RD)
          .set({
            decisionKind: decision,
            // Only ever SET, never cleared by omission: a caller changing a decision kind must not
            // silently drop the link to an order that was already sent to a prescriber and may already
            // be signed. Unlinking is a deliberate act, and no caller asks for it today.
            ...(resultingMedicationOrderId ? { resultingMedicationOrderId } : {}),
          })
          .where(and(eq(RD.id, lineId), eq(RD.worksheetId, id)))
          .returning({ id: RD.id });
        if (updated.length === 0) throw new NotFoundError("decision line not found");
        return readWorksheet(tx, id);
      });
    },

    async addCaregiverReportedLine(orgId, id, drugName): Promise<WorksheetView> {
      // A caregiver-reported home med becomes a decision line. The DB decision row is NOT NULL on
      // decision_kind, so it records as `document_only` (a recorded-but-no-action placeholder) until a
      // clinician updates it (compromise #7 — no separate undecided-line state).
      return withOrg(orgId, async (tx) => {
        await loadWorksheet(tx, id);
        await tx.insert(RD).values({
          organizationId: orgId,
          worksheetId: id,
          lineKind: "caregiver_reported",
          caregiverReportedSnapshot: { drugName },
          decisionKind: "document_only",
          decisionMadeByMembershipId: PATIENT_SENTINEL,
        });
        return readWorksheet(tx, id);
      });
    },

    async finalizeReconciliation(orgId, userId, id): Promise<WorksheetView> {
      return withOrg(orgId, async (tx) => {
        const w = await loadWorksheet(tx, id);
        const decisions = await tx.select({ id: RD.id }).from(RD).where(eq(RD.worksheetId, id));
        if (decisions.length === 0)
          throw new ValidationError("reconciliation incomplete", [
            {
              field: "decisions",
              code: "RECONCILIATION_INCOMPLETE",
              message: "no reconciliation decision recorded",
            },
          ]);
        const finalizedAt = new Date();
        await tx
          .update(WS)
          .set({ status: "finalized", finalizedAt, finalizedByMembershipId: userId })
          .where(eq(WS.id, id));
        await emit(tx, orgId, "m13.reconciliation.completed", "reconciliation_worksheet", id, {
          worksheetId: id,
          triggerKind: w.triggerKind,
          patientId: w.patientId,
          admissionId: w.admissionId,
          finalizedAt: finalizedAt.toISOString(),
          finalizedBy: userId,
          lineSummary: {},
        });
        await emit(
          tx,
          orgId,
          "m13.reconciliation.document_requested",
          "reconciliation_worksheet",
          id,
          {
            worksheetId: id,
            formTemplate: "reconciliation_worksheet_v1",
            // GAP-023/024/038 — `renderPayload` was `{}` because nothing consumed this event; M22's live
            // render consumer now files the resulting `document` against a patient, and an empty payload
            // would file it with a NULL `patient_id` on a chart artifact that plainly has one.
            renderPayload: {
              patientId: w.patientId,
              admissionId: w.admissionId,
              triggerKind: w.triggerKind,
              finalizedAt: finalizedAt.toISOString(),
            },
          },
        );
        return readWorksheet(tx, id);
      });
    },

    async voidWorksheet(orgId, userId, id, reason): Promise<WorksheetView> {
      return withOrg(orgId, async (tx) => {
        await loadWorksheet(tx, id);
        await tx.update(WS).set({ status: "voided", voidReason: reason }).where(eq(WS.id, id));
        await emit(tx, orgId, "m13.reconciliation.voided", "reconciliation_worksheet", id, {
          worksheetId: id,
          voidReason: reason,
        });
        return readWorksheet(tx, id);
      });
    },

    // ── comfort-kit deployment writes ─────────────────────────────────────────────────────────────────
    async acknowledgeReturn(orgId, userId, id): Promise<DeploymentView> {
      return withOrg(orgId, async (tx) => {
        const [d] = await tx.select().from(CKD).where(eq(CKD.id, id)).limit(1);
        if (!d) throw new NotFoundError("comfort-kit deployment not found");
        const returnedAt = new Date();
        await tx
          .update(CKD)
          .set({
            disposalStatus: "returned",
            returnedAt,
            disposalReconciliationStatus: "reconciled",
          })
          .where(eq(CKD.id, id));
        await emit(tx, orgId, "m13.comfort_kit.returned", "comfort_kit_deployment", id, {
          deploymentId: id,
          returnedAt: returnedAt.toISOString(),
          finalRemainingByMedication: {},
          disposalReconciliationStatus: "reconciled",
        });
        return {
          id: d.id,
          patientId: d.patientId,
          admissionId: d.admissionId,
          disposalStatus: "returned",
        };
      });
    },

    // ── administration policy write (org singleton; UPSERT) ───────────────────────────────────────────
    async putPolicy(orgId, patch): Promise<AdministrationPolicyView> {
      return withOrg(orgId, async (tx) => {
        const [existing] = await tx
          .select()
          .from(POL)
          .where(eq(POL.organizationId, orgId))
          .limit(1);
        const next: AdministrationPolicyView = {
          graceWindowMinutes:
            patch.graceWindowMinutes ??
            existing?.defaultGraceWindowMinutes ??
            DEFAULT_POLICY.graceWindowMinutes,
          prnMinimumIntervalMinutes:
            patch.prnMinimumIntervalMinutes ??
            existing?.defaultPrnReassessmentWindowMinutes ??
            DEFAULT_POLICY.prnMinimumIntervalMinutes,
          emarPdfOnCommit:
            patch.emarPdfOnCommit ??
            existing?.emarPerAdministrationPdfEnabled ??
            DEFAULT_POLICY.emarPdfOnCommit,
        };
        await tx
          .insert(POL)
          .values({
            organizationId: orgId,
            defaultGraceWindowMinutes: next.graceWindowMinutes,
            defaultPrnReassessmentWindowMinutes: next.prnMinimumIntervalMinutes,
            emarPerAdministrationPdfEnabled: next.emarPdfOnCommit,
          })
          .onConflictDoUpdate({
            target: POL.organizationId,
            set: {
              defaultGraceWindowMinutes: next.graceWindowMinutes,
              defaultPrnReassessmentWindowMinutes: next.prnMinimumIntervalMinutes,
              emarPerAdministrationPdfEnabled: next.emarPdfOnCommit,
              updatedAt: new Date(),
            },
          });
        await emit(tx, orgId, "m13.policy.changed", "administration_policy", orgId, {
          policyDeltaSummary: patch,
        });
        return next;
      });
    },

    // The prod outbox is the M1 transactional relay, not a drainable in-memory buffer.
    drainEvents: () => [],
  };
}

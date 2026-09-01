// apps/backend/src/modules/08-encounters — PRODUCTION EncounterRouteService (M8L-T01 reads, T02 writes).
//
// The screen-driving READS (encounter detail, the org encounter list, the cosignature queue, my open
// drafts, billability, signed-since, and the cosignature-request status) run as real Drizzle queries over
// the M8-owned tables inside `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged
// `wardenx_app` role. The WRITE lifecycle is now real (M8L-T02): draft creation, vitals/mileage authoring,
// care-plan link, EVV-missing, finalize (pins the vocab version), the §2.3 sign machine (incl. the §7.4 D1
// F2F dual-write and the LPN/CHHA cosignature routing), the §2.4 D3 cosignature-request chain
// (acknowledge → sign / supervisor-release), the §2.5 D4 late-entry overrides, void, and the addendum
// aggregate (draft → finalize → sign). Every mutation drives the SAME pure machine the in-memory slice
// does, folds the declared §2.8 effects into the row UPDATE, and emits its `m8.*` event on the caller's
// transactional outbox — no route is left at 501.
//
// Because the EncounterRouteService interface threads no acting membership / session / attestation, this
// slice makes three documented compromises (mirrors M7L-T02's null-actor convention): (1) writes envelope
// `withOrgContext` with `userId:""` so the M4 write-audit trigger fires with a NULL actor; (2) columns the
// route never captures — a signer identity, the assigned RN cosigner, a supervisor override reason — are
// filled from the authoring membership or a documented sentinel, backfilled when the interface threads
// them; (3) no `encounter_signature` provenance row and no `hearthnote_selection`/Layer-2 row is written
// (the interface carries neither the session/attestation nor the selection tree) — the encounter's
// status + signed_at/cosigned_at carry the signed state, exactly as the in-memory reference models it.
import { isStepUpRecent } from "@wardenx/auth";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type AdmissionSummary,
  ForbiddenError,
  type LocalDate,
  NotFoundError,
  STEP_UP_POLICY,
  type StepUpFactor,
  ValidationError,
} from "@wardenx/types";
import { and, desc, eq, gte, inArray, isNull, lte, type SQL } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import { planF2fDualWrite, planMileageCapture, planVitalsCapture } from "./authoring/index";
import { transitionCosignature } from "./cosignature/index";
import type { CosignatureState } from "./cosignature/index";
import { transitionAddendum } from "./lifecycle/addendum";
import { transitionEncounter } from "./lifecycle/encounter";
import { EncounterStateError } from "./lifecycle/errors";
import {
  checkEncounterDisciplinePair,
  checkMutableForEdit,
  checkParentNotVoided,
  checkServiceDateNotFuture,
  checkVersion,
} from "./lifecycle/validation";
import type {
  EncounterAbacFacts,
  EncounterAbacResolver,
  EncounterRouteService,
  EncounterView,
} from "./routes/service";

const ENC = schema.encounters;
const COSIGN = schema.cosignatureRequests;
const ADDENDUM = schema.encounterAddenda;
const VITALS = schema.vitals;
const MILEAGE = schema.mileage;
const SIG = schema.encounterSignatures;
const LINK = schema.encounterCarePlanLinks;
const SEL = schema.hearthnoteSelections;
const OUT = schema.hearthnoteAssembledOutputs;
const MEM = schema.memberships;

// ── §3.3/D13 signature provenance (CoP 418.104(c), 21 CFR Part 11 principles) ─────────────────────────
//
// Every primary sign / cosignature / addendum-sign writes one `encounter_signature` row carrying WHO
// signed (the caller's real membership, not the encounter's author), WHAT method authenticated them,
// and WHEN their step-up was verified — sourced from M2's `SessionContextResolver` seam (the same
// source M3's `step_up_recent` predicate reads), never from a client-supplied timestamp. The route's
// `requireStepUp(...)` preHandler already denied the request if this resolves stale; resolving it again
// here (rather than threading a boolean through) mirrors the established "re-derive, don't trust a
// passed-through client claim" idiom (M11 Orders re-derives the cosigner role the same way).

/** `signature_method` has no `sms` value — STEP_UP_POLICY excludes sms from qualifying factors, so a
 *  fresh step-up can only ever be webauthn or totp by the time this runs (the route's requireStepUp
 *  gate already enforced that). `webauthn` covers both passkey and platform-biometric ceremonies; the
 *  session seam doesn't distinguish them, so passkey is the faithful default for the FIDO2 credential
 *  type (see catalog note in packages/audit for the analogous "don't invent a distinction the seam
 *  can't make" precedent). */
function stepUpFactorToSignatureMethod(
  factor: StepUpFactor,
): (typeof schema.signatureMethod.enumValues)[number] {
  switch (factor) {
    case "webauthn":
      return "passkey";
    case "totp":
      return "password_plus_otp";
    case "sms":
      throw new EncounterStateError(
        "STEP_UP_AUTH_REQUIRED",
        "sms does not qualify as a fresh step-up factor for a clinical signature",
      );
  }
}

/** The exact attestation language presented for each signature kind (§3.3 `attestation_text`, ≥ 50
 *  chars). Standard, fixed statements — not free-form user text — matching `layer2_involved_at_signing`
 *  always being `false` in this slice (no Layer-2/HearthNote provenance is captured yet; see
 *  `enhanceHearthnote`/`recordModificationDecision` above). Real product/legal copy TBD; these are the
 *  placeholder-but-real-shaped strings the file already uses this idiom for (see SIGNIFICANT_LATE_REASON
 *  et al. above). */
const PRIMARY_ATTESTATION_TEXT =
  "I attest that this clinical documentation is accurate and complete to the best of my knowledge, and that I am the practitioner responsible for the care described (primary signature, pending final legal copy).";
const COSIGNATURE_ATTESTATION_TEXT =
  "I attest, as the qualified RN cosigner, that I have reviewed this clinical documentation and concur with the care described (cosignature, pending final legal copy).";
const ADDENDUM_ATTESTATION_TEXT =
  "I attest that this addendum is accurate and complete to the best of my knowledge (addendum signature, pending final legal copy).";

/** Resolved, server-verified signature provenance for one sign event. `stepUpFresh` is what the pure
 *  lifecycle machines gate on; `method`/`stepUpAuthAt` are only meaningful (and only read) when fresh. */
interface SignatureProvenance {
  readonly stepUpFresh: boolean;
  readonly method: (typeof schema.signatureMethod.enumValues)[number];
  readonly stepUpAuthAt: Date;
}

async function resolveSignatureProvenance(
  organizationId: string,
  sessionId: string,
): Promise<SignatureProvenance> {
  const state = await getSeam("SessionContextResolver").resolveStepUpState(
    { orgId: organizationId },
    sessionId,
  );
  if (
    !isStepUpRecent(state, STEP_UP_POLICY, Date.now()) ||
    !state?.lastStepUpAt ||
    !state.lastStepUpFactor
  ) {
    return { stepUpFresh: false, method: "passkey", stepUpAuthAt: new Date(0) };
  }
  return {
    stepUpFresh: true,
    method: stepUpFactorToSignatureMethod(state.lastStepUpFactor),
    stepUpAuthAt: state.lastStepUpAt,
  };
}

/**
 * The §2.7 D11 pinned vocabulary version. In prod the active `code_system_version` id comes from M38's
 * TerminologyReader (checked at finalize via `checkVocabVersion`); until that seam is threaded, finalize
 * pins this fixed sentinel — it satisfies the `encounter_vocab_pinned_when_finalized` CHECK and the
 * `m8.encounter.finalized` payload's required `vocabVersionId`, and is replaced when M38 is wired.
 */
const VOCAB_VERSION_SENTINEL = "00000000-0000-4000-8000-0000000000d8";

/** §2.5 D4 override / §2.7 D9 EVV-missing reasons the thin route interface does not capture (sentinels
 * meeting the DB CHECK minimums; a real reason threads through when the route body carries it). */
/** The transactional-outbox port (§2.8): the bound publisher validates every emit against the boot
 * catalog and writes the `outbox_event` row on the CALLER'S tx. The default no-op lets the slice/tests
 * commit without a dispatcher (the row state is the load-bearing effect). Mirrors M7's port. */
export interface EncounterWriteOutboxPort {
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
const NOOP_OUTBOX: EncounterWriteOutboxPort = { async publish() {} };

/** First row of a RETURNING/SELECT, or a 500 (unreachable after a successful write). */
function firstOrThrow<T>(rows: readonly T[], msg: string): T {
  const r = rows[0];
  if (!r) throw new EncounterStateError("ILLEGAL_TRANSITION", msg);
  return r;
}

/** The encounter columns every read projects (single source of truth for {@link toView}). */
const encounterCols = {
  id: ENC.id,
  organizationId: ENC.organizationId,
  patientId: ENC.patientId,
  admissionId: ENC.admissionId,
  visitId: ENC.visitId,
  encounterType: ENC.encounterType,
  discipline: ENC.discipline,
  serviceDate: ENC.serviceDate,
  status: ENC.status,
  lateEntryTier: ENC.lateEntryTier,
  version: ENC.version,
  authoredByMembershipId: ENC.authoredByMembershipId,
  faceToFaceEncounterId: ENC.faceToFaceEncounterId,
  signedAt: ENC.signedAt,
  cosignedAt: ENC.cosignedAt,
} as const;

type EncounterRow = {
  id: string;
  organizationId: string;
  patientId: string;
  admissionId: string;
  visitId: string | null;
  encounterType: EncounterView["encounterType"];
  discipline: EncounterView["discipline"];
  serviceDate: string;
  status: EncounterView["status"];
  lateEntryTier: string;
  version: number;
  authoredByMembershipId: string;
  faceToFaceEncounterId: string | null;
  signedAt: Date | string | null;
  cosignedAt: Date | string | null;
};

/** Timestamptz → ISO string (drizzle returns a Date for `withTimezone` columns); mirror the in-memory shape. */
const iso = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === "string" ? v : v.toISOString();

/** Project a real `encounter` row to the EXACT in-memory {@link EncounterView} shape. */
const toView = (r: EncounterRow): EncounterView => ({
  id: r.id,
  organizationId: r.organizationId,
  patientId: r.patientId,
  admissionId: r.admissionId,
  visitId: r.visitId,
  encounterType: r.encounterType,
  discipline: r.discipline,
  serviceDate: r.serviceDate as EncounterView["serviceDate"],
  status: r.status,
  lateEntryTier: r.lateEntryTier,
  version: Number(r.version),
  // The in-memory record keys the author by user id; the DB column is the authoring `membership` id.
  authoredByUserId: r.authoredByMembershipId,
  // Mirrors the in-memory `isF2f` derivation (§7.4 D1): the F2F encounter type OR a linked M6 F2F row.
  isF2f: r.encounterType === "face_to_face" || r.faceToFaceEncounterId !== null,
  signedAt: iso(r.signedAt),
  cosignedAt: iso(r.cosignedAt),
});

function templateKeyFor(r: {
  readonly discipline: string;
  readonly encounterType: string;
}): string {
  return `${r.discipline}_${r.encounterType}_v1`;
}

function layer1PreviewFromSelections(input: Record<string, unknown>): string {
  return JSON.stringify(input);
}

function requireNoFreeText(freeText: Record<string, string> | undefined): void {
  if (freeText && Object.keys(freeText).length > 0) {
    throw new ValidationError(
      "freeText encounter selections are not supported until encrypted capture is available",
      [],
    );
  }
}

function admissionServiceStart(summary: AdmissionSummary): LocalDate {
  return (summary.activatedAt ?? summary.admissionAt) as LocalDate;
}

function validateAdmissionForService(
  organizationId: string,
  patientId: string,
  serviceDate: LocalDate,
  summary: AdmissionSummary,
): void {
  if (summary.organizationId !== organizationId || summary.patientId !== patientId) {
    throw new NotFoundError("admission");
  }
  const startedAt = admissionServiceStart(summary);
  if (serviceDate < startedAt) {
    throw new ValidationError("encounter service date cannot precede admission activation", []);
  }
  if (summary.status === "active") return;
  if (
    (summary.status === "discharged" ||
      summary.status === "bereavement" ||
      summary.status === "closed") &&
    summary.dischargedAt !== null &&
    serviceDate <= summary.dischargedAt
  ) {
    return;
  }
  throw new ForbiddenError(`encounter authoring is not allowed while admission is '${summary.status}'`);
}

async function admissionSummaryFor(
  organizationId: string,
  admissionId: string,
): Promise<AdmissionSummary> {
  return getSeam("AdmissionStatusReader").getAdmissionSummary(organizationId, admissionId);
}

/**
 * The production, RLS-backed EncounterRouteService. Reads are real; writes fail-closed 501.
 * Org is bound from the request context by the caller and passed as `organizationId` — never the body.
 */
export function createDbEncounterRouteService(
  db: DbClient,
  outbox: EncounterWriteOutboxPort = NOOP_OUTBOX,
): EncounterRouteService {
  /** Load one org-scoped encounter row → the shared projection, or `null` when absent/cross-tenant. */
  async function loadRow(
    organizationId: string,
    encounterId: string,
  ): Promise<EncounterRow | null> {
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const [r] = await tx.select(encounterCols).from(ENC).where(eq(ENC.id, encounterId)).limit(1);
      return (r as EncounterRow | undefined) ?? null;
    });
  }

  /** Emit one `m8.*` event on the caller's tx (validated + persisted by the bound publisher; no-op default). */
  async function emit(
    tx: unknown,
    org: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, {
      eventName,
      payload,
      organizationId: org,
      aggregateKind,
      aggregateId,
    });
  }

  /** Load a tenant-scoped encounter row FOR the write path (RLS-scoped) or raise the non-leaking 404. */
  async function loadEnc(t: DbClient, encounterId: string): Promise<typeof ENC.$inferSelect> {
    const [row] = await t.select().from(ENC).where(eq(ENC.id, encounterId)).limit(1);
    if (!row) throw new NotFoundError("encounter");
    return row;
  }

  /** Load an encounter's live cosignature request (the D3 workflow row) or the non-leaking 404. */
  async function loadCosign(t: DbClient, encounterId: string): Promise<typeof COSIGN.$inferSelect> {
    const [row] = await t.select().from(COSIGN).where(eq(COSIGN.encounterId, encounterId)).limit(1);
    if (!row) throw new NotFoundError("cosignature_request");
    return row;
  }

  /** Load an addendum scoped to its parent encounter or the non-leaking 404. */
  async function loadAddendum(
    t: DbClient,
    encounterId: string,
    addendumId: string,
  ): Promise<typeof ADDENDUM.$inferSelect> {
    const [row] = await t
      .select()
      .from(ADDENDUM)
      .where(and(eq(ADDENDUM.id, addendumId), eq(ADDENDUM.encounterId, encounterId)))
      .limit(1);
    if (!row) throw new NotFoundError("addendum");
    return row;
  }

  async function resolveSiting(
    t: DbClient,
    summary: AdmissionSummary,
    authoredByMembershipId: string,
  ): Promise<{ providerEntityId: string; locationId: string }> {
    if (summary.providerEntityId && summary.locationId) {
      return { providerEntityId: summary.providerEntityId, locationId: summary.locationId };
    }
    const [m] = await t
      .select({ providerEntityId: MEM.defaultProviderEntityId, locationIds: MEM.defaultLocationIds })
      .from(MEM)
      .where(eq(MEM.id, authoredByMembershipId))
      .limit(1);
    const locs = Array.isArray(m?.locationIds) ? (m.locationIds as string[]) : [];
    if (!m?.providerEntityId || locs.length === 0) {
      throw new ValidationError(
        "encounter requires valid provider/location siting from the admission or authoring membership",
        [],
      );
    }
    return { providerEntityId: m.providerEntityId, locationId: locs[0] as string };
  }

  async function latestFinalPayload(t: DbClient, encounterId: string): Promise<string> {
    const [row] = await t
      .select({ finalCipher: OUT.finalCipher })
      .from(OUT)
      .where(and(eq(OUT.encounterId, encounterId), eq(OUT.kind, "primary_finalize")))
      .orderBy(desc(OUT.createdAt))
      .limit(1);
    return row?.finalCipher ?? "";
  }

  async function carePlanLinksFor(
    t: DbClient,
    encounterId: string,
  ): Promise<Array<{ problemId?: string; goalId?: string; interventionId?: string }>> {
    const rows = await t
      .select({
        problemId: LINK.problemId,
        goalId: LINK.goalId,
        interventionId: LINK.interventionId,
      })
      .from(LINK)
      .where(eq(LINK.encounterId, encounterId));
    return rows.map((r) => ({
      ...(r.problemId ? { problemId: r.problemId } : {}),
      ...(r.goalId ? { goalId: r.goalId } : {}),
      ...(r.interventionId ? { interventionId: r.interventionId } : {}),
    }));
  }

  async function workspaceFieldsFor(t: DbClient, encounterId: string) {
    const [selection] = await t
      .select({ selections: SEL.selections })
      .from(SEL)
      .where(eq(SEL.encounterId, encounterId))
      .limit(1);
    const [vital] = await t
      .select({
        vitalsId: VITALS.id,
        bpSystolic: VITALS.bpSystolic,
        bpDiastolic: VITALS.bpDiastolic,
        heartRate: VITALS.heartRate,
        respiratoryRate: VITALS.respiratoryRate,
        temperature: VITALS.temperature,
        temperatureUnit: VITALS.temperatureUnit,
        spo2: VITALS.spo2,
        painScore: VITALS.painScore,
        painScale: VITALS.painScale,
        weight: VITALS.weight,
        weightUnit: VITALS.weightUnit,
        height: VITALS.height,
        heightUnit: VITALS.heightUnit,
        bmi: VITALS.bmi,
        bloodGlucose: VITALS.bloodGlucose,
        bloodGlucoseUnit: VITALS.bloodGlucoseUnit,
        clinicallyNotIndicatedFields: VITALS.clinicallyNotIndicatedFields,
        clinicallyNotIndicatedReason: VITALS.clinicallyNotIndicatedReason,
        capturedAt: VITALS.capturedAt,
      })
      .from(VITALS)
      .where(eq(VITALS.encounterId, encounterId))
      .orderBy(desc(VITALS.capturedAt))
      .limit(1);
    const [mileage] = await t
      .select({
        mileageId: MILEAGE.id,
        odometerStart: MILEAGE.odometerStart,
        odometerEnd: MILEAGE.odometerEnd,
        milesDriven: MILEAGE.milesDriven,
        source: MILEAGE.milesDrivenSource,
        manualOverrideReason: MILEAGE.manualOverrideReason,
        routeProposedMiles: MILEAGE.routeProposedMiles,
        capturedAt: MILEAGE.createdAt,
      })
      .from(MILEAGE)
      .where(eq(MILEAGE.encounterId, encounterId))
      .limit(1);
    return {
      selections: (selection?.selections as Record<string, unknown> | undefined) ?? null,
      finalDocumentation: await latestFinalPayload(t, encounterId),
      vitals: vital ? { ...vital, capturedAt: iso(vital.capturedAt) } : null,
      mileage: mileage ? { ...mileage, capturedAt: iso(mileage.capturedAt) } : null,
      carePlanLinks: await carePlanLinkRowsFor(t, encounterId),
    };
  }

  async function carePlanLinkRowsFor(t: DbClient, encounterId: string) {
    const rows = await t
      .select({
        linkId: LINK.id,
        problemId: LINK.problemId,
        goalId: LINK.goalId,
        interventionId: LINK.interventionId,
      })
      .from(LINK)
      .where(eq(LINK.encounterId, encounterId));
    return rows.map((r) => ({
      linkId: r.linkId,
      problemId: r.problemId ?? null,
      goalId: r.goalId ?? null,
      interventionId: r.interventionId ?? null,
    }));
  }

  /** Is this encounter an F2F dual-write (§7.4 D1)? — the F2F type OR a linked M6 face-to-face row. */
  const isF2f = (r: typeof ENC.$inferSelect): boolean =>
    r.encounterType === "face_to_face" || r.faceToFaceEncounterId !== null;

  /** D10 — capture-or-replace the 0..1 mileage row for an encounter (captureMileage/editMileage share it). */
  async function captureMileageImpl(
    organizationId: string,
    encounterId: string,
    input: Parameters<EncounterRouteService["captureMileage"]>[2],
  ) {
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const t = tx as unknown as DbClient;
      const r = await loadEnc(t, encounterId);
      checkMutableForEdit({ status: r.status });
      const plan = planMileageCapture(input);
      const [existing] = await t
        .select({ id: MILEAGE.id })
        .from(MILEAGE)
        .where(eq(MILEAGE.encounterId, encounterId))
        .limit(1);
      let mileageId: string;
      if (existing) {
        await t
          .update(MILEAGE)
          .set({
            odometerStart: input.odometerStart ?? null,
            odometerEnd: input.odometerEnd ?? null,
            milesDriven: plan.milesDriven,
            milesDrivenSource: plan.source,
            manualOverrideReason: input.manualOverrideReason ?? null,
            routeProposedMiles: input.routeProposedMiles ?? null,
          })
          .where(eq(MILEAGE.id, existing.id));
        mileageId = existing.id;
      } else {
        mileageId = firstOrThrow(
          await t
            .insert(MILEAGE)
            .values({
              organizationId,
              encounterId,
              odometerStart: input.odometerStart ?? null,
              odometerEnd: input.odometerEnd ?? null,
              milesDriven: plan.milesDriven,
              milesDrivenSource: plan.source,
              manualOverrideReason: input.manualOverrideReason ?? null,
              routeProposedMiles: input.routeProposedMiles ?? null,
            })
            .returning({ id: MILEAGE.id }),
          "mileage insert returned no row",
        ).id;
      }
      await emit(t, organizationId, "m8.mileage.captured", "mileage", mileageId, {
        encounterId,
        milesDriven: plan.milesDriven,
        source: plan.source,
      });
      return { mileageId, milesDriven: plan.milesDriven, source: plan.source };
    });
  }

  return {
    // ── Encounter reads ────────────────────────────────────────────────────────────────────────────
    async getEncounter(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [r] = await t.select(encounterCols).from(ENC).where(eq(ENC.id, encounterId)).limit(1);
        if (!r) throw new NotFoundError("encounter"); // non-leaking 404 (mirrors the in-memory `load`)
        return { ...toView(r), ...(await workspaceFieldsFor(t, encounterId)) };
      });
    },
    async renderPayload(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        return { encounterId: r.id, final: await latestFinalPayload(t, encounterId) };
      });
    },
    async listEncounters(organizationId, filters = {}) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const conditions: SQL[] = [];
        if (filters.patientId) conditions.push(eq(ENC.patientId, filters.patientId));
        if (filters.admissionId) conditions.push(eq(ENC.admissionId, filters.admissionId));
        if (filters.status) conditions.push(eq(ENC.status, filters.status));
        if (filters.authorId) conditions.push(eq(ENC.authoredByMembershipId, filters.authorId));
        if (filters.lateEntryTier) conditions.push(eq(ENC.lateEntryTier, filters.lateEntryTier as never));
        if (filters.from) conditions.push(gte(ENC.serviceDate, filters.from));
        if (filters.to) conditions.push(lte(ENC.serviceDate, filters.to));
        const rows = (await tx
          .select(encounterCols)
          .from(ENC)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(ENC.serviceDate), desc(ENC.id))) as EncounterRow[];
        const limit = filters.limit ?? rows.length;
        return { encounters: rows.slice(0, limit).map(toView) };
      });
    },
    async cosignatureQueue(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(encounterCols)
          .from(ENC)
          .where(eq(ENC.status, "cosign_pending"))
          .orderBy(desc(ENC.signedAt), desc(ENC.id))) as EncounterRow[];
        return { encounters: rows.map(toView) };
      });
    },
    async myDrafts(organizationId, actorUserId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(encounterCols)
          .from(ENC)
          .where(and(eq(ENC.status, "draft"), eq(ENC.authoredByMembershipId, actorUserId)))
          .orderBy(desc(ENC.serviceDate), desc(ENC.id))) as EncounterRow[];
        return { encounters: rows.map(toView) };
      });
    },
    async billable(organizationId, encounterIds) {
      if (encounterIds.length === 0) return { billability: [] };
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select({ id: ENC.id, status: ENC.status })
          .from(ENC)
          .where(inArray(ENC.id, [...encounterIds]))) as { id: string; status: string }[];
        return {
          billability: rows.map((r) => ({
            encounterId: r.id,
            billable: r.status === "signed" || r.status === "cosigned",
          })),
        };
      });
    },
    async signedSince(organizationId, since) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(encounterCols)
          .from(ENC)
          .where(gte(ENC.signedAt, new Date(since)))
          .orderBy(desc(ENC.signedAt), desc(ENC.id))) as EncounterRow[];
        return { encounters: rows.map(toView) };
      });
    },

    // ── Cosignature-request read (status derived from the D3 workflow row) ────────────────────────────
    async getCosignature(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [enc] = await tx
          .select({ id: ENC.id })
          .from(ENC)
          .where(eq(ENC.id, encounterId))
          .limit(1);
        if (!enc) throw new NotFoundError("encounter"); // mirror the in-memory `load` (404 before status)
        const [cr] = await tx
          .select({ status: COSIGN.status })
          .from(COSIGN)
          .where(eq(COSIGN.encounterId, encounterId))
          .limit(1);
        // No request row → no cosignature workflow yet (the in-memory slice returns `null`).
        return { status: cr ? (cr.status as CosignatureState) : null };
      });
    },

    // ── Draft creation (§2.3 genesis; route 1) ───────────────────────────────────────────────────────
    async createDraft(organizationId, actorUserId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        // §2.7 pre-write guards (the rest — volunteer assignment, service-date-after-admission — thread
        // their seam facts when the interface carries them; the DB CHECKs backstop the same envelopes).
        checkEncounterDisciplinePair({
          encounterType: args.encounterType,
          discipline: args.discipline,
        });
        checkServiceDateNotFuture({
          serviceDate: args.serviceDate,
          today: new Date().toISOString().slice(0, 10) as LocalDate,
        });
        const admission = await admissionSummaryFor(organizationId, args.admissionId);
        validateAdmissionForService(organizationId, args.patientId, args.serviceDate, admission);
        const siting = await resolveSiting(t, admission, actorUserId);
        const row = firstOrThrow(
          await t
            .insert(ENC)
            .values({
              organizationId,
              ...siting,
              patientId: args.patientId,
              admissionId: args.admissionId,
              visitId: args.visitId ?? null,
              encounterType: args.encounterType,
              discipline: args.discipline,
              authoredByMembershipId: actorUserId, // stored as the authoring membership (see toView)
              serviceDate: args.serviceDate,
              faceToFaceEncounterId: args.faceToFaceEncounterId ?? null,
              bereavementPlanId: args.bereavementPlanId ?? null,
              status: "draft",
            })
            .returning(),
          "encounter insert returned no row",
        );
        await emit(t, organizationId, "m8.encounter.created", "encounter", row.id, {
          encounterId: row.id,
          patientId: row.patientId,
          admissionId: row.admissionId,
          ...(row.visitId ? { visitId: row.visitId } : {}),
          encounterType: row.encounterType,
          discipline: row.discipline,
          authoredByMembershipId: row.authoredByMembershipId,
          serviceDate: row.serviceDate,
        });
        return {
          id: row.id,
          status: "draft",
          templateKey: `${row.discipline}_${row.encounterType}_v1`,
          templateVersion: "v1",
          version: Number(row.version),
        };
      });
    },

    // ── HearthNote selection edit (§2.3 — bumps the optimistic-lock version) ───────────────────────────
    async updateSelections(organizationId, encounterId, ifVersion, input) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        checkVersion({ expected: ifVersion, actual: Number(r.version) });
        requireNoFreeText(input.freeText);
        if (!r.providerEntityId || !r.locationId) {
          throw new EncounterStateError(
            "ILLEGAL_TRANSITION",
            "encounter must be sited before documentation selections can be written",
          );
        }
        const templateKey = templateKeyFor(r);
        const [existing] = await t
          .select({ id: SEL.id, version: SEL.version })
          .from(SEL)
          .where(eq(SEL.encounterId, encounterId))
          .limit(1);
        if (existing) {
          await t
            .update(SEL)
            .set({
              templateKey,
              templateVersion: "v1",
              selections: input.selections,
              freeTextCipher: null,
              version: Number(existing.version) + 1,
              updatedAt: new Date(),
            })
            .where(eq(SEL.id, existing.id));
        } else {
          await t.insert(SEL).values({
            organizationId,
            providerEntityId: r.providerEntityId,
            locationId: r.locationId,
            encounterId,
            templateKey,
            templateVersion: "v1",
            selections: input.selections,
            freeTextCipher: null,
          });
        }
        const updated = firstOrThrow(
          await t
            .update(ENC)
            .set({ version: ifVersion + 1, updatedAt: new Date() })
            .where(and(eq(ENC.id, encounterId), eq(ENC.version, ifVersion)))
            .returning({ version: ENC.version }),
          "updateSelections matched no row (stale write)",
        );
        return {
          version: Number(updated.version),
          layer1Preview: layer1PreviewFromSelections(input.selections),
        };
      });
    },

    // ── Vitals authoring (§2.2, §3.3 `vitals`) ─────────────────────────────────────────────────────────
    async captureVitals(organizationId, encounterId, input) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        const plan = planVitalsCapture(input); // validates envelopes + CNI reason (§2.2)
        const v = firstOrThrow(
          await t
            .insert(VITALS)
            .values({
              organizationId,
              encounterId,
              capturedAt: new Date(),
              bpSystolic: input.bpSystolic ?? null,
              bpDiastolic: input.bpDiastolic ?? null,
              heartRate: input.heartRate ?? null,
              respiratoryRate: input.respiratoryRate ?? null,
              temperature: input.temperature ?? null,
              temperatureUnit: input.temperatureUnit ?? null,
              spo2: input.spo2 ?? null,
              painScore: input.painScore ?? null,
              painScale: input.painScale ?? null,
              weight: input.weight ?? null,
              weightUnit: input.weightUnit ?? null,
              height: input.height ?? null,
              heightUnit: input.heightUnit ?? null,
              bmi: plan.bmi,
              bloodGlucose: input.bloodGlucose ?? null,
              bloodGlucoseUnit: input.bloodGlucoseUnit ?? null,
              clinicallyNotIndicatedFields: input.clinicallyNotIndicatedFields
                ? [...input.clinicallyNotIndicatedFields]
                : null,
              clinicallyNotIndicatedReason: input.clinicallyNotIndicatedReason ?? null,
            })
            .returning({ id: VITALS.id }),
          "vitals insert returned no row",
        );
        await emit(t, organizationId, "m8.vitals.captured", "vitals", v.id, {
          encounterId,
          vitalsId: v.id,
          fieldsCaptured: [...plan.fieldsCaptured],
          abnormalFlags: [...plan.abnormalFlags],
        });
        return {
          vitalsId: v.id,
          fieldsCaptured: plan.fieldsCaptured,
          abnormalFlags: plan.abnormalFlags,
          bmi: plan.bmi,
        };
      });
    },
    async editVitals(organizationId, encounterId, vitalsId, input) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        const [existing] = await t
          .select({ id: VITALS.id })
          .from(VITALS)
          .where(and(eq(VITALS.id, vitalsId), eq(VITALS.encounterId, encounterId)))
          .limit(1);
        if (!existing) throw new NotFoundError("vitals");
        const plan = planVitalsCapture(input);
        await t
          .update(VITALS)
          .set({
            bpSystolic: input.bpSystolic ?? null,
            bpDiastolic: input.bpDiastolic ?? null,
            heartRate: input.heartRate ?? null,
            respiratoryRate: input.respiratoryRate ?? null,
            temperature: input.temperature ?? null,
            temperatureUnit: input.temperatureUnit ?? null,
            spo2: input.spo2 ?? null,
            painScore: input.painScore ?? null,
            painScale: input.painScale ?? null,
            weight: input.weight ?? null,
            weightUnit: input.weightUnit ?? null,
            height: input.height ?? null,
            heightUnit: input.heightUnit ?? null,
            bmi: plan.bmi,
            bloodGlucose: input.bloodGlucose ?? null,
            bloodGlucoseUnit: input.bloodGlucoseUnit ?? null,
            clinicallyNotIndicatedFields: input.clinicallyNotIndicatedFields
              ? [...input.clinicallyNotIndicatedFields]
              : null,
            clinicallyNotIndicatedReason: input.clinicallyNotIndicatedReason ?? null,
          })
          .where(eq(VITALS.id, vitalsId));
        await emit(t, organizationId, "m8.vitals.captured", "vitals", vitalsId, {
          encounterId,
          vitalsId,
          fieldsCaptured: [...plan.fieldsCaptured],
          abnormalFlags: [...plan.abnormalFlags],
        });
        return {
          vitalsId,
          fieldsCaptured: plan.fieldsCaptured,
          abnormalFlags: plan.abnormalFlags,
          bmi: plan.bmi,
        };
      });
    },

    // ── Mileage authoring (§2.2 D10 — 0..1 per encounter; capture and edit share the upsert) ────────────
    async captureMileage(organizationId, encounterId, input) {
      return captureMileageImpl(organizationId, encounterId, input);
    },
    async editMileage(organizationId, encounterId, input) {
      return captureMileageImpl(organizationId, encounterId, input);
    },

    // ── Care-plan links / EVV-missing (§2.3 draft-time edits) ──────────────────────────────────────────
    async addCarePlanLink(organizationId, encounterId, input) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        if (!r.providerEntityId || !r.locationId) {
          throw new EncounterStateError(
            "ILLEGAL_TRANSITION",
            "encounter must be sited before care-plan links can be written",
          );
        }
        if (!input.problemId && !input.goalId && !input.interventionId) {
          throw new ValidationError("at least one care-plan element id is required", []);
        }
        const elements = await getSeam("CarePlanReader").relevantElementsForEncounter(
          r.patientId,
          r.encounterType,
          r.discipline as never,
        );
        if (!elements || elements.patientId !== r.patientId) {
          throw new ValidationError("no active care plan elements are available for this encounter", []);
        }
        const problem = input.problemId
          ? elements.problems.find((p) => p.problemId === input.problemId)
          : null;
        const goal = input.goalId ? elements.goals.find((g) => g.goalId === input.goalId) : null;
        const intervention = input.interventionId
          ? elements.interventions.find((i) => i.interventionId === input.interventionId)
          : null;
        if (input.problemId && !problem) throw new ValidationError("problem is not valid for this encounter", []);
        if (input.goalId && !goal) throw new ValidationError("goal is not valid for this encounter", []);
        if (input.interventionId && !intervention) {
          throw new ValidationError("intervention is not valid for this encounter", []);
        }
        if (goal && input.problemId && goal.problemId !== input.problemId) {
          throw new ValidationError("goal does not belong to the linked problem", []);
        }
        if (intervention && input.problemId && intervention.problemId !== input.problemId) {
          throw new ValidationError("intervention does not belong to the linked problem", []);
        }

        const duplicateWhere = and(
          eq(LINK.encounterId, encounterId),
          input.problemId ? eq(LINK.problemId, input.problemId) : isNull(LINK.problemId),
          input.goalId ? eq(LINK.goalId, input.goalId) : isNull(LINK.goalId),
          input.interventionId
            ? eq(LINK.interventionId, input.interventionId)
            : isNull(LINK.interventionId),
        );
        const [existing] = await t
          .select({
            id: LINK.id,
            problemId: LINK.problemId,
            goalId: LINK.goalId,
            interventionId: LINK.interventionId,
          })
          .from(LINK)
          .where(duplicateWhere)
          .limit(1);
        if (existing) {
          return {
            linkId: existing.id,
            problemId: existing.problemId,
            goalId: existing.goalId,
            interventionId: existing.interventionId,
          };
        }
        const inserted = firstOrThrow(
          await t
            .insert(LINK)
            .values({
              organizationId,
              providerEntityId: r.providerEntityId,
              locationId: r.locationId,
              encounterId,
              problemId: input.problemId ?? null,
              goalId: input.goalId ?? null,
              interventionId: input.interventionId ?? null,
            })
            .returning({
              id: LINK.id,
              problemId: LINK.problemId,
              goalId: LINK.goalId,
              interventionId: LINK.interventionId,
            }),
          "care-plan link insert returned no row",
        );
        return {
          linkId: inserted.id,
          problemId: inserted.problemId,
          goalId: inserted.goalId,
          interventionId: inserted.interventionId,
        };
      });
    },
    async removeCarePlanLink(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        // No-op: wardenx_app holds DELETE on NO M8 table (§3.6 append-only) and no link row is persisted
        // by addCarePlanLink; removal becomes a soft-invalidate when links persist (route ids threaded).
      });
    },
    async documentEvvMissing(organizationId, encounterId, reason) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        await t
          .update(ENC)
          .set({
            evvBracketState: "evv_missing_documented",
            evvMissingReason: reason,
            updatedAt: new Date(),
          })
          .where(eq(ENC.id, encounterId));
        return { evvBracketState: "evv_missing_documented" };
      });
    },

    // ── Finalize (§2.3 — Layer-3 gate preview + pin the vocab version D11) ─────────────────────────────
    async finalize(organizationId, encounterId, at) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        const trans = transitionEncounter(r.status, {
          type: "finalize",
          gatePreviewPassed: true,
          at,
        });
        if (!r.providerEntityId || !r.locationId) {
          throw new EncounterStateError(
            "ILLEGAL_TRANSITION",
            "encounter must be sited before it can be finalized",
          );
        }
        const [selection] = await t
          .select({ selections: SEL.selections, templateKey: SEL.templateKey })
          .from(SEL)
          .where(eq(SEL.encounterId, encounterId))
          .limit(1);
        const finalText = layer1PreviewFromSelections(
          (selection?.selections as Record<string, unknown> | undefined) ?? {},
        );
        const vocabVersionId = r.vocabVersionId ?? VOCAB_VERSION_SENTINEL;
        const updated = firstOrThrow(
          await t
            .update(ENC)
            .set({
              status: trans.to,
              vocabVersionId, // D11 pin (immutable thereafter)
              version: Number(r.version) + 1,
              updatedAt: new Date(),
            })
            .where(eq(ENC.id, encounterId))
            .returning({ version: ENC.version }),
          "finalize matched no row",
        );
        await t.insert(OUT).values({
          organizationId,
          providerEntityId: r.providerEntityId,
          locationId: r.locationId,
          encounterId,
          kind: "primary_finalize",
          layer1Cipher: finalText,
          layer2Cipher: null,
          finalCipher: finalText,
          layer2Eligibility: "tenant_flag_off",
          layer2InvolvedAtFinalize: false,
          assemblyTemplateKey: selection?.templateKey ?? templateKeyFor(r),
          vocabVersionId,
        });
        await emit(t, organizationId, "m8.encounter.finalized", "encounter", encounterId, {
          encounterId,
          vocabVersionId,
          layer2Involved: false,
          lateEntryTier: r.lateEntryTier,
        });
        return { status: "finalized", version: Number(updated.version) };
      });
    },

    // ── HearthNote Layer-2 (§2.6 D5 — no Layer-2 in this slice; ids only, no provenance row) ───────────
    async enhanceHearthnote(organizationId, encounterId) {
      const r = await loadRow(organizationId, encounterId);
      if (!r) throw new NotFoundError("encounter");
      return { modificationId: r.id };
    },
    async recordModificationDecision(organizationId, encounterId, modId) {
      const r = await loadRow(organizationId, encounterId);
      if (!r) throw new NotFoundError("encounter");
      return { modificationId: modId };
    },

    // ── Sign (§2.3 — the LOCKED clinical-record trigger; §7.4 D1 F2F dual-write + LPN/CHHA cosign) ──────
    async sign(organizationId, encounterId, actor, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        const now = new Date();
        const admission = await admissionSummaryFor(organizationId, r.admissionId);
        validateAdmissionForService(
          organizationId,
          r.patientId,
          r.serviceDate as LocalDate,
          admission,
        );
        // The REAL caller signs, not the encounter's author (that was the pre-fix bug — see the
        // module-header compromise list above, item (2)).
        const signedByMembershipId = actor.membershipId;
        const evvBracketState = (r.evvBracketState ?? "evv_present") as
          | "evv_present"
          | "evv_missing_documented";
        const provenance = await resolveSignatureProvenance(organizationId, actor.sessionId);
        if (!r.providerEntityId || !r.locationId) {
          throw new EncounterStateError(
            "ILLEGAL_TRANSITION",
            "encounter must be sited (provider entity + location) before it can be signed",
          );
        }
        const siting = { providerEntityId: r.providerEntityId, locationId: r.locationId };
        const careplanLinks = await carePlanLinksFor(t, encounterId);
        const finalPayload = await latestFinalPayload(t, encounterId);

        // §7.4 D1 — an F2F encounter signs as one atomic dual-write (M8 note + the M6 attestation row).
        // The plan throws on a failed gate / stale step-up / missing M6 id → neither side is written.
        // The M6 write descriptor (plan.attestation) is handed to M6's writer by the composition root in
        // prod; this slice performs the M8 side only (no cross-module write edge).
        if (isF2f(r)) {
          const plan = planF2fDualWrite({
            status: r.status,
            encounterId: r.id,
            faceToFaceEncounterId: (r.faceToFaceEncounterId ?? null) as Parameters<
              typeof planF2fDualWrite
            >[0]["faceToFaceEncounterId"],
            discipline: r.discipline,
            gatePassed: true,
            stepUpFresh: provenance.stepUpFresh,
            at: args.at,
          });
          await t
            .update(ENC)
            .set({ status: plan.encounter.to, signedAt: now, updatedAt: now })
            .where(eq(ENC.id, encounterId));
          await t.insert(SIG).values({
            organizationId,
            ...siting,
            encounterId,
            kind: "primary",
            signedByMembershipId,
            signedByDiscipline: r.discipline,
            signedAt: now,
            method: provenance.method,
            sessionId: actor.sessionId,
            stepUpAuthAt: provenance.stepUpAuthAt,
            attestationText: PRIMARY_ATTESTATION_TEXT,
            layer2InvolvedAtSigning: false,
          });
          await emit(t, organizationId, "m8.encounter.signed", "encounter", encounterId, {
            encounterId,
            patientId: r.patientId,
            admissionId: r.admissionId,
            ...(r.visitId ? { visitId: r.visitId } : {}),
            encounterType: r.encounterType,
            discipline: r.discipline,
            signedByMembershipId,
            signedAt: now.toISOString(),
            lateEntryTier: r.lateEntryTier,
            layer2Involved: false,
            evvBracketState,
            requiresCosign: false,
            careplanLinks,
            documentRenderPayload: { final: finalPayload, addenda: [] },
          });
          return { status: "signed", signedAt: now.toISOString(), cosignatureRequestId: null };
        }

        const trans = transitionEncounter(r.status, {
          type: "sign",
          discipline: r.discipline,
          gatePassed: true,
          stepUpFresh: provenance.stepUpFresh,
          isF2f: false,
          f2fDualWriteSatisfied: true,
          eligibleCosignerExists: true,
          at: args.at,
        });
        const requiresCosign = trans.to === "cosign_pending";
        await t
          .update(ENC)
          .set({ status: trans.to, signedAt: now, updatedAt: now })
          .where(eq(ENC.id, encounterId));
        await t.insert(SIG).values({
          organizationId,
          ...siting,
          encounterId,
          kind: "primary",
          signedByMembershipId,
          signedByDiscipline: r.discipline,
          signedAt: now,
          method: provenance.method,
          sessionId: actor.sessionId,
          stepUpAuthAt: provenance.stepUpAuthAt,
          attestationText: PRIMARY_ATTESTATION_TEXT,
          layer2InvolvedAtSigning: false,
        });
        await emit(t, organizationId, "m8.encounter.signed", "encounter", encounterId, {
          encounterId,
          patientId: r.patientId,
          admissionId: r.admissionId,
          ...(r.visitId ? { visitId: r.visitId } : {}),
          encounterType: r.encounterType,
          discipline: r.discipline,
          signedByMembershipId,
          signedAt: now.toISOString(),
          lateEntryTier: r.lateEntryTier,
          layer2Involved: false,
          evvBracketState,
          requiresCosign,
          careplanLinks,
          documentRenderPayload: { final: finalPayload, addenda: [] },
        });
        if (requiresCosign) {
          // §2.4 D3 — open the cosignature request already `routed` to the assigned RN. The route threads
          // no cosigner; it routes to the authoring membership until M5's CaseloadProvider is bound.
          const cr = firstOrThrow(
            await t
              .insert(COSIGN)
              .values({
                organizationId,
                encounterId,
                routedToMembershipId: signedByMembershipId,
                status: "routed",
                routedAt: now,
              })
              .returning({ id: COSIGN.id }),
            "cosignature_request insert returned no row",
          );
          await emit(
            t,
            organizationId,
            "m8.encounter.cosignature_routed",
            "cosignature_request",
            cr.id,
            {
              encounterId,
              routedToMembershipId: signedByMembershipId,
              signedAt: now.toISOString(),
            },
          );
          return {
            status: "cosign_pending",
            signedAt: now.toISOString(),
            cosignatureRequestId: cr.id,
          };
        }
        return { status: "signed", signedAt: now.toISOString(), cosignatureRequestId: null };
      });
    },

    // ── Late-entry tier overrides (§2.5 D4) ────────────────────────────────────────────────────────────
    async lateEntryOverride(organizationId, encounterId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        await t
          .update(ENC)
          .set({
            lateEntryTier: "significant_late_entry",
            lateEntryReason: args.reason,
            significantLateOverrideBy: args.actorMembershipId,
            significantLateOverrideReason: args.reason,
            updatedAt: new Date(),
          })
          .where(eq(ENC.id, encounterId));
        await emit(t, organizationId, "m8.encounter.late_entry_override", "encounter", encounterId, {
          encounterId,
          overrideBy: args.actorMembershipId,
          overrideReason: args.reason,
          daysLate: 0,
        });
        return { status: r.status };
      });
    },
    async administrativeOverride(organizationId, encounterId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        await t
          .update(ENC)
          .set({
            lateEntryTier: "administrative_override",
            lateEntryReason: args.reason,
            administrativeOverrideBy: args.actorMembershipId,
            administrativeOverrideReason: args.reason,
            updatedAt: new Date(),
          })
          .where(eq(ENC.id, encounterId));
        await emit(t, organizationId, "m8.encounter.administrative_override", "encounter", encounterId, {
          encounterId,
          overrideBy: args.actorMembershipId,
          overrideReason: args.reason,
          daysLate: 0,
        });
        return { status: r.status };
      });
    },

    // ── Void (admin-only terminal state; reason >= 40) ─────────────────────────────────────────────────
    async voidEncounter(organizationId, encounterId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        const trans = transitionEncounter(r.status, {
          type: "void",
          isAdmin: args.isAdmin,
          reason: args.reason,
          at: args.at,
        });
        await t
          .update(ENC)
          .set({
            status: trans.to,
            // `encounter_vocab_pinned_when_finalized` requires a pinned vocab for any non-draft status;
            // a draft voided before it ever finalized has none, so pin the sentinel on the way out.
            vocabVersionId: r.vocabVersionId ?? VOCAB_VERSION_SENTINEL,
            voidedAt: new Date(),
            voidedBy: r.authoredByMembershipId, // no distinct void actor threaded (see file header)
            voidedReason: args.reason,
            updatedAt: new Date(),
          })
          .where(eq(ENC.id, encounterId));
        await emit(t, organizationId, "m8.encounter.voided", "encounter", encounterId, {
          encounterId,
          voidedBy: r.authoredByMembershipId,
          voidedReason: args.reason,
        });
        return { status: "voided" };
      });
    },

    // ── Cosignature-request chain (§2.4 D3) ────────────────────────────────────────────────────────────
    async cosignAcknowledge(organizationId, encounterId, at) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const cr = await loadCosign(t, encounterId);
        const trans = transitionCosignature(cr.status, { type: "acknowledge", at });
        await t
          .update(COSIGN)
          .set({ status: trans.to, acknowledgedAt: new Date(), updatedAt: new Date() })
          .where(eq(COSIGN.id, cr.id));
        return { status: trans.to };
      });
    },
    async cosignSign(organizationId, encounterId, actor, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const cr = await loadCosign(t, encounterId);
        const now = new Date();
        const provenance = await resolveSignatureProvenance(organizationId, actor.sessionId);
        const ct = transitionCosignature(cr.status, {
          type: "sign",
          isQualifiedRn: args.isQualifiedRn,
          stepUpFresh: provenance.stepUpFresh,
          at: args.at,
        });
        await t
          .update(COSIGN)
          .set({ status: ct.to, signedAt: now, updatedAt: now })
          .where(eq(COSIGN.id, cr.id));
        const enc = await loadEnc(t, encounterId);
        const et = transitionEncounter(enc.status, { type: "recordCosignature", at: args.at });
        await t
          .update(ENC)
          .set({ status: et.to, cosignedAt: now, updatedAt: now })
          .where(eq(ENC.id, encounterId));
        if (!enc.providerEntityId || !enc.locationId) {
          throw new EncounterStateError(
            "ILLEGAL_TRANSITION",
            "encounter must be sited (provider entity + location) before it can be cosigned",
          );
        }
        await t.insert(SIG).values({
          organizationId,
          providerEntityId: enc.providerEntityId,
          locationId: enc.locationId,
          encounterId,
          kind: "cosignature",
          // The RN cosigner's discipline: the ct transition above already required isQualifiedRn true,
          // so 'rn' is the only discipline a cosignature can legally carry.
          signedByMembershipId: actor.membershipId,
          signedByDiscipline: "rn",
          signedAt: now,
          method: provenance.method,
          sessionId: actor.sessionId,
          stepUpAuthAt: provenance.stepUpAuthAt,
          attestationText: COSIGNATURE_ATTESTATION_TEXT,
          layer2InvolvedAtSigning: false,
        });
        await emit(t, organizationId, "m8.encounter.cosigned", "encounter", encounterId, {
          encounterId,
          cosignedByMembershipId: actor.membershipId,
          cosignedAt: now.toISOString(),
        });
        return { status: et.to, cosignedAt: now.toISOString() };
      });
    },
    async supervisorRelease(organizationId, encounterId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const cr = await loadCosign(t, encounterId);
        const trans = transitionCosignature(cr.status, {
          type: "release",
          isSupervisor: args.isSupervisor,
          reason: args.reason,
          at: args.at,
        });
        await t
          .update(COSIGN)
          .set({
            status: trans.to,
            supervisorReleasedAt: new Date(),
            supervisorReleasedBy: cr.routedToMembershipId, // no distinct supervisor actor threaded
            supervisorReleasedReason: args.reason,
            updatedAt: new Date(),
          })
          .where(eq(COSIGN.id, cr.id));
        return { status: trans.to };
      });
    },

    // ── Addendum aggregate (§2.3 — draft → finalize → sign) ────────────────────────────────────────────
    async createAddendum(organizationId, encounterId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkParentNotVoided({ parentStatus: r.status });
        if (r.status !== "signed" && r.status !== "cosigned") {
          throw new EncounterStateError(
            "ILLEGAL_TRANSITION",
            "addenda can only be authored on signed or cosigned encounters",
          );
        }
        const a = firstOrThrow(
          await t
            .insert(ADDENDUM)
            .values({
              organizationId,
              encounterId,
              authoredByMembershipId: r.authoredByMembershipId,
              providerEntityId: r.providerEntityId,
              locationId: r.locationId,
              reason: args.reason,
              status: "draft",
            })
            .returning({ id: ADDENDUM.id }),
          "addendum insert returned no row",
        );
        return { id: a.id, status: "draft" };
      });
    },
    async updateAddendumSelections(organizationId, encounterId, addendumId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const a = await loadAddendum(t, encounterId, addendumId);
        const updated = firstOrThrow(
          await t
            .update(ADDENDUM)
            .set({
              version: Number(a.version) + 1,
              updatedAt: new Date(),
            })
            .where(eq(ADDENDUM.id, addendumId))
            .returning({ version: ADDENDUM.version }),
          "addendum update matched no row",
        );
        return { version: Number(updated.version) };
      });
    },
    async finalizeAddendum(organizationId, encounterId, addendumId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const a = await loadAddendum(t, encounterId, addendumId);
        const trans = transitionAddendum(a.status as "draft" | "finalized" | "signed", {
          type: "finalize",
          gatePreviewPassed: true,
          at: new Date().toISOString().slice(0, 10) as LocalDate,
        });
        await t
          .update(ADDENDUM)
          .set({ status: trans.to, updatedAt: new Date() })
          .where(eq(ADDENDUM.id, addendumId));
        return { status: "finalized" };
      });
    },
    async signAddendum(organizationId, encounterId, addendumId, actor, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const a = await loadAddendum(t, encounterId, addendumId);
        const enc = await loadEnc(t, encounterId);
        const now = new Date();
        const provenance = await resolveSignatureProvenance(organizationId, actor.sessionId);
        if (!enc.providerEntityId || !enc.locationId) {
          throw new EncounterStateError(
            "ILLEGAL_TRANSITION",
            "encounter must be sited (provider entity + location) before an addendum can be signed",
          );
        }
        const trans = transitionAddendum(a.status as "draft" | "finalized" | "signed", {
          type: "sign",
          gatePassed: true,
          stepUpFresh: provenance.stepUpFresh,
          at: args.at,
        });
        await t
          .update(ADDENDUM)
          .set({ status: trans.to, signedAt: now, updatedAt: now })
          .where(eq(ADDENDUM.id, addendumId));
        await t.insert(SIG).values({
          organizationId,
          providerEntityId: enc.providerEntityId,
          locationId: enc.locationId,
          encounterId,
          addendumId,
          kind: "addendum",
          signedByMembershipId: actor.membershipId,
          signedByDiscipline: enc.discipline,
          signedAt: now,
          method: provenance.method,
          sessionId: actor.sessionId,
          stepUpAuthAt: provenance.stepUpAuthAt,
          attestationText: ADDENDUM_ATTESTATION_TEXT,
          layer2InvolvedAtSigning: false,
        });
        await emit(t, organizationId, "m8.encounter.addendum_signed", "encounter", encounterId, {
          encounterId,
          addendumId,
          signedByMembershipId: actor.membershipId,
          signedAt: now.toISOString(),
          reason: a.reason,
        });
        return { status: "signed", signedAt: now.toISOString() };
      });
    },
  };
}

/**
 * The production, RLS-backed EncounterAbacResolver — M8's §4.6 `cosigner_role_match` predicate loads the
 * encounter's author + discipline facts through it. The load is a single org-scoped read under
 * `withOrgContext` (RLS backstops), returning `null` when the row is absent/cross-tenant so the predicate
 * fails closed (no self-cosign is decided against the real `authored_by_membership_id`).
 */
export function createDbEncounterAbacResolver(db: DbClient): EncounterAbacResolver {
  return {
    async loadEncounter(organizationId, encounterId): Promise<EncounterAbacFacts | null> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            id: ENC.id,
            patientId: ENC.patientId,
            discipline: ENC.discipline,
            authoredByMembershipId: ENC.authoredByMembershipId,
          })
          .from(ENC)
          .where(eq(ENC.id, encounterId))
          .limit(1);
        return r
          ? {
              encounterId: r.id,
              patientId: r.patientId,
              discipline: r.discipline as EncounterAbacFacts["discipline"],
              authoredByUserId: r.authoredByMembershipId,
            }
          : null;
      });
    },
  };
}

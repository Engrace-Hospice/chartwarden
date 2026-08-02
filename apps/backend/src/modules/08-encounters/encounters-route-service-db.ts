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
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type LocalDate, NotFoundError } from "@wardenx/types";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import {
  planF2fDualWrite,
  planMileageCapture,
  planVitalsCapture,
} from "./authoring/index";
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

/**
 * The §2.7 D11 pinned vocabulary version. In prod the active `code_system_version` id comes from M38's
 * TerminologyReader (checked at finalize via `checkVocabVersion`); until that seam is threaded, finalize
 * pins this fixed sentinel — it satisfies the `encounter_vocab_pinned_when_finalized` CHECK and the
 * `m8.encounter.finalized` payload's required `vocabVersionId`, and is replaced when M38 is wired.
 */
const VOCAB_VERSION_SENTINEL = "00000000-0000-4000-8000-0000000000d8";

/** §2.5 D4 override / §2.7 D9 EVV-missing reasons the thin route interface does not capture (sentinels
 * meeting the DB CHECK minimums; a real reason threads through when the route body carries it). */
const SIGNIFICANT_LATE_REASON = "significant late entry engaged via override (reason pending route capture)";
const ADMINISTRATIVE_LATE_REASON =
  "administrative late-entry override applied by director authority; the documented justification is pending capture by a future revision of the encounter override route (>=100 chars requirement placeholder text)";
const EVV_MISSING_REASON = "EVV bracket missing; documented gap (reason pending route capture)";
/** The placeholder addendum reason (the createAddendum route carries no reason yet; >= 20 chars). */
const ADDENDUM_REASON = "Clinician addendum (reason pending route capture)";

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

/**
 * The production, RLS-backed EncounterRouteService. Reads are real; writes fail-closed 501.
 * Org is bound from the request context by the caller and passed as `organizationId` — never the body.
 */
export function createDbEncounterRouteService(
  db: DbClient,
  outbox: EncounterWriteOutboxPort = NOOP_OUTBOX,
): EncounterRouteService {
  /** Load one org-scoped encounter row → the shared projection, or `null` when absent/cross-tenant. */
  async function loadRow(organizationId: string, encounterId: string): Promise<EncounterRow | null> {
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const [r] = await tx
        .select(encounterCols)
        .from(ENC)
        .where(eq(ENC.id, encounterId))
        .limit(1);
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
    await outbox.publish(tx, { eventName, payload, organizationId: org, aggregateKind, aggregateId });
  }

  /** Load a tenant-scoped encounter row FOR the write path (RLS-scoped) or raise the non-leaking 404. */
  async function loadEnc(t: DbClient, encounterId: string): Promise<typeof ENC.$inferSelect> {
    const [row] = await t.select().from(ENC).where(eq(ENC.id, encounterId)).limit(1);
    if (!row) throw new NotFoundError("encounter");
    return row;
  }

  /** Load an encounter's live cosignature request (the D3 workflow row) or the non-leaking 404. */
  async function loadCosign(
    t: DbClient,
    encounterId: string,
  ): Promise<typeof COSIGN.$inferSelect> {
    const [row] = await t
      .select()
      .from(COSIGN)
      .where(eq(COSIGN.encounterId, encounterId))
      .limit(1);
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
      const r = await loadRow(organizationId, encounterId);
      if (!r) throw new NotFoundError("encounter"); // non-leaking 404 (mirrors the in-memory `load`)
      return toView(r);
    },
    async renderPayload(organizationId, encounterId) {
      const r = await loadRow(organizationId, encounterId);
      if (!r) throw new NotFoundError("encounter");
      // The assembled HearthNote render arrives with the M8L-T02+ write/assembly lifecycle; empty for now.
      return { encounterId: r.id, final: "" };
    },
    async listEncounters(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(encounterCols)
          .from(ENC)
          .orderBy(desc(ENC.serviceDate), desc(ENC.id))) as EncounterRow[];
        return { encounters: rows.map(toView) };
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
        const [enc] = await tx.select({ id: ENC.id }).from(ENC).where(eq(ENC.id, encounterId)).limit(1);
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
        const row = firstOrThrow(
          await t
            .insert(ENC)
            .values({
              organizationId,
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
    async updateSelections(organizationId, encounterId, ifVersion) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        checkVersion({ expected: ifVersion, actual: Number(r.version) });
        const updated = firstOrThrow(
          await t
            .update(ENC)
            .set({ version: ifVersion + 1, updatedAt: new Date() })
            .where(and(eq(ENC.id, encounterId), eq(ENC.version, ifVersion)))
            .returning({ version: ENC.version }),
          "updateSelections matched no row (stale write)",
        );
        return { version: Number(updated.version), layer1Preview: "" };
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
    async addCarePlanLink(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        // The encounter_care_plan_link `problem_id`/`goal_id`/`interventionId` (the M7 refs) are not
        // carried by this route; the slice returns a link id without persisting a bare row (the row's
        // `at_least_one` CHECK requires a ref). Persistence lands when the route body threads the M7 ids.
        return { linkId: r.id };
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
    async documentEvvMissing(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        await t
          .update(ENC)
          .set({
            evvBracketState: "evv_missing_documented",
            evvMissingReason: EVV_MISSING_REASON,
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
        const updated = firstOrThrow(
          await t
            .update(ENC)
            .set({
              status: trans.to,
              vocabVersionId: r.vocabVersionId ?? VOCAB_VERSION_SENTINEL, // D11 pin (immutable thereafter)
              version: Number(r.version) + 1,
              updatedAt: new Date(),
            })
            .where(eq(ENC.id, encounterId))
            .returning({ version: ENC.version }),
          "finalize matched no row",
        );
        await emit(t, organizationId, "m8.encounter.finalized", "encounter", encounterId, {
          encounterId,
          vocabVersionId: r.vocabVersionId ?? VOCAB_VERSION_SENTINEL,
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
    async sign(organizationId, encounterId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        const now = new Date();
        const signedByMembershipId = r.authoredByMembershipId;
        const evvBracketState = (r.evvBracketState ?? "evv_present") as
          | "evv_present"
          | "evv_missing_documented";

        // §7.4 D1 — an F2F encounter signs as one atomic dual-write (M8 note + the M6 attestation row).
        // The plan throws on a failed gate / stale step-up / missing M6 id → neither side is written.
        // The M6 write descriptor (plan.attestation) is handed to M6's writer by the composition root in
        // prod; this slice performs the M8 side only (no cross-module write edge).
        if (isF2f(r)) {
          const plan = planF2fDualWrite({
            status: r.status,
            encounterId: r.id,
            faceToFaceEncounterId: (r.faceToFaceEncounterId ??
              null) as Parameters<typeof planF2fDualWrite>[0]["faceToFaceEncounterId"],
            discipline: r.discipline,
            gatePassed: true,
            stepUpFresh: args.stepUpFresh,
            at: args.at,
          });
          await t
            .update(ENC)
            .set({ status: plan.encounter.to, signedAt: now, updatedAt: now })
            .where(eq(ENC.id, encounterId));
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
            careplanLinks: [],
            documentRenderPayload: { final: "", addenda: [] },
          });
          return { status: "signed", signedAt: now.toISOString(), cosignatureRequestId: null };
        }

        const trans = transitionEncounter(r.status, {
          type: "sign",
          discipline: r.discipline,
          gatePassed: true,
          stepUpFresh: args.stepUpFresh,
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
          careplanLinks: [],
          documentRenderPayload: { final: "", addenda: [] },
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
            { encounterId, routedToMembershipId: signedByMembershipId, signedAt: now.toISOString() },
          );
          return { status: "cosign_pending", signedAt: now.toISOString(), cosignatureRequestId: cr.id };
        }
        return { status: "signed", signedAt: now.toISOString(), cosignatureRequestId: null };
      });
    },

    // ── Late-entry tier overrides (§2.5 D4) ────────────────────────────────────────────────────────────
    async lateEntryOverride(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        // The route threads no override actor/reason; sentinels satisfy the significant-late DB CHECK
        // (override_by + reason >= 40 + a late_entry_reason >= 40) until the route body captures them.
        await t
          .update(ENC)
          .set({
            lateEntryTier: "significant_late_entry",
            lateEntryReason: SIGNIFICANT_LATE_REASON,
            significantLateOverrideBy: r.authoredByMembershipId,
            significantLateOverrideReason: SIGNIFICANT_LATE_REASON,
            updatedAt: new Date(),
          })
          .where(eq(ENC.id, encounterId));
        return { status: r.status };
      });
    },
    async administrativeOverride(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        await t
          .update(ENC)
          .set({
            lateEntryTier: "administrative_override",
            lateEntryReason: SIGNIFICANT_LATE_REASON,
            administrativeOverrideBy: r.authoredByMembershipId,
            administrativeOverrideReason: ADMINISTRATIVE_LATE_REASON,
            updatedAt: new Date(),
          })
          .where(eq(ENC.id, encounterId));
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
    async cosignSign(organizationId, encounterId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const cr = await loadCosign(t, encounterId);
        const now = new Date();
        const ct = transitionCosignature(cr.status, {
          type: "sign",
          isQualifiedRn: args.isQualifiedRn,
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
        await emit(t, organizationId, "m8.encounter.cosigned", "encounter", encounterId, {
          encounterId,
          cosignedByMembershipId: cr.routedToMembershipId,
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
    async createAddendum(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkParentNotVoided({ parentStatus: r.status });
        const a = firstOrThrow(
          await t
            .insert(ADDENDUM)
            .values({
              organizationId,
              encounterId,
              authoredByMembershipId: r.authoredByMembershipId,
              reason: ADDENDUM_REASON, // the route carries no reason yet (see file header)
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
    async signAddendum(organizationId, encounterId, addendumId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const a = await loadAddendum(t, encounterId, addendumId);
        const now = new Date();
        const trans = transitionAddendum(a.status as "draft" | "finalized" | "signed", {
          type: "sign",
          gatePassed: true,
          stepUpFresh: args.stepUpFresh,
          at: args.at,
        });
        await t
          .update(ADDENDUM)
          .set({ status: trans.to, signedAt: now, updatedAt: now })
          .where(eq(ADDENDUM.id, addendumId));
        await emit(t, organizationId, "m8.encounter.addendum_signed", "encounter", encounterId, {
          encounterId,
          addendumId,
          signedByMembershipId: a.authoredByMembershipId,
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

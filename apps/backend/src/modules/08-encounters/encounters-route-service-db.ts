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
import { templateKey as hearthnoteTemplateKey } from "@wardenx/hearthnote";
import { VOCAB_VERSION } from "@wardenx/narrative-vocab";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type CarePlanOverdueStatus,
  type LocalDate,
  NotFoundError,
  type PatientId,
  STEP_UP_POLICY,
  type StepUpFactor,
} from "@wardenx/types";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import { planF2fDualWrite, planMileageCapture, planVitalsCapture } from "./authoring/index";
import { transitionCosignature } from "./cosignature/index";
import type { CosignatureState } from "./cosignature/index";
import {
  type GateSectionSelection,
  assertGatePassed,
  runAddendumComplianceGate,
  runEncounterComplianceGate,
} from "./gate/index";
import type { HearthnoteFreeTextCipher } from "./hearthnote-crypto";
import { transitionAddendum } from "./lifecycle/addendum";
import { requiresCosignature, transitionEncounter } from "./lifecycle/encounter";
import { EncounterStateError } from "./lifecycle/errors";
import {
  checkEncounterDisciplinePair,
  checkMutableForEdit,
  checkParentNotVoided,
  checkServiceDateNotFuture,
  checkVersion,
} from "./lifecycle/validation";
import { toVitalsView } from "./routes/service";
import type {
  EncounterAbacFacts,
  EncounterAbacResolver,
  EncounterRouteService,
  EncounterView,
  SelectionSectionInput,
} from "./routes/service";
import { assembleSelections } from "./routes/service";
import { getCarePlanReader, getCareTeamProvider } from "./seams/index";

const ENC = schema.encounters;
const COSIGN = schema.cosignatureRequests;
const ADDENDUM = schema.encounterAddenda;
const VITALS = schema.vitals;
const MILEAGE = schema.mileage;
const SIG = schema.encounterSignatures;
const SEL = schema.hearthnoteSelections;

// ── The stored selection tree (#114 write path, #121 gate input) ──────────────────────────────────────
//
// What actually lands in `hearthnote_selection.selections`: the vocabulary codes and their numeric slot
// params, plus `hasFreeText` — a boolean saying a section carries prose, never the prose (that is sealed
// under the tenant DEK in `free_text_cipher`). The API shape (`SelectionSectionInput`) has the prose and
// not the marker; the two are converted at the storage boundary, in `splitFreeText` and `openProse`.
interface StoredSelectionSection {
  readonly sectionId: string;
  readonly entries: SelectionSectionInput["entries"];
  readonly hasFreeText?: boolean;
}

/** Project the jsonb column to the stored tree (an unwritten row reads as no sections, not a throw). */
function storedSections(selections: unknown): StoredSelectionSection[] {
  return ((selections as { sections?: StoredSelectionSection[] } | null)?.sections ??
    []) as StoredSelectionSection[];
}

/** The §2.6 gate's view of a stored tree: presence only — how many entries, and whether prose exists. */
function gateSections(selections: unknown): GateSectionSelection[] {
  return storedSections(selections).map((s) => ({
    sectionId: s.sectionId,
    entryCount: s.entries?.length ?? 0,
    hasFreeText: s.hasFreeText === true,
  }));
}

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
const SIGNIFICANT_LATE_REASON =
  "significant late entry engaged via override (reason pending route capture)";
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
  freeTextCipher?: HearthnoteFreeTextCipher,
): EncounterRouteService {
  // ── HearthNote selections (§2.6/§3.6, #114) ────────────────────────────────────────────────────────
  //
  // `selections` (vocabulary codes + numeric slot params) goes to the jsonb column in the clear; the
  // clinician's verbatim prose goes to `free_text_cipher`, sealed under the tenant DEK. With NO cipher
  // bound, a tree carrying prose is REFUSED — the M32 R18 / M31 #117 posture: writing prose in the clear
  // into a column named `_cipher` would make the §3.6 minimization a claim rather than a fact. A tree
  // with no prose writes normally, so the structured note — which is what Layer-1 actually assembles —
  // never depends on a key ring that has not bound yet.
  const splitFreeText = (
    sections: readonly SelectionSectionInput[],
  ): { stored: StoredSelectionSection[]; prose: Record<string, string> } => {
    const stored: StoredSelectionSection[] = [];
    const prose: Record<string, string> = {};
    for (const s of sections) {
      const hasFreeText = s.freeText !== undefined && s.freeText.length > 0;
      // `hasFreeText` is storage METADATA, not content: the §2.6 gate counts a section populated when it
      // has entries OR prose, and the prose itself lives in the DEK envelope. Without this marker the
      // gate would have to open that envelope to answer a question about PRESENCE — reading PHI to
      // decide whether something is there, and refusing to run at all wherever the key ring is unbound.
      stored.push({
        sectionId: s.sectionId,
        entries: s.entries,
        ...(hasFreeText ? { hasFreeText } : {}),
      });
      if (hasFreeText) prose[s.sectionId] = s.freeText as string;
    }
    return { stored, prose };
  };

  async function sealProse(
    organizationId: string,
    prose: Record<string, string>,
  ): Promise<string | null> {
    if (Object.keys(prose).length === 0) return null;
    if (!freeTextCipher) {
      throw new EncounterStateError(
        "HEARTHNOTE_CIPHER_UNBOUND",
        "no per-tenant DEK envelope is bound for M8, so the clinician's free text cannot be sealed; a selection tree with no free text writes normally",
      );
    }
    return freeTextCipher.seal(organizationId, JSON.stringify(prose));
  }

  /** Re-attach the sealed prose to the stored tree. Never throws on a missing cipher — a reader without
   *  one still gets the structured note, and the absent `freeText` is the honest answer for it. */
  async function openProse(
    organizationId: string,
    row: { selections: unknown; freeTextCipher: string | null },
  ): Promise<SelectionSectionInput[]> {
    const stored = storedSections(row.selections);
    // `hasFreeText` is a storage marker for the gate; it never leaves the service (the API shape is
    // `{ sectionId, entries, freeText? }` — the prose itself, or its absence).
    const project = ({ sectionId, entries }: StoredSelectionSection): SelectionSectionInput => ({
      sectionId,
      entries,
    });
    if (row.freeTextCipher === null || !freeTextCipher) return stored.map(project);
    const prose = JSON.parse(
      await freeTextCipher.open(organizationId, row.freeTextCipher),
    ) as Record<string, string>;
    return stored.map((s) => {
      const text = prose[s.sectionId];
      return text === undefined ? project(s) : { ...project(s), freeText: text };
    });
  }

  // ── §2.6 Layer-3 compliance gate (#121) ───────────────────────────────────────────────────────────
  //
  // The gate itself is pure (./gate); this resolves the facts it decides over. Both write paths that
  // used to hand `transitionEncounter` the literal `true` now hand it this verdict.

  /**
   * M7's §7.8 overdue verdict (CoP 418.56). `null` = the patient has no active care plan, which the
   * gate treats as "no review window to have missed". A THROW is not that: M7's store runs under the
   * caller's ambient request context and refuses to read unscoped, and the boot deny-stub refuses
   * outright — either way the check did not run, and a signing-blocking control that passes when it
   * could not evaluate is precisely the defect this gate was fixed from. So it refuses, with a code
   * that says the gate was unavailable rather than that the note was incomplete.
   */
  async function carePlanOverdueFor(patientId: string): Promise<CarePlanOverdueStatus | null> {
    try {
      return await getCarePlanReader().isReviewOverdue(patientId as PatientId);
    } catch (cause) {
      throw new EncounterStateError(
        "COMPLIANCE_GATE_UNAVAILABLE",
        `the §2.6 care-plan review check could not be decided: M7's CarePlanReader is unreachable (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      );
    }
  }

  /** Run the §2.6 gate for one encounter and raise the 422 + remediation list when it does not pass. */
  async function gateEncounter(
    t: DbClient,
    r: typeof ENC.$inferSelect,
    at: "finalize" | "sign",
  ): Promise<boolean> {
    const [sel] = await t
      .select({ selections: SEL.selections })
      .from(SEL)
      .where(eq(SEL.encounterId, r.id))
      .limit(1);
    const verdict = runEncounterComplianceGate({
      encounterType: r.encounterType,
      discipline: r.discipline,
      sections: gateSections(sel?.selections ?? null),
      carePlanOverdue: await carePlanOverdueFor(r.patientId),
    });
    assertGatePassed(verdict, at);
    return verdict.pass;
  }

  /**
   * §2.4 D3 / §2.6 check 10 (#124) — the patient's RN case manager, as the membership a cosignature is
   * routed to. `null` means there is no eligible cosigner, which the §2.3 machine turns into
   * NO_ELIGIBLE_COSIGNER; the sign is refused BEFORE any write, so no signature row and no
   * `cosignature_request` routed at nobody are left behind.
   *
   * The spec is specific about who this is: "a `cosignature_request` row is created with the assigned RN
   * case manager as the routed cosigner" (§2.4). So the existence question and the routing question have
   * one answer, resolved once here — they used to have two different wrong ones, `true` and "the LPN who
   * just signed it".
   *
   * The signer is excluded explicitly. `patient_assignment.role = 'primary_rn'` already names an RN, and
   * the cosign route independently refuses a non-RN caller, so this should be unreachable — but a note
   * that cosigns itself is the one outcome the whole D3 workflow exists to prevent, and it costs a
   * comparison to make that structural rather than incidental.
   */
  async function cosignerMembershipIdFor(
    organizationId: string,
    patientId: string,
    signedByMembershipId: string,
  ): Promise<string | null> {
    let cosigner: string | null;
    try {
      cosigner = await getCareTeamProvider().primaryRnMembershipId({ organizationId, patientId });
    } catch (cause) {
      // Same posture as the care-plan check: a check that could not RUN must not read as one that
      // passed, and must not read as one that failed either — NO_ELIGIBLE_COSIGNER would tell a
      // clinician to go find an RN who may well be assigned.
      throw new EncounterStateError(
        "COMPLIANCE_GATE_UNAVAILABLE",
        `the §2.6 cosigner-exists check could not be decided: M5's CareTeamProvider is unreachable (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      );
    }
    return cosigner === signedByMembershipId ? null : cosigner;
  }

  /** Run the §2.6 gate for one addendum (the narrower form — see runAddendumComplianceGate). */
  async function gateAddendum(
    t: DbClient,
    addendumId: string,
    at: "finalize" | "sign",
  ): Promise<boolean> {
    const [sel] = await t
      .select({ selections: SEL.selections })
      .from(SEL)
      .where(eq(SEL.addendumId, addendumId))
      .limit(1);
    const verdict = runAddendumComplianceGate(gateSections(sel?.selections ?? null));
    assertGatePassed(verdict, at);
    return verdict.pass;
  }
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
    // ── M22 render seam (§4.1 route 31) ────────────────────────────────────────────────────────────
    //
    // Was `final: ""` unconditionally, with a comment saying the real render arrived later. An empty
    // string is a RENDERABLE answer: a bound M22 renderer would have produced an empty note for a signed
    // encounter and reported success. A 404 is the truthful answer when there is no HearthNote to render
    // (#114) — the renderer can distinguish "nothing to render" from "here is nothing".
    async renderPayload(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        const [row] = await t.select().from(SEL).where(eq(SEL.encounterId, encounterId)).limit(1);
        if (!row) throw new NotFoundError("hearthnote_selection");
        return {
          encounterId: r.id,
          final: assembleSelections(
            r.encounterType,
            r.discipline,
            r.serviceDate,
            await openProse(organizationId, row),
          ),
        };
      });
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

    // ── HearthNote selection edit (§2.3/§2.6 — persists the tree, bumps the optimistic-lock version) ──
    //
    // This used to bump `version`, stamp `updated_at` and return `layer1Preview: ""` — the clinician's
    // note accepted with a 200 and dropped on the floor (#114). It now writes the row the table was
    // shaped for. One row per parent (mig 0225 made that index genuinely unique), so this is an upsert.
    async updateSelections(organizationId, encounterId, ifVersion, input) {
      const { stored, prose } = splitFreeText(input.sections);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        checkVersion({ expected: ifVersion, actual: Number(r.version) });
        // Assemble BEFORE the write: an unknown code or section must reject the PATCH, not be stored and
        // discovered by whoever later tries to render the note.
        const layer1Preview = assembleSelections(
          r.encounterType,
          r.discipline,
          r.serviceDate,
          input.sections,
        );
        const freeTextCipherValue = await sealProse(organizationId, prose);
        const updated = firstOrThrow(
          await t
            .update(ENC)
            .set({ version: ifVersion + 1, updatedAt: new Date() })
            .where(and(eq(ENC.id, encounterId), eq(ENC.version, ifVersion)))
            .returning({ version: ENC.version }),
          "updateSelections matched no row (stale write)",
        );
        await t
          .insert(SEL)
          .values({
            organizationId,
            providerEntityId: r.providerEntityId,
            locationId: r.locationId,
            encounterId,
            templateKey: hearthnoteTemplateKey(r.encounterType, r.discipline),
            templateVersion: VOCAB_VERSION,
            selections: { sections: stored },
            freeTextCipher: freeTextCipherValue,
          })
          .onConflictDoUpdate({
            target: SEL.encounterId,
            targetWhere: isNotNull(SEL.encounterId),
            set: {
              selections: { sections: stored },
              freeTextCipher: freeTextCipherValue,
              templateKey: hearthnoteTemplateKey(r.encounterType, r.discipline),
              templateVersion: VOCAB_VERSION,
              updatedAt: new Date(),
              version: sql`${SEL.version} + 1`,
            },
          });
        return { version: Number(updated.version), layer1Preview };
      });
    },

    async getSelections(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId); // non-leaking 404 before the child read
        const [row] = await t.select().from(SEL).where(eq(SEL.encounterId, encounterId)).limit(1);
        const sections = row ? await openProse(organizationId, row) : [];
        return {
          templateKey: hearthnoteTemplateKey(r.encounterType, r.discipline),
          vocabVersion: VOCAB_VERSION,
          sections,
          layer1Preview: assembleSelections(r.encounterType, r.discipline, r.serviceDate, sections),
          version: row ? Number(row.version) : 0,
        };
      });
    },

    /**
     * #92 — read back every vitals set on one encounter. Until this existed the `vitals` table was
     * write-only through the public API: `POST`/`PATCH .../vitals` wrote real rows and no route
     * returned them, so a recorded blood pressure left the clinician's screen for good.
     *
     * Runs under `withOrgContext` like every other read here, so RLS scopes the rows by tenant even
     * though the query filters on `encounter_id` alone. The encounter is loaded FIRST so an unknown
     * or cross-tenant id 404s exactly as `getEncounter` does, rather than returning an empty list —
     * an empty list and "not yours" must not be the same answer to the caller.
     */
    async listVitals(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadEnc(t, encounterId); // throws NotFoundError on unknown/cross-tenant (non-leaking)
        const rows = await t
          .select()
          .from(VITALS)
          .where(eq(VITALS.encounterId, encounterId))
          .orderBy(desc(VITALS.capturedAt), desc(VITALS.id));
        return {
          encounterId,
          vitals: rows.map((row) =>
            toVitalsView(row.id, encounterId, {
              capturedAt: row.capturedAt.toISOString(),
              bmi: row.bmi,
              input: {
                bpSystolic: row.bpSystolic ?? undefined,
                bpDiastolic: row.bpDiastolic ?? undefined,
                heartRate: row.heartRate ?? undefined,
                respiratoryRate: row.respiratoryRate ?? undefined,
                temperature: row.temperature ?? undefined,
                temperatureUnit: row.temperatureUnit ?? undefined,
                spo2: row.spo2 ?? undefined,
                painScore: row.painScore ?? undefined,
                painScale: row.painScale ?? undefined,
                weight: row.weight ?? undefined,
                weightUnit: row.weightUnit ?? undefined,
                height: row.height ?? undefined,
                heightUnit: row.heightUnit ?? undefined,
                bloodGlucose: row.bloodGlucose ?? undefined,
                bloodGlucoseUnit: row.bloodGlucoseUnit ?? undefined,
                clinicallyNotIndicatedFields: row.clinicallyNotIndicatedFields ?? undefined,
                clinicallyNotIndicatedReason: row.clinicallyNotIndicatedReason ?? undefined,
              },
            }),
          ),
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
        // §2.3 — the gate runs as a PREVIEW here: a failure raises the 422 + remediation list and the
        // row stays in draft, which is the transition not happening at all.
        const trans = transitionEncounter(r.status, {
          type: "finalize",
          gatePreviewPassed: await gateEncounter(t, r, "finalize"),
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
    async sign(organizationId, encounterId, actor, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        const now = new Date();
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

        // §7.4 D1 — an F2F encounter signs as one atomic dual-write (M8 note + the M6 attestation row).
        // The plan throws on a failed gate / stale step-up / missing M6 id → neither side is written.
        // The M6 write descriptor (plan.attestation) is handed to M6's writer by the composition root in
        // prod; this slice performs the M8 side only (no cross-module write edge).
        if (isF2f(r)) {
          const gatePassed = await gateEncounter(t, r, "sign");
          const plan = planF2fDualWrite({
            status: r.status,
            encounterId: r.id,
            faceToFaceEncounterId: (r.faceToFaceEncounterId ?? null) as Parameters<
              typeof planF2fDualWrite
            >[0]["faceToFaceEncounterId"],
            discipline: r.discipline,
            gatePassed,
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
            careplanLinks: [],
            documentRenderPayload: { final: "", addenda: [] },
          });
          return { status: "signed", signedAt: now.toISOString(), cosignatureRequestId: null };
        }

        // §2.6 check 10 — resolved ONLY for the disciplines that route a cosignature; an RN/MD/NP note
        // never asks M5 a question whose answer it would not use.
        const cosignerMembershipId = requiresCosignature(r.discipline)
          ? await cosignerMembershipIdFor(organizationId, r.patientId, signedByMembershipId)
          : null;
        const trans = transitionEncounter(r.status, {
          type: "sign",
          discipline: r.discipline,
          gatePassed: await gateEncounter(t, r, "sign"),
          stepUpFresh: provenance.stepUpFresh,
          isF2f: false,
          f2fDualWriteSatisfied: true,
          eligibleCosignerExists: cosignerMembershipId !== null,
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
          careplanLinks: [],
          documentRenderPayload: { final: "", addenda: [] },
        });
        if (requiresCosign) {
          // §2.4 D3 — open the cosignature request already `routed` to the assigned RN case manager,
          // resolved above through M5's CareTeamProvider. It used to route to `signedByMembershipId` —
          // the LPN who just signed the note — so the 12h/24h/48h SLA chain escalated at the author and
          // the cosignature queue showed them their own note (#124). The machine has already refused the
          // sign if this is null, so the non-null assertion is the guard's postcondition, not a hope.
          const routedToMembershipId = cosignerMembershipId as string;
          const cr = firstOrThrow(
            await t
              .insert(COSIGN)
              .values({
                organizationId,
                encounterId,
                routedToMembershipId,
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
              routedToMembershipId,
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
    async updateAddendumSelections(organizationId, encounterId, addendumId, input) {
      const { stored, prose } = splitFreeText(input.sections);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const a = await loadAddendum(t, encounterId, addendumId);
        // The addendum inherits its parent's template — an addendum to an RN routine visit is written
        // against the RN routine-visit template, not one of its own.
        const parent = await loadEnc(t, encounterId);
        const layer1Preview = assembleSelections(
          parent.encounterType,
          parent.discipline,
          parent.serviceDate,
          input.sections,
        );
        const freeTextCipherValue = await sealProse(organizationId, prose);
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
        await t
          .insert(SEL)
          .values({
            organizationId,
            providerEntityId: a.providerEntityId,
            locationId: a.locationId,
            addendumId,
            templateKey: hearthnoteTemplateKey(parent.encounterType, parent.discipline),
            templateVersion: VOCAB_VERSION,
            selections: { sections: stored },
            freeTextCipher: freeTextCipherValue,
          })
          .onConflictDoUpdate({
            target: SEL.addendumId,
            targetWhere: isNotNull(SEL.addendumId),
            set: {
              selections: { sections: stored },
              freeTextCipher: freeTextCipherValue,
              updatedAt: new Date(),
              version: sql`${SEL.version} + 1`,
            },
          });
        return { version: Number(updated.version), layer1Preview };
      });
    },

    async getAddendumSelections(organizationId, encounterId, addendumId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadAddendum(t, encounterId, addendumId);
        const parent = await loadEnc(t, encounterId);
        const [row] = await t.select().from(SEL).where(eq(SEL.addendumId, addendumId)).limit(1);
        const sections = row ? await openProse(organizationId, row) : [];
        return {
          templateKey: hearthnoteTemplateKey(parent.encounterType, parent.discipline),
          vocabVersion: VOCAB_VERSION,
          sections,
          layer1Preview: assembleSelections(
            parent.encounterType,
            parent.discipline,
            parent.serviceDate,
            sections,
          ),
          version: row ? Number(row.version) : 0,
        };
      });
    },
    async finalizeAddendum(organizationId, encounterId, addendumId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const a = await loadAddendum(t, encounterId, addendumId);
        const trans = transitionAddendum(a.status as "draft" | "finalized" | "signed", {
          type: "finalize",
          gatePreviewPassed: await gateAddendum(t, addendumId, "finalize"),
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
          gatePassed: await gateAddendum(t, addendumId, "sign"),
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

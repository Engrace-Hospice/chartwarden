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
import {
  DEFAULT_HEARTHNOTE_FLAGS,
  enhanceNarrative,
  requiredScalesFor,
  templateKey as hearthnoteTemplateKey,
} from "@wardenx/hearthnote";
import { VOCAB_VERSION, activeNarrativeVocabRelease } from "@wardenx/narrative-vocab";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type AdmissionSummary,
  type CarePlanOverdueStatus,
  ForbiddenError,
  type LocalDate,
  NotFoundError,
  type PatientId,
  type ScaleType,
  STEP_UP_POLICY,
  type StepUpFactor,
  ValidationError,
} from "@wardenx/types";
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import {
  assertAtLeastOneCarePlanRef,
  planF2fDualWrite,
  planMileageCapture,
  planVitalsCapture,
} from "./authoring/index";
import { transitionCosignature } from "./cosignature/index";
import type { CosignatureState } from "./cosignature/index";
import {
  type GateSectionSelection,
  assertGatePassed,
  deriveVitalsGateFacts,
  runAddendumComplianceGate,
  runEncounterComplianceGate,
} from "./gate/index";
import type { HearthnoteCiphers } from "./hearthnote-crypto";
import { LAYER2_TENANT_FACTS_UNBOUND, resolveLayer2Eligibility } from "./layer2";
import { transitionAddendum } from "./lifecycle/addendum";
import { requiresCosignature, transitionEncounter } from "./lifecycle/encounter";
import { EncounterStateError } from "./lifecycle/errors";
import {
  checkEncounterDisciplinePair,
  checkMutableForEdit,
  checkParentNotVoided,
  checkServiceDateNotFuture,
  checkVersion,
  checkVocabVersion,
} from "./lifecycle/validation";
import { toVitalsView } from "./routes/service";
import type {
  CarePlanLinkView,
  EncounterAbacFacts,
  EncounterAbacResolver,
  EncounterRouteService,
  EncounterView,
  SelectionSectionInput,
} from "./routes/service";
import { assembleSelections, buildTemplateMenu } from "./routes/service";
import { getCarePlanReader, getCareTeamProvider, getLatestAssessmentProvider } from "./seams/index";

const ENC = schema.encounters;
const LINK = schema.encounterCarePlanLinks;
const COSIGN = schema.cosignatureRequests;
const ADDENDUM = schema.encounterAddenda;
const VITALS = schema.vitals;
const MILEAGE = schema.mileage;
const SIG = schema.encounterSignatures;
const SEL = schema.hearthnoteSelections;
const OUT = schema.hearthnoteAssembledOutputs;
const LLM = schema.hearthnoteLlmModifications;
const MEM = schema.memberships;

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
 * The §2.7 D11 pinned vocabulary version (#128).
 *
 * This used to be a fixed sentinel uuid, written identically onto every encounter the platform ever
 * finalized, because `encounter.vocab_version_id` is a `uuid` and the corpus versions itself as a
 * string. It satisfied the `encounter_vocab_pinned_when_finalized` CHECK and identified nothing — so
 * §2.6 check 12 could not be evaluated against it in either direction (comparing a placeholder to a
 * real id refuses every signature; comparing it to itself passes unconditionally, which is the F-051
 * defect one level down).
 *
 * `@wardenx/narrative-vocab` now carries the `(version → uuid)` registry the column always needed, and
 * this resolves the running build's release through it. The pin is the CORPUS release, not an M38
 * `code_system_version` row: architecture §10.5.2 makes Layer-1 assembly a pure function of
 * (selections × template × that package), M38 has no single active-version pointer to hold, and
 * `packages/narrative-vocab` is M8-owned so no seam is involved. See `releases.ts` for the full
 * reasoning — the module spec §2.7 names M38 and architecture wins on conflict.
 *
 * It THROWS on an unregistered version rather than degrading. That is deliberate: the alternative is
 * a placeholder that every later read is unable to tell from a real pin.
 */
function activeVocabPin(): { readonly id: string; readonly version: string } {
  return activeNarrativeVocabRelease(VOCAB_VERSION);
}

/**
 * The parent encounter's D11 pin, for an addendum assembled against it. Refuses rather than
 * substituting: a fabricated pin on an addendum would claim the addendum was written against a
 * vocabulary nobody chose, and the `encounter_vocab_pinned_when_finalized` CHECK already guarantees a
 * non-draft parent has one — so reaching the throw means the invariant is broken and inventing a value
 * would hide it.
 */
function requireParentVocabPin(pin: string | null, encounterId: string): string {
  if (pin === null) {
    throw new EncounterStateError(
      "VOCAB_VERSION_MISMATCH",
      `encounter ${encounterId} is finalized with no D11 vocabulary pin; an addendum cannot inherit one`,
    );
  }
  return pin;
}

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

/** F-064 — one live care-plan link, as the route projects it. */
const toCarePlanLinkView = (r: typeof LINK.$inferSelect): CarePlanLinkView => ({
  id: r.id,
  encounterId: r.encounterId,
  problemId: r.problemId,
  goalId: r.goalId,
  interventionId: r.interventionId,
  createdAt: r.createdAt.toISOString(),
});

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
  throw new ForbiddenError(
    `encounter authoring is not allowed while admission is '${summary.status}'`,
  );
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
  ciphers?: HearthnoteCiphers,
): EncounterRouteService {
  const freeTextCipher = ciphers?.freeText;
  const narrativeCipher = ciphers?.narrative;

  /**
   * Run one tenant-DEK operation, turning a KEY-RESOLVE failure into the designed 503.
   *
   * Without this the `HEARTHNOTE_CIPHER_UNBOUND` code is unreachable in production: the composition root
   * always constructs the cipher OBJECTS (`createHearthnoteCiphers(getTenantKeyProvider())`), so the
   * `!cipher` branch only ever fires in the slice and in tests. The key resolve happens per CALL, deep
   * inside M34 — `dekForOrg` throws `M34InfraPortUnbound` while the KEK/KMS adapter is unbound (#105),
   * `TenantKeyMissing` for an org with no key ring, `TenantKeyDestroyed` after a crypto-shred. Unwrapped,
   * every one of those surfaces as a 500. They are all the same operational statement — this deployment
   * cannot key this tenant's PHI right now — and 503 is what says it.
   */
  async function withTenantDek<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      throw new EncounterStateError(
        "HEARTHNOTE_CIPHER_UNBOUND",
        `${what}: the tenant DEK could not be resolved (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      );
    }
  }
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
    return withTenantDek("the clinician's free text could not be sealed", () =>
      freeTextCipher.seal(organizationId, JSON.stringify(prose)),
    );
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
      await withTenantDek("the clinician's free text could not be opened", () =>
        freeTextCipher.open(organizationId, row.freeTextCipher as string),
      ),
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

  /**
   * §2.6 check 3 (#125) — which of `requiredScalesFor(encounterType)`'s scales M9 already has an
   * active row for on this patient. Empty roster short-circuits without asking the seam at all, the
   * same posture as `requiredHopeItems` — no need to fail closed on a seam this encounter type never
   * consults. A seam failure is `COMPLIANCE_GATE_UNAVAILABLE`, same as the care-plan/cosigner checks:
   * a check that could not run must not read as passed.
   */
  async function scalesPresentFor(
    patientId: string,
    encounterType: (typeof ENC.$inferSelect)["encounterType"],
  ): Promise<Set<ScaleType>> {
    const required = requiredScalesFor(encounterType);
    if (required.length === 0) return new Set();
    try {
      const rows = await getLatestAssessmentProvider().latestBatch(
        patientId as PatientId,
        required,
      );
      return new Set(rows.map((row) => row.scaleType));
    } catch (cause) {
      throw new EncounterStateError(
        "COMPLIANCE_GATE_UNAVAILABLE",
        `the §2.6 required-scales check could not be decided: M9's LatestAssessmentProvider is unreachable (${
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
    const vitalsRows = await t
      .select({
        bpSystolic: VITALS.bpSystolic,
        bpDiastolic: VITALS.bpDiastolic,
        heartRate: VITALS.heartRate,
        respiratoryRate: VITALS.respiratoryRate,
        temperature: VITALS.temperature,
        spo2: VITALS.spo2,
        painScore: VITALS.painScore,
        clinicallyNotIndicatedFields: VITALS.clinicallyNotIndicatedFields,
      })
      .from(VITALS)
      .where(eq(VITALS.encounterId, r.id));
    const { captured, clinicallyNotIndicated } = deriveVitalsGateFacts(vitalsRows);
    const verdict = runEncounterComplianceGate({
      encounterType: r.encounterType,
      discipline: r.discipline,
      sections: gateSections(sel?.selections ?? null),
      carePlanOverdue: await carePlanOverdueFor(r.patientId),
      vitalsCaptured: captured,
      vitalsClinicallyNotIndicated: clinicallyNotIndicated,
      scalesPresent: await scalesPresentFor(r.patientId, r.encounterType),
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

  // ── §2.6 the assembled-output pin (#122) ────────────────────────────────────────────────────────
  //
  // `hearthnote_assembled_output` holds the bytes that ARE the signed narrative. Nothing had ever written
  // it: the §2.3 machine has emitted `{ kind: "persist_assembled_output" }` on every finalize since
  // M8-T04 — `encounter-lifecycle.test.ts` asserts that it does — and no service performed the effect. So
  // the note was reassembled from `hearthnote_selection` at every read, which defeats the D11 vocabulary
  // pin at the last step: a `@wardenx/narrative-vocab` release that edits a phrase would change the
  // rendered text of an ALREADY-SIGNED encounter, and the `${patient}` slot (a literal today) will change
  // every historical note the day M8 binds an M5 reader. For a 42 CFR 418.104 legal record, "we can
  // rebuild it" is not the claim "here is what it said".

  /** Resolve one parent's stored tree. Absent → an empty section list, not a throw: a template with no
   *  REQUIRED section passes the §2.6 gate with nothing documented, and the honest pin for that is the
   *  template's own text. (An addendum cannot reach it — its gate refuses an empty tree outright.) */
  async function storedTreeFor(
    t: DbClient,
    organizationId: string,
    parent: { readonly encounterId: string } | { readonly addendumId: string },
  ): Promise<SelectionSectionInput[]> {
    const [row] = await t
      .select()
      .from(SEL)
      .where(
        "addendumId" in parent
          ? eq(SEL.addendumId, parent.addendumId)
          : eq(SEL.encounterId, parent.encounterId),
      )
      .limit(1);
    return row ? await openProse(organizationId, row) : [];
  }

  /**
   * Assemble the stored tree and PIN the result, sealed under the tenant DEK. Called once per finalize,
   * inside the finalize transaction, AFTER the §2.6 gate has passed — so a refused finalize leaves no row.
   *
   * The seal is not optional. `layer1_cipher` and `final_cipher` are NOT NULL and the column names are the
   * §3.6 promise; an assembled narrative is prose by construction, so unlike the selection tree there is no
   * codes-in-the-clear half that could be written without a key. A deployment that cannot key the tenant's
   * PHI therefore cannot finalize — see {@link withTenantDek} for why that surfaces as a 503 naming the
   * DEK, and #105 for the binding it names.
   */
  async function pinAssembledOutput(
    t: DbClient,
    organizationId: string,
    input: {
      readonly kind: "primary_finalize" | "addendum_finalize";
      readonly encounterId: string | null;
      readonly addendumId: string | null;
      readonly providerEntityId: string | null;
      readonly locationId: string | null;
      readonly encounterType: EncounterView["encounterType"];
      readonly discipline: EncounterView["discipline"];
      readonly serviceDate: string;
      readonly vocabVersionId: string;
    },
  ): Promise<void> {
    if (!narrativeCipher) {
      throw new EncounterStateError(
        "HEARTHNOTE_CIPHER_UNBOUND",
        "no per-tenant DEK envelope is bound for M8, so the assembled narrative cannot be sealed and the encounter cannot be finalized",
      );
    }
    const sections = await storedTreeFor(
      t,
      organizationId,
      input.addendumId === null
        ? { encounterId: input.encounterId as string }
        : { addendumId: input.addendumId },
    );
    const layer1 = assembleSelections(
      input.encounterType,
      input.discipline,
      input.serviceDate,
      sections,
    );
    // D5's finalize-time reification, through the module's own shipped ladder rather than a literal.
    // Phase 1: the platform flag is off, so this is `kill_switch_active` / `enhanced: false` / final === layer1.
    const outcome = enhanceNarrative({
      layer1,
      flags: DEFAULT_HEARTHNOTE_FLAGS,
      eligibility: LAYER2_TENANT_FACTS_UNBOUND,
    });
    const [layer1Cipher, finalCipher] = await withTenantDek(
      "the assembled narrative could not be sealed",
      () =>
        Promise.all([
          narrativeCipher.seal(organizationId, outcome.layer1),
          narrativeCipher.seal(organizationId, outcome.final),
        ]),
    );
    await t.insert(OUT).values({
      organizationId,
      providerEntityId: input.providerEntityId,
      locationId: input.locationId,
      encounterId: input.encounterId,
      addendumId: input.addendumId,
      kind: input.kind,
      layer1Cipher,
      finalCipher,
      // The layer2 pair is derived from the outcome, never asserted: the `hearthnote_output_layer2_consistency`
      // CHECK requires cipher-and-flag to agree, and deriving both from one value is what keeps them agreeing
      // when Layer 2 becomes reachable.
      layer2Cipher: null,
      layer2InvolvedAtFinalize: outcome.enhanced,
      layer2Eligibility: outcome.reason,
      assemblyTemplateKey: hearthnoteTemplateKey(input.encounterType, input.discipline),
      vocabVersionId: input.vocabVersionId,
    });
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

  async function resolveSiting(
    t: DbClient,
    summary: AdmissionSummary,
    authoredByMembershipId: string,
  ): Promise<{ providerEntityId: string; locationId: string }> {
    if (summary.providerEntityId && summary.locationId) {
      return { providerEntityId: summary.providerEntityId, locationId: summary.locationId };
    }
    const [m] = await t
      .select({
        providerEntityId: MEM.defaultProviderEntityId,
        locationIds: MEM.defaultLocationIds,
      })
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

  /** The pinned (finalize-time) narrative, opened — `null` when nothing is pinned yet or no DEK cipher
   *  is bound to open it. `final_cipher` is sealed under the tenant DEK (#122); never project it raw. */
  async function latestFinalPayload(
    t: DbClient,
    organizationId: string,
    encounterId: string,
  ): Promise<string | null> {
    const [row] = await t
      .select({ finalCipher: OUT.finalCipher })
      .from(OUT)
      .where(and(eq(OUT.encounterId, encounterId), eq(OUT.kind, "primary_finalize")))
      .orderBy(desc(OUT.createdAt))
      .limit(1);
    if (!row || !narrativeCipher) return null;
    return withTenantDek("the pinned narrative could not be opened", () =>
      narrativeCipher.open(organizationId, row.finalCipher),
    );
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
      .where(and(eq(LINK.encounterId, encounterId), isNull(LINK.removedAt)));
    return rows.map((r) => ({
      ...(r.problemId ? { problemId: r.problemId } : {}),
      ...(r.goalId ? { goalId: r.goalId } : {}),
      ...(r.interventionId ? { interventionId: r.interventionId } : {}),
    }));
  }

  async function workspaceFieldsFor(t: DbClient, organizationId: string, encounterId: string) {
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
      finalDocumentation: await latestFinalPayload(t, organizationId, encounterId),
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
      .where(and(eq(LINK.encounterId, encounterId), isNull(LINK.removedAt)));
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
        return { ...toView(r), ...(await workspaceFieldsFor(t, organizationId, encounterId)) };
      });
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
        // The PINNED bytes win whenever they exist (#122). This is the whole point of the pin: what M22
        // prints and M28 exposes is what was assembled at finalize, not what the current corpus would
        // produce from the same selections today.
        const [pinned] = await t
          .select({ finalCipher: OUT.finalCipher })
          .from(OUT)
          .where(and(eq(OUT.encounterId, encounterId), eq(OUT.kind, "primary_finalize")))
          .orderBy(desc(OUT.createdAt))
          .limit(1);
        if (pinned) {
          if (!narrativeCipher) {
            throw new EncounterStateError(
              "HEARTHNOTE_CIPHER_UNBOUND",
              "the encounter's narrative is pinned but no per-tenant DEK envelope is bound to open it",
            );
          }
          return {
            encounterId: r.id,
            final: await withTenantDek("the pinned narrative could not be opened", () =>
              narrativeCipher.open(organizationId, pinned.finalCipher),
            ),
            pinned: true,
          };
        }
        // No pin: either a draft (nothing has been finalized, so a live preview is the only answer there
        // is) or a row finalized before #122 shipped. `pinned: false` is the difference, and it is on the
        // wire — a renderer must be able to tell a legal record from a preview of one.
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
          pinned: false,
        };
      });
    },
    async listEncounters(organizationId, filters = {}) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const conditions: SQL[] = [];
        if (filters.patientId) conditions.push(eq(ENC.patientId, filters.patientId));
        if (filters.admissionId) conditions.push(eq(ENC.admissionId, filters.admissionId));
        if (filters.status) conditions.push(eq(ENC.status, filters.status));
        if (filters.authorId) conditions.push(eq(ENC.authoredByMembershipId, filters.authorId));
        if (filters.lateEntryTier)
          conditions.push(eq(ENC.lateEntryTier, filters.lateEntryTier as never));
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
      // Resolved BEFORE the write transaction: the seam's Drizzle store opens its own tenant context,
      // and nesting that inside an open `withOrgContext` would set the GUC on an already-bound
      // connection (M10's `admissionSiting` records the same rule).
      const admission = await admissionSummaryFor(organizationId, args.admissionId);
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
        validateAdmissionForService(organizationId, args.patientId, args.serviceDate, admission);
        // F-064 — the ARCH-011 siting 0128 deferred: from the admission, else the author's membership.
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

    /**
     * F-063 — the authoring menu. `@wardenx/narrative-vocab`'s `entriesFor` is documented as "the
     * entries a `(encounterType, discipline)` menu surfaces … so the selection UI and the template
     * engine see the same deterministic ordering", and no route ever surfaced it — so there was no
     * selection UI. Derived from the encounter's OWN type/discipline (never from the caller), so the
     * menu a client is offered and the rules `assembleSelections` enforces on the way back in cannot
     * be different rules.
     */
    async getTemplate(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId); // non-leaking 404 before the menu is built
        return { encounterId, ...buildTemplateMenu(r.encounterType, r.discipline) };
      });
    },

    /**
     * F-063 — read the mileage row back. `POST`/`PATCH .../mileage` wrote a real row and no route
     * returned it, so recorded travel left the clinician's screen for good — the same write-only shape
     * #92 fixed for vitals, on the table beside it. `null` (not 404) when no mileage was recorded: the
     * encounter exists and has none, which is an answer rather than an absence.
     */
    async getMileage(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadEnc(t, encounterId); // 404s on unknown/cross-tenant exactly as getEncounter does
        const [row] = await t
          .select()
          .from(MILEAGE)
          .where(eq(MILEAGE.encounterId, encounterId))
          .limit(1);
        if (!row) return null;
        return {
          mileageId: row.id,
          encounterId,
          odometerStart: row.odometerStart,
          odometerEnd: row.odometerEnd,
          milesDriven: row.milesDriven,
          source: row.milesDrivenSource,
          manualOverrideReason: row.manualOverrideReason,
          routeProposedMiles: row.routeProposedMiles,
          recordedAt: row.createdAt.toISOString(),
        };
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
    /**
     * F-064 (#159) — persist the link.
     *
     * This used to parse the body in the route, discard it, insert nothing, and return the ENCOUNTER's
     * own id as `linkId` with a 201. Two things were missing and only one was written down: the route
     * did not thread the M7 refs, AND `encounter_care_plan_link.provider_entity_id` / `location_id`
     * were NOT NULL while the encounter they would be copied from carried null in both — migration 0128
     * relaxed that pair on every other encounter satellite and left this table out. Migration 0231
     * finishes that list, and `createDraft` now stamps the encounter's siting from M6.
     */
    async addCarePlanLink(organizationId, actorMembershipId, encounterId, input) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        // 422 naming the field, rather than the raw `23514` the `at_least_one` CHECK would raise.
        assertAtLeastOneCarePlanRef(input);
        // The refs must name elements of THIS patient's active plan, relevant to this encounter's
        // (type × discipline), and a goal/intervention must hang off the problem it is linked with —
        // otherwise a link could claim a visit addressed a problem on some other patient's plan.
        const elements = await getCarePlanReader().relevantElementsForEncounter(
          r.patientId as PatientId,
          r.encounterType,
          r.discipline as never,
        );
        if (!elements || elements.patientId !== r.patientId) {
          throw new ValidationError(
            "no active care plan elements are available for this encounter",
            [],
          );
        }
        const problem = input.problemId
          ? elements.problems.find((p) => p.problemId === input.problemId)
          : null;
        const goal = input.goalId ? elements.goals.find((g) => g.goalId === input.goalId) : null;
        const intervention = input.interventionId
          ? elements.interventions.find((i) => i.interventionId === input.interventionId)
          : null;
        if (input.problemId && !problem)
          throw new ValidationError("problem is not valid for this encounter", []);
        if (input.goalId && !goal)
          throw new ValidationError("goal is not valid for this encounter", []);
        if (input.interventionId && !intervention) {
          throw new ValidationError("intervention is not valid for this encounter", []);
        }
        if (goal && input.problemId && goal.problemId !== input.problemId) {
          throw new ValidationError("goal does not belong to the linked problem", []);
        }
        if (intervention && input.problemId && intervention.problemId !== input.problemId) {
          throw new ValidationError("intervention does not belong to the linked problem", []);
        }
        // Idempotent: re-linking the same (problem, goal, intervention) triple returns the live link.
        const [existing] = await t
          .select()
          .from(LINK)
          .where(
            and(
              eq(LINK.encounterId, encounterId),
              isNull(LINK.removedAt),
              input.problemId ? eq(LINK.problemId, input.problemId) : isNull(LINK.problemId),
              input.goalId ? eq(LINK.goalId, input.goalId) : isNull(LINK.goalId),
              input.interventionId
                ? eq(LINK.interventionId, input.interventionId)
                : isNull(LINK.interventionId),
            ),
          )
          .limit(1);
        if (existing) return toCarePlanLinkView(existing);
        const row = firstOrThrow(
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
            .returning(),
          "encounter_care_plan_link insert returned no row",
        );
        return toCarePlanLinkView(row);
      });
    },
    /**
     * F-064 — a SOFT invalidate, and a real 404.
     *
     * The route loaded the encounter, checked it was mutable, and returned 204 having removed nothing:
     * `wardenx_app` holds DELETE on no M8 table (§3.6 append-only, uniform across all ten) and there was
     * no column to mark instead. Migration 0231 adds the `removed_at` / `removed_by_membership_id`
     * pair, so the row survives for the M4 write-audit trail while the link stops counting.
     *
     * A link that is absent or already removed is a 404. The old 204 was indistinguishable from a
     * working delete, which is the whole defect.
     */
    async removeCarePlanLink(organizationId, actorMembershipId, encounterId, linkId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const r = await loadEnc(t, encounterId);
        checkMutableForEdit({ status: r.status });
        const rows = await t
          .update(LINK)
          .set({ removedAt: new Date(), removedByMembershipId: actorMembershipId })
          .where(
            and(
              eq(LINK.id, linkId),
              eq(LINK.encounterId, encounterId),
              eq(LINK.organizationId, organizationId),
              isNull(LINK.removedAt),
            ),
          )
          .returning({ id: LINK.id });
        if (rows.length === 0) {
          throw new NotFoundError(`Care-plan link ${linkId} not found on encounter ${encounterId}`);
        }
      });
    },
    /**
     * F-064 — the read that never existed.
     *
     * Even once links persist, `encounter_care_plan_link` would be write-only without this: there was
     * no `GET`, and `GET /api/v1/encounters/{id}` does not project the links. The same shape #92 fixed
     * for vitals and F-063 for mileage.
     */
    async listCarePlanLinks(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadEnc(t, encounterId); // 404 before the read if absent / cross-tenant
        const rows = await t
          .select()
          .from(LINK)
          .where(
            and(
              eq(LINK.encounterId, encounterId),
              eq(LINK.organizationId, organizationId),
              isNull(LINK.removedAt),
            ),
          )
          .orderBy(asc(LINK.createdAt), asc(LINK.id));
        return { links: rows.map(toCarePlanLinkView) };
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
        // §2.3 — the gate runs as a PREVIEW here: a failure raises the 422 + remediation list and the
        // row stays in draft, which is the transition not happening at all.
        const trans = transitionEncounter(r.status, {
          type: "finalize",
          gatePreviewPassed: await gateEncounter(t, r, "finalize"),
          at,
        });
        // §2.7 D11 — the vocabulary version guard, which had never run: `checkVocabVersion` has existed
        // in `lifecycle/validation.ts` since M8-T04 and was called by no production path (#128).
        //
        // The draft records the corpus it was authored against in `hearthnote_selection.template_version`
        // (written on every selections PATCH). If a corpus release ships between the last edit and the
        // finalize, the selections were built from phrases this build may no longer render identically —
        // which is the exact scenario §2.7 puts a 409 VOCAB_VERSION_MISMATCH on. Re-opening and saving
        // the draft re-stamps it and clears the refusal, so the remedy is in the clinician's hands.
        //
        // A draft with NO selection row has nothing to disagree about (an empty note the §2.6 gate has
        // already judged), so there is nothing to compare and the check does not run.
        const pin = activeVocabPin();
        const [selRow] = await t
          .select({ templateVersion: SEL.templateVersion })
          .from(SEL)
          .where(eq(SEL.encounterId, encounterId))
          .limit(1);
        if (selRow !== undefined) {
          checkVocabVersion({
            pinnedVersionId: selRow.templateVersion,
            activeVersionId: pin.version,
          });
        }
        // The D11 pin, resolved ONCE: the encounter row, the assembled output and the outbox event all
        // carry the same value, so the version the note was assembled under cannot disagree with the
        // version the encounter claims. Set at FIRST finalize and immutable thereafter, so an already
        // pinned row keeps the id it was signed under.
        const vocabVersionId = r.vocabVersionId ?? pin.id;
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
        // The `persist_assembled_output` effect the machine has declared since M8-T04 (#122).
        await pinAssembledOutput(t, organizationId, {
          kind: "primary_finalize",
          encounterId,
          addendumId: null,
          providerEntityId: r.providerEntityId,
          locationId: r.locationId,
          encounterType: r.encounterType,
          discipline: r.discipline,
          serviceDate: r.serviceDate,
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

    // ── HearthNote Layer-2 (§2.6 D5) ──────────────────────────────────────────────────────────────────
    //
    // Was: return `r.id` — the ENCOUNTER's own id — as a `modificationId`, and echo back whatever id the
    // decision route was handed. Nothing wrote `hearthnote_llm_modification`, so a caller invoked
    // enhancement, received an id that identified something else, recorded a per-passage decision against
    // it, and got a 200 both times. Nothing happened, twice, successfully (#123).
    async enhanceHearthnote(organizationId, encounterId) {
      const r = await loadRow(organizationId, encounterId);
      if (!r) throw new NotFoundError("encounter");
      // The D5 ladder is the answer, and it is the SAME resolution `finalize` reifies on the assembled
      // output — so the row and the route cannot disagree about why Layer 2 did not run.
      return { enhanced: false, reason: resolveLayer2Eligibility() };
    },
    async recordModificationDecision(organizationId, encounterId, modId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        await loadEnc(t, encounterId); // non-leaking 404 for the parent first
        // A real read, org-scoped, RLS-backstopped. `hearthnote_llm_modification` is written by nothing
        // today (the Layer-2 dispatch is unbuilt), so in practice this always 404s — but it 404s because
        // the row is ABSENT, not because the route decided to. The live suite inserts one and gets a 200,
        // which is what distinguishes this from a hard-coded refusal.
        const [row] = await t
          .select({ id: LLM.id })
          .from(LLM)
          .innerJoin(OUT, eq(OUT.id, LLM.assembledOutputId))
          .where(and(eq(LLM.id, modId), eq(OUT.encounterId, encounterId)))
          .limit(1);
        if (!row) throw new NotFoundError("hearthnote_llm_modification");
        // The DECISION itself is not recorded yet, and cannot be from this contract: the column is
        // `per_passage_decisions` and `ModificationDecisionSchema` carries no passage id. Passage
        // identity is created by the Layer-1↔Layer-2 diff, so there is nothing to key a decision to
        // until the dispatch that produces that diff exists (#123's remaining half).
        return { modificationId: row.id };
      });
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
        // The pinned narrative is sealed under the tenant DEK (#122); it is NOT copied into the outbox
        // payload in the clear. M22 renders through `renderPayload` (route 31), which opens the pin.
        const finalPayload = "";

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
            careplanLinks,
            documentRenderPayload: { final: finalPayload, addenda: [] },
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
          careplanLinks,
          documentRenderPayload: { final: finalPayload, addenda: [] },
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
        await emit(
          t,
          organizationId,
          "m8.encounter.late_entry_override",
          "encounter",
          encounterId,
          {
            encounterId,
            overrideBy: args.actorMembershipId,
            overrideReason: args.reason,
            daysLate: 0,
          },
        );
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
        await emit(
          t,
          organizationId,
          "m8.encounter.administrative_override",
          "encounter",
          encounterId,
          {
            encounterId,
            overrideBy: args.actorMembershipId,
            overrideReason: args.reason,
            daysLate: 0,
          },
        );
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
            // a draft voided before it ever finalized has none. Pin the corpus current AT THE VOID — a
            // real, decodable release rather than the old sentinel. Nothing was ever assembled under it,
            // and a voided draft claims no narrative, but the column must say something and a truthful
            // "this is what the platform was shipping" beats a uuid that names nothing (#128).
            vocabVersionId: r.vocabVersionId ?? activeVocabPin().id,
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
        // The addendum's own assembled output (`addendum_finalize`), pinned the same way and against the
        // PARENT's template and pinned vocab version — an addendum to an RN routine visit is written
        // against the RN routine-visit template, so it must be pinned against it too.
        const parent = await loadEnc(t, encounterId);
        await pinAssembledOutput(t, organizationId, {
          kind: "addendum_finalize",
          encounterId: null,
          addendumId,
          providerEntityId: a.providerEntityId,
          locationId: a.locationId,
          encounterType: parent.encounterType,
          discipline: parent.discipline,
          serviceDate: parent.serviceDate,
          // The parent is finalized or later, and `encounter_vocab_pinned_when_finalized` makes a pin
          // NOT NULL for every non-draft row — so this is the parent's real pin. There is deliberately
          // no fallback: an addendum inherits the vocabulary its parent was signed under, and if that
          // is somehow absent the honest move is to refuse, not to mint a second answer (#128).
          vocabVersionId: requireParentVocabPin(parent.vocabVersionId, encounterId),
        });
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

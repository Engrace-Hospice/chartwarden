import { type DbClient, schema } from "@wardenx/db";
// apps/backend/src/modules/22-documents/extraction/batch-identity.ts — does each document in an intake batch
// belong to the patient the batch is filed under? (F-238)
//
// The TARGET is the batch's patient (M5 PatientReader), or — for records filed against a referral M6 has not
// resolved yet — the name and DOB the referral was received with. When the referral HAS resolved a patient
// since the upload, the batch adopts it here (M22 writes only its own row; M6 is only read, through its seam).
//
// Each document's own identifiers are the reviewer-visible extracted candidates `patient.legalLastName`,
// `patient.legalFirstName`, `patient.dateOfBirth` of that document (grounded on its page, decrypted here
// server-side). The verdict per document goes to `classified_page.identity_*` (status + disagreeing FIELD
// names, never values); the batch keeps the worst verdict among documents a reviewer has not resolved.
// Recomputed after the intake run, after a relink (which clears earlier resolutions — they were about
// another target), and when the workspace finds a referral that has resolved its patient.
import {
  type DocumentIdentity,
  type IdentityStatus,
  type IdentityTarget,
  compareIdentity,
  splitFullName,
  worstIdentity,
} from "@wardenx/intake-extraction";
import {
  DegradedError,
  type IntakeSudRelinkedPayload,
  M22_INTAKE_SUD_RELINKED_EVENT,
} from "@wardenx/types";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import type { CandidateValueCipher } from "./candidate-value-cipher";
import type { ExtractionOutboxPort } from "./writeback-commit-db";

const BATCH = schema.intakeUploadBatches;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;
const EC = schema.extractionCandidates;

/** M5 / M6 lookups, bound at the composition root (getSeam) — fakes in tests. */
export interface IdentityTargetPorts {
  readonly patient: (
    organizationId: string,
    patientId: string,
  ) => Promise<{ lastName: string; firstName: string; dateOfBirth: string } | null>;
  readonly referral?: (
    organizationId: string,
    referralId: string,
  ) => Promise<{
    patientId: string | null;
    patientNameAtReceipt: string;
    patientDobAtReceipt: string | null;
  } | null>;
}

export type BatchIdentityStatus = IdentityStatus | "no_target";

export interface BatchIdentityResult {
  readonly status: BatchIdentityStatus;
  /** Set when the batch just adopted its referral's newly resolved patient. */
  readonly adoptedPatientId: string | null;
  readonly targetSource: "patient" | "referral" | "none";
}

const ID_FIELDS: Record<string, keyof DocumentIdentity> = {
  "patient.legalLastName": "lastName",
  "patient.legalFirstName": "firstName",
  "patient.dateOfBirth": "dateOfBirth",
};

/**
 * Does another of this patient's batches still carry a live (pending or confirmed) Part 2 detection? M22
 * owns the batches, so M22 answers this for M5 whenever one batch's detection stops applying to the
 * patient (a move, a rejection, a discard) — the patient keeps the DocLens flag while any other live
 * detection holds it. An unreviewed detection on a discarded batch is not live; a confirmed one is.
 */
export async function otherBatchHoldsSudFlag(
  tx: DbClient,
  patientId: string,
  exceptBatchId: string,
): Promise<boolean> {
  const [other] = await tx
    .select({ id: BATCH.id })
    .from(BATCH)
    .where(
      and(
        eq(BATCH.patientId, patientId),
        ne(BATCH.id, exceptBatchId),
        or(
          // A confirmed detection is a reviewer's finding: it holds even once its batch is discarded.
          eq(BATCH.sudStatus, "confirmed"),
          // An unreviewed one stops holding when its batch is discarded (m22.intake.sud_withdrawn).
          and(eq(BATCH.sudStatus, "detected"), ne(BATCH.status, "discarded")),
        ),
      ),
    )
    .limit(1);
  return other !== undefined;
}

/**
 * F-238 — a fax with a pending or confirmed Part 2 detection changed patient: tell M5 to move the
 * DocLens-origin privacy flag with it, in the transaction that moved the fax. Nothing to say when the
 * batch has no live detection (`not_detected` / `rejected`). The previous patient keeps the flag while
 * another of ITS batches still carries a live detection — M22 owns the batches, so M22 says so.
 */
export async function publishSudFlagMove(
  tx: DbClient,
  outbox: ExtractionOutboxPort | undefined,
  organizationId: string,
  move: {
    batchId: string;
    sudStatus: string;
    fromPatientId: string | null;
    toPatientId: string | null;
    movedByMembershipId: string | null;
  },
): Promise<boolean> {
  if (move.sudStatus !== "detected" && move.sudStatus !== "confirmed") return false;
  if (move.fromPatientId === move.toPatientId) return false;
  if (!outbox) {
    // A flag left on the wrong person, or missing on the right one, is worse than a retry.
    throw new DegradedError("doclens-relink", "no outbox is bound for the M5 privacy-flag move");
  }
  const fromPatientRetainsFlag = move.fromPatientId
    ? await otherBatchHoldsSudFlag(tx, move.fromPatientId, move.batchId)
    : false;
  const payload: IntakeSudRelinkedPayload = {
    intakeBatchId: move.batchId,
    fromPatientId: move.fromPatientId,
    toPatientId: move.toPatientId,
    sudStatus: move.sudStatus,
    fromPatientRetainsFlag,
    movedByMembershipId: move.movedByMembershipId,
  };
  await outbox.publish(tx, {
    eventName: M22_INTAKE_SUD_RELINKED_EVENT,
    payload: { ...payload, organizationId },
    organizationId,
    aggregateKind: "intake_upload_batch",
    aggregateId: move.batchId,
  });
  return true;
}

/** Resolve whom this batch's documents must be about. May adopt the referral's patient (writes the batch). */
async function resolveTarget(
  tx: DbClient,
  ports: IdentityTargetPorts,
  organizationId: string,
  batch: { id: string; patientId: string | null; referralId: string | null },
): Promise<{
  target: IdentityTarget | null;
  adopted: string | null;
  source: BatchIdentityResult["targetSource"];
}> {
  let patientId = batch.patientId;
  let adopted: string | null = null;
  let referral: Awaited<ReturnType<NonNullable<IdentityTargetPorts["referral"]>>> = null;
  if (!patientId && batch.referralId && ports.referral) {
    referral = await ports.referral(organizationId, batch.referralId);
    if (referral?.patientId) {
      patientId = referral.patientId;
      adopted = referral.patientId;
      await tx
        .update(BATCH)
        .set({ patientId })
        .where(and(eq(BATCH.id, batch.id), eq(BATCH.organizationId, organizationId)));
    }
  }
  if (patientId) {
    const p = await ports.patient(organizationId, patientId);
    return {
      target: p
        ? { lastName: p.lastName, firstName: p.firstName, dateOfBirth: p.dateOfBirth }
        : null,
      adopted,
      source: p ? "patient" : "none",
    };
  }
  if (referral) {
    const name = splitFullName(referral.patientNameAtReceipt);
    return {
      target: { ...name, dateOfBirth: referral.patientDobAtReceipt },
      adopted: null,
      source: "referral",
    };
  }
  return { target: null, adopted: null, source: "none" };
}

/**
 * Recompute the identity verdicts of every document in the batch. `clearResolutions` (after a relink)
 * forgets reviewer resolutions — they confirmed a different target. Runs in the caller's org-scoped tx.
 */
export async function refreshBatchIdentity(
  tx: DbClient,
  deps: { cipher: CandidateValueCipher; ports: IdentityTargetPorts; outbox?: ExtractionOutboxPort },
  organizationId: string,
  batchId: string,
  opts: { clearResolutions?: boolean } = {},
): Promise<BatchIdentityResult> {
  const [b] = await tx
    .select({
      id: BATCH.id,
      patientId: BATCH.patientId,
      referralId: BATCH.referralId,
      sudStatus: BATCH.sudStatus,
    })
    .from(BATCH)
    .where(eq(BATCH.id, batchId))
    .limit(1);
  if (!b) return { status: "no_target", adoptedPatientId: null, targetSource: "none" };
  const { target, adopted, source } = await resolveTarget(tx, deps.ports, organizationId, b);
  if (adopted) {
    // The detection was published with no patient to flag; the patient the referral resolved to gets it.
    await publishSudFlagMove(tx, deps.outbox, organizationId, {
      batchId,
      sudStatus: b.sudStatus,
      fromPatientId: null,
      toPatientId: adopted,
      movedByMembershipId: null,
    });
  }

  const docs = await tx
    .select({
      id: CP.id,
      duplicateOfPage: CP.duplicateOfPage,
      resolution: CP.identityResolution,
    })
    .from(CP)
    .where(eq(CP.intakeUploadBatchId, batchId));
  if (opts.clearResolutions && docs.length) {
    await tx
      .update(CP)
      .set({
        identityResolution: null,
        identityResolvedByMembershipId: null,
        identityResolvedAt: null,
        identityResolutionReason: null,
      })
      .where(eq(CP.intakeUploadBatchId, batchId));
  }

  if (!target) {
    if (docs.length) {
      await tx
        .update(CP)
        .set({ identityStatus: null, identityDisagreeing: null })
        .where(eq(CP.intakeUploadBatchId, batchId));
    }
    await tx.update(BATCH).set({ identityStatus: "no_target" }).where(eq(BATCH.id, batchId));
    return { status: "no_target", adoptedPatientId: adopted, targetSource: source };
  }

  const docIds = docs.map((d) => d.id);
  const rows = docIds.length
    ? await tx
        .select({ pageId: EJ.classifiedPageId, fieldPath: EC.fieldPath, cipher: EC.valueCipher })
        .from(EC)
        .innerJoin(EJ, eq(EJ.id, EC.extractionJobId))
        .where(
          and(inArray(EJ.classifiedPageId, docIds), inArray(EC.fieldPath, Object.keys(ID_FIELDS))),
        )
    : [];
  const stated = new Map<
    string,
    { -readonly [K in keyof DocumentIdentity]: DocumentIdentity[K] }
  >();
  for (const r of rows) {
    if (!r.cipher) continue;
    const key = ID_FIELDS[r.fieldPath];
    if (!key) continue;
    const doc = stated.get(r.pageId) ?? {};
    // The first grounded value per field wins; a document rarely states its patient twice differently.
    doc[key] ??= await deps.cipher.decrypt(organizationId, r.cipher);
    stated.set(r.pageId, doc);
  }

  const open: IdentityStatus[] = [];
  for (const d of docs) {
    // A re-sent page is its original's copy: it is judged once, through the original.
    if (d.duplicateOfPage !== null) continue;
    const verdict = compareIdentity(stated.get(d.id) ?? {}, target);
    await tx
      .update(CP)
      .set({ identityStatus: verdict.status, identityDisagreeing: [...verdict.disagreeing] })
      .where(eq(CP.id, d.id));
    const resolved = !opts.clearResolutions && d.resolution !== null;
    if (!resolved) open.push(verdict.status);
  }
  const status: BatchIdentityStatus = worstIdentity(open) ?? "match";
  await tx.update(BATCH).set({ identityStatus: status }).where(eq(BATCH.id, batchId));
  return { status, adoptedPatientId: adopted, targetSource: source };
}

/** The live ports: M5 `PatientReader` and M6 `ReferralReader`, resolved per call (seams register at boot). */
export function createIdentityTargetPorts(): IdentityTargetPorts {
  return {
    async patient(organizationId, patientId) {
      const p = await getSeam("PatientReader").findById({ organizationId, id: patientId });
      return p
        ? { lastName: p.lastName, firstName: p.firstName, dateOfBirth: p.dateOfBirth }
        : null;
    },
    async referral(organizationId, referralId) {
      const r = await getSeam("ReferralReader").getReferralSubject({
        organizationId,
        referralId: referralId as never,
      });
      return r
        ? {
            patientId: r.patientId,
            patientNameAtReceipt: r.patientNameAtReceipt,
            patientDobAtReceipt: r.patientDobAtReceipt,
          }
        : null;
    },
  };
}

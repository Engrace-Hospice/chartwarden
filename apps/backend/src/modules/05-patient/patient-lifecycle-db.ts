// apps/backend/src/modules/05-patient/patient-lifecycle-db.ts — the Drizzle {@link PatientLifecyclePort}
// (GAP-018 / GAP-019 / GAP-012). Every method runs under `withOrgContext` (RLS scopes by app.org_id), and
// every write publishes its spec'd `m5.patient.*` event through the m5 outbox port ON THE SAME
// TRANSACTION, so a rejected publish rolls the write back.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type M5OutboxPort, recordDeathFromDischarge } from "./deceased-db";
import {
  type PatientIdentifierCipher,
  UNBOUND_IDENTIFIER_CIPHER,
} from "./identifiers/identifier-cipher";
import {
  findSsnHitPatientIds,
  insertPreparedIdentifier,
  prepareSensitiveIdentifier,
  revealSensitiveIdentifier,
  supersedeOpenIdentifier,
} from "./identifiers/sensitive-identifiers-db";
import { normalizeSsn } from "./identifiers/ssn";
import { insertSoftMatchReviews } from "./match-review-db";
import { normalizeSubject } from "./matching/normalize";
import { PatientNotFoundError, mergePatientsInTx } from "./merges-db";
import {
  AmendmentNotDeniedError,
  AmendmentNotFoundError,
  type AmendmentRecord,
  type CaregiverRecord,
  IdentifierConflictError,
  type IdentifierRecord,
  InvalidStatusTransitionError,
  LegalRepresentativeProofError,
  MatchReviewClosedError,
  MatchReviewNotFoundError,
  MatchReviewNotMergeableError,
  type MatchReviewRecord,
  MergeAlreadyReversedError,
  MergeNotFoundError,
  type PatientDemographicsPatch,
  type PatientLifecyclePort,
  PrimaryCaregiverExistsError,
  SOURCE_PRIOR_STATUS_KEY,
  type SensitiveIdentifierRecord,
  UNMERGE_FALLBACK_STATUS,
  UnmergeWindowExpiredError,
  isAllowedManualTransition,
  isWithinUnmergeWindow,
} from "./patient-lifecycle";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const P = schema.patients;
const ID = schema.patientIdentifiers;
const CG = schema.caregivers;
const PCG = schema.patientCaregivers;
const REVIEW = schema.patientMatchReviews;
const PM = schema.patientMerges;
const AMEND = schema.patientAmendmentRequests;

const PG_UNIQUE_VIOLATION = "23505";
const KNOWN_PATIENT_STATUSES: ReadonlySet<string> = new Set([
  "prospective",
  "active",
  "on_hold",
  "discharged",
]);

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown; cause?: { code?: unknown } } | null) ?? null;
  return code?.code === PG_UNIQUE_VIOLATION || code?.cause?.code === PG_UNIQUE_VIOLATION;
}

function toAmendment(r: typeof AMEND.$inferSelect): AmendmentRecord {
  return {
    id: r.id,
    patientId: r.patientId,
    scope: r.scope,
    rationale: r.rationale,
    status: r.status,
    denialReason: r.denialReason,
    statementOfDisagreement: r.statementOfDisagreement,
    receivedAt: r.receivedAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    slaDueAt: r.slaDueAt.toISOString(),
  };
}

function toReview(r: typeof REVIEW.$inferSelect): MatchReviewRecord {
  return {
    id: r.id,
    status: r.status,
    score: Number(r.score),
    newPatientId: r.newPatientId,
    candidateExistingPatientId: r.candidateExistingPatientId,
    createdAt: r.createdAt.toISOString(),
    reason: r.reason,
  };
}

export function createDbPatientLifecyclePort(
  db: DbClient,
  outbox: M5OutboxPort,
  now: () => Date = () => new Date(),
  /** GAP-010: the per-tenant DEK envelope for ssn / state_id. Unbound by default (the route then answers 503). */
  identifierCipher: PatientIdentifierCipher = UNBOUND_IDENTIFIER_CIPHER,
): PatientLifecyclePort {
  const emit = (
    tx: Tx,
    organizationId: string,
    patientId: string,
    eventName: string,
    extra: Record<string, unknown>,
  ): Promise<void> =>
    outbox.publish(tx as unknown as DbClient, {
      eventName,
      payload: { patientId, organizationId, ...extra },
      organizationId,
      aggregateKind: "patient",
      aggregateId: patientId,
    });

  const loadPatient = async (tx: Tx, patientId: string) => {
    const [row] = await tx.select().from(P).where(eq(P.id, patientId)).limit(1);
    if (!row) throw new PatientNotFoundError(patientId);
    return row;
  };

  const updateDemographics: PatientLifecyclePort["updateDemographics"] = (
    organizationId,
    patientId,
    patch,
    actorUserId,
  ) =>
    withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
      const current = (await loadPatient(tx, patientId)) as Record<string, unknown>;
      const changed = (Object.keys(patch) as (keyof PatientDemographicsPatch)[]).filter(
        (k) => JSON.stringify(current[k] ?? null) !== JSON.stringify(patch[k] ?? null),
      );
      if (changed.length === 0) return { patientId, changed: [] };
      const set = Object.fromEntries(changed.map((k) => [k, patch[k] ?? null]));
      await tx
        .update(P)
        .set({ ...set, updatedAt: now() })
        .where(eq(P.id, patientId));
      await emit(tx, organizationId, patientId, "m5.patient.updated", { changed });
      return { patientId, changed };
    });

  const transitionStatus: PatientLifecyclePort["transitionStatus"] = (
    organizationId,
    patientId,
    input,
    actorUserId,
  ) =>
    withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
      const { status: fromStatus } = await loadPatient(tx, patientId);
      if (!isAllowedManualTransition(fromStatus, input.toStatus)) {
        throw new InvalidStatusTransitionError(fromStatus, input.toStatus);
      }
      await tx
        .update(P)
        .set({ status: input.toStatus, updatedAt: now() })
        .where(eq(P.id, patientId));
      await emit(tx, organizationId, patientId, "m5.patient.status_changed", {
        fromStatus,
        toStatus: input.toStatus,
      });
      return { patientId, fromStatus, toStatus: input.toStatus };
    });

  const recordDeath: PatientLifecyclePort["recordDeath"] = async (
    organizationId,
    patientId,
    input,
    actorUserId,
  ) => {
    await withOrgContext(db, { organizationId, userId: actorUserId }, (tx) =>
      loadPatient(tx, patientId),
    );
    const outcome = await recordDeathFromDischarge(db, outbox, {
      organizationId,
      patientId,
      deceasedDate: input.deceasedDate,
      today: isoDate(now()),
      actorUserId,
    });
    return {
      patientId,
      status: "deceased" as const,
      deceasedDate: outcome.kind === "recorded" ? outcome.deceasedDate : input.deceasedDate,
      alreadyDeceased: outcome.kind === "already_deceased",
    };
  };

  const addIdentifier: PatientLifecyclePort["addIdentifier"] = (
    organizationId,
    patientId,
    input,
    actorUserId,
  ) =>
    withOrgContext(
      db,
      { organizationId, userId: actorUserId },
      async (tx): Promise<IdentifierRecord> => {
        await loadPatient(tx, patientId);
        const today = isoDate(now());
        const effectiveFrom = input.effectiveFrom ?? today;
        try {
          // One open MBI per org (partial unique index): a new MBI supersedes the patient's open one.
          if (input.kind === "mbi") {
            await tx
              .update(ID)
              .set({ effectiveTo: today })
              .where(and(eq(ID.patientId, patientId), eq(ID.kind, "mbi"), isNull(ID.effectiveTo)));
          }
          const [row] = await tx
            .insert(ID)
            .values({
              patientId,
              organizationId,
              kind: input.kind,
              value: input.value,
              issuer: input.issuer ?? null,
              effectiveFrom,
            })
            .returning();
          await emit(tx, organizationId, patientId, "m5.patient.updated", {
            changed: [`identifier:${input.kind}`],
          });
          return {
            id: row!.id,
            patientId,
            kind: row!.kind,
            value: row!.value,
            issuer: row!.issuer,
            effectiveFrom: row!.effectiveFrom,
            effectiveTo: row!.effectiveTo,
          };
        } catch (e) {
          if (isUniqueViolation(e)) throw new IdentifierConflictError(input.kind);
          throw e;
        }
      },
    );

  // GAP-010 — an SSN / state id, envelope-encrypted. The value is sealed (and an SSN blind-indexed) BEFORE the first
  // write, so an unbound / destroyed key ring refuses the request with nothing written. The new row supersedes the
  // patient's open row of that kind (the MBI pattern). The response and the outbox event carry the kind and last 4
  // at most, never the value.
  const addSensitiveIdentifier: PatientLifecyclePort["addSensitiveIdentifier"] = (
    organizationId,
    patientId,
    input,
    actorUserId,
  ) =>
    withOrgContext(
      db,
      { organizationId, userId: actorUserId },
      async (tx): Promise<SensitiveIdentifierRecord> => {
        const patient = await loadPatient(tx, patientId);
        const prepared = await prepareSensitiveIdentifier(identifierCipher, organizationId, input);
        const today = isoDate(now());
        await supersedeOpenIdentifier(tx, patientId, input.kind, today);
        const stored = await insertPreparedIdentifier(
          tx,
          organizationId,
          patientId,
          prepared,
          today,
        );
        if (input.kind === "ssn") {
          await openSsnCollisionReviews(tx, organizationId, patient, input.value);
        }
        await emit(tx, organizationId, patientId, "m5.patient.updated", {
          changed: [`identifier:${input.kind}`],
        });
        return {
          id: stored.id,
          patientId,
          kind: stored.kind,
          valueLast4: stored.valueLast4,
          effectiveFrom: today,
        };
      },
    );

  // A newly written SSN that equals another patient's SSN AND date of birth is a probable duplicate. The admit
  // path blocks it; after the fact a block is impossible, so it lands in the review queue (the soft path).
  // One open review per (new, existing) pair.
  const openSsnCollisionReviews = async (
    tx: Tx,
    organizationId: string,
    patient: typeof P.$inferSelect,
    rawSsn: string,
  ): Promise<void> => {
    const ssn = normalizeSsn(rawSsn);
    if (!ssn) return;
    const hitIds = await findSsnHitPatientIds(
      tx,
      identifierCipher,
      organizationId,
      ssn,
      patient.id,
    );
    if (hitIds.size === 0) return;
    const sameDob = await tx
      .select({ id: P.id })
      .from(P)
      .where(and(inArray(P.id, [...hitIds]), eq(P.dob, patient.dob)));
    if (sameDob.length === 0) return;
    const alreadyOpen = await tx
      .select({ existingId: REVIEW.candidateExistingPatientId })
      .from(REVIEW)
      .where(and(eq(REVIEW.newPatientId, patient.id), eq(REVIEW.status, "open")));
    const skip = new Set(alreadyOpen.map((r) => r.existingId));
    const candidates = sameDob.filter((r) => !skip.has(r.id)).map((r) => ({ id: r.id, score: 1 }));
    if (candidates.length === 0) return;
    await insertSoftMatchReviews(
      tx,
      organizationId,
      patient.id,
      normalizeSubject({
        lastName: patient.legalLastName,
        firstName: patient.legalFirstName,
        dob: patient.dob,
      }),
      candidates,
      { rule: "ssn_dob" },
    );
  };

  const revealIdentifier: PatientLifecyclePort["revealIdentifier"] = (
    organizationId,
    patientId,
    identifierId,
    actorUserId,
    correlationId,
  ) =>
    withOrgContext(db, { organizationId, userId: actorUserId }, (tx) =>
      revealSensitiveIdentifier(
        tx,
        identifierCipher,
        { organizationId, userId: actorUserId, correlationId },
        patientId,
        identifierId,
      ),
    );

  const caregiverRows = async (tx: Tx, patientId: string): Promise<CaregiverRecord[]> => {
    const rows = await tx
      .select({
        id: PCG.id,
        caregiverId: PCG.caregiverId,
        firstName: CG.firstName,
        lastName: CG.lastName,
        relationship: PCG.relationship,
        isPrimary: PCG.isPrimary,
        isLegalRepresentative: PCG.isLegalRepresentative,
        lrAuthority: PCG.lrAuthority,
        involvementFrom: PCG.involvementFrom,
        involvementTo: PCG.involvementTo,
      })
      .from(PCG)
      .innerJoin(CG, eq(CG.id, PCG.caregiverId))
      .where(eq(PCG.patientId, patientId))
      .orderBy(desc(PCG.isPrimary), asc(PCG.createdAt));
    return rows.map((r) => ({ ...r, patientId }));
  };

  const listCaregivers: PatientLifecyclePort["listCaregivers"] = (organizationId, patientId) =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const exists = await tx.select({ id: P.id }).from(P).where(eq(P.id, patientId)).limit(1);
      if (!exists[0]) return null;
      return caregiverRows(tx, patientId);
    });

  const addCaregiver: PatientLifecyclePort["addCaregiver"] = (
    organizationId,
    patientId,
    input,
    actorUserId,
  ) =>
    withOrgContext(
      db,
      { organizationId, userId: actorUserId },
      async (tx): Promise<CaregiverRecord> => {
        await loadPatient(tx, patientId);
        const lrAuthority = input.lrAuthority ?? "none";
        const isLr = input.isLegalRepresentative ?? false;
        if (isLr && (lrAuthority === "none" || !input.lrProofDocRef)) {
          throw new LegalRepresentativeProofError();
        }
        if (!isLr && lrAuthority !== "none") throw new LegalRepresentativeProofError();
        if (input.isPrimary) {
          const open = await tx
            .select({ id: PCG.id })
            .from(PCG)
            .where(
              and(eq(PCG.patientId, patientId), eq(PCG.isPrimary, true), isNull(PCG.involvementTo)),
            )
            .limit(1);
          if (open[0]) throw new PrimaryCaregiverExistsError();
        }
        const [cg] = await tx
          .insert(CG)
          .values({
            organizationId,
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.email ?? null,
            phone: input.phone ?? null,
          })
          .returning({ id: CG.id });
        const [link] = await tx
          .insert(PCG)
          .values({
            patientId,
            caregiverId: cg!.id,
            organizationId,
            relationship: input.relationship as typeof PCG.$inferInsert.relationship,
            isPrimary: input.isPrimary ?? false,
            isLegalRepresentative: isLr,
            lrAuthority: lrAuthority as typeof PCG.$inferInsert.lrAuthority,
            lrProofDocRef: input.lrProofDocRef ?? null,
            portalInvitationConsented: input.portalInvitationConsented ?? false,
            involvementFrom: input.involvementFrom ?? isoDate(now()),
            notes: input.notes ?? null,
          })
          .returning();
        return {
          id: link!.id,
          caregiverId: cg!.id,
          patientId,
          firstName: input.firstName,
          lastName: input.lastName,
          relationship: link!.relationship,
          isPrimary: link!.isPrimary,
          isLegalRepresentative: link!.isLegalRepresentative,
          lrAuthority: link!.lrAuthority,
          involvementFrom: link!.involvementFrom,
          involvementTo: link!.involvementTo,
        };
      },
    );

  const listMatchReviews: PatientLifecyclePort["listMatchReviews"] = (organizationId, q) =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = await tx
        .select()
        .from(REVIEW)
        .where(eq(REVIEW.status, q.status as typeof REVIEW.$inferSelect.status))
        .orderBy(desc(REVIEW.score), asc(REVIEW.createdAt))
        .limit(q.limit);
      return rows.map(toReview);
    });

  const loadOpenReview = async (tx: Tx, reviewId: string) => {
    const [review] = await tx.select().from(REVIEW).where(eq(REVIEW.id, reviewId)).limit(1);
    if (!review) throw new MatchReviewNotFoundError(reviewId);
    if (review.status !== "open") throw new MatchReviewClosedError(reviewId, review.status);
    return review;
  };

  const mergeMatchReview: PatientLifecyclePort["mergeMatchReview"] = (
    organizationId,
    reviewId,
    input,
    actorUserId,
  ) =>
    withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
      const review = await loadOpenReview(tx, reviewId);
      if (!review.newPatientId) throw new MatchReviewNotMergeableError(reviewId);
      // §7.3: the freshly created duplicate (source) folds into the pre-existing chart (target).
      const merged = await mergePatientsInTx(tx as unknown as DbClient, outbox, {
        organizationId,
        sourcePatientId: review.newPatientId,
        targetPatientId: review.candidateExistingPatientId,
        fieldResolutions: input.fieldResolutions,
        reason: input.reason,
        actorUserId,
      });
      const decidedAt = now();
      await tx
        .update(REVIEW)
        .set({
          status: "merged",
          reviewedBy: actorUserId || null,
          reviewedAt: decidedAt,
          reason: input.reason,
        })
        .where(eq(REVIEW.id, reviewId));
      // Sibling candidates for the same (now merged-away) chart are moot.
      await tx
        .update(REVIEW)
        .set({ status: "cancelled", reviewedBy: actorUserId || null, reviewedAt: decidedAt })
        .where(
          and(
            eq(REVIEW.newPatientId, review.newPatientId),
            eq(REVIEW.status, "open"),
            sql`${REVIEW.id} <> ${reviewId}`,
          ),
        );
      return {
        reviewId,
        mergeId: merged.mergeId,
        sourcePatientId: merged.sourcePatientId,
        targetPatientId: merged.targetPatientId,
      };
    });

  const markNotAMatch: PatientLifecyclePort["markNotAMatch"] = (
    organizationId,
    reviewId,
    input,
    actorUserId,
  ) =>
    withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
      await loadOpenReview(tx, reviewId);
      const [row] = await tx
        .update(REVIEW)
        .set({
          status: "not_a_match",
          reviewedBy: actorUserId || null,
          reviewedAt: now(),
          reason: input.reason ?? null,
        })
        .where(eq(REVIEW.id, reviewId))
        .returning();
      return toReview(row!);
    });

  const unmerge: PatientLifecyclePort["unmerge"] = (organizationId, mergeId, _input, actorUserId) =>
    withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
      const [merge] = await tx.select().from(PM).where(eq(PM.id, mergeId)).limit(1);
      if (!merge) throw new MergeNotFoundError(mergeId);
      if (merge.unmergedAt) throw new MergeAlreadyReversedError(mergeId);
      if (!isWithinUnmergeWindow(merge.performedAt, now())) {
        throw new UnmergeWindowExpiredError(mergeId);
      }
      const source = await loadPatient(tx, merge.sourcePatientId);
      if (source.status !== "merged" || source.mergedIntoId !== merge.targetPatientId) {
        throw new MergeAlreadyReversedError(mergeId);
      }
      const diff = (merge.mergedFieldDiff ?? {}) as Record<string, unknown>;
      const priorStatus = diff[SOURCE_PRIOR_STATUS_KEY];
      const restoredStatus =
        typeof priorStatus === "string" && KNOWN_PATIENT_STATUSES.has(priorStatus)
          ? priorStatus
          : UNMERGE_FALLBACK_STATUS;

      // Revert the target's resolved demographics, but only where nobody has edited the field since.
      const target = (await loadPatient(tx, merge.targetPatientId)) as Record<string, unknown>;
      const revert: Record<string, unknown> = {};
      for (const [field, entry] of Object.entries(diff)) {
        if (field === SOURCE_PRIOR_STATUS_KEY) continue;
        const e = entry as { kept?: string; targetValue?: unknown; appliedValue?: unknown };
        if (e.kept === "target") continue;
        if (JSON.stringify(target[field] ?? null) === JSON.stringify(e.appliedValue ?? null)) {
          revert[field] = e.targetValue ?? null;
        }
      }
      if (Object.keys(revert).length > 0) {
        await tx
          .update(P)
          .set({ ...revert, updatedAt: now() })
          .where(eq(P.id, merge.targetPatientId));
      }
      await tx
        .update(P)
        .set({
          status: restoredStatus as typeof P.$inferInsert.status,
          mergedIntoId: null,
          updatedAt: now(),
        })
        .where(eq(P.id, merge.sourcePatientId));
      await tx
        .update(PM)
        .set({ unmergedAt: now(), unmergedBy: actorUserId || null })
        .where(eq(PM.id, mergeId));
      await emit(tx, organizationId, merge.targetPatientId, "m5.patient.unmerged", {
        sourcePatientId: merge.sourcePatientId,
      });
      await emit(tx, organizationId, merge.sourcePatientId, "m5.patient.status_changed", {
        fromStatus: "merged",
        toStatus: restoredStatus,
      });
      return {
        mergeId,
        sourcePatientId: merge.sourcePatientId,
        targetPatientId: merge.targetPatientId,
        restoredStatus,
      };
    });

  const listAmendments: PatientLifecyclePort["listAmendments"] = (organizationId, patientId) =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const exists = await tx.select({ id: P.id }).from(P).where(eq(P.id, patientId)).limit(1);
      if (!exists[0]) return null;
      const rows = await tx
        .select()
        .from(AMEND)
        .where(eq(AMEND.patientId, patientId))
        .orderBy(desc(AMEND.receivedAt));
      return rows.map(toAmendment);
    });

  const listPendingAmendments: PatientLifecyclePort["listPendingAmendments"] = (
    organizationId,
    q,
  ) =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = await tx
        .select()
        .from(AMEND)
        .where(eq(AMEND.status, q.status as typeof AMEND.$inferSelect.status))
        .orderBy(asc(AMEND.slaDueAt))
        .limit(q.limit);
      return rows.map(toAmendment);
    });

  const recordStatement: PatientLifecyclePort["recordStatement"] = (
    organizationId,
    amendmentId,
    input,
    actorUserId,
  ) =>
    withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
      const [row] = await tx.select().from(AMEND).where(eq(AMEND.id, amendmentId)).limit(1);
      if (!row) throw new AmendmentNotFoundError(amendmentId);
      if (row.status !== "denied") throw new AmendmentNotDeniedError(amendmentId);
      // Append-only in spirit: a second statement is kept after the first, never over it.
      const statement = row.statementOfDisagreement
        ? `${row.statementOfDisagreement}\n---\n${input.statement}`
        : input.statement;
      const [updated] = await tx
        .update(AMEND)
        .set({ statementOfDisagreement: statement })
        .where(eq(AMEND.id, amendmentId))
        .returning();
      return toAmendment(updated!);
    });

  return {
    updateDemographics,
    transitionStatus,
    recordDeath,
    addIdentifier,
    addSensitiveIdentifier,
    revealIdentifier,
    listCaregivers,
    addCaregiver,
    listMatchReviews,
    mergeMatchReview,
    markNotAMatch,
    unmerge,
    listAmendments,
    listPendingAmendments,
    recordStatement,
  };
}

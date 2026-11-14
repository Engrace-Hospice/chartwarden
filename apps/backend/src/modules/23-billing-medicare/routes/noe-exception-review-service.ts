import * as schema from "@chartwarden/db/schema";
import { withOrgContext } from "@chartwarden/tenancy";
import { ConflictError, NotFoundError, ValidationError } from "@chartwarden/types";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { repositories } from "@chartwarden/billing";
import type { M23WriteActor } from "./actor";
import { initialNoeExceptionReviewStatus, recordedExternalDecisionStatus, type NoeExceptionDecision, type NoeExceptionStatus } from "./noe-exception-review-domain";

type BillingDb = repositories.BillingDb;

export const NOE_EXCEPTION_CATEGORIES = ["operations_disruption", "cms_mac_system_issue", "new_hospice_access_delay", "other_external_determination"] as const;
export type NoeExceptionCategory = (typeof NOE_EXCEPTION_CATEGORIES)[number];
export type { NoeExceptionDecision, NoeExceptionStatus } from "./noe-exception-review-domain";

export interface NoeExceptionReviewView {
  readonly id: string;
  readonly noeId: string;
  readonly category: NoeExceptionCategory;
  readonly justificationDocumentId: string;
  readonly status: NoeExceptionStatus;
  readonly evidenceDocumentIds: readonly string[];
  readonly externalRequestReference: string | null;
  readonly externalRequestDate: string | null;
  readonly externalAuthority: "a_b_mac" | "cms" | null;
  readonly externalDecision: NoeExceptionDecision | null;
  readonly externalDecisionProvenance: "operator_attested_document" | null;
  readonly externalDecisionDate: string | null;
  readonly externalDecisionDocumentId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NoeExceptionReviewService {
  list(actor: { organizationId: string; userId: string }, noeId: string): Promise<readonly NoeExceptionReviewView[]>;
  summaries(actor: { organizationId: string; userId: string }, noeIds: readonly string[]): Promise<ReadonlyMap<string, NoeExceptionReviewView>>;
  history(actor: { organizationId: string; userId: string }, noeId: string, reviewId: string): Promise<readonly { eventType: string; fromStatus: string | null; toStatus: string; occurredAt: string; evidenceDocumentIds: readonly string[] }[]>;
  create(actor: M23WriteActor, input: { noeId: string; category: NoeExceptionCategory; justificationDocumentId: string; evidenceDocumentIds: readonly string[] }): Promise<NoeExceptionReviewView>;
  addEvidence(actor: M23WriteActor, input: { noeId: string; reviewId: string; expectedVersion: number; evidenceDocumentIds: readonly string[] }): Promise<NoeExceptionReviewView>;
  recordRequest(actor: M23WriteActor, input: { noeId: string; reviewId: string; expectedVersion: number; requestDate: string; requestReference?: string; evidenceDocumentId: string }): Promise<NoeExceptionReviewView>;
  recordDecision(actor: M23WriteActor, input: { noeId: string; reviewId: string; expectedVersion: number; decision: NoeExceptionDecision; authority: "a_b_mac" | "cms"; decisionDate: string; evidenceDocumentId: string }): Promise<NoeExceptionReviewView>;
}

export interface NoeExceptionEvidenceReader {
  documentMetadata(args: { readonly documentId: string; readonly organizationId: string }): Promise<{ readonly patientId: string | null; readonly status: string } | null>;
}

function view(row: typeof schema.noeExceptionReview.$inferSelect): NoeExceptionReviewView {
  return {
    id: row.id, noeId: row.noeId, category: row.category, justificationDocumentId: row.justificationDocumentId, status: row.status,
    evidenceDocumentIds: row.evidenceDocumentIds, externalRequestReference: row.externalRequestReference,
    externalRequestDate: row.externalRequestDate, externalAuthority: row.externalAuthority,
    externalDecision: row.externalDecision, externalDecisionDate: row.externalDecisionDate,
    externalDecisionProvenance: row.externalDecision ? "operator_attested_document" : null,
    externalDecisionDocumentId: row.externalDecisionDocumentId, version: row.version,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

function invalid(message: string): ValidationError {
  return new ValidationError(message, [{ code: "invalid", message }]);
}

/** M23 records a review and external evidence; it never decides eligibility or submits a request to CMS/MAC. */
export function buildNoeExceptionReviewService(db: BillingDb, evidence: NoeExceptionEvidenceReader, now: () => Date = () => new Date()): NoeExceptionReviewService {
  const read = <T>(actor: { organizationId: string; userId: string }, f: (tx: BillingDb) => Promise<T>) =>
    withOrgContext<BillingDb, T>(db, { organizationId: actor.organizationId, userId: actor.userId }, f);
  const write = <T>(actor: M23WriteActor, f: (tx: BillingDb) => Promise<T>) => read(actor, f);
  const verifyEvidence = async (organizationId: string, patientId: string, ids: readonly string[]) => {
    if (!ids.length) return false;
    const rows = await Promise.all(ids.map((documentId) => evidence.documentMetadata({ documentId, organizationId })));
    return rows.every((document) => document?.patientId === patientId && document.status === "active");
  };
  return {
    async list(actor, noeId) {
      return read(actor, async (tx) => {
        const [noe] = await tx.select({ id: schema.noeRecord.id, organizationId: schema.noeRecord.organizationId })
          .from(schema.noeRecord).where(and(eq(schema.noeRecord.id, noeId), eq(schema.noeRecord.organizationId, actor.organizationId))).limit(1);
        if (!noe) throw new NotFoundError("noe");
        const rows = await tx.select().from(schema.noeExceptionReview).where(and(
          eq(schema.noeExceptionReview.organizationId, actor.organizationId), eq(schema.noeExceptionReview.noeId, noeId),
        )).orderBy(desc(schema.noeExceptionReview.createdAt), desc(schema.noeExceptionReview.id));
        return rows.map(view);
      });
    },
    async summaries(actor, noeIds) {
      if (noeIds.length === 0) return new Map();
      return read(actor, async (tx) => {
        const rows = await tx.select().from(schema.noeExceptionReview).where(and(
          eq(schema.noeExceptionReview.organizationId, actor.organizationId),
          inArray(schema.noeExceptionReview.noeId, [...new Set(noeIds)]),
        )).orderBy(desc(schema.noeExceptionReview.updatedAt), desc(schema.noeExceptionReview.id));
        const result = new Map<string, NoeExceptionReviewView>();
        for (const row of rows) if (!result.has(row.noeId)) result.set(row.noeId, view(row));
        return result;
      });
    },
    async history(actor, noeId, reviewId) {
      return read(actor, async (tx) => {
        const [review] = await tx.select({ id: schema.noeExceptionReview.id }).from(schema.noeExceptionReview).where(and(
          eq(schema.noeExceptionReview.organizationId, actor.organizationId), eq(schema.noeExceptionReview.noeId, noeId), eq(schema.noeExceptionReview.id, reviewId),
        )).limit(1);
        if (!review) throw new NotFoundError("noe exception review");
        const events = await tx.select().from(schema.noeExceptionReviewEvent).where(and(
          eq(schema.noeExceptionReviewEvent.organizationId, actor.organizationId), eq(schema.noeExceptionReviewEvent.reviewId, reviewId),
        )).orderBy(schema.noeExceptionReviewEvent.occurredAt, schema.noeExceptionReviewEvent.id);
        return events.map((event) => ({ eventType: event.eventType, fromStatus: event.fromStatus, toStatus: event.toStatus,
          occurredAt: event.occurredAt.toISOString(), evidenceDocumentIds: event.evidenceDocumentIds }));
      });
    },
    async create(actor, input) {
      if (actor.actorKind !== "user") throw invalid("A human billing operator is required.");
      return write(actor, async (tx) => {
        const [noe] = await tx.select({ id: schema.noeRecord.id, organizationId: schema.noeRecord.organizationId, patientId: schema.noeRecord.patientId })
          .from(schema.noeRecord).where(and(eq(schema.noeRecord.id, input.noeId), eq(schema.noeRecord.organizationId, actor.organizationId))).limit(1).for("update");
        if (!noe) throw new NotFoundError("noe");
        const [active] = await tx.select({ id: schema.noeExceptionReview.id }).from(schema.noeExceptionReview).where(and(
          eq(schema.noeExceptionReview.organizationId, actor.organizationId), eq(schema.noeExceptionReview.noeId, noe.id),
          notInArray(schema.noeExceptionReview.status, ["external_approved_recorded", "external_denied_recorded", "withdrawn"]),
        )).limit(1);
        if (active) throw new ConflictError("An active exception review already exists for this NOE.");
        const evidenceIds = [...new Set(input.evidenceDocumentIds)];
        if (evidenceIds.length !== input.evidenceDocumentIds.length || evidenceIds.includes(input.justificationDocumentId)) throw invalid("Evidence references must be unique and separate from the justification document.");
        const documentIds = [...evidenceIds, input.justificationDocumentId];
        if (!(await verifyEvidence(actor.organizationId, noe.patientId, documentIds))) throw invalid("Justification and evidence must be active protected documents for this beneficiary and organization.");
        const status = initialNoeExceptionReviewStatus(evidenceIds.length > 0);
        const [row] = await tx.insert(schema.noeExceptionReview).values({
          organizationId: actor.organizationId, noeId: noe.id, category: input.category, justificationDocumentId: input.justificationDocumentId,
          status, evidenceDocumentIds: evidenceIds, createdByMembershipId: actor.membershipId,
          updatedByMembershipId: actor.membershipId,
        }).returning();
        if (!row) throw new Error("NOE exception review insert returned no row");
        await tx.insert(schema.noeExceptionReviewEvent).values({ organizationId: actor.organizationId, reviewId: row.id,
          eventType: "created", fromStatus: null, toStatus: status, actorMembershipId: actor.membershipId, evidenceDocumentIds: documentIds });
        return view(row);
      });
    },
    async addEvidence(actor, input) {
      if (actor.actorKind !== "user") throw invalid("A human billing operator is required.");
      return write(actor, async (tx) => {
        const [row] = await tx.select().from(schema.noeExceptionReview).where(and(eq(schema.noeExceptionReview.id, input.reviewId), eq(schema.noeExceptionReview.organizationId, actor.organizationId))).limit(1);
        if (!row || row.noeId !== input.noeId) throw new NotFoundError("noe exception review");
        if (row.version !== input.expectedVersion) throw new ConflictError("NOE exception review changed; refresh before continuing.");
        if (["external_approved_recorded", "external_denied_recorded", "withdrawn"].includes(row.status)) throw invalid("Closed exception reviews cannot be changed.");
        const additions = [...new Set(input.evidenceDocumentIds)];
        if (!additions.length || additions.length !== input.evidenceDocumentIds.length || additions.some((id) => row.evidenceDocumentIds.includes(id))) throw invalid("Provide new, unique supporting evidence documents.");
        const [noe] = await tx.select({ patientId: schema.noeRecord.patientId }).from(schema.noeRecord).where(and(eq(schema.noeRecord.id, row.noeId), eq(schema.noeRecord.organizationId, actor.organizationId))).limit(1);
        if (!noe || !(await verifyEvidence(actor.organizationId, noe.patientId, additions))) throw invalid("Supporting evidence must be active protected documents for this beneficiary and organization.");
        const evidenceDocumentIds = [...row.evidenceDocumentIds, ...additions];
        const [updated] = await tx.update(schema.noeExceptionReview).set({ evidenceDocumentIds, status: "ready_for_external_request",
          updatedByMembershipId: actor.membershipId, updatedAt: now(), version: row.version + 1 })
          .where(and(eq(schema.noeExceptionReview.id, row.id), eq(schema.noeExceptionReview.version, input.expectedVersion))).returning();
        if (!updated) throw new ConflictError("NOE exception review changed; refresh before continuing.");
        await tx.insert(schema.noeExceptionReviewEvent).values({ organizationId: actor.organizationId, reviewId: row.id,
          eventType: "evidence_updated", fromStatus: row.status, toStatus: updated.status, actorMembershipId: actor.membershipId,
          evidenceDocumentIds: [...evidenceDocumentIds, row.justificationDocumentId] });
        return view(updated);
      });
    },
    async recordRequest(actor, input) {
      if (!actor.stepUpRecent || actor.actorKind !== "user") throw invalid("Recent step-up authentication is required to record an external request.");
      return write(actor, async (tx) => {
        const [row] = await tx.select().from(schema.noeExceptionReview).where(and(eq(schema.noeExceptionReview.id, input.reviewId), eq(schema.noeExceptionReview.organizationId, actor.organizationId))).limit(1);
        if (!row || row.noeId !== input.noeId) throw new NotFoundError("noe exception review");
        if (row.version !== input.expectedVersion) throw new ConflictError("NOE exception review changed; refresh before continuing.");
        if (row.status !== "ready_for_external_request") throw invalid("Protected supporting evidence is required before recording that a request was made.");
        const [noe] = await tx.select({ patientId: schema.noeRecord.patientId }).from(schema.noeRecord).where(and(eq(schema.noeRecord.id, row.noeId), eq(schema.noeRecord.organizationId, actor.organizationId))).limit(1);
        if (!noe || !(await verifyEvidence(actor.organizationId, noe.patientId, [...row.evidenceDocumentIds, row.justificationDocumentId, input.evidenceDocumentId]))) throw invalid("Request and supporting evidence must be active protected documents for this beneficiary and organization.");
        const at = now();
        const requestReference = input.requestReference?.trim() || null;
        const requestEvidenceIds = [...new Set([...row.evidenceDocumentIds, input.evidenceDocumentId])];
        const [updated] = await tx.update(schema.noeExceptionReview).set({ status: "awaiting_external_determination", externalRequestDate: input.requestDate,
          externalRequestReference: requestReference, evidenceDocumentIds: requestEvidenceIds, updatedByMembershipId: actor.membershipId, updatedAt: at, version: row.version + 1 })
          .where(and(eq(schema.noeExceptionReview.id, row.id), eq(schema.noeExceptionReview.version, input.expectedVersion))).returning();
        if (!updated) throw new ConflictError("NOE exception review changed; refresh before continuing.");
        await tx.insert(schema.noeExceptionReviewEvent).values({ organizationId: actor.organizationId, reviewId: row.id,
          eventType: "request_recorded", fromStatus: row.status, toStatus: updated.status, actorMembershipId: actor.membershipId,
          evidenceDocumentIds: requestEvidenceIds });
        return view(updated);
      });
    },
    async recordDecision(actor, input) {
      if (!actor.stepUpRecent || actor.actorKind !== "user") throw invalid("Recent step-up authentication is required to record an external decision.");
      return write(actor, async (tx) => {
        const [row] = await tx.select().from(schema.noeExceptionReview).where(and(eq(schema.noeExceptionReview.id, input.reviewId), eq(schema.noeExceptionReview.organizationId, actor.organizationId))).limit(1);
        if (!row || row.noeId !== input.noeId) throw new NotFoundError("noe exception review");
        if (row.version !== input.expectedVersion) throw new ConflictError("NOE exception review changed; refresh before continuing.");
        if (row.status !== "awaiting_external_determination") throw invalid("Record an external request before its decision.");
        const [noe] = await tx.select({ patientId: schema.noeRecord.patientId }).from(schema.noeRecord).where(and(eq(schema.noeRecord.id, row.noeId), eq(schema.noeRecord.organizationId, actor.organizationId))).limit(1);
        if (!noe || !(await verifyEvidence(actor.organizationId, noe.patientId, [input.evidenceDocumentId]))) throw invalid("Decision evidence must be an active protected document for this beneficiary and organization.");
        if (!(await verifyEvidence(actor.organizationId, noe.patientId, [row.justificationDocumentId, ...row.evidenceDocumentIds]))) throw invalid("Supporting documents must remain active for this beneficiary and organization.");
        const status = recordedExternalDecisionStatus(input.decision);
        const at = now();
        const [updated] = await tx.update(schema.noeExceptionReview).set({ status, externalDecision: input.decision, externalAuthority: input.authority,
          externalDecisionDate: input.decisionDate, externalDecisionDocumentId: input.evidenceDocumentId,
          updatedByMembershipId: actor.membershipId, updatedAt: at, version: row.version + 1 })
          .where(and(eq(schema.noeExceptionReview.id, row.id), eq(schema.noeExceptionReview.version, input.expectedVersion))).returning();
        if (!updated) throw new ConflictError("NOE exception review changed; refresh before continuing.");
        await tx.insert(schema.noeExceptionReviewEvent).values({ organizationId: actor.organizationId, reviewId: row.id,
          eventType: "decision_recorded", fromStatus: row.status, toStatus: updated.status, actorMembershipId: actor.membershipId,
          evidenceDocumentIds: [...row.evidenceDocumentIds, input.evidenceDocumentId] });
        return view(updated);
      });
    },
  };
}

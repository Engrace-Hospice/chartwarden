// apps/backend/src/modules/25-remittance/routes/adr-readiness-service.ts - M25 milestone 8a-1: ADVISORY ADR
// documentation readiness. Every command runs under `withOrgContext` (RLS).
//
//   - The DETERMINISTIC gap view is computed on every read from the live packet; it needs no model and no stored row.
//   - A review request asks the (deny-stubbed) assistant port, filters whatever comes back through `acceptAiFindings`, and
//     stores the review plus the surviving findings in two tables that sit BESIDE the packet. This file never writes
//     adr_case, adr_case_document, the checklist, a submission attempt or a case event, and never bumps the case
//     version: a readiness review cannot change what staff can do, and its absence changes nothing.
//   - The model is never called inside a transaction: phase 1 snapshots the packet, the port is consulted, phase 2 stores.
//     A packet edited in between leaves the review visibly stale (it records the case version it looked at).
//   - Events carry ids and counts only. The finding note is PHI-bearing: stored, audit-scrubbed, never evented.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  type AdrReadinessAssistPort,
  type AdrReadinessAssistResult,
  resolveAdrReadinessAssist,
} from "../ai/adr-readiness-capability";
import {
  ADR_CHECKLIST_KEYS,
  type DeterministicGaps,
  READINESS_ALLOWED_CASE_STATES,
  READINESS_REQUEST_MIN_INTERVAL_SECONDS,
  type ReadinessDisposition,
  type ReadinessFinding,
  type ReadinessReviewStatus,
  type ReadinessSource,
  acceptAiFindings,
  deterministicGaps,
  isReviewDisposed,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import { providerEntityScopeCondition } from "./scope";
import type { WriteOutboxPort } from "./write-service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface ReadinessFindingView {
  readonly id: string;
  readonly checklistKey: string;
  readonly status: string;
  readonly citedDocumentIds: readonly string[];
  readonly note: string;
  readonly disposition: string | null;
  readonly disposedAt: string | null;
}

export interface ReadinessReviewView {
  readonly id: string;
  readonly status: string;
  readonly source: string;
  readonly requestedAt: string;
  readonly requestedByMembershipId: string;
  /** True when the packet's version has moved since the review looked at it. */
  readonly stale: boolean;
  readonly unavailableReason: string | null;
  readonly droppedFindingCount: number;
  readonly modelVersionPin: string | null;
  readonly promptTemplateVersion: string | null;
  /** Every finding has a disposition. Informational: it is never a sign-off requirement. */
  readonly allDisposed: boolean;
  readonly findings: readonly ReadinessFindingView[];
}

export interface AdrReadinessView {
  readonly adrCaseId: string;
  readonly caseState: string;
  readonly caseVersion: number;
  readonly generatedAt: string;
  readonly gaps: DeterministicGaps;
  /** The most recent stored review, or null when none was ever requested. */
  readonly review: ReadinessReviewView | null;
}

export interface AdrReadinessRequestResult {
  readonly reviewId: string;
  readonly status: ReadinessReviewStatus;
  readonly source: ReadinessSource;
  readonly findingCount: number;
}

export interface AdrReadinessService {
  getAdrReadiness(actor: M25ReadActor, adrCaseId: string): Promise<AdrReadinessView>;
  requestAdrReadiness(actor: M25WriteActor, adrCaseId: string): Promise<AdrReadinessRequestResult>;
  disposeReadinessFinding(
    actor: M25WriteActor,
    adrCaseId: string,
    findingId: string,
    disposition: ReadinessDisposition,
  ): Promise<{ id: string; disposition: ReadinessDisposition }>;
}

export interface AdrReadinessPorts {
  readonly outbox?: WriteOutboxPort;
  /** Defaults to the deny-stub: no model is reachable until milestone 8b binds one. */
  readonly assist?: AdrReadinessAssistPort;
}

const iso = (d: Date): string => d.toISOString();

export function buildDrizzleAdrReadinessService(
  db: DbClient,
  ports: AdrReadinessPorts = {},
): AdrReadinessService {
  const ADR = schema.adrCase;
  const DOC = schema.adrCaseDocument;
  const REVIEW = schema.adrReadinessReview;
  const FINDING = schema.adrReadinessFinding;
  const assist = ports.assist ?? resolveAdrReadinessAssist();

  async function loadCase(tx: Tx, actor: M25ReadActor, id: string) {
    const scope = providerEntityScopeCondition(ADR.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(ADR)
      .where(scope ? and(eq(ADR.id, id), scope) : eq(ADR.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("ADR case");
    return rows[0];
  }

  async function loadPacket(tx: Tx, row: typeof ADR.$inferSelect) {
    const docs = await tx
      .select({ documentId: DOC.documentId, checklistKey: DOC.checklistKey })
      .from(DOC)
      .where(and(eq(DOC.adrCaseId, row.id), isNull(DOC.removedAt)))
      .orderBy(asc(DOC.attachedAt), asc(DOC.id));
    return {
      documents: docs,
      gaps: deterministicGaps((row.checklist ?? {}) as Record<string, string>, docs),
    };
  }

  const emit = (
    tx: Tx,
    actor: M25WriteActor,
    eventName: string,
    adrCaseId: string,
    payload: Record<string, unknown>,
  ) =>
    ports.outbox?.publish(tx, {
      eventName,
      organizationId: actor.organizationId,
      aggregateKind: "adr_case",
      aggregateId: adrCaseId,
      payload: { adrCaseId, ...payload },
    });

  /** Consults the port; an absent, failing or misbehaving assistant is a value, never an error to the caller. */
  async function consult(
    actor: M25WriteActor,
    adrCaseId: string,
    packet: Awaited<ReturnType<typeof loadPacket>>,
  ): Promise<AdrReadinessAssistResult> {
    try {
      return await assist.review({
        organizationId: actor.organizationId,
        adrCaseId,
        documents: packet.documents,
        requirementKeys: ADR_CHECKLIST_KEYS,
      });
    } catch {
      return { available: false, reason: "assistant_error" } as const;
    }
  }

  return {
    async getAdrReadiness(actor, adrCaseId) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadCase(tx, actor, adrCaseId);
        const packet = await loadPacket(tx, cur);
        const reviews = await tx
          .select()
          .from(REVIEW)
          .where(eq(REVIEW.adrCaseId, adrCaseId))
          .orderBy(desc(REVIEW.createdAt), desc(REVIEW.id))
          .limit(1);
        const latest = reviews[0];
        const findings = latest
          ? await tx
              .select()
              .from(FINDING)
              .where(eq(FINDING.reviewId, latest.id))
              .orderBy(asc(FINDING.createdAt), asc(FINDING.id))
          : [];
        return {
          adrCaseId,
          caseState: cur.state,
          caseVersion: cur.version,
          generatedAt: iso(new Date()),
          gaps: packet.gaps,
          review: latest
            ? {
                id: latest.id,
                status: latest.status,
                source: latest.source,
                requestedAt: iso(latest.createdAt),
                requestedByMembershipId: latest.requestedByMembershipId,
                stale: latest.caseVersion !== cur.version,
                unavailableReason: latest.unavailableReason,
                droppedFindingCount: latest.droppedFindingCount,
                modelVersionPin: latest.modelVersionPin,
                promptTemplateVersion: latest.promptTemplateVersion,
                allDisposed: isReviewDisposed(findings),
                findings: findings.map((f) => ({
                  id: f.id,
                  checklistKey: f.checklistKey,
                  status: f.status,
                  citedDocumentIds: f.citedDocumentIds,
                  note: f.note,
                  disposition: f.disposition,
                  disposedAt: f.disposedAt ? iso(f.disposedAt) : null,
                })),
              }
            : null,
        };
      });
    },

    async requestAdrReadiness(actor, adrCaseId) {
      // Phase 1: snapshot the packet, refuse a wrong state or a too-frequent request.
      const snapshot = await withOrgContext(db, actor, async (tx) => {
        const cur = await loadCase(tx, actor, adrCaseId);
        if (!READINESS_ALLOWED_CASE_STATES.includes(cur.state)) {
          throw new ChartWardenError(
            "ADR_WRONG_STATE",
            `a readiness review needs the ADR to be in assembly or in review, not '${cur.state}'`,
            409,
          );
        }
        const recent = await tx
          .select({ id: REVIEW.id })
          .from(REVIEW)
          .where(
            and(
              eq(REVIEW.adrCaseId, adrCaseId),
              sql`${REVIEW.createdAt} > now() - make_interval(secs => ${READINESS_REQUEST_MIN_INTERVAL_SECONDS})`,
            ),
          )
          .limit(1);
        // ponytail: two truly concurrent requests can both pass this check; the Idempotency-Key middleware covers
        // retries, and a duplicate review is harmless (advisory, append-only). Add an advisory lock if that ever matters.
        if (recent[0]) {
          throw new ChartWardenError(
            "READINESS_RATE_LIMITED",
            `a readiness review was requested for this ADR in the last ${READINESS_REQUEST_MIN_INTERVAL_SECONDS} seconds; wait a moment`,
            429,
          );
        }
        return { caseVersion: cur.version, packet: await loadPacket(tx, cur) };
      });

      // The assistant is consulted outside any transaction.
      const answer = await consult(actor, adrCaseId, snapshot.packet);
      const accepted = answer.available
        ? acceptAiFindings(
            answer.findings,
            snapshot.packet.gaps,
            snapshot.packet.documents.map((d) => d.documentId),
          )
        : null;
      const findings: readonly ReadinessFinding[] = accepted?.accepted ?? [];
      // An answer that is not even a list is a failed review, not an empty one.
      const unusable = accepted?.dropped.some((d) => d.index === -1) === true;
      const status: ReadinessReviewStatus = !answer.available
        ? answer.reason === "assistant_error"
          ? "failed"
          : "unavailable"
        : unusable
          ? "failed"
          : "ready";
      const source: ReadinessSource = answer.available ? "ai" : "deterministic";

      // Phase 2: store the review and the surviving findings, and emit ids-only events.
      return withOrgContext(db, actor, async (tx) => {
        const inserted = await tx
          .insert(REVIEW)
          .values({
            organizationId: actor.organizationId,
            adrCaseId,
            requestedByMembershipId: actor.membershipId,
            status,
            source,
            caseVersion: snapshot.caseVersion,
            ...(answer.available
              ? {
                  invocationId: answer.invocationId,
                  promptTemplateVersion: answer.promptTemplateVersion,
                  modelVersionPin: answer.modelVersionPin,
                }
              : { unavailableReason: answer.reason }),
            droppedFindingCount: accepted?.dropped.length ?? 0,
          })
          .returning({ id: REVIEW.id });
        const reviewId = (inserted[0] as { id: string }).id;
        if (findings.length > 0) {
          await tx.insert(FINDING).values(
            findings.map((f) => ({
              organizationId: actor.organizationId,
              reviewId,
              adrCaseId,
              checklistKey: f.checklistKey,
              status: f.status,
              citedDocumentIds: [...f.citedDocumentIds],
              note: f.note,
            })),
          );
        }
        await emit(tx, actor, "m25.adr_readiness.requested", adrCaseId, { reviewId });
        if (status === "ready") {
          await emit(tx, actor, "m25.adr_readiness.completed", adrCaseId, {
            reviewId,
            findingCount: findings.length,
            droppedFindingCount: accepted?.dropped.length ?? 0,
          });
        } else {
          await emit(tx, actor, "m25.adr_readiness.unavailable", adrCaseId, {
            reviewId,
            reason: answer.available ? "schema_invalid" : answer.reason,
          });
        }
        return { reviewId, status, source, findingCount: findings.length };
      });
    },

    async disposeReadinessFinding(actor, adrCaseId, findingId, disposition) {
      return withOrgContext(db, actor, async (tx) => {
        await loadCase(tx, actor, adrCaseId); // provider-entity scope: an out-of-scope case reads as absent
        const updated = await tx
          .update(FINDING)
          .set({
            disposition,
            disposedByMembershipId: actor.membershipId,
            disposedAt: new Date(),
          })
          .where(and(eq(FINDING.id, findingId), eq(FINDING.adrCaseId, adrCaseId)))
          .returning({ id: FINDING.id, reviewId: FINDING.reviewId });
        const row = updated[0];
        if (!row) throw new NotFoundError("readiness finding");
        await emit(tx, actor, "m25.adr_readiness.finding_disposed", adrCaseId, {
          reviewId: row.reviewId,
          findingId,
          disposition,
        });
        return { id: row.id, disposition };
      });
    },
  };
}

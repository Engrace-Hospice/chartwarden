import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import {
  type PlatformBypassAuditor,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import { ConflictError, DegradedError, NotFoundError, ValidationError } from "@chartwarden/types";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { MedicaidEraReviewService as Evaluator } from "../domain/medicaid-era-trusted-review";
import type { M25ReadActor, M25WriteActor } from "../routes/actor";
import { providerEntityScopeCondition } from "../routes/scope";

const REVIEW = schema.medicaidEraReview;
const HISTORY = schema.medicaidEraReviewHistory;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type State =
  | "needs_review"
  | "investigating"
  | "follow_up_required"
  | "reviewed_not_posted"
  | "reopened";
const allowed = new Set<State>([
  "needs_review",
  "investigating",
  "follow_up_required",
  "reviewed_not_posted",
  "reopened",
]);

export const M25_MEDICAID_ERA_REVIEW_WRITE_JOB_ID = "m25-medicaid-era-review-write";

export function buildDrizzleMedicaidEraReviewWorkflow(
  db: DbClient,
  evaluator: Evaluator,
  options: {
    readonly platformDb?: DbClient;
    readonly auditBypass?: PlatformBypassAuditor<Tx>;
  } = {},
) {
  const write = <T>(reason: string, fn: (tx: Tx) => Promise<T>) => {
    if (!options.platformDb || !options.auditBypass)
      throw new DegradedError(
        "MEDICAID_ERA_REVIEW_WRITER_UNAVAILABLE",
        "nonposting review writes are unavailable",
      );
    return withPlatformContext(
      options.platformDb,
      { jobId: M25_MEDICAID_ERA_REVIEW_WRITE_JOB_ID, reason, crossTenant: false },
      options.auditBypass,
      fn,
    );
  };
  const find = async (
    actor: M25ReadActor,
    id: string,
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
  ) => {
    const rows = await tx
      .select()
      .from(REVIEW)
      .where(
        and(
          eq(REVIEW.id, id),
          eq(REVIEW.organizationId, actor.organizationId),
          providerEntityScopeCondition(REVIEW.providerEntityId, actor.providerEntityScope),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new NotFoundError("Medicaid ERA review not found");
    return rows[0];
  };

  return {
    async evaluate(actor: M25WriteActor, artifactId: string, idempotencyKey: string) {
      const result = await evaluator.inspect(actor, artifactId);
      if (result.status === "unavailable")
        return { status: "unavailable" as const, reasonCode: result.reasonCode };
      if (result.status === "held")
        return { status: "held" as const, reasonCode: result.reasonCode };
      if (result.claims.length === 0)
        return { status: "held" as const, reasonCode: "ERA_NO_CLAIMS" };
      const first = result.claims[0]!;
      if (result.claims.some((item) => item.attributionStatus !== "verified"))
        return { status: "held" as const, reasonCode: "SOURCE_ACCOUNT_UNVERIFIED" };
      const attribution = first.attribution;
      const providerEntityId = attribution.providerEntityId;
      const canonicalPayerId = attribution.canonicalPayerId;
      const programId = attribution.programId;
      const vendor = attribution.vendor;
      const accountReference = attribution.accountReference;
      const sourceEnvironment = attribution.usage;
      const artifactDigest = result.artifactDigest;
      if (
        attribution.organizationId !== actor.organizationId ||
        !providerEntityId ||
        !canonicalPayerId ||
        !programId ||
        !accountReference ||
        !sourceEnvironment ||
        !vendor ||
        !artifactDigest ||
        result.artifactReference !== artifactId ||
        (actor.providerEntityScope !== undefined &&
          !actor.providerEntityScope.includes(providerEntityId))
      )
        return { status: "held" as const, reasonCode: "SOURCE_ACCOUNT_SCOPE_CONFLICT" };
      if (
        result.claims.some(
          (item) =>
            item.attribution.organizationId !== attribution.organizationId ||
            item.attribution.providerEntityId !== attribution.providerEntityId ||
            item.attribution.accountReference !== attribution.accountReference,
        )
      )
        return { status: "held" as const, reasonCode: "SOURCE_ACCOUNT_AMBIGUOUS" };
      const safeSummary = {
        transactionSetCount: result.transactionSetCount,
        claims: result.claims.map((item) => ({
          decision: item.decision,
          reasonCode: item.reasonCode,
          matchStatus: item.matchStatus,
          matchedClaim: item.matchedClaim,
          amounts: item.amounts,
          unresolvedRequirements: item.unresolvedRequirements,
          postingAuthorized: false,
        })),
      };
      const digestKey = createHash("sha256").update(idempotencyKey).digest("hex");
      const decisionStatus = result.claims.some((item) => item.decision !== "payment_reported")
        ? "review_required"
        : "payment_reported";
      const reasonCodes = [...new Set(result.claims.map((item) => item.reasonCode))].slice(0, 32);
      const claimMatchStatus =
        result.claims.length === 1 ? result.claims[0]!.matchStatus : "MULTIPLE";
      const duplicateStatus = result.claims.some((item) => item.decision === "possible_duplicate")
        ? "possible"
        : result.claims.some((item) => item.decision === "exact_duplicate")
          ? "exact"
          : "none";
      const assessmentFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            version: "l5-v1",
            decisionStatus,
            reasonCodes,
            claimMatchStatus,
            duplicateStatus,
            safeSummary,
          }),
        )
        .digest("hex");
      return write("Authorized M25 nonposting Medicaid ERA assessment", async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:${artifactId}:${artifactDigest}`}, 1))`,
        );
        const [existing] = await tx
          .select()
          .from(REVIEW)
          .where(
            and(
              eq(REVIEW.organizationId, actor.organizationId),
              eq(REVIEW.providerEntityId, providerEntityId),
              eq(REVIEW.stageId, artifactId),
              eq(REVIEW.sourceDigest, artifactDigest),
            ),
          )
          .limit(1);
        if (existing?.assessmentFingerprint === assessmentFingerprint)
          return {
            status: "review_saved" as const,
            reviewId: existing.id,
            version: existing.version,
            replay: true,
          };
        if (existing) {
          const [priorAction] = await tx
            .select({ id: HISTORY.id })
            .from(HISTORY)
            .where(
              and(
                eq(HISTORY.organizationId, actor.organizationId),
                eq(HISTORY.idempotencyKeyHash, digestKey),
              ),
            )
            .limit(1);
          if (priorAction)
            return {
              status: "review_saved" as const,
              reviewId: existing.id,
              version: existing.version,
              replay: true,
            };
          const version = existing.version + 1;
          const [updated] = await tx
            .update(REVIEW)
            .set({
              assessmentFingerprint,
              assessmentVersion: "l5-v1",
              decisionStatus,
              reasonCodes,
              claimMatchStatus,
              duplicateStatus,
              safeSummary,
              version,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(REVIEW.id, existing.id),
                eq(REVIEW.organizationId, actor.organizationId),
                eq(REVIEW.version, existing.version),
              ),
            )
            .returning({ id: REVIEW.id, version: REVIEW.version });
          if (!updated) throw new ConflictError("the review changed during reassessment");
          await tx.insert(HISTORY).values({
            organizationId: actor.organizationId,
            providerEntityId,
            reviewId: existing.id,
            version,
            action: "reassessed",
            reasonCode: "CURRENT_SOURCE_FACTS_REASSESSED",
            actorMembershipId: actor.membershipId,
            idempotencyKeyHash: digestKey,
          });
          return {
            status: "review_saved" as const,
            reviewId: updated.id,
            version: updated.version,
            replay: false,
          };
        }
        const [row] = await tx
          .insert(REVIEW)
          .values({
            organizationId: actor.organizationId,
            providerEntityId,
            stageId: artifactId,
            vendor,
            accountReference,
            sourceEnvironment,
            canonicalPayerId,
            programId,
            sourceDigest: artifactDigest,
            assessmentFingerprint,
            assessmentVersion: "l5-v1",
            decisionStatus,
            reasonCodes,
            claimMatchStatus,
            duplicateStatus,
            safeSummary,
          })
          .returning({ id: REVIEW.id, version: REVIEW.version });
        await tx.insert(HISTORY).values({
          organizationId: actor.organizationId,
          providerEntityId,
          reviewId: row!.id,
          version: 1,
          action: "assessed",
          reasonCode: "NONPOSTING_ASSESSMENT",
          actorMembershipId: actor.membershipId,
          idempotencyKeyHash: digestKey,
        });
        return {
          status: "review_saved" as const,
          reviewId: row!.id,
          version: row!.version,
          replay: false,
        };
      });
    },
    async list(actor: M25ReadActor, limit = 50, cursor?: string) {
      const bounded = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 50));
      let after: { at: Date; id: string } | undefined;
      if (cursor) {
        try {
          const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
          if (!at || !id || !/^[0-9a-f-]{36}$/i.test(id) || !Number.isFinite(Date.parse(at)))
            throw new Error();
          after = { at: new Date(at), id };
        } catch {
          throw new ValidationError("invalid Medicaid ERA review cursor", []);
        }
      }
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select({
            id: REVIEW.id,
            providerEntityId: REVIEW.providerEntityId,
            vendor: REVIEW.vendor,
            sourceEnvironment: REVIEW.sourceEnvironment,
            canonicalPayerId: REVIEW.canonicalPayerId,
            programId: REVIEW.programId,
            decisionStatus: REVIEW.decisionStatus,
            reasonCodes: REVIEW.reasonCodes,
            claimMatchStatus: REVIEW.claimMatchStatus,
            duplicateStatus: REVIEW.duplicateStatus,
            workflowState: REVIEW.workflowState,
            version: REVIEW.version,
            createdAt: REVIEW.createdAt,
          })
          .from(REVIEW)
          .where(
            and(
              eq(REVIEW.organizationId, actor.organizationId),
              providerEntityScopeCondition(REVIEW.providerEntityId, actor.providerEntityScope),
              after
                ? or(
                    lt(REVIEW.createdAt, after.at),
                    and(eq(REVIEW.createdAt, after.at), lt(REVIEW.id, after.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(REVIEW.createdAt), desc(REVIEW.id))
          .limit(bounded + 1);
        const hasMore = rows.length > bounded;
        const items = hasMore ? rows.slice(0, bounded) : rows;
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            hasMore && last
              ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url")
              : null,
        };
      });
    },
    async detail(actor: M25ReadActor, id: string) {
      return withOrgContext(db, actor, async (tx) => {
        const { assessmentFingerprint: _assessmentFingerprint, ...detail } = await find(
          actor,
          id,
          tx,
        );
        return detail;
      });
    },
    async history(actor: M25ReadActor, id: string) {
      return withOrgContext(db, actor, async (tx) => {
        const review = await find(actor, id, tx);
        return tx
          .select({
            version: HISTORY.version,
            action: HISTORY.action,
            reasonCode: HISTORY.reasonCode,
            actorMembershipId: HISTORY.actorMembershipId,
            createdAt: HISTORY.createdAt,
          })
          .from(HISTORY)
          .where(
            and(
              eq(HISTORY.organizationId, actor.organizationId),
              eq(HISTORY.providerEntityId, review.providerEntityId),
              eq(HISTORY.reviewId, review.id),
            ),
          )
          .orderBy(HISTORY.version);
      });
    },
    async addNote(
      actor: M25WriteActor,
      id: string,
      expectedVersion: number,
      reasonCode: string,
      idempotencyKey: string,
    ) {
      if (!/^[A-Z0-9_]{2,64}$/.test(reasonCode))
        throw new ValidationError("invalid review note code", []);
      const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
      return write("Authorized M25 Medicaid ERA investigation note", async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:${id}`}, 1))`,
        );
        const [prior] = await tx
          .select()
          .from(HISTORY)
          .where(
            and(
              eq(HISTORY.organizationId, actor.organizationId),
              eq(HISTORY.idempotencyKeyHash, keyHash),
            ),
          )
          .limit(1);
        if (prior) {
          if (prior.reviewId !== id || prior.action !== "note" || prior.reasonCode !== reasonCode)
            throw new ConflictError("this idempotency key was used for another review action");
          const current = await find(actor, id, tx);
          return {
            id,
            version: current.version,
            workflowState: current.workflowState,
            replay: true,
          };
        }
        const current = await find(actor, id, tx);
        if (current.version !== expectedVersion)
          throw new ConflictError("reload the review before adding a note");
        const version = current.version + 1;
        await tx
          .update(REVIEW)
          .set({ version, updatedAt: new Date() })
          .where(
            and(
              eq(REVIEW.id, id),
              eq(REVIEW.organizationId, actor.organizationId),
              eq(REVIEW.version, expectedVersion),
            ),
          );
        await tx.insert(HISTORY).values({
          organizationId: actor.organizationId,
          providerEntityId: current.providerEntityId,
          reviewId: id,
          version,
          action: "note",
          reasonCode,
          actorMembershipId: actor.membershipId,
          idempotencyKeyHash: keyHash,
        });
        return { id, version, workflowState: current.workflowState, replay: false };
      });
    },
    async transition(
      actor: M25WriteActor,
      id: string,
      expectedVersion: number,
      state: State,
      reasonCode: string,
      idempotencyKey: string,
    ) {
      if (!allowed.has(state) || !/^[A-Z0-9_]{2,64}$/.test(reasonCode))
        throw new ValidationError("invalid nonposting review disposition", []);
      const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
      return write("Authorized M25 Medicaid ERA review disposition", async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:${id}`}, 1))`,
        );
        const [prior] = await tx
          .select()
          .from(HISTORY)
          .where(
            and(
              eq(HISTORY.organizationId, actor.organizationId),
              eq(HISTORY.idempotencyKeyHash, keyHash),
            ),
          )
          .limit(1);
        if (prior) {
          if (prior.reviewId !== id || prior.action !== state || prior.reasonCode !== reasonCode)
            throw new ConflictError("this idempotency key was used for another review action");
          const current = await find(actor, id, tx);
          return {
            id,
            version: current.version,
            workflowState: current.workflowState,
            replay: true,
          };
        }
        const current = await find(actor, id, tx);
        if (current.version !== expectedVersion)
          throw new ConflictError("reload the review before updating it");
        if (current.workflowState === "reviewed_not_posted" && state !== "reopened")
          throw new ConflictError("reopen the investigation before changing its disposition");
        const version = current.version + 1;
        const [updated] = await tx
          .update(REVIEW)
          .set({ workflowState: state, version, updatedAt: new Date() })
          .where(
            and(
              eq(REVIEW.id, id),
              eq(REVIEW.organizationId, actor.organizationId),
              eq(REVIEW.version, expectedVersion),
            ),
          )
          .returning({
            id: REVIEW.id,
            version: REVIEW.version,
            workflowState: REVIEW.workflowState,
          });
        if (!updated) throw new ConflictError("the review changed during the update");
        await tx.insert(HISTORY).values({
          organizationId: actor.organizationId,
          providerEntityId: current.providerEntityId,
          reviewId: id,
          version,
          action: state,
          reasonCode,
          actorMembershipId: actor.membershipId,
          idempotencyKeyHash: keyHash,
        });
        return { ...updated, replay: false };
      });
    },
  };
}

export type ReturnTypeMedicaidEraReviewWorkflow = ReturnType<
  typeof buildDrizzleMedicaidEraReviewWorkflow
>;

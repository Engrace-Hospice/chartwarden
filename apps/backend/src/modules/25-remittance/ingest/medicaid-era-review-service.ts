import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ConflictError, DegradedError, NotFoundError, ValidationError } from "@chartwarden/types";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { MedicaidEraReviewService as Evaluator } from "../domain/medicaid-era-trusted-review";
import { consistentMedicaidEraReviewAttribution } from "../domain/medicaid-era-trusted-review";
import type { M25ReadActor, M25WriteActor } from "../routes/actor";
import { providerEntityScopeCondition } from "../routes/scope";

const REVIEW = schema.medicaidEraReview;
const HISTORY = schema.medicaidEraReviewHistory;
const IDEMPOTENCY = schema.medicaidEraReviewIdempotency;
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

/** Deterministic JSON for fingerprints; object key insertion order never changes assessment identity. */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite assessment value");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    const fields = Object.keys(row)
      .filter((key) => row[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError("assessment contains a non-JSON value");
}

const fingerprint = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

type ImmutableReviewIdentity = Pick<
  typeof REVIEW.$inferSelect,
  | "organizationId"
  | "providerEntityId"
  | "stageId"
  | "vendor"
  | "accountReference"
  | "sourceEnvironment"
  | "canonicalPayerId"
  | "programId"
  | "sourceDigest"
>;

export function sameImmutableIdentity(
  existing: ImmutableReviewIdentity,
  expected: ImmutableReviewIdentity,
): boolean {
  return (
    existing.organizationId === expected.organizationId &&
    existing.providerEntityId === expected.providerEntityId &&
    existing.stageId === expected.stageId &&
    existing.vendor === expected.vendor &&
    existing.accountReference === expected.accountReference &&
    existing.sourceEnvironment === expected.sourceEnvironment &&
    existing.canonicalPayerId === expected.canonicalPayerId &&
    existing.programId === expected.programId &&
    existing.sourceDigest === expected.sourceDigest
  );
}

type AssessmentReplayIdentity = Pick<
  typeof REVIEW.$inferSelect,
  "assessmentTrustStatus" | "assessmentFingerprint" | "assessmentEvidenceFingerprint"
>;

/** A fingerprint can identify a replay only after evaluator provenance has independently qualified the row. */
export function isTrustedAssessmentReplay(
  existing: AssessmentReplayIdentity | undefined,
  assessmentFingerprint: string,
  evidenceFingerprint: string,
): boolean {
  return (
    existing?.assessmentTrustStatus === "isolated_evaluator" &&
    existing.assessmentFingerprint === assessmentFingerprint &&
    existing.assessmentEvidenceFingerprint === evidenceFingerprint
  );
}

function actorOperationIdentity(actor: M25WriteActor) {
  return {
    organizationId: actor.organizationId,
    userId: actor.userId,
    membershipId: actor.membershipId,
    sessionId: actor.sessionId ?? null,
    roles: [...actor.roles].sort(),
    providerEntityScope:
      actor.providerEntityScope === undefined ? null : [...actor.providerEntityScope].sort(),
    stepUpRecent: actor.stepUpRecent,
  };
}

export function buildDrizzleMedicaidEraReviewWorkflow(
  db: DbClient,
  evaluator: Evaluator,
  isolatedWriterDb?: DbClient,
) {
  // The API and general workers intentionally omit isolatedWriterDb. Only the separately deployed
  // evaluator process receives the chartwarden_m25_evaluator credential.
  const write = <T>(
    actor: M25WriteActor,
    _reason: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> =>
    isolatedWriterDb
      ? withOrgContext(isolatedWriterDb, actor, fn)
      : Promise.reject(
          new DegradedError(
            "MEDICAID_ERA_REVIEW_WRITER_UNAVAILABLE",
            "nonposting review writes are unavailable",
          ),
        );
  const find = async (
    actor: M25ReadActor,
    id: string,
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    forUpdate = false,
  ) => {
    let query = tx
      .select()
      .from(REVIEW)
      .where(
        and(
          eq(REVIEW.id, id),
          eq(REVIEW.organizationId, actor.organizationId),
          providerEntityScopeCondition(REVIEW.providerEntityId, actor.providerEntityScope),
        ),
      );
    if (forUpdate) query = query.for("update") as typeof query;
    const rows = await query.limit(1);
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
      const attributionResult = consistentMedicaidEraReviewAttribution(result.claims);
      if (attributionResult.status !== "verified")
        return { status: "held" as const, reasonCode: attributionResult.reasonCode };
      const attribution = attributionResult.attribution;
      const providerEntityId = attribution.providerEntityId;
      const canonicalPayerId = attribution.canonicalPayerId;
      const programId = attribution.programId;
      const vendor = attribution.vendor;
      const accountReference = attribution.accountReference;
      const sourceEnvironment = attribution.usage;
      const artifactDigest = result.artifactDigest;
      const evaluationSnapshotFingerprint = fingerprint(result);
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
      const safeSummary = {
        transactionSetCount: result.transactionSetCount,
        claims: result.claims.map((item) => ({
          decision: item.decision,
          reasonCode: item.reasonCode,
          matchStatus: item.matchStatus,
          matchedClaim: item.matchedClaim,
          attribution: item.attribution,
          evidenceReferences: item.evidenceReferences,
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
          canonicalJson({
            version: "l6d-v2",
            decisionStatus,
            reasonCodes,
            claimMatchStatus,
            duplicateStatus,
            evidenceSnapshotFingerprint: evaluationSnapshotFingerprint,
            safeSummary,
          }),
        )
        .digest("hex");
      const operationFingerprint = createHash("sha256")
        .update(
          canonicalJson({
            operation: "evaluate",
            actor: actorOperationIdentity(actor),
            artifactId,
            assessmentFingerprint,
          }),
        )
        .digest("hex");
      return write(actor, "Authorized M25 nonposting Medicaid ERA assessment", async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:${artifactId}:${artifactDigest}`}, 1))`,
        );
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:idempotency:${digestKey}`}, 2))`,
        );
        // Assessment inputs are read through M24/M40/M25 owners before the restricted writer transaction.
        // Re-read them after acquiring the per-artifact lock so an evaluation that waited behind a newer
        // assessment cannot overwrite it with stale account, claim, duplicate or submission evidence.
        const currentEvaluation = await evaluator.inspect(actor, artifactId);
        // Record when this authoritative evaluator snapshot was observed, before persistence work.
        // This remains a point-in-time nonposting observation, not a transaction-time authorization.
        const assessmentObservedAt = new Date();
        if (
          currentEvaluation.status !== "review_only" ||
          currentEvaluation.artifactDigest !== artifactDigest ||
          fingerprint(currentEvaluation) !== evaluationSnapshotFingerprint
        )
          throw new ConflictError(
            "authoritative ERA evidence changed; evaluate the artifact again",
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
          .for("update")
          .limit(1);
        const [priorOperation] = await tx
          .select({
            reviewId: IDEMPOTENCY.reviewId,
            operation: IDEMPOTENCY.operation,
            operationFingerprint: IDEMPOTENCY.operationFingerprint,
          })
          .from(IDEMPOTENCY)
          .where(
            and(
              eq(IDEMPOTENCY.organizationId, actor.organizationId),
              eq(IDEMPOTENCY.idempotencyKeyHash, digestKey),
            ),
          )
          .limit(1);
        if (
          existing &&
          !sameImmutableIdentity(existing, {
            organizationId: actor.organizationId,
            providerEntityId,
            stageId: artifactId,
            vendor,
            accountReference,
            sourceEnvironment,
            canonicalPayerId,
            programId,
            sourceDigest: artifactDigest,
          })
        )
          return {
            status: "held" as const,
            reasonCode: "REVIEW_IMMUTABLE_SOURCE_IDENTITY_CONFLICT",
          };
        if (priorOperation) {
          if (
            priorOperation.reviewId !== existing?.id ||
            priorOperation.operation !== "evaluate" ||
            priorOperation.operationFingerprint !== operationFingerprint
          )
            throw new ConflictError("this idempotency key was used for another review operation");
          if (
            isTrustedAssessmentReplay(
              existing,
              assessmentFingerprint,
              evaluationSnapshotFingerprint,
            )
          )
            return {
              status: "review_saved" as const,
              reviewId: existing.id,
              version: existing.version,
              replay: true,
            };
          throw new ConflictError(
            "the prior evaluation is not a trusted replay of current evidence",
          );
        }
        if (
          isTrustedAssessmentReplay(existing, assessmentFingerprint, evaluationSnapshotFingerprint)
        ) {
          await tx.insert(IDEMPOTENCY).values({
            organizationId: actor.organizationId,
            providerEntityId,
            reviewId: existing.id,
            idempotencyKeyHash: digestKey,
            operation: "evaluate",
            operationFingerprint,
          });
          return {
            status: "review_saved" as const,
            reviewId: existing.id,
            version: existing.version,
            replay: true,
          };
        }
        if (existing) {
          const version = existing.version + 1;
          const [updated] = await tx
            .update(REVIEW)
            .set({
              assessmentFingerprint,
              assessmentEvidenceFingerprint: evaluationSnapshotFingerprint,
              assessmentObservedAt,
              assessmentVersion: "l6d-v2",
              decisionStatus,
              reasonCodes,
              claimMatchStatus,
              duplicateStatus,
              safeSummary,
              assessmentTrustStatus: "isolated_evaluator",
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
          await tx.insert(IDEMPOTENCY).values({
            organizationId: actor.organizationId,
            providerEntityId,
            reviewId: existing.id,
            idempotencyKeyHash: digestKey,
            operation: "evaluate",
            operationFingerprint,
          });
          await tx.insert(HISTORY).values({
            organizationId: actor.organizationId,
            providerEntityId,
            reviewId: existing.id,
            version,
            action: "reassessed",
            reasonCode: "CURRENT_SOURCE_FACTS_REASSESSED",
            actorMembershipId: actor.membershipId,
            idempotencyKeyHash: digestKey,
            operationFingerprint,
            trustStatus: "isolated_evaluator",
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
            assessmentEvidenceFingerprint: evaluationSnapshotFingerprint,
            assessmentObservedAt,
            assessmentVersion: "l6d-v2",
            decisionStatus,
            reasonCodes,
            claimMatchStatus,
            duplicateStatus,
            safeSummary,
            assessmentTrustStatus: "isolated_evaluator",
          })
          .returning({ id: REVIEW.id, version: REVIEW.version });
        await tx.insert(IDEMPOTENCY).values({
          organizationId: actor.organizationId,
          providerEntityId,
          reviewId: row!.id,
          idempotencyKeyHash: digestKey,
          operation: "evaluate",
          operationFingerprint,
        });
        await tx.insert(HISTORY).values({
          organizationId: actor.organizationId,
          providerEntityId,
          reviewId: row!.id,
          version: 1,
          action: "assessed",
          reasonCode: "NONPOSTING_ASSESSMENT",
          actorMembershipId: actor.membershipId,
          idempotencyKeyHash: digestKey,
          operationFingerprint,
          trustStatus: "isolated_evaluator",
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
            assessmentTrustStatus: REVIEW.assessmentTrustStatus,
            assessmentEvidenceFingerprint: REVIEW.assessmentEvidenceFingerprint,
            assessmentObservedAt: REVIEW.assessmentObservedAt,
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
          items: items.map((item) => {
            const assessmentSemantics =
              item.assessmentTrustStatus === "legacy_unverified"
                ? "legacy_unverified"
                : item.assessmentEvidenceFingerprint && item.assessmentObservedAt
                  ? "point_in_time_nonposting"
                  : "snapshot_unavailable";
            const { assessmentEvidenceFingerprint: _evidenceFingerprint, ...safeItem } = item;
            return item.assessmentTrustStatus === "legacy_unverified"
              ? {
                  ...safeItem,
                  assessmentSemantics,
                  assessmentObservedAt: null,
                  sourceEnvironment: null,
                  canonicalPayerId: null,
                  programId: null,
                  decisionStatus: "unverified",
                  reasonCodes: ["LEGACY_ASSESSMENT_UNVERIFIED"],
                  claimMatchStatus: "UNVERIFIED",
                  duplicateStatus: "unverified",
                }
              : { ...safeItem, assessmentSemantics };
          }),
          nextCursor:
            hasMore && last
              ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url")
              : null,
        };
      });
    },
    /**
     * Resolve the staged reference for a reassessment only from an evaluator-attested review row.
     * The opaque artifact reference stays inside the server composition; callers expose only the
     * review id and the evaluator re-reads the staged bytes and current evidence before writing.
     * Legacy rows intentionally cannot be promoted through this path.
     */
    async reassessmentArtifactReference(actor: M25ReadActor, id: string): Promise<string | null> {
      return withOrgContext(db, actor, async (tx) => {
        const review = await find(actor, id, tx);
        if (
          review.assessmentTrustStatus !== "isolated_evaluator" ||
          !review.stageId ||
          !review.sourceDigest ||
          !review.accountReference ||
          !review.sourceEnvironment ||
          !review.canonicalPayerId ||
          !review.programId
        )
          return null;
        return review.stageId;
      });
    },
    async detail(actor: M25ReadActor, id: string) {
      return withOrgContext(db, actor, async (tx) => {
        const {
          assessmentFingerprint: _assessmentFingerprint,
          assessmentEvidenceFingerprint,
          ...storedDetail
        } = await find(actor, id, tx);
        const detail = {
          ...storedDetail,
          assessmentSemantics:
            storedDetail.assessmentTrustStatus === "legacy_unverified"
              ? "legacy_unverified"
              : assessmentEvidenceFingerprint && storedDetail.assessmentObservedAt
                ? "point_in_time_nonposting"
                : "snapshot_unavailable",
        };
        if (detail.assessmentTrustStatus === "legacy_unverified")
          // Historical rows predate evaluator attestation. Their stored source identity is not
          // trustworthy evidence, so do not expose it as if the account/artifact were verified.
          // Keep only the vendor discriminator needed to explain which review family this is.
          return (({
            stageId: _stageId,
            accountReference: _accountReference,
            sourceEnvironment: _sourceEnvironment,
            sourceDigest: _sourceDigest,
            ...legacyDetail
          }) => ({
            ...legacyDetail,
            accountReference: null,
            sourceEnvironment: null,
            sourceDigest: null,
            stageId: null,
            assessmentObservedAt: null,
            canonicalPayerId: null,
            programId: null,
            assessmentVersion: "legacy_unverified",
            decisionStatus: "unverified",
            reasonCodes: ["LEGACY_ASSESSMENT_UNVERIFIED"],
            claimMatchStatus: "UNVERIFIED",
            duplicateStatus: "unverified",
            safeSummary: null,
          }))(detail);
        return detail;
      });
    },
    async history(actor: M25ReadActor, id: string) {
      return withOrgContext(db, actor, async (tx) => {
        const review = await find(actor, id, tx);
        const items = await tx
          .select({
            version: HISTORY.version,
            action: HISTORY.action,
            reasonCode: HISTORY.reasonCode,
            actorMembershipId: HISTORY.actorMembershipId,
            trustStatus: HISTORY.trustStatus,
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
        return items.map((item) =>
          item.trustStatus === "legacy_unverified"
            ? {
                ...item,
                action: "legacy_unverified",
                reasonCode: null,
                actorMembershipId: null,
                trustStatus: "legacy_unverified" as const,
              }
            : { ...item, trustStatus: "isolated_evaluator" as const },
        );
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
      const operationFingerprint = createHash("sha256")
        .update(
          canonicalJson({
            operation: "note",
            actor: actorOperationIdentity(actor),
            id,
            expectedVersion,
            reasonCode,
          }),
        )
        .digest("hex");
      return write(actor, "Authorized M25 Medicaid ERA investigation note", async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:${id}`}, 1))`,
        );
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:idempotency:${keyHash}`}, 2))`,
        );
        const [prior] = await tx
          .select()
          .from(IDEMPOTENCY)
          .where(
            and(
              eq(IDEMPOTENCY.organizationId, actor.organizationId),
              eq(IDEMPOTENCY.idempotencyKeyHash, keyHash),
            ),
          )
          .limit(1);
        if (prior) {
          if (
            prior.reviewId !== id ||
            prior.operation !== "note" ||
            prior.operationFingerprint !== operationFingerprint
          )
            throw new ConflictError("this idempotency key was used for another review action");
          const current = await find(actor, id, tx, true);
          return {
            id,
            version: current.version,
            workflowState: current.workflowState,
            replay: true,
          };
        }
        const current = await find(actor, id, tx, true);
        if (current.version !== expectedVersion)
          throw new ConflictError("reload the review before adding a note");
        const version = current.version + 1;
        await tx.insert(IDEMPOTENCY).values({
          organizationId: actor.organizationId,
          providerEntityId: current.providerEntityId,
          reviewId: id,
          idempotencyKeyHash: keyHash,
          operation: "note",
          operationFingerprint,
        });
        const [updated] = await tx
          .update(REVIEW)
          .set({ version, updatedAt: new Date() })
          .where(
            and(
              eq(REVIEW.id, id),
              eq(REVIEW.organizationId, actor.organizationId),
              eq(REVIEW.version, expectedVersion),
            ),
          )
          .returning({ id: REVIEW.id });
        if (!updated) throw new ConflictError("the review changed during the note update");
        await tx.insert(HISTORY).values({
          organizationId: actor.organizationId,
          providerEntityId: current.providerEntityId,
          reviewId: id,
          version,
          action: "note",
          reasonCode,
          actorMembershipId: actor.membershipId,
          idempotencyKeyHash: keyHash,
          operationFingerprint,
          trustStatus: "isolated_evaluator",
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
      const operationFingerprint = createHash("sha256")
        .update(
          canonicalJson({
            operation: "transition",
            actor: actorOperationIdentity(actor),
            id,
            expectedVersion,
            state,
            reasonCode,
          }),
        )
        .digest("hex");
      return write(actor, "Authorized M25 Medicaid ERA review disposition", async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:${id}`}, 1))`,
        );
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:idempotency:${keyHash}`}, 2))`,
        );
        const [prior] = await tx
          .select()
          .from(IDEMPOTENCY)
          .where(
            and(
              eq(IDEMPOTENCY.organizationId, actor.organizationId),
              eq(IDEMPOTENCY.idempotencyKeyHash, keyHash),
            ),
          )
          .limit(1);
        if (prior) {
          if (
            prior.reviewId !== id ||
            prior.operation !== "transition" ||
            prior.operationFingerprint !== operationFingerprint
          )
            throw new ConflictError("this idempotency key was used for another review action");
          const current = await find(actor, id, tx, true);
          return {
            id,
            version: current.version,
            workflowState: current.workflowState,
            replay: true,
          };
        }
        const current = await find(actor, id, tx, true);
        if (current.version !== expectedVersion)
          throw new ConflictError("reload the review before updating it");
        if (current.workflowState === "reviewed_not_posted" && state !== "reopened")
          throw new ConflictError("reopen the investigation before changing its disposition");
        const version = current.version + 1;
        await tx.insert(IDEMPOTENCY).values({
          organizationId: actor.organizationId,
          providerEntityId: current.providerEntityId,
          reviewId: id,
          idempotencyKeyHash: keyHash,
          operation: "transition",
          operationFingerprint,
        });
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
          operationFingerprint,
          trustStatus: "isolated_evaluator",
        });
        return { ...updated, replay: false };
      });
    },
  };
}

export type ReturnTypeMedicaidEraReviewWorkflow = ReturnType<
  typeof buildDrizzleMedicaidEraReviewWorkflow
>;

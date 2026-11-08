import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import { and, asc, count, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { claimMdIdentityFromCapturedPage } from "./event-identifiers";
import type { ClaimMdIdentityEvent, IdentityResolution, SubmissionCandidate } from "./resolve";
import type { IdentityResolutionRepository, ResolutionQueueRepository } from "./service";
import { CLAIMMD_IDENTITY_JOB_ID } from "./worker";

const R = schema.claimmdResponseResolutions;
const H = schema.claimmdResponseResolutionHistory;
const E = schema.claimmdResponseEvents;
const B = schema.claimmdResponseBatches;
const S = schema.claimmdResponseStreams;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Cipher = { open(streamId: string, cursor: string, sealed: Buffer): string };
export interface ClaimMdIdentityStore
  extends IdentityResolutionRepository,
    ResolutionQueueRepository {
  requeue(
    eventId: string,
    expectedVersion: number,
    reason: "verified_receipt_enriched" | "keyring_restored" | "operator_evidence_verified",
    actorId: string,
  ): Promise<boolean>;
  summary(): Promise<{
    readonly pending: number;
    readonly resolved: number;
    readonly unmatched: number;
    readonly ambiguous: number;
    readonly conflict: number;
    readonly needsReview: number;
    readonly oldestUnresolvedSeconds: number | null;
  }>;
}

function asResolution(
  row: typeof R.$inferSelect | undefined,
  accountReference: string,
  usage: "test" | "production",
): IdentityResolution | null {
  if (!row) return null;
  return {
    state: row.state,
    reason: (row.reasonCode as IdentityResolution["reason"]) ?? null,
    strategy: (row.strategy as IdentityResolution["strategy"]) ?? null,
    candidate:
      row.organizationId &&
      row.providerEntityId &&
      row.claimId &&
      row.module &&
      row.submissionId &&
      row.submissionAttemptId
        ? {
            accountReference,
            usage,
            organizationId: row.organizationId,
            providerEntityId: row.providerEntityId,
            locationId: row.locationId,
            evidenceId:
              typeof row.evidenceRef?.evidenceId === "string"
                ? row.evidenceRef.evidenceId
                : undefined,
            transportAttemptId:
              typeof row.evidenceRef?.transportAttemptId === "string"
                ? row.evidenceRef.transportAttemptId
                : undefined,
            payloadSha256:
              typeof row.evidenceRef?.payloadSha256 === "string"
                ? row.evidenceRef.payloadSha256
                : undefined,
            claimId: row.claimId,
            module: row.module,
            submissionId: row.submissionId,
            submissionAttemptId: row.submissionAttemptId,
          }
        : null,
    algorithmVersion: "bil1.2.v1",
  };
}

/** Account-wide data and cross-tenant candidate access require the narrow Claim.MD integration execution role. */
export function createClaimMdIdentityStore(input: {
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<Tx>;
  readonly cipher: Cipher;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly candidates: (
    event: ClaimMdIdentityEvent,
  ) => Promise<
    | readonly SubmissionCandidate[]
    | { readonly candidates: readonly SubmissionCandidate[]; readonly complete: boolean }
  >;
}): ClaimMdIdentityStore {
  const run = <T>(reason: string, fn: (tx: Tx) => Promise<T>) =>
    withPlatformContext(
      input.platformDb,
      { jobId: CLAIMMD_IDENTITY_JOB_ID, reason, crossTenant: true },
      input.auditBypass,
      fn,
    );
  return {
    async loadEvent(eventId) {
      return run("claimmd identity event read", async (tx) => {
        const [row] = await tx
          .select({
            eventId: E.id,
            responseId: E.responseId,
            parentIndex: E.parentIndex,
            messageIndex: E.messageIndex,
            streamId: E.streamId,
            cursor: B.afterCursor,
            payload: B.payloadCipher,
            accountReference: S.accountReference,
            usage: S.usage,
            resolution: R,
            version: R.version,
          })
          .from(E)
          .innerJoin(B, eq(B.id, E.batchId))
          .innerJoin(S, eq(S.id, E.streamId))
          .leftJoin(R, eq(R.eventId, E.id))
          .where(eq(E.id, eventId))
          .limit(1);
        if (!row) return null;
        if (row.accountReference !== input.accountReference || row.usage !== input.usage)
          return null;
        let body: unknown;
        try {
          body = JSON.parse(input.cipher.open(row.streamId, row.cursor, row.payload));
        } catch {
          throw new Error("CLAIMMD_INBOX_KEY_OR_PAYLOAD_UNAVAILABLE");
        }
        const event = claimMdIdentityFromCapturedPage({
          body,
          parentIndex: row.parentIndex,
          messageIndex: row.messageIndex,
          accountReference: row.accountReference,
          usage: row.usage,
          responseId: row.responseId,
        });
        const safeEvent: ClaimMdIdentityEvent = event ?? {
          accountReference: row.accountReference,
          usage: row.usage,
          responseId: row.responseId,
          claimMdClaimId: null,
          remoteClaimId: null,
          claimId: null,
          fileId: null,
          batchId: null,
          pcn: null,
          billingNpi: null,
          billingTin: null,
          payerId: null,
          claimType: null,
          serviceFrom: null,
          serviceTo: null,
          malformed: true,
        };
        return {
          event: safeEvent,
          previous: asResolution(row.resolution ?? undefined, row.accountReference, row.usage),
          version: row.version ?? 0,
        };
      });
    },
    findCandidates(event) {
      return input.candidates(event);
    },
    async save(eventId, expectedVersion, result, leaseToken) {
      return run("claimmd identity resolution write", async (tx) => {
        const [current] = await tx
          .select()
          .from(R)
          .where(eq(R.eventId, eventId))
          .for("update")
          .limit(1);
        const currentVersion = current?.version ?? 0;
        if (
          currentVersion !== expectedVersion ||
          (leaseToken !== undefined && current?.leaseOwner !== leaseToken)
        )
          return false;
        const version = currentVersion + 1;
        const previousResolved = current?.state === "resolved";
        const target =
          result.candidate ??
          (previousResolved
            ? {
                accountReference: input.accountReference,
                usage: input.usage,
                organizationId: current.organizationId!,
                providerEntityId: current.providerEntityId!,
                locationId: current.locationId,
                evidenceId:
                  typeof current.evidenceRef?.evidenceId === "string"
                    ? current.evidenceRef.evidenceId
                    : undefined,
                transportAttemptId:
                  typeof current.evidenceRef?.transportAttemptId === "string"
                    ? current.evidenceRef.transportAttemptId
                    : undefined,
                payloadSha256:
                  typeof current.evidenceRef?.payloadSha256 === "string"
                    ? current.evidenceRef.payloadSha256
                    : undefined,
                claimId: current.claimId!,
                module: current.module!,
                submissionId: current.submissionId!,
                submissionAttemptId: current.submissionAttemptId!,
              }
            : null);
        const evidenceRef: Record<string, string> = result.candidate
          ? {
              strategy: result.strategy ?? "none",
              module: result.candidate.module,
              submissionId: result.candidate.submissionId,
              submissionAttemptId: result.candidate.submissionAttemptId,
              ...(result.candidate.evidenceId ? { evidenceId: result.candidate.evidenceId } : {}),
              ...(result.candidate.transportAttemptId
                ? { transportAttemptId: result.candidate.transportAttemptId }
                : {}),
              ...(result.candidate.payloadSha256
                ? { payloadSha256: result.candidate.payloadSha256 }
                : {}),
            }
          : {};
        const values = {
          state: result.state,
          organizationId: target?.organizationId ?? null,
          providerEntityId: target?.providerEntityId ?? null,
          locationId: target?.locationId ?? null,
          claimId: target?.claimId ?? null,
          module: target?.module ?? null,
          submissionId: target?.submissionId ?? null,
          submissionAttemptId: target?.submissionAttemptId ?? null,
          strategy: result.strategy,
          reasonCode: result.reason,
          evidenceRef: result.candidate
            ? evidenceRef
            : previousResolved
              ? current.evidenceRef
              : evidenceRef,
          algorithmVersion: result.algorithmVersion,
          version,
          attempts: sql`${R.attempts} + 1`,
          nextAttemptAt:
            result.state === "unmatched" ||
            result.state === "ambiguous" ||
            result.state === "needs_review"
              ? sql`now() + interval '15 minutes'`
              : null,
          resolvedAt:
            result.state === "resolved" ? sql`now()` : previousResolved ? current.resolvedAt : null,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: sql`now()`,
        };
        let resolutionId = current?.id;
        if (current)
          await tx
            .update(R)
            .set(values)
            .where(
              and(
                eq(R.id, current.id),
                eq(R.version, currentVersion),
                ...(leaseToken === undefined ? [] : [eq(R.leaseOwner, leaseToken)]),
              ),
            );
        else {
          const [inserted] = await tx
            .insert(R)
            .values({ eventId, ...values })
            .onConflictDoNothing()
            .returning({ id: R.id });
          if (!inserted) return false;
          resolutionId = inserted.id;
        }
        if (!resolutionId) return false;
        await tx.insert(H).values({
          resolutionId,
          version,
          state: result.state,
          organizationId: target?.organizationId ?? null,
          providerEntityId: target?.providerEntityId ?? null,
          locationId: target?.locationId ?? null,
          claimId: target?.claimId ?? null,
          module: target?.module ?? null,
          submissionId: target?.submissionId ?? null,
          submissionAttemptId: target?.submissionAttemptId ?? null,
          strategy: result.strategy,
          reasonCode: result.reason,
          evidenceRef: values.evidenceRef,
          algorithmVersion: result.algorithmVersion,
        });
        return true;
      });
    },
    async claimBatch(limit, leaseMs) {
      const owner = randomUUID();
      return run("claimmd identity work lease", async (tx) => {
        const rows = await tx
          .select({ id: R.id, version: R.version })
          .from(R)
          .innerJoin(E, eq(E.id, R.eventId))
          .innerJoin(S, eq(S.id, E.streamId))
          .where(
            and(
              eq(S.accountReference, input.accountReference),
              eq(S.usage, input.usage),
              ne(E.captureState, "malformed"),
              sql`${R.attempts} < 8`,
              and(
                eq(R.state, "pending"),
                or(isNull(R.nextAttemptAt), lte(R.nextAttemptAt, sql`now()`)),
              ),
              or(isNull(R.leaseUntil), lte(R.leaseUntil, sql`now()`)),
            ),
          )
          .orderBy(asc(R.createdAt))
          .limit(Math.min(100, limit))
          .for("update", { skipLocked: true });
        const leased: { eventId: string; version: number; leaseToken: string }[] = [];
        for (const row of rows) {
          const [updated] = await tx
            .update(R)
            .set({
              leaseOwner: owner,
              leaseUntil: sql`now() + (${leaseMs} * interval '1 millisecond')`,
              updatedAt: sql`now()`,
            })
            .where(and(eq(R.id, row.id), eq(R.version, row.version)))
            .returning({ id: R.eventId, version: R.version });
          if (updated)
            leased.push({ eventId: updated.id, version: updated.version, leaseToken: owner });
        }
        return leased;
      });
    },
    async complete(eventId, version, leaseToken) {
      await run("claimmd identity lease complete", async (tx) => {
        await tx
          .update(R)
          .set({ leaseOwner: null, leaseUntil: null, updatedAt: sql`now()` })
          .where(and(eq(R.eventId, eventId), eq(R.version, version), eq(R.leaseOwner, leaseToken)));
      });
    },
    async retry(eventId, version, leaseToken, safeCode) {
      await run("claimmd identity lease retry", async (tx) => {
        await tx
          .update(R)
          .set({
            state: sql`CASE WHEN ${R.attempts} >= 7 THEN 'needs_review' ELSE 'pending' END`,
            reasonCode: sql`CASE WHEN ${R.attempts} >= 7 THEN 'RESOLUTION_RETRY_EXHAUSTED' ELSE ${safeCode} END`,
            attempts: sql`${R.attempts} + 1`,
            nextAttemptAt: sql`now() + (LEAST(30, power(2, LEAST(${R.attempts}, 4))) * interval '1 minute')`,
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: sql`now()`,
          })
          .where(and(eq(R.eventId, eventId), eq(R.version, version), eq(R.leaseOwner, leaseToken)));
      });
    },
    /** Internal platform-only requeue. Resolved/conflict mappings cannot be reassigned through this path. */
    async requeue(
      eventId: string,
      expectedVersion: number,
      reason: "verified_receipt_enriched" | "keyring_restored" | "operator_evidence_verified",
      actorId: string,
    ): Promise<boolean> {
      if (!/^[0-9a-f-]{36}$/i.test(actorId)) throw new Error("CLAIMMD_REQUEUE_ACTOR_INVALID");
      return run(`Claim.MD identity requeue: ${reason}`, async (tx) => {
        const [current] = await tx
          .select()
          .from(R)
          .where(eq(R.eventId, eventId))
          .for("update")
          .limit(1);
        if (
          !current ||
          current.version !== expectedVersion ||
          !["unmatched", "ambiguous", "needs_review"].includes(current.state)
        )
          return false;
        const version = current.version + 1;
        const evidenceRef = {
          ...(current.evidenceRef ?? {}),
          requeueReason: reason,
          requeuedBy: actorId,
        };
        const [updated] = await tx
          .update(R)
          .set({
            state: "pending",
            reasonCode: "OPERATOR_REQUEUED",
            attempts: 0,
            nextAttemptAt: sql`now()`,
            leaseOwner: null,
            leaseUntil: null,
            version,
            evidenceRef,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(R.id, current.id),
              eq(R.version, expectedVersion),
              inArray(R.state, ["unmatched", "ambiguous", "needs_review"]),
            ),
          )
          .returning({ id: R.id });
        if (!updated) return false;
        await tx.insert(H).values({
          resolutionId: current.id,
          version,
          state: "pending",
          organizationId: current.organizationId,
          providerEntityId: current.providerEntityId,
          locationId: current.locationId,
          claimId: current.claimId,
          module: current.module,
          submissionId: current.submissionId,
          submissionAttemptId: current.submissionAttemptId,
          strategy: current.strategy,
          reasonCode: "OPERATOR_REQUEUED",
          evidenceRef,
          algorithmVersion: current.algorithmVersion,
        });
        return true;
      });
    },
    async summary() {
      return run("Claim.MD identity resolver PHI-safe operational summary", async (tx) => {
        const rows = await tx
          .select({
            state: R.state,
            count: count(),
            oldest: sql<number | null>`extract(epoch from now() - min(${R.createdAt}))`,
          })
          .from(R)
          .innerJoin(E, eq(E.id, R.eventId))
          .innerJoin(S, eq(S.id, E.streamId))
          .where(and(eq(S.accountReference, input.accountReference), eq(S.usage, input.usage)))
          .groupBy(R.state);
        const counts = new Map(rows.map((r) => [r.state, Number(r.count)]));
        const unresolved = rows.filter((r) =>
          ["pending", "unmatched", "ambiguous", "conflict", "needs_review"].includes(r.state),
        );
        const oldest = unresolved.reduce<number | null>(
          (max, row) => (row.oldest === null ? max : Math.max(max ?? 0, Number(row.oldest))),
          null,
        );
        return {
          pending: counts.get("pending") ?? 0,
          resolved: counts.get("resolved") ?? 0,
          unmatched: counts.get("unmatched") ?? 0,
          ambiguous: counts.get("ambiguous") ?? 0,
          conflict: counts.get("conflict") ?? 0,
          needsReview: counts.get("needs_review") ?? 0,
          oldestUnresolvedSeconds: oldest,
        };
      });
    },
  };
}

import { type DbClient, schema } from "@chartwarden/db";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import { and, count, eq, min, notExists } from "drizzle-orm";
/** Read-only metrics principal, independent of response capture activation. */
export const CLAIMMD_RESPONSE_METRICS_JOB_ID = "m23-claimmd-response-metrics";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
const S = schema.claimmdResponseStreams;
const E = schema.claimmdResponseEvents;
const R = schema.claimmdResponseResolutions;
const D = schema.claimmdAckDeliveries;
const A = schema.claimmdAckApplications;

/** Read-only, bounded aggregate view. It never decrypts response payloads or returns identifiers. */
export function createClaimMdOperationalReader(input: {
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<Tx>;
  readonly accountReference: string;
  readonly usage: "test" | "production";
}) {
  return {
    async snapshot() {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.accountReference))
        throw new Error("CLAIMMD_ACCOUNT_INVALID");
      return withPlatformContext(
        input.platformDb,
        {
          jobId: CLAIMMD_RESPONSE_METRICS_JOB_ID,
          reason: "Claim.MD response and acknowledgment durable operational metrics",
          crossTenant: true,
        },
        input.auditBypass,
        async (tx) => {
          const [stream] = await tx
            .select({
              cursorPresent: S.id,
              lastSuccessAt: S.lastSuccessAt,
              lastAttemptAt: S.lastAttemptAt,
              failed: S.errorCode,
              leaseUntil: S.leaseUntil,
            })
            .from(S)
            .where(
              and(
                eq(S.accountReference, input.accountReference),
                eq(S.usage, input.usage),
                eq(S.streamType, "claim_responses"),
              ),
            )
            .limit(1);
          const events = await tx
            .select({ state: E.captureState, count: count(), oldest: min(E.capturedAt) })
            .from(E)
            .innerJoin(S, eq(S.id, E.streamId))
            .where(
              and(
                eq(S.accountReference, input.accountReference),
                eq(S.usage, input.usage),
                eq(S.streamType, "claim_responses"),
              ),
            )
            .groupBy(E.captureState);
          const resolutions = await tx
            .select({ state: R.state, count: count(), oldest: min(R.createdAt) })
            .from(R)
            .innerJoin(E, eq(E.id, R.eventId))
            .innerJoin(S, eq(S.id, E.streamId))
            .where(
              and(
                eq(S.accountReference, input.accountReference),
                eq(S.usage, input.usage),
                eq(S.streamType, "claim_responses"),
              ),
            )
            .groupBy(R.state);
          const deliveries = await tx
            .select({ state: D.state, count: count(), oldest: min(D.updatedAt) })
            .from(D)
            .where(and(eq(D.accountReference, input.accountReference), eq(D.usage, input.usage)))
            .groupBy(D.state);
          const applications = await tx
            .select({ outcome: A.outcome, count: count() })
            .from(A)
            .where(and(eq(A.accountReference, input.accountReference), eq(A.usage, input.usage)))
            .groupBy(A.outcome);
          const unresolved = tx.select({ id: R.id }).from(R).where(eq(R.eventId, E.id));
          const [unresolvedEvents] = await tx
            .select({ count: count(), oldest: min(E.capturedAt) })
            .from(E)
            .innerJoin(S, eq(S.id, E.streamId))
            .where(
              and(
                eq(S.accountReference, input.accountReference),
                eq(S.usage, input.usage),
                eq(S.streamType, "claim_responses"),
                notExists(unresolved),
              ),
            );
          const asCounts = (rows: readonly { state: string; count: number }[]) =>
            Object.fromEntries(rows.map((row) => [row.state, row.count]));
          const oldest = (...values: (Date | null)[]) => {
            const present = values.filter((value): value is Date => value instanceof Date);
            return present.length ? Math.min(...present.map((value) => value.getTime())) : null;
          };
          return {
            cursorPresent: Boolean(stream?.cursorPresent),
            lastSuccessAt: stream?.lastSuccessAt?.getTime() ?? null,
            lastAttemptAt: stream?.lastAttemptAt?.getTime() ?? null,
            streamFailed: Boolean(stream?.failed),
            leaseActive: Boolean(stream?.leaseUntil && stream.leaseUntil > new Date()),
            capture: asCounts(events),
            resolution: asCounts(resolutions),
            delivery: asCounts(deliveries),
            applications: Object.fromEntries(applications.map((row) => [row.outcome, row.count])),
            unresolvedCount: unresolvedEvents?.count ?? 0,
            oldestUnresolvedAt: oldest(
              unresolvedEvents?.oldest ?? null,
              ...resolutions
                .filter((row) =>
                  ["pending", "unmatched", "ambiguous", "conflict", "needs_review"].includes(
                    row.state,
                  ),
                )
                .map((row) => row.oldest),
            ),
            oldestDispatchAt: oldest(
              ...deliveries
                .filter((row) => row.state === "pending" || row.state === "needs_review")
                .map((row) => row.oldest),
            ),
            sampledAt: Date.now(),
          };
        },
      );
    },
  };
}

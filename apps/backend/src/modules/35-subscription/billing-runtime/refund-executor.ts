// apps/backend/src/modules/35-subscription/billing-runtime/refund-executor.ts - GAP-061 / GAP-058.
//
// Executes APPROVED refunds through the §4.13 outbox-only dispatcher. Before this, `approveRefund` flipped a
// row to `approved` and nothing ever moved it on: no Stripe call, and no producer for `m35.refund.executed` /
// `m35.refund.failed`. The `approved` row is itself the durable work item (no extra outbox hop), so this is a
// SWEEP: every tick it picks up approved refunds and drives each through `dispatchStripeCall`
// (deterministic idempotency key, redacted `stripe_api_call_audit` row, retry-vs-DLQ decision).
//
//   - success            -> refund `executed_success` + `stripe_refund_id`, `m35.refund.executed`
//   - permanent failure  -> refund `executed_failed` + failure code, `m35.refund.failed`
//   - retryable failure  -> the dispatcher rethrows; the row stays `approved` and the next tick retries with
//                           `attemptIndex + 1` (a distinct, auditable key) until STRIPE_MAX_ATTEMPTS
//   - re-drain after a Stripe 2xx whose mirror write was lost -> `noop` from the dispatcher; the mirror is
//                           re-applied from the audited 2xx response, never by calling Stripe again
//
// With no Stripe credential the bound client is the FAIL-CLOSED port: every call fails permanently and the
// refund is marked `executed_failed` with `STRIPE_NOT_CONFIGURED` - it is never reported as paid out.
import { schema } from "@wardenx/db";
import {
  STRIPE_MAX_ATTEMPTS,
  type StripeApiCallAuditStore,
  type StripeApiResponse,
  type StripeClient,
  type StripeDispatchEvent,
  type StripeMirrorApplier,
  dispatchStripeCall,
} from "@wardenx/subscription-billing";
import type { OrgId, StripeApiCallAuditId } from "@wardenx/types";
import { and, asc, eq, gte, like, lt, sql } from "drizzle-orm";
import type { PlatformRunner, WriteOutboxPort } from "../routes/service-drizzle";

const REFUND_SWEEP_LIMIT = 25;
const REFUND_OPERATION = "refund.create";

export interface RefundExecutorDeps {
  readonly platformRunner: PlatformRunner;
  readonly client: StripeClient;
  readonly outbox?: WriteOutboxPort;
  readonly now?: () => Date;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

export interface RefundSweepResult {
  readonly considered: number;
  readonly executed: number;
  readonly failed: number;
  readonly retryLater: number;
}

/** `stripe_api_call_audit` writes through the platform runner (the table has no tenant grant). */
export function createDrizzleStripeAuditStore(
  platformRunner: PlatformRunner,
): StripeApiCallAuditStore {
  const A = schema.stripeApiCallAudit;
  return {
    async hasSucceededForIdempotencyKey(idempotencyKey) {
      return platformRunner(async (tx) => {
        const rows = await tx
          .select({ id: A.id })
          .from(A)
          .where(
            and(
              eq(A.stripeIdempotencyKey, idempotencyKey),
              gte(A.responseStatusCode, 200),
              lt(A.responseStatusCode, 300),
            ),
          )
          .limit(1);
        return rows.length > 0;
      });
    },
    async insertCall(input) {
      return platformRunner(async (tx) => {
        const inserted = await tx
          .insert(A)
          .values({
            stripeIdempotencyKey: input.stripeIdempotencyKey,
            operation: input.operation,
            targetResourceId: input.targetResourceId,
            organizationId: input.organizationId,
            requestEnvelopeRedacted: input.requestEnvelopeRedacted,
            attemptIndex: input.attemptIndex,
          })
          .onConflictDoNothing({ target: A.stripeIdempotencyKey })
          .returning({ id: A.id });
        const row =
          inserted[0] ??
          (
            await tx
              .select({ id: A.id })
              .from(A)
              .where(eq(A.stripeIdempotencyKey, input.stripeIdempotencyKey))
              .limit(1)
          )[0];
        if (!row) throw new Error("stripe_api_call_audit insert returned no row");
        return { auditId: row.id as StripeApiCallAuditId };
      });
    },
    async recordSuccess(input) {
      await platformRunner((tx) =>
        tx
          .update(A)
          .set({
            responseStatusCode: input.responseStatusCode,
            responseEnvelopeRedacted: input.responseEnvelopeRedacted,
            latencyMs: input.latencyMs,
            errorText: null,
          })
          .where(eq(A.id, input.auditId)),
      );
    },
    async recordFailure(input) {
      await platformRunner((tx) =>
        tx
          .update(A)
          .set({
            responseStatusCode: input.responseStatusCode,
            errorText: input.errorText,
            latencyMs: input.latencyMs,
          })
          .where(eq(A.id, input.auditId)),
      );
    },
  };
}

interface ApprovedRefund {
  readonly id: string;
  readonly organizationId: string;
  readonly amountCents: number;
  readonly stripeInvoiceId: string;
}

async function loadApproved(deps: RefundExecutorDeps): Promise<readonly ApprovedRefund[]> {
  const R = schema.refund;
  const INV = schema.invoice;
  return deps.platformRunner((tx) =>
    tx
      .select({
        id: R.id,
        organizationId: R.organizationId,
        amountCents: R.amountCents,
        stripeInvoiceId: INV.stripeInvoiceId,
      })
      .from(R)
      .innerJoin(INV, eq(INV.id, R.invoiceId))
      .where(eq(R.status, "approved"))
      .orderBy(asc(R.approvedAt))
      .limit(REFUND_SWEEP_LIMIT),
  );
}

/** Attempts already made for this refund = audit rows under its key prefix. */
async function nextAttemptIndex(deps: RefundExecutorDeps, refundId: string): Promise<number> {
  const A = schema.stripeApiCallAudit;
  const rows = await deps.platformRunner((tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(A)
      .where(like(A.stripeIdempotencyKey, `stripe-idem-${REFUND_OPERATION}-${refundId}-%`)),
  );
  return Number(rows[0]?.n ?? 0);
}

async function emitRefundEvent(
  deps: RefundExecutorDeps,
  tx: unknown,
  eventName: "m35.refund.executed" | "m35.refund.failed",
  refund: ApprovedRefund,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!deps.outbox) return;
  await deps.outbox.publish(tx, {
    eventName,
    payload,
    organizationId: refund.organizationId,
    aggregateKind: "refund",
    aggregateId: refund.id,
  });
}

async function markExecuted(
  deps: RefundExecutorDeps,
  refund: ApprovedRefund,
  stripeRefundId: string,
): Promise<boolean> {
  const at = (deps.now ?? (() => new Date()))();
  return deps.platformRunner(async (tx) => {
    const done = await tx
      .update(schema.refund)
      .set({ status: "executed_success", stripeRefundId, executedAt: at })
      .where(and(eq(schema.refund.id, refund.id), eq(schema.refund.status, "approved")))
      .returning({ id: schema.refund.id });
    if (done.length === 0) return false;
    await emitRefundEvent(deps, tx, "m35.refund.executed", refund, {
      refundId: refund.id,
      organizationId: refund.organizationId,
      executedAt: at.toISOString(),
      amountCents: refund.amountCents,
      stripeRefundId,
    });
    return true;
  });
}

async function markFailed(
  deps: RefundExecutorDeps,
  refund: ApprovedRefund,
  failureCode: string,
): Promise<boolean> {
  const at = (deps.now ?? (() => new Date()))();
  return deps.platformRunner(async (tx) => {
    const done = await tx
      .update(schema.refund)
      .set({ status: "executed_failed", stripeFailureCode: failureCode })
      .where(and(eq(schema.refund.id, refund.id), eq(schema.refund.status, "approved")))
      .returning({ id: schema.refund.id });
    if (done.length === 0) return false;
    await emitRefundEvent(deps, tx, "m35.refund.failed", refund, {
      refundId: refund.id,
      organizationId: refund.organizationId,
      failedAt: at.toISOString(),
      stripeFailureCode: failureCode,
    });
    return true;
  });
}

/** The audited 2xx response for a refund whose Stripe call already succeeded (mirror write was lost). */
async function recoverSucceededRefundId(
  deps: RefundExecutorDeps,
  refundId: string,
): Promise<string | null> {
  const A = schema.stripeApiCallAudit;
  const rows = await deps.platformRunner((tx) =>
    tx
      .select({ response: A.responseEnvelopeRedacted })
      .from(A)
      .where(
        and(
          like(A.stripeIdempotencyKey, `stripe-idem-${REFUND_OPERATION}-${refundId}-%`),
          gte(A.responseStatusCode, 200),
          lt(A.responseStatusCode, 300),
        ),
      )
      .limit(1),
  );
  const id = (rows[0]?.response as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** One sweep: execute every approved refund through the dispatcher. Never throws for one refund's failure. */
export async function runRefundExecutionSweep(
  deps: RefundExecutorDeps,
): Promise<RefundSweepResult> {
  const approved = await loadApproved(deps);
  let executed = 0;
  let failed = 0;
  let retryLater = 0;

  for (const refund of approved) {
    const attemptIndex = await nextAttemptIndex(deps, refund.id);
    const mirror: StripeMirrorApplier = {
      async apply(_event: StripeDispatchEvent, response: StripeApiResponse) {
        const stripeRefundId = response.body.id;
        if (typeof stripeRefundId !== "string" || stripeRefundId.length === 0) {
          throw new Error("Stripe refund response carried no id");
        }
        if (await markExecuted(deps, refund, stripeRefundId)) executed += 1;
      },
    };
    const event: StripeDispatchEvent = {
      operation: REFUND_OPERATION,
      businessKey: refund.id,
      targetResourceId: refund.stripeInvoiceId,
      organizationId: refund.organizationId as OrgId,
      payload: {
        stripeInvoiceId: refund.stripeInvoiceId,
        amountCents: refund.amountCents,
        refundId: refund.id,
      },
      attemptIndex,
    };
    try {
      const outcome = await dispatchStripeCall(
        {
          client: deps.client,
          auditStore: createDrizzleStripeAuditStore(deps.platformRunner),
          mirror,
          nowMs: () => (deps.now ?? (() => new Date()))().getTime(),
        },
        event,
      );
      if (outcome.kind === "noop") {
        const stripeRefundId = await recoverSucceededRefundId(deps, refund.id);
        if (stripeRefundId && (await markExecuted(deps, refund, stripeRefundId))) executed += 1;
      } else if (outcome.kind === "failed_permanent") {
        const code = outcome.outbox
          .map((o) => (o.payload as { errorText?: string }).errorText)
          .find((t) => typeof t === "string");
        if (await markFailed(deps, refund, (code ?? "stripe_error").slice(0, 200))) failed += 1;
      }
    } catch (err) {
      // Retryable transient failure (below STRIPE_MAX_ATTEMPTS) or a mirror-write failure: leave `approved`.
      retryLater += 1;
      deps.log?.("refund execution deferred", {
        refundId: refund.id,
        attemptIndex,
        maxAttempts: STRIPE_MAX_ATTEMPTS,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { considered: approved.length, executed, failed, retryLater };
}

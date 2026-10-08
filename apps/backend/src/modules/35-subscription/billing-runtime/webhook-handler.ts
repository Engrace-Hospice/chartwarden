// apps/backend/src/modules/35-subscription/billing-runtime/webhook-handler.ts - GAP-058 / GAP-059.
//
// The `stripe-webhook-handler` half of §4.14: drains the `stripe_webhook_event` rows the ingest route stored
// (`processed_at IS NULL`), decrypts each payload, and applies the invoice lifecycle that drives billing state:
//
//   invoice.payment_failed          -> mirror the invoice, open dunning (none -> day_1), subscription -> past_due
//   invoice.paid / payment_succeeded -> mirror the invoice, resolve dunning, subscription back to active
//   invoice.voided / uncollectible   -> mirror the invoice
//   anything else                    -> recorded as processed (no M35 state depends on it yet)
//
// Without this, nothing ever put a subscription into `past_due`, so the dunning engine had no rows to walk.
// The tenant is derived SERVER-SIDE from the Stripe customer id (`subscription.stripe_customer_id`), never from
// the payload's own claims. A poison event (5 failed attempts) stays unprocessed with its error text.
import { type DbClient, schema } from "@wardenx/db";
import {
  DunningStateMachineService,
  InvoiceMirrorService,
  SubscriptionLifecycleService,
  canTransitionSubscription,
} from "@wardenx/subscription-billing";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  InvoiceLineKind,
  InvoiceStatus,
  OrgId,
  SubscriptionId,
  SubscriptionStatus,
} from "@wardenx/types";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  createDrizzleDunningStore,
  createDrizzleInvoiceStore,
  createDrizzleSubscriptionStore,
} from "./drizzle-stores";
import type { M35JobDeps } from "./jobs";
import type { WebhookPayloadCipher } from "./webhook-payload-crypto";

const MAX_PROCESSING_ATTEMPTS = 5;
const SWEEP_BATCH = 50;
const SECONDS = 1000;

type Tx = DbClient;
type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
const at = (v: unknown): Date | null =>
  typeof v === "number" && v > 0 ? new Date(v * SECONDS) : null;

/** The invoice statuses this handler mirrors, keyed by Stripe event type. */
const INVOICE_EVENT_STATUS: Readonly<Record<string, InvoiceStatus>> = {
  "invoice.payment_failed": "open",
  "invoice.paid": "paid",
  "invoice.payment_succeeded": "paid",
  "invoice.voided": "void",
  "invoice.marked_uncollectible": "uncollectible",
};

/** Map one Stripe invoice object's lines onto M35 line inputs (+ a synthetic tax line so the sums reconcile). */
export function invoiceLinesOf(invoice: Json): Array<{
  stripeLineId: string;
  kind: InvoiceLineKind;
  description: string;
  quantity: number;
  unitAmountCents: number;
  totalCents: number;
}> {
  const data = obj(invoice.lines).data;
  const lines = (Array.isArray(data) ? data : []).map((raw, i) => {
    const l = obj(raw);
    const total = int(l.amount);
    return {
      stripeLineId: str(l.id) ?? `${str(invoice.id) ?? "inv"}-line-${i}`,
      kind: (l.proration === true ? "proration" : "subscription") as InvoiceLineKind,
      description: str(l.description) ?? "",
      quantity: Math.max(1, int(l.quantity)),
      unitAmountCents: total,
      totalCents: total,
    };
  });
  const tax = int(invoice.tax);
  if (tax > 0) {
    lines.push({
      stripeLineId: `${str(invoice.id) ?? "inv"}-tax`,
      kind: "tax",
      description: "Tax",
      quantity: 1,
      unitAmountCents: tax,
      totalCents: tax,
    });
  }
  return lines;
}

async function moveSubscription(
  deps: M35JobDeps,
  tx: Tx,
  subscriptionId: string,
  organizationId: string,
  to: SubscriptionStatus,
  reasonCode: string,
  stripeEventId: string,
  now: Date,
): Promise<void> {
  const store = createDrizzleSubscriptionStore(tx);
  const current = await store.loadForUpdate(subscriptionId);
  if (!current || current.status === to || !canTransitionSubscription(current.status, to)) return;
  const result = await new SubscriptionLifecycleService(store).transition({
    subscriptionId,
    toStatus: to,
    actorMembershipId: null,
    reasonCode,
    stripeEventId,
    now,
  });
  for (const intent of result.outbox) {
    await deps.outbox.publish(tx, {
      eventName: intent.eventName,
      payload: intent.payload as unknown as Record<string, unknown>,
      organizationId,
      aggregateKind: intent.eventName.split(".")[1] ?? "subscription",
      aggregateId: subscriptionId,
    });
  }
}

async function publishAll(
  deps: M35JobDeps,
  tx: Tx,
  intents: ReadonlyArray<{ eventName: string; payload: unknown }>,
  organizationId: string,
  aggregateId: string,
): Promise<void> {
  for (const intent of intents) {
    await deps.outbox.publish(tx, {
      eventName: intent.eventName,
      payload: intent.payload as Record<string, unknown>,
      organizationId,
      aggregateKind: intent.eventName.split(".")[1] ?? "invoice",
      aggregateId,
    });
  }
}

/** Apply one verified invoice event inside the owning org's RLS scope. */
async function applyInvoiceEvent(
  deps: M35JobDeps,
  organizationId: string,
  subscriptionId: string,
  event: { id: string; type: string; invoice: Json },
  now: Date,
): Promise<void> {
  const status = INVOICE_EVENT_STATUS[event.type];
  if (!status) return;
  const inv = event.invoice;
  await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as Tx;
    const failed = event.type === "invoice.payment_failed";
    const mirrored = await new InvoiceMirrorService(
      createDrizzleInvoiceStore(tx),
    ).applyStripeInvoiceEvent({
      organizationId: organizationId as OrgId,
      stripeInvoiceId: str(inv.id) ?? event.id,
      toStatus: status,
      subtotalCents: int(inv.subtotal),
      taxCents: int(inv.tax),
      totalCents: int(inv.total),
      amountPaidCents: int(inv.amount_paid),
      periodStart: at(inv.period_start),
      periodEnd: at(inv.period_end),
      paidAt: status === "paid" ? (at(obj(inv.status_transitions).paid_at) ?? now) : null,
      lines: invoiceLinesOf(inv),
      ...(failed
        ? {
            failure: {
              code: str(obj(inv.last_finalization_error).code) ?? "payment_failed",
              attemptCount: Math.max(1, int(inv.attempt_count)),
              nextAttemptAt: at(inv.next_payment_attempt),
            },
          }
        : {}),
      now,
    });
    await publishAll(deps, tx, mirrored.outbox, organizationId, mirrored.invoiceId);

    const dunning = new DunningStateMachineService(createDrizzleDunningStore(tx));
    if (failed) {
      const entered = await dunning.onPaymentFailed({
        subscriptionId: subscriptionId as SubscriptionId,
        organizationId: organizationId as OrgId,
        triggerInvoiceId: mirrored.invoiceId,
        failureCode: str(obj(inv.last_finalization_error).code) ?? "payment_failed",
        now,
      });
      await publishAll(deps, tx, entered.outbox, organizationId, subscriptionId);
      await moveSubscription(
        deps,
        tx,
        subscriptionId,
        organizationId,
        "past_due",
        "invoice_payment_failed",
        event.id,
        now,
      );
    } else if (status === "paid") {
      const resolved = await dunning.resolve({
        subscriptionId: subscriptionId as SubscriptionId,
        now,
      });
      await publishAll(deps, tx, resolved.outbox, organizationId, subscriptionId);
      await moveSubscription(
        deps,
        tx,
        subscriptionId,
        organizationId,
        "active",
        "invoice_paid",
        event.id,
        now,
      );
    }
  });
}

export interface WebhookSweepResult {
  readonly processed: number;
  readonly ignored: number;
  readonly failed: number;
}

/** One sweep over the unprocessed `stripe_webhook_event` rows. Never throws for one event's failure. */
export async function runWebhookHandlerSweep(
  deps: M35JobDeps & { readonly cipher: WebhookPayloadCipher },
): Promise<WebhookSweepResult> {
  const WH = schema.stripeWebhookEvent;
  const now = (deps.now ?? (() => new Date()))();
  const pending = await deps.platformRunner((tx) =>
    tx
      .select()
      .from(WH)
      .where(and(isNull(WH.processedAt), lt(WH.processingAttemptCount, MAX_PROCESSING_ATTEMPTS)))
      .orderBy(asc(WH.receivedAt))
      .limit(SWEEP_BATCH),
  );
  let processed = 0;
  let ignored = 0;
  let failed = 0;
  for (const row of pending) {
    try {
      if (!INVOICE_EVENT_STATUS[row.eventType]) {
        ignored += 1;
      } else {
        const event = JSON.parse(deps.cipher.decrypt(row.payloadCiphertext)) as Json;
        const invoice = obj(obj(event.data).object);
        const customer = str(invoice.customer);
        const owner = customer
          ? await deps.platformRunner((tx) =>
              tx
                .select({
                  organizationId: schema.subscriptionRow.organizationId,
                  subscriptionId: schema.subscriptionRow.id,
                })
                .from(schema.subscriptionRow)
                .where(eq(schema.subscriptionRow.stripeCustomerId, customer))
                .limit(1),
            )
          : [];
        const target = owner[0];
        if (!target)
          throw new Error("webhook references a Stripe customer M35 has no subscription for");
        await applyInvoiceEvent(
          deps,
          target.organizationId,
          target.subscriptionId,
          { id: row.id, type: row.eventType, invoice },
          now,
        );
        processed += 1;
      }
      await deps.platformRunner((tx) =>
        tx
          .update(WH)
          .set({
            processedAt: now,
            processingAttemptCount: sql`${WH.processingAttemptCount} + 1`,
            errorText: null,
          })
          .where(eq(WH.id, row.id)),
      );
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      deps.log?.("stripe webhook handling failed", {
        eventId: row.id,
        eventType: row.eventType,
        error: message,
      });
      await deps.platformRunner((tx) =>
        tx
          .update(WH)
          .set({
            processingAttemptCount: sql`${WH.processingAttemptCount} + 1`,
            errorText: message.slice(0, 500),
          })
          .where(eq(WH.id, row.id)),
      );
    }
  }
  return { processed, ignored, failed };
}

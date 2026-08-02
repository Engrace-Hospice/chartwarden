// @wardenx/subscription-billing — §2.2 invoice mirror service (pure over ports, M35-T03).
//
// M35 NEVER authors invoices — Stripe does. This service mirrors the Stripe invoice lifecycle a webhook
// delivers (`invoice.created → draft`, `invoice.finalized → open`, `invoice.paid → paid`, `payment_failed`,
// `voided`, `marked_uncollectible`) into the `invoice` + `invoice_line` tables. The pure `canTransitionInvoice`
// guard (`../domain/invoice-lifecycle`) is defence-in-depth against an out-of-order or spoofed Stripe event
// on top of Stripe's own state. The §2.3 penny-exact invariants (`invoiceTotalsConsistent` /
// `invoiceLineSumsConsistent`) are asserted here — the totals CHECK is a DB constraint, but the LINE-sum
// equality cannot be (lines arrive across multiple webhook events), so the reconciler asserts it when the
// invoice reaches `open`.
//
// PURE: the store owns the RLS session + the actual Drizzle upsert; T06 supplies it and publishes the
// returned {@link OutboxIntent}s. NOTHING here verifies the Stripe signature (that is the T06 webhook
// route) or calls the Stripe API (that is the T04 dispatcher).

import type { InvoiceStatus, IsoInstant, MembershipId, OrgId } from "@wardenx/types";
import { canTransitionInvoice } from "../domain/invoice-lifecycle";
import { invoiceLineSumsConsistent, invoiceTotalsConsistent } from "../domain/validation";
import {
  outboxIntent,
  type InvoiceLineMirrorInput,
  type InvoiceStore,
  type OutboxIntent,
} from "./ports";

export class InvoiceMirrorError extends Error {
  constructor(
    readonly code: "illegal_transition" | "totals_inconsistent" | "line_sums_inconsistent",
    message: string,
  ) {
    super(message);
    this.name = "InvoiceMirrorError";
  }
}

export interface ApplyStripeInvoiceEventInput {
  readonly organizationId: OrgId;
  readonly stripeInvoiceId: string;
  readonly toStatus: InvoiceStatus;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly paidAt: Date | null;
  readonly lines: readonly InvoiceLineMirrorInput[];
  /** Set on an `invoice.payment_failed` mirror (drives `m35.invoice.payment_failed`). */
  readonly failure?: { readonly code: string; readonly attemptCount: number; readonly nextAttemptAt: Date | null };
  /** Set on a `void` mirror when a human voided it. */
  readonly voidedByMembershipId?: MembershipId | null;
  readonly now: Date;
}

export interface ApplyStripeInvoiceEventResult {
  readonly invoiceId: string;
  readonly from: InvoiceStatus | null;
  readonly to: InvoiceStatus;
  readonly outbox: OutboxIntent[];
}

export class InvoiceMirrorService {
  constructor(private readonly store: InvoiceStore) {}

  async applyStripeInvoiceEvent(
    input: ApplyStripeInvoiceEventInput,
  ): Promise<ApplyStripeInvoiceEventResult> {
    // §2.3 totals CHECK (always enforced, on every mirror write).
    if (
      !invoiceTotalsConsistent({
        totalCents: input.totalCents,
        subtotalCents: input.subtotalCents,
        taxCents: input.taxCents,
      })
    ) {
      throw new InvoiceMirrorError(
        "totals_inconsistent",
        `invoice ${input.stripeInvoiceId}: total ${input.totalCents} != subtotal ${input.subtotalCents} + tax ${input.taxCents}`,
      );
    }

    const existing = await this.store.invoiceByStripeId(input.stripeInvoiceId);
    const from = existing?.status ?? null;
    if (from !== null && from !== input.toStatus && !canTransitionInvoice(from, input.toStatus)) {
      throw new InvoiceMirrorError(
        "illegal_transition",
        `illegal invoice transition ${from} → ${input.toStatus} for ${input.stripeInvoiceId}`,
      );
    }

    // §2.3 reconciler invariant: assert the line sums when the invoice reaches `open` (lines are complete).
    if (input.toStatus === "open") {
      if (
        !invoiceLineSumsConsistent({
          lines: input.lines,
          subtotalCents: input.subtotalCents,
          taxCents: input.taxCents,
        })
      ) {
        throw new InvoiceMirrorError(
          "line_sums_inconsistent",
          `invoice ${input.stripeInvoiceId}: line sums do not reconcile against subtotal/tax`,
        );
      }
    }

    const invoice = await this.store.upsertInvoice({
      organizationId: input.organizationId,
      stripeInvoiceId: input.stripeInvoiceId,
      status: input.toStatus,
      subtotalCents: input.subtotalCents,
      taxCents: input.taxCents,
      totalCents: input.totalCents,
      amountPaidCents: input.amountPaidCents,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      paidAt: input.paidAt,
    });
    await this.store.replaceInvoiceLines({ invoiceId: invoice.id, lines: input.lines });

    return {
      invoiceId: invoice.id,
      from,
      to: input.toStatus,
      outbox: buildInvoiceOutbox(invoice.id, from, input),
    };
  }
}

/** §2.4 the invoice status → outbox mapping (pure; the webhook handler reuses it). */
export function buildInvoiceOutbox(
  invoiceId: string,
  from: InvoiceStatus | null,
  input: ApplyStripeInvoiceEventInput,
): OutboxIntent[] {
  const iso = input.now.toISOString() as IsoInstant;
  const orgId = input.organizationId;
  const out: OutboxIntent[] = [];

  // `created` fires once, when the mirror row first appears (no prior status).
  if (from === null && input.toStatus === "draft") {
    out.push(
      outboxIntent("m35.invoice.created", {
        invoiceId,
        organizationId: orgId,
        stripeInvoiceId: input.stripeInvoiceId,
        totalCents: input.totalCents,
        periodStart: input.periodStart ? (input.periodStart.toISOString() as IsoInstant) : null,
        periodEnd: input.periodEnd ? (input.periodEnd.toISOString() as IsoInstant) : null,
      }),
    );
  }

  switch (input.toStatus) {
    case "paid":
      if (from !== "paid") {
        out.push(
          outboxIntent("m35.invoice.paid", {
            invoiceId,
            organizationId: orgId,
            paidAt: (input.paidAt ?? input.now).toISOString() as IsoInstant,
            amountPaidCents: input.amountPaidCents,
          }),
        );
      }
      break;
    case "void":
      if (from !== "void") {
        out.push(
          outboxIntent("m35.invoice.voided", {
            invoiceId,
            organizationId: orgId,
            voidedAt: iso,
            voidedByMembershipId: input.voidedByMembershipId ?? null,
          }),
        );
      }
      break;
    case "uncollectible":
      if (from !== "uncollectible") {
        out.push(
          outboxIntent("m35.invoice.uncollectible", {
            invoiceId,
            organizationId: orgId,
            markedAt: iso,
          }),
        );
      }
      break;
    default:
      break;
  }

  // A payment failure is signalled out-of-band from the status (the invoice may stay `open`).
  if (input.failure) {
    out.push(
      outboxIntent("m35.invoice.payment_failed", {
        invoiceId,
        organizationId: orgId,
        failureCode: input.failure.code,
        attemptCount: input.failure.attemptCount,
        nextAttemptAt: input.failure.nextAttemptAt
          ? (input.failure.nextAttemptAt.toISOString() as IsoInstant)
          : null,
      }),
    );
  }

  return out;
}

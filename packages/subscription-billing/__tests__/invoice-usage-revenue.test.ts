// M35-T03 — invoice mirror + usage metering + revenue recognition (pure cores + in-memory stores).
import { describe, expect, it } from "vitest";
import { InvoiceMirrorError, InvoiceMirrorService } from "../src/service/invoice-service";
import {
  UsageMeteringService,
  buildUsageOverageOutbox,
  computeMeterAggregate,
  toBillingYearMonth,
} from "../src/service/usage-metering-service";
import {
  RevenueRecognitionService,
  computeRevenueSnapshot,
  normalizeMonthlyCents,
  priorBillingYearMonth,
} from "../src/service/revenue-recognition-service";
import type {
  ActivePeriodStore,
  InvoiceLineMirrorInput,
  InvoiceMirrorRecord,
  InvoiceStore,
  PseudonymKeyProvider,
  RevenueContribution,
  RevenueStore,
  UsageEventStore,
} from "../src/service/ports";

const NOW = new Date("2026-08-02T00:00:00.000Z");

// ── invoice mirror ──────────────────────────────────────────────────────────────────────────────────
class FakeInvoiceStore implements InvoiceStore {
  invoices = new Map<string, InvoiceMirrorRecord>();
  lines = new Map<string, readonly InvoiceLineMirrorInput[]>();
  seq = 0;
  async invoiceByStripeId(stripeInvoiceId: string) {
    for (const inv of this.invoices.values()) if (inv.stripeInvoiceId === stripeInvoiceId) return inv;
    return null;
  }
  async upsertInvoice(input: Parameters<InvoiceStore["upsertInvoice"]>[0]) {
    const existing = await this.invoiceByStripeId(input.stripeInvoiceId);
    const id = existing?.id ?? `inv-${++this.seq}`;
    const rec: InvoiceMirrorRecord = {
      id,
      organizationId: input.organizationId,
      stripeInvoiceId: input.stripeInvoiceId,
      status: input.status,
      subtotalCents: input.subtotalCents,
      taxCents: input.taxCents,
      totalCents: input.totalCents,
      amountPaidCents: input.amountPaidCents,
    };
    this.invoices.set(id, rec);
    return rec;
  }
  async replaceInvoiceLines(input: { invoiceId: string; lines: readonly InvoiceLineMirrorInput[] }) {
    this.lines.set(input.invoiceId, input.lines);
  }
}

describe("InvoiceMirrorService", () => {
  const line = (kind: InvoiceLineMirrorInput["kind"], total: number): InvoiceLineMirrorInput => ({
    stripeLineId: `il_${kind}_${total}`,
    kind,
    description: kind,
    quantity: 1,
    unitAmountCents: total,
    totalCents: total,
  });

  it("mirrors a draft invoice and emits m35.invoice.created", async () => {
    const store = new FakeInvoiceStore();
    const svc = new InvoiceMirrorService(store);
    const res = await svc.applyStripeInvoiceEvent({
      organizationId: "org-1", stripeInvoiceId: "in_1", toStatus: "draft",
      subtotalCents: 50000, taxCents: 4000, totalCents: 54000, amountPaidCents: 0,
      periodStart: NOW, periodEnd: NOW, paidAt: null, lines: [line("subscription", 50000), line("tax", 4000)], now: NOW,
    });
    expect(res.outbox.map((o) => o.eventName)).toEqual(["m35.invoice.created"]);
    expect(res.to).toBe("draft");
  });

  it("rejects inconsistent totals (§2.3)", async () => {
    const svc = new InvoiceMirrorService(new FakeInvoiceStore());
    await expect(
      svc.applyStripeInvoiceEvent({
        organizationId: "org-1", stripeInvoiceId: "in_2", toStatus: "draft",
        subtotalCents: 50000, taxCents: 4000, totalCents: 99999, amountPaidCents: 0,
        periodStart: null, periodEnd: null, paidAt: null, lines: [], now: NOW,
      }),
    ).rejects.toMatchObject({ code: "totals_inconsistent" });
  });

  it("asserts line-sum reconciliation when the invoice reaches open", async () => {
    const store = new FakeInvoiceStore();
    const svc = new InvoiceMirrorService(store);
    await expect(
      svc.applyStripeInvoiceEvent({
        organizationId: "org-1", stripeInvoiceId: "in_3", toStatus: "open",
        subtotalCents: 50000, taxCents: 4000, totalCents: 54000, amountPaidCents: 0,
        periodStart: null, periodEnd: null, paidAt: null,
        lines: [line("subscription", 40000), line("tax", 4000)], now: NOW, // subtotal lines sum to 40000 ≠ 50000
      }),
    ).rejects.toBeInstanceOf(InvoiceMirrorError);
  });

  it("rejects an out-of-order transition (paid → draft)", async () => {
    const store = new FakeInvoiceStore();
    const svc = new InvoiceMirrorService(store);
    await svc.applyStripeInvoiceEvent({ organizationId: "org-1", stripeInvoiceId: "in_4", toStatus: "draft", subtotalCents: 0, taxCents: 0, totalCents: 0, amountPaidCents: 0, periodStart: null, periodEnd: null, paidAt: null, lines: [], now: NOW });
    await svc.applyStripeInvoiceEvent({ organizationId: "org-1", stripeInvoiceId: "in_4", toStatus: "open", subtotalCents: 0, taxCents: 0, totalCents: 0, amountPaidCents: 0, periodStart: null, periodEnd: null, paidAt: null, lines: [], now: NOW });
    await svc.applyStripeInvoiceEvent({ organizationId: "org-1", stripeInvoiceId: "in_4", toStatus: "paid", subtotalCents: 0, taxCents: 0, totalCents: 0, amountPaidCents: 0, periodStart: null, periodEnd: null, paidAt: NOW, lines: [], now: NOW });
    await expect(
      svc.applyStripeInvoiceEvent({ organizationId: "org-1", stripeInvoiceId: "in_4", toStatus: "draft", subtotalCents: 0, taxCents: 0, totalCents: 0, amountPaidCents: 0, periodStart: null, periodEnd: null, paidAt: null, lines: [], now: NOW }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });
});

// ── usage metering ──────────────────────────────────────────────────────────────────────────────────
class FakeUsageStore implements UsageEventStore {
  seen = new Set<string>();
  inserted: unknown[] = [];
  async usageEventExists(input: { organizationId: string; sourceModule: string; sourceEventId: string }) {
    return this.seen.has(`${input.organizationId}|${input.sourceModule}|${input.sourceEventId}`);
  }
  async insertUsageEvent(input: Parameters<UsageEventStore["insertUsageEvent"]>[0]) {
    if (input.sourceEventId) this.seen.add(`${input.organizationId}|${input.sourceModule}|${input.sourceEventId}`);
    this.inserted.push(input);
  }
}
class FakeActivePeriodStore implements ActivePeriodStore {
  patients = new Set<string>();
  users = new Set<string>();
  async upsertPatientActivePeriod(input: Parameters<ActivePeriodStore["upsertPatientActivePeriod"]>[0]) {
    const k = `${input.organizationId}|${input.patientPseudonym}|${input.periodYearMonth}`;
    const inserted = !this.patients.has(k);
    this.patients.add(k);
    return { inserted };
  }
  async upsertUserActivePeriod(input: Parameters<ActivePeriodStore["upsertUserActivePeriod"]>[0]) {
    const k = `${input.organizationId}|${input.membershipPseudonym}|${input.periodYearMonth}`;
    const inserted = !this.users.has(k);
    this.users.add(k);
    return { inserted };
  }
}
const keyProvider: PseudonymKeyProvider = { async activeKey() { return { keyEpoch: "epoch-2026-08", keyMaterial: "secret" }; } };

describe("UsageMeteringService", () => {
  it("dedups a re-delivered event on (org, sourceModule, sourceEventId)", async () => {
    const usage = new FakeUsageStore();
    const svc = new UsageMeteringService(usage, new FakeActivePeriodStore(), keyProvider);
    const ev = { organizationId: "org-1", eventType: "fhir_egress_request" as const, quantity: 5, sourceModule: "m28" as const, sourceEventId: "e1" };
    expect((await svc.ingest(ev, NOW)).accepted).toBe(true);
    expect((await svc.ingest(ev, NOW)).deduped).toBe(true);
    expect(usage.inserted).toHaveLength(1);
  });

  it("rejects a non-positive quantity", async () => {
    const svc = new UsageMeteringService(new FakeUsageStore(), new FakeActivePeriodStore(), keyProvider);
    const r = await svc.ingest({ organizationId: "org-1", eventType: "active_user", quantity: 0, sourceModule: "m2" }, NOW);
    expect(r.accepted).toBe(false);
  });

  it("pseudonymizes a raw patient id idempotently within a period", async () => {
    const store = new FakeActivePeriodStore();
    const svc = new UsageMeteringService(new FakeUsageStore(), store, keyProvider);
    const first = await svc.recordPatientActive({ organizationId: "org-1", rawPatientId: "a1b2c3d4-0000-0000-0000-000000000001", now: NOW });
    const second = await svc.recordPatientActive({ organizationId: "org-1", rawPatientId: "a1b2c3d4-0000-0000-0000-000000000001", now: NOW });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect([...store.patients][0]).toMatch(/\|[a-f0-9]{32}\|2026-08$/);
  });
});

describe("computeMeterAggregate + overage outbox", () => {
  it("computes overage cents with integer math", () => {
    const agg = computeMeterAggregate({ totalQuantity: 12000, inclusiveQuantity: 10000, overageUnitPriceCents: 3 });
    expect(agg.overageQuantity).toBe(2000);
    expect(agg.overageCents).toBe(6000);
    expect(agg.crossed100).toBe(true);
  });
  it("flags an 80% warning below 100%", () => {
    const agg = computeMeterAggregate({ totalQuantity: 8500, inclusiveQuantity: 10000, overageUnitPriceCents: 3 });
    expect(agg.crossed80).toBe(true);
    expect(agg.crossed100).toBe(false);
    const out = buildUsageOverageOutbox({ subscriptionId: "sub-1", organizationId: "org-1", eventType: "fhir_egress_request", aggregate: agg });
    expect(out.map((o) => o.eventName)).toEqual(["m35.usage.overage_threshold_warning"]);
  });
  it("emits breached at/over 100%", () => {
    const agg = computeMeterAggregate({ totalQuantity: 10000, inclusiveQuantity: 10000, overageUnitPriceCents: 3 });
    const out = buildUsageOverageOutbox({ subscriptionId: "sub-1", organizationId: "org-1", eventType: "fhir_egress_request", aggregate: agg });
    expect(out.map((o) => o.eventName)).toEqual(["m35.usage.overage_threshold_breached"]);
  });
  it("buckets a UTC date to YYYY-MM", () => {
    expect(toBillingYearMonth(new Date("2026-01-15T23:00:00Z"))).toBe("2026-01");
  });
});

// ── revenue recognition ─────────────────────────────────────────────────────────────────────────────
describe("revenue recognition (D18)", () => {
  it("normalizes annual base price to monthly", () => {
    expect(normalizeMonthlyCents("monthly", 50000)).toBe(50000);
    expect(normalizeMonthlyCents("annual", 600000)).toBe(50000);
  });

  it("computes MRR/ARR and the new/expansion/contraction/churn movement", () => {
    const contributions: RevenueContribution[] = [
      { subscriptionId: "a", status: "active", monthlyCents: 50000 }, // was 40000 → expansion 10000
      { subscriptionId: "b", status: "active", monthlyCents: 30000 }, // new (absent prior)
      { subscriptionId: "c", status: "canceled", monthlyCents: 0 }, // churn (was 20000)
      { subscriptionId: "d", status: "trialing", monthlyCents: 50000 }, // trialing → 0 MRR, counted trialing
    ];
    const prior = new Map<string, number>([["a", 40000], ["c", 20000]]);
    const snap = computeRevenueSnapshot({ snapshotMonth: "2026-08", contributions, priorContributions: prior });
    expect(snap.mrrCents).toBe(80000); // a 50000 + b 30000
    expect(snap.arrCents).toBe(960000);
    expect(snap.newMrrCents).toBe(30000);
    expect(snap.expansionMrrCents).toBe(10000);
    expect(snap.churnMrrCents).toBe(20000);
    expect(snap.activeSubscriptions).toBe(2);
    expect(snap.trialingSubscriptions).toBe(1);
  });

  it("computes the prior calendar month across a year boundary", () => {
    expect(priorBillingYearMonth("2026-01")).toBe("2025-12");
    expect(priorBillingYearMonth("2026-08")).toBe("2026-07");
  });

  it("persists a snapshot and emits the platform-wide outbox event", async () => {
    const store: RevenueStore = {
      async currentContributions() { return [{ subscriptionId: "a", status: "active", monthlyCents: 50000 }]; },
      async priorMonthContributions() { return new Map(); },
      async insertSnapshot(input) { return { id: "snap-1", snapshotMonth: input.snapshotMonth, mrrCents: input.mrrCents, arrCents: input.arrCents, activeSubscriptions: input.activeSubscriptions, computedAt: input.computedAt }; },
    };
    const svc = new RevenueRecognitionService(store);
    const { snapshot, outbox } = await svc.computeAndStoreMonthlySnapshot({ snapshotMonth: "2026-08", now: NOW });
    expect(snapshot.mrrCents).toBe(50000);
    expect(outbox.map((o) => o.eventName)).toEqual(["m35.revenue.monthly_snapshot_computed"]);
  });
});

// apps/web/src/modules/35-subscription/billing-status.test.ts — the M35 tenant status→tone + money helpers.
//
// The pure presentation helpers live in billing-status.ts (they import only the `StatusTone` *type* from
// @wardenx/ui, erased at runtime), so this test is colocated in apps/web — a `packages/` test importing it
// would create a forbidden package→app dependency-cruiser edge (the M34 precedent). Proves the §6.6 badge
// taxonomy is applied once: every M35 wire enum resolves to the documented Lantern tone, the two §5.5
// assertive-alert dunning stages read `critical`, unknown values default to neutral, and money stays
// integer-cents until the single formatCents boundary.
import { describe, expect, it } from "vitest";
import {
  DUNNING_TONE,
  INVOICE_TONE,
  SUBSCRIPTION_TONE,
  USAGE_THRESHOLD_TONE,
  cap,
  dunningTone,
  formatCents,
  formatDate,
  invoiceTone,
  isCriticalDunningStage,
  statusLabel,
  subscriptionTone,
} from "./billing-status";

describe("M35 billing-status tone map (§5.1 / §6.6)", () => {
  it("maps the seven-state subscription lifecycle onto the Lantern StatusTone vocabulary", () => {
    expect(SUBSCRIPTION_TONE.trialing).toBe("progress");
    expect(SUBSCRIPTION_TONE.active).toBe("success");
    expect(SUBSCRIPTION_TONE.past_due).toBe("warning");
    expect(SUBSCRIPTION_TONE.at_risk).toBe("warning");
    expect(SUBSCRIPTION_TONE.suspended).toBe("error");
    expect(SUBSCRIPTION_TONE.canceled).toBe("neutral");
    expect(SUBSCRIPTION_TONE.paused).toBe("neutral");
    expect(Object.keys(SUBSCRIPTION_TONE)).toHaveLength(7);
  });

  it("reads the day_28_suspend + day_60_cancel dunning stages as critical (§5.5 assertive alerts)", () => {
    expect(DUNNING_TONE.none).toBe("neutral");
    expect(DUNNING_TONE.day_1).toBe("progress");
    expect(DUNNING_TONE.day_14).toBe("warning");
    expect(DUNNING_TONE.day_28_suspend).toBe("critical");
    expect(DUNNING_TONE.day_60_cancel).toBe("critical");
    expect(DUNNING_TONE.resolved).toBe("success");
    expect(Object.keys(DUNNING_TONE)).toHaveLength(8);
    expect(isCriticalDunningStage("day_28_suspend")).toBe(true);
    expect(isCriticalDunningStage("day_60_cancel")).toBe(true);
    expect(isCriticalDunningStage("day_7")).toBe(false);
  });

  it("maps invoice + usage-threshold enums onto tones (uncollectible/breached read as error)", () => {
    expect(INVOICE_TONE.open).toBe("progress");
    expect(INVOICE_TONE.paid).toBe("success");
    expect(INVOICE_TONE.void).toBe("neutral");
    expect(INVOICE_TONE.uncollectible).toBe("error");
    expect(USAGE_THRESHOLD_TONE.ok).toBe("success");
    expect(USAGE_THRESHOLD_TONE.warning).toBe("warning");
    expect(USAGE_THRESHOLD_TONE.breached).toBe("error");
  });

  it("resolver helpers default unknown values to neutral", () => {
    expect(subscriptionTone("active")).toBe("success");
    expect(subscriptionTone("not_a_real_status")).toBe("neutral");
    expect(dunningTone("day_28_suspend")).toBe("critical");
    expect(dunningTone("bogus")).toBe("neutral");
    expect(invoiceTone("paid")).toBe("success");
    expect(invoiceTone("bogus")).toBe("neutral");
  });

  it("statusLabel/cap title-cases underscore enum values", () => {
    expect(statusLabel("past_due")).toBe("Past Due");
    expect(cap("day_28_suspend")).toBe("Day 28 Suspend");
  });

  it("formatCents converts integer minor units to a localized currency string", () => {
    expect(formatCents(125_000)).toBe("$1,250.00");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(999, "USD")).toBe("$9.99");
    // Falls back to USD on an empty currency code rather than throwing.
    expect(formatCents(100, "")).toBe("$1.00");
  });

  it("formatDate renders an em dash for null/invalid instants", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
  });
});

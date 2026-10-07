// GAP-171 — the revocation-cascade arbiter + sweep planner (pure; the DB shells are covered live).
import { CASCADE_MAX_ATTEMPTS } from "@wardenx/consent";
import { describe, expect, it } from "vitest";
import {
  CASCADE_DEFERRED_CONSUMERS,
  CASCADE_LIVE_CONSUMERS,
  evaluateCascade,
} from "../src/modules/39-consent/cascade-ack";
import { planCascadeSweep } from "../src/modules/39-consent/jobs/cascade-retry";

/** The shape the store writes at revocation time: all four §2.2.3 consumers, none ACKed. */
const FRESH = { m31_portal: false, m36_messaging: false, m28_fhir: false, m22_documents: false };

describe("GAP-171 — cascade arbiter", () => {
  it("only counts consumers that have a live binding", () => {
    expect(CASCADE_LIVE_CONSUMERS).toEqual(["m31_portal"]);
    expect(Object.keys(CASCADE_DEFERRED_CONSUMERS).sort()).toEqual([
      "m22_documents",
      "m28_fhir",
      "m36_messaging",
    ]);
  });

  it("completes once the live consumer ACKs, even though deferred consumers never can", () => {
    const evaluation = evaluateCascade(
      { status: "pending", consumerJson: { ...FRESH, m31_portal: true } },
      0,
    );
    expect(evaluation.status).toBe("completed");
    expect(evaluation.pendingConsumers).toEqual([]);
  });

  it("stays in_progress while the live consumer has not ACKed and budget remains", () => {
    const evaluation = evaluateCascade({ status: "pending", consumerJson: FRESH }, 1);
    expect(evaluation.status).toBe("in_progress");
    expect(evaluation.pendingConsumers).toEqual(["m31_portal"]);
  });

  it("declares partial_failed naming the un-ACKed consumer when the budget is spent", () => {
    const evaluation = evaluateCascade(
      { status: "in_progress", consumerJson: FRESH },
      CASCADE_MAX_ATTEMPTS,
    );
    expect(evaluation.status).toBe("partial_failed");
    expect(evaluation.pendingConsumers).toEqual(["m31_portal"]);
  });

  it("a spent budget does not fail a cascade whose live consumer already ACKed", () => {
    const evaluation = evaluateCascade(
      { status: "in_progress", consumerJson: { ...FRESH, m31_portal: true } },
      CASCADE_MAX_ATTEMPTS,
    );
    expect(evaluation.status).toBe("completed");
  });

  it("never moves a terminal status", () => {
    expect(evaluateCascade({ status: "completed", consumerJson: FRESH }, 9).status).toBe(
      "completed",
    );
    expect(evaluateCascade({ status: "partial_failed", consumerJson: FRESH }, 0).status).toBe(
      "partial_failed",
    );
  });
});

describe("GAP-171 — sweep planner", () => {
  const base = { attempts: 1, pendingConsumers: ["m31_portal"], consumers: { m31_portal: false } };

  it("maps each verdict to exactly one action", () => {
    expect(planCascadeSweep({ ...base, status: "completed" })).toBe("complete");
    expect(planCascadeSweep({ ...base, status: "in_progress" })).toBe("retry");
    expect(planCascadeSweep({ ...base, status: "partial_failed" })).toBe("fail");
  });
});

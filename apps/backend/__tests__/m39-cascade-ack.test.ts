// GAP-171 — the revocation-cascade arbiter + sweep planner (pure; the DB shells are covered live).
import { CASCADE_MAX_ATTEMPTS } from "@chartwarden/consent";
import { describe, expect, it } from "vitest";
import {
  CASCADE_DEFERRED_CONSUMERS,
  CASCADE_LIVE_CONSUMERS,
  evaluateCascade,
} from "../src/modules/39-consent/cascade-ack";
import { planCascadeSweep } from "../src/modules/39-consent/jobs/cascade-retry";

/** The shape the store writes at revocation time: all four §2.2.3 consumers, none ACKed. */
const ALL_ACKED = { m31_portal: true, m36_messaging: true, m28_fhir: true, m22_documents: true };
const FRESH = { m31_portal: false, m36_messaging: false, m28_fhir: false, m22_documents: false };

describe("GAP-171 — cascade arbiter", () => {
  it("counts all four §2.2.3 consumers, each of which has a live binding", () => {
    expect([...CASCADE_LIVE_CONSUMERS].sort()).toEqual(
      ["m22_documents", "m28_fhir", "m31_portal", "m36_messaging"].sort(),
    );
    expect(Object.keys(CASCADE_DEFERRED_CONSUMERS)).toEqual([]);
  });

  it("completes only once EVERY consumer has ACKed", () => {
    const partial = evaluateCascade(
      { status: "pending", consumerJson: { ...FRESH, m31_portal: true, m22_documents: true } },
      0,
    );
    expect(partial.status).toBe("in_progress");
    expect([...partial.pendingConsumers].sort()).toEqual(["m28_fhir", "m36_messaging"]);
    const all = evaluateCascade(
      {
        status: "in_progress",
        consumerJson: {
          m31_portal: true,
          m36_messaging: true,
          m28_fhir: true,
          m22_documents: true,
        },
      },
      1,
    );
    expect(all.status).toBe("completed");
  });

  it("stays in_progress while the live consumer has not ACKed and budget remains", () => {
    const evaluation = evaluateCascade({ status: "pending", consumerJson: FRESH }, 1);
    expect(evaluation.status).toBe("in_progress");
    expect(evaluation.pendingConsumers).toHaveLength(4);
  });

  it("declares partial_failed naming the un-ACKed consumer when the budget is spent", () => {
    const evaluation = evaluateCascade(
      { status: "in_progress", consumerJson: FRESH },
      CASCADE_MAX_ATTEMPTS,
    );
    expect(evaluation.status).toBe("partial_failed");
    expect(evaluation.pendingConsumers).toHaveLength(4);
  });

  it("a spent budget does not fail a cascade whose consumers all ACKed", () => {
    const evaluation = evaluateCascade(
      { status: "in_progress", consumerJson: ALL_ACKED },
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

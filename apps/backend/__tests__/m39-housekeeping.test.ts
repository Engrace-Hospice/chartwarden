// GAP-171 — the pure decisions behind the renewal-cycle-close and draft-auto-expire crons.
import { describe, expect, it } from "vitest";
import {
  DRAFT_TTL_MS,
  draftCutoff,
  planRenewalCycleClose,
} from "../src/modules/39-consent/jobs/housekeeping";

describe("planRenewalCycleClose", () => {
  it("closes a cycle whose source expired without renewal", () => {
    expect(planRenewalCycleClose("expired")).toEqual({
      status: "closed_expired",
      reason: "source_expired_without_renewal",
    });
  });

  it("closes revoked and superseded sources with their own terminal status", () => {
    expect(planRenewalCycleClose("revoked")?.status).toBe("closed_revoked");
    expect(planRenewalCycleClose("superseded")?.status).toBe("closed_no_longer_applicable");
  });

  it("leaves a cycle open while its source is still live", () => {
    expect(planRenewalCycleClose("active")).toBeNull();
    expect(planRenewalCycleClose("draft")).toBeNull();
  });
});

describe("draftCutoff", () => {
  it("is exactly 30 days before now (housekeeping TTL, not a retention class)", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    expect(DRAFT_TTL_MS).toBe(30 * 24 * 3_600_000);
    expect(draftCutoff(now).toISOString()).toBe("2026-09-06T12:00:00.000Z");
  });
});

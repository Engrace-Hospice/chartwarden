// M36-T08 — the §8.1.2 job-emitted message-integrity + DLQ events land in the action catalog under
// the D9 `m36.*` namespace (the §4.4 jobs this task implements produce them).
//
// Accept: the three §8.1.2 events are present, owned by `m36`, PHI-free (no denylist; the DLQ
// payload is hashed), not Part 2 eligible, and the consolidated catalog still validates.
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, M36_ACTION_CATALOG, validateActionCatalog } from "../src/actions";

describe("M36-T08 action catalog (§8.1.2)", () => {
  it("declares the §8.1.2 job/integrity events and the ADR-0054 realtime events under m36", () => {
    expect(M36_ACTION_CATALOG.map((e) => e.action)).toEqual([
      "m36.integrity.hash_mismatch",
      "m36.hash_verify.run",
      "m36.retention_scan.run",
      "m36.dlq_job",
      "m36.realtime.connected",
      "m36.realtime.disconnected",
      "m36.membership.access_ended",
    ]);
  });

  it("every m36 event is owned by m36, PHI-free, and not Part 2 eligible", () => {
    for (const e of M36_ACTION_CATALOG) {
      expect(e.moduleOwner).toBe("m36");
      expect(e.denylistCategories).toEqual([]);
      expect(e.isPartTwoEligible).toBe(false);
    }
  });

  it("keeps the consolidated catalog valid after M36 is merged in", () => {
    expect(validateActionCatalog()).toEqual([]);
    for (const e of M36_ACTION_CATALOG) expect(ACTION_CATALOG).toContainEqual(e);
  });
});

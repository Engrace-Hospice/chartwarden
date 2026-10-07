// GAP-014 — pure cores of the M4 audit job ops (retention candidates, export scope, fan-out).
import { describe, expect, it } from "vitest";
import {
  exportFilterFromScope,
  groupRetentionCandidates,
  retentionCutoffFor,
  runAuditFanout,
} from "../src/modules/04-audit/jobs/audit-job-ops";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const ev = (createdAt: string, retentionClass: string, patientId?: string) => ({
  createdAt,
  retentionClass: retentionClass as "compliance",
  context: patientId ? { patientId } : {},
});

describe("retentionCutoffFor", () => {
  it("is 1y for operational and 7y for compliance; null for legal_hold", () => {
    expect(retentionCutoffFor("operational", NOW)?.toISOString()).toBe("2025-10-01T00:00:00.000Z");
    expect(retentionCutoffFor("compliance", NOW)?.toISOString()).toBe("2019-10-01T00:00:00.000Z");
    expect(retentionCutoffFor("legal_hold", NOW)).toBeNull();
  });
});

describe("groupRetentionCandidates", () => {
  it("groups expired events into one candidate per month and class", () => {
    const out = groupRetentionCandidates(
      "org-1",
      [
        ev("2019-03-02T00:00:00Z", "compliance"),
        ev("2019-03-20T00:00:00Z", "compliance"),
        ev("2019-04-01T00:00:00Z", "compliance"),
        ev("2026-09-01T00:00:00Z", "compliance"), // not expired
        ev("2024-01-01T00:00:00Z", "operational"),
      ],
      NOW,
    );
    expect(out.map((c) => c.partition).sort()).toEqual([
      "audit_event_2019_03",
      "audit_event_2019_04",
      "audit_event_2024_01",
    ]);
    const march = out.find((c) => c.partition === "audit_event_2019_03");
    expect(march).toMatchObject({ organizationId: "org-1", retentionClass: "compliance" });
  });

  it("keeps legal_hold candidates (the scan skips them with an explicit reason)", () => {
    const out = groupRetentionCandidates("o", [ev("2001-01-01T00:00:00Z", "legal_hold")], NOW);
    expect(out[0]?.retentionClass).toBe("legal_hold");
  });

  it("never attaches a patient to a Part 2 candidate (conservative keep)", () => {
    const out = groupRetentionCandidates(
      "o",
      [ev("2001-01-01T00:00:00Z", "compliance_42cfr_part2", "p1")],
      NOW,
    );
    expect(out[0]?.patient).toBeNull();
  });
});

describe("exportFilterFromScope", () => {
  it("maps the window and single-valued filters; post-filters multi-valued ones", () => {
    const f = exportFilterFromScope({
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
      patientIds: ["p1"],
      eventTypes: ["a.b", "c.d"],
    });
    expect(f.queries[0]).toMatchObject({
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
      patientId: "p1",
    });
    expect(f.matches({ eventType: "a.b", actorUserId: null, resourceKind: "x" })).toBe(true);
    expect(f.matches({ eventType: "z.z", actorUserId: null, resourceKind: "x" })).toBe(false);
  });
});

describe("runAuditFanout", () => {
  it("runs every org, then rethrows all failures together", async () => {
    const seen: string[] = [];
    await expect(
      runAuditFanout(
        async () => [{ organizationId: "a" }, { organizationId: "b" }, { organizationId: "c" }],
        async (id) => {
          seen.push(id);
          if (id === "a") throw new Error("boom");
        },
        "retention_scan",
      ),
    ).rejects.toThrow(/1 org failure/);
    expect(seen).toEqual(["a", "b", "c"]);
  });
});

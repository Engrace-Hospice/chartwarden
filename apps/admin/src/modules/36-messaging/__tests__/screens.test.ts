import { allPermissionMirrorRows } from "@wardenx/auth";
import { describe, expect, it } from "vitest";
import { type IntegrityEvent, summariseIntegrity } from "../integrity-status";
import { messagingAdminScreens } from "../screens";

const CATALOG_KEYS = new Set(allPermissionMirrorRows().map((r) => r.key));

describe("M36 admin screen registry", () => {
  it("declares M36 with six bound screens, unique ids and paths", () => {
    expect(messagingAdminScreens.moduleId).toBe(36);
    expect(messagingAdminScreens.screens).toHaveLength(6);
    const ids = messagingAdminScreens.screens.map((s) => s.id);
    const paths = messagingAdminScreens.screens.map((s) => s.path);
    expect(new Set(ids).size).toBe(6);
    expect(new Set(paths).size).toBe(6);
    for (const s of messagingAdminScreens.screens) expect(typeof s.screen).toBe("function");
  });

  it("gates every screen on a real permission key", () => {
    for (const s of messagingAdminScreens.screens) {
      expect(CATALOG_KEYS.has(s.requiredPermission ?? ""), s.id).toBe(true);
    }
  });
});

const ev = (eventType: string, createdAt: string, outcome: IntegrityEvent["outcome"] = "success") =>
  ({ eventType, createdAt, outcome }) satisfies IntegrityEvent;

describe("summariseIntegrity", () => {
  it("is no-runs with no rows", () => {
    expect(summariseIntegrity({}).health).toBe("no-runs");
  });
  it("is healthy after a clean run with only older findings", () => {
    const s = summariseIntegrity({
      "m36.hash_verify.run": ev("m36.hash_verify.run", "2026-10-02T00:00:00Z"),
      "m36.integrity.hash_mismatch": ev("m36.integrity.hash_mismatch", "2026-10-01T00:00:00Z"),
    });
    expect(s.health).toBe("healthy");
    expect(s.findings).toHaveLength(0);
  });
  it("needs attention for a finding at or after the last run, or a failed run", () => {
    const fresh = summariseIntegrity({
      "m36.hash_verify.run": ev("m36.hash_verify.run", "2026-10-02T00:00:00Z"),
      "m36.integrity.hash_mismatch": ev("m36.integrity.hash_mismatch", "2026-10-02T00:00:00Z"),
    });
    expect(fresh.health).toBe("attention");
    const failed = summariseIntegrity({
      "m36.hash_verify.run": ev("m36.hash_verify.run", "2026-10-02T00:00:00Z", "failure"),
    });
    expect(failed.health).toBe("attention");
  });
});

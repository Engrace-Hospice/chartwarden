// ADR-0085 G1: the per-tenant thread-grant duration is a registered, bounded setting whose maximum is the database's 7-day cap.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ORGANIZATION_SETTINGS_REGISTRY } from "../index";
import {
  THREAD_ACCESS_GRANT_HOURS_DEFAULT,
  THREAD_ACCESS_GRANT_HOURS_KEY,
  THREAD_ACCESS_GRANT_HOURS_MAX,
} from "../settings-by-m36";

const entry = ORGANIZATION_SETTINGS_REGISTRY.find((e) => e.settingsKey === THREAD_ACCESS_GRANT_HOURS_KEY);

describe("thread_access_grant_hours", () => {
  it("is registered by m36, optional, with the placeholder default", () => {
    expect(entry).toMatchObject({
      registeredByModule: "m36",
      required: false,
      defaultValue: THREAD_ACCESS_GRANT_HOURS_DEFAULT,
      uniqueAcrossTenants: false,
    });
  });

  it("accepts whole hours from 1 to the 7-day cap and nothing else", () => {
    const ok = (v: unknown) => Value.Check(entry!.typeBoxSchema, v);
    expect(THREAD_ACCESS_GRANT_HOURS_MAX).toBe(7 * 24);
    expect([1, 4, 168].every(ok)).toBe(true);
    expect([0, -1, 169, 1.5, "4", null].some(ok)).toBe(false);
  });
});

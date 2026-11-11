// Every key in ONBOARDING_KEYS is a real catalog key that the platform_ops role template carries, so a gate on one of them can never
// be on a misspelt key (always closed) nor on one no operator holds (React review L4; the skip / read gap). A gate on a literal key
// outside ONBOARDING_KEYS is not covered here.
import { allPermissionMirrorRows, rolesForPermission } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import { ONBOARDING_KEYS } from "./wizard-model";

const CATALOG = new Set(allPermissionMirrorRows().map((r) => r.key));

describe("ONBOARDING_KEYS", () => {
  for (const [name, key] of Object.entries(ONBOARDING_KEYS)) {
    it(`${name} (${key}) is in the catalog and held by platform_ops`, () => {
      expect(CATALOG.has(key)).toBe(true);
      expect(rolesForPermission(key)).toContain("platform_ops");
    });
  }
});

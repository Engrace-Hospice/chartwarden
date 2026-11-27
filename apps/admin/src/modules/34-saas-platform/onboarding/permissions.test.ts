// Every key in ONBOARDING_KEYS is a real catalog key that an onboarding role template carries (platform_ops, or one of the three duty roles
// CW-AC-22 split off it), so a gate on one of them can never be on a misspelt key (always closed) nor on one no operator holds (React
// review L4; the skip / read gap). A gate on a literal key outside ONBOARDING_KEYS is not covered here.
import {
  PLATFORM_ONBOARDING_ROLE_KEYS,
  allPermissionMirrorRows,
  rolesForPermission,
} from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import { ONBOARDING_KEYS } from "./wizard-model";

const CATALOG = new Set(allPermissionMirrorRows().map((r) => r.key));

describe("ONBOARDING_KEYS", () => {
  for (const [name, key] of Object.entries(ONBOARDING_KEYS)) {
    it(`${name} (${key}) is in the catalog and held by an onboarding role`, () => {
      expect(CATALOG.has(key)).toBe(true);
      const holders = rolesForPermission(key);
      expect(holders.some((role) => PLATFORM_ONBOARDING_ROLE_KEYS.includes(role as never))).toBe(
        true,
      );
    });
  }
});

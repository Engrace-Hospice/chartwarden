// GAP-133 — the M18 §D10 coordinate envelope for the M18 live suites.
//
// The production binding is `createEvvCoordsCipher(lazyEvvCoordsKeys(getTenantKeyProvider))` — M34's key ring
// unwrapped under the platform KEK. These suites prove M18's own tables, RLS and outbox, not M34's key ring
// (its live suite does that), so the key provider here is an in-memory per-tenant DEK ring with the SAME shape:
// 32 random bytes per (org, version), never derived. The ENVELOPE code under test is the production one.
import { randomBytes } from "node:crypto";
import {
  type EvvCoordsCipher,
  type EvvCoordsKeyProvider,
  createEvvCoordsCipher,
} from "../src/modules/18-evv/coords";

/** The DEK version the test key ring reports as current (what `coords_dek_version` must be stamped with). */
export const TEST_COORDS_DEK_VERSION = "v1";

/** An in-memory per-tenant DEK ring: one random 32-byte key per (org, version), minted on first use. */
export function createTestCoordsKeyRing(
  currentVersion: string = TEST_COORDS_DEK_VERSION,
): EvvCoordsKeyProvider {
  const keys = new Map<string, Buffer>();
  const keyFor = (organizationId: string, version: string): Buffer => {
    const id = `${organizationId}:${version}`;
    const existing = keys.get(id);
    if (existing) return existing;
    const minted = randomBytes(32);
    keys.set(id, minted);
    return minted;
  };
  return {
    async dekForOrg(organizationId) {
      return { version: currentVersion, key: keyFor(organizationId, currentVersion) };
    },
    async dekForOrgVersion(organizationId, version) {
      return { version, key: keyFor(organizationId, version) };
    },
  };
}

/** The production envelope over {@link createTestCoordsKeyRing}. */
export function createTestEvvCoordsCipher(
  currentVersion: string = TEST_COORDS_DEK_VERSION,
): EvvCoordsCipher {
  return createEvvCoordsCipher(createTestCoordsKeyRing(currentVersion));
}

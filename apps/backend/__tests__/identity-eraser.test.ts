// apps/backend/__tests__/identity-eraser.test.ts — M2-T10 identity data eraser.
//
// Proves M2 registers a REAL eraser for the `identity` data class over the Phase-0 deny-stub:
//   • the eraser destroys the subject's two_factor + passkey + pending-invitation rows and
//     reports a faithful { erased } total;
//   • the composition-root wireModuleErasers hook makes validateErasers() pass during a real
//     buildServer() boot (the deny-stub would have stood otherwise — still passing, but a
//     right-to-erasure request would silently no-op).
import { beforeEach, describe, expect, it } from "vitest";
import { wireErasers } from "../src/bootstrap/erasers/providers";
import { NotImplementedEraserError } from "../src/bootstrap/erasers/providers";
import {
  __resetErasersForTest,
  getEraser,
  validateErasers,
} from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";
import {
  createInMemoryIdentityEraserStore,
  registerIdentityErasers,
} from "../src/modules/02-identity/index";

const ORG = "org_1";

describe("M2-T10 — the identity eraser registers over the deny-stub (right-to-erasure)", () => {
  beforeEach(() => __resetErasersForTest());

  it("erases the subject's two_factor + passkey + pending invitations and reports the count", async () => {
    const { store, remaining } = createInMemoryIdentityEraserStore({
      twoFactor: [{ id: "tf_1", userId: "user_1" }],
      passkeys: [
        { id: "pk_1", userId: "user_1" },
        { id: "pk_2", userId: "user_1" },
        { id: "pk_3", userId: "user_2" }, // another subject — must survive
      ],
      invitations: [{ id: "inv_1", userId: "user_1" }],
    });
    registerIdentityErasers({ store });
    const eraser = getEraser("identity");

    const result = await eraser.erase({ orgId: ORG }, "user_1");

    expect(result).toEqual({ erased: 4 }); // 1 two_factor + 2 passkeys + 1 invitation
    // user_2's passkey is untouched — the eraser is subject-scoped, not a table wipe.
    expect(remaining()).toEqual({ twoFactor: 0, passkeys: 1, invitations: 0 });
  });

  it("a subject with no identity rows erases to zero (idempotent / safe no-rows)", async () => {
    const { store } = createInMemoryIdentityEraserStore();
    registerIdentityErasers({ store });
    expect(await getEraser("identity").erase({ orgId: ORG }, "ghost")).toEqual({ erased: 0 });
  });

  it("without M2's registration the identity eraser is the Phase-0 deny-stub (fails loud)", () => {
    wireErasers(); // M1 deny-stubs every required class, including `identity`
    expect(() => validateErasers()).not.toThrow();
    // The deny-stub throws synchronously on call (it never returns a promise).
    expect(() => getEraser("identity").erase({ orgId: ORG }, "user_1")).toThrow(
      NotImplementedEraserError,
    );
  });

  it("buildServer() boots green with both composition-root hooks; the real identity eraser stands", async () => {
    const app = buildServer({
      registerModuleSeams: wireModuleSeams,
      registerModuleErasers: wireModuleErasers,
    });
    // validateErasers() did not throw (boot succeeded) AND the identity eraser is the real impl:
    // it returns a count, it does not throw the deny-stub error.
    await expect(getEraser("identity").erase({ orgId: ORG }, "nobody")).resolves.toEqual({
      erased: 0,
    });
    await app.close();
  });
});

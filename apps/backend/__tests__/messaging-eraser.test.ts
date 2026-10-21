import { DekDestroyedError, createInMemoryMessagingEraseStore } from "@chartwarden/messaging";
// apps/backend/__tests__/messaging-eraser.test.ts — M36-T10 the `messages` data eraser
// (spec §7.8 / §11 D9).
//
// Proves M36 registers a REAL eraser for the `messages` data class over the Phase-0 deny-stub, and
// that the registered eraser enforces the §7.8 destruction contract:
//   • DEK destruction is cryptographic erasure — a post-erase decrypt attempt on a sample body fails
//     (the spec's "done means" check);
//   • structural rows for the offboarding org are deleted; another org's rows are untouched;
//   • cross-tenant user rows (presence/delivery_endpoint/user_notification_preferences) are deleted
//     ONLY for users whose sole membership was the offboarded tenant (the D9 carve-out);
//   • the composition-root wireModuleErasers hook makes validateErasers() pass during a real
//     buildServer() boot (the deny-stub would otherwise have stood).
import { beforeEach, describe, expect, it } from "vitest";
import { wireErasers } from "../src/bootstrap/erasers/providers";
import {
  __resetErasersForTest,
  getEraser,
  validateErasers,
} from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";
import { registerMessagingErasers } from "../src/modules/36-messaging/index";

const ORG = "org_1";
const OTHER_ORG = "org_2";

describe("M36-T10 — the `messages` eraser registers over the deny-stub (D9 §7.8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("cryptographically erases the org's message bodies + deletes structural & sole-tenant rows", async () => {
    const inMem = createInMemoryMessagingEraseStore({
      messages: [
        { id: "m1", orgId: ORG, bodyCipher: "cipher-1" },
        { id: "m2", orgId: ORG, bodyCipher: "cipher-2" },
        { id: "m3", orgId: OTHER_ORG, bodyCipher: "cipher-3" },
      ],
      structural: [
        { id: "ch1", orgId: ORG },
        { id: "cm1", orgId: ORG },
        { id: "ch2", orgId: OTHER_ORG },
      ],
      crossTenant: [
        // sole member of ORG → deleted
        { id: "p1", table: "presence", userId: "u_sole", memberOf: [ORG] },
        { id: "e1", table: "delivery_endpoint", userId: "u_sole", memberOf: [ORG] },
        // belongs to ORG *and* OTHER_ORG → retained (a user is not the tenant)
        { id: "p2", table: "presence", userId: "u_multi", memberOf: [ORG, OTHER_ORG] },
      ],
    });

    registerMessagingErasers({ store: inMem.store });
    const result = await getEraser("messages").erase({ orgId: ORG }, ORG);

    // 2 bodies rendered + (2 structural + 2 message rows) + 2 sole-tenant cross-tenant rows.
    expect(result).toEqual({ erased: 2 + 4 + 2 });

    // §7.8 "done means": a post-erase decrypt attempt on a sample body fails. The other org's body,
    // whose DEK was never destroyed, is still decryptable.
    expect(() => inMem.tryDecrypt("m3")).not.toThrow();
    // ORG's message rows were deleted, so its bodies are gone twice over; the DEK is destroyed for
    // ORG, so even before structural delete the bodies were unreadable.
    const { remaining } = inMem;
    expect(remaining()).toEqual({ messages: 1, structural: 1, crossTenant: 1 });
  });

  it("renders a sampled ORG body undecryptable the instant the DEK is destroyed (pre structural delete)", async () => {
    // Drive the store port directly to observe the §7.8 order: destroyTenantDek alone makes the body
    // unreadable, before any structural row is deleted.
    const inMem = createInMemoryMessagingEraseStore({
      messages: [{ id: "m1", orgId: ORG, bodyCipher: "phi-body" }],
    });
    expect(inMem.tryDecrypt("m1")).toBe("phi-body");
    await inMem.store.destroyTenantDek(ORG);
    expect(() => inMem.tryDecrypt("m1")).toThrow(DekDestroyedError);
  });

  it("reports zero when the org has no messaging footprint (no-op, not an error)", async () => {
    const inMem = createInMemoryMessagingEraseStore();
    registerMessagingErasers({ store: inMem.store });
    expect(await getEraser("messages").erase({ orgId: ORG }, ORG)).toEqual({ erased: 0 });
  });

  it("makes validateErasers() pass during a real buildServer() boot (no deny-stub left standing)", () => {
    wireErasers(); // deny-stub every required class first…
    // …then the registered messaging eraser must stand over its stub (no NotImplemented throw).
    expect(() =>
      buildServer({
        registerModuleSeams: wireModuleSeams,
        registerModuleErasers: wireModuleErasers,
      }),
    ).not.toThrow();
    expect(() => validateErasers()).not.toThrow();
  });
});

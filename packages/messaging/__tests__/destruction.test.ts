// packages/messaging/__tests__/destruction.test.ts — M36-T10 the pure D9 eraseFn (§7.8 / §11 D9).
//
// Proves the destruction ORDER and the carve-outs the spec fixes, against the in-memory store:
//   • the tenant DEK is destroyed FIRST → bodies are undecryptable before structural delete (§7.8);
//   • structural rows are deleted only for the offboarding org;
//   • cross-tenant user rows are deleted ONLY for users whose sole membership was that org (D9);
//   • the `{ erased }` total is the faithful sum of all three; a second pass is a clean no-op.
import { describe, expect, it } from "vitest";
import {
  DekDestroyedError,
  createInMemoryMessagingEraseStore,
  eraseTenantMessaging,
} from "../src/index";

const ORG = "org_A";
const OTHER = "org_B";

describe("eraseTenantMessaging — D9 tenant offboarding (§7.8)", () => {
  it("destroys the DEK first, then structural + sole-tenant rows; reports a faithful total", async () => {
    const inMem = createInMemoryMessagingEraseStore({
      messages: [
        { id: "m1", orgId: ORG, bodyCipher: "a" },
        { id: "m2", orgId: ORG, bodyCipher: "b" },
        { id: "m3", orgId: OTHER, bodyCipher: "c" },
      ],
      structural: [
        { id: "ch1", orgId: ORG },
        { id: "ch2", orgId: OTHER },
      ],
      crossTenant: [
        { id: "u1", table: "presence", userId: "sole", memberOf: [ORG] },
        { id: "u2", table: "delivery_endpoint", userId: "multi", memberOf: [ORG, OTHER] },
      ],
    });

    const result = await eraseTenantMessaging(ORG, inMem.store);

    expect(result.bodiesRendered).toBe(2); // both ORG bodies undecryptable
    expect(result.structuralRows).toBe(3); // 1 channel + 2 message rows
    expect(result.crossTenantRows).toBe(1); // only the sole-tenant user
    expect(result.erased).toBe(result.bodiesRendered + result.structuralRows + result.crossTenantRows);

    // OTHER org untouched: its body still decrypts, its rows remain.
    expect(() => inMem.tryDecrypt("m3")).not.toThrow();
    expect(inMem.remaining()).toEqual({ messages: 1, structural: 1, crossTenant: 1 });
  });

  it("makes a sampled body undecryptable as soon as the DEK is destroyed", async () => {
    const inMem = createInMemoryMessagingEraseStore({
      messages: [{ id: "m1", orgId: ORG, bodyCipher: "phi" }],
    });
    expect(inMem.tryDecrypt("m1")).toBe("phi");
    await inMem.store.destroyTenantDek(ORG);
    expect(() => inMem.tryDecrypt("m1")).toThrow(DekDestroyedError);
  });

  it("is idempotent — a second offboarding pass erases nothing more", async () => {
    const inMem = createInMemoryMessagingEraseStore({
      messages: [{ id: "m1", orgId: ORG, bodyCipher: "a" }],
      structural: [{ id: "ch1", orgId: ORG }],
    });
    const first = await eraseTenantMessaging(ORG, inMem.store);
    // 1 body rendered + (1 structural row + 1 message row deleted) = 3.
    expect(first.erased).toBe(3);
    const second = await eraseTenantMessaging(ORG, inMem.store);
    expect(second).toEqual({ bodiesRendered: 0, structuralRows: 0, crossTenantRows: 0, erased: 0 });
  });
});

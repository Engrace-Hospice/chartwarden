import { randomBytes } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { InMemoryAttemptStore, NOT_WIRED_TRANSPORT, UNBOUND_BINDING } from "@chartwarden/x12-837-client";
import type { ClearinghouseBinding } from "@chartwarden/x12-837-client";
import { createInMemoryHarness } from "@chartwarden/x12-837-client/testing";
import { describe, expect, it } from "vitest";
import type { ConfigRow } from "./config-store";
import { createTenantClearinghouseRuntime } from "./resolver";
import { buildClearinghouseSecretCipher } from "./secret-cipher";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ORG_C = "33333333-3333-4333-8333-333333333333";
const KEY = "fake-key-not-a-secret#1";

async function setup() {
  const cipher = buildClearinghouseSecretCipher(randomBytes(32));
  let decrypts = 0;
  const counting = {
    encrypt: cipher.encrypt,
    decrypt: (...args: Parameters<typeof cipher.decrypt>) => {
      decrypts += 1;
      return cipher.decrypt(...args);
    },
  };
  const rows = new Map<string, ConfigRow>();
  const put = async (
    org: string,
    over: Partial<ConfigRow> & { vendor: string; mode: string | null; secret?: string },
  ) => {
    const { secret, ...rest } = over;
    const sealed =
      secret && (over.vendor === "stedi" || over.vendor === "claimmd") && over.mode
        ? await cipher.encrypt(org, secret, { vendor: over.vendor, mode: over.mode as "test" })
        : null;
    rows.set(org, {
      organizationId: org,
      status: "active",
      version: 1,
      secretCipher: sealed?.cipher ?? null,
      ...rest,
    } as ConfigRow);
  };
  const platformBinding: ClearinghouseBinding = {
    vendor: "in_memory",
    transport: createInMemoryHarness().transport,
  };
  const runtime = createTenantClearinghouseRuntime({
    db: {} as DbClient,
    cipher: counting,
    attempts: new InMemoryAttemptStore(),
    platformBinding,
    fallbackOrgIds: new Set([ORG_C]),
    readRow: async (org) => rows.get(org) ?? null,
  });
  return { runtime, rows, put, platformBinding, decrypts: () => decrypts };
}

describe("per-organization clearinghouse binding", () => {
  it("is unbound at the top level (a consumer that does not resolve per org fails closed)", async () => {
    const { runtime } = await setup();
    expect(runtime.binding.vendor).toBeNull();
    expect(runtime.binding.transport).toBe(NOT_WIRED_TRANSPORT);
    expect(runtime.binding.forOrg).toBeTypeOf("function");
  });

  it("gives each org the transport of its own vendor", async () => {
    const { runtime, put } = await setup();
    await put(ORG_A, { vendor: "stedi", mode: "production", secret: KEY });
    await put(ORG_B, { vendor: "claimmd", mode: "test", secret: KEY });
    const a = await runtime.binding.forOrg?.(ORG_A);
    const b = await runtime.binding.forOrg?.(ORG_B);
    expect(a?.vendor).toBe("stedi");
    expect(a?.transport.vendor).toBe("stedi");
    expect(b?.vendor).toBe("claimmd");
    expect(b?.transport.vendor).toBe("claimmd");
    expect(a?.transport).not.toBe(b?.transport);
  });

  it("serves nothing for outside, for a draft or verified config, and for an org with no row", async () => {
    const { runtime, put } = await setup();
    await put(ORG_A, { vendor: "outside", mode: null });
    await put(ORG_B, { vendor: "stedi", mode: "test", status: "verified", secret: KEY });
    for (const org of [ORG_A, ORG_B, "99999999-9999-4999-8999-999999999999"]) {
      expect(await runtime.binding.forOrg?.(org)).toBe(UNBOUND_BINDING);
    }
  });

  it("serves the platform env binding only to an org named in the fallback list that has no row", async () => {
    const { runtime, put, platformBinding } = await setup();
    expect(await runtime.binding.forOrg?.(ORG_C)).toBe(platformBinding);
    await put(ORG_C, { vendor: "outside", mode: null });
    expect(await runtime.binding.forOrg?.(ORG_C)).toBe(UNBOUND_BINDING);
  });

  it("opens the credential once per version and rebuilds when the config changes", async () => {
    const { runtime, put, decrypts } = await setup();
    await put(ORG_A, { vendor: "stedi", mode: "test", secret: KEY });
    const first = await runtime.binding.forOrg?.(ORG_A);
    const second = await runtime.binding.forOrg?.(ORG_A);
    expect(second).toBe(first);
    expect(decrypts()).toBe(1);
    await put(ORG_A, { vendor: "claimmd", mode: "test", secret: KEY, version: 2 });
    const third = await runtime.binding.forOrg?.(ORG_A);
    expect(third?.vendor).toBe("claimmd");
    expect(decrypts()).toBe(2);
  });

  it("stops serving an org the moment its config leaves `active`", async () => {
    const { runtime, put } = await setup();
    await put(ORG_A, { vendor: "stedi", mode: "test", secret: KEY });
    expect((await runtime.binding.forOrg?.(ORG_A))?.vendor).toBe("stedi");
    await put(ORG_A, { vendor: "stedi", mode: "test", secret: KEY, status: "draft", version: 2 });
    expect(await runtime.binding.forOrg?.(ORG_A)).toBe(UNBOUND_BINDING);
  });

  it("throws, rather than going unbound, when a live credential cannot be opened", async () => {
    const { runtime, rows, put } = await setup();
    await put(ORG_A, { vendor: "stedi", mode: "test", secret: KEY });
    const row = rows.get(ORG_A) as ConfigRow;
    rows.set(ORG_A, { ...row, secretCipher: "AAAA" });
    await expect(runtime.binding.forOrg?.(ORG_A)).rejects.toThrow(/did not open/);
    rows.set(ORG_A, { ...row, secretCipher: null });
    await expect(runtime.binding.forOrg?.(ORG_A)).rejects.toThrow(/no usable credential/);
  });

  it("reports an org's live mode, and nothing for a config that is not live", async () => {
    const { runtime, put } = await setup();
    await put(ORG_A, { vendor: "stedi", mode: "production", secret: KEY });
    await put(ORG_B, { vendor: "claimmd", mode: "test", status: "draft", secret: KEY });
    expect(await runtime.usageFor(ORG_A)).toBe("production");
    expect(await runtime.usageFor(ORG_B)).toBeNull();
    expect(await runtime.usageFor(ORG_C)).toBeNull();
  });
});

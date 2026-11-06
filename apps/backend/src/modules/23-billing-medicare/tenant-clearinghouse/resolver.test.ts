import { randomBytes } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import {
  CH,
  InMemoryAttemptStore,
  NOT_WIRED_TRANSPORT,
  UNBOUND_BINDING,
  UNBOUND_NOT_ACTIVE,
  UNBOUND_NOT_CHOSEN,
  UNBOUND_OUTSIDE,
} from "@chartwarden/x12-837-client";
import type { ClearinghouseBinding } from "@chartwarden/x12-837-client";
import { createInMemoryHarness } from "@chartwarden/x12-837-client/testing";
import { describe, expect, it } from "vitest";
import type { ConfigRow } from "./config-store";
import { createTenantClearinghouseRuntime, withOrgOnAnomaly } from "./resolver";
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
      expect((await runtime.binding.forOrg?.(org))?.vendor).toBeNull();
    }
  });

  it("says WHY an org is unbound: outside, a config that is not live yet, nothing chosen", async () => {
    const { runtime, put } = await setup();
    await put(ORG_A, { vendor: "outside", mode: null });
    await put(ORG_B, { vendor: "stedi", mode: "test", status: "verified", secret: KEY });
    expect(await runtime.binding.forOrg?.(ORG_A)).toBe(UNBOUND_OUTSIDE);
    expect(await runtime.binding.forOrg?.(ORG_B)).toBe(UNBOUND_NOT_ACTIVE);
    expect(await runtime.binding.forOrg?.("99999999-9999-4999-8999-999999999999")).toBe(
      UNBOUND_NOT_CHOSEN,
    );
  });

  it("serves the platform env binding only to an org named in the fallback list that has no row", async () => {
    const { runtime, put, platformBinding } = await setup();
    expect(await runtime.binding.forOrg?.(ORG_C)).toBe(platformBinding);
    await put(ORG_C, { vendor: "outside", mode: null });
    expect(await runtime.binding.forOrg?.(ORG_C)).toBe(UNBOUND_OUTSIDE);
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
    expect(await runtime.binding.forOrg?.(ORG_A)).toBe(UNBOUND_NOT_ACTIVE);
  });

  it("throws, rather than going unbound, when a live credential cannot be opened", async () => {
    const { runtime, rows, put } = await setup();
    await put(ORG_A, { vendor: "stedi", mode: "test", secret: KEY });
    const row = rows.get(ORG_A) as ConfigRow;
    rows.set(ORG_A, { ...row, secretCipher: "AAAA" });
    // A typed 503 (never a bare Error, which surfaces as a 500 on a route that resolves the binding).
    const unreadable = { code: "CLEARINGHOUSE_CREDENTIAL_UNREADABLE", statusCode: 503 };
    await expect(runtime.binding.forOrg?.(ORG_A)).rejects.toMatchObject(unreadable);
    rows.set(ORG_A, { ...row, secretCipher: null });
    await expect(runtime.binding.forOrg?.(ORG_A)).rejects.toMatchObject(unreadable);
  });

  it("binds each org's transport to that org: a call naming another org is refused before the vendor", async () => {
    const { runtime, put } = await setup();
    await put(ORG_A, { vendor: "claimmd", mode: "test", secret: KEY });
    await put(ORG_B, { vendor: "claimmd", mode: "test", secret: KEY });
    const a = await runtime.binding.forOrg?.(ORG_A);
    const ctxFor = (organizationId: string) => ({
      organizationId,
      providerEntityId: "44444444-4444-4444-8444-444444444444",
      payerId: "PAYER",
      correlationId: "c-1",
      usage: "test" as const,
    });
    const submission = {
      kind: "claim" as const,
      controlNumber: "CTRL1",
      idempotencyKey: "k1",
      payload: { format: "x12" as const, x12: "ISA*00~" },
    };
    const calls = [
      await a?.transport.submitClaim(ctxFor(ORG_B), submission),
      await a?.transport.submitNotice(ctxFor(ORG_B), { ...submission, kind: "noe" as const }),
      await a?.transport.fetchAcknowledgments(ctxFor(ORG_B), null),
      await a?.transport.fetchRemittances(ctxFor(ORG_B), null),
      await a?.transport.fetchClaimStatus(ctxFor(ORG_B), "CTRL1"),
    ];
    for (const result of calls) {
      expect(result && !result.ok && result.degraded.code).toBe(CH.INVALID_REQUEST);
      expect(result && !result.ok && result.degraded.reason).toMatch(
        /belongs to another organization/,
      );
    }
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

describe("transport anomalies name the organization", () => {
  it("hands the anomaly sink the organization whose transport raised it (a per-org account's warning must be attributable)", () => {
    const seen: { anomaly: unknown; context: unknown }[] = [];
    const sink = withOrgOnAnomaly((anomaly, context) => seen.push({ anomaly, context }), ORG_A);
    sink?.({ type: "reconciled_from_upload_list", idempotencyKey: "k1" });
    expect(seen).toEqual([
      {
        anomaly: { type: "reconciled_from_upload_list", idempotencyKey: "k1" },
        context: { organizationId: ORG_A },
      },
    ]);
  });

  it("is absent when no sink is configured", () => {
    expect(withOrgOnAnomaly(undefined, ORG_A)).toBeUndefined();
  });
});

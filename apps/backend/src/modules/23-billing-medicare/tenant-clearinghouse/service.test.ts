import { randomBytes } from "node:crypto";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createInMemoryConfigStore } from "./config-store-memory";
import { buildClearinghouseSecretCipher } from "./secret-cipher";
import {
  type ClearinghouseActor,
  type ClearinghouseProbes,
  createTenantClearinghouseService,
} from "./service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const ACTOR: ClearinghouseActor = {
  organizationId: ORG,
  userId: "33333333-3333-4333-8333-333333333333",
  membershipId: "44444444-4444-4444-8444-444444444444",
};
const FAKE_KEY = "fake-key-not-a-secret#1";

function setup(probes: ClearinghouseProbes = {}) {
  const store = createInMemoryConfigStore();
  const cipher = buildClearinghouseSecretCipher(randomBytes(32));
  let probed: { secret: string; mode: string } | undefined;
  const probe = (outcome: "ok" | "credential_rejected" | "unreachable") => async (
    secret: string,
    mode: string,
  ) => {
    probed = { secret, mode };
    return outcome;
  };
  const service = createTenantClearinghouseService({
    cipher,
    probes: Object.keys(probes).length > 0 ? probes : { claimmd: probe("ok") },
  });
  return { store, service, cipher, probe, probed: () => probed };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ChartWardenError) return err.code;
    throw err;
  }
  return "no error";
};

describe("tenant clearinghouse service: choosing", () => {
  it("reports nothing chosen for a new tenant", async () => {
    const { store, service } = setup();
    const view = await service.view(store, ORG);
    expect(view).toMatchObject({ vendor: null, status: null, source: "none", hasSecret: false });
  });

  it("starts a transmitting vendor at draft with a sealed secret and never returns the secret", async () => {
    const { store, service } = setup();
    const { created, view } = await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    expect(created).toBe(true);
    expect(view).toMatchObject({
      vendor: "claimmd",
      mode: "test",
      status: "draft",
      hasSecret: true,
      verifiableBy: "connection_test",
    });
    expect(JSON.stringify(view)).not.toContain(FAKE_KEY);
    const [row] = store.rows();
    expect(row?.secretCipher).toBeTruthy();
    expect(row?.secretCipher).not.toContain(FAKE_KEY);
  });

  it("stores `outside` as active with no mode and no secret", async () => {
    const { store, service } = setup();
    const { view } = await service.put(store, ACTOR, { vendor: "outside" }, undefined);
    expect(view).toMatchObject({ vendor: "outside", status: "active", mode: null, hasSecret: false });
  });

  it("refuses an incomplete or contradictory choice before touching the store", async () => {
    const { store, service } = setup();
    expect(await codeOf(service.put(store, ACTOR, { vendor: "stedi", secret: FAKE_KEY }, undefined))).toBe("VALIDATION_FAILED");
    expect(await codeOf(service.put(store, ACTOR, { vendor: "stedi", mode: "test" }, undefined))).toBe("VALIDATION_FAILED");
    expect(await codeOf(service.put(store, ACTOR, { vendor: "outside", mode: "test" }, undefined))).toBe("VALIDATION_FAILED");
    expect(await codeOf(service.put(store, ACTOR, { vendor: "stedi", mode: "test", secret: "short" }, undefined))).toBe("VALIDATION_FAILED");
    expect(store.rows()).toHaveLength(0);
  });

  it("answers 503 when no encryption key is bound (a secret is never stored in the clear)", async () => {
    const store = createInMemoryConfigStore();
    const service = createTenantClearinghouseService({ probes: {} });
    expect(
      await codeOf(service.put(store, ACTOR, { vendor: "stedi", mode: "test", secret: FAKE_KEY }, undefined)),
    ).toBe("CLEARINGHOUSE_CIPHER_UNBOUND");
    expect(store.rows()).toHaveLength(0);
  });

  it("needs If-Match to change an existing config, and refuses a stale version", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined);
    const input = { vendor: "claimmd", mode: "test", secret: `${FAKE_KEY}2` } as const;
    expect(await codeOf(service.put(store, ACTOR, input, undefined))).toBe("IF_MATCH_REQUIRED");
    expect(await codeOf(service.put(store, ACTOR, input, 7))).toBe("VERSION_CONFLICT");
    expect(await codeOf(service.put(store, ACTOR, input, 1))).toBe("no error");
    expect(await codeOf(service.put(store, ACTOR, { vendor: "outside" }, undefined))).toBe("IF_MATCH_REQUIRED");
  });

  it("refuses If-Match on a first choice", async () => {
    const { store, service } = setup();
    expect(await codeOf(service.put(store, ACTOR, { vendor: "outside" }, 1))).toBe("VERSION_CONFLICT");
  });

  it("changes nothing for an identical put with no new secret", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined);
    const { view } = await service.put(store, ACTOR, { vendor: "claimmd", mode: "test" }, 1);
    expect(view.version).toBe(1);
  });

  it("puts a vendor or mode change back to draft and demands the new credential", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined);
    await service.verify(store, ACTOR, {});
    await service.activate(store, ACTOR);
    expect(await codeOf(service.put(store, ACTOR, { vendor: "claimmd", mode: "production" }, 3))).toBe("VALIDATION_FAILED");
    const { view } = await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "production", secret: `${FAKE_KEY}-prod` },
      3,
    );
    expect(view).toMatchObject({ status: "draft", mode: "production", verification: null, activatedAt: null });
  });

  it("keeps a live config live across a credential rotation but forgets the last test", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined);
    await service.verify(store, ACTOR, {});
    await service.activate(store, ACTOR);
    const { view } = await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: `${FAKE_KEY}-rotated` },
      3,
    );
    expect(view).toMatchObject({ status: "active", lastTest: null });
    expect(view.verification?.kind).toBe("connection_test");
  });

  it("locks vendor and mode once a production submission exists, but still allows a rotation", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "claimmd", mode: "production", secret: FAKE_KEY }, undefined);
    store.setProductionAttempts(ORG, true);
    expect(await codeOf(service.put(store, ACTOR, { vendor: "stedi", mode: "production", secret: FAKE_KEY }, 1))).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
    expect(await codeOf(service.put(store, ACTOR, { vendor: "outside" }, 1))).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
    expect(await codeOf(service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, 1))).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
    expect(
      await codeOf(service.put(store, ACTOR, { vendor: "claimmd", mode: "production", secret: `${FAKE_KEY}-new` }, 1)),
    ).toBe("no error");
  });

  it("reports a platform-env fallback for an org that has no row", async () => {
    const store = createInMemoryConfigStore();
    const service = createTenantClearinghouseService({
      probes: {},
      platformFallback: (org) => (org === ORG ? { vendor: "stedi", mode: "test" } : null),
    });
    expect(await service.view(store, ORG)).toMatchObject({ vendor: "stedi", status: "active", source: "platform_env" });
    expect(await service.view(store, OTHER_ORG)).toMatchObject({ vendor: null, source: "none" });
  });
});

describe("tenant clearinghouse service: verifying and activating", () => {
  it("verifies Claim.MD with a connection test using the unsealed key in the chosen mode", async () => {
    const { store, service, probed } = setup();
    await service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined);
    const { view, test } = await service.verify(store, ACTOR, {});
    expect(test).toEqual({ outcome: "ok" });
    expect(view).toMatchObject({ status: "verified", verification: { kind: "connection_test" }, lastTest: { outcome: "ok" } });
    expect(probed()).toEqual({ secret: FAKE_KEY, mode: "test" });
  });

  it("stays at draft and records the outcome when the connection test fails", async () => {
    const { store, service, probe } = setup();
    const failing = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32)),
      probes: { claimmd: probe("credential_rejected") },
    });
    await failing.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined);
    const { view, test } = await failing.verify(store, ACTOR, {});
    expect(test).toEqual({ outcome: "credential_rejected" });
    expect(view).toMatchObject({ status: "draft", verification: null, lastTest: { outcome: "credential_rejected" } });
    expect(await codeOf(failing.activate(store, ACTOR))).toBe("CLEARINGHOUSE_NOT_VERIFIED");
  });

  it("verifies Stedi (no safe probe) only by attestation with an evidence note", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "stedi", mode: "test", secret: FAKE_KEY }, undefined);
    expect((await service.view(store, ORG)).verifiableBy).toBe("attestation");
    expect(await codeOf(service.verify(store, ACTOR, {}))).toBe("VALIDATION_FAILED");
    expect(await codeOf(service.verify(store, ACTOR, { evidenceNote: "short" }))).toBe("VALIDATION_FAILED");
    const { view, test } = await service.verify(store, ACTOR, {
      evidenceNote: "Sandbox claim accepted by Stedi test mode, ticket OPS-123",
    });
    expect(test).toBeNull();
    expect(view).toMatchObject({
      status: "verified",
      verification: { kind: "attested", evidence: "Sandbox claim accepted by Stedi test mode, ticket OPS-123" },
    });
  });

  it("refuses an evidence note that looks like a patient identifier", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "stedi", mode: "test", secret: FAKE_KEY }, undefined);
    expect(
      await codeOf(service.verify(store, ACTOR, { evidenceNote: "tested with beneficiary 900-12-3456 today" })),
    ).toBe("VALIDATION_FAILED");
  });

  it("refuses to verify with nothing chosen, with `outside`, or before the credential is entered", async () => {
    const { store, service } = setup();
    expect(await codeOf(service.verify(store, ACTOR, {}))).toBe("CLEARINGHOUSE_NOT_CONFIGURED");
    expect(await codeOf(service.activate(store, ACTOR))).toBe("CLEARINGHOUSE_NOT_CONFIGURED");
    await service.put(store, ACTOR, { vendor: "outside" }, undefined);
    expect(await codeOf(service.verify(store, ACTOR, {}))).toBe("CLEARINGHOUSE_OUTSIDE_NOT_VERIFIABLE");
  });

  it("activates only a verified config, and activation is idempotent", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined);
    expect(await codeOf(service.activate(store, ACTOR))).toBe("CLEARINGHOUSE_NOT_VERIFIED");
    await service.verify(store, ACTOR, {});
    const first = await service.activate(store, ACTOR);
    expect(first).toMatchObject({ status: "active" });
    expect(first.activatedAt).not.toBeNull();
    const again = await service.activate(store, ACTOR);
    expect(again.version).toBe(first.version);
  });

  it("re-verifying an active config keeps it active", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined);
    await service.verify(store, ACTOR, {});
    await service.activate(store, ACTOR);
    const { view } = await service.verify(store, ACTOR, {});
    expect(view.status).toBe("active");
  });
});

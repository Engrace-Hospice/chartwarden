// M36 WP 2.13 — behaviour of the boot/gate functions that index.ts and the CLI call, and WIRING proofs that they are
// actually called (a regression that deletes a call must fail here, because the unit tests of the callee cannot see it).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbClient } from "@wardenx/db";
import { describe, expect, it, vi } from "vitest";
import {
  BodyKeyUnavailableError,
  createRingDekCache,
} from "../src/modules/36-messaging/body-key-ring";
import {
  LegacyBodyCountUnavailableError,
  LegacyBodyKeyMissingError,
  assertM36BodyBootEnv,
  runLegacyBodyBootCheck,
} from "../src/modules/36-messaging/body-legacy-key-check";
import {
  BodyBackfillRefusedError,
  backfillBodiesForOrg,
} from "../src/modules/36-messaging/jobs/body-backfill";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";

const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
const log = () => ({ info: vi.fn(), warn: vi.fn() });
const ORG = "11111111-1111-4111-8111-111111111111";

describe("boot check behaviour", () => {
  it("production: an unavailable count is fatal (not a warning)", async () => {
    await expect(
      runLegacyBodyBootCheck({
        count: async () => {
          throw new Error("permission denied for table message");
        },
        env: { NODE_ENV: "production" },
        log: log(),
      }),
    ).rejects.toBeInstanceOf(LegacyBodyCountUnavailableError);
  });

  it("outside production it warns and continues", async () => {
    const l = log();
    const status = await runLegacyBodyBootCheck({
      count: async () => {
        throw new Error("nope");
      },
      env: { NODE_ENV: "development" },
      log: l,
    });
    expect(status).toBeUndefined();
    expect(l.warn).toHaveBeenCalledOnce();
  });

  it("production with legacy rows and no key fails closed; with the key it logs the state", async () => {
    await expect(
      runLegacyBodyBootCheck({
        count: async () => ({ message: 1, message_revision: 0 }),
        env: { NODE_ENV: "production" },
        log: log(),
      }),
    ).rejects.toBeInstanceOf(LegacyBodyKeyMissingError);
    const l = log();
    const ok = await runLegacyBodyBootCheck({
      count: async () => ({ message: 1, message_revision: 0 }),
      env: {
        NODE_ENV: "production",
        MESSAGING_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      },
      log: l,
    });
    expect(ok?.state).toBe("legacy_rows_key_present");
    expect(l.info).toHaveBeenCalledWith(expect.stringContaining("legacy_rows_key_present"));
  });
});

describe("M36_BODY_SEAL_SCHEME boot validation", () => {
  it("rejects a typo; ring needs the platform KEK and pool; legacy/unset pass", () => {
    expect(assertM36BodyBootEnv({})).toBe("legacy");
    expect(assertM36BodyBootEnv({ M36_BODY_SEAL_SCHEME: "legacy" })).toBe("legacy");
    expect(() => assertM36BodyBootEnv({ M36_BODY_SEAL_SCHEME: "rign" })).toThrow(
      /legacy' or 'ring/,
    );
    expect(() => assertM36BodyBootEnv({ M36_BODY_SEAL_SCHEME: "ring" })).toThrow(/M34_TENANT_KEK/);
    expect(() =>
      assertM36BodyBootEnv({ M36_BODY_SEAL_SCHEME: "ring", M34_TENANT_KEK: "k:x" }),
    ).toThrow(/DATABASE_PLATFORM_URL/);
    expect(
      assertM36BodyBootEnv({
        M36_BODY_SEAL_SCHEME: "ring",
        M34_TENANT_KEK: "k:x",
        DATABASE_PLATFORM_URL: "postgres://x",
      }),
    ).toBe("ring");
  });
});

describe("escrow gate inside the library", () => {
  it("a real run in production is refused by backfillBodiesForOrg itself, before any database access", async () => {
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error("database touched");
        },
      },
    ) as unknown as DbClient;
    await expect(
      backfillBodiesForOrg({ db, cipher: createMessageBodyCipher({ sealScheme: "ring" }) }, ORG, {
        env: { NODE_ENV: "production" },
      }),
    ).rejects.toBeInstanceOf(BodyBackfillRefusedError);
  });
});

describe("key outage is distinguishable from a GCM failure", () => {
  it("provider failures surface as BodyKeyUnavailableError; a tampered envelope is a plain auth error", async () => {
    const down = createRingDekCache({
      dekForOrg: async () => {
        throw new Error("platform pool down");
      },
      dekForOrgVersion: async () => {
        throw new Error("platform pool down");
      },
    });
    const good = createRingDekCache({
      dekForOrg: async () => ({ version: "v1", key: Buffer.alloc(32, 5) }),
      dekForOrgVersion: async () => ({ version: "v1", key: Buffer.alloc(32, 5) }),
    });
    const sealed = (
      await createMessageBodyCipher({ ringCache: good, sealScheme: "ring" }).seal(ORG, "x")
    ).cipher;
    await expect(
      createMessageBodyCipher({ ringCache: down }).open(ORG, sealed),
    ).rejects.toBeInstanceOf(BodyKeyUnavailableError);
    await expect(
      createMessageBodyCipher({ ringCache: down, sealScheme: "ring" }).seal(ORG, "x"),
    ).rejects.toBeInstanceOf(BodyKeyUnavailableError);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    const err = await createMessageBodyCipher({ ringCache: good })
      .open(ORG, tampered)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BodyKeyUnavailableError);
  });
});

describe("wiring: the calls exist where they must (source-level regression guards)", () => {
  const index = src("src/index.ts");
  it("index.ts validates the seal scheme, runs the legacy boot check and binds the key provider", () => {
    expect(index).toContain("assertM36BodyBootEnv(process.env)");
    expect(index).toContain("await runLegacyBodyBootCheck({");
    expect(index).toContain("setMessageBodyKeyProvider(() => getTenantKeyProvider())");
  });

  it("the shred path drops cached DEKs right after the destroy commits, and rotation publishes drop the org's", () => {
    const destroy = index.slice(index.indexOf("async destroyTenantKeyRing(input)"));
    const call = destroy.indexOf("m34_destroy_tenant_key_ring(");
    const inval = destroy.indexOf("invalidateMessageBodyKeys();");
    expect(call).toBeGreaterThan(-1);
    expect(inval).toBeGreaterThan(call);
    expect(inval - call).toBeLessThan(900);
    expect(index).toMatch(
      /dek_rotation_completed"\)\s*\{\s*invalidateMessageBodyKeys\(event\.organizationId\)/,
    );
  });

  it("the library enforces the escrow gate and the CLI passes the re-seal credential", () => {
    expect(src("src/modules/36-messaging/jobs/body-backfill.ts")).toContain(
      "assertBodyBackfillAllowed(opts.env ?? process.env, dryRun)",
    );
    const cli = readFileSync(join(__dirname, "../../../scripts/m36-body-backfill.ts"), "utf8");
    expect(cli).toContain("assertBodyBackfillAllowed(process.env, dryRun)");
    expect(cli).toContain("resealDb: reseal.db");
  });

  it("hash_verify and search do not swallow key outages", () => {
    expect(src("src/modules/36-messaging/jobs/integrity-jobs.ts")).toContain(
      "if (err instanceof BodyKeyUnavailableError) throw err;",
    );
    expect(src("src/modules/36-messaging/message-search-service-db.ts")).toContain(
      "if (err instanceof BodyKeyUnavailableError) throw err;",
    );
  });
});

/**
 * #105 (F-045) — the M34 per-tenant DEK chain, end to end over real Postgres.
 *
 * Four modules' encryption surfaces terminated at one missing dependency. This suite drives the whole
 * chain the way production does: a wrapped DEK minted by the platform KEK, stored by the SECURITY DEFINER
 * provisioning function, resolved back through M34's `TenantKeyProvider` seam, used to open a real
 * HearthNote envelope (M8's §2.6 narrative cipher — the consumer that made this urgent), and finally
 * destroyed by the shred function so the same ciphertext becomes permanently unreadable.
 *
 * TWO things were broken, and only one of them was the KEK. The second is asserted first here, because
 * it fails BEFORE the unwrap and would survive any amount of work on the KEK: migration 0052 §5 REVOKES
 * `wardenx_app`'s SELECT on `tenant_key_ring` (the §3.10 / M34-F02 control — the request path's
 * credential must never reach key material), and the key provider was reading the ring through exactly
 * that credential. `42501 permission denied for table tenant_key_ring`, for every org, in every
 * deployment, whatever `kekUnwrap` was bound to.
 *
 * The assertions a plausible-looking implementation would fail:
 *   • the DEK really opens the envelope a production cipher wrote — not "returns 32 bytes", which a zero
 *     key also does. (M39's cipher only seals; the suite opens it with the DEK the provider handed back,
 *     which is what proves the two are the same key.)
 *   • a wrapped DEK copied from ANOTHER tenant's key ring refuses (the AAD binds the org). Without this,
 *     anyone able to WRITE `tenant_key_ring` — the platform credential, or a restored backup — reads B's
 *     PHI through A's request path while never holding the KEK.
 *   • after the shred, the SAME envelope is unreadable — the property destruction certificates assert.
 *   • an unbound key-ring credential refuses with a STATED reason, not a 42501 no caller can interpret.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m34:tenant-key-provider:live
 */
import { Buffer } from "node:buffer";
import { createDecipheriv } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { __resetModule34SeamsForTest } from "@wardenx/saas-tenant-platform";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACTIVE_KEK_ENV,
  RETIRED_KEK_ENV,
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../src/bootstrap/tenant-kek";
import { m34PlatformBypassAuditor } from "../src/index";
import {
  TenantKeyDestroyed,
  TenantKeyMissing,
  getTenantKeyProvider,
  registerLiveM34Seams,
  validateModule34Seams,
} from "../src/modules/34-saas-tenant-platform/index";
import { createConsentInternalNotesCipher } from "../src/modules/39-consent/consent-crypto";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];

const ORG_A = "11111111-1111-4111-8111-111111110451";
const ORG_B = "22222222-2222-4222-8222-222222220452";
const APPROVER = "33333333-3333-4333-8333-333333330453";

const KEY_1 = Buffer.alloc(32, 0x11).toString("base64");
const KEY_2 = Buffer.alloc(32, 0x22).toString("base64");

/**
 * Open an M39 `consent_record.internal_notes` envelope (`v1.<dekVersion>.<nonce>.<tag>.<ct>`, AES-256-GCM
 * with the module/table/column/tenant AAD). M39's production cipher only SEALS — the field is write-only
 * today — so the read half lives here; it is a transcription of `consent-crypto.ts`'s own format, and its
 * job is to prove the DEK the seam handed back is the same key that sealed the row.
 */
function openConsentEnvelope(envelope: string, organizationId: string, dek: Buffer): string {
  const [scheme, , nonce, tag, ciphertext] = envelope.split(".");
  if (scheme !== "v1" || !nonce || !tag || ciphertext === undefined) {
    throw new Error("malformed consent envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(nonce, "base64url"));
  decipher.setAAD(Buffer.from(`m39:consent_record:internal_notes:${organizationId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

const kekAdapter = (active: string, retired = "") => {
  const ring = loadPlatformKekRing({
    [ACTIVE_KEK_ENV]: active,
    [RETIRED_KEK_ENV]: retired,
  } as NodeJS.ProcessEnv);
  if (!ring) throw new Error("expected a KEK ring");
  return createPlatformKekAdapter(ring);
};

describe.skipIf(!DB_URL)("#105 — M34 tenant key provider, LIVE Postgres", () => {
  let admin: Client;
  let appHandle: ReturnType<typeof createDbClient>;
  let platformHandle: ReturnType<typeof createDbClient>;
  const accountOf: Record<string, string> = {};

  const urlAs = (role: string, password: string): string => {
    const u = new URL(DB_URL as string);
    u.username = role;
    u.password = password;
    return u.toString();
  };

  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  async function seedOrg(org: string, slug: string): Promise<void> {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
      [org, slug, slug],
    );
    accountOf[org] = (
      await admin.query(
        `INSERT INTO tenant_account (organization_id, legal_business_name, billing_contact_email, breach_notification_email)
         VALUES ($1,$2,'billing@f045.example','breach@f045.example') RETURNING id`,
        [org, `${slug} Hospice LLC`],
      )
    ).rows[0].id as string;
  }

  /** Provision a key ring exactly as the `tenant.provision` worker does: mint+wrap, then the SD function. */
  async function provisionKeyRing(
    org: string,
    adapter: ReturnType<typeof kekAdapter>,
  ): Promise<{ wrappedCiphertextB64: string; kekId: string }> {
    const wrapped = await adapter.mintAndWrapDek({ organizationId: org });
    await platformHandle.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.dek_kek_wrapped_ciphertext_b64', ${wrapped.wrappedCiphertextB64}, true), set_config('app.dek_kek_id', ${wrapped.kekId}, true)`,
      );
      await tx.execute(sql`SELECT m34_provision_tenant_key_ring(${accountOf[org]})`);
    });
    return wrapped;
  }

  /** Register the D5 provider over a given KEK + key-ring credential, replacing whatever stood before. */
  function bindSeams(opts: {
    kek?: ReturnType<typeof kekAdapter>;
    keyRingDb?: ReturnType<typeof createDbClient>["db"];
  }): void {
    __resetModule34SeamsForTest();
    registerLiveM34Seams({
      db: appHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      kekUnwrap: opts.kek,
      keyRingDb: opts.keyRingDb,
    });
    validateModule34Seams();
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await seedOrg(ORG_A, "f045a");
    await seedOrg(ORG_B, "f045b");

    await admin.query("ALTER ROLE wardenx_app LOGIN PASSWORD 'f045_app'");
    appHandle = createDbClient({ connectionString: urlAs("wardenx_app", "f045_app") });
    // The platform credential (`DATABASE_PLATFORM_URL`). `wardenx_admin` holds 0052's tenant_key_ring
    // grants, so it stands in for `wardenx_platform_login` here (the GAP-097/098 precedent).
    await admin.query("ALTER ROLE wardenx_admin LOGIN BYPASSRLS PASSWORD 'f045_platform'");
    platformHandle = createDbClient({ connectionString: urlAs("wardenx_admin", "f045_platform") });
  }, 240_000);

  afterAll(async () => {
    await appHandle?.close();
    await platformHandle?.close();
    await admin?.end();
    __resetModule34SeamsForTest();
  });

  // ── the credential break (fails BEFORE the KEK, and is invisible to any amount of KEK work) ────────
  describe("tenant_key_ring is unreadable to the request path's credential (§3.10 / M34-F02)", () => {
    it("wardenx_app is refused; the platform credential is not", async () => {
      // Drizzle wraps the driver error, so the Postgres message is on `cause` — asserting the wrapper's
      // text would pass for ANY failed query, which is the opposite of what this case is for.
      const failureOf = async (
        handle: ReturnType<typeof createDbClient>,
      ): Promise<string | null> => {
        try {
          await handle.db.execute(sql`SELECT count(*)::int AS n FROM tenant_key_ring`);
          return null;
        } catch (e) {
          const cause = (e as { cause?: { message?: string } }).cause;
          return cause?.message ?? (e as Error).message;
        }
      };
      expect(await failureOf(appHandle)).toMatch(/permission denied for table tenant_key_ring/i);
      // Falsifiability: the same statement on the platform credential succeeds, so the refusal above is
      // the GRANT and not some unrelated failure of the harness.
      expect(await failureOf(platformHandle)).toBeNull();
    });

    it("a provider bound WITHOUT a key-ring credential refuses with a stated reason", async () => {
      bindSeams({ kek: kekAdapter(`kek-1:${KEY_1}`) });
      await expect(getTenantKeyProvider().dekForOrg(ORG_A)).rejects.toThrow(
        /tenantKeyRingRead.*DATABASE_PLATFORM_URL/s,
      );
    });

    it("a provider bound WITHOUT a KEK refuses by naming the env var to set", async () => {
      bindSeams({ keyRingDb: platformHandle.db });
      await provisionKeyRing(ORG_A, kekAdapter(`kek-1:${KEY_1}`));
      await expect(getTenantKeyProvider().dekForOrg(ORG_A)).rejects.toThrow(
        new RegExp(`kekUnwrap.*${ACTIVE_KEK_ENV}`, "s"),
      );
    });
  });

  // ── the chain, bound ───────────────────────────────────────────────────────────────────────────────
  describe("a fully bound provider resolves a usable DEK", () => {
    const kek = () => kekAdapter(`kek-1:${KEY_1}`);

    it("refuses an org with no key ring rather than inventing one", async () => {
      bindSeams({ kek: kek(), keyRingDb: platformHandle.db });
      await expect(getTenantKeyProvider().dekForOrg(ORG_B)).rejects.toBeInstanceOf(
        TenantKeyMissing,
      );
      expect(await getTenantKeyProvider().keyRingState(ORG_B)).toBe("absent");
    });

    it("resolves the DEK that OPENS what a production cipher sealed", async () => {
      bindSeams({ kek: kek(), keyRingDb: platformHandle.db });
      expect(await getTenantKeyProvider().keyRingState(ORG_A)).toBe("active");
      const dek = await getTenantKeyProvider().dekForOrg(ORG_A);
      expect(dek.key).toHaveLength(32);
      expect(dek.version).toBe("v1");
      expect(dek.key.equals(Buffer.alloc(32))).toBe(false); // not a zero key

      // A REAL consumer, through the real seam: this call threw for every org before #105.
      const sealed = await createConsentInternalNotesCipher(getTenantKeyProvider()).encrypt(
        ORG_A,
        "Patient resting comfortably.",
      );
      expect(openConsentEnvelope(sealed, ORG_A, dek.key)).toBe("Patient resting comfortably.");
    });

    it("refuses a wrapped DEK lifted from ANOTHER tenant's key ring (the AAD binds the org)", async () => {
      // Org B's own ring, minted for B…
      const bWrapped = await provisionKeyRing(ORG_B, kek());
      // …transplanted into org A's row. RLS and the grants cannot see this: the row is well-formed and
      // sits in the right tenant. Only the AAD distinguishes it.
      await admin.query(
        `UPDATE tenant_key_ring SET current_dek_kek_wrapped_ciphertext = decode($1,'base64')
          WHERE organization_id = $2`,
        [bWrapped.wrappedCiphertextB64, ORG_A],
      );
      bindSeams({ kek: kek(), keyRingDb: platformHandle.db });
      await expect(getTenantKeyProvider().dekForOrg(ORG_A)).rejects.toThrow(
        /failed authentication/,
      );
      // Org B still resolves its own copy — the refusal is about WHERE the ciphertext sits, not the bytes.
      expect((await getTenantKeyProvider().dekForOrg(ORG_B)).key).toHaveLength(32);
      // Restore A so the later cases run against a well-formed ring.
      const aWrapped = await kek().mintAndWrapDek({ organizationId: ORG_A });
      await admin.query(
        `UPDATE tenant_key_ring SET current_dek_kek_wrapped_ciphertext = decode($1,'base64')
          WHERE organization_id = $2`,
        [aWrapped.wrappedCiphertextB64, ORG_A],
      );
    });

    it("resolves a PRIOR DEK version through a retired KEK (the rotation window)", async () => {
      const retiredWrapped = await kekAdapter(`kek-1:${KEY_1}`).mintAndWrapDek({
        organizationId: ORG_A,
      });
      await admin.query(
        `UPDATE tenant_key_ring
            SET prior_dek_versions = $1::jsonb
          WHERE organization_id = $2`,
        [
          JSON.stringify([
            {
              version: "v0",
              kekWrappedCiphertext: retiredWrapped.wrappedCiphertextB64,
              kekId: "kek-1",
              rotatedAt: "2026-01-01T00:00:00.000Z",
            },
          ]),
          ORG_A,
        ],
      );
      // The platform has rotated to kek-2; kek-1 lives on in the retired list, unwrap-only.
      bindSeams({
        kek: kekAdapter(`kek-2:${KEY_2}`, `kek-1:${KEY_1}`),
        keyRingDb: platformHandle.db,
      });
      const prior = await getTenantKeyProvider().dekForOrgVersion(ORG_A, "v0");
      expect(prior.version).toBe("v0");
      expect(prior.key).toHaveLength(32);
    });
  });

  // ── the shred: what a destruction certificate actually certifies ───────────────────────────────────
  describe("cryptographic shred", () => {
    it("makes the tenant's ciphertext permanently unreadable", async () => {
      const kek = kekAdapter(`kek-1:${KEY_1}`);
      bindSeams({ kek, keyRingDb: platformHandle.db });

      // Something sealed BEFORE the shred — the point is that this becomes unreadable, not that a
      // subsequent resolve throws (a resolve that throws proves nothing about the data at rest).
      const sealed = await createConsentInternalNotesCipher(getTenantKeyProvider()).encrypt(
        ORG_A,
        "Family present at bedside.",
      );
      const preShredDek = (await getTenantKeyProvider().dekForOrg(ORG_A)).key;
      expect(openConsentEnvelope(sealed, ORG_A, preShredDek)).toBe("Family present at bedside.");

      const certId = (
        await admin.query(
          `INSERT INTO destruction_certificate
             (organization_id, data_class, record_count, date_range_start, date_range_end, method, status)
           VALUES ($1,'saas_tenant_platform_class',1, now() - interval '2 years', now() - interval '1 year',
                   'crypto_erase','approved')
           RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      await admin.query("UPDATE tenant_account SET status='destruction_pending' WHERE id=$1", [
        accountOf[ORG_A],
      ]);
      await admin.query("SELECT set_config('app.destroyed_by_membership_id',$1,false)", [APPROVER]);
      await admin.query("SELECT m34_destroy_tenant_key_ring($1,$2)", [accountOf[ORG_A], certId]);

      // The ONLY copy of the key material is gone from the row…
      const row = await admin.query(
        "SELECT current_dek_kek_wrapped_ciphertext, current_dek_kek_id, destroyed_at FROM tenant_key_ring WHERE organization_id=$1",
        [ORG_A],
      );
      expect(row.rows[0].current_dek_kek_wrapped_ciphertext).toBeNull();
      expect(row.rows[0].destroyed_at).not.toBeNull();

      // …so the provider refuses, and the bytes sealed a moment ago can never be opened again. Holding
      // the KEK is not enough: the DEK was random and its wrapped form was the only copy.
      bindSeams({ kek, keyRingDb: platformHandle.db });
      expect(await getTenantKeyProvider().keyRingState(ORG_A)).toBe("destroyed");
      await expect(getTenantKeyProvider().dekForOrg(ORG_A)).rejects.toBeInstanceOf(
        TenantKeyDestroyed,
      );
      await expect(
        createConsentInternalNotesCipher(getTenantKeyProvider()).encrypt(ORG_A, "anything"),
      ).rejects.toBeInstanceOf(TenantKeyDestroyed);
      // And the ciphertext at rest: only a key nobody can obtain again opens it. `preShredDek` is a
      // copy this TEST happens to still hold in memory, which is exactly why the assertion below uses a
      // FRESH random key — the platform's own path to that key material is what the shred removed.
      expect(() => openConsentEnvelope(sealed, ORG_A, Buffer.alloc(32, 0x99))).toThrow();
    });
  });
});

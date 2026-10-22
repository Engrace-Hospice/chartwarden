/**
 * Crypto context-label rename, RELEASE 2 - the operator-run backfill (scripts/db/backfill-crypto-labels.ts), LIVE Postgres.
 *
 * Every module is populated with values sealed under the LEGACY ("wardenx") label by an independent oracle
 * (`_crypto-label-oracle.ts`: literal label strings + node:crypto, no import from the code under test), then the real backfill
 * runs as the NOBYPASSRLS `chartwarden_app` role (and the platform / reseal credentials where the tool needs them) and the stored
 * BYTES are checked by the same oracle: they must open under the "chartwarden" label and no longer under "wardenx".
 *
 * What a plausible-looking backfill would fail:
 *   - `--verify` reporting zero while a row still opens only under the legacy label (the release-3 gate would be a lie);
 *   - a second run changing anything (idempotence), or an interrupted run not resuming;
 *   - a concurrent edit being overwritten (the compare-and-swap), a legal-held message being touched;
 *   - the M34 key ring ever being left unreadable: crashes before the write, before COMMIT and after COMMIT, and a read-back that
 *     fails (the old bytes are restored), the DEKs staying byte-identical, the KEK id and every prior version preserved;
 *   - search name-exclusion digests changing with the flip and a name being indexed in the clear while the index is rewritten.
 *
 * Run against a PRIVATE container, never the shared cluster (it DROPs ROLEs):
 *   docker run -d --name cw-crypto-r2-pg -p 55441:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg18 \
 *     -c max_locks_per_transaction=2048
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55441/postgres bun run test:crypto-labels:backfill:live
 */
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { buildMessageTags, tokenizeForSearch } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BackfillDeps,
  type BackfillReport,
  MissingDependencyError,
  type ModuleId,
  runBackfill,
} from "../../../scripts/db/crypto-label-backfill";
import type { Mode } from "../../../scripts/db/crypto-label-backfill/core";
import { m5IdentifierScan } from "../../../scripts/db/crypto-label-backfill/m5";
import { m23MacCredentialScan } from "../../../scripts/db/crypto-label-backfill/m23";
import { m24TradingPartnerScan } from "../../../scripts/db/crypto-label-backfill/m24";
import {
  BackupNotConfirmedError,
  SimulatedCrash,
} from "../../../scripts/db/crypto-label-backfill/m34";
import { MissingResealCredentialError } from "../../../scripts/db/crypto-label-backfill/m36-body";
import {
  type PlatformKekAdapter,
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../src/bootstrap/tenant-kek";
import { createPatientIdentifierCipher } from "../src/modules/05-patient/identifiers/identifier-cipher";
import { findSsnHitPatientIds } from "../src/modules/05-patient/identifiers/sensitive-identifiers-db";
import { buildMacSecretCipher } from "../src/modules/23-billing-medicare/routes/secret-cipher";
import { buildKeyProvider } from "../src/modules/34-saas-tenant-platform/seam-registration";
import { createRingDekCache } from "../src/modules/36-messaging/body-key-ring";
import { createIndexWriter } from "../src/modules/36-messaging/global-search/index-writer";
import {
  type NameExclusions,
  type PatientNameSource,
  createNameExclusions,
} from "../src/modules/36-messaging/global-search/name-exclusion";
import { createPlatformSearchFlag } from "../src/modules/36-messaging/global-search/platform-flag";
import { createBodyReader } from "../src/modules/36-messaging/global-search/ports";
import { createRingSearchKeyProvider } from "../src/modules/36-messaging/global-search/search-key-provider";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { currentOracle, fails, legacyOracle } from "./_crypto-label-oracle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "chartwarden_destruction",
  "tenant_platform_writer",
  "chartwarden_platform_login",
  "chartwarden_platform",
  "chartwarden_body_backfill_login",
  "chartwarden_m36_reseal",
];
const ORG_A = "aaaaaaaa-0000-4000-8000-0000000c2a01";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000c2b02";
const SHA = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// Key material the oracle needs to build and check values by hand.
const KEK1 = randomBytes(32); // active platform KEK  ("kek-1")
const KEK0 = randomBytes(32); // retired platform KEK ("kek-0"): a prior DEK version is wrapped under it
const M24_KEK = randomBytes(32); // M24_CREDENTIAL_ENCRYPTION_KEY (M23 + M24)
const MSG_KEK = randomBytes(32); // MESSAGING_ENCRYPTION_KEY (v1 message bodies)
const PK_ACTIVE = randomBytes(32); // M35 active pseudonym KEK ("pk-1")
const PK_RETIRED = randomBytes(32); // M35 retired pseudonym KEK ("pk-0")
const DEK_A1 = randomBytes(32); // org A, ring version v1 (a PRIOR version, wrapped under the retired KEK)
const DEK_A2 = randomBytes(32); // org A, ring version v2 (current)
const DEK_B1 = randomBytes(32); // org B, ring version v1 (current)
const b64 = (b: Buffer) => b.toString("base64");

/** A Luhn-valid NPI (prefix 80840) for sequence number n: provider_entity.npi is unique and checksummed. */
function npi(n: number): string {
  const body = `1${String(n).padStart(8, "0")}`;
  const digits = `80840${body}`.split("").reverse().map(Number);
  let sum = 0;
  for (const [i, d] of digits.entries()) {
    const v = i % 2 === 0 ? d * 2 : d;
    sum += v > 9 ? v - 9 : v;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}
let npiSeq = 0;

describe.skipIf(!DB_URL)("crypto label backfill (release 2) - LIVE Postgres", () => {
  let admin: Client;
  let app: { db: DbClient; close: () => Promise<void> };
  let platform: { db: DbClient; close: () => Promise<void> };
  let reseal: { db: DbClient; close: () => Promise<void> };
  let adapter: PlatformKekAdapter;
  let deps: BackfillDeps;
  let exclusions: NameExclusions;
  let sabotage = false;
  const urls: { app: string; platform: string; reseal: string } = {
    app: "",
    platform: "",
    reseal: "",
  };
  const accountOf: Record<string, string> = {};
  const userOf: Record<string, string> = {};
  const pe: Record<string, string[]> = { [ORG_A]: [], [ORG_B]: [] };
  const NAMES: PatientNameSource = {
    async fragmentsPage(_org, afterId) {
      return afterId === null
        ? { fragments: ["Zebrowski"], nextAfterId: null }
        : { fragments: [], nextAfterId: null };
    },
  };

  const urlAs = (role: string, password: string): string => {
    const u = new URL(DB_URL as string);
    u.username = role;
    u.password = password;
    return u.toString();
  };
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await admin.query(text, params)).rows as T[];

  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
  }

  async function seedOrg(org: string, slug: string) {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
      [org, slug],
    );
    accountOf[org] = (
      await q<{ id: string }>(
        `INSERT INTO tenant_account (organization_id, legal_business_name, billing_contact_email, breach_notification_email)
         VALUES ($1,$2,'b@cl2.example','x@cl2.example') RETURNING id`,
        [org, `${slug} LLC`],
      )
    )[0]?.id as string;
    userOf[org] = (
      await q<{ id: string }>(`INSERT INTO "user" (email, name) VALUES ($1,$1) RETURNING id`, [
        `${slug}@cl2.test`,
      ])
    )[0]?.id as string;
    await admin.query(
      "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')",
      [userOf[org], org],
    );
    for (const n of [1, 2, 3]) {
      pe[org]?.push(
        (
          await q<{ id: string }>(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,'PE',$3,'enc','1231') RETURNING id`,
            [org, `${org === ORG_A ? "71" : "72"}${n}${n}${n}${n}`, npi(++npiSeq)],
          )
        )[0]?.id as string,
      );
    }
  }

  /** The tenant key ring as production holds it today: every wrap carries the LEGACY label. */
  async function seedLegacyKeyRing() {
    const wrapA2 = legacyOracle.wrapDek(KEK1, "kek-1", ORG_A, DEK_A2);
    const wrapA1 = legacyOracle.wrapDek(KEK0, "kek-0", ORG_A, DEK_A1);
    await admin.query(
      `INSERT INTO tenant_key_ring (organization_id, tenant_account_id, current_dek_version,
          current_dek_kek_wrapped_ciphertext, current_dek_kek_id, prior_dek_versions, dek_created_at)
       VALUES ($1,$2,'v2',$3,'kek-1',$4::jsonb, now())`,
      [
        ORG_A,
        accountOf[ORG_A],
        wrapA2,
        JSON.stringify([
          {
            version: "v1",
            kekWrappedCiphertext: b64(wrapA1),
            kekId: "kek-0",
            rotatedAt: "2026-10-08T00:00:00.000Z",
          },
        ]),
      ],
    );
    await admin.query(
      `INSERT INTO tenant_key_ring (organization_id, tenant_account_id, current_dek_version,
          current_dek_kek_wrapped_ciphertext, current_dek_kek_id, prior_dek_versions, dek_created_at)
       VALUES ($1,$2,'v1',$3,'kek-1','[]'::jsonb, now())`,
      [ORG_B, accountOf[ORG_B], legacyOracle.wrapDek(KEK1, "kek-1", ORG_B, DEK_B1)],
    );
  }

  const ringRow = async (org: string) =>
    (
      await q<{
        w: Buffer;
        k: string;
        p: Array<{
          version: string;
          kekWrappedCiphertext: string;
          kekId: string;
          rotatedAt: string;
        }>;
      }>(
        `SELECT current_dek_kek_wrapped_ciphertext AS w, current_dek_kek_id AS k, prior_dek_versions AS p
           FROM tenant_key_ring WHERE organization_id=$1`,
        [org],
      )
    )[0] as {
      w: Buffer;
      k: string;
      p: Array<{ version: string; kekWrappedCiphertext: string; kekId: string; rotatedAt: string }>;
    };

  const run = (
    modules: ModuleId[],
    mode: Mode,
    extra: Partial<Parameters<typeof runBackfill>[1]> = {},
    d: BackfillDeps = deps,
  ): Promise<BackfillReport> =>
    runBackfill(d, {
      modules,
      organizationIds: [ORG_A, ORG_B],
      mode,
      batchSize: 2, // small pages so every scan crosses page boundaries
      ...extra,
    });
  const totalOf = (report: BackfillReport, module: ModuleId) =>
    report.modules.find((m) => m.module === module)?.total;

  /** Verify + apply + verify + apply again: legacy-only before, zero after, the second run changes nothing. */
  async function converge(module: ModuleId, expectLegacy: number, expectResealed = expectLegacy) {
    const before = await run([module], "verify");
    expect(totalOf(before, module)?.legacyOnly).toBe(expectLegacy);
    const applied = await run([module], "apply");
    expect(totalOf(applied, module)?.resealed).toBe(expectResealed);
    expect(totalOf(applied, module)?.failed).toBe(0);
    const after = await run([module], "verify");
    expect(totalOf(after, module)?.legacyOnly).toBe(0);
    expect(totalOf(after, module)?.unreadable).toBe(0);
    const again = await run([module], "apply");
    expect(totalOf(again, module)?.resealed).toBe(0);
    expect(totalOf(again, module)?.wouldReseal).toBe(0);
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
    urls.app = await appRoleConnectionString(admin, DB_URL as string);
    app = createDbClient({ connectionString: urls.app });
    // The REAL production credentials, created by the operator's own provisioning script with its enumerated grants: the platform
    // login (BYPASSRLS, UPDATE on tenant_key_ring / patient_pseudonym_key) and the reseal login (EXECUTE on the 1090 / 1094 / 1150
    // functions only). Nothing here stands in for them, so a missing grant fails this suite the way it would fail the operator.
    const provision = spawnSync(
      "bun",
      ["run", join(__dirname, "../../../scripts/db/provision-runtime-roles.ts")],
      {
        env: {
          ...process.env,
          PROVISION_DATABASE_URL: DB_URL,
          CHARTWARDEN_PLATFORM_PASSWORD: "cl2-platform-password-0123456789",
          CHARTWARDEN_BODY_BACKFILL_PASSWORD: "cl2-backfill-password-0123456789",
        },
        encoding: "utf8",
      },
    );
    if (provision.status !== 0) throw new Error(`role provisioning failed: ${provision.stderr}`);
    urls.platform = urlAs("chartwarden_platform_login", "cl2-platform-password-0123456789");
    platform = createDbClient({ connectionString: urls.platform });
    urls.reseal = urlAs("chartwarden_body_backfill_login", "cl2-backfill-password-0123456789");
    reseal = createDbClient({ connectionString: urls.reseal });

    await seedOrg(ORG_A, "cl2a");
    await seedOrg(ORG_B, "cl2b");
    await seedLegacyKeyRing();

    const ring = loadPlatformKekRing({
      M34_TENANT_KEK: `kek-1:${b64(KEK1)}`,
      M34_TENANT_KEK_RETIRED: `kek-0:${b64(KEK0)}`,
    } as NodeJS.ProcessEnv);
    if (!ring) throw new Error("expected a KEK ring");
    const real = createPlatformKekAdapter(ring);
    // `sabotage` lets a test corrupt ONLY the phase-3 read-back, to prove the old bytes are put back.
    adapter = {
      ...real,
      unwrap: async (input) => {
        const dek = await real.unwrap(input);
        if (sabotage && input.onlyGeneration === "current") dek[0] = (dek[0] as number) ^ 0xff;
        return dek;
      },
    };
    const keys = buildKeyProvider({
      kekUnwrap: real,
      runInKeyRingContext: (orgId, fn) => withOrgContext(platform.db, systemOrgContext(orgId), fn),
    });
    const ringCache = createRingDekCache(keys);
    const searchKeys = createRingSearchKeyProvider(() => ringCache);
    const bodies = createBodyReader(createMessageBodyCipher({ kek: MSG_KEK, keys, ringCache }));
    exclusions = createNameExclusions({ db: app.db, keys: searchKeys, names: NAMES });
    deps = {
      db: app.db,
      platformDb: platform.db,
      resealDb: reseal.db,
      identifierCipher: createPatientIdentifierCipher(keys),
      macCipher: buildMacSecretCipher(M24_KEK),
      credentialKek: M24_KEK,
      kekAdapter: adapter,
      pseudonymRing: {
        active: { kekId: "pk-1", key: PK_ACTIVE },
        byId: new Map([
          ["pk-1", PK_ACTIVE],
          ["pk-0", PK_RETIRED],
        ]),
      },
      bodyKit: { kek: MSG_KEK, ringDek: (org, version) => ringCache.byVersion(org, version) },
      search: {
        db: app.db,
        keys: searchKeys,
        bodies,
        exclusions,
        writer: createIndexWriter({
          db: app.db,
          bodies,
          keys: searchKeys,
          exclusions,
          platformFlag: createPlatformSearchFlag(app.db),
        }),
      },
      backupConfirmed: true,
    };
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await platform?.close();
    await reseal?.close();
    await admin?.end();
  });

  // ── M34: the highest-risk module goes FIRST in these tests so every later module reads through a re-wrapped ring ──
  describe("M34 tenant key ring (two-phase, crash-safe)", () => {
    const ringProvider = () =>
      buildKeyProvider({
        kekUnwrap: createPlatformKekAdapter(
          loadPlatformKekRing({
            M34_TENANT_KEK: `kek-1:${b64(KEK1)}`,
            M34_TENANT_KEK_RETIRED: `kek-0:${b64(KEK0)}`,
          } as NodeJS.ProcessEnv) as never,
        ),
        runInKeyRingContext: (orgId, fn) =>
          withOrgContext(platform.db, systemOrgContext(orgId), fn),
      });
    /** The ring still hands out every DEK byte-for-byte, through the production provider. */
    const ringStillReadable = async () => {
      const p = ringProvider();
      expect((await p.dekForOrg(ORG_A)).key.equals(DEK_A2)).toBe(true);
      expect((await p.dekForOrgVersion(ORG_A, "v1")).key.equals(DEK_A1)).toBe(true);
      expect((await p.dekForOrg(ORG_B)).key.equals(DEK_B1)).toBe(true);
    };

    it("--verify counts both rings as legacy-only (current wrap AND the prior version are legacy-wrapped)", async () => {
      const report = await run(["m34"], "verify");
      expect(totalOf(report, "m34")).toMatchObject({
        scanned: 2,
        legacyOnly: 2,
        current: 0,
        unreadable: 0,
      });
      expect(report.legacyOnlyTotal).toBe(2);
    });

    it("refuses to write without the explicit backup confirmation, and a dry run writes nothing", async () => {
      const before = await ringRow(ORG_A);
      await expect(run(["m34"], "apply", {}, { ...deps, backupConfirmed: false })).rejects.toThrow(
        BackupNotConfirmedError,
      );
      const dry = await run(["m34"], "dry-run");
      expect(totalOf(dry, "m34")).toMatchObject({ wouldReseal: 2, resealed: 0 });
      expect((await ringRow(ORG_A)).w.equals(before.w)).toBe(true);
      await ringStillReadable();
    });

    it.each([
      ["afterCompute", "before anything is written"],
      ["beforeCommit", "after the UPDATE but before COMMIT (rolled back)"],
    ] as const)(
      "a crash %s (%s) leaves the old ring byte-identical and readable",
      async (point, _when) => {
        const before = await ringRow(ORG_A);
        await expect(
          run(
            ["m34"],
            "apply",
            {},
            {
              ...deps,
              m34Hooks: {
                [point]: () => {
                  throw new SimulatedCrash(point);
                },
              },
            },
          ),
        ).rejects.toThrow(SimulatedCrash);
        const after = await ringRow(ORG_A);
        expect(after.w.equals(before.w)).toBe(true);
        expect(after.p).toEqual(before.p);
        await ringStillReadable();
        expect(totalOf(await run(["m34"], "verify"), "m34")?.legacyOnly).toBe(2);
      },
    );

    it("a read-back that fails puts the OLD bytes back and reports failed", async () => {
      const before = await ringRow(ORG_A);
      sabotage = false;
      const report = await run(
        ["m34"],
        "apply",
        {},
        {
          ...deps,
          m34Hooks: {
            afterCommit: () => {
              sabotage = true;
            },
          },
        },
      );
      sabotage = false;
      expect(totalOf(report, "m34")?.failed).toBeGreaterThanOrEqual(1);
      const after = await ringRow(ORG_A);
      expect(after.w.equals(before.w)).toBe(true);
      expect(after.p).toEqual(before.p);
      await ringStillReadable();
    });

    it("a crash AFTER commit leaves a fully valid new ring; the next run finds it current", async () => {
      await expect(
        run(
          ["m34"],
          "apply",
          { organizationIds: [ORG_A] },
          {
            ...deps,
            m34Hooks: {
              afterCommit: () => {
                throw new SimulatedCrash("afterCommit");
              },
            },
          },
        ),
      ).rejects.toThrow(SimulatedCrash);
      const ring = await ringRow(ORG_A);
      // independent oracle: the stored bytes open under the NEW label and not the legacy one
      expect(currentOracle.unwrapDek(KEK1, "kek-1", ORG_A, ring.w).equals(DEK_A2)).toBe(true);
      expect(fails(() => legacyOracle.unwrapDek(KEK1, "kek-1", ORG_A, ring.w))).toBe(true);
      await ringStillReadable();
      const verify = await run(["m34"], "verify");
      expect(totalOf(verify, "m34")).toMatchObject({ scanned: 2, current: 1, legacyOnly: 1 });
    });

    it("converges: current DEK and every prior version re-wrapped, same KEK ids, same DEKs, idempotent", async () => {
      const applied = await run(["m34"], "apply");
      expect(totalOf(applied, "m34")).toMatchObject({ resealed: 1, current: 1, failed: 0 });
      expect(totalOf(await run(["m34"], "verify"), "m34")?.legacyOnly).toBe(0);
      expect(totalOf(await run(["m34"], "apply"), "m34")?.resealed).toBe(0);
      const a = await ringRow(ORG_A);
      expect(a.k).toBe("kek-1");
      expect(currentOracle.unwrapDek(KEK1, "kek-1", ORG_A, a.w).equals(DEK_A2)).toBe(true);
      const prior = a.p[0];
      expect(prior).toMatchObject({
        version: "v1",
        kekId: "kek-0",
        rotatedAt: "2026-10-08T00:00:00.000Z",
      });
      const priorBytes = Buffer.from(prior?.kekWrappedCiphertext as string, "base64");
      expect(currentOracle.unwrapDek(KEK0, "kek-0", ORG_A, priorBytes).equals(DEK_A1)).toBe(true);
      expect(fails(() => legacyOracle.unwrapDek(KEK0, "kek-0", ORG_A, priorBytes))).toBe(true);
      const b = await ringRow(ORG_B);
      expect(currentOracle.unwrapDek(KEK1, "kek-1", ORG_B, b.w).equals(DEK_B1)).toBe(true);
      await ringStillReadable();
    });
  });

  // ── M5 ──
  describe("M5 sensitive identifiers (envelope + SSN blind index)", () => {
    const ssn = "123456789";
    const ids = {
      ssn1: randomUUID(),
      ssn2: randomUUID(),
      state: randomUUID(),
      other: randomUUID(),
      orgB: randomUUID(),
    };
    let patientA = "";
    let patientB = "";
    let patientOrgB = "";

    async function insertIdentifier(
      org: string,
      patientId: string,
      id: string,
      kind: "ssn" | "state_id",
      dek: Buffer,
      version: string,
      plaintext: string,
      prefix: "wardenx" | "chartwarden",
    ) {
      const o = prefix === "wardenx" ? legacyOracle : currentOracle;
      await admin.query(
        `INSERT INTO patient_identifier (id, patient_id, organization_id, kind, value, value_encrypted, value_last4,
            value_blind_index, value_dek_version, issuer, effective_from)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,'2026-01-01')`,
        [
          id,
          patientId,
          org,
          kind,
          o.identifier(dek, version, org, id, kind, plaintext),
          plaintext.slice(-4),
          kind === "ssn" ? o.ssnIndex(dek, org, plaintext) : null,
          version,
          kind === "state_id" ? "OR" : null,
        ],
      );
    }

    beforeAll(async () => {
      const mk = async (org: string, mrn: string) =>
        (
          await q<{ id: string }>(
            "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,$2,'Jane','Doe','1950-01-01','F','active') RETURNING id",
            [org, mrn],
          )
        )[0]?.id as string;
      patientA = await mk(ORG_A, "MRN-A1");
      patientB = await mk(ORG_A, "MRN-A2");
      patientOrgB = await mk(ORG_B, "MRN-B1");
      // two SSNs on different DEK versions (v1 = a PRIOR version, v2 = current), one state id, one already-current SSN, one in org B
      await insertIdentifier(ORG_A, patientA, ids.ssn1, "ssn", DEK_A1, "v1", ssn, "wardenx");
      await insertIdentifier(
        ORG_A,
        patientB,
        ids.ssn2,
        "ssn",
        DEK_A2,
        "v2",
        "987654321",
        "wardenx",
      );
      await insertIdentifier(
        ORG_A,
        patientA,
        ids.state,
        "state_id",
        DEK_A2,
        "v2",
        "OR1234567",
        "wardenx",
      );
      await insertIdentifier(
        ORG_A,
        patientB,
        ids.other,
        "state_id",
        DEK_A2,
        "v2",
        "OR7654321",
        "chartwarden",
      );
      await insertIdentifier(
        ORG_B,
        patientOrgB,
        ids.orgB,
        "ssn",
        DEK_B1,
        "v1",
        "111223333",
        "wardenx",
      );
    });

    const stored = async (id: string) =>
      (
        await q<{ e: Buffer; i: Buffer | null; v: string }>(
          "SELECT value_encrypted AS e, value_blind_index AS i, value_dek_version AS v FROM patient_identifier WHERE id=$1",
          [id],
        )
      )[0] as { e: Buffer; i: Buffer | null; v: string };

    it("converges; the stored bytes open under the NEW label only, the index is the NEW token, nothing else moved", async () => {
      const untouched = await stored(ids.other);
      await converge("m5", 4); // ssn1, ssn2, state, orgB (the chartwarden-sealed one is already current)
      expect((await stored(ids.other)).e.equals(untouched.e)).toBe(true);

      const s1 = await stored(ids.ssn1);
      // re-sealed under the CURRENT DEK (v2): the version column follows the key that sealed it
      expect(s1.v).toBe("v2");
      expect(currentOracle.openIdentifier(DEK_A2, ORG_A, ids.ssn1, "ssn", s1.e)).toBe(ssn);
      expect(fails(() => legacyOracle.openIdentifier(DEK_A2, ORG_A, ids.ssn1, "ssn", s1.e))).toBe(
        true,
      );
      expect(s1.i?.equals(currentOracle.ssnIndex(DEK_A2, ORG_A, ssn))).toBe(true);
      expect(s1.i?.equals(legacyOracle.ssnIndex(DEK_A2, ORG_A, ssn))).toBe(false);
      const st = await stored(ids.state);
      expect(currentOracle.openIdentifier(DEK_A2, ORG_A, ids.state, "state_id", st.e)).toBe(
        "OR1234567",
      );
      expect(st.i).toBeNull();
      const sb = await stored(ids.orgB);
      expect(currentOracle.openIdentifier(DEK_B1, ORG_B, ids.orgB, "ssn", sb.e)).toBe("111223333");
    });

    it("the duplicate-SSN matcher still finds the patient through the real cipher and Postgres", async () => {
      const cipher = deps.identifierCipher as NonNullable<BackfillDeps["identifierCipher"]>;
      const hits = await withOrgContext(app.db, systemOrgContext(ORG_A), (tx) =>
        findSsnHitPatientIds(tx, cipher, ORG_A, ssn),
      );
      expect([...hits]).toEqual([patientA]);
      const none = await withOrgContext(app.db, systemOrgContext(ORG_A), (tx) =>
        findSsnHitPatientIds(tx, cipher, ORG_A, "555443333"),
      );
      expect(none.size).toBe(0);
    });

    it("a concurrent edit is not overwritten (compare-and-swap) and an unreadable row is left alone", async () => {
      const id = randomUUID();
      await insertIdentifier(ORG_A, patientB, id, "state_id", DEK_A2, "v2", "OR0000001", "wardenx");
      const cipher = deps.identifierCipher as NonNullable<BackfillDeps["identifierCipher"]>;
      const scan = m5IdentifierScan({ db: app.db, cipher }, ORG_A);
      const [row] = (await scan.page(null, 500)).filter((r) => r.id === id);
      expect(row).toBeDefined();
      const racing = currentOracle.identifier(DEK_A2, "v2", ORG_A, id, "state_id", "OR9999999");
      await admin.query("UPDATE patient_identifier SET value_encrypted=$2 WHERE id=$1", [
        id,
        racing,
      ]);
      expect(await scan.reseal(row as NonNullable<typeof row>)).toBe("skipped");
      expect((await stored(id)).e.equals(racing)).toBe(true);
      // corrupt row: reported unreadable, never rewritten
      const junk = Buffer.from(racing);
      junk[junk.length - 1] = (junk[junk.length - 1] as number) ^ 0xff;
      await admin.query("UPDATE patient_identifier SET value_encrypted=$2 WHERE id=$1", [id, junk]);
      const report = await run(["m5"], "apply");
      expect(totalOf(report, "m5")).toMatchObject({ unreadable: 1, resealed: 0 });
      expect((await stored(id)).e.equals(junk)).toBe(true);
      await admin.query("DELETE FROM patient_identifier WHERE id=$1", [id]);
    });

    it("an interrupted run resumes: stop after one row, then finish", async () => {
      const mine = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of mine) {
        await insertIdentifier(
          ORG_A,
          patientB,
          id,
          "state_id",
          DEK_A2,
          "v2",
          "OR1111111",
          "wardenx",
        );
      }
      let seen = 0;
      const first = await run(["m5"], "apply", {
        organizationIds: [ORG_A],
        interrupted: () => seen++ >= 1,
      });
      expect(totalOf(first, "m5")?.resealed).toBeLessThanOrEqual(1);
      expect(first.modules[0]?.tables[0]?.stoppedBy).toBe("interrupted");
      const left = totalOf(await run(["m5"], "verify"), "m5")?.legacyOnly as number;
      expect(left).toBeGreaterThanOrEqual(2);
      const rest = await run(["m5"], "apply");
      expect(totalOf(rest, "m5")?.resealed).toBe(left);
      expect(totalOf(await run(["m5"], "verify"), "m5")?.legacyOnly).toBe(0);
      await admin.query("DELETE FROM patient_identifier WHERE id = ANY($1)", [mine]);
    });
  });

  // ── M23 ──
  describe("M23 MAC portal credentials", () => {
    const ctx = (org: string, i: number) => ({
      providerEntityId: pe[org]?.[i] as string,
      macJurisdiction: "noridian_jf",
    });
    const insert = async (
      org: string,
      i: number,
      secret: string,
      prefix: "wardenx" | "chartwarden",
    ) => {
      const o = prefix === "wardenx" ? legacyOracle : currentOracle;
      await admin.query(
        `INSERT INTO mac_submitter_credential (organization_id, provider_entity_id, mac_jurisdiction, submitter_id,
            trading_partner_id, client_id, client_secret_cipher, client_secret_dek_version, set_by_membership_id)
         VALUES ($1,$2,'noridian_jf','sub','tp','cid',$3,2,$4)`,
        [org, pe[org]?.[i], o.macSecret(M24_KEK, org, ctx(org, i), secret), randomUUID()],
      );
    };
    const stored = async (org: string, i: number) =>
      (
        await q<{ c: string }>(
          "SELECT client_secret_cipher AS c FROM mac_submitter_credential WHERE provider_entity_id=$1",
          [pe[org]?.[i]],
        )
      )[0]?.c as string;

    beforeAll(async () => {
      await insert(ORG_A, 0, "secret-a0", "wardenx");
      await insert(ORG_A, 1, "secret-a1", "wardenx");
      await insert(ORG_A, 2, "secret-a2", "chartwarden"); // already current
      await insert(ORG_B, 0, "secret-b0", "wardenx");
    });

    it("converges; the stored value opens under the NEW label only; the already-current row is untouched", async () => {
      const untouched = await stored(ORG_A, 2);
      await converge("m23", 3);
      expect(await stored(ORG_A, 2)).toBe(untouched);
      for (const [org, i, secret] of [
        [ORG_A, 0, "secret-a0"],
        [ORG_A, 1, "secret-a1"],
        [ORG_B, 0, "secret-b0"],
      ] as const) {
        const c = await stored(org, i);
        expect(currentOracle.openMacSecret(M24_KEK, org, ctx(org, i), c)).toBe(secret);
        expect(fails(() => legacyOracle.openMacSecret(M24_KEK, org, ctx(org, i), c))).toBe(true);
      }
    });

    it("a concurrent edit between the page read and the write is not lost", async () => {
      await admin.query("DELETE FROM mac_submitter_credential WHERE provider_entity_id=$1", [
        pe[ORG_A]?.[0],
      ]);
      await insert(ORG_A, 0, "old-secret", "wardenx");
      const scan = m23MacCredentialScan({ db: app.db, cipher: deps.macCipher as never }, ORG_A);
      const [row] = await scan
        .page(null, 50)
        .then((rows) => rows.filter((r) => r.providerEntityId === pe[ORG_A]?.[0]));
      const edited = currentOracle.macSecret(M24_KEK, ORG_A, ctx(ORG_A, 0), "edited-by-user");
      await admin.query(
        "UPDATE mac_submitter_credential SET client_secret_cipher=$2 WHERE provider_entity_id=$1",
        [pe[ORG_A]?.[0], edited],
      );
      expect(await scan.reseal(row as NonNullable<typeof row>)).toBe("skipped");
      expect(await stored(ORG_A, 0)).toBe(edited);
    });
  });

  // ── M24 ──
  describe("M24 trading-partner credentials", () => {
    const insert = async (
      org: string,
      i: number,
      state: string,
      cols: [string | null, string | null, string | null],
    ) =>
      (
        await q<{ id: string }>(
          `INSERT INTO state_medicaid_trading_partner_credential (organization_id, provider_entity_id, service_state, channel,
              trading_partner_id, client_id, client_secret_cipher, sftp_key_cipher, additional_config_cipher, active_from,
              created_by_membership_id, updated_by_membership_id)
           VALUES ($1,$2,$3,'direct_mmis','TP','cid',$4,$5,$6, now() - interval '1 day', $7, $7) RETURNING id`,
          [org, pe[org]?.[i], state, cols[0], cols[1], cols[2], randomUUID()],
        )
      )[0]?.id as string;
    const stored = async (id: string) =>
      (
        await q<{ a: string | null; b: string | null; c: string | null }>(
          "SELECT client_secret_cipher AS a, sftp_key_cipher AS b, additional_config_cipher AS c FROM state_medicaid_trading_partner_credential WHERE id=$1",
          [id],
        )
      )[0] as { a: string | null; b: string | null; c: string | null };
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      const L = (s: string) => legacyOracle.credential(M24_KEK, ORG_A, s);
      const C = (s: string) => currentOracle.credential(M24_KEK, ORG_A, s);
      ids.both = await insert(ORG_A, 0, "OR", [L("client-secret"), L("sftp-key"), null]);
      ids.mixed = await insert(ORG_A, 1, "WA", [C("already-new"), L("legacy-sftp"), null]); // one column current, one legacy
      ids.placeholder = await insert(ORG_A, 2, "CA", ["ENC:deferred", null, null]); // pre-crypto placeholder: no usable secret
      ids.current = await insert(ORG_B, 0, "OR", [
        currentOracle.credential(M24_KEK, ORG_B, "b-secret"),
        null,
        null,
      ]);
    });

    it("converges; every legacy column re-sealed, current columns and the placeholder untouched", async () => {
      const mixedBefore = await stored(ids.mixed as string);
      const placeholderBefore = await stored(ids.placeholder as string);
      await converge("m24", 2); // "both" and "mixed" are legacy rows
      const both = await stored(ids.both as string);
      expect(currentOracle.openCredential(M24_KEK, ORG_A, both.a as string)).toBe("client-secret");
      expect(currentOracle.openCredential(M24_KEK, ORG_A, both.b as string)).toBe("sftp-key");
      expect(fails(() => legacyOracle.openCredential(M24_KEK, ORG_A, both.a as string))).toBe(true);
      const mixed = await stored(ids.mixed as string);
      expect(mixed.a).toBe(mixedBefore.a); // the already-current column is byte-identical
      expect(currentOracle.openCredential(M24_KEK, ORG_A, mixed.b as string)).toBe("legacy-sftp");
      expect(await stored(ids.placeholder as string)).toEqual(placeholderBefore);
    });

    it("a concurrent edit is not overwritten", async () => {
      const id = await insert(ORG_A, 2, "NV", [
        legacyOracle.credential(M24_KEK, ORG_A, "v0"),
        null,
        null,
      ]);
      const scan = m24TradingPartnerScan({ db: app.db, kek: M24_KEK }, ORG_A);
      const [row] = (await scan.page(null, 50)).filter((r) => r.id === id);
      const edited = currentOracle.credential(M24_KEK, ORG_A, "edited");
      await admin.query(
        "UPDATE state_medicaid_trading_partner_credential SET client_secret_cipher=$2 WHERE id=$1",
        [id, edited],
      );
      expect(await scan.reseal(row as NonNullable<typeof row>)).toBe("skipped");
      expect((await stored(id)).a).toBe(edited);
    });
  });

  // ── M35 ──
  describe("M35 pseudonym key material (platform-wide)", () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const read = async () =>
      q<{ k: string; c: string; ref: string }>(
        "SELECT key_epoch AS k, key_material_ciphertext AS c, key_kms_ref AS ref FROM patient_pseudonym_key ORDER BY key_epoch",
      );
    beforeAll(async () => {
      await admin.query(
        `INSERT INTO patient_pseudonym_key (key_epoch, key_material_ciphertext, key_kms_ref, is_active, activated_at, retired_at)
         VALUES ('epoch-old', $1, 'pk-0', false, now() - interval '1 year', now() - interval '1 day'),
                ('epoch-new', $2, 'pk-1', true, now() - interval '1 day', NULL)`,
        [
          legacyOracle.pseudonym(PK_RETIRED, "pk-0", "epoch-old", keyA),
          legacyOracle.pseudonym(PK_ACTIVE, "pk-1", "epoch-new", keyB),
        ],
      );
    });

    it("converges; retired and active epochs re-sealed under their OWN KEK; the KEK reference is unchanged", async () => {
      const report = await run(["m35"], "verify");
      expect(totalOf(report, "m35")).toMatchObject({ scanned: 2, legacyOnly: 2 });
      expect(report.modules[0]?.tables).toHaveLength(1); // platform-wide: once, not per tenant
      await converge("m35", 2);
      const rows = await read();
      const old = rows.find((r) => r.k === "epoch-old");
      const fresh = rows.find((r) => r.k === "epoch-new");
      expect(old?.ref).toBe("pk-0");
      expect(fresh?.ref).toBe("pk-1");
      expect(
        currentOracle.openPseudonym(PK_RETIRED, "pk-0", "epoch-old", old?.c as string).equals(keyA),
      ).toBe(true);
      expect(
        currentOracle
          .openPseudonym(PK_ACTIVE, "pk-1", "epoch-new", fresh?.c as string)
          .equals(keyB),
      ).toBe(true);
      expect(
        fails(() => legacyOracle.openPseudonym(PK_ACTIVE, "pk-1", "epoch-new", fresh?.c as string)),
      ).toBe(true);
    });
  });

  // ── M36 bodies ──
  describe("M36 message bodies and the other sealed-body tables", () => {
    let channel = "";
    const ids: Record<string, string> = {};
    const text = (name: string) => `body of ${name}`;
    const ringKeyOf = (org: string, version: string) =>
      org === ORG_A ? (version === "v1" ? DEK_A1 : DEK_A2) : DEK_B1;

    const insertMessage = async (
      name: string,
      sealed: Buffer,
      plaintext = text(name),
      org = ORG_A,
    ) => {
      const chan =
        org === ORG_A
          ? channel
          : ((
              await q<{ id: string }>(
                `INSERT INTO channel (organization_id, channel_kind, dm_participant_key, title, retention_class)
         VALUES ($1,'dm','b:peer','DM','care_related') RETURNING id`,
                [org],
              )
            )[0]?.id as string);
      return (
        await q<{ id: string }>(
          `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, body_kind)
           VALUES ($1,$2,$3,'user',$4,$5,'plain') RETURNING id`,
          [chan, org, userOf[org], sealed, SHA(plaintext)],
        )
      )[0]?.id as string;
    };
    const cipherOf = async (table: string, col: string, id: string) =>
      (await q<{ c: Buffer }>(`SELECT ${col} AS c FROM ${table} WHERE id=$1`, [id]))[0]
        ?.c as Buffer;
    const v2Legacy = (org: string, version: string, plaintext: string) =>
      legacyOracle.bodyV2(ringKeyOf(org, version), org, version, plaintext);

    beforeAll(async () => {
      channel = (
        await q<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, dm_participant_key, title, retention_class)
           VALUES ($1,'dm','a:peer','DM','care_related') RETURNING id`,
          [ORG_A],
        )
      )[0]?.id as string;
      ids.v1 = await insertMessage("v1", legacyOracle.bodyV1(MSG_KEK, ORG_A, text("v1")));
      ids.v2 = await insertMessage("v2", v2Legacy(ORG_A, "v2", text("v2")));
      ids.v2prior = await insertMessage("v2prior", v2Legacy(ORG_A, "v1", text("v2prior")));
      ids.current = await insertMessage(
        "current",
        currentOracle.bodyV2(DEK_A2, ORG_A, "v2", text("current")),
      );
      ids.held = await insertMessage("held", v2Legacy(ORG_A, "v2", text("held")));
      ids.orgB = await insertMessage(
        "orgB",
        v2Legacy(ORG_B, "v1", text("orgB")),
        text("orgB"),
        ORG_B,
      );
      // a revision (append-only for the app role), a poll with two options (v1 and v2), a draft and a scheduled message
      await admin.query(
        `INSERT INTO message_revision (organization_id, message_id, revision_no, body_cipher, body_sha256, body_kind, body_written_at, edited_by)
         VALUES ($1,$2,1,$3,$4,'plain', now(), $5)`,
        [
          ORG_A,
          ids.v2,
          v2Legacy(ORG_A, "v2", "first draft of v2"),
          SHA("first draft of v2"),
          userOf[ORG_A],
        ],
      );
      ids.revision = (
        await q<{ id: string }>("SELECT id FROM message_revision WHERE organization_id=$1", [ORG_A])
      )[0]?.id as string;
      const poll = (
        await q<{ id: string }>(
          `INSERT INTO message_poll (organization_id, channel_id, message_id, created_by_user_id) VALUES ($1,$2,$3,$4) RETURNING id`,
          [ORG_A, channel, ids.v1, userOf[ORG_A]],
        )
      )[0]?.id as string;
      ids.optionV1 = (
        await q<{ id: string }>(
          `INSERT INTO message_poll_option (organization_id, poll_id, position, label_cipher) VALUES ($1,$2,0,$3) RETURNING id`,
          [ORG_A, poll, legacyOracle.bodyV1(MSG_KEK, ORG_A, "Yes")],
        )
      )[0]?.id as string;
      ids.optionV2 = (
        await q<{ id: string }>(
          `INSERT INTO message_poll_option (organization_id, poll_id, position, label_cipher) VALUES ($1,$2,1,$3) RETURNING id`,
          [ORG_A, poll, v2Legacy(ORG_A, "v2", "No")],
        )
      )[0]?.id as string;
      ids.draft = (
        await q<{ id: string }>(
          `INSERT INTO message_draft (organization_id, channel_id, user_id, body_cipher, device_id) VALUES ($1,$2,$3,$4,'dev-1') RETURNING id`,
          [ORG_A, channel, userOf[ORG_A], v2Legacy(ORG_A, "v2", "draft text")],
        )
      )[0]?.id as string;
      ids.scheduled = (
        await q<{ id: string }>(
          `INSERT INTO scheduled_message (organization_id, channel_id, user_id, body_cipher, scheduled_for)
           VALUES ($1,$2,$3,$4, now() + interval '1 day') RETURNING id`,
          [ORG_A, channel, userOf[ORG_A], legacyOracle.bodyV1(MSG_KEK, ORG_A, "later")],
        )
      )[0]?.id as string;
      // Stand-in for the migration-1138 legal-hold backstop: an UPDATE of this one message's body_cipher is refused with 23001.
      await admin.query(
        `CREATE FUNCTION cl2_hold_stub() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
           IF OLD.id = '${ids.held}'::uuid THEN RAISE EXCEPTION 'held' USING ERRCODE = '23001'; END IF; RETURN NEW; END $$`,
      );
      await admin.query(
        "CREATE TRIGGER cl2_hold_stub BEFORE UPDATE OF body_cipher ON message FOR EACH ROW EXECUTE FUNCTION cl2_hold_stub()",
      );
    });

    it("refuses to report on the reseal-only tables without the reseal credential (never a silent zero)", async () => {
      await expect(
        run(["m36-body"], "verify", {}, { ...deps, resealDb: undefined }),
      ).rejects.toThrow(MissingResealCredentialError);
      await expect(
        run(["m36-body"], "verify", {}, { ...deps, bodyKit: undefined }),
      ).rejects.toThrow(MissingDependencyError);
    });

    it("--verify counts the legacy-only rows per table; --dry-run changes nothing", async () => {
      const before = await cipherOf("message", "body_cipher", ids.v2 as string);
      const report = await run(["m36-body"], "verify");
      const by = (table: string) =>
        report.modules[0]?.tables
          .filter((t) => t.table === table)
          .reduce((n, t) => n + t.counts.legacyOnly, 0);
      expect(by("message")).toBe(5); // v1, v2, v2prior, held (org A) + orgB; "current" is already new
      expect(by("message_revision")).toBe(1);
      expect(by("message_poll_option")).toBe(2);
      expect(by("message_draft")).toBe(1);
      expect(by("scheduled_message")).toBe(1);
      const dry = await run(["m36-body"], "dry-run");
      expect(totalOf(dry, "m36-body")?.resealed).toBe(0);
      expect((await cipherOf("message", "body_cipher", ids.v2 as string)).equals(before)).toBe(
        true,
      );
    });

    it("converges (the legal-held message is skipped and stays counted); scheme and ring version are unchanged", async () => {
      const applied = await run(["m36-body"], "apply");
      expect(totalOf(applied, "m36-body")).toMatchObject({
        resealed: 9,
        skipped: 1,
        failed: 0,
        unreadable: 0,
      });
      const after = await run(["m36-body"], "verify");
      expect(totalOf(after, "m36-body")?.legacyOnly).toBe(1); // exactly the held message
      // release the "hold": the next run finishes it
      await admin.query("DROP TRIGGER cl2_hold_stub ON message");
      expect(totalOf(await run(["m36-body"], "apply"), "m36-body")?.resealed).toBe(1);
      expect(totalOf(await run(["m36-body"], "verify"), "m36-body")?.legacyOnly).toBe(0);
      expect(totalOf(await run(["m36-body"], "apply"), "m36-body")?.resealed).toBe(0);

      // stored BYTES, by the independent oracle: v1 stays v1 (new HKDF label), v2 stays v2 on the SAME ring version (new AAD label)
      const v1 = await cipherOf("message", "body_cipher", ids.v1 as string);
      expect(v1[0]).toBe(1);
      expect(currentOracle.openBodyV1(MSG_KEK, ORG_A, v1)).toBe(text("v1"));
      expect(fails(() => legacyOracle.openBodyV1(MSG_KEK, ORG_A, v1))).toBe(true);
      const v2 = await cipherOf("message", "body_cipher", ids.v2 as string);
      expect(v2[0]).toBe(2);
      expect(currentOracle.openBodyV2(DEK_A2, ORG_A, v2)).toBe(text("v2"));
      expect(fails(() => legacyOracle.openBodyV2(DEK_A2, ORG_A, v2))).toBe(true);
      const prior = await cipherOf("message", "body_cipher", ids.v2prior as string);
      expect(prior.subarray(2, 4).toString()).toBe("v1"); // ring version v1 kept (a PRIOR key version)
      expect(currentOracle.openBodyV2(DEK_A1, ORG_A, prior)).toBe(text("v2prior"));
      expect(
        currentOracle.openBodyV2(
          DEK_B1,
          ORG_B,
          await cipherOf("message", "body_cipher", ids.orgB as string),
        ),
      ).toBe(text("orgB"));
      const rev = await cipherOf("message_revision", "body_cipher", ids.revision as string);
      expect(currentOracle.openBodyV2(DEK_A2, ORG_A, rev)).toBe("first draft of v2");
      expect(
        currentOracle.openBodyV1(
          MSG_KEK,
          ORG_A,
          await cipherOf("message_poll_option", "label_cipher", ids.optionV1 as string),
        ),
      ).toBe("Yes");
      expect(
        currentOracle.openBodyV2(
          DEK_A2,
          ORG_A,
          await cipherOf("message_poll_option", "label_cipher", ids.optionV2 as string),
        ),
      ).toBe("No");
      expect(
        currentOracle.openBodyV2(
          DEK_A2,
          ORG_A,
          await cipherOf("message_draft", "body_cipher", ids.draft as string),
        ),
      ).toBe("draft text");
      expect(
        currentOracle.openBodyV1(
          MSG_KEK,
          ORG_A,
          await cipherOf("scheduled_message", "body_cipher", ids.scheduled as string),
        ),
      ).toBe("later");
      // the plaintext digest was never touched
      const sha = (
        await q<{ s: string }>("SELECT body_sha256 AS s FROM message WHERE id=$1", [ids.v2])
      )[0]?.s;
      expect(sha).toBe(SHA(text("v2")));
    });

    it("the swap function refuses a change of shape: another scheme, another ring version, another length", async () => {
      const client = new Client({ connectionString: urls.reseal });
      await client.connect();
      try {
        const old = await cipherOf("message_draft", "body_cipher", ids.draft as string);
        const call = async (newC: Buffer, org = ORG_A) => {
          await client.query("BEGIN");
          try {
            await client.query("SELECT set_config('app.org_id', $1, true)", [org]);
            const r = await client.query(
              "SELECT m36_label_backfill_swap('message_draft', $1, $2, $3, $4) AS ok",
              [org, ids.draft, old, newC],
            );
            return r.rows[0].ok as boolean;
          } finally {
            await client.query("ROLLBACK");
          }
        };
        const v1Shape = currentOracle.bodyV1(MSG_KEK, ORG_A, "x"); // scheme 1 over a scheme 2 row
        await expect(call(v1Shape)).rejects.toThrow();
        const otherVersion = currentOracle.bodyV2(DEK_A1, ORG_A, "v9", "draft text"); // different ring label (and length)
        await expect(call(otherVersion)).rejects.toThrow();
        const longer = Buffer.concat([old, Buffer.from([0])]);
        await expect(call(longer)).rejects.toThrow();
        expect(await call(Buffer.from(old), ORG_B)).toBe(false); // another tenant's session matches no row of this tenant
        const foreign = new Client({ connectionString: urls.reseal });
        await foreign.connect();
        try {
          await foreign.query("BEGIN");
          await foreign.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          // a session bound to org A cannot name org B
          await expect(
            foreign.query("SELECT m36_label_backfill_swap('message_draft', $1, $2, $3, $4)", [
              ORG_B,
              ids.draft,
              old,
              old,
            ]),
          ).rejects.toThrow();
        } finally {
          await foreign.query("ROLLBACK").catch(() => undefined);
          await foreign.end();
        }
        await expect(
          client.query("SELECT m36_label_backfill_swap('message', $1, $2, $3, $4)", [
            ORG_A,
            ids.v1,
            old,
            old,
          ]),
        ).rejects.toThrow(); // unknown table
      } finally {
        await client.end();
      }
    });
  });

  // ── M36 search index + name-exclusion digests ──
  describe("M36 search index and name-exclusion digests", () => {
    const VERSION = "v2";
    const BITS = 16;
    let chan = "";
    const msgs: string[] = [];
    const TEXTS = [
      "Zebrowski needs morphine tonight",
      "family meeting about hospice care",
      "oxygen refill scheduled",
    ];

    const storedTags = async (id: string) =>
      new Set(
        (
          await q<{ tag: number }>("SELECT tag FROM message_search_token WHERE message_id=$1", [id])
        ).map((r) => r.tag),
      );
    const channelKey = (o: typeof legacyOracle, channelId: string) =>
      o.channelKey(o.searchKey(DEK_A2, ORG_A, VERSION), VERSION, BITS, channelId);
    /** The token's whole-word tag, independent of the module: top BITS bits of HMAC-SHA256(channelKey, "w\0<token>"). */
    const wordTag = (key: Buffer, token: string): number =>
      createHmac("sha256", key).update(`w\u0000${token}`, "utf8").digest().readUInt32BE(0) >>>
      (32 - BITS);

    beforeAll(async () => {
      chan = (
        await q<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, dm_participant_key, title, retention_class)
           VALUES ($1,'dm','s:peer','DM','care_related') RETURNING id`,
          [ORG_A],
        )
      )[0]?.id as string;
      for (const t of TEXTS) {
        msgs.push(
          (
            await q<{ id: string }>(
              `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, body_kind)
               VALUES ($1,$2,$3,'user',$4,$5,'plain') RETURNING id`,
              [chan, ORG_A, userOf[ORG_A], currentOracle.bodyV2(DEK_A2, ORG_A, "v2", t), SHA(t)],
            )
          )[0]?.id as string,
        );
      }
      // The index as production holds it: tags under the LEGACY labels, "zebrowski" excluded by its LEGACY-key digest.
      await admin.query(
        `INSERT INTO message_search_index_state (organization_id, key_version, tag_bits, status, reconciled_at,
            excluded_name_digests, exclusion_synced_at)
         VALUES ($1,$2,$3,'ready', now(), $4, now())`,
        [
          ORG_A,
          VERSION,
          BITS,
          [legacyOracle.nameDigest(legacyOracle.searchKey(DEK_A2, ORG_A, VERSION), "zebrowski")],
        ],
      );
      const legacyKey = channelKey(legacyOracle, chan);
      const excluded = {
        has: (token: string) =>
          legacyOracle.nameDigest(legacyOracle.searchKey(DEK_A2, ORG_A, VERSION), token) ===
            legacyOracle.nameDigest(legacyOracle.searchKey(DEK_A2, ORG_A, VERSION), "zebrowski") &&
          token === "zebrowski",
      };
      for (const [i, t] of TEXTS.entries()) {
        const tags = buildMessageTags(legacyKey, t, BITS, excluded);
        await admin.query(
          `INSERT INTO message_search_token (organization_id, key_version, channel_id, tag, message_id)
           SELECT $1,$2,$3,unnest($4::int[]),$5`,
          [ORG_A, VERSION, chan, tags, msgs[i]],
        );
      }
      await admin.query(
        `INSERT INTO tenant_messaging_search_setting (organization_id, enabled, changed_at) VALUES ($1,true,now())
         ON CONFLICT (organization_id) DO UPDATE SET enabled=true`,
        [ORG_A],
      );
      await admin.query(
        `INSERT INTO feature_flag (organization_id, flag_key, flag_kind, value_type, value)
         VALUES (NULL,'messaging.global_search_platform_enabled','product','bool','true'::jsonb)`,
      );
    });

    it("--verify sees every indexed message as legacy-tagged", async () => {
      const report = await run(["m36-search"], "verify", { organizationIds: [ORG_A] });
      expect(totalOf(report, "m36-search")).toMatchObject({
        legacyOnly: 3,
        current: 0,
        ignored: 5,
      }); // the 5 message-body fixtures are not indexed;
      // the independent oracle agrees: the stored tags contain the LEGACY word tags and not the new ones
      const legacy = channelKey(legacyOracle, chan);
      const current = channelKey(currentOracle, chan);
      const tags = await storedTags(msgs[1] as string);
      for (const token of tokenizeForSearch(TEXTS[1] as string)) {
        expect(tags.has(wordTag(legacy, token))).toBe(true);
        expect(tags.has(wordTag(current, token))).toBe(false);
      }
    });

    it("until the rewrite, a NEW message is indexed under the new labels with the name still excluded (legacy digest honoured)", async () => {
      const t = "Zebrowski asks for the chaplain";
      const id = (
        await q<{ id: string }>(
          `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, body_kind)
           VALUES ($1,$2,$3,'user',$4,$5,'plain') RETURNING id`,
          [chan, ORG_A, userOf[ORG_A], currentOracle.bodyV2(DEK_A2, ORG_A, "v2", t), SHA(t)],
        )
      )[0]?.id as string;
      msgs.push(id);
      TEXTS.push(t);
      expect(
        await (deps.search as NonNullable<BackfillDeps["search"]>).writer.indexMessage(ORG_A, id),
      ).toBe("indexed");
      const tags = await storedTags(id);
      const current = channelKey(currentOracle, chan);
      expect(tags.has(wordTag(current, "chaplain"))).toBe(true); // indexed under the NEW labels
      expect(tags.has(wordTag(current, "zebrowski"))).toBe(false); // the name is NOT indexed in the clear
    });

    it("apply rewrites every message under the new labels, adds the new-label digests, clears the pending list; verify is zero", async () => {
      const applied = await run(["m36-search"], "apply", { organizationIds: [ORG_A] });
      expect(totalOf(applied, "m36-search")).toMatchObject({ resealed: 3, failed: 0, skipped: 0 });
      expect(
        totalOf(await run(["m36-search"], "verify", { organizationIds: [ORG_A] }), "m36-search"),
      ).toMatchObject({
        legacyOnly: 0,
        current: 4,
      });
      const legacy = channelKey(legacyOracle, chan);
      const current = channelKey(currentOracle, chan);
      for (const [i, t] of TEXTS.entries()) {
        const tags = await storedTags(msgs[i] as string);
        for (const token of tokenizeForSearch(t, { has: (x) => x === "zebrowski" })) {
          expect(tags.has(wordTag(current, token)), `${token} under the new labels`).toBe(true);
        }
        expect(tags.has(wordTag(current, "zebrowski"))).toBe(false); // excluded in every rewritten message
        expect(tags.has(wordTag(legacy, "morphine"))).toBe(false); // no legacy-set tag survives
      }
      const [state] = await q<{ digests: string[]; pending: string[] }>(
        "SELECT excluded_name_digests AS digests, exclusion_pending AS pending FROM message_search_index_state WHERE organization_id=$1 AND key_version=$2",
        [ORG_A, VERSION],
      );
      const newDigest = currentOracle.nameDigest(
        currentOracle.searchKey(DEK_A2, ORG_A, VERSION),
        "zebrowski",
      );
      const oldDigest = legacyOracle.nameDigest(
        legacyOracle.searchKey(DEK_A2, ORG_A, VERSION),
        "zebrowski",
      );
      expect(state?.digests).toEqual(expect.arrayContaining([newDigest, oldDigest])); // grow-only: both kept
      expect(newDigest).not.toBe(oldDigest); // the digest DOES change with the flip
      expect(state?.pending ?? []).toEqual([]); // nothing left to reindex
      expect(
        totalOf(await run(["m36-search"], "apply", { organizationIds: [ORG_A] }), "m36-search")
          ?.resealed,
      ).toBe(0);
    });

    it("search still answers through the real query path: the dual probe finds new-label rows", async () => {
      const keys = (deps.search as NonNullable<BackfillDeps["search"]>).keys;
      const sets = await keys.tagKeysForRead(ORG_A, VERSION);
      expect(sets.map((s) => s.labels.searchInfoPrefix)).toEqual([
        "chartwarden-message-search:",
        "wardenx-message-search:",
      ]);
    });
  });

  // ── M36 export jobs (count-only) ──
  describe("M36 export job keys (count-only: they expire on their own)", () => {
    it("counts a legacy-wrapped key and never rewrites it", async () => {
      const chan = (
        await q<{ id: string }>("SELECT id FROM channel WHERE organization_id=$1 LIMIT 1", [ORG_A])
      )[0]?.id as string;
      const wrapped = `kek-1:${b64(legacyOracle.wrapDek(KEK1, "kek-1", ORG_A, randomBytes(32)))}`;
      const c = new Client({ connectionString: DB_URL });
      await c.connect();
      try {
        await c.query("SET session_replication_role = replica");
        await c.query(
          `INSERT INTO message_export_job (organization_id, requested_by, scope_kind, channel_id, justification, status,
              decided_by, decided_at, ready_at, expires_at, wrapped_dek)
           VALUES ($1,$2,'channel',$3,'incident review for the quality committee','ready',$4,now(), now(), now() + interval '24 hours',$5)`,
          [ORG_A, userOf[ORG_A], chan, userOf[ORG_B], wrapped],
        );
      } finally {
        await c.end();
      }
      const report = await run(["m36-export"], "verify");
      expect(totalOf(report, "m36-export")).toMatchObject({ legacyOnly: 1, unreadable: 0 });
      const applied = await run(["m36-export"], "apply");
      expect(totalOf(applied, "m36-export")).toMatchObject({ resealed: 0, skipped: 1 });
      expect(
        (await q<{ w: string }>("SELECT wrapped_dek AS w FROM message_export_job"))[0]?.w,
      ).toBe(wrapped);
      await admin.query("DELETE FROM message_export_job");
    });
  });

  // ── the whole tool ──
  describe("the release-3 gate: --verify over every module", () => {
    it("reports zero legacy-only and zero unreadable rows across all modules after the backfill", async () => {
      const report = await run(
        [...(["m24", "m23", "m35", "m5", "m36-body", "m36-search", "m36-export", "m34"] as const)],
        "verify",
      );
      expect(report.legacyOnlyTotal).toBe(0);
      expect(report.problemTotal).toBe(0);
      expect(report.modules.map((m) => m.module)).toEqual([
        "m24",
        "m23",
        "m35",
        "m5",
        "m36-body",
        "m36-search",
        "m36-export",
        "m34",
      ]);
    });
  });

  // ── the CLI ──
  describe("the operator CLI (bun run crypto-labels:*)", () => {
    const env = () => ({
      ...process.env,
      DATABASE_URL: urls.app,
      DATABASE_PLATFORM_URL: urls.platform,
      DATABASE_BODY_BACKFILL_URL: urls.reseal,
      M34_TENANT_KEK: `kek-1:${b64(KEK1)}`,
      M34_TENANT_KEK_RETIRED: `kek-0:${b64(KEK0)}`,
      M24_CREDENTIAL_ENCRYPTION_KEY: b64(M24_KEK),
      MESSAGING_ENCRYPTION_KEY: b64(MSG_KEK),
      M35_PSEUDONYM_KEY_KEK: `pk-1:${b64(PK_ACTIVE)}`,
      M35_PSEUDONYM_KEY_KEK_RETIRED: `pk-0:${b64(PK_RETIRED)}`,
    });
    const cli = (...args: string[]) =>
      spawnSync(
        "bun",
        ["run", join(__dirname, "../../../scripts/db/backfill-crypto-labels.ts"), ...args],
        {
          env: env(),
          encoding: "utf8",
        },
      );

    it("--verify --all-orgs prints one JSON report and exits 0 when nothing is left", () => {
      const r = cli("--verify", "--all-orgs");
      expect(r.status, r.stderr).toBe(0);
      const report = JSON.parse(r.stdout) as BackfillReport;
      expect(report.legacyOnlyTotal).toBe(0);
      expect(r.stdout).not.toMatch(/body of|secret-a0|Zebrowski/i); // counts and ids only
    });

    it("exits 2 when legacy-only rows remain, and 1 for usage errors", async () => {
      await admin.query(
        "UPDATE mac_submitter_credential SET client_secret_cipher=$2 WHERE provider_entity_id=$1",
        [
          pe[ORG_B]?.[0],
          legacyOracle.macSecret(
            M24_KEK,
            ORG_B,
            { providerEntityId: pe[ORG_B]?.[0] as string, macJurisdiction: "noridian_jf" },
            "secret-b0",
          ),
        ],
      );
      const left = cli("--verify", "--all-orgs", "--module", "m23");
      expect(left.status).toBe(2);
      expect(JSON.parse(left.stdout).legacyOnlyTotal).toBe(1);
      const fix = cli("--apply", "--all-orgs", "--module", "m23");
      expect(fix.status, fix.stderr).toBe(0);
      expect(cli("--verify", "--all-orgs", "--module", "m23").status).toBe(0);
      expect(cli("--all-orgs").status).toBe(1); // no mode
      expect(cli("--verify", "--dry-run", "--all-orgs").status).toBe(1); // two modes
      expect(cli("--verify").status).toBe(1); // no org selection
      expect(cli("--verify", "--all-orgs", "--module", "nope").status).toBe(1);
    });

    it("refuses --apply of m34 without --i-have-a-backup, before touching the database", () => {
      const r = cli("--apply", "--all-orgs", "--module", "m34");
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/--i-have-a-backup/);
    });

    it("never reports a silent zero when a module's input is missing", () => {
      const r = spawnSync(
        "bun",
        [
          "run",
          join(__dirname, "../../../scripts/db/backfill-crypto-labels.ts"),
          "--verify",
          "--all-orgs",
          "--module",
          "m24",
        ],
        {
          env: { ...env(), M24_CREDENTIAL_ENCRYPTION_KEY: "" },
          encoding: "utf8",
        },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/cannot run/);
    });
  });
});

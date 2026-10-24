/**
 * Crypto context-label rename, RELEASE 3 - the legacy labels are gone, LIVE Postgres.
 *
 * Every module is populated with values sealed under the LEGACY ("wardenx") label AND values sealed under the current
 * ("chartwarden") label by an independent oracle (`_crypto-label-oracle.ts`: literal label strings + node:crypto, no import from the
 * code under test). The real application ciphers and the read-only verifier (scripts/db/backfill-crypto-labels.ts) then read them as
 * the NOBYPASSRLS `chartwarden_app` role (and the platform login for the key ring / pseudonym keys):
 *   - a value under the chartwarden label opens and is reported "current";
 *   - a value still under the wardenx label FAILS CLOSED (the module's generic error, no label named) and is reported "unreadable"
 *     - this is exactly the data loss the merge gate in migration 1152 exists to prevent;
 *   - migration 1152 removed the 1150 backfill functions, policies and owner role, and kept the reseal carrier and its login.
 *
 * Run against a PRIVATE container, never the shared cluster (it DROPs ROLEs):
 *   docker run -d --name cw-crypto-r3-pg -p 55443:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg18 \
 *     -c max_locks_per_transaction=2048
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55443/postgres bun run test:crypto-labels:backfill:live
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MissingDependencyError,
  type VerifyDeps,
  type VerifyReport,
  runVerify,
} from "../../../scripts/db/crypto-label-backfill";
import {
  type PlatformKekAdapter,
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../src/bootstrap/tenant-kek";
import {
  IdentifierCipherIntegrityError,
  createPatientIdentifierCipher,
} from "../src/modules/05-patient/identifiers/identifier-cipher";
import { buildMacSecretCipher } from "../src/modules/23-billing-medicare/routes/secret-cipher";
import { buildKeyProvider } from "../src/modules/34-saas-tenant-platform/seam-registration";
import { createRingDekCache } from "../src/modules/36-messaging/body-key-ring";
import { createNameExclusions } from "../src/modules/36-messaging/global-search/name-exclusion";
import { createBodyReader } from "../src/modules/36-messaging/global-search/ports";
import { createRingSearchKeyProvider } from "../src/modules/36-messaging/global-search/search-key-provider";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { currentOracle, legacyOracle } from "./_crypto-label-oracle";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "aaaaaaaa-0000-4000-8000-0000000c3a01";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000c3b02";
const SHA = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const b64 = (b: Buffer) => b.toString("base64");

const KEK1 = randomBytes(32); // active platform KEK  ("kek-1")
const KEK0 = randomBytes(32); // retired platform KEK ("kek-0")
const M24_KEK = randomBytes(32); // M24_CREDENTIAL_ENCRYPTION_KEY (M23 + M24)
const MSG_KEK = randomBytes(32); // MESSAGING_ENCRYPTION_KEY (v1 message bodies)
const PK_ACTIVE = randomBytes(32);
const PK_RETIRED = randomBytes(32);
const DEK_A1 = randomBytes(32); // org A ring version v1 (a PRIOR version, wrapped under the retired KEK)
const DEK_A2 = randomBytes(32); // org A ring version v2 (current)
const DEK_B1 = randomBytes(32); // org B ring version v1 (current)

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

describe.skipIf(!DB_URL)("crypto labels (release 3: legacy labels removed) - LIVE Postgres", () => {
  let admin: Client;
  let app: { db: DbClient; close: () => Promise<void> };
  let platform: { db: DbClient; close: () => Promise<void> };
  let adapter: PlatformKekAdapter;
  let deps: VerifyDeps;
  let keys: ReturnType<typeof buildKeyProvider>;
  const accountOf: Record<string, string> = {};
  const userOf: Record<string, string> = {};
  const pe: Record<string, string[]> = { [ORG_A]: [], [ORG_B]: [] };

  const urlAs = (role: string, password: string): string => {
    const u = new URL(DB_URL as string);
    u.username = role;
    u.password = password;
    return u.toString();
  };
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await admin.query(text, params)).rows as T[];

  async function seedOrg(org: string, slug: string) {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
      [org, slug],
    );
    accountOf[org] = (
      await q<{ id: string }>(
        `INSERT INTO tenant_account (organization_id, legal_business_name, billing_contact_email, breach_notification_email)
         VALUES ($1,$2,'b@cl3.example','x@cl3.example') RETURNING id`,
        [org, `${slug} LLC`],
      )
    )[0]?.id as string;
    userOf[org] = (
      await q<{ id: string }>(`INSERT INTO "user" (email, name) VALUES ($1,$1) RETURNING id`, [
        `${slug}@cl3.test`,
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

  const report = (modules: Parameters<typeof runVerify>[1]["modules"], orgs = [ORG_A, ORG_B]) =>
    runVerify(deps, { modules, organizationIds: orgs, batchSize: 2 });
  const totalOf = (r: VerifyReport, module: string) =>
    r.modules.find((m) => m.module === module)?.total;

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    // The platform login is provisioned by the operator's own script (BYPASSRLS, SELECT on tenant_key_ring / patient_pseudonym_key).
    const { spawnSync } = await import("node:child_process");
    const provision = spawnSync(
      "bun",
      ["run", join(__dirname, "../../../scripts/db/provision-runtime-roles.ts")],
      {
        env: {
          ...process.env,
          PROVISION_DATABASE_URL: DB_URL,
          CHARTWARDEN_PLATFORM_PASSWORD: "cl3-platform-password-0123456789",
          CHARTWARDEN_BODY_BACKFILL_PASSWORD: "cl3-backfill-password-0123456789",
        },
        encoding: "utf8",
      },
    );
    if (provision.status !== 0) throw new Error(`role provisioning failed: ${provision.stderr}`);
    platform = createDbClient({
      connectionString: urlAs("chartwarden_platform_login", "cl3-platform-password-0123456789"),
    });

    await seedOrg(ORG_A, "cl3a");
    await seedOrg(ORG_B, "cl3b");

    // Key ring: org A's CURRENT wrap carries the chartwarden label, its PRIOR version (v1) is still wrapped under the removed
    // legacy label; org B's single wrap is chartwarden.
    await admin.query(
      `INSERT INTO tenant_key_ring (organization_id, tenant_account_id, current_dek_version,
          current_dek_kek_wrapped_ciphertext, current_dek_kek_id, prior_dek_versions, dek_created_at)
       VALUES ($1,$2,'v2',$3,'kek-1',$4::jsonb, now())`,
      [
        ORG_A,
        accountOf[ORG_A],
        currentOracle.wrapDek(KEK1, "kek-1", ORG_A, DEK_A2),
        JSON.stringify([
          {
            version: "v1",
            kekWrappedCiphertext: b64(legacyOracle.wrapDek(KEK0, "kek-0", ORG_A, DEK_A1)),
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
      [ORG_B, accountOf[ORG_B], currentOracle.wrapDek(KEK1, "kek-1", ORG_B, DEK_B1)],
    );

    const ring = loadPlatformKekRing({
      M34_TENANT_KEK: `kek-1:${b64(KEK1)}`,
      M34_TENANT_KEK_RETIRED: `kek-0:${b64(KEK0)}`,
    } as NodeJS.ProcessEnv);
    if (!ring) throw new Error("expected a KEK ring");
    adapter = createPlatformKekAdapter(ring);
    keys = buildKeyProvider({
      kekUnwrap: adapter,
      runInKeyRingContext: (orgId, fn) => withOrgContext(platform.db, systemOrgContext(orgId), fn),
    });
    const ringCache = createRingDekCache(keys);
    const searchKeys = createRingSearchKeyProvider(() => ringCache);
    const bodies = createBodyReader(createMessageBodyCipher({ kek: MSG_KEK, keys, ringCache }));
    deps = {
      db: app.db,
      platformDb: platform.db,
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
        exclusions: createNameExclusions({
          db: app.db,
          keys: searchKeys,
          names: { fragmentsPage: async () => ({ fragments: [], nextAfterId: null }) },
        }),
      },
    };
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await platform?.close();
    await admin?.end();
  });

  describe("migration 1152", () => {
    it("removed the 1150 backfill functions, policies and owner role", async () => {
      expect(
        await q(
          `SELECT proname FROM pg_proc WHERE proname IN ('m36_label_backfill_page','m36_label_backfill_swap')`,
        ),
      ).toEqual([]);
      expect(
        await q(`SELECT polname FROM pg_policy WHERE polname LIKE '%label_backfill%'`),
      ).toEqual([]);
      expect(
        await q(`SELECT rolname FROM pg_roles WHERE rolname = 'chartwarden_label_backfill_owner'`),
      ).toEqual([]);
    });

    it("kept the reseal carrier and its login (still used by the legacy->ring body backfill)", async () => {
      const roles = await q<{ rolname: string }>(
        `SELECT rolname FROM pg_roles WHERE rolname IN ('chartwarden_m36_reseal','chartwarden_body_backfill_login') ORDER BY rolname`,
      );
      expect(roles.map((r) => r.rolname)).toEqual([
        "chartwarden_body_backfill_login",
        "chartwarden_m36_reseal",
      ]);
    });
  });

  describe("M34 tenant key ring", () => {
    it("a DEK wrapped under the legacy label no longer unwraps; the chartwarden-wrapped ones still do", async () => {
      expect((await keys.dekForOrg(ORG_A)).key.equals(DEK_A2)).toBe(true);
      expect((await keys.dekForOrg(ORG_B)).key.equals(DEK_B1)).toBe(true);
      await expect(keys.dekForOrgVersion(ORG_A, "v1")).rejects.toThrow();
    });

    it("the verifier reports the ring with a legacy-wrapped entry as unreadable", async () => {
      const r = await report(["m34"]);
      expect(totalOf(r, "m34")).toMatchObject({ scanned: 2, current: 1, unreadable: 1 });
      expect(r.problemTotal).toBe(1);
      expect(r.complete).toBe(true);
    });
  });

  describe("M5 sensitive identifiers (envelope + SSN blind index)", () => {
    const ssn = "123456789";
    const ids = {
      ok: randomUUID(),
      legacyEnvelope: randomUUID(),
      legacyIndexOnly: randomUUID(),
      stateOk: randomUUID(),
      stateLegacy: randomUUID(),
    };
    let patientId = "";
    const insert = (
      id: string,
      kind: "ssn" | "state_id",
      plaintext: string,
      envelopeLabel: typeof currentOracle,
      indexLabel: typeof currentOracle,
    ) =>
      admin.query(
        `INSERT INTO patient_identifier (id, patient_id, organization_id, kind, value, value_encrypted, value_last4,
            value_blind_index, value_dek_version, issuer, effective_from)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,'v2',$8,'2026-01-01')`,
        [
          id,
          patientId,
          ORG_A,
          kind,
          envelopeLabel.identifier(DEK_A2, "v2", ORG_A, id, kind, plaintext),
          plaintext.slice(-4),
          kind === "ssn" ? indexLabel.ssnIndex(DEK_A2, ORG_A, plaintext) : null,
          kind === "state_id" ? "OR" : null,
        ],
      );

    beforeAll(async () => {
      patientId = (
        await q<{ id: string }>(
          "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,'MRN-A1','Jane','Doe','1950-01-01','F','active') RETURNING id",
          [ORG_A],
        )
      )[0]?.id as string;
      await insert(ids.ok, "ssn", ssn, currentOracle, currentOracle);
      await insert(ids.legacyEnvelope, "ssn", "987654321", legacyOracle, legacyOracle);
      await insert(ids.legacyIndexOnly, "ssn", "555667777", currentOracle, legacyOracle);
      await insert(ids.stateOk, "state_id", "OR1234567", currentOracle, currentOracle);
      await insert(ids.stateLegacy, "state_id", "OR7654321", legacyOracle, legacyOracle);
    });

    it("opens the chartwarden envelope and refuses the legacy one with the generic integrity error", async () => {
      const cipher = createPatientIdentifierCipher(keys);
      const row = async (id: string) =>
        (
          await q<{ v: Buffer; k: "ssn" | "state_id" }>(
            "SELECT value_encrypted AS v, kind AS k FROM patient_identifier WHERE id=$1",
            [id],
          )
        )[0] as { v: Buffer; k: "ssn" | "state_id" };
      const ok = await row(ids.ok);
      expect(await cipher.open(ORG_A, ids.ok, ok.k, ok.v)).toBe(ssn);
      const legacy = await row(ids.legacyEnvelope);
      const err = await cipher
        .open(ORG_A, ids.legacyEnvelope, legacy.k, legacy.v)
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(IdentifierCipherIntegrityError);
      expect((err as Error).message).not.toMatch(/wardenx|chartwarden|label/i);
    });

    it("looks an SSN up by the chartwarden token only: a legacy-indexed row is not found", async () => {
      const cipher = createPatientIdentifierCipher(keys);
      const token = (await cipher.blindIndex(ORG_A, "555667777", "v2")).token;
      expect(token.equals(currentOracle.ssnIndex(DEK_A2, ORG_A, "555667777"))).toBe(true);
      const stored = (
        await q<{ t: Buffer }>(
          "SELECT value_blind_index AS t FROM patient_identifier WHERE id=$1",
          [ids.legacyIndexOnly],
        )
      )[0]?.t as Buffer;
      expect(stored.equals(token)).toBe(false);
    });

    it("the verifier counts: 2 current (ok ssn, ok state id), 3 unreadable (legacy envelope, legacy index, legacy state id)", async () => {
      const r = await report(["m5"]);
      expect(totalOf(r, "m5")).toMatchObject({ scanned: 5, current: 2, unreadable: 3 });
      expect(r.problemTotal).toBe(3);
    });
  });

  describe("M23 MAC credential", () => {
    const ctx = (i: number) => ({
      providerEntityId: pe[ORG_A]?.[i] as string,
      macJurisdiction: "noridian_jf",
    });
    beforeAll(async () => {
      for (const [i, o] of [
        [0, currentOracle],
        [1, legacyOracle],
      ] as const) {
        await admin.query(
          `INSERT INTO mac_submitter_credential (organization_id, provider_entity_id, mac_jurisdiction, submitter_id,
              trading_partner_id, client_id, client_secret_cipher, client_secret_dek_version, set_by_membership_id)
           VALUES ($1,$2,'noridian_jf','sub','tp','cid',$3,2,$4)`,
          [ORG_A, pe[ORG_A]?.[i], o.macSecret(M24_KEK, ORG_A, ctx(i), `secret-${i}`), randomUUID()],
        );
      }
    });

    it("decrypts the chartwarden secret and refuses the legacy one; the verifier counts 1 current / 1 unreadable", async () => {
      const cipher = buildMacSecretCipher(M24_KEK);
      const stored = async (i: number) =>
        (
          await q<{ c: string }>(
            "SELECT client_secret_cipher AS c FROM mac_submitter_credential WHERE provider_entity_id=$1",
            [pe[ORG_A]?.[i]],
          )
        )[0]?.c as string;
      expect(await cipher.decrypt(ORG_A, ctx(0) as never, await stored(0))).toBe("secret-0");
      await expect(cipher.decrypt(ORG_A, ctx(1) as never, await stored(1))).rejects.toThrow(
        "MAC secret cipher: ciphertext failed authentication",
      );
      const r = await report(["m23"]);
      expect(totalOf(r, "m23")).toMatchObject({ scanned: 2, current: 1, unreadable: 1 });
    });
  });

  describe("M24 trading-partner credential", () => {
    it("a credential with a legacy column is unreadable; a fully chartwarden one is current", async () => {
      const C = (s: string) => currentOracle.credential(M24_KEK, ORG_A, s);
      const L = (s: string) => legacyOracle.credential(M24_KEK, ORG_A, s);
      const insert = (i: number, state: string, cols: [string | null, string | null]) =>
        admin.query(
          `INSERT INTO state_medicaid_trading_partner_credential (organization_id, provider_entity_id, service_state, channel,
              trading_partner_id, client_id, client_secret_cipher, sftp_key_cipher, active_from,
              created_by_membership_id, updated_by_membership_id)
           VALUES ($1,$2,$3,'direct_mmis','TP','cid',$4,$5, now() - interval '1 day', $6, $6)`,
          [ORG_A, pe[ORG_A]?.[i], state, cols[0], cols[1], randomUUID()],
        );
      await insert(0, "OR", [C("client-secret"), C("sftp-key")]);
      await insert(1, "WA", [C("client-secret"), L("sftp-key")]);
      const r = await report(["m24"]);
      expect(totalOf(r, "m24")).toMatchObject({ scanned: 2, current: 1, unreadable: 1 });
    });
  });

  describe("M35 pseudonym key material", () => {
    it("opens the chartwarden key and refuses the legacy one; the verifier counts 1 / 1", async () => {
      const keyA = randomBytes(32);
      const keyB = randomBytes(32);
      await admin.query(
        `INSERT INTO patient_pseudonym_key (key_epoch, key_material_ciphertext, key_kms_ref, is_active, activated_at, retired_at)
         VALUES ('epoch-old', $1, 'pk-0', false, now() - interval '1 year', now() - interval '1 day'),
                ('epoch-new', $2, 'pk-1', true, now() - interval '1 day', NULL)`,
        [
          legacyOracle.pseudonym(PK_RETIRED, "pk-0", "epoch-old", keyA),
          currentOracle.pseudonym(PK_ACTIVE, "pk-1", "epoch-new", keyB),
        ],
      );
      const r = await report(["m35"]);
      expect(totalOf(r, "m35")).toMatchObject({ scanned: 2, current: 1, unreadable: 1 });
      expect(r.problemTotal).toBe(1);
    });
  });

  describe("M36 message bodies (v1 HKDF label and v2 ring AAD label)", () => {
    it("opens chartwarden bodies, refuses legacy ones through the real cipher; the verifier counts 2 / 2", async () => {
      const channel = (
        await q<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, dm_participant_key, title, retention_class)
           VALUES ($1,'dm','b:peer','DM','care_related') RETURNING id`,
          [ORG_A],
        )
      )[0]?.id as string;
      const insert = async (sealed: Buffer, plaintext: string) =>
        (
          await q<{ id: string }>(
            `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, body_kind)
             VALUES ($1,$2,$3,'user',$4,$5,'plain') RETURNING id`,
            [channel, ORG_A, userOf[ORG_A], sealed, SHA(plaintext)],
          )
        )[0]?.id as string;
      const bodies = {
        v1Ok: await insert(currentOracle.bodyV1(MSG_KEK, ORG_A, "v1-ok"), "v1-ok"),
        v1Legacy: await insert(legacyOracle.bodyV1(MSG_KEK, ORG_A, "v1-old"), "v1-old"),
        v2Ok: await insert(currentOracle.bodyV2(DEK_A2, ORG_A, "v2", "v2-ok"), "v2-ok"),
        v2Legacy: await insert(legacyOracle.bodyV2(DEK_A2, ORG_A, "v2", "v2-old"), "v2-old"),
      };
      const ringCache = createRingDekCache(keys);
      const cipher = createMessageBodyCipher({ kek: MSG_KEK, keys, ringCache });
      const bodyOf = async (id: string) =>
        (await q<{ c: Buffer }>("SELECT body_cipher AS c FROM message WHERE id=$1", [id]))[0]
          ?.c as Buffer;
      expect(await cipher.open(ORG_A, await bodyOf(bodies.v1Ok))).toBe("v1-ok");
      expect(await cipher.open(ORG_A, await bodyOf(bodies.v2Ok))).toBe("v2-ok");
      for (const id of [bodies.v1Legacy, bodies.v2Legacy]) {
        const err = await cipher.open(ORG_A, await bodyOf(id)).catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).not.toMatch(/wardenx|chartwarden|label/i);
      }
      const r = await report(["m36-body"], [ORG_A]);
      expect(totalOf(r, "m36-body")).toMatchObject({ scanned: 4, current: 2, unreadable: 2 });
    });
  });

  describe("verifier behaviour", () => {
    it("never reports a clean result over a missing input, and a capped run is not complete", async () => {
      await expect(
        runVerify(
          { ...deps, credentialKek: undefined },
          {
            modules: ["m24"],
            organizationIds: [ORG_A],
            batchSize: 2,
          },
        ),
      ).rejects.toThrow(MissingDependencyError);
      const capped = await runVerify(deps, {
        modules: ["m5"],
        organizationIds: [ORG_A],
        batchSize: 1,
        maxRows: 1,
      });
      expect(capped.complete).toBe(false);
      // a single-module run covers one module and can never read as a full sweep
      const one = await report(["m5"]);
      expect(one.allModules).toBe(false);
      expect(one.modulesCovered).toEqual(["m5"]);
    });

    it("the whole sweep is complete and its problemTotal is exactly the legacy-sealed values planted above", async () => {
      const r = await report([
        "m24",
        "m23",
        "m35",
        "m5",
        "m36-body",
        "m36-search",
        "m36-export",
        "m34",
      ]);
      expect(r.complete).toBe(true);
      expect(r.allModules).toBe(true);
      // m34: 1 ring, m5: 3, m23: 1, m24: 1, m35: 1, m36-body: 2
      expect(r.problemTotal).toBe(9);
    });
  });
});

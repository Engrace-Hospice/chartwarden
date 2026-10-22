/**
 * Migration 1151 — stored identifiers wardenx -> chartwarden — the LIVE Postgres proof.
 *
 * Replays every migration BEFORE 1151, seeds legacy rows with LITERAL old values, applies 1151, and asserts with
 * literal new values (no shared constant): principal e-mails and tenant_fhir_config URN bases are rewritten, a real
 * tenant host and an ordinary user are untouched, a principal whose new address already exists is skipped, and a
 * second application changes nothing.
 *
 * Run on a private pgvector container, one database at a time:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:…@host/throwaway bun run test:stored-identifiers:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const MIGRATION = "1151_chartwarden_stored_identifiers.sql";

const sqlFiles = (upTo: string) =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < upTo)
    .sort();

const ORG_URN = "00000000-0000-4000-8000-0000000b0001";
const ORG_REAL = "00000000-0000-4000-8000-0000000b0002";
const LINK_A = "00000000-0000-4000-8000-0000000c0001";
const LINK_B = "00000000-0000-4000-8000-0000000c0002";

describe.skipIf(!DB_URL)("migration 1151 — stored identifier rewrite — LIVE Postgres", () => {
  let db: Client;
  const apply = () => db.query(readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8"));
  const emails = async () =>
    (await db.query(`SELECT email FROM "user" WHERE email LIKE '%@%' ORDER BY email`)).rows.map(
      (r) => r.email as string,
    );
  const cfg = async () =>
    (
      await db.query(
        "SELECT organization_id, tenant_fhir_host, identifier_uri_base FROM tenant_fhir_config ORDER BY organization_id",
      )
    ).rows;

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    for (const f of sqlFiles(MIGRATION))
      await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    const insertUser = (id: string, email: string) =>
      db.query(`INSERT INTO "user" (id, email) VALUES ($1, $2)`, [id, email]);
    await insertUser(
      "00000000-0000-4000-8000-0000000d0001",
      `link-${LINK_A}@principals.wardenx.invalid`,
    );
    // LINK_B has BOTH forms already: the legacy one must be skipped, not collide on user_email_idx.
    await insertUser(
      "00000000-0000-4000-8000-0000000d0002",
      `link-${LINK_B}@principals.wardenx.invalid`,
    );
    await insertUser(
      "00000000-0000-4000-8000-0000000d0003",
      `link-${LINK_B}@principals.chartwarden.invalid`,
    );
    await insertUser("00000000-0000-4000-8000-0000000d0004", "nurse@wardenx.example");
    for (const [id, slug] of [
      [ORG_URN, "urn-org"],
      [ORG_REAL, "real-org"],
    ] as const)
      await db.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'L','D')",
        [id, slug],
      );
    const insertCfg = (org: string, host: string, base: string) =>
      db.query(
        "INSERT INTO tenant_fhir_config (organization_id, tenant_fhir_host, identifier_uri_base, cursor_signing_key_cipher) VALUES ($1,$2,$3,'\\x00')",
        [org, host, base],
      );
    await insertCfg(ORG_URN, `urn:wardenx:org:${ORG_URN}`, `urn:wardenx:org:${ORG_URN}`);
    await insertCfg(ORG_REAL, "fhir.partner.example.org", "https://partner.example.org/fhir");
    await apply();
  }, 900_000);

  afterAll(async () => {
    await db?.end();
  });

  it("rewrites the legacy principal address to the new domain", async () => {
    const all = await emails();
    expect(all).toContain(`link-${LINK_A}@principals.chartwarden.invalid`);
    expect(all).not.toContain(`link-${LINK_A}@principals.wardenx.invalid`);
  });

  it("skips a principal whose new-form address already exists, and leaves other users alone", async () => {
    const all = await emails();
    expect(all).toContain(`link-${LINK_B}@principals.wardenx.invalid`);
    expect(all).toContain(`link-${LINK_B}@principals.chartwarden.invalid`);
    expect(all).toContain("nurse@wardenx.example");
  });

  it("rewrites the URN fallback bases and leaves a tenant's real host untouched", async () => {
    expect(await cfg()).toEqual([
      {
        organization_id: ORG_URN,
        tenant_fhir_host: `urn:chartwarden:org:${ORG_URN}`,
        identifier_uri_base: `urn:chartwarden:org:${ORG_URN}`,
      },
      {
        organization_id: ORG_REAL,
        tenant_fhir_host: "fhir.partner.example.org",
        identifier_uri_base: "https://partner.example.org/fhir",
      },
    ]);
  });

  it("is idempotent: a second application changes nothing", async () => {
    const before = { e: await emails(), c: await cfg() };
    await apply();
    expect({ e: await emails(), c: await cfg() }).toEqual(before);
  });
});

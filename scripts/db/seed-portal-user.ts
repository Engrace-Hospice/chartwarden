/**
 * WardenX — additive local-dev seed for one patient portal login. NOT for production / real PHI.
 *
 * Creates a Better Auth user, an active patient-self portal account, the governing M39
 * `portal_access` consent, and one active M31 grant to the first seeded demo patient. The contact
 * fields use M31's real tenant-DEK cipher. Re-running replaces only this synthetic portal identity.
 *
 * Prereqs: backend running; db:seed, db:seed:patients and db:seed:consent-types completed; the demo
 * tenant key ring and M34_TENANT_KEK must be available.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Client } from "pg";
import {
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../../apps/backend/src/bootstrap/tenant-kek";
import { validateScopeSet } from "../../apps/backend/src/modules/31-portal/lifecycle/scope-set";
import { createPortalPhiCipher } from "../../apps/backend/src/modules/31-portal/portal-crypto";
import { fetchAuthWithRateLimitRetry } from "./lib/auth-rate-limit";
import { SEED_CREDENTIALS_PATH, seedUsername, writeSeedCredentials } from "./lib/credentials";
import { firstRow } from "./lib/query-rows";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const ORG_SLUG = "wardenx-demo";
const EMAIL = "patient@wardenx.local";
const NAME = "Pat Portal";
const SECTION = "\n## Patient Portal (bun run db:seed:portal)\n";

function genPassword(): string {
  return `Wx-${randomBytes(9).toString("base64url")}-Zq9!`;
}

async function signUp(password: string): Promise<string> {
  const res = await fetchAuthWithRateLimitRetry(
    `${AUTH_URL}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password, name: NAME, username: seedUsername(EMAIL) }),
    },
    `sign-up for ${EMAIL}`,
  );
  if (!res.ok)
    throw new Error(`sign-up failed for ${EMAIL}: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user?: { id?: string } };
  if (!body.user?.id) throw new Error(`sign-up for ${EMAIL} returned no user id`);
  return body.user.id;
}

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const kekRing = loadPlatformKekRing();
  if (!kekRing) throw new Error("M34_TENANT_KEK is required to encrypt portal contact fields");

  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");

  const target = await db.query<{
    organization_id: string;
    patient_id: string;
    provider_entity_id: string;
    location_id: string | null;
    grantor_membership_id: string;
    wrapped_dek: Buffer;
    dek_kek_id: string;
    dek_version: string;
  }>(
    `SELECT o.id AS organization_id,
            p.id AS patient_id,
            p.provider_entity_id,
            p.location_id,
            m.id AS grantor_membership_id,
            tkr.current_dek_kek_wrapped_ciphertext AS wrapped_dek,
            tkr.current_dek_kek_id AS dek_kek_id,
            tkr.current_dek_version AS dek_version
       FROM organization o
       JOIN patient p ON p.organization_id = o.id AND p.provider_entity_id IS NOT NULL
       JOIN membership m ON m.organization_id = o.id
       JOIN "user" staff ON staff.id = m.user_id AND staff.email = 'admin@wardenx.local'
       JOIN tenant_account ta ON ta.organization_id = o.id
       JOIN tenant_key_ring tkr ON tkr.tenant_account_id = ta.id AND tkr.destroyed_at IS NULL
      WHERE o.slug = $1
      ORDER BY p.created_at
      LIMIT 1`,
    [ORG_SLUG],
  );
  if (!target.rowCount) {
    await db.end();
    throw new Error(
      "demo org/patient/admin/key ring missing — run db:seed, db:seed:patients and db:seed:org-admin first",
    );
  }
  const row = firstRow(target, "seed-portal-user: target patient");

  // Replace only this known synthetic identity. Grants and the seed-owned consent precede the account.
  const prior = await db.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [EMAIL]);
  for (const { id } of prior.rows) {
    const accounts = await db.query<{ id: string }>(
      "SELECT id FROM portal_account WHERE user_id = $1",
      [id],
    );
    const accountIds = accounts.rows.map((account) => account.id);
    if (accountIds.length) {
      const consentIds = await db.query<{ source_consent_record_id: string }>(
        "SELECT source_consent_record_id FROM portal_access_grant WHERE portal_account_id = ANY($1)",
        [accountIds],
      );
      await db.query("DELETE FROM portal_access_grant WHERE portal_account_id = ANY($1)", [
        accountIds,
      ]);
      await db.query("DELETE FROM portal_account WHERE id = ANY($1)", [accountIds]);
      const ids = consentIds.rows.map((consent) => consent.source_consent_record_id);
      if (ids.length) await db.query("DELETE FROM consent_record WHERE id = ANY($1)", [ids]);
    }
    for (const table of ["session", "account", "two_factor", "passkey"]) {
      await db.query(`DELETE FROM ${table} WHERE user_id = $1`, [id]).catch(() => undefined);
    }
    await db.query('DELETE FROM "user" WHERE id = $1', [id]);
  }

  const password = genPassword();
  const userId = await signUp(password);
  await db.query('UPDATE "user" SET email_verified = true, updated_at = now() WHERE id = $1', [
    userId,
  ]);

  const dek = await createPlatformKekAdapter(kekRing).unwrap({
    organizationId: row.organization_id,
    kekWrappedCiphertext: row.wrapped_dek,
    kekId: row.dek_kek_id,
  });
  const cipher = createPortalPhiCipher({
    dekForOrg: async () => ({ version: row.dek_version, key: dek }),
    dekForOrgVersion: async () => ({ version: row.dek_version, key: dek }),
  });
  const [displayName, email] = await Promise.all([
    cipher.encrypt(row.organization_id, "portal_account.display_name_cipher", NAME),
    cipher.encrypt(row.organization_id, "portal_account.email_cipher", EMAIL),
  ]);

  await db.query("BEGIN");
  try {
    const consent = await db.query<{ id: string }>(
      `INSERT INTO consent_record
         (organization_id, provider_entity_id, location_id, patient_id, type_key, scope_descriptor,
          grantor_kind, effective_at, status, capture_method, capture_evidence_jsonb,
          created_by_id, signed_at, signed_by_id)
       VALUES ($1,$2,$3,$4,'portal_access','{}'::jsonb,'patient_self',now(),'active',
               'typed_signature_in_app','{"seed":"db:seed:portal"}'::jsonb,$5,now(),$5)
       RETURNING id`,
      [
        row.organization_id,
        row.provider_entity_id,
        row.location_id,
        row.patient_id,
        row.grantor_membership_id,
      ],
    );
    const consentId = firstRow(consent, "seed-portal-user: consent").id;
    const account = await db.query<{ id: string }>(
      `INSERT INTO portal_account
         (organization_id, user_id, relationship, status, display_name_cipher, email_cipher,
          activated_at, two_factor_enrolled)
       VALUES ($1,$2,'patient_self','active',$3,$4,now(),false)
       RETURNING id`,
      [row.organization_id, userId, displayName.envelope, email.envelope],
    );
    const portalAccountId = firstRow(account, "seed-portal-user: portal account").id;
    await db.query(
      `INSERT INTO portal_access_grant
         (organization_id, provider_entity_id, location_id, portal_account_id, patient_id, grant_kind,
          scope_set_jsonb, source_consent_record_id, source_consent_version, granted_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,'patient_self',$6::jsonb,$7,'1',$8)`,
      [
        row.organization_id,
        row.provider_entity_id,
        row.location_id,
        portalAccountId,
        row.patient_id,
        JSON.stringify(validateScopeSet("patient_self", "1")),
        consentId,
        row.grantor_membership_id,
      ],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    dek.fill(0);
    await db.end();
  }

  const existing = existsSync(SEED_CREDENTIALS_PATH)
    ? readFileSync(SEED_CREDENTIALS_PATH, "utf8")
    : "# WardenX — Local Dev Credentials\n";
  const [before = existing, after = ""] = existing.split(SECTION);
  const nextSection = after.indexOf("\n## ");
  const preserved = nextSection >= 0 ? after.slice(nextSection) : "";
  const block = [
    before.replace(/\n+$/, ""),
    SECTION.trimStart(),
    "",
    "| Persona | Email | Password | Session class |",
    "|---|---|---|---|",
    `| Demo patient | \`${EMAIL}\` | \`${password}\` | patient_portal |`,
    "",
    "> Sign in at http://localhost:5174 using **Use a password instead**.",
    "",
  ].join("\n");
  writeSeedCredentials(`${block}${preserved}`);

  console.log("\n✓ patient portal user created");
  console.log(`  email:    ${EMAIL}`);
  console.log("  account:  patient_self (active, one active patient grant)");
  console.log("  credentials written to CREDENTIALS.local.md");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

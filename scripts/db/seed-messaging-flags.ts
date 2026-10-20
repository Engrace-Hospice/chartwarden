/**
 * WardenX — additive seed: turn the M36 messaging capabilities ON for the demo org.
 *
 * Every flag defaults OFF and the web shell fails closed, so a freshly (re)seeded tenant shows none of the
 * link-a-record, needs-a-response, ask-a-nurse, urgent/SBAR or IDG controls. `db:seed:all` runs after the demo org is
 * rebuilt (its feature_flag rows go with the org), so this belongs in that chain.
 *
 * Demo org only. A real tenant's flags are set through the platform admin API (step-up gated), never here.
 * Idempotent: upserts on (flag_key, organization_id). Uses the admin connection.
 * Usage: bun run db:seed:messaging-flags
 */
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const ORG_SLUG = "wardenx-demo";

// `messaging.role_send` needs `messaging.ack_requests` on too (a role send without a response record is a 503).
export const MESSAGING_FLAGS = [
  "messaging.clinical_links",
  "messaging.ack_requests",
  "messaging.role_send",
  "messaging.presence_enabled",
  "messaging.sbar",
  "messaging.idg",
  "messaging.urgent_clinical",
] as const;

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    const org = await db.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
      ORG_SLUG,
    ]);
    const orgId = org.rows[0]?.id;
    if (!orgId) throw new Error(`organization ${ORG_SLUG} not found - run db:seed first`);
    for (const flag of MESSAGING_FLAGS) {
      await db.query(
        `INSERT INTO feature_flag (organization_id, flag_key, flag_kind, value_type, value, rationale)
         VALUES ($1, $2, 'product', 'bool', 'true'::jsonb, 'demo seed: M36 messaging capabilities (demo org only)')
         ON CONFLICT (flag_key, organization_id)
         DO UPDATE SET value = 'true'::jsonb, kill_switch_active = false`,
        [orgId, flag],
      );
    }
    console.log(`messaging flags on for ${ORG_SLUG}: ${MESSAGING_FLAGS.join(", ")}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

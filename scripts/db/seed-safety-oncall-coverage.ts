/**
 * ChartWarden — demo safety/on-call coverage seed. Closes the two standing gaps the hourly M20 and half-hourly M19
 * coverage-gap watchdogs (deliberately) re-alert on, so the demo inbox stops filling with critical pages:
 *   - M20: one org-wide `safety_supervisor_subscription` (supervisor@) covering every field clinician;
 *   - M19: one long-running active `clinical_rn` `on_call_shift` (rita@) for the demo ProviderEntity.
 * Direct SQL under `session_replication_role = replica` (no REST route creates either row — same convention as
 * seed-org-structure.ts). Idempotent: fixed ids; re-running refreshes the shift window.
 * NOTE: db:seed:scenario-field-ops deletes rita@'s on-call shifts, this one included — if you re-run it on its own,
 * re-run db:seed:safety-oncall afterwards or the M19 coverage-gap alerts return.
 * Prereqs: db:seed:staff, db:seed:org-structure, db:seed:scenario-field-ops (owns the tenant_oncall_policy row).
 * Run: bun run db:seed:safety-oncall
 */
import { Client } from "pg";
import { buildRnCoverageShift, buildSupervisionSubscription } from "./lib/safety-oncall-coverage";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const ORG_SLUG = "chartwarden-demo";
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001"; // db:seed:org-structure
const SUPERVISOR_EMAIL = "supervisor@chartwarden.local";
const RN_EMAIL = "rita@chartwarden.local";

async function membershipId(db: Client, orgId: string, email: string): Promise<string> {
  const res = await db.query<{ id: string }>(
    `SELECT m.id FROM membership m JOIN "user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND u.email = $2`,
    [orgId, email],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`${email} has no membership in ${ORG_SLUG} — run db:seed:staff first`);
  return id;
}

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    await db.query("SET session_replication_role = replica");
    const org = await db.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
      ORG_SLUG,
    ]);
    const orgId = org.rows[0]?.id;
    if (!orgId) throw new Error(`demo org '${ORG_SLUG}' not found — run db:seed first`);

    const sub = buildSupervisionSubscription(
      await membershipId(db, orgId, SUPERVISOR_EMAIL),
      orgId,
    );
    await db.query(
      `INSERT INTO safety_supervisor_subscription
         (id, organization_id, supervisor_membership_id, scope_kind, alert_kinds)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
      [sub.id, sub.organizationId, sub.supervisorMembershipId, sub.scopeKind, sub.alertKinds],
    );

    const policy = await db.query(
      "SELECT to_jsonb(p) AS snapshot FROM tenant_oncall_policy p WHERE organization_id = $1 AND provider_entity_id = $2",
      [orgId, PROVIDER_ENTITY_ID],
    );
    const snapshot = policy.rows[0]?.snapshot;
    if (!snapshot) {
      throw new Error("tenant_oncall_policy missing — run db:seed:scenario-field-ops first");
    }
    const shift = buildRnCoverageShift({
      organizationId: orgId,
      providerEntityId: PROVIDER_ENTITY_ID,
      rnMembershipId: await membershipId(db, orgId, RN_EMAIL),
      now: new Date(),
    });
    await db.query(
      `INSERT INTO on_call_shift
         (id, organization_id, provider_entity_id, shift_starts_at, shift_ends_at, discipline,
          primary_on_call_membership_id, policy_snapshot, status, opened_at)
       VALUES ($1,$2,$3,$4,$5,'clinical_rn',$6,$7,'active',$8)
       ON CONFLICT (id) DO UPDATE
         SET shift_ends_at = EXCLUDED.shift_ends_at, status = 'active', updated_at = now()`,
      [
        shift.id,
        shift.organizationId,
        shift.providerEntityId,
        shift.shiftStartsAt,
        shift.shiftEndsAt,
        shift.rnMembershipId,
        snapshot,
        shift.openedAt,
      ],
    );
    console.log(
      `✓ safety/on-call coverage seed: org-wide supervision subscription + active clinical_rn shift to ${shift.shiftEndsAt.toISOString()}.`,
    );
  } finally {
    await db.end();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

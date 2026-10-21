// apps/backend/src/modules/36-messaging/alert-rule-seed-persister.ts — GAP-096.
//
// Boot-populate `alert_rule`'s platform-default rows (organization_id IS NULL) from
// `PLATFORM_DEFAULT_ALERT_RULES` (@chartwarden/messaging). The package's own doc comments already call
// this "the boot slice UPSERT" (`toNewAlertRuleRows`'s doc: "the boot slice UPSERTs into alert_rule")
// and gate boot on `assertAlertRuleSeedValid()` — the write side was simply never wired, mirroring
// `apps/backend/src/bootstrap/organization-settings-persister.ts`'s exact prior gap (a header comment
// claiming a boot write "lands with the backend bootstrap" that never happened). Without this, every
// `AlertEmitterPorts.rulesFor` call returns `[]` for every real event forever — GAP-096's worker wiring
// would be structurally complete but functionally inert.
//
// WHY A SQL FUNCTION, NOT A PLAIN DRIZZLE UPSERT: `alert_rule`'s own RLS write policy is
// `WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)` — a NULL
// `organization_id` can never satisfy that check under `wardenx_app` (the role every request/worker
// connection runs as in production), by design (a tenant must never write a platform-default row).
// ADR-0010 D2/D3 forbids adding a second RLS branch to that SAME policy (never an org-alternative
// disjunct on a policy that is also tenant-writable). Migration 0193 mirrors 0187's
// `audit_writer_insert_platform_event` / 0189's `cap_platform_loader_publish_constant` pattern exactly:
// `alert_rule_platform_upsert(...)` is a SECURITY DEFINER function owned by `wardenx_admin` (which holds
// its own dedicated `alert_rule_admin_all` policy), EXECUTE-granted to `wardenx_app` — so this runs over
// the SAME ordinary `dbHandle.db` connection every other boot-populate uses, no separate platform
// credential required. `organization_id` is hardcoded NULL inside the function body, never a parameter.
import type { DbClient } from "@chartwarden/db";
import { PLATFORM_DEFAULT_ALERT_RULES, assertAlertRuleSeedValid } from "@chartwarden/messaging";
import { sql } from "drizzle-orm";

/** Idempotent UPSERT of the platform-default `alert_rule` rows via the migration-0193 SECURITY
 *  DEFINER function (see file header) — safe to call on every boot. */
export async function wireAlertRuleSeed(db: DbClient): Promise<void> {
  assertAlertRuleSeedValid();
  for (const rule of PLATFORM_DEFAULT_ALERT_RULES) {
    await db.execute(sql`
      SELECT alert_rule_platform_upsert(
        ${rule.eventType},
        ${rule.category},
        ${rule.severityFloor},
        ${rule.recipientResolver},
        ${JSON.stringify(rule.resolverArgs)}::jsonb,
        ${rule.channelsOverride ? JSON.stringify(rule.channelsOverride) : null}::jsonb,
        ${rule.systemLocked},
        ${rule.enabled}
      )
    `);
  }
}

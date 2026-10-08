// apps/backend/src/modules/34-saas-tenant-platform/alert-rule-seed-persister.ts — GAP-098.
//
// Boot-populate the `alert_rule` platform-default rows (organization_id IS NULL) M34 contributes,
// through the SAME migration-0193 `alert_rule_platform_upsert` SECURITY DEFINER function M36's own
// seed persister uses (see ../36-messaging/alert-rule-seed-persister.ts for why a plain Drizzle upsert
// cannot write a NULL-org row under `wardenx_app`).
//
// GAP-057: the seed is COMPLETE. M34's two resolvers (`compliance_officer_for_tenant`,
// `platform_security_owner`) are registered onto the emitter's resolver registry at boot (see
// ./alert-resolver-ports.ts and apps/backend/src/index.ts), so no rule names an unregistered resolver and
// `skipped` is 0. The skip accounting stays so a future rule naming an unregistered resolver is reported.
import type { DbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";
import { M34_ALERT_RULES, seedableM34AlertRules } from "./alert-rules";

/** What the boot seed did — the caller logs it so the unseeded remainder stays visible. */
export interface M34AlertRuleSeedResult {
  readonly seeded: number;
  /** Rules whose resolver is not registered at boot; dormant, and would THROW if seeded. */
  readonly skipped: number;
  readonly skippedResolvers: readonly string[];
}

/** Idempotent UPSERT of M34's seedable platform-default `alert_rule` rows — safe on every boot. */
export async function wireM34AlertRuleSeed(db: DbClient): Promise<M34AlertRuleSeedResult> {
  const seedable = seedableM34AlertRules();
  for (const rule of seedable) {
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
  const skippedRules = M34_ALERT_RULES.filter((r) => !seedable.includes(r));
  return {
    seeded: seedable.length,
    skipped: skippedRules.length,
    skippedResolvers: [...new Set(skippedRules.map((r) => r.recipientResolver))].sort(),
  };
}

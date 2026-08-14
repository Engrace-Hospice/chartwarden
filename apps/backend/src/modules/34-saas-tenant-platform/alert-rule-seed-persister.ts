// apps/backend/src/modules/34-saas-tenant-platform/alert-rule-seed-persister.ts — GAP-098.
//
// Boot-populate the `alert_rule` platform-default rows (organization_id IS NULL) M34 contributes,
// through the SAME migration-0193 `alert_rule_platform_upsert` SECURITY DEFINER function M36's own
// seed persister uses (see ../36-messaging/alert-rule-seed-persister.ts for why a plain Drizzle upsert
// cannot write a NULL-org row under `wardenx_app`).
//
// `M34_ALERT_RULES`'s own footer has called this "the Phase 2D boot UPSERT" since the file was
// written, and nothing ever performed it — so every `m34.*` alert rule has been dormant, and the
// GAP-098 oversized-hold alert would have been dormant on arrival too.
//
// PARTIAL BY CONSTRUCTION, AND IT SAYS SO. Only the rules whose `recipientResolver` is an M36 built-in
// are seeded (`seedableM34AlertRules`). The rest name M34's own two resolvers, which are implemented
// but never registered at boot; M36's registry THROWS on an unknown resolver name, so seeding them
// would turn a dormant rule into a failing emit. The count skipped is returned (and logged by the
// caller) rather than swallowed — a partial seed that reports itself is honest; one that doesn't is
// how "the alert plane is wired" gets believed.
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

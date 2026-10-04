import { Client } from "pg";
import { AI_PHASE_1_BACKENDS } from "../../packages/ai-platform/src/inventory/backends";
/**
 * scripts/db/sync-ai-capability-catalog.ts — idempotent `ai_capability` sync from the M32 §2.4
 * in-code inventory (ARCH-019 / TASK-062).
 *
 * `packages/ai-platform/src/inventory/capabilities.ts`'s `AI_PHASE_1_CAPABILITIES` is "PURE DATA —
 * spec T55 is what INSERTs them" per its own header, but until this script no INSERT path existed at
 * all: the governance docs described capabilities the DB never received. This is that path, run the
 * same way `db:sync:permissions` syncs the permission catalog — additive, idempotent, no PHI, no org
 * scope (`ai_capability` is PLATFORM-SHARED per its own schema header).
 *
 * NOT EVERY REGISTERED CAPABILITY IS SEEDABLE YET. `AI_PHASE_1_INVENTORY_GAPS` is the single source of
 * truth for which ones the schema currently refuses (`ai_capability.default_backend_key` NOT NULL, and
 * `ai_capability_approved_has_template` CHECK): this script reads `gap.blocks` generically rather than
 * hand-rolling its own skip logic, so a newly-documented gap self-enforces here with no code change,
 * and closing a gap (e.g. T56 landing prompt templates) makes the capability seedable with no code
 * change either. Every skip is printed with the gap's own `detail`, never silent (no silent caps).
 *
 * Usage: bun run db:sync:ai-capabilities   (DATABASE_ADMIN_URL — needs write on ai_capability)
 */
import {
  AI_PHASE_1_CAPABILITIES,
  AI_PHASE_1_INVENTORY_GAPS,
  aiCapabilityGovernanceDefaults,
} from "../../packages/ai-platform/src/inventory/capabilities";

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) must be set");

  // capabilityKey -> the gap.detail explaining why it is not seeded yet (first gap that blocks it wins;
  // today no capability is named by more than one gap's `blocks`).
  const blocked = new Map<string, string>();
  for (const gap of AI_PHASE_1_INVENTORY_GAPS) {
    for (const key of gap.blocks) {
      if (!blocked.has(key)) blocked.set(key, gap.detail);
    }
  }

  const db = new Client({ connectionString: url });
  await db.connect();
  // A catalog sync is a deploy action, not an audited user action (the same posture db:seed and
  // sync-permission-catalog take).
  await db.query("SET session_replication_role = replica");

  let synced = 0;
  for (const cap of AI_PHASE_1_CAPABILITIES) {
    const reason = blocked.get(cap.capabilityKey);
    if (reason) {
      console.log(`SKIP ${cap.capabilityKey}: ${reason}`);
      continue;
    }
    // Unreachable given the gaps above cover every null-defaultBackendKey row, but the column is NOT
    // NULL — a defensive check beats a cryptic constraint-violation stack trace.
    if (cap.defaultBackendKey === null) {
      console.log(
        `SKIP ${cap.capabilityKey}: defaultBackendKey is null and no inventory gap documents why — add one before seeding.`,
      );
      continue;
    }
    const governance = aiCapabilityGovernanceDefaults(cap.riskTier);
    await db.query(
      `INSERT INTO ai_capability
         (capability_key, display_name, description, risk_tier, lifecycle_state,
          default_backend_key, allowed_backend_keys, fallback_chain_keys,
          tenant_opt_in_required, clinical_review_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (capability_key) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         risk_tier = EXCLUDED.risk_tier,
         lifecycle_state = EXCLUDED.lifecycle_state,
         default_backend_key = EXCLUDED.default_backend_key,
         allowed_backend_keys = EXCLUDED.allowed_backend_keys,
         tenant_opt_in_required = EXCLUDED.tenant_opt_in_required,
         clinical_review_required = EXCLUDED.clinical_review_required,
         updated_at = now()
         -- fallback_chain_keys is deliberately NOT re-synced: it starts [] here, but the routing
         -- gate's fallback chain is an operational tuning knob, not inventory data, and a resync
         -- should not clobber one an operator configured (same posture as sync-permission-catalog
         -- preserving abac_override).`,
      [
        cap.capabilityKey,
        cap.displayName,
        cap.note,
        cap.riskTier,
        cap.phase1LifecycleState,
        cap.defaultBackendKey,
        // F-236 — ALLOWED is the default plus every active §2.3 backend whose own "Capabilities served"
        // column names this capability. It used to be the default alone, which made the inventory's
        // local routes unreachable: a `local_only` tenant could never be served `doclens_extract` by the
        // local backend §2.3 says serves it. Allowed is not routed — fallback_chain_keys (below) is still
        // left [] for an operator to tune, and the routing gate filters the chain by the allowed set.
        JSON.stringify([
          cap.defaultBackendKey,
          ...AI_PHASE_1_BACKENDS.filter(
            (b) =>
              b.isActive &&
              b.backendKey !== cap.defaultBackendKey &&
              b.servesCapabilityKeys.includes(cap.capabilityKey),
          ).map((b) => b.backendKey),
        ]),
        JSON.stringify([]),
        governance.tenantOptInRequired,
        governance.clinicalReviewRequired,
      ],
    );
    synced += 1;
  }

  const skipped = AI_PHASE_1_CAPABILITIES.length - synced;
  console.log(
    `ai_capability synced: ${synced}/${AI_PHASE_1_CAPABILITIES.length} capabilities upserted (${skipped} skipped — see SKIP lines above)`,
  );

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

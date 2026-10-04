/**
 * WardenX — turn DocLens's AI path ON for the DEMO ORG ONLY (local dev; F-236, ADR-0048). NOT for production.
 *
 * Every gate in the M32 pipeline stays real; this script satisfies them the way an operator and an AI
 * Safety Owner eventually would, for one dev tenant, and prints what it did:
 *
 *   1. feature flags `ai.full` + `documents.doclens` ON for the demo org (both default OFF everywhere).
 *   2. the four reviewed prompt templates registered ACTIVE (`ai_prompt_template`), each pinned by the
 *      SHA-256 of its file in packages/ai-platform/prompts/doclens — the registry refuses a drifted file.
 *   3. the four DocLens capabilities moved to PILOT (serves pilot-enrolled tenants only) with the
 *      local backend as their fallback chain. DEV-ONLY: in production that transition is the AI Safety
 *      Owner's, through the lifecycle workflow and its evaluation evidence. Nothing is marked APPROVED.
 *   4. an ACTIVE, pilot-enrolled tenant opt-in for each, routing preference `local_only` (PHI stays on
 *      this machine; the cloud backend is never contacted for this tenant — W8).
 *   5. a monthly token budget for each (`ai_token_budgets`).
 *
 * Prereqs: db:seed, db:sync:ai-capabilities, db:sync:ai-backends (healthy local backends registered:
 *          llama for classify/extract/SUD, qwen2.5-vl for stage-5 vision — F-237).
 * Run:     DATABASE_ADMIN_URL=… bun run db:seed:scenario-doclens-ai
 * Undo:    re-run with DOCLENS_AI=off (flags off, opt-ins opted_out; prompt rows and lifecycle kept).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL;
const ORG_SLUG = "wardenx-demo";
const ADMIN_EMAIL = "admin@wardenx.local";
const LOCAL_BACKEND = "local-llama-3.1-8b-instruct";
// F-237 — stage 5 needs a model that can see; the local route is Qwen2.5-VL (ADR-0048).
const LOCAL_VISION_BACKEND = "local-qwen2.5-vl-7b-instruct";
const OFF = process.env.DOCLENS_AI === "off";

const TEMPLATES = [
  {
    capability: "doclens_classify",
    file: "packages/ai-platform/prompts/doclens/classify.v1.md",
    backend: LOCAL_BACKEND,
  },
  {
    capability: "doclens_extract",
    file: "packages/ai-platform/prompts/doclens/extract.v1.md",
    backend: LOCAL_BACKEND,
  },
  // F-237 — stage 5 (vision double-check) and the model pass of SUD detection.
  {
    capability: "doclens_vision_verify",
    file: "packages/ai-platform/prompts/doclens/vision_verify.v1.md",
    backend: LOCAL_VISION_BACKEND,
  },
  {
    capability: "doclens_sud_detect",
    file: "packages/ai-platform/prompts/doclens/sud_detect.v1.md",
    backend: LOCAL_BACKEND,
  },
] as const;

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica"); // dev seed, not an audited user action
  const org = (
    await db.query<{ id: string }>("SELECT id FROM organization WHERE slug=$1", [ORG_SLUG])
  ).rows[0];
  if (!org) throw new Error("demo org not found — run db:seed first");
  const admin = (
    await db.query<{ id: string }>(
      `SELECT m.id FROM membership m JOIN "user" u ON u.id=m.user_id WHERE u.email=$1 AND m.organization_id=$2`,
      [ADMIN_EMAIL, org.id],
    )
  ).rows[0];
  if (!admin) throw new Error(`${ADMIN_EMAIL} has no demo-org membership — run db:seed first`);

  // 1. flags
  for (const flag of ["ai.full", "documents.doclens"]) {
    await db.query("DELETE FROM feature_flag WHERE organization_id=$1 AND flag_key=$2", [
      org.id,
      flag,
    ]);
    await db.query(
      `INSERT INTO feature_flag (organization_id, flag_key, flag_kind, value_type, value, rationale)
       VALUES ($1,$2,'product','bool',$3::jsonb,'F-236 dev seed: DocLens local pilot (demo org only)')`,
      [org.id, flag, JSON.stringify(!OFF)],
    );
  }

  if (!OFF) {
    for (const t of TEMPLATES) {
      const cap = (
        await db.query<{ id: string }>("SELECT id FROM ai_capability WHERE capability_key=$1", [
          t.capability,
        ])
      ).rows[0];
      if (!cap)
        throw new Error(`${t.capability} is not in ai_capability — run db:sync:ai-capabilities`);
      // 2. the reviewed template, pinned by hash
      const body = readFileSync(join(process.cwd(), t.file), "utf8");
      const hash = createHash("sha256").update(body, "utf8").digest("hex");
      const key = `${t.capability}/v1`;
      await db.query(
        `INSERT INTO ai_prompt_template (template_key, capability_key, version, template_filesystem_ref,
           template_content_hash, compatible_backend_keys, input_schema_ref, output_schema_ref,
           output_entity_target_prefix, output_type_prefix, status, created_by_membership_id,
           approved_by_membership_id, approved_at)
         VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,$7,'extraction_candidate',$8,'active',$9,$9,now())
         ON CONFLICT (template_key) DO UPDATE SET template_content_hash=EXCLUDED.template_content_hash,
           template_filesystem_ref=EXCLUDED.template_filesystem_ref, status='active'`,
        [
          key,
          t.capability,
          t.file,
          hash,
          JSON.stringify([t.backend, "anthropic-claude-opus-4-7", "anthropic-claude-haiku-4-5"]),
          `m22:${t.capability}:input:v1`,
          `m32:${t.capability}:output:v1`,
          `doclens_${t.capability.slice("doclens_".length)}`,
          admin.id,
        ],
      );
      // 3. PILOT + local fallback chain (DEV-ONLY transition — see header)
      await db.query(
        `UPDATE ai_capability SET lifecycle_state='PILOT', current_prompt_template_key=$2,
           fallback_chain_keys=$3::jsonb, updated_at=now() WHERE id=$1`,
        [cap.id, key, JSON.stringify([t.backend])],
      );
      // 4. pilot-enrolled local_only opt-in
      await db.query(
        "DELETE FROM ai_tenant_opt_in_record WHERE organization_id=$1 AND capability_id=$2",
        [org.id, cap.id],
      );
      await db.query(
        `INSERT INTO ai_tenant_opt_in_record (organization_id, capability_id, status, org_admin_membership_id,
           disclosure_acknowledgments, routing_preference_snapshot, pilot_enrollment, opted_in_at)
         VALUES ($1,$2,'active',$3,$4::jsonb,'local_only',true,now())`,
        [
          org.id,
          cap.id,
          admin.id,
          JSON.stringify({ devSeed: "F-236", acknowledged: ["pilot", "local_only"] }),
        ],
      );
      console.log(
        `OK ${t.capability}: template ${key} sha256=${hash.slice(0, 12)}…, PILOT, opt-in local_only`,
      );
    }
    // 5. budgets
    await db.query(
      `UPDATE organization SET settings = settings || jsonb_build_object('ai_token_budgets', $2::jsonb)
       WHERE id=$1`,
      [
        org.id,
        JSON.stringify({
          doclens_classify: { hardCapTokens: 2_000_000 },
          doclens_extract: { hardCapTokens: 5_000_000 },
          doclens_vision_verify: { hardCapTokens: 3_000_000 },
          doclens_sud_detect: { hardCapTokens: 2_000_000 },
        }),
      ],
    );
  } else {
    await db.query(
      `UPDATE ai_tenant_opt_in_record SET status='opted_out', opted_out_at=now(), opted_out_reason='DOCLENS_AI=off'
       WHERE organization_id=$1`,
      [org.id],
    );
  }
  console.log(`DocLens AI ${OFF ? "OFF" : "ON (local pilot)"} for ${ORG_SLUG}`);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

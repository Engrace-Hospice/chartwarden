import { Client } from "pg";
import { aiBackendConfigFromEnv } from "../../apps/backend/src/modules/32-ai-platform/backends/config";
/**
 * scripts/db/sync-ai-backends.ts — register THIS deployment's model backends in `ai_model_backend`
 * (F-236, ADR-0048). Idempotent upsert on `backend_key`.
 *
 * The §2.3 inventory names the backend KEYS and deliberately leaves the model pin, ZDR status, BAA
 * reference, license terms and artifact reference unstated (inventory/backends.ts: "guessing any of them
 * would be worse than leaving the hole visible"). Only a deployment knows them, so this script registers
 * ONLY the backends the deployment configures (the same env `aiBackendConfigFromEnv` reads at boot) and
 * takes every unstated value from the deployment itself — never a default:
 *
 *   local (Ollama)   model pin = `ollama/<tag>`; artifact_storage_ref = `ollama://<tag>`; artifact_checksum =
 *                    the digest Ollama reports for that tag (queried here); license terms from
 *                    OLLAMA_LICENSES (backendKey=terms,…) — REQUIRED (the D17 local CHECK).
 *   cloud (Anthropic) model pin = the Messages API model id; baa_reference = ANTHROPIC_BAA_REFERENCE and
 *                    zdr_status 'enabled' only with an unexpired ANTHROPIC_ZDR_* contract — both REQUIRED
 *                    (the D19 cloud CHECK). Without them the row is NOT registered (printed, not silent).
 *
 * `last_health_status` is left as the table keeps it (`unknown` on insert); the worker's health sweep
 * writes it. Usage: bun run db:sync:ai-backends   (DATABASE_ADMIN_URL — needs write on ai_model_backend)
 */
import { AI_PHASE_1_BACKENDS_BY_KEY } from "../../packages/ai-platform/src/inventory/backends";

function pairs(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url)
    throw new Error("DATABASE_ADMIN_URL must be set (ai_model_backend is wardenx_admin-written)");
  const config = aiBackendConfigFromEnv(process.env);
  const db = new Client({ connectionString: url });
  await db.connect();
  await db.query("SET session_replication_role = replica"); // deploy action, not an audited user action

  const upsert = async (row: Record<string, unknown>): Promise<void> => {
    const cols = Object.keys(row);
    const vals = Object.values(row).map((v) =>
      typeof v === "object" && v !== null ? JSON.stringify(v) : v,
    );
    const set = cols.filter((c) => c !== "backend_key").map((c) => `${c} = EXCLUDED.${c}`);
    await db.query(
      `INSERT INTO ai_model_backend (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})
       ON CONFLICT (backend_key) DO UPDATE SET ${set.join(", ")}, updated_at = now()`,
      vals,
    );
  };

  let registered = 0;
  if (config.ollama) {
    const licenses = pairs(process.env.OLLAMA_LICENSES);
    const tags = (await (
      await fetch(`${config.ollama.baseUrl.replace(/\/+$/, "")}/api/tags`)
    ).json()) as {
      models?: Array<{ name?: string; digest?: string }>;
    };
    for (const [backendKey, tag] of config.ollama.models) {
      const inv = AI_PHASE_1_BACKENDS_BY_KEY.get(backendKey);
      const license = licenses.get(backendKey);
      const digest = tags.models?.find((m) => m.name === tag)?.digest;
      if (!inv || !inv.vendor || !inv.modelFamily) {
        console.log(`SKIP ${backendKey}: the inventory row has no vendor/model family`);
        continue;
      }
      if (!license) {
        console.log(
          `SKIP ${backendKey}: OLLAMA_LICENSES names no license terms (D17 requires them)`,
        );
        continue;
      }
      if (!digest) {
        console.log(`SKIP ${backendKey}: Ollama has no '${tag}' pulled — no artifact to register`);
        continue;
      }
      await upsert({
        backend_key: backendKey,
        kind: "local",
        vendor: inv.vendor,
        model_family: inv.modelFamily,
        model_version_pin: `ollama/${tag}`,
        supported_modalities: inv.supportedModalities,
        context_window_tokens: config.ollama.numCtx,
        max_output_tokens: config.maxOutputTokens,
        supported_features: {
          structured_output: true,
          tool_use: false,
          vision: false,
          streaming: false,
        },
        zdr_status: "not_applicable",
        license_terms: license,
        artifact_storage_ref: `ollama://${tag}`,
        artifact_checksum: `sha256:${digest}`,
        health_endpoint: `${config.ollama.baseUrl.replace(/\/+$/, "")}/api/tags`,
        is_active: true,
      });
      registered += 1;
      console.log(`OK   ${backendKey} → ollama/${tag}`);
    }
  }
  if (config.anthropic) {
    const baa = process.env.ANTHROPIC_BAA_REFERENCE?.trim();
    const zdr = config.anthropic.zdr;
    const zdrLive = zdr !== null && new Date(zdr.expiresAt).getTime() > Date.now();
    for (const [backendKey, model] of config.anthropic.models) {
      const inv = AI_PHASE_1_BACKENDS_BY_KEY.get(backendKey);
      if (!inv?.vendor || !inv.modelFamily || !inv.contextWindowTokens) {
        console.log(`SKIP ${backendKey}: the inventory row is incomplete`);
        continue;
      }
      if (!baa || !zdrLive) {
        console.log(
          `SKIP ${backendKey}: ANTHROPIC_BAA_REFERENCE and an unexpired ANTHROPIC_ZDR_* contract are both required (D19)`,
        );
        continue;
      }
      await upsert({
        backend_key: backendKey,
        kind: "cloud",
        vendor: inv.vendor,
        model_family: inv.modelFamily,
        model_version_pin: model,
        supported_modalities: inv.supportedModalities,
        context_window_tokens: inv.contextWindowTokens,
        max_output_tokens: config.maxOutputTokens,
        supported_features: {
          structured_output: true,
          tool_use: true,
          vision: true,
          streaming: true,
        },
        baa_reference: baa,
        zdr_status: "enabled",
        health_endpoint: `https://api.anthropic.com/v1/models/${model}`,
        is_active: true,
      });
      registered += 1;
      console.log(`OK   ${backendKey} → ${model}`);
    }
  }
  console.log(`ai_model_backend: ${registered} backend(s) registered for this deployment`);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

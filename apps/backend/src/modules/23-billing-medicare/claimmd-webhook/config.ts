// apps/backend/src/modules/23-billing-medicare/claimmd-webhook/config.ts — whether the Claim.MD webhook ingress is bound.
// All of CLAIMMD_WEBHOOK_ENABLED=true, CLAIMMD_ACCOUNT_KEY, CLAIMMD_ACCOUNT_USAGE, CLAIMMD_WEBHOOK_PAYLOAD_KEY and a
// platform runner (DATABASE_PLATFORM_URL) must be present; otherwise the route answers 503 and one warning names what is
// missing (names only, never a value). A payload key of the wrong length throws: it must never silently weaken the cipher.
import {
  type WebhookPayloadCipher,
  createWebhookPayloadCipher,
  parseWebhookPayloadKey,
} from "@chartwarden/shared";
import type { ClaimMdPlatformRunner, ClaimMdUsage } from "./receipt-store";

export const CLAIMMD_WEBHOOK_PAYLOAD_KEY_ENV = "CLAIMMD_WEBHOOK_PAYLOAD_KEY";
export const CLAIMMD_WEBHOOK_KEY_ID = "claimmd-webhook-v1";

export interface ClaimMdWebhookConfig {
  readonly usage: ClaimMdUsage | null;
  /** Present only when every prerequisite is. */
  readonly bound: {
    readonly usage: ClaimMdUsage;
    readonly accountKey: string;
    readonly cipher: WebhookPayloadCipher;
    readonly runner: ClaimMdPlatformRunner;
  } | null;
  /** Names of what is missing (empty when bound or when the feature is simply off). */
  readonly missing: readonly string[];
}

type Env = Record<string, string | undefined>;

export function claimMdWebhookConfigFromEnv(
  env: Env,
  runner: ClaimMdPlatformRunner | undefined,
): ClaimMdWebhookConfig {
  const rawUsage = env.CLAIMMD_ACCOUNT_USAGE?.trim();
  const usage: ClaimMdUsage | null =
    rawUsage === "test" || rawUsage === "production" ? rawUsage : null;
  if (env.CLAIMMD_WEBHOOK_ENABLED !== "true") return { usage, bound: null, missing: [] };
  const accountKey = env.CLAIMMD_ACCOUNT_KEY ?? "";
  const payloadKey = env[CLAIMMD_WEBHOOK_PAYLOAD_KEY_ENV]?.trim() ?? "";
  const missing = [
    ...(accountKey ? [] : ["CLAIMMD_ACCOUNT_KEY"]),
    ...(usage ? [] : ["CLAIMMD_ACCOUNT_USAGE"]),
    ...(payloadKey ? [] : [CLAIMMD_WEBHOOK_PAYLOAD_KEY_ENV]),
    ...(runner ? [] : ["DATABASE_PLATFORM_URL"]),
  ];
  if (missing.length > 0 || !usage || !runner) return { usage, bound: null, missing };
  const cipher = createWebhookPayloadCipher(
    parseWebhookPayloadKey(payloadKey, CLAIMMD_WEBHOOK_PAYLOAD_KEY_ENV),
    CLAIMMD_WEBHOOK_KEY_ID,
  );
  return { usage, bound: { usage, accountKey, cipher, runner }, missing: [] };
}

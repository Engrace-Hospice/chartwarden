// apps/backend/src/modules/12-dosespot/webhooks/secrets.ts — the per-tenant DoseSpot webhook secret source
// (M12 spec §2.5 D5 / §7.4.1: `webhookSecret` from the secrets manager, keyed by organization id).
//
// No credential store for DoseSpot exists in this repository, and no real DoseSpot secret exists in this
// environment. The port below is therefore the WHOLE contract; the ONLY production binding shipped is the
// environment-backed one, which yields NOTHING unless an operator sets `DOSESPOT_WEBHOOK_SECRETS` (a JSON map
// `{ "<organizationId>": "<secret>" }`). Unset/empty/malformed ⇒ `isConfigured() === false` ⇒ the route is
// DISABLED (503) — it never falls back to a default, a shared, or a derived secret.
export interface DoseSpotWebhookSecretResolver {
  /** `true` when at least one tenant secret source is bound; `false` ⇒ the whole route is disabled. */
  isConfigured(): boolean;
  /** The org's webhook secret, or `null` (⇒ the request is rejected exactly like a bad signature). */
  resolve(organizationId: string): Promise<string | null>;
}

export const DOSESPOT_WEBHOOK_SECRETS_ENV = "DOSESPOT_WEBHOOK_SECRETS";

/** The fail-closed default: nothing configured. */
export function createUnboundWebhookSecretResolver(): DoseSpotWebhookSecretResolver {
  return { isConfigured: () => false, resolve: async () => null };
}

/** Env-backed resolver (see the file header). Reads `env` ONCE at construction. Malformed JSON ⇒ unbound. */
export function createEnvWebhookSecretResolver(
  env: Record<string, string | undefined> = process.env,
): DoseSpotWebhookSecretResolver {
  const raw = env[DOSESPOT_WEBHOOK_SECRETS_ENV];
  if (!raw || raw.trim() === "") return createUnboundWebhookSecretResolver();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createUnboundWebhookSecretResolver();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return createUnboundWebhookSecretResolver();
  }
  const map = new Map<string, string>();
  for (const [org, secret] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof secret === "string" && secret.length >= 16) map.set(org.toLowerCase(), secret);
  }
  if (map.size === 0) return createUnboundWebhookSecretResolver();
  return {
    isConfigured: () => true,
    resolve: async (organizationId) => map.get(organizationId.toLowerCase()) ?? null,
  };
}

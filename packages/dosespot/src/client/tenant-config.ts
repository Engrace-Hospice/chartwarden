// @wardenx/dosespot — the per-tenant DoseSpot configuration source (M12 §2.5 D5, GAP-037 close-out).
//
// THE ADAPTER IS UNBOUND UNLESS A TENANT HAS A COMPLETE CONFIG. The only production source shipped is
// environment-backed (the secrets manager injects it, like `DOSESPOT_WEBHOOK_SECRETS`): a JSON map
// `{ "<organizationId>": { baseUrl, subscriptionKey, clinicId, clinicKey, serviceClinicianId, epcsCertified? } }`
// in `DOSESPOT_TENANT_CONFIGS`. Unset / malformed / an incomplete entry ⇒ that tenant has NO config ⇒ every
// adapter call for it rejects with a non-retryable `DegradedError` and no order is ever queued for
// transmission (the route service asks `isConfiguredFor`). There is no default, shared or derived credential.
// `baseUrl` must be https (a plaintext vendor URL would carry PHI and the clinic key in the clear).
import type { DoseSpotCredentials } from "./contract";

export const DOSESPOT_TENANT_CONFIGS_ENV = "DOSESPOT_TENANT_CONFIGS";

/** One tenant's complete adapter configuration. Extends the §2.5 credential shape with the v2 API's two extra
 * inputs: the `Subscription-Key` header value and the clinician the service token is minted for. */
export interface DoseSpotTenantConfig extends Omit<DoseSpotCredentials, "webhookSecret"> {
  readonly subscriptionKey: string;
  /** The DoseSpot clinician id service calls (patient sync, history, status polling) authenticate as. */
  readonly serviceClinicianId: string;
  /** Present only when the tenant also uses the webhook; the route resolves its secret separately. */
  readonly webhookSecret?: string;
}

export interface DoseSpotTenantConfigResolver {
  /** `true` when at least one tenant has a complete configuration. */
  isConfigured(): boolean;
  /** Does THIS tenant have a complete configuration (⇒ e-prescribing is bound for it)? */
  isConfiguredFor(organizationId: string): boolean;
  /** The tenant's configuration, or `null` ⇒ the adapter fails closed for it. */
  configFor(organizationId: string): DoseSpotTenantConfig | null;
  /** Tenants with a complete configuration (boot log + the transmit sweep's candidate set). */
  configuredOrganizationIds(): readonly string[];
}

const NONE: DoseSpotTenantConfigResolver = {
  isConfigured: () => false,
  isConfiguredFor: () => false,
  configFor: () => null,
  configuredOrganizationIds: () => [],
};

export function createUnboundTenantConfigResolver(): DoseSpotTenantConfigResolver {
  return NONE;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Validate one raw entry; `null` when anything required is missing or the URL is not https. */
export function parseTenantConfig(raw: unknown): DoseSpotTenantConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !nonEmpty(r.baseUrl) ||
    !nonEmpty(r.subscriptionKey) ||
    !nonEmpty(r.clinicId) ||
    !nonEmpty(r.clinicKey) ||
    !nonEmpty(r.serviceClinicianId)
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(r.baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const baseUrl = r.baseUrl.replace(/\/+$/, "");
  return {
    baseUrl,
    subscriptionKey: r.subscriptionKey,
    clinicId: r.clinicId,
    clinicKey: r.clinicKey,
    serviceClinicianId: r.serviceClinicianId,
    epcsCertified: r.epcsCertified === true,
    ...(nonEmpty(r.webhookSecret) ? { webhookSecret: r.webhookSecret } : {}),
  };
}

/** Env-backed resolver. Reads `env` ONCE. Malformed JSON ⇒ unbound; invalid entries are skipped (never repaired). */
export function createEnvTenantConfigResolver(
  env: Record<string, string | undefined> = process.env,
): DoseSpotTenantConfigResolver {
  const raw = env[DOSESPOT_TENANT_CONFIGS_ENV];
  if (!raw || raw.trim() === "") return NONE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NONE;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return NONE;
  const map = new Map<string, DoseSpotTenantConfig>();
  for (const [org, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const cfg = parseTenantConfig(entry);
    if (cfg) map.set(org.toLowerCase(), cfg);
  }
  if (map.size === 0) return NONE;
  return {
    isConfigured: () => true,
    isConfiguredFor: (org) => map.has(org.toLowerCase()),
    configFor: (org) => map.get(org.toLowerCase()) ?? null,
    configuredOrganizationIds: () => [...map.keys()],
  };
}

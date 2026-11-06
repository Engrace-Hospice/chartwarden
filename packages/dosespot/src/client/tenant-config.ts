// @chartwarden/dosespot — the per-tenant DoseSpot configuration source (M12 §2.5 D5, GAP-037 close-out).
//
// THE ADAPTER IS UNBOUND UNLESS A TENANT HAS A COMPLETE CONFIG. The only production source shipped is
// environment-backed (the secrets manager injects it, like `DOSESPOT_WEBHOOK_SECRETS`): a JSON map
// `{ "<organizationId>": { baseUrl, subscriptionKey, clinicId, clinicKey, serviceClinicianId, epcsCertified? } }`
// in `DOSESPOT_TENANT_CONFIGS`. Unset / malformed / an incomplete entry ⇒ that tenant has NO config ⇒ every
// adapter call for it rejects with a non-retryable `DegradedError` and no order is ever queued for
// transmission (the route service asks `isConfiguredFor`). There is no default, shared or derived credential.
// `baseUrl` must be https (a plaintext vendor URL would carry PHI and the clinic key in the clear).
//
// SLICE 4 (tenant onboarding): the per-tenant source of truth is now the `dosespot_clinic_registration` row, read through a
// {@link DoseSpotTenantConfigSource} and layered IN FRONT of the env map ({@link createLayeredTenantConfigResolver}). A tenant
// WITH a row is served by that row alone (a draft, registered, verified-but-not-active or deactivated row means "not live":
// the env entry never serves it); a tenant with NO row falls through to the env entry exactly as before. Reads are async
// because the row lives in the database and its credential is sealed.
import type { DoseSpotCredentials } from "./contract";

export const DOSESPOT_TENANT_CONFIGS_ENV = "DOSESPOT_TENANT_CONFIGS";

/** One tenant's complete adapter configuration. Extends the §2.5 credential shape with the v2 API's two extra
 * inputs: the `Subscription-Key` header value and the clinician the service token is minted for. */
export interface DoseSpotTenantConfig extends Omit<DoseSpotCredentials, "webhookSecret"> {
  readonly subscriptionKey: string;
  /**
   * The config's generation (the registration row's `version`; an env entry has none). The token cache keys on it, so a
   * rotated credential never reuses a token minted under the old key.
   */
  readonly version?: number;
  /** The DoseSpot clinician id service calls (patient sync, history, status polling) authenticate as. */
  readonly serviceClinicianId: string;
  /** Present only when the tenant also uses the webhook; the route resolves its secret separately. */
  readonly webhookSecret?: string;
}

/**
 * Why a caller wants the config: `operate` (patient sync, transmission, status poll, ...) needs a LIVE (`active`) config;
 * `setup` (a prescriber's vendor enrolment) is allowed from `verified` on, so a tenant can enrol its prescribers before it
 * activates. An env entry has no lifecycle, so both purposes see it.
 */
export type DoseSpotConfigPurpose = "operate" | "setup";

export interface DoseSpotTenantConfigResolver {
  /** `true` when at least one tenant is known to have a complete configuration WITHOUT a lookup (the env fallback). */
  isConfigured(): boolean;
  /** Does THIS tenant have a live configuration (⇒ e-prescribing is bound for it)? Never opens a sealed credential. */
  isConfiguredFor(organizationId: string): Promise<boolean>;
  /** The tenant's configuration for `purpose` (default `operate`), or `null` ⇒ the adapter fails closed for it. */
  configFor(
    organizationId: string,
    purpose?: DoseSpotConfigPurpose,
  ): Promise<DoseSpotTenantConfig | null>;
  /** Tenants named without a lookup (the env fallback): boot log only. A database-backed source names none. */
  configuredOrganizationIds(): readonly string[];
}

/** What a database-backed source knows about one org for one purpose. */
export type DoseSpotConfigLookup =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      /** Is the row in a state the purpose may use? Answered WITHOUT opening the sealed credential. */
      readonly usable: boolean;
      /** Opens the sealed credential. Only called when `usable`; throws when it cannot be opened. */
      readonly load: () => Promise<DoseSpotTenantConfig>;
    };

export interface DoseSpotTenantConfigSource {
  lookup(organizationId: string, purpose: DoseSpotConfigPurpose): Promise<DoseSpotConfigLookup>;
}

/**
 * Database in front of env: an org with a row is served by the row alone; an org with none falls through to `fallback`.
 * This is what keeps an env credential from silently serving a tenant that rotated or deactivated its own.
 */
export function createLayeredTenantConfigResolver(deps: {
  readonly source: DoseSpotTenantConfigSource;
  readonly fallback: DoseSpotTenantConfigResolver;
}): DoseSpotTenantConfigResolver {
  const { source, fallback } = deps;
  return {
    isConfigured: () => fallback.isConfigured(),
    async isConfiguredFor(organizationId) {
      const found = await source.lookup(organizationId, "operate");
      return found.kind === "absent" ? fallback.isConfiguredFor(organizationId) : found.usable;
    },
    async configFor(organizationId, purpose = "operate") {
      const found = await source.lookup(organizationId, purpose);
      if (found.kind === "absent") return fallback.configFor(organizationId, purpose);
      return found.usable ? found.load() : null;
    },
    configuredOrganizationIds: () => fallback.configuredOrganizationIds(),
  };
}

const NONE: DoseSpotTenantConfigResolver = {
  isConfigured: () => false,
  isConfiguredFor: async () => false,
  configFor: async () => null,
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
    isConfiguredFor: async (org) => map.has(org.toLowerCase()),
    configFor: async (org) => map.get(org.toLowerCase()) ?? null,
    configuredOrganizationIds: () => [...map.keys()],
  };
}

// @chartwarden/dosespot — which DoseSpot host an `environment` means (slice 4, tenant onboarding).
//
// A tenant (or an operator on its behalf) picks an ENVIRONMENT, never a URL: the host is platform configuration. A URL the
// caller could type would let a registration aim the clinic key and PHI at any server (SSRF), so none is ever accepted.
//   sandbox     DoseSpot's public staging host (`DOSESPOT_BASE_URL_SANDBOX` may change its port or path, never its hostname).
//   production  NO baked-in host: it needs `DOSESPOT_PRODUCTION_ENABLED=true` (set only once the ChartWarden / DoseSpot BAA is
//               executed and a sandbox run has confirmed the wire shapes) AND an explicit `DOSESPOT_BASE_URL_PRODUCTION`.
// Every override must be https, on a `dosespot.com` host, with no credentials in the URL and no IP literal; a sandbox one must
// also name the sandbox hostname.
export type DoseSpotEnvironment = "sandbox" | "production";

export const DOSESPOT_SANDBOX_DEFAULT_BASE_URL = "https://my.staging.dosespot.com/webapi/v2";
export const DOSESPOT_PRODUCTION_ENABLED_ENV = "DOSESPOT_PRODUCTION_ENABLED";
export const DOSESPOT_SANDBOX_ENABLED_ENV = "DOSESPOT_SANDBOX_ENABLED";

const BASE_URL_ENV: Readonly<Record<DoseSpotEnvironment, string>> = {
  sandbox: "DOSESPOT_BASE_URL_SANDBOX",
  production: "DOSESPOT_BASE_URL_PRODUCTION",
};
const SUBSCRIPTION_KEY_ENV: Readonly<Record<DoseSpotEnvironment, string>> = {
  sandbox: "DOSESPOT_SUBSCRIPTION_KEY_SANDBOX",
  production: "DOSESPOT_SUBSCRIPTION_KEY_PRODUCTION",
};

type Env = Readonly<Record<string, string | undefined>>;

export type DoseSpotEnvironmentResolution =
  | { readonly ok: true; readonly baseUrl: string }
  | {
      readonly ok: false;
      readonly reason: "production_disabled" | "production_url_unset" | "base_url_invalid";
    };

const HOST_SUFFIX = ".dosespot.com";
/**
 * The ONE hostname a sandbox base URL may name. The guard compares HOSTNAMES (port and case stripped), and refuses every other
 * `*.dosespot.com` host, not just the one production host we know: the production flag guards production only, so a sandbox variable
 * naming `my.dosespot.com:8443`, `api.dosespot.com` or any host we have not seen must not reach a real environment.
 * Extend it when the sandbox run confirms another genuine sandbox host.
 */
const SANDBOX_HOSTNAME = new URL(DOSESPOT_SANDBOX_DEFAULT_BASE_URL).hostname;

/** The URL without a trailing slash, or null when it is not an https `*.dosespot.com` URL with no credentials. */
function vendorUrlOrNull(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (!url.hostname.endsWith(HOST_SUFFIX) || url.hostname.length <= HOST_SUFFIX.length) return null;
  return raw.trim().replace(/\/+$/, "");
}

/** The base URL for `environment`, or why it has none. Pure: the caller passes the environment variables. */
export function resolveDoseSpotEnvironment(
  environment: DoseSpotEnvironment,
  env: Env,
): DoseSpotEnvironmentResolution {
  if (environment === "production" && env[DOSESPOT_PRODUCTION_ENABLED_ENV] !== "true") {
    return { ok: false, reason: "production_disabled" };
  }
  const override = env[BASE_URL_ENV[environment]]?.trim();
  if (override === undefined || override === "") {
    return environment === "sandbox"
      ? { ok: true, baseUrl: DOSESPOT_SANDBOX_DEFAULT_BASE_URL }
      : { ok: false, reason: "production_url_unset" };
  }
  const baseUrl = vendorUrlOrNull(override);
  if (baseUrl === null) return { ok: false, reason: "base_url_invalid" };
  // The production flag guards production only, so the sandbox variable may name the sandbox hostname and nothing else.
  if (environment === "sandbox" && new URL(baseUrl).hostname !== SANDBOX_HOSTNAME) {
    return { ok: false, reason: "base_url_invalid" };
  }
  return { ok: true, baseUrl };
}

/**
 * May a registration in `environment` be LIVE (activated, transmitting, settling the wizard step) on this deployment?
 *   production  its flag and host (the same test `resolveDoseSpotEnvironment` applies);
 *   sandbox     `DOSESPOT_SANDBOX_ENABLED` exactly `true`. A sandbox registration may be VERIFIED anywhere (that is how an operator
 *               tries a tenant's credentials), but a deployment that does not enable sandbox must never serve one as live: prescriptions
 *               for real patients would go to DoseSpot's test environment.
 */
export function environmentAllowsLive(environment: DoseSpotEnvironment, env: Env): boolean {
  if (!resolveDoseSpotEnvironment(environment, env).ok) return false;
  return environment === "production" || isSandboxEnabled(env);
}

export function isSandboxEnabled(env: Env): boolean {
  return env[DOSESPOT_SANDBOX_ENABLED_ENV] === "true";
}

/** The platform's own Subscription-Key for `environment`, used when a tenant's row carries none; null when unset. */
export function subscriptionKeyFallback(environment: DoseSpotEnvironment, env: Env): string | null {
  const key = env[SUBSCRIPTION_KEY_ENV[environment]]?.trim();
  return key === undefined || key === "" ? null : key;
}

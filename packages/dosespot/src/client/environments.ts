// @chartwarden/dosespot — which DoseSpot host an `environment` means (slice 4, tenant onboarding).
//
// A tenant (or an operator on its behalf) picks an ENVIRONMENT, never a URL: the host is platform configuration. A URL the
// caller could type would let a registration aim the clinic key and PHI at any server (SSRF), so none is ever accepted.
//   sandbox     DoseSpot's public staging host by default (`DOSESPOT_BASE_URL_SANDBOX` may override it).
//   production  NO baked-in host: it needs `DOSESPOT_PRODUCTION_ENABLED=true` (set only once the ChartWarden / DoseSpot BAA is
//               executed and a sandbox run has confirmed the wire shapes) AND an explicit `DOSESPOT_BASE_URL_PRODUCTION`.
// Every override must be https, on a `dosespot.com` host, with no credentials in the URL and no IP literal.
export type DoseSpotEnvironment = "sandbox" | "production";

export const DOSESPOT_SANDBOX_DEFAULT_BASE_URL = "https://my.staging.dosespot.com/webapi/v2";
export const DOSESPOT_PRODUCTION_ENABLED_ENV = "DOSESPOT_PRODUCTION_ENABLED";

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
  return baseUrl === null ? { ok: false, reason: "base_url_invalid" } : { ok: true, baseUrl };
}

/** The platform's own Subscription-Key for `environment`, used when a tenant's row carries none; null when unset. */
export function subscriptionKeyFallback(environment: DoseSpotEnvironment, env: Env): string | null {
  const key = env[SUBSCRIPTION_KEY_ENV[environment]]?.trim();
  return key === undefined || key === "" ? null : key;
}

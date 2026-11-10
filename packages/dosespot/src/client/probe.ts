// @chartwarden/dosespot — the connection test (slice 4, tenant onboarding): mint ONE service-clinician token with a candidate
// config and report whether DoseSpot accepted it. It sends no patient data and touches no clinical endpoint, so it is safe to
// run before a tenant is live and from an operator's session. The result is a closed set, never an error body or a secret:
//   ok                   the token endpoint returned an access token
//   credential_rejected  the clinic id / key / Subscription-Key / clinician id were refused (400/401/403, or a 200 with no token)
//   unreachable          5xx, 429, a network failure, a timeout, or a response that could not be read
// "ok" proves the credentials were accepted. It does NOT prove DoseSpot accepts our payload field names (docs/history).
import { TOKEN_ENDPOINT } from "./endpoints";
import type { DoseSpotFetch } from "./http";
import { asString, pick } from "./mappers";
import { classifyRetryableStatus } from "./retry";
import type { DoseSpotTenantConfig } from "./tenant-config";
import { buildTokenRequest } from "./token-request";

export type ConnectionProbeOutcome = "ok" | "credential_rejected" | "unreachable";

export interface DoseSpotConnectionProbe {
  probe(config: DoseSpotTenantConfig): Promise<ConnectionProbeOutcome>;
}

export interface HttpConnectionProbeDeps {
  readonly fetch?: DoseSpotFetch;
  readonly requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const defaultFetch: DoseSpotFetch = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<DoseSpotFetch>;

export function createHttpDoseSpotConnectionProbe(
  deps: HttpConnectionProbeDeps = {},
): DoseSpotConnectionProbe {
  const doFetch = deps.fetch ?? defaultFetch;
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async probe(config) {
      const request = buildTokenRequest(config, config.serviceClinicianId);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${config.baseUrl}${TOKEN_ENDPOINT.path}`, {
          method: TOKEN_ENDPOINT.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
          redirect: "error", // never re-send the clinic key and Subscription-Key to wherever a 307/308 points
        });
        if (classifyRetryableStatus(res.status)) return "unreachable";
        if (res.status < 200 || res.status >= 300) return "credential_rejected";
        let parsed: unknown;
        try {
          parsed = JSON.parse(await res.text());
        } catch {
          return "unreachable";
        }
        return asString(pick(parsed, "access_token")) === undefined ? "credential_rejected" : "ok";
      } catch {
        return "unreachable"; // network failure or timeout: a vendor we could not reach, not a failed request
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

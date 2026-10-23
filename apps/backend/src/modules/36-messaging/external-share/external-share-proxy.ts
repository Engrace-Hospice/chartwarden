// M36 WP 6.6 (ADR-0096 D17) - may partner access run on this deployment? The partner routes budget by client address (`request.ip`). Fastify derives that
// from the socket peer unless the peer is in `TRUSTED_PROXY_CIDRS` (bootstrap/trusted-proxies.ts, the one validated reading). Behind a load balancer
// with the list missing every partner shares ONE bucket (the budget is meaningless and one caller locks everyone out); with a list that trusts every
// address (/0, a wildcard, a boolean) the key is whatever the caller writes in X-Forwarded-For. Either way the budget protects nothing.
//
// So the feature is available only when EITHER NODE_ENV is explicitly `development` or `test` (the socket peer is the real client) OR the list is
// present AND valid. Anything else - production, staging, `prod`, a typo, unset - needs a valid list. Otherwise the partner routes are not mounted and
// creating or reissuing a share is refused, so a share nobody can use is never made.
import { inspectTrustedProxies } from "../../../bootstrap/trusted-proxies";

export interface PartnerAccessAvailability {
  readonly available: boolean;
  /** One boot warning line when unavailable; null otherwise. Names the offending entries; contains no secret. */
  readonly warning: string | null;
}

const LOCAL_ENVIRONMENTS: ReadonlySet<string> = new Set(["development", "test"]);

export function partnerAccessAvailability(env: {
  readonly NODE_ENV?: string | undefined;
  readonly TRUSTED_PROXY_CIDRS?: string | undefined;
}): PartnerAccessAvailability {
  if (env.NODE_ENV !== undefined && LOCAL_ENVIRONMENTS.has(env.NODE_ENV)) {
    return { available: true, warning: null };
  }
  const list = inspectTrustedProxies(env.TRUSTED_PROXY_CIDRS);
  if (list.valid) return { available: true, warning: null };
  const why =
    list.entries.length === 0
      ? "TRUSTED_PROXY_CIDRS is unset or empty"
      : `TRUSTED_PROXY_CIDRS has invalid or over-broad entries (${list.invalid.map((e) => JSON.stringify(e)).join(", ")}); /0 prefixes, wildcards, booleans and malformed addresses are refused`;
  return {
    available: false,
    warning: `M36 external partner access is DISABLED: ${why} (NODE_ENV=${JSON.stringify(env.NODE_ENV ?? null)}), so per-address budgets would be keyed on the proxy's address or an attacker-chosen one. Partner routes are not mounted and creating or reissuing a partner share answers PARTNER_ACCESS_UNAVAILABLE (503). Set TRUSTED_PROXY_CIDRS to the real proxy hops (or NODE_ENV=development/test locally) to enable it.`,
  };
}

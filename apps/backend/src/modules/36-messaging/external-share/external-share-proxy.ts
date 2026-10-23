// M36 WP 6.6 (ADR-0096 D17) - may partner access run on this deployment? The partner routes budget by client address (`request.ip`). Fastify derives that
// from the socket peer unless `TRUSTED_PROXY_CIDRS` names the proxy hops (bootstrap/index.ts parseTrustedProxies). Behind a load balancer with the
// variable unset every partner shares ONE bucket (the budget is meaningless and one caller locks everyone out), so in production the feature fails
// CLOSED: the partner routes are not mounted and creating or reissuing a share is refused, so a share nobody can use is never made. Outside
// production (development, tests) the socket peer is the real client and the feature is available.
export interface PartnerAccessAvailability {
  readonly available: boolean;
  /** One boot warning line when unavailable; null otherwise. Contains no secret. */
  readonly warning: string | null;
}

export function partnerAccessAvailability(env: {
  readonly NODE_ENV?: string | undefined;
  readonly TRUSTED_PROXY_CIDRS?: string | undefined;
}): PartnerAccessAvailability {
  if (env.NODE_ENV !== "production") return { available: true, warning: null };
  const configured = (env.TRUSTED_PROXY_CIDRS ?? "")
    .split(",")
    .some((entry) => entry.trim().length > 0);
  if (configured) return { available: true, warning: null };
  return {
    available: false,
    warning:
      "M36 external partner access is DISABLED: NODE_ENV=production and TRUSTED_PROXY_CIDRS is unset or empty, so per-address budgets would be keyed on the proxy's address. Partner routes are not mounted and creating or reissuing a partner share answers PARTNER_ACCESS_UNAVAILABLE (503). Set TRUSTED_PROXY_CIDRS to the proxy hops to enable it.",
  };
}

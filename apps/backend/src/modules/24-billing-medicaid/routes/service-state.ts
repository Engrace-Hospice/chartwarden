// apps/backend/src/modules/24-billing-medicaid/routes/service-state.ts — GAP-196: derive the Medicaid
// service state for an eligibility check from the trading-partner credentials in force, never from an
// arbitrary `LIMIT 1` row. Pure; the caller supplies the (already org-scoped) credential rows.

export interface ServiceStateCredential {
  readonly serviceState: string;
  readonly activeFrom: Date;
  readonly activeTo: Date | null;
}

export type ServiceStateResolution =
  | { readonly kind: "resolved"; readonly state: string }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly states: readonly string[] };

/**
 * Credentials active on `asOf` decide the state. Exactly one distinct state resolves; several (a
 * multi-state tenant that did not name a provider entity) is `ambiguous` rather than a silent first-row
 * pick, which would record the check against the wrong state.
 */
export function resolveServiceState(
  creds: readonly ServiceStateCredential[],
  asOf: Date,
): ServiceStateResolution {
  const states = [
    ...new Set(
      creds
        .filter((c) => c.activeFrom <= asOf && (c.activeTo === null || c.activeTo >= asOf))
        .map((c) => c.serviceState),
    ),
  ].sort();
  if (states.length === 0) return { kind: "none" };
  if (states.length === 1) return { kind: "resolved", state: states[0] as string };
  return { kind: "ambiguous", states };
}

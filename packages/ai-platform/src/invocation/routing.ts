// @wardenx/ai-platform — §3.2.4 / §3.2.13 / W8 routing resolution (M32-T04).
//
// WHICH BACKEND SERVES THIS CALL — and, separately, WHICH BACKEND THE LEDGER ROW NAMES when nothing
// serves it. Pure: the registry rows, the capability's chain, the tenant's consented routing preference
// and any live override come in as facts; a decision comes out. No IO, no clock (`at` is passed).
//
// ── W8 IS THE SHAPE OF THIS FILE, NOT A CASE IT HANDLES ────────────────────────────────────────────
//
// "All subsequent invocations route to the local backend; the Anthropic backend is **not contacted**
// under any circumstance (no fallback to cloud)." So the preference is applied as a FILTER over the
// candidate chain BEFORE health is consulted, never as a preference-ordering that a health failure can
// walk past. `local_only` with every local backend unhealthy resolves to NOTHING — which is exactly
// W8.3's expected outcome (`unavailable`), and is why the health filter runs last: a filter that ran
// before the kind filter could leave a healthy cloud backend as the sole survivor of a `local_only`
// chain and no later step would know it had been forbidden.
//
// ── THE LEDGER ROUTE IS A SEPARATE ANSWER FROM THE SERVABLE ROUTE ──────────────────────────────────
//
// `ai_invocation.backend_id` / `backend_key` / `model_version_pin` / `routing_decision` /
// `routing_reason` are all NOT NULL, and W2/W9 both require a row for a call that never dispatched. A
// refused call therefore has to name the route it WOULD have taken — which is also the answer a
// §164.528 accounting wants ("which vendor was this about to reach?").
//
// That prospective route is the first candidate that survives the ALLOWED-SET, REGISTRY and PREFERENCE
// filters, with health ignored. Health is a property of the moment; the route is a property of the
// configuration, and a backend being down does not change which vendor the call was aimed at.
//
// It is NOT the capability's `default_backend_key` unconditionally. Naming the cloud default on a
// `local_only` tenant's refused call would put "anthropic-claude-opus-4-7" in that tenant's disclosure
// ledger for a call the platform had forbidden from ever reaching Anthropic — a false entry in the one
// record built to be read as true. When the preference filter empties the chain there is no truthful
// route to name, `ledgerRoute` is `null`, and the caller cannot write a row at all (the service reports
// that as `ledgerRecorded: false` rather than inventing a backend).
//
// ── HEALTH: `unknown` IS NOT ROUTABLE ──────────────────────────────────────────────────────────────
//
// §3.2.4 keeps `unknown` (registered, never probed) DISTINCT from `unhealthy` (answered badly), and D17
// gates a `local_only` opt-in on `healthy`. Routing must not be more permissive than the opt-in that
// authorised it, so only `healthy` and `degraded` route. `degraded` still routes because the §4.9 alert
// for it is informational — degraded is "slower / partially impaired", and refusing it would turn every
// latency blip into a capability outage.
import type {
  AiBackendHealthStatus,
  AiModelBackendKind,
  AiModelModality,
  AiRoutingDecision,
  AiRoutingPreference,
  AiRoutingReason,
  AiZdrStatus,
} from "@wardenx/types";

/** The `ai_model_backend` columns the routing gate reads. */
export interface AiBackendRoutingRow {
  readonly backendId: string;
  readonly backendKey: string;
  readonly kind: AiModelBackendKind;
  readonly isActive: boolean;
  readonly lastHealthStatus: AiBackendHealthStatus;
  readonly zdrStatus: AiZdrStatus;
  /** Copied verbatim onto `ai_invocation.model_version_pin` — the EXACT model that ran. */
  readonly modelVersionPin: string;
  readonly supportedModalities: readonly AiModelModality[];
}

/** The `ai_capability` columns the routing gate reads. */
export interface AiRoutingCapabilitySnapshot {
  readonly defaultBackendKey: string;
  readonly allowedBackendKeys: readonly string[];
  readonly fallbackChainKeys: readonly string[];
  /** §3.2.1 — `false` makes any `ai_routing_override` row for this capability inert. */
  readonly tenantOverrideAllowed: boolean;
  /** `null` when the capability states no modality requirement (no §3.2.1 column names one). */
  readonly requiredModality: AiModelModality | null;
}

/** A live `ai_routing_override` row (§3.2.13), already narrowed to the window that contains `at`. */
export interface AiActiveRoutingOverride {
  readonly backendKeyPreference: string;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
}

/** The route a call takes, or would have taken. */
export interface AiResolvedRoute {
  readonly backendId: string;
  readonly backendKey: string;
  readonly modelVersionPin: string;
  readonly kind: AiModelBackendKind;
  readonly decision: AiRoutingDecision;
  readonly reason: AiRoutingReason;
  /** §3.2.8's `zdr_confirmed` + its CHECK. True iff the registry says ZDR is on for this backend. */
  readonly zdrConfirmed: boolean;
}

/**
 * Why no backend may serve the call. Finer-grained than `AiCapabilityUnavailableReason` on purpose: the
 * seam vocabulary tells a CONSUMER what to do (fall back to Layer 1 — identical for all five), while
 * this tells an OPERATOR what to fix, and the two audiences need different words. The service maps this
 * to `backend_unhealthy` on the wire and carries the cause in the operator-facing `detail`.
 */
export type AiRoutingRefusalCause =
  | "override_backend_unregistered"
  | "override_outside_allowed_set"
  | "override_forbidden_by_capability"
  | "no_registered_backend_in_chain"
  | "no_backend_under_routing_preference"
  | "no_backend_supports_modality"
  | "no_healthy_backend";

/** The routing gate's answer. */
export interface AiRouteResolution {
  /** The backend that may actually run. `null` means nothing may. */
  readonly servable: AiResolvedRoute | null;
  /** What `ai_invocation` names — the servable route, or the prospective one (see header). */
  readonly ledgerRoute: AiResolvedRoute | null;
  readonly refusal: { readonly cause: AiRoutingRefusalCause; readonly detail: string } | null;
}

/** Everything `resolveAiRoute` needs. */
export interface AiRouteResolutionInput {
  readonly capability: AiRoutingCapabilitySnapshot;
  /**
   * The `routing_preference_snapshot` from the tenant's opt-in — see `resolveAiRoute`'s note.
   *
   * `null` means the tenant has NO opt-in record, so no narrowing has been consented to and the
   * capability's own chain order stands unfiltered. It is not a synonym for `prefer_cloud`: that value
   * would REORDER the chain cloud-first, silently promoting a cloud backend over the local default the
   * capability itself declared, on behalf of a tenant who has expressed nothing.
   */
  readonly routingPreference: AiRoutingPreference | null;
  readonly override: AiActiveRoutingOverride | null;
  /** `ai_model_backend` rows keyed by `backend_key`. A key ABSENT from the map is unregistered. */
  readonly backends: ReadonlyMap<string, AiBackendRoutingRow>;
}

/** §3.2.4's routable health set. See the header for why `unknown` is not in it. */
export const AI_ROUTABLE_HEALTH_STATUSES: readonly AiBackendHealthStatus[] = [
  "healthy",
  "degraded",
];

/** True when a registry row is in a state a call may be dispatched to. */
export function aiBackendIsRoutable(row: AiBackendRoutingRow): boolean {
  return row.isActive && AI_ROUTABLE_HEALTH_STATUSES.includes(row.lastHealthStatus);
}

/** The kinds a routing preference permits, in the order it prefers them. */
export function aiPreferredKindOrder(
  preference: AiRoutingPreference,
): readonly AiModelBackendKind[] {
  switch (preference) {
    case "local_only":
      return ["local"];
    case "cloud_only":
      return ["cloud"];
    case "prefer_local":
      return ["local", "cloud"];
    case "prefer_cloud":
      return ["cloud", "local"];
  }
}

function decisionForIndex(index: number): AiRoutingDecision {
  if (index === 0) return "primary";
  if (index === 1) return "fallback_1";
  return "fallback_2";
}

function toRoute(
  row: AiBackendRoutingRow,
  index: number,
  fromOverride: boolean,
  primarySkipped: boolean,
): AiResolvedRoute {
  return {
    backendId: row.backendId,
    backendKey: row.backendKey,
    modelVersionPin: row.modelVersionPin,
    kind: row.kind,
    decision: decisionForIndex(index),
    // `tenant_override` beats every other label: the tenant's standing instruction is WHY this backend
    // is in play at all, and a ledger that called it `default` would erase the tenant's decision from
    // the record that exists to show it. Past that, a link the primary was skipped FOR is a fallback,
    // and a health skip is `vendor_outage_fallback` — `cost_cap_fallback` and `kill_switch_fallback`
    // are stamped by the gates that own them (§3.1: the reason exists to make D7's cap fallback
    // distinguishable from an outage), not derivable from the chain.
    reason: fromOverride
      ? "tenant_override"
      : primarySkipped
        ? "vendor_outage_fallback"
        : "default",
    zdrConfirmed: row.zdrStatus === "enabled",
  };
}

/**
 * Resolve the backend for one invocation (§3.2.4 / §3.2.13 / W8).
 *
 * `routingPreference` is the tenant opt-in record's `routing_preference_snapshot`, NOT M2's live
 * `TenantConfiguration.ai_routing_preference`. The snapshot is the preference the §5.3.1
 * acknowledgments were given against — an org that flipped to `local_only` after opting in has not
 * re-consented, and honouring the live value would route under an authorisation nobody gave. The
 * opt-in workflow is where a preference change becomes effective (it rewrites the snapshot).
 */
export function resolveAiRoute(input: AiRouteResolutionInput): AiRouteResolution {
  const { capability, routingPreference, override, backends } = input;
  const allowed = new Set(capability.allowedBackendKeys);

  // ── the candidate chain, before any filter ───────────────────────────────────────────────────────
  let fromOverride = false;
  let chainKeys: readonly string[];

  if (override !== null) {
    if (!capability.tenantOverrideAllowed) {
      // §3.2.1's `tenant_override_allowed = false`. The row exists but the capability forbids it; a
      // stale override must not silently steer a capability the platform said tenants may not steer.
      return refuse(
        "override_forbidden_by_capability",
        `capability forbids tenant routing overrides; ignoring override to '${override.backendKeyPreference}'`,
      );
    }
    if (!allowed.has(override.backendKeyPreference)) {
      // NOT "fall back to the default". An override is usually a SOVEREIGNTY instruction (§3.2.13's
      // `tenant_sovereignty`), so quietly serving the capability's cloud default instead would do the
      // one thing the tenant wrote the row to prevent. Refusing hands the tenant their Layer-1 path
      // and leaves the misconfiguration visible.
      return refuse(
        "override_outside_allowed_set",
        `override names '${override.backendKeyPreference}', which is not in the capability's allowed_backend_keys`,
      );
    }
    if (!backends.has(override.backendKeyPreference)) {
      return refuse(
        "override_backend_unregistered",
        `override names '${override.backendKeyPreference}', which is not a registered ai_model_backend`,
      );
    }
    fromOverride = true;
    chainKeys = [override.backendKeyPreference];
  } else {
    // The default first, then the fallback chain, de-duplicated: §3.2.1 lets `fallback_chain_keys`
    // repeat the default, and a duplicate would shift a genuine fallback into the `fallback_2` slot.
    chainKeys = dedupe([capability.defaultBackendKey, ...capability.fallbackChainKeys]);
  }

  // ── filter 1: the capability's allowed set ───────────────────────────────────────────────────────
  const inAllowed = chainKeys.filter((k) => allowed.has(k));

  // ── filter 2: registered ─────────────────────────────────────────────────────────────────────────
  const registered: AiBackendRoutingRow[] = [];
  for (const key of inAllowed) {
    const row = backends.get(key);
    if (row !== undefined) registered.push(row);
  }
  if (registered.length === 0) {
    return refuse(
      "no_registered_backend_in_chain",
      `none of [${chainKeys.join(", ")}] is both allowed by the capability and registered in ai_model_backend`,
    );
  }

  // ── filter 3: modality ───────────────────────────────────────────────────────────────────────────
  const modality = capability.requiredModality;
  const byModality =
    modality === null
      ? registered
      : registered.filter((r) => r.supportedModalities.includes(modality));
  if (byModality.length === 0) {
    return refuse(
      "no_backend_supports_modality",
      `no backend in the chain supports the '${String(modality)}' modality`,
    );
  }

  // ── filter 4: the tenant's routing preference (W8) ───────────────────────────────────────────────
  // A FILTER, then a stable re-order — never an ordering alone. See the header.
  const byPreference: AiBackendRoutingRow[] = [];
  if (routingPreference === null) {
    byPreference.push(...byModality);
  } else {
    for (const kind of aiPreferredKindOrder(routingPreference)) {
      for (const row of byModality) if (row.kind === kind) byPreference.push(row);
    }
  }
  if (byPreference.length === 0) {
    return refuse(
      "no_backend_under_routing_preference",
      `routing preference '${String(routingPreference)}' admits no backend from the capability's chain`,
    );
  }

  // From here a truthful ledger route exists: `byPreference[0]` is the backend this call was aimed at.
  const prospective = byPreference[0] as AiBackendRoutingRow;
  const ledgerRoute = toRoute(prospective, 0, fromOverride, false);

  // ── filter 5: health — LAST, so it can never resurrect a backend an earlier filter forbade ───────
  const servableIndex = byPreference.findIndex((r) => aiBackendIsRoutable(r));
  if (servableIndex < 0) {
    return {
      servable: null,
      ledgerRoute,
      refusal: {
        cause: "no_healthy_backend",
        detail: `every backend admitted by preference '${String(routingPreference)}' is inactive or unhealthy: [${byPreference
          .map((r) => `${r.backendKey}=${r.isActive ? r.lastHealthStatus : "inactive"}`)
          .join(", ")}]`,
      },
    };
  }

  const servableRow = byPreference[servableIndex] as AiBackendRoutingRow;
  return {
    servable: toRoute(servableRow, servableIndex, fromOverride, servableIndex > 0),
    ledgerRoute,
    refusal: null,
  };
}

function refuse(cause: AiRoutingRefusalCause, detail: string): AiRouteResolution {
  // No `ledgerRoute`: every one of these causes means the platform cannot name a backend this call was
  // legitimately aimed at, and a §164.528 row naming a backend the call was forbidden to reach is worse
  // than the visible gap of no row (which the service surfaces as `ledgerRecorded: false`).
  return { servable: null, ledgerRoute: null, refusal: { cause, detail } };
}

function dedupe(keys: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

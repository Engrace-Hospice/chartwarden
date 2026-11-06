// @chartwarden/ui — ClaimsBillingNotice + useClaimsBilling (ADR-0108). The tenant's claims-billing add-on posture, shown
// atop the Medicare, Medicaid, remittance and commercial billing areas. One shared store: the app shell primes it per org
// and re-reads it after CLAIMS_BILLING_POSTURE_TTL_MS (`primeClaimsBilling`, GET /api/v1/billing/status); a 402 CLAIMS_BILLING_ADDON_REQUIRED observed anywhere
// (`noteClaimsBillingRefusal`, fed from the app's response hook or a screen's error path) flips every reader to
// blocked at once. `blocked` is what disables create / submit actions: only when the server enforces the add-on.
// In-flight work, voids and NOE/NOTR are never disabled by this; a replacement (TOB 817) is new work and is.
import { useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { ApiClient } from "../../core/api/client";
import { InlineAlert } from "./inline-alert";

export const CLAIMS_BILLING_ADDON_REQUIRED_CODE = "CLAIMS_BILLING_ADDON_REQUIRED";

export type ClaimsBillingDenyReason =
  // ADR-0053 amendment 2026-11-06: the gate follows the tenant's clearinghouse choice (the add-on reasons below are legacy).
  | "clearinghouse_not_chosen"
  | "clearinghouse_outside"
  | "clearinghouse_not_active"
  | "never_purchased"
  | "lapsed"
  | "subscription_suspended"
  | "subscription_canceled"
  | "subscription_paused";

export interface ClaimsBillingPosture {
  readonly entitled: boolean;
  readonly enforced: boolean;
  readonly reason: ClaimsBillingDenyReason | null;
}

export interface ClaimsBillingState {
  /** The posture, or null while unknown (not loaded, or the status read is not permitted for this user). */
  readonly posture: ClaimsBillingPosture | null;
  /** True when new claims work is refused right now: disable create / submit / check-eligibility actions. */
  readonly blocked: boolean;
}

const REASON_TEXT: Record<ClaimsBillingDenyReason, string> = {
  clearinghouse_not_chosen: "Your organization has not chosen a clearinghouse for claims yet.",
  clearinghouse_outside: "Your organization bills outside ChartWarden.",
  clearinghouse_not_active: "Your organization's clearinghouse is set up but not active yet.",
  never_purchased: "Your organization does not have the claims-billing add-on.",
  lapsed: "Your organization's claims-billing add-on has ended.",
  subscription_suspended: "Your subscription is suspended.",
  subscription_canceled: "Your subscription is canceled.",
  subscription_paused: "Your subscription is paused.",
};

/** How long a read posture is trusted before the next prime re-reads it (a platform grant shows without a reload). */
export const CLAIMS_BILLING_POSTURE_TTL_MS = 5 * 60_000;

let posture: ClaimsBillingPosture | null = null;
/** The org the posture was last requested for, and when. */
let requested: { readonly orgKey: string; readonly at: number } | null = null;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = (): ClaimsBillingPosture | null => posture;

/** The deny reason of a 402 add-on refusal (`{ error: { code, details: [{ code: reason }] } }`), or null. */
export function claimsBillingRefusalReason(error: unknown): ClaimsBillingDenyReason | null {
  if (error === null || typeof error !== "object") return null;
  const body = error as { error?: { code?: unknown; details?: Array<{ code?: unknown }> } };
  if (body.error?.code !== CLAIMS_BILLING_ADDON_REQUIRED_CODE) return null;
  const reason = body.error.details?.[0]?.code;
  return typeof reason === "string" && reason in REASON_TEXT
    ? (reason as ClaimsBillingDenyReason)
    : "never_purchased";
}

/** Record a 402 add-on refusal the app observed: every notice and gated action updates at once. */
export function noteClaimsBillingRefusal(error: unknown): boolean {
  const reason = claimsBillingRefusalReason(error);
  if (!reason) return false;
  posture = { entitled: false, enforced: true, reason };
  emit();
  return true;
}

/** Test-only: forget the cached posture. */
export function __resetClaimsBillingForTest(): void {
  posture = null;
  requested = null;
  emit();
}

/**
 * Read the posture for `orgKey` unless it was read for that org less than the TTL ago (cheap to call on every
 * navigation). The app shell calls it for a signed-in user who may read the billing status; anyone else stays
 * "unknown" until a 402 refusal tells the store. An org switch drops the previous org's posture at once.
 */
export function primeClaimsBilling(
  client: ApiClient,
  opts: { readonly orgKey?: string; readonly now?: number } = {},
): void {
  const orgKey = opts.orgKey ?? "";
  const now = opts.now ?? Date.now();
  if (requested?.orgKey === orgKey && now - requested.at < CLAIMS_BILLING_POSTURE_TTL_MS) return;
  if (requested !== null && requested.orgKey !== orgKey && posture !== null) {
    posture = null;
    emit();
  }
  const mine = { orgKey, at: now };
  requested = mine;
  void client
    .GET("/api/v1/billing/status")
    .then(({ data }) => {
      const cb = data?.claimsBilling;
      // A newer prime (another org, a later refresh) owns the store; no add-on service bound: stay as is.
      if (requested !== mine || !cb) return;
      posture = { entitled: cb.entitled, enforced: cb.enforced, reason: cb.reason };
      emit();
    })
    .catch(() => undefined);
}

export function useClaimsBilling(): ClaimsBillingState {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { posture: current, blocked: current !== null && !current.entitled && current.enforced };
}

/** The banner atop a billing area. Renders nothing when the org is entitled or the posture is unknown. */
export function ClaimsBillingNotice(): JSX.Element | null {
  const { posture: p } = useClaimsBilling();
  if (!p || p.entitled) return null;
  const why = REASON_TEXT[p.reason ?? "never_purchased"];
  return p.enforced ? (
    <InlineAlert tone="warning">
      {why} New claims, submissions, replacements and eligibility checks are paused. Claims already
      sent still finish, and NOE, NOTR, transfer notices and voids stay available. Contact
      ChartWarden to add claims billing.
    </InlineAlert>
  ) : (
    <InlineAlert tone="info">
      {why} Claims billing will need the add-on; nothing is blocked yet.
    </InlineAlert>
  );
}

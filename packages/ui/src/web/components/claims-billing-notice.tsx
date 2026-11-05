// @chartwarden/ui — ClaimsBillingNotice + useClaimsBilling (ADR-0108). The tenant's claims-billing add-on posture, shown
// atop the Medicare, Medicaid, remittance and commercial billing areas. One shared store: the app shell primes it once
// per page load (`primeClaimsBilling`, GET /api/v1/billing/status); a 402 CLAIMS_BILLING_ADDON_REQUIRED observed anywhere
// (`noteClaimsBillingRefusal`, fed from the app's response hook or a screen's error path) flips every reader to
// blocked at once. `blocked` is what disables create / submit actions: only when the server enforces the add-on.
// In-flight work, voids and NOE/NOTR are never disabled by this; a replacement (TOB 817) is new work and is.
import { useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { ApiClient } from "../../core/api/client";
import { InlineAlert } from "./inline-alert";

export const CLAIMS_BILLING_ADDON_REQUIRED_CODE = "CLAIMS_BILLING_ADDON_REQUIRED";

export type ClaimsBillingDenyReason =
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
  never_purchased: "Your organization does not have the claims-billing add-on.",
  lapsed: "Your organization's claims-billing add-on has ended.",
  subscription_suspended: "Your subscription is suspended.",
  subscription_canceled: "Your subscription is canceled.",
  subscription_paused: "Your subscription is paused.",
};

let posture: ClaimsBillingPosture | null = null;
let requested = false;
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
  requested = false;
  emit();
}

/**
 * Read the posture once per page load (idempotent). The app shell calls it for a signed-in user who may read the
 * billing status; anyone else stays "unknown" until a 402 refusal tells the store.
 */
export function primeClaimsBilling(client: ApiClient): void {
  if (requested) return;
  requested = true;
  void client
    .GET("/api/v1/billing/status")
    .then(({ data }) => {
      const cb = data?.claimsBilling;
      if (!cb) return; // no add-on service bound: stay unknown, never block
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

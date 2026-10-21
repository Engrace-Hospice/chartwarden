// @chartwarden/triage-vendors — the §4.4 / §8.5 `ExternalTriageVendorAdapter` interface (M19-T01).
//
// Per architecture §25.14 (the adapter mandate) this package is the ONLY place an external triage
// vendor's endpoint, credentials and payload shape live; dependency-cruiser (architecture-fitness §25.15
// check #2) forbids any other module — including the M19 backend — from calling a vendor directly. The
// M19 backend consumes ONLY this interface, resolved through the boot-registered vendor registry.
//
// M19-T01 ships the interface, the credentials shape and the D13 activation gate (the layout). Concrete
// vendor adapters are Phase-2 and per-customer: D3 keeps `hybrid`/`centralized` structurally complete
// but feature-flagged OFF until a vendor BAA and a Compliance-approved minimization profile exist, and
// ADR-013 (vendor selection) is still Proposed. Shipping a named adapter now would be shipping the half
// of a feature whose other half is a contract nobody has signed.
//
// PHI boundary: every outbound body is built by `minimizeForVendor` and gated by
// `assertVendorPayloadMinimized` (§7.10) before it reaches an adapter's `submit`. An adapter never sees
// the full `TriageVendorSourceContext` and never logs a body.

import { ChartWardenError } from "@chartwarden/types";

import type { VendorMinimizationProfile, VendorOutboundPayload } from "./minimization";

/** Per-(org, vendor) credentials resolved by the M19 credential store and handed to each call. The
 *  `secrets` map is opaque to the M19 backend — only the adapter interprets its keys. */
export interface TriageVendorCredentials {
  readonly organizationId: string;
  /** `external_triage_vendor.adapter_key`, e.g. `tenants/triage-vendor-<x>` (§3.3). */
  readonly adapterKey: string;
  readonly secrets: Record<string, string>;
}

/** The M19-side facts about a vendor binding that decide whether it may carry live calls. Mirrors the
 *  §3.3 `external_triage_vendor` columns the gate reads. */
export interface TriageVendorBinding {
  readonly externalTriageVendorId: string;
  readonly adapterKey: string;
  readonly minimizationProfile: VendorMinimizationProfile;
  /** D13 — BAA on file in the M4 BAA registry. */
  readonly baaInEffect: boolean;
  /** ISO date; null when the BAA has no stated expiry. */
  readonly baaExpiresOn: string | null;
  /** CoP 418.64(b) — the vendor attests RN coverage for the hours it answers. */
  readonly rnCoverageAttested: boolean;
}

/** The result of handing a call to a vendor. `refused` is the vendor declining the call (out of scope,
 *  no coverage); `transport_failure` is the network. The two are separated because only the second is
 *  worth retrying, and conflating them is how a vendor's "not mine" becomes an infinite retry loop. */
export type TriageVendorHandoffResult =
  | { readonly result: "accepted"; readonly vendorCallRef: string; readonly acceptedAt: string }
  | { readonly result: "refused"; readonly reasonCode: string; readonly reason: string }
  | { readonly result: "transport_failure"; readonly nextRetryAt: string };

/** What the vendor reports back about a call it is handling. M19 mirrors this onto its own
 *  `triage_call` row; the vendor never writes ChartWarden state. */
export type TriageVendorCallUpdate =
  | { readonly kind: "in_progress"; readonly observedAt: string }
  | {
      readonly kind: "escalated_to_agency";
      readonly observedAt: string;
      /** The vendor-side operator label recorded on `on_call_shift.external_actor_label` (§7.5). */
      readonly operatorLabel: string | null;
      readonly summary: string;
    }
  | { readonly kind: "resolved_by_vendor"; readonly observedAt: string; readonly summary: string };

/**
 * §4.4 / §8.5 — the external triage vendor adapter. One implementation per vendor; the registry selects
 * by `external_triage_vendor.adapter_key`.
 *
 * `supportedProfiles` is declared per adapter rather than assumed: a vendor whose contact centre cannot
 * disposition should not be bindable to `centralized_phi_min` at all, and the binding gate refuses that
 * pairing rather than discovering it when an operator picks a disposition they were never scoped for.
 */
export interface ExternalTriageVendorAdapter {
  /** Identifier for ops dashboards and the registry (matches `external_triage_vendor.adapter_key`). */
  readonly adapterKey: string;
  /** The D13 profiles this vendor's integration is built for. */
  readonly supportedProfiles: readonly VendorMinimizationProfile[];

  /** Hand an inbound call to the vendor. The body is already minimized and gated by the caller. */
  handoffCall(args: {
    readonly body: VendorOutboundPayload;
    readonly idempotencyKey: string;
    readonly credentials: TriageVendorCredentials;
  }): Promise<TriageVendorHandoffResult>;

  /** Poll a handed-off call for the vendor's own progress. */
  pollCall(args: {
    readonly vendorCallRef: string;
    readonly credentials: TriageVendorCredentials;
  }): Promise<TriageVendorCallUpdate>;

  /** Health probe for the ops dashboard and the §2.7 degraded-mode classifier. */
  healthy(): Promise<boolean>;
}

/** Thrown when a vendor binding may not carry live calls. */
export class TriageVendorBindingError extends ChartWardenError {
  constructor(
    message: string,
    public readonly reason:
      | "baa_missing"
      | "baa_expired"
      | "rn_coverage_not_attested"
      | "profile_unsupported"
      | "adapter_key_mismatch",
  ) {
    super("TRIAGE_VENDOR_BINDING_INACTIVE", message, 409);
    this.name = "TriageVendorBindingError";
  }
}

/**
 * D13 — the gate that decides whether a vendor binding may carry live calls, checked at binding creation
 * AND at every handoff. Both, because a BAA that was in effect when the binding was created expires on a
 * date nobody is watching at 02:00, and a check that only runs at creation would keep routing PHI to a
 * vendor whose agreement lapsed months earlier.
 *
 * `asOfIsoDate` is passed in rather than read from the clock so the check is deterministic and testable.
 * Throws rather than returning a boolean, for the same reason the minimization guard does.
 */
export function assertVendorBindingActive(
  binding: TriageVendorBinding,
  adapter: ExternalTriageVendorAdapter,
  asOfIsoDate: string,
): void {
  if (binding.adapterKey !== adapter.adapterKey) {
    throw new TriageVendorBindingError(
      `binding names adapter "${binding.adapterKey}" but resolved adapter is "${adapter.adapterKey}"`,
      "adapter_key_mismatch",
    );
  }
  if (!binding.baaInEffect) {
    throw new TriageVendorBindingError(
      `no BAA on file for vendor ${binding.externalTriageVendorId}`,
      "baa_missing",
    );
  }
  if (binding.baaExpiresOn !== null && binding.baaExpiresOn < asOfIsoDate) {
    throw new TriageVendorBindingError(
      `BAA for vendor ${binding.externalTriageVendorId} expired on ${binding.baaExpiresOn}`,
      "baa_expired",
    );
  }
  if (!binding.rnCoverageAttested) {
    throw new TriageVendorBindingError(
      `vendor ${binding.externalTriageVendorId} has not attested CoP 418.64(b) RN coverage`,
      "rn_coverage_not_attested",
    );
  }
  if (!adapter.supportedProfiles.includes(binding.minimizationProfile)) {
    throw new TriageVendorBindingError(
      `adapter "${adapter.adapterKey}" does not support profile "${binding.minimizationProfile}"`,
      "profile_unsupported",
    );
  }
}

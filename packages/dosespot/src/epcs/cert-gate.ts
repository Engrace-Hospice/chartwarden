// @chartwarden/dosespot — EPCS feature flag + per-tenant certification gate (§2.4 D18 / §1311.300, M12-T05).
// Pure, IO-free.
//
// EPCS (Electronic Prescribing of Controlled Substances) is fully BUILT in Phase 1, but production
// *certification* (the DEA-recognized Third-Party Audit per 21 CFR 1311.300 — Drummond Group; gated by
// ADR-006) is the deferred item. Two independent gates govern whether a controlled-substance signing session
// may even open:
//   1. The platform `dosespot.epcs` feature flag — OFF in Phase 1. This is the global kill switch; the whole
//      EPCS route surface (M12-T08) is a deny-stub behind it. {@link DEFAULT_DOSESPOT_EPCS_FLAGS}.
//   2. The per-tenant `epcs_certification_status` on `organization` (§1311.300 / D18) — `not_certified`
//      (default) and `audit_in_progress` block; `certified` permits; `revoked` blocks with an explicit alert.
// Drafts of controlled-substance orders may always exist (clinicians need to write the plan); it is the
// *transmission* of a Schedule II/III/IV/V NewRx that the gate blocks. Every fact is injected as data.
import type { EpcsCertificationStatus } from "@chartwarden/types";
import { requireEpcs } from "./errors";

/** The DoseSpot platform feature flags. `epcs` is the Phase-1 global kill switch (default OFF). */
export interface DoseSpotEpcsFlags {
  /** Master switch for the EPCS controlled-substance signing path. Phase 1: OFF — see
   * {@link DEFAULT_DOSESPOT_EPCS_FLAGS}. While OFF, every EPCS route is a deny-stub. */
  readonly epcs: boolean;
}

/** Phase-1 defaults: EPCS disabled platform-wide until the §1311.300 Third-Party Audit completes (ADR-006). */
export const DEFAULT_DOSESPOT_EPCS_FLAGS: DoseSpotEpcsFlags = { epcs: false } as const;

/** The §1311.300 / D18 cert-gate verdict for a tenant's `epcs_certification_status`. */
export type EpcsCertGateVerdict =
  /** `certified` — controlled-substance transmission permitted. */
  | { readonly permitted: true }
  /** `not_certified` / `audit_in_progress` / `revoked` — blocked, with the precise code + revoked flag. */
  | {
      readonly permitted: false;
      readonly code: "EPCS_NOT_CERTIFIED" | "EPCS_CERTIFICATION_REVOKED";
      /** True only for `revoked` — the route surfaces an explicit "certification revoked" alert (§2.4). */
      readonly revoked: boolean;
    };

/**
 * §2.4 D18 / §1311.300 — evaluate the per-tenant certification gate. Pure verdict (never throws), mirroring
 * the HearthNote eligibility-ladder shape so the route layer can branch on `permitted` and surface the
 * revoked alert. `certified` → permitted; `not_certified` / `audit_in_progress` → blocked
 * (`EPCS_NOT_CERTIFIED`); `revoked` → blocked (`EPCS_CERTIFICATION_REVOKED`, `revoked: true`).
 */
export function evaluateEpcsCertGate(status: EpcsCertificationStatus): EpcsCertGateVerdict {
  switch (status) {
    case "certified":
      return { permitted: true };
    case "revoked":
      return { permitted: false, code: "EPCS_CERTIFICATION_REVOKED", revoked: true };
    case "not_certified":
    case "audit_in_progress":
      return { permitted: false, code: "EPCS_NOT_CERTIFIED", revoked: false };
  }
}

/**
 * §2.4 D18 — assert controlled-substance transmission is permitted for this tenant, throwing the precise
 * {@link EpcsStateError} (`EPCS_NOT_CERTIFIED` / `EPCS_CERTIFICATION_REVOKED`) on a blocked status. The
 * route handler calls this before opening a signing session; the medication-order machine repeats the
 * `EPCS_NOT_CERTIFIED` guard inline as defence in depth.
 */
export function assertEpcsCertified(status: EpcsCertificationStatus): void {
  const verdict = evaluateEpcsCertGate(status);
  if (verdict.permitted) return;
  requireEpcs(
    false,
    verdict.code,
    verdict.revoked
      ? "the tenant's EPCS certification has been revoked; controlled-substance transmission is blocked"
      : "controlled-substance prescribing requires the tenant to be DEA EPCS-certified (D18)",
  );
}

/**
 * The Phase-1 platform kill switch (§2.4 D18). Asserts the `dosespot.epcs` flag is ON, throwing
 * `EPCS_FEATURE_DISABLED` when OFF — the outermost gate of every EPCS path. In Phase 1
 * ({@link DEFAULT_DOSESPOT_EPCS_FLAGS}) this always throws: the EPCS architecture is built, the route is a
 * deny-stub, and no Phase-1 route depends on it transmitting.
 */
export function assertEpcsFeatureEnabled(flags: DoseSpotEpcsFlags): void {
  requireEpcs(
    flags.epcs,
    "EPCS_FEATURE_DISABLED",
    "EPCS controlled-substance e-prescribing is disabled in Phase 1 (the `dosespot.epcs` flag is OFF)",
  );
}

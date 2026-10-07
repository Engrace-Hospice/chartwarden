// @wardenx/terminology-loader — the licensing gate (policy decided 2026-10-06; M38 §1.3, §3.9, §11 D4).
//
// Tier 1 PUBLIC systems load freely. Tier 2 LICENSED-FREE systems — SNOMED CT US (UMLS), RxNorm full release
// (UMLS) and LOINC (Regenstrief) — are free to use but only under a licence the platform operator has accepted
// and must attribute. A load of any non-public system is REFUSED unless an active attestation exists:
//   licensee · licence reference id · attested_by (platform operator) · effective/expiry · attribution text.
// The DB repeats this check inside `terminology_loader_register_version` / `…_stage_concepts` / `…_activate_version`
// (migration 0364) so a caller that skips this module still cannot load; this pure copy gives the route and the
// scheduled-source job the same decision with a precise reason, and is what the unit tests pin.
import type { LoadableSystemId } from "./types";

/** Systems whose licence terms require an attestation regardless of what the catalog row says today. */
export const LICENSE_GATED_SYSTEMS = [
  "snomed",
  "rxnorm",
  "loinc",
] as const satisfies readonly LoadableSystemId[];

/** One `terminology_license_attestation` row. */
export interface LicenseAttestation {
  readonly id: string;
  readonly system: LoadableSystemId;
  readonly licensee: string;
  readonly licenseReference: string;
  readonly attestedBy: string;
  /** ISO dates. */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly attributionText: string;
  readonly revokedAt: string | null;
}

export type LicenseRefusal =
  | "ATTESTATION_REQUIRED"
  | "ATTESTATION_EXPIRED"
  | "ATTESTATION_NOT_YET_EFFECTIVE"
  | "ATTESTATION_REVOKED"
  | "LICENSE_UNSUPPORTED";

export type LicenseVerdict =
  | { readonly allowed: true; readonly attestation: LicenseAttestation | null }
  | { readonly allowed: false; readonly reason: LicenseRefusal };

/** Catalog `license_source` values that carry licence terms (anything else — `public`, or a free-text label an older
 *  loader wrote such as "CDC/NCHS (public domain)" — is public). */
const LICENSED_SOURCES = ["umls", "regenstrief"] as const;

/** True when loading `system` needs an attestation: a licensed catalog source, or one of the gated systems. */
export function requiresAttestation(system: LoadableSystemId, licenseSource: string): boolean {
  return (
    (LICENSED_SOURCES as readonly string[]).includes(licenseSource) ||
    (LICENSE_GATED_SYSTEMS as readonly string[]).includes(system)
  );
}

const covers = (a: LicenseAttestation, today: string): boolean =>
  a.revokedAt === null &&
  a.effectiveFrom <= today &&
  (a.effectiveTo === null || a.effectiveTo >= today);

/** The pure gate. `today` is an ISO date (injected clock). */
export function evaluateLicenseGate(
  system: LoadableSystemId,
  licenseSource: string,
  attestations: readonly LicenseAttestation[],
  today: string,
): LicenseVerdict {
  if (licenseSource === "ama") return { allowed: false, reason: "LICENSE_UNSUPPORTED" };
  if (!requiresAttestation(system, licenseSource)) return { allowed: true, attestation: null };
  const mine = attestations.filter((a) => a.system === system);
  const active = mine.find((a) => covers(a, today));
  if (active) return { allowed: true, attestation: active };
  if (mine.length === 0) return { allowed: false, reason: "ATTESTATION_REQUIRED" };
  if (mine.every((a) => a.revokedAt !== null))
    return { allowed: false, reason: "ATTESTATION_REVOKED" };
  if (mine.some((a) => a.effectiveFrom > today))
    return { allowed: false, reason: "ATTESTATION_NOT_YET_EFFECTIVE" };
  return { allowed: false, reason: "ATTESTATION_EXPIRED" };
}

/** The attribution text to ship with a system's data, or null when none is required/active. */
export function attributionFor(
  attestations: readonly LicenseAttestation[],
  system: LoadableSystemId,
  today: string,
): string | null {
  const active = attestations
    .filter((a) => a.system === system && covers(a, today))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
  return active ? active.attributionText : null;
}

/** Input to record an attestation. */
export interface AttestationInput {
  readonly system: LoadableSystemId;
  readonly licensee: string;
  readonly licenseReference: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly attributionText: string;
}

/** Field-level validation (the DB function repeats the non-empty and date-order checks). Empty array = valid. */
export function validateAttestationInput(input: AttestationInput): string[] {
  const errors: string[] = [];
  if (input.licensee.trim() === "") errors.push("licensee is required");
  if (input.licenseReference.trim() === "") errors.push("licenseReference is required");
  if (input.attributionText.trim() === "") errors.push("attributionText is required");
  if (input.effectiveTo !== null && input.effectiveTo < input.effectiveFrom) {
    errors.push("effectiveTo must not precede effectiveFrom");
  }
  return errors;
}

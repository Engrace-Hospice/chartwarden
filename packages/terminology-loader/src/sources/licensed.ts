// @chartwarden/terminology-loader — tier-2 LICENSED-FREE sources behind a credential seam (SNOMED CT US, RxNorm full
// release, LOINC). NOTHING here fetches: no UMLS download client and no Regenstrief client exists in this
// repository, and a fetch that "works" without having been exercised against the real service is a lie.
//
// The seam is `LicensedSourceFetcher`. The composition root binds {@link licensedSourceDenyStub}, which throws
// `LicensedSourceCredentialMissingError` for every call (fail-closed, like M36's delivery-transport deny-stubs);
// the scheduled job turns that into a `skipped: credentials_not_configured` outcome rather than a retry storm.
//
// WHAT A REAL OPERATOR MUST DO TODAY (the supported path): obtain the release files under their own licence, record
// a licence attestation (POST /api/v1/admin/terminology/:system/license-attestation), upload the file to the platform
// bucket and call POST /api/v1/admin/terminology/:system/load. WHAT AUTOMATION WOULD NEED (not built):
//   snomed / rxnorm  a UMLS Terminology Services API key for an account holding the SNOMED CT US Edition affiliate
//                    licence and the RxNorm licence, and an implementation of the UTS download endpoint.
//   loinc            a Regenstrief (loinc.org) account's credentials and an implementation of the LOINC download.
import { LicensedSourceCredentialMissingError } from "../errors";
import type { LoadableSystemId } from "../types";
import type { FetchContext, FetchedSource } from "./adapter";

export type LicensedSystemId = Extract<LoadableSystemId, "snomed" | "rxnorm" | "loinc">;

/** The seam a real licensed-source adapter would implement. */
export interface LicensedSourceFetcher {
  fetchLatest(system: LicensedSystemId, ctx: FetchContext): Promise<FetchedSource | null>;
}

/** The fail-closed default: every call throws. */
export const licensedSourceDenyStub: LicensedSourceFetcher = {
  async fetchLatest(system) {
    throw new LicensedSourceCredentialMissingError(system);
  },
};

/** Human-readable statement of what must be configured for `system` (surfaced in logs and the admin response). */
export function credentialRequirement(system: LicensedSystemId): string {
  return system === "loinc"
    ? "Regenstrief (loinc.org) credentials and a LOINC download adapter (not built); until then upload Loinc.csv"
    : "a UMLS API key for an account holding the licence, and a UTS download adapter (not built); until then upload the RF2/RRF release";
}

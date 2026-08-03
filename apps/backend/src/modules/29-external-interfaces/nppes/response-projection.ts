// apps/backend/src/modules/29-external-interfaces/nppes — NPPES public-API projection (M29-T07, §2.1 / D10).
// PURE. The CMS NPI Registry JSON (`https://npiregistry.cms.hhs.gov/api/?version=2.1&number=<NPI>`) is a
// large, quirky shape; this module projects one raw result into `NppesIndividualProvider` — the stable
// internal record aligned to the `nppes_provider` jsonb columns (`basic`/`addresses`/`taxonomies`/
// `identifiers`) and the `nppes_provider_status` enum (`active`/`deactivated`, NOT the API's `A`/`D`).
//
// NON-GOAL (§1.2): NPI-2 (organization) entities. The M40 `external_physician` model is individual-only, so a
// classified NPI-2 short-circuits as `organization_skipped` before any DB write. Type-2 sync is a future PR.
import type { Npi, NppesProviderStatus } from "@wardenx/types";

/** The stable internal projection of one NPPES individual (NPI-1) provider. */
export interface NppesIndividualProvider {
  readonly npi: Npi;
  readonly enumerationType: "NPI-1";
  readonly status: NppesProviderStatus;
  readonly enumerationDate: string | null; // ISO yyyy-mm-dd
  readonly lastUpdated: string | null; // ISO yyyy-mm-dd (NPPES `last_updated`)
  readonly deactivationDate: string | null;
  readonly deactivationReason: string | null;
  readonly reactivationDate: string | null;
  readonly basic: NppesBasic;
  readonly addresses: readonly NppesAddress[];
  readonly taxonomies: readonly NppesTaxonomy[];
  readonly identifiers: readonly NppesIdentifier[];
}

export interface NppesBasic {
  readonly firstName: string;
  readonly middleName: string | null;
  readonly lastName: string;
  readonly credential: string | null;
  readonly gender: string | null;
  readonly namePrefix: string | null;
  readonly nameSuffix: string | null;
  readonly soleProprietor: string | null;
}

export interface NppesAddress {
  readonly purpose: "LOCATION" | "MAILING" | string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly countryCode: string;
  readonly telephoneNumber: string | null;
}

export interface NppesTaxonomy {
  readonly code: string;
  readonly desc: string;
  readonly primary: boolean;
  readonly state: string | null;
  readonly licenseNumber: string | null;
}

export interface NppesIdentifier {
  readonly code: string;
  readonly identifier: string;
  readonly state: string | null;
  readonly issuer: string | null;
}

/** The classified outcome of a single-NPI lookup — the union the orchestrator switches on (§2.1). */
export type NppesFetchResult =
  | { readonly kind: "found"; readonly provider: NppesIndividualProvider }
  | { readonly kind: "deactivated"; readonly provider: NppesIndividualProvider }
  | { readonly kind: "not_found"; readonly npi: Npi }
  | { readonly kind: "organization_skipped"; readonly npi: Npi }
  | { readonly kind: "invalid_format"; readonly npi: Npi };

// ── Raw API shapes (only the fields we read; the API sends far more) ─────────────────────────────────────

export interface NppesApiResponse {
  readonly result_count?: number;
  readonly results?: readonly NppesApiRawResult[];
}

export interface NppesApiRawResult {
  readonly number?: string;
  readonly enumeration_type?: "NPI-1" | "NPI-2" | string;
  readonly basic?: Record<string, unknown>;
  readonly addresses?: readonly Record<string, unknown>[];
  readonly taxonomies?: readonly Record<string, unknown>[];
  readonly identifiers?: readonly Record<string, unknown>[];
}

/**
 * Classify a raw NPPES response for `npi` (§2.1). The API returns HTTP 200 with `result_count: 0` for an
 * unknown NPI (never a 404), so an empty result set is `not_found`. NPI-2 is `organization_skipped`. A
 * projected NPI-1 with a `deactivated` status is `deactivated` (drives the A→D deactivation event); an active
 * one is `found`. Luhn is checked upstream by the client, so this never returns `invalid_format`.
 */
export function classifyNppesResponse(npi: Npi, response: NppesApiResponse): NppesFetchResult {
  const results = response.results ?? [];
  const raw = results[0];
  if ((response.result_count ?? results.length) === 0 || raw === undefined) {
    return { kind: "not_found", npi };
  }

  if (raw.enumeration_type === "NPI-2") {
    return { kind: "organization_skipped", npi };
  }

  const provider = projectProvider(npi, raw);
  return provider.status === "deactivated"
    ? { kind: "deactivated", provider }
    : { kind: "found", provider };
}

/** Project a raw NPI-1 result into the stable internal record (§2.1). Defensive against missing sub-objects. */
export function projectProvider(npi: Npi, raw: NppesApiRawResult): NppesIndividualProvider {
  const basic = (raw.basic ?? {}) as Record<string, unknown>;
  const rawStatus = str(basic.status);
  // NPPES omits `status` for active providers and sends `D` for deactivated ones.
  const status: NppesProviderStatus = rawStatus === "D" ? "deactivated" : "active";

  return {
    npi: str(raw.number) || npi,
    enumerationType: "NPI-1",
    status,
    enumerationDate: strOrNull(basic.enumeration_date),
    lastUpdated: strOrNull(basic.last_updated),
    deactivationDate: strOrNull(basic.deactivation_date),
    deactivationReason: strOrNull(basic.deactivation_reason),
    reactivationDate: strOrNull(basic.reactivation_date),
    basic: {
      firstName: str(basic.first_name),
      middleName: strOrNull(basic.middle_name),
      lastName: str(basic.last_name),
      credential: strOrNull(basic.credential),
      gender: strOrNull(basic.gender),
      namePrefix: strOrNull(basic.name_prefix),
      nameSuffix: strOrNull(basic.name_suffix),
      soleProprietor: strOrNull(basic.sole_proprietor),
    },
    addresses: (raw.addresses ?? []).map((a) => ({
      purpose: str(a.address_purpose),
      addressLine1: str(a.address_1),
      addressLine2: strOrNull(a.address_2),
      city: str(a.city),
      state: str(a.state),
      postalCode: str(a.postal_code),
      countryCode: str(a.country_code) || "US",
      telephoneNumber: strOrNull(a.telephone_number),
    })),
    taxonomies: (raw.taxonomies ?? []).map((t) => ({
      code: str(t.code),
      desc: str(t.desc),
      primary: Boolean(t.primary),
      state: strOrNull(t.state),
      licenseNumber: strOrNull(t.license),
    })),
    identifiers: (raw.identifiers ?? []).map((i) => ({
      code: str(i.code),
      identifier: str(i.identifier),
      state: strOrNull(i.state),
      issuer: strOrNull(i.issuer),
    })),
  };
}

/** The primary specialty taxonomy code (§4.7.1 — M40 maps this to `external_physician.specialty_taxonomy`). */
export function primaryTaxonomyCode(provider: NppesIndividualProvider): string | null {
  const primary = provider.taxonomies.find((t) => t.primary) ?? provider.taxonomies[0];
  return primary ? primary.code : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

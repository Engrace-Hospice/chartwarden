// apps/backend/src/modules/12-dosespot/tenant-config/practitioner-profile.ts — WHO a roster prescriber is, for a DoseSpot enrolment.
// Nobody types the NPI or the name. They come from the practitioner record the roster already links the membership to
// (`dosespot_prescriber.external_physician_mdm_id` -> M40's canonical `external_physician`, an NPPES-sourced master-data record
// that a tenant cannot write an NPI into), and are cross-checked against NPPES's public directory (`nppes_provider`, M29):
//   - the NPI must be present and pass the check digit;
//   - where NPPES has the NPI, it must be an ACTIVE individual (NPI-1) whose last name matches the record's;
//   - where NPPES has NO row, a PRODUCTION registration refuses (NPPES has not confirmed the NPI yet) and a SANDBOX one proceeds
//     flagged `nppesVerified: false` (the synthetic demo NPIs are not in the real registry).
// M12 reads M40 and M29 through narrow ports bound at the composition root (M12 has no edge to M29; both are seam reads).
import { ChartWardenError } from "@chartwarden/types";

/** The practitioner's identity as DoseSpot will be told it. */
export interface PractitionerProfile {
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
  /** NPPES's own row agreed with the record. False only for a sandbox registration whose NPI NPPES does not (yet) list. */
  readonly nppesVerified: boolean;
}

/** The slice of M40's `MdmEntityProvider.resolvePhysician` this needs. */
export interface PractitionerDirectoryPort {
  resolvePhysician(
    organizationId: string,
    mdmId: string,
  ): Promise<{
    readonly status: string;
    readonly canonical: {
      readonly identifierValue: string | null;
      readonly firstName: string;
      readonly lastName: string;
    };
  } | null>;
}

/** The slice of M29's `NppesProviderReader` this needs (`basic` is the cached NPPES projection, jsonb). */
export interface NppesDirectoryPort {
  getByNpi(input: { npi: string }): Promise<{
    readonly enumerationType: string;
    readonly status: string;
    readonly basic: unknown;
  } | null>;
}

export interface PractitionerProfileSource {
  profileFor(input: {
    readonly organizationId: string;
    /** The roster row's `external_physician_mdm_id` (null when the roster row names no physician record). */
    readonly physicianMdmId: string | null;
    readonly environment: string;
  }): Promise<PractitionerProfile>;
}

/**
 * The NPI check: ten digits whose Luhn check digit holds with the 80840 prefix.
 * ponytail: a local copy; M2 and M29 each carry theirs and modules may not import each other. Extract to a shared package when
 * a fourth consumer appears.
 */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi}`.split("").map(Number).reverse();
  const sum = digits.reduce((acc, d, i) => {
    if (i % 2 === 0) return acc + d;
    const doubled = d * 2;
    return acc + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  return sum % 10 === 0;
}

const refuse = (code: string, message: string, status: 409 | 422 = 409): ChartWardenError =>
  new ChartWardenError(code, message, status);

/**
 * A surname as NPPES and a master-data record may spell it differently: case, spaces, hyphens, apostrophes and accents are not a mismatch.
 * A name with no Latin letter in it (a non-Latin surname) reduces to the EMPTY key, which proves nothing: the caller refuses it.
 */
const surnameKey = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();

/** The cached NPPES projection keeps camelCase keys (`basic.lastName`); the raw API's snake_case is tolerated. */
function nppesLastName(basic: unknown): string | null {
  if (typeof basic !== "object" || basic === null) return null;
  const record = basic as Record<string, unknown>;
  const value = record.lastName ?? record.last_name;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function crossCheckNppes(
  row: { enumerationType: string; status: string; basic: unknown },
  recordLastName: string,
): void {
  if (row.enumerationType !== "NPI-1") {
    throw refuse(
      "DOSESPOT_NPPES_MISMATCH",
      "NPPES lists this NPI as an organization, not an individual prescriber",
    );
  }
  if (row.status !== "active") {
    throw refuse("DOSESPOT_NPPES_MISMATCH", "NPPES lists this NPI as deactivated");
  }
  const listed = nppesLastName(row.basic);
  const listedKey = listed === null ? "" : surnameKey(listed);
  const recordKey = surnameKey(recordLastName);
  if (listedKey === "" || recordKey === "" || listedKey !== recordKey) {
    throw refuse(
      "DOSESPOT_NPPES_MISMATCH",
      "the last name NPPES lists for this NPI does not match the practitioner record",
    );
  }
}

export function createPractitionerProfileSource(deps: {
  readonly directory: PractitionerDirectoryPort;
  readonly nppes: NppesDirectoryPort;
}): PractitionerProfileSource {
  return {
    async profileFor({ organizationId, physicianMdmId, environment }) {
      if (physicianMdmId === null) {
        throw refuse(
          "DOSESPOT_PRACTITIONER_NOT_LINKED",
          "this member is not linked to a physician record on the prescriber roster; link one before enrolling with DoseSpot",
        );
      }
      const record = await deps.directory.resolvePhysician(organizationId, physicianMdmId);
      if (record === null || record.status !== "active") {
        throw refuse(
          "DOSESPOT_PRACTITIONER_NOT_ACTIVE",
          "the physician record linked to this member is not an active master-data record",
        );
      }
      const npi = record.canonical.identifierValue;
      if (npi === null || npi.trim() === "") {
        throw refuse(
          "DOSESPOT_PRACTITIONER_NPI_MISSING",
          "the physician record linked to this member has no NPI on file",
        );
      }
      if (!isValidNpi(npi)) {
        throw refuse(
          "DOSESPOT_NPI_INVALID",
          "the NPI on the linked physician record is not a valid NPI (check digit)",
          422,
        );
      }
      const firstName = record.canonical.firstName.trim();
      const lastName = record.canonical.lastName.trim();
      if (firstName === "" || lastName === "") {
        throw refuse(
          "DOSESPOT_PRACTITIONER_NAME_MISSING",
          "the physician record linked to this member has no legal name on file",
        );
      }
      const listed = await deps.nppes.getByNpi({ npi });
      if (listed !== null) {
        crossCheckNppes(listed, lastName);
        return { npi, firstName, lastName, nppesVerified: true };
      }
      if (environment === "production") {
        throw refuse(
          "DOSESPOT_NPPES_UNVERIFIED",
          "NPPES has not confirmed this NPI yet; try again after the next NPPES sync, or ask platform support to run a lookup",
        );
      }
      return { npi, firstName, lastName, nppesVerified: false };
    },
  };
}

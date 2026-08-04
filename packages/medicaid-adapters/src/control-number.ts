// @wardenx/medicaid-adapters — M24 deterministic medicaid_claim_control_number derivation (D4 / §2.6).
// Mirrors the M23 @wardenx/billing kernel but is STATE-NAMESPACED: the control number is the idempotency
// key BOTH internally (the `(provider_entity_id, service_state, medicaid_claim_control_number,
// attempt_index)` unique index on medicaid_submission) AND at the state aggregator / CCO clearinghouse.
//
// FORMAT (D4): `{ccn}-{ST}-{yymmdd}-{base36(prefix,5)}-{attempt:02d}` — e.g. `381588-OR-260601-09zld-00`.
// LENGTH: 6 + 1 + 2 + 1 + 6 + 1 + 5 + 1 + 2 = 25 chars, under the medicaid_claim_control_number varchar(32).
// (The Medicare 23-char MAC ceiling is Medicare-specific and does not bind state Medicaid fields.)
//
// PURE DOMAIN: no Fastify, Drizzle, BullMQ, getSeam, clock. No PHI / no Recipient ID (D12 / §3.6).
import type { IsoDate, MedicaidClaimId, StateCode } from "./contracts";

export interface MedicaidControlNumberInput {
  /** The 6-char CMS Certification Number of the ProviderEntity. */
  readonly ccn: string;
  /** The two-letter US state the claim is routed to (`'OR'`). */
  readonly serviceState: StateCode;
  /** The claim's service-period start date (drives the `yymmdd` segment). */
  readonly serviceFrom: IsoDate;
  /** The claim row's UUID; its first 6 hex chars seed the opaque base36 segment. */
  readonly claimId: MedicaidClaimId;
  /** The 0-based submission attempt index. */
  readonly attemptIndex: number;
}

export interface ParsedMedicaidControlNumber {
  readonly ccn: string;
  readonly serviceState: string;
  readonly yymmdd: string;
  readonly claimIdPrefixBase36: string;
  readonly attemptIndex: number;
}

const CLAIM_ID_PREFIX_HEX_CHARS = 6;
const BASE36_SEGMENT_WIDTH = 5;
const MAX_CONTROL_NUMBER_LENGTH = 32; // medicaid_claim_control_number varchar(32)

const CCN_RE = /^[A-Za-z0-9]{6}$/;
const STATE_RE = /^[A-Z]{2}$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HEX_PREFIX_RE = /^[0-9a-f]+$/;

export const MEDICAID_CONTROL_NUMBER_RE =
  /^([A-Za-z0-9]{6})-([A-Z]{2})-(\d{6})-([0-9a-z]{5})-(\d{2})$/;

/**
 * Derive the deterministic medicaid_claim_control_number. Pure + total over valid inputs; throws a
 * `RangeError` with a precise message on malformed input. Identical inputs always yield the identical string.
 */
export function deriveMedicaidControlNumber(input: MedicaidControlNumberInput): string {
  const ccn = input.ccn.trim();
  if (!CCN_RE.test(ccn)) {
    throw new RangeError(
      `deriveMedicaidControlNumber: ccn must be 6 alphanumeric chars (got '${input.ccn}')`,
    );
  }
  const state = input.serviceState.trim().toUpperCase();
  if (!STATE_RE.test(state)) {
    throw new RangeError(
      `deriveMedicaidControlNumber: serviceState must be a 2-letter US state (got '${input.serviceState}')`,
    );
  }
  const dateMatch = ISO_DATE_RE.exec(input.serviceFrom);
  if (!dateMatch) {
    throw new RangeError(
      `deriveMedicaidControlNumber: serviceFrom must be ISO 'YYYY-MM-DD' (got '${input.serviceFrom}')`,
    );
  }
  const [, year, month, day] = dateMatch;
  const yymmdd = `${year!.slice(2)}${month}${day}`;

  if (!Number.isInteger(input.attemptIndex) || input.attemptIndex < 0 || input.attemptIndex > 99) {
    throw new RangeError(
      `deriveMedicaidControlNumber: attemptIndex must be an integer in [0, 99] (got ${input.attemptIndex})`,
    );
  }
  const attempt2 = String(input.attemptIndex).padStart(2, "0");

  const hexPrefix = input.claimId
    .replace(/-/g, "")
    .slice(0, CLAIM_ID_PREFIX_HEX_CHARS)
    .toLowerCase();
  if (hexPrefix.length < CLAIM_ID_PREFIX_HEX_CHARS || !HEX_PREFIX_RE.test(hexPrefix)) {
    throw new RangeError(
      `deriveMedicaidControlNumber: claimId must yield ${CLAIM_ID_PREFIX_HEX_CHARS} leading hex chars ` +
        `(got prefix '${hexPrefix}' from '${input.claimId}')`,
    );
  }
  const base36 = Number.parseInt(hexPrefix, 16).toString(36).padStart(BASE36_SEGMENT_WIDTH, "0");
  if (base36.length !== BASE36_SEGMENT_WIDTH) {
    throw new RangeError(
      `deriveMedicaidControlNumber: base36 segment width invariant broken ('${base36}')`,
    );
  }

  const controlNumber = `${ccn}-${state}-${yymmdd}-${base36}-${attempt2}`;
  if (controlNumber.length > MAX_CONTROL_NUMBER_LENGTH) {
    throw new RangeError(
      `deriveMedicaidControlNumber: '${controlNumber}' exceeds ${MAX_CONTROL_NUMBER_LENGTH} chars`,
    );
  }
  return controlNumber;
}

/** Parse a control number into its segments, or `null` if it does not conform. Pure + total — never throws. */
export function parseMedicaidControlNumber(
  controlNumber: string,
): ParsedMedicaidControlNumber | null {
  const match = MEDICAID_CONTROL_NUMBER_RE.exec(controlNumber);
  if (!match) return null;
  const [, ccn, serviceState, yymmdd, claimIdPrefixBase36, attempt] = match;
  return {
    ccn: ccn!,
    serviceState: serviceState!,
    yymmdd: yymmdd!,
    claimIdPrefixBase36: claimIdPrefixBase36!,
    attemptIndex: Number.parseInt(attempt!, 10),
  };
}

/** True iff `controlNumber` conforms to the D4 format and is within the column width. */
export function isValidMedicaidControlNumber(controlNumber: string): boolean {
  return (
    controlNumber.length <= MAX_CONTROL_NUMBER_LENGTH &&
    MEDICAID_CONTROL_NUMBER_RE.test(controlNumber)
  );
}

// @chartwarden/billing — M23 deterministic claim_control_number derivation (D4 / §2.6). The control number
// is the idempotency key BOTH internally (the `(provider_entity_id, claim_control_number, attempt_index)`
// unique index on `claim_submission`) AND at the MAC (the MAC dedupes on the control number so a retried
// submission is a no-op by construction). It is derived deterministically so the `claim.submit` worker
// can compute it from the claim alone without coordinating ID generation with the route handler (D2).
//
// FORMAT (D4): `{ccn}-{yymmdd}-{base36(claim_id_prefix)}-{attempt_index:02d}` — e.g. `381588-260601-09zldr…`.
//   * `ccn`                  — the 6-char CMS Certification Number of the ProviderEntity (resolved from
//                             `provider_entity_id` upstream; this PURE kernel takes the resolved CCN).
//   * `yymmdd`              — the claim's service-period start month (`claim.service_from`), 6 digits.
//   * `base36(prefix)`     — the first 6 hex chars (24 bits) of the claim UUID, base-36 encoded, padded
//                             to 5 chars. Opaque + un-correlatable: it leaks neither claim volume (vs. a
//                             sequential counter) nor any payer-id structure (D4 rationale).
//   * `attempt_index:02d`  — the 0-based submission attempt, 2 digits (retry max is 5 per spec §7.11).
//
// LENGTH: 6 + 1 + 6 + 1 + 5 + 1 + 2 = 22 chars, strictly under the 23-char MAC field convention (D4) so
// there is never a truncation surprise.
//
// COLLISION-FREEDOM: the namespace is per-CCN-per-month (the `ccn` + `yymmdd` segments) and the DB unique
// index `(provider_entity_id, claim_control_number, attempt_index)` is the hard backstop. Within a single
// CCN+month the 24-bit UUID prefix gives a birthday bound far beyond any real hospice's monthly claim
// volume (a few hundred claims), so the §9.5 100k-tuple fuzz across many CCNs/months yields zero
// collisions. The 24-bit prefix width is the maximum that fits the 5-char base36 budget under the 23-char
// MAC field ceiling. TODO(CMS-fixture): confirm the exact NGS-J6 patient-control-number field length on
// the first live 837I round-trip; widen the prefix only if the MAC field proves wider than 23.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`, no clock. No PHI /
// no MBI (D13 / §3.6). Deterministic: identical inputs always yield the identical string.
import type { ClaimId, IsoDate } from "./contracts";

/** The resolved primitive inputs to the deterministic derivation (D4). */
export interface ControlNumberInput {
  /** The 6-char CMS Certification Number of the ProviderEntity (resolved from `provider_entity_id`). */
  readonly ccn: string;
  /** The claim's service-period start date (`claim.service_from`); drives the `yymmdd` segment. */
  readonly serviceFrom: IsoDate;
  /** The claim row's UUID (`claim.id`); its first 6 hex chars seed the opaque base36 segment. */
  readonly claimId: ClaimId;
  /** The 0-based submission attempt index; increments on each MAC re-dispatch (D4). */
  readonly attemptIndex: number;
}

/** The structured decomposition of a parsed control number. */
export interface ParsedControlNumber {
  readonly ccn: string;
  readonly yymmdd: string;
  readonly claimIdPrefixBase36: string;
  readonly attemptIndex: number;
}

/** Number of leading hex characters of the claim UUID folded into the opaque base36 segment (24 bits). */
const CLAIM_ID_PREFIX_HEX_CHARS = 6;
/** Fixed width (chars) of the base36 segment; 24 bits ⇒ ≤ 5 base36 chars, left-zero-padded. */
const BASE36_SEGMENT_WIDTH = 5;
/** The strict upper bound on total length per the MAC field convention (D4). */
const MAX_CONTROL_NUMBER_LENGTH = 23;

const CCN_RE = /^[A-Za-z0-9]{6}$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HEX_PREFIX_RE = /^[0-9a-f]+$/;

/** The canonical format regex — what `parseControlNumber` / `isValidControlNumber` validate against. */
export const CONTROL_NUMBER_RE = /^([A-Za-z0-9]{6})-(\d{6})-([0-9a-z]{5})-(\d{2})$/;

/**
 * Derive the deterministic `claim_control_number` for a (CCN, service-from, claimId, attemptIndex) tuple.
 * Pure + total over valid inputs; throws a `RangeError` with a precise message on any malformed input so
 * the service layer maps it to a structured 422 rather than emit a malformed MAC field. Identical inputs
 * always yield the identical string.
 */
export function deriveControlNumber(input: ControlNumberInput): string {
  const ccn = input.ccn.trim();
  if (!CCN_RE.test(ccn)) {
    throw new RangeError(
      `deriveControlNumber: ccn must be 6 alphanumeric chars (got '${input.ccn}')`,
    );
  }

  const dateMatch = ISO_DATE_RE.exec(input.serviceFrom);
  if (!dateMatch) {
    throw new RangeError(
      `deriveControlNumber: serviceFrom must be an ISO date 'YYYY-MM-DD' (got '${input.serviceFrom}')`,
    );
  }
  const [, year, month, day] = dateMatch;
  const yymmdd = `${year!.slice(2)}${month}${day}`;

  if (!Number.isInteger(input.attemptIndex) || input.attemptIndex < 0 || input.attemptIndex > 99) {
    throw new RangeError(
      `deriveControlNumber: attemptIndex must be an integer in [0, 99] (got ${input.attemptIndex})`,
    );
  }
  const attempt2 = String(input.attemptIndex).padStart(2, "0");

  const hexPrefix = input.claimId
    .replace(/-/g, "")
    .slice(0, CLAIM_ID_PREFIX_HEX_CHARS)
    .toLowerCase();
  if (hexPrefix.length < CLAIM_ID_PREFIX_HEX_CHARS || !HEX_PREFIX_RE.test(hexPrefix)) {
    throw new RangeError(
      `deriveControlNumber: claimId must yield ${CLAIM_ID_PREFIX_HEX_CHARS} leading hex chars ` +
        `(got prefix '${hexPrefix}' from '${input.claimId}')`,
    );
  }
  const base36 = Number.parseInt(hexPrefix, 16).toString(36).padStart(BASE36_SEGMENT_WIDTH, "0");
  // 24-bit value ⇒ max base36 length 5; guard the invariant so a future prefix-width change can't
  // silently overflow the MAC field width.
  if (base36.length !== BASE36_SEGMENT_WIDTH) {
    throw new RangeError(
      `deriveControlNumber: base36 segment width invariant broken ('${base36}')`,
    );
  }

  const controlNumber = `${ccn}-${yymmdd}-${base36}-${attempt2}`;
  if (controlNumber.length >= MAX_CONTROL_NUMBER_LENGTH) {
    throw new RangeError(
      `deriveControlNumber: control number '${controlNumber}' is not under ${MAX_CONTROL_NUMBER_LENGTH} chars`,
    );
  }
  return controlNumber;
}

/**
 * Parse a control number into its four segments, or return `null` if the string does not conform to the
 * D4 format. Pure + total — never throws. `parseControlNumber(deriveControlNumber(x))` round-trips the
 * structural segments for every valid `x`.
 */
export function parseControlNumber(controlNumber: string): ParsedControlNumber | null {
  const match = CONTROL_NUMBER_RE.exec(controlNumber);
  if (!match) return null;
  const [, ccn, yymmdd, claimIdPrefixBase36, attempt] = match;
  return {
    ccn: ccn!,
    yymmdd: yymmdd!,
    claimIdPrefixBase36: claimIdPrefixBase36!,
    attemptIndex: Number.parseInt(attempt!, 10),
  };
}

/** True iff `controlNumber` conforms to the D4 format AND is strictly under the MAC field length. */
export function isValidControlNumber(controlNumber: string): boolean {
  return controlNumber.length < MAX_CONTROL_NUMBER_LENGTH && CONTROL_NUMBER_RE.test(controlNumber);
}

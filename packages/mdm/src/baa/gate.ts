// @wardenx/mdm — the pure §7.7 BAA-gate decision engine (M40-T06).
//
// Given the per-(org,kind) "is a BAA required?" policy flag, the candidate `mdm_baa_record` rows
// for a (org, kind, canonicalId), and the disclosure moment `asOf`, decide whether PHI may leave
// the perimeter. PURE and DB-agnostic — `BaaStatusProvider` (provider.ts) supplies the rows from
// Drizzle (T07) and the unit tests build them in-memory; this engine owns the §7.7 / §4.6.2
// `computeStatus` rules so the time-travel decision has exactly one home.
//
// The §7.10 time-travel invariant: a BAA active at attempt-time but expired at transmit-time must
// gate CLOSED at transmit-time (`asOf` = the actual transmission moment), so a job queued before
// expiry but processed after it is correctly refused.

import type {
  BaaEntityKind,
  BaaStatusKind,
  BaaStatusResult,
} from "../interfaces/baa-status-provider";
import { MDM_ENTITY_KIND_DESCRIPTORS } from "../interfaces/kinds";

/** The minimal `mdm_baa_record` projection the gate needs (§3.5). Dates are ISO yyyy-mm-dd. */
export interface BaaRecordRow {
  readonly id: string;
  readonly baaStatus: "executed" | "pending" | "n_a";
  readonly executedOn: string | null;
  readonly expiresOn: string | null;
}

/**
 * The HIPAA default when a tenant has no `mdm_baa_required` config row for a kind (§4.6.2
 * `defaultRequired`). Reuses the T01 `baaGated` descriptor flag — true for facility/payer/
 * referral_source, false for the DME-vendor / funeral-home kinds with no PHI flow.
 */
export function defaultBaaRequired(kind: BaaEntityKind): boolean {
  return MDM_ENTITY_KIND_DESCRIPTORS[kind].baaGated;
}

/** The §4.6.2 "no facility matched the sendingFacility" default — conservative: assume required. */
export const NO_MATCH_RESULT: BaaStatusResult = {
  isActive: false,
  status: "missing",
  expiresOn: null,
  requiredByPolicy: true,
  baaRecordId: null,
};

/** Is `r` an executed BAA covering `asOf` (signed on-or-before, not yet expired)? (§4.6.2 step 2) */
function activeAt(r: BaaRecordRow, asOf: Date): boolean {
  if (r.baaStatus !== "executed") return false;
  if (r.executedOn === null || new Date(r.executedOn) > asOf) return false;
  return r.expiresOn === null || new Date(r.expiresOn) >= asOf;
}

/** executedOn DESC; a null executedOn sorts last (matches the SQL `DESC NULLS LAST`). */
function byExecutedOnDescNullsLast(a: BaaRecordRow, b: BaaRecordRow): number {
  if (a.executedOn === b.executedOn) return 0;
  if (a.executedOn === null) return 1;
  if (b.executedOn === null) return -1;
  return a.executedOn < b.executedOn ? 1 : -1;
}

/**
 * Decide the §7.7 gate (§4.6.2 `computeStatus`). When no BAA is required → `n_a` (`isActive:true`,
 * "yes, none needed"). Otherwise: an executed record covering `asOf` → `executed` (`isActive:true`);
 * else classify the latest record — `pending`, an `expired` executed one (its `expires_on` is before
 * `asOf`), or `missing` (none, or executed-but-not-yet-effective).
 */
export function decideBaaStatus(input: {
  requiredByPolicy: boolean;
  records: readonly BaaRecordRow[];
  asOf: Date;
}): BaaStatusResult {
  if (!input.requiredByPolicy) {
    return {
      isActive: true,
      status: "n_a",
      expiresOn: null,
      requiredByPolicy: false,
      baaRecordId: null,
    };
  }

  // An executed BAA in force at asOf wins — newest first when several coexist.
  const [inForce] = input.records
    .filter((r) => activeAt(r, input.asOf))
    .sort(byExecutedOnDescNullsLast);
  if (inForce !== undefined) {
    return {
      isActive: true,
      status: "executed",
      expiresOn: inForce.expiresOn,
      requiredByPolicy: true,
      baaRecordId: inForce.id,
    };
  }

  // No in-force record — classify the most recent one (never executed / pending / expired).
  const latest = [...input.records].sort(byExecutedOnDescNullsLast)[0];
  let status: BaaStatusKind;
  if (latest === undefined) {
    status = "missing";
  } else if (latest.baaStatus === "pending") {
    status = "pending";
  } else if (latest.expiresOn !== null && new Date(latest.expiresOn) < input.asOf) {
    status = "expired";
  } else {
    status = "missing";
  }

  return {
    isActive: false,
    status,
    expiresOn: latest?.expiresOn ?? null,
    requiredByPolicy: true,
    baaRecordId: latest?.id ?? null,
  };
}

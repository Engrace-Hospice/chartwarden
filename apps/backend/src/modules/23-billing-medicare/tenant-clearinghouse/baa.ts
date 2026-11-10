// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/baa.ts — the tenant-held vendor BAA record (owner decision D2,
// 2026-11-06): a tenant that brings its own Stedi or Claim.MD account holds its own BAA with that vendor. The TENANT records it
// (who holds it, the effective date, a screened document reference: never patient data); a platform OPERATOR verifies the record;
// only then may the config go active. Pure helpers: the rules that act on them live in service.ts.
import type { ConfigRow } from "./config-store";
import { invalid, screenedText } from "./screening";

export const BAA_REF_MIN = 3;
export const BAA_REF_MAX = 200;
/** The operator's reason for revoking a BAA: the same screen as the document reference, a longer bound (migration 1468's CHECK). */
export const BAA_REVOKE_REASON_MIN = 3;
export const BAA_REVOKE_REASON_MAX = 500;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What a tenant records. `heldBy` is the tenant's own statement; the only holder this model knows is the tenant. */
export interface RecordBaaInput {
  readonly heldBy: "tenant";
  /** The BAA's effective date, `YYYY-MM-DD`, not in the future. */
  readonly effectiveDate: string;
  readonly documentRef: string;
}

export interface BaaView {
  readonly heldBy: "tenant";
  readonly effectiveDate: string;
  readonly documentRef: string;
  readonly recordedAt: string;
  readonly verified: { readonly at: string } | null;
  /** True once a platform operator revoked this record (the vendor ended the BAA); recording a new BAA clears it. */
  readonly revoked: boolean;
  readonly revokedAt: string | null;
  /** The operator's reason: only the platform lane's view carries it, never the tenant's. */
  readonly revokedReason?: string;
}

/** The record an operator verifies: named by the `recordedAt` the view showed (the verify route's `If-Match`). */
export interface BaaPin {
  readonly recordedAt: string;
}

/** A revocation belongs to the record it revoked: a new record (or a new vendor) starts with none. */
export const BAA_REVOCATION_CLEARED = {
  baaRevokedAt: null,
  baaRevokedByMembershipId: null,
  baaRevokedReason: null,
} as const;

/** The BAA columns a vendor change voids (the record, its verification and any revocation): a new vendor is a new agreement. */
export const BAA_CLEARED = {
  baaVendor: null,
  baaEffectiveDate: null,
  baaDocumentRef: null,
  baaRecordedAt: null,
  baaRecordedByMembershipId: null,
  baaVerifiedAt: null,
  baaVerifiedByMembershipId: null,
  ...BAA_REVOCATION_CLEARED,
} as const;

/** Just the verification (a changed record needs a fresh look; the record itself is replaced). */
export const BAA_VERIFICATION_CLEARED = {
  baaVerifiedAt: null,
  baaVerifiedByMembershipId: null,
} as const;

const isRealDay = (day: string): boolean => {
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
};

/** The record normalised and checked against `today` (`YYYY-MM-DD`), or a 422 naming the field. */
export function normalizeBaaInput(
  raw: RecordBaaInput,
  today: string,
): { readonly effectiveDate: string; readonly documentRef: string } {
  if (raw.heldBy !== "tenant") {
    throw invalid(
      "heldBy",
      "CLEARINGHOUSE_BAA_HOLDER_INVALID",
      "the vendor BAA of a tenant-held account is held by the tenant",
    );
  }
  const day = typeof raw.effectiveDate === "string" ? raw.effectiveDate.trim() : "";
  if (!ISO_DAY.test(day) || !isRealDay(day)) {
    throw invalid(
      "effectiveDate",
      "CLEARINGHOUSE_BAA_DATE_INVALID",
      "effectiveDate must be a real date (YYYY-MM-DD)",
    );
  }
  if (day > today) {
    throw invalid(
      "effectiveDate",
      "CLEARINGHOUSE_BAA_DATE_INVALID",
      "effectiveDate cannot be in the future: a BAA that is not in effect yet does not cover the account",
    );
  }
  const documentRef = screenedText(raw.documentRef, {
    field: "documentRef",
    min: BAA_REF_MIN,
    max: BAA_REF_MAX,
    lengthCode: "CLEARINGHOUSE_BAA_REF_INVALID",
    lengthMessage: `documentRef must be ${BAA_REF_MIN}-${BAA_REF_MAX} characters: say where the signed BAA is kept`,
    phiMessage:
      "documentRef looks like it contains a patient identifier; name the document, never a patient",
  });
  return { effectiveDate: day, documentRef };
}

/** The operator's reason, normalised and screened like the document reference, or a 422 naming the field. */
export const normalizeRevokeReason = (raw: unknown): string =>
  screenedText(raw, {
    field: "reason",
    min: BAA_REVOKE_REASON_MIN,
    max: BAA_REVOKE_REASON_MAX,
    lengthCode: "CLEARINGHOUSE_BAA_REVOKE_REASON_INVALID",
    lengthMessage: `reason must be ${BAA_REVOKE_REASON_MIN}-${BAA_REVOKE_REASON_MAX} characters: say why the BAA is revoked`,
    phiMessage:
      "reason looks like it contains a patient identifier; give a ticket reference, never a patient",
  });

/**
 * The same record as the one stored (a re-record of it changes nothing). A REVOKED record is never "the same": the tenant
 * re-recording it is its statement that the agreement is in force again, which clears the revocation and goes back to the operator.
 */
export const sameBaa = (
  row: ConfigRow,
  next: { readonly effectiveDate: string; readonly documentRef: string },
): boolean =>
  row.baaRecordedAt !== null &&
  row.baaRevokedAt === null &&
  row.baaEffectiveDate === next.effectiveDate &&
  row.baaDocumentRef === next.documentRef;

/** The stored record is the very one the operator looked at (a changed record gets a new `recordedAt`). */
export const baaMatchesPin = (row: ConfigRow, pin: BaaPin): boolean =>
  row.baaRecordedAt !== null && row.baaRecordedAt.toISOString() === pin.recordedAt;

/** The view of the stored record; `operator` (the platform lane) also carries the revoke reason, which the tenant's view never does. */
export function baaViewOf(row: ConfigRow, operator = false): BaaView | null {
  if (!row.baaRecordedAt || !row.baaEffectiveDate || !row.baaDocumentRef) return null;
  return {
    heldBy: "tenant",
    effectiveDate: row.baaEffectiveDate,
    documentRef: row.baaDocumentRef,
    recordedAt: row.baaRecordedAt.toISOString(),
    verified: row.baaVerifiedAt ? { at: row.baaVerifiedAt.toISOString() } : null,
    revoked: row.baaRevokedAt !== null,
    revokedAt: row.baaRevokedAt ? row.baaRevokedAt.toISOString() : null,
    ...(operator && row.baaRevokedReason ? { revokedReason: row.baaRevokedReason } : {}),
  };
}

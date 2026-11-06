// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/baa.ts — the tenant-held vendor BAA record (owner decision D2,
// 2026-11-06): a tenant that brings its own Stedi or Claim.MD account holds its own BAA with that vendor. The TENANT records it
// (who holds it, the effective date, a screened document reference: never patient data); a platform OPERATOR verifies the record;
// only then may the config go active. Pure helpers: the rules that act on them live in service.ts.
import type { ConfigRow } from "./config-store";
import { invalid, screenedText } from "./screening";

export const BAA_REF_MIN = 3;
export const BAA_REF_MAX = 200;
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
}

/** The record an operator verifies: named by the `recordedAt` the view showed (the verify route's `If-Match`). */
export interface BaaPin {
  readonly recordedAt: string;
}

/** The BAA columns a vendor change voids (the record and its verification): a new vendor is a new agreement. */
export const BAA_CLEARED = {
  baaVendor: null,
  baaEffectiveDate: null,
  baaDocumentRef: null,
  baaRecordedAt: null,
  baaRecordedByMembershipId: null,
  baaVerifiedAt: null,
  baaVerifiedByMembershipId: null,
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

/** The same record as the one stored (a re-record of it changes nothing). */
export const sameBaa = (
  row: ConfigRow,
  next: { readonly effectiveDate: string; readonly documentRef: string },
): boolean =>
  row.baaRecordedAt !== null &&
  row.baaEffectiveDate === next.effectiveDate &&
  row.baaDocumentRef === next.documentRef;

/** The stored record is the very one the operator looked at (a changed record gets a new `recordedAt`). */
export const baaMatchesPin = (row: ConfigRow, pin: BaaPin): boolean =>
  row.baaRecordedAt !== null && row.baaRecordedAt.toISOString() === pin.recordedAt;

export function baaViewOf(row: ConfigRow): BaaView | null {
  if (!row.baaRecordedAt || !row.baaEffectiveDate || !row.baaDocumentRef) return null;
  return {
    heldBy: "tenant",
    effectiveDate: row.baaEffectiveDate,
    documentRef: row.baaDocumentRef,
    recordedAt: row.baaRecordedAt.toISOString(),
    verified: row.baaVerifiedAt ? { at: row.baaVerifiedAt.toISOString() } : null,
  };
}

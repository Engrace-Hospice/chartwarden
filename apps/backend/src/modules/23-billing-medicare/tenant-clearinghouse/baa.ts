// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/baa.ts — the tenant-held vendor BAA record (owner decision D2,
// 2026-11-06): a tenant that brings its own Stedi or Claim.MD account holds its own BAA with that vendor. The TENANT records it
// (who holds it, the effective date, a screened document reference: never patient data); a platform OPERATOR verifies the record;
// only then may the config go active. Pure helpers: the rules that act on them live in service.ts.
import type { ConfigRow } from "./config-store";
import { invalid, screenedText } from "./screening";

export const BAA_REF_MIN = 3;
export const BAA_REF_MAX = 200;
/**
 * Why a platform operator revoked a BAA: a CLOSED set, so no sentence can reach the durable, tenant-readable row or the audit rows
 * copied from it (migration 1468's CHECK holds the same set). The code carries no patient information and is shown to the tenant.
 */
export const BAA_REVOKE_REASON_CODES = [
  "vendor_terminated",
  "account_closed",
  "baa_expired",
  "other",
] as const;
export type BaaRevokeReasonCode = (typeof BAA_REVOKE_REASON_CODES)[number];
/** The ticket the operator acted on (`SEC-42`): platform-only, never shown to the tenant's view (migration 1468's CHECK). */
export const BAA_REVOKE_TICKET_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d{1,8}$/;
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
  /** Why (a closed code, no patient information); the tenant sees it. */
  readonly revokedReasonCode: BaaRevokeReasonCode | null;
  /** The operator's ticket: only the platform lane's view carries it, never the tenant's. */
  readonly revokedTicketRef?: string;
  /**
   * Platform lane only: this record was revoked before (`at`), and `sameDocument` says the document is the one that was revoked, so
   * an operator verifying it must acknowledge that. The tenant's view never has it.
   */
  readonly previousRevocation?: { readonly at: string; readonly sameDocument: boolean };
}

/** The record an operator verifies: named by the `recordedAt` the view showed (the verify route's `If-Match`). */
export interface BaaPin {
  readonly recordedAt: string;
}

/**
 * A revocation belongs to the record it revoked: a new record (or a new vendor) starts with none. The HISTORY of it
 * (`baaLastRevoked*`) and the departure time (`revokedVendorLeftAt`) are deliberately not here: they survive a re-record and a vendor
 * change.
 */
export const BAA_REVOCATION_CLEARED = {
  baaRevokedAt: null,
  baaRevokedByMembershipId: null,
  baaRevokedReasonCode: null,
  baaRevokedTicketRef: null,
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

/** The revoke request validated: a code from the closed set and a ticket reference, or a 422 naming the field. */
export function normalizeRevokeInput(raw: {
  readonly reasonCode: unknown;
  readonly ticketRef: unknown;
}): {
  readonly reasonCode: BaaRevokeReasonCode;
  readonly ticketRef: string;
} {
  const code = BAA_REVOKE_REASON_CODES.find((c) => c === raw.reasonCode);
  if (!code) {
    throw invalid(
      "reasonCode",
      "CLEARINGHOUSE_BAA_REVOKE_REASON_INVALID",
      `reasonCode must be one of ${BAA_REVOKE_REASON_CODES.join(", ")}`,
    );
  }
  const ticketRef = typeof raw.ticketRef === "string" ? raw.ticketRef : "";
  if (!BAA_REVOKE_TICKET_PATTERN.test(ticketRef)) {
    throw invalid(
      "ticketRef",
      "CLEARINGHOUSE_BAA_REVOKE_TICKET_INVALID",
      "ticketRef must be the ticket the revoke was ordered under, such as SEC-42 (capital letters and digits, a dash, a number)",
    );
  }
  return { reasonCode: code, ticketRef };
}

/** A document reference reduced to its letters and digits: a re-typed ended document (a space, a dot, a case) is still that document. */
export const documentKeyOf = (ref: string): string => ref.toLowerCase().replace(/[^a-z0-9]/gu, "");

/** True when the stored record's document is the one the last revocation ended (the operator must acknowledge verifying it). */
export const isPreviouslyRevokedDocument = (row: ConfigRow): boolean => {
  if (!row.baaLastRevokedAt || !row.baaLastRevokedDocumentRef || !row.baaDocumentRef) return false;
  const revoked = documentKeyOf(row.baaLastRevokedDocumentRef);
  // a reference with no letter or digit has no identity to compare: it never matches
  return revoked.length > 0 && revoked === documentKeyOf(row.baaDocumentRef);
};

/**
 * The same record as the one stored (a re-record of it changes nothing). A REVOKED record is never "the same": the tenant
 * re-recording it is its statement that the agreement is in force again, which clears the revocation and goes back to the operator.
 */
export const sameBaa = (
  row: ConfigRow,
  next: { readonly effectiveDate: string; readonly documentRef: string },
): boolean =>
  row.baaRecordedAt !== null &&
  !row.baaRevokedAt &&
  row.baaEffectiveDate === next.effectiveDate &&
  row.baaDocumentRef === next.documentRef;

/** The stored record is the very one the operator looked at (a changed record gets a new `recordedAt`). */
export const baaMatchesPin = (row: ConfigRow, pin: BaaPin): boolean =>
  row.baaRecordedAt !== null && row.baaRecordedAt.toISOString() === pin.recordedAt;

/**
 * The view of the stored record. The platform lane (`operator`) also carries the ticket and the revocation history; the tenant's view
 * shows only that the BAA is revoked, when, and the closed reason code.
 */
export function baaViewOf(row: ConfigRow, operator = false): BaaView | null {
  if (!row.baaRecordedAt || !row.baaEffectiveDate || !row.baaDocumentRef) return null;
  return {
    heldBy: "tenant",
    effectiveDate: row.baaEffectiveDate,
    documentRef: row.baaDocumentRef,
    recordedAt: row.baaRecordedAt.toISOString(),
    verified: row.baaVerifiedAt ? { at: row.baaVerifiedAt.toISOString() } : null,
    revoked: Boolean(row.baaRevokedAt),
    revokedAt: row.baaRevokedAt ? row.baaRevokedAt.toISOString() : null,
    revokedReasonCode: (row.baaRevokedReasonCode as BaaRevokeReasonCode | null) ?? null,
    ...(operator && row.baaRevokedTicketRef ? { revokedTicketRef: row.baaRevokedTicketRef } : {}),
    ...(operator && row.baaLastRevokedAt && !row.baaRevokedAt
      ? {
          previousRevocation: {
            at: row.baaLastRevokedAt.toISOString(),
            sameDocument: isPreviouslyRevokedDocument(row),
          },
        }
      : {}),
  };
}

// apps/backend/src/bootstrap/onboarding-notice-port.ts — the seam through which the platform routes (M34
// `/api/v1/platform/tenants/:orgSlug/{noe,notr}-records/:id/withdraw-external-filing`) withdraw a tenant's "filed outside
// ChartWarden" NOE / NOTR record, and list which ones the tenant has recorded, without importing M23 (M34 has no `dependsOn`
// edge to the billing modules). The sibling of `onboarding-clearinghouse-port.ts`, for the same reasons.
//
// M23 implements the port over its own rules (`withdrawExternalNoticeFiling`), on the CALLER'S open transaction (already scoped to
// the target org's `app.org_id` and attributed to the operator), so the withdrawal commits or rolls back with the audit row. What
// it returns is ids, a state and dates: no patient, no admission, no free text.
import type { DbClient } from "@chartwarden/db";
import type { OnboardingWriteScope } from "./onboarding-credential-port";

export type { OnboardingWriteScope } from "./onboarding-credential-port";

export type OnboardingNoticeKind = "noe" | "notr";

/** The notice after the withdrawal, as the platform sees it. `externalFiling` is null: the record is gone. */
export interface OnboardingNoticeView {
  readonly noticeKind: OnboardingNoticeKind;
  readonly noticeId: string;
  readonly state: string;
  readonly windowTargetAt: string;
  /** What the deadline watchdog stamped (a withdrawal keeps it); null once the withdrawn LATE record's own stamp is cleared. */
  readonly windowBreachedAt: string | null;
  readonly externalFiling: null;
}

export interface OnboardingNoticeWithdrawal {
  /** The notice id (the audit row's resource id). */
  readonly resourceId: string;
  readonly view: OnboardingNoticeView;
  /**
   * Non-sensitive facts for the platform audit row: the notice kind, the filed date and the record's `recordedAt` withdrawn, and
   * what became of the breach stamp (`breachStamp`: cleared with its date / kept / none).
   */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/**
 * One notice the tenant recorded as filed outside ChartWarden: what an operator needs to find it and to withdraw it. Ids, a state
 * and dates only: no patient, no admission, no control number.
 */
export interface OnboardingNoticeFiling {
  readonly noticeKind: OnboardingNoticeKind;
  readonly noticeId: string;
  readonly state: string;
  readonly windowTargetAt: string;
  readonly windowBreachedAt: string | null;
  /** The date the tenant says it filed. */
  readonly filedOn: string | null;
  /** The record's `recordedAt`: the `If-Match` a withdrawal must carry. */
  readonly recordedAt: string | null;
  /** The record wrote the breach stamp itself, so a withdrawal clears it (a watchdog's own stamp stays either way). */
  readonly breachStampFromRecord: boolean;
}

export interface OnboardingNoticeFilingList {
  /** Newest record first, NOEs and NOTRs together. */
  readonly items: readonly OnboardingNoticeFiling[];
  /** The list was cut at the seam's cap: older records exist that it does not show. */
  readonly truncated: boolean;
}

export interface OnboardingNoticePort {
  /**
   * What the tenant recorded as filed outside ChartWarden (a parked or unmarked notice is not on the list), on the caller's
   * transaction scoped to the tenant.
   */
  listExternalFilings(
    tx: DbClient,
    scope: OnboardingWriteScope,
  ): Promise<OnboardingNoticeFilingList>;

  /**
   * Withdraw the tenant's external-filing record of one notice. `expectedRecordedAt` is the `externalFiling.recordedAt` the operator
   * read (null: the request named none, a 428); a record that changed since is a 409, both carrying the record's current
   * `recordedAt` in the error details, and a notice with no record is a 409. A notice of another organization is a 404.
   */
  withdrawExternalFiling(
    tx: DbClient,
    scope: OnboardingWriteScope,
    input: {
      readonly kind: OnboardingNoticeKind;
      readonly noticeId: string;
      readonly expectedRecordedAt: string | null;
    },
  ): Promise<OnboardingNoticeWithdrawal>;
}

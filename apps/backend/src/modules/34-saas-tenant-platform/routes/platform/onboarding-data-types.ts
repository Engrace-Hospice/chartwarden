// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-types.ts — the shapes of the operator's onboarding
// data service (`onboarding-data-service.ts`): the service's surface, its dependencies and the slug resolver. Their own file so the
// service's helpers (the clearinghouse put, the BAA upload) can name them without importing the service that calls them.
import type { DbClient } from "@chartwarden/db";
import type {
  OnboardingBaaDocument,
  OnboardingBaaDocumentPort,
} from "../../../../bootstrap/onboarding-baa-document-port";
import type { OnboardingBillingModePort } from "../../../../bootstrap/onboarding-billing-mode-port";
import type { OnboardingClearinghousePort } from "../../../../bootstrap/onboarding-clearinghouse-port";
import type { OnboardingCredentialPort } from "../../../../bootstrap/onboarding-credential-port";
import type {
  OnboardingNoticeFilingList,
  OnboardingNoticeKind,
  OnboardingNoticePort,
  OnboardingNoticeView,
} from "../../../../bootstrap/onboarding-notice-port";
import type { TaxIdCipherPort } from "../../../02-identity/org-admin-site-service";
import type { OnboardingOperator } from "./onboarding-data-audit";
import type { TenantMemberView } from "./onboarding-members";

/** A body field set with the platform `reason` already removed, ready for the tenant's own validators. */
export type OnboardingFields = Readonly<Record<string, unknown>>;

export interface OnboardingDataService {
  listProviderEntities(op: OnboardingOperator, orgSlug: string): Promise<{ items: unknown[] }>;
  createProviderEntity(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields,
    reason: string,
  ): Promise<unknown>;
  updateProviderEntity(
    op: OnboardingOperator,
    orgSlug: string,
    id: string,
    fields: OnboardingFields,
    reason: string,
  ): Promise<unknown>;
  listLocations(op: OnboardingOperator, orgSlug: string): Promise<{ items: unknown[] }>;
  createLocation(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields,
    reason: string,
  ): Promise<unknown>;
  updateLocation(
    op: OnboardingOperator,
    orgSlug: string,
    id: string,
    fields: OnboardingFields,
    reason: string,
  ): Promise<unknown>;
  listMacCredentials(op: OnboardingOperator, orgSlug: string): Promise<{ items: unknown[] }>;
  upsertMacCredential(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields & { providerEntityId: string },
    reason: string,
    expectedVersion: number | undefined,
  ): Promise<unknown>;
  /** The tenant's clearinghouse choice, masked (`hasSecret`, never the credential). One audited read. */
  getClearinghouse(op: OnboardingOperator, orgSlug: string): Promise<unknown>;
  putClearinghouse(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields,
    reason: string,
    expectedVersion: number | undefined,
  ): Promise<{
    readonly created: boolean;
    readonly view: unknown;
    /**
     * `false` only when the vendor committed but the billing mode the operator chose could not be confirmed afterwards (even after one
     * retry): the tenant has the vendor, and its contract may not hold that mode. Absent otherwise.
     */
    readonly billingModeConfirmed?: false;
  }>;
  verifyClearinghouse(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields,
    reason: string,
  ): Promise<{ readonly config: unknown; readonly test: unknown }>;
  /**
   * The operator verifies the vendor BAA the tenant recorded. NOT gated on the tenant's onboarding status: a live tenant that
   * changed vendor or re-recorded its BAA needs this too.
   */
  /** `expected` is the `baa.recordedAt` the operator read: a record that changed since is a 409, not a verification. */
  verifyClearinghouseBaa(
    op: OnboardingOperator,
    orgSlug: string,
    reason: string,
    expected: { readonly recordedAt: string },
    options?: { readonly acknowledgePreviousRevocation?: boolean },
  ): Promise<unknown>;
  /** Revoke the tenant's current vendor BAA using only a closed reason and an operator ticket reference. */
  revokeClearinghouseBaa(
    op: OnboardingOperator,
    orgSlug: string,
    input: { readonly reasonCode: string; readonly ticketRef: string },
    expected: { readonly recordedAt: string },
  ): Promise<unknown>;
  /**
   * The operator releases every clearinghouse credential the tenant still holds except its current one, so another organization may
   * seal it. NOT gated on the tenant's onboarding status; refused while the tenant's vendor responses may still arrive.
   */
  releaseClearinghouseCredentials(
    op: OnboardingOperator,
    orgSlug: string,
    reason: string,
  ): Promise<unknown>;
  /**
   * The notices the tenant recorded as filed outside ChartWarden, NOEs and NOTRs, newest record first (what the withdraw drawer
   * reads; each carries the `recordedAt` pin a withdrawal needs). Ids, a state and dates only; an audited read on the tenant's own
   * RLS scope, NOT gated on the tenant's onboarding status.
   */
  listNoticeFilings(op: OnboardingOperator, orgSlug: string): Promise<OnboardingNoticeFilingList>;
  /**
   * The operator withdraws the tenant's "filed outside ChartWarden" record of one NOE / NOTR: the notice returns to its pre-record
   * state (a watchdog's breach stamp stays; the one a withdrawn LATE record wrote itself is cleared with it). NOT gated on the
   * tenant's onboarding status. `expected` is the `externalFiling.recordedAt` the operator read (null: the request named none): a
   * record that changed since is a 409 and none named is a 428, both carrying the current `recordedAt` in the error details.
   */
  withdrawNoticeExternalFiling(
    op: OnboardingOperator,
    orgSlug: string,
    kind: OnboardingNoticeKind,
    noticeId: string,
    reason: string,
    expected: { readonly recordedAt: string | null },
  ): Promise<OnboardingNoticeView>;
  /**
   * The operator uploads the signed BAA for the tenant (onboarding step 3, or a live tenant's renewal): M22's own upload pipeline files one
   * document kind (`tenant_baa`) on the tenant's RLS scope, and the BAA register row then links the returned id. Only in
   * `BAA_DOCUMENT_UPLOAD_STATUSES` (being set up, or live; never offboarding or later); a successful upload voids a pending go-live attestation like any other onboarding data write.
   */
  uploadBaaDocument(
    op: OnboardingOperator,
    orgSlug: string,
    input: { readonly contentBase64: string; readonly mimeType: string },
    reason: string,
  ): Promise<OnboardingBaaDocument>;
  listMedicaidCredentials(op: OnboardingOperator, orgSlug: string): Promise<{ items: unknown[] }>;
  /** The tenant's active staff, for assigning its compliance officer (minimum necessary; an audited read). */
  listMembers(
    op: OnboardingOperator,
    orgSlug: string,
  ): Promise<{ items: TenantMemberView[]; truncated: boolean }>;
  upsertMedicaidCredential(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields & { providerEntityId: string },
    reason: string,
  ): Promise<unknown>;
}

/** The organization behind a tenant slug, or null. A slug lookup spans tenants, so it needs the platform credential. */
export type OnboardingTenantResolver = (
  orgSlug: string,
) => Promise<{ organizationId: string } | null>;

export interface OnboardingDataDeps {
  /** The TENANT pool (NOBYPASSRLS): the write must be bound by the target org's RLS, never bypass it. */
  readonly db: DbClient;
  /** Slug -> organization on the audited platform credential; absent => every call answers 503 (never a tenant-pool guess). */
  readonly resolveTenant?: OnboardingTenantResolver;
  /** Unbound -> creating a provider entity answers 503 TAX_ID_CIPHER_UNBOUND (an EIN is never stored in the clear). */
  readonly taxIdCipher?: TaxIdCipherPort;
  /** M23's MAC credential adapter; unbound -> the MAC credential routes answer 503. */
  readonly macCredentials?: OnboardingCredentialPort;
  /** M24's state Medicaid trading-partner credential adapter; unbound -> those routes answer 503. */
  readonly medicaidCredentials?: OnboardingCredentialPort;
  /**
   * Runs the advance sweep for the tenant after a write COMMITS (best effort: a failure is warned and never fails the write), so
   * the step the data satisfies settles at once (the MAC credential, a location) instead of waiting for the daily pass.
   */
  readonly advance?: (tenant: { tenantAccountId: string; organizationId: string }) => Promise<void>;
  /** `err` carries the raw error for the redacting logger (a database error holds bound values). */
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
  /** M23's clearinghouse adapter (ADR-0053 amendment 2026-11-06); unbound -> the clearinghouse routes answer 503. */
  readonly clearinghouse?: OnboardingClearinghousePort;
  /** M23's notice adapter (an operator withdraws a tenant's external-filing record); unbound -> that route answers 503. */
  readonly notices?: OnboardingNoticePort;
  /** M22's BAA document adapter (an operator uploads the tenant's signed BAA); unbound -> that route answers 503. */
  readonly baaDocuments?: OnboardingBaaDocumentPort;
  /**
   * M35's billing mode adapter. A contracted tenant that bills outside ChartWarden is on mode none, so the operator's switch to a vendor
   * names the mode (set before the vendor, put back if the vendor change fails). Unbound (a deployment without pricing) -> no tenant has a
   * contract, and a billing mode in the body is refused.
   */
  readonly billingMode?: OnboardingBillingModePort;
  /**
   * Runs the onboarding advance pass for the tenant after a clearinghouse change COMMITS, so wizard step 7
   * (`clearinghouse_selected`) settles at once. Best effort: a failure is the caller's to log and never fails the write.
   */
  readonly settleOnboarding?: (organizationId: string) => Promise<void>;
  readonly logError?: (cause: unknown, context: { organizationId: string }) => void;
  /** Cause logging for a failed-attempt audit row that could not be written (the original error still reaches the caller). */
  readonly logAuditError?: (cause: unknown, context: { organizationId: string }) => void;
}

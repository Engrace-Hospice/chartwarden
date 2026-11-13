// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-store.ts — the help-request data port.
//
// `HelpRequestStore` is bound to ONE open transaction; `HelpRequestRunner` opens that transaction the right way for each surface
// (the member's own `withOrgContext` under RLS on the real NOBYPASSRLS app role, or an audited `withPlatformContext` on the carrier),
// the `WizardStore` / `WizardRunner` precedent. The service holds every rule; the store only reads and writes rows, so the in-memory
// store (`help-request-store-memory.ts`) and the Drizzle one (`help-request-store-drizzle.ts`) are interchangeable under it.
import type { DbClient } from "@chartwarden/db";
import type { LinkedHelpRequestPort } from "@chartwarden/saas-tenant-platform";
import type { HelpRequestStatus, PlatformHelpRequestFilter } from "./help-request-contract";

/** `tenant_help_request.closed_by_actor_kind`. */
export type HelpCloserKind = "tenant" | "platform_ops" | "system";

/** One `tenant_help_request` row, in the service's own words. */
export interface HelpRequestRow {
  readonly id: string;
  readonly organizationId: string;
  readonly tenantAccountId: string;
  readonly stepKey: string | null;
  /** Null only after the 90-day retention sweep; views project a fixed placeholder. */
  readonly message: string | null;
  readonly status: HelpRequestStatus;
  readonly requestedByMembershipId: string;
  readonly requestedByUserId: string;
  readonly requestedAt: Date;
  /** `requested_at` as microsecond-precision ISO text: the keyset cursor's anchor (a JS Date would lose the microseconds). */
  readonly cursorTs: string;
  readonly supportConsentGrantId: string | null;
  readonly approvedByMembershipId: string | null;
  readonly approvedAt: Date | null;
  readonly closedByActorKind: HelpCloserKind | null;
  readonly closedByUserId: string | null;
  readonly closedAt: Date | null;
  readonly closeNote: string | null;
  /** Stamped when the retention sweep removed the message at rest (migration 1485); null while the text is kept. */
  readonly messagePurgedAt: Date | null;
}

/** The inbox row: the request plus the tenant it belongs to (read on the platform lane only). */
export interface PlatformHelpRequestRow extends HelpRequestRow {
  readonly orgSlug: string;
  readonly legalBusinessName: string;
}

/** What a grant lookup tells the view: when it expires and whether it was revoked. */
export interface HelpGrantRow {
  readonly id: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** The place a keyset page continues from: the last row the client saw. */
export interface HelpPageAfter {
  readonly cursorTs: string;
  readonly id: string;
}

export interface NewHelpRequest {
  readonly organizationId: string;
  readonly tenantAccountId: string;
  readonly stepKey: string | null;
  readonly message: string;
  readonly requestedByMembershipId: string;
  readonly requestedByUserId: string;
}

export interface HelpApproval {
  readonly grantId: string;
  readonly approvedByMembershipId: string;
  readonly approvedAt: Date;
}

/** An ending: `from` is the status the row must still have (a lost race changes nothing and answers null). */
export interface HelpClosing {
  readonly from: "open" | "approved";
  readonly to: "resolved" | "cancelled";
  readonly closedByActorKind: HelpCloserKind;
  readonly closedByUserId: string | null;
  readonly closedAt: Date;
  /** The operator's tenant-visible note; the tenant lane has no column grant for it, so it is only ever set on the platform lane. */
  readonly closeNote: string | null;
}

export interface HelpRequestStore {
  /** The open transaction, handed to the grant operations (`SupportGrantOperations.depsFor(tx)`) so they share it. */
  readonly tx: DbClient;

  // ── tenant lane (RLS scopes every statement to the member's organization) ──
  /** The organization's one tenant account id, or null. */
  tenantAccountIdOf(organizationId: string): Promise<string | null>;
  /** Whether the session's membership is an ACTIVE membership of this organization held by this user (the file policy's own test). */
  isActiveMember(member: {
    readonly membershipId: string;
    readonly userId: string;
    readonly organizationId: string;
  }): Promise<boolean>;
  /** Whether `userId` is ChartWarden platform staff (the wizard's `m34_platform_role_holders` read). */
  isPlatformStaff(userId: string): Promise<boolean>;
  /** Whether `key` names an onboarding step (retired ones too: a request filed against one still resolves). */
  stepKeyExists(key: string): Promise<boolean>;
  /** The tenant account's live (open or approved) request, or null. */
  findLive(tenantAccountId: string): Promise<HelpRequestRow | null>;
  /** The tenant account's ended requests, newest first, after `after`; the caller asks for one more than it shows. */
  listEnded(
    tenantAccountId: string,
    after: HelpPageAfter | null,
    limit: number,
  ): Promise<readonly HelpRequestRow[]>;
  insert(input: NewHelpRequest): Promise<HelpRequestRow>;
  /** open -> approved, linking the grant; null when the row is no longer open. */
  markApproved(id: string, approval: HelpApproval): Promise<HelpRequestRow | null>;

  // ── both lanes ──
  /**
   * One request by id, locked for the rest of the transaction; null when it does not exist (or RLS hides it). LOCK ORDER, on every
   * path that ends or revokes consent: the grant row first, then the request row. (Piece 7S's revoke marks the grant before it calls
   * the linked-request port, so it takes them in that order too; two people ending the same consent at once then queue instead of
   * deadlocking.) A request with no grant locks only itself.
   */
  findForUpdate(id: string): Promise<HelpRequestRow | null>;
  /** Apply an ending; null when the row is no longer in `closing.from`. */
  markClosed(id: string, closing: HelpClosing): Promise<HelpRequestRow | null>;
  /**
   * Run `hook` once this unit of work has COMMITTED (never if it rolls back): for what must not outlive a rollback, such as an alert
   * (the alert engine opens its own transaction). A hook is best-effort and owns its own error handling; the runner awaits it.
   */
  afterCommit(hook: () => Promise<void>): void;
  /** The grants behind some requests, by id. */
  grantsById(grantIds: readonly string[]): Promise<ReadonlyMap<string, HelpGrantRow>>;
  /**
   * The port the revoke cascade ends a linked request through, bound to this transaction. `defaults` fill what the caller of the
   * cascade does not pass (the revoke input carries neither the closer's user nor an operator's note).
   */
  linkedRequests(defaults?: LinkedRequestDefaults): LinkedHelpRequestPort;

  // ── platform lane (the carrier reads every tenant) ──
  /** The operators' inbox, newest first, joined to the tenant; the caller asks for one more than it shows. */
  listForPlatform(
    filter: PlatformHelpRequestFilter,
    after: HelpPageAfter | null,
    limit: number,
  ): Promise<readonly PlatformHelpRequestRow[]>;
  /** One request with its tenant (for the Resolve response). */
  findForPlatform(id: string): Promise<PlatformHelpRequestRow | null>;

  // ── the sweep (platform lane) ──
  /** Cancel every `open` request requested before `olderThan`, closed by the system; the number cancelled. */
  cancelStaleOpen(olderThan: Date, at: Date): Promise<number>;
  /** Resolve every `approved` request whose grant is expired or revoked as of `at`, closed by the system; the number resolved. */
  resolveGrantEnded(at: Date): Promise<number>;
  /**
   * Null the message and note of every closed request that closed more than `retentionDays` ago and
   * stamp `message_purged_at`; the number purged. The database judges the age by its own clock (the guard trigger of migration 1485),
   * so a sweep and the trigger can never disagree at the edge.
   */
  purgeClosedText(retentionDays: number, at: Date): Promise<number>;
}

export interface LinkedRequestDefaults {
  readonly closedByUserId?: string | null;
  readonly note?: string | null;
}

/** Opens the transaction a unit of work runs in; one method per lane. */
export interface HelpRequestRunner {
  /** The member's own organization transaction (RLS on `app.org_id`, `app.user_id` = the member). */
  asMember<T>(
    ctx: { readonly organizationId: string; readonly userId: string },
    fn: (store: HelpRequestStore) => Promise<T>,
  ): Promise<T>;
  /**
   * An audited platform transaction acting for `userId` (the row-audit trigger names the operator); `userId` null is the system.
   * `reason` is the bypass audit row's justification.
   */
  asPlatform<T>(
    ctx: { readonly userId: string | null; readonly reason: string },
    fn: (store: HelpRequestStore) => Promise<T>,
  ): Promise<T>;
}

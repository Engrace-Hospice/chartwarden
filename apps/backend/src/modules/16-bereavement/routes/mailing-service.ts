// apps/backend/src/modules/16-bereavement/routes/mailing-service.ts — the mailing program service interface (ADR-0109 D10, routes 42-51).
//
// A tenant configures its mailings (`config`), the 5-minute sweep drafts a RUN per occurrence, and bereavement oversight drives the run:
//   draft -> generate -> (the `m16-mailing-generate` worker renders the batch PDF) ready -> download -> confirm-mailed -> mailed
// then the sweep writes the contact-log activity rows. Everything here is oversight-only (`bereavement.mailing.read|manage|dispatch` plus
// `org_scope_bereavement_oversight`): the batch PDF holds EVERY recipient's name and address.
//
// The views carry ids, enum tokens, counts and the agency's own wording: never a name or an address. The batch PDF is the only place those exist.
import type {
  BereavedContactRelationship,
  BereavementMailingChannel,
  BereavementMailingExclusionReason,
  BereavementMailingItemStatus,
  BereavementMailingKey,
  BereavementMailingRunKind,
  BereavementMailingRunStatus,
  BereavementMailingContent,
} from "@chartwarden/types";
import type { M16ReadActor, M16WriteActor } from "./actor";
import type { CursorPage } from "./concurrency";

/** The tenant's overrides of the occurrence dates (see `mailings/occurrence.ts`). */
export interface MailingScheduleView {
  readonly monthDays?: readonly string[];
  readonly monthDay?: string;
}

/** One mailing key's configuration. A key the tenant never configured reads as a disabled default at version 0 (`configured: false`). */
export interface MailingConfigView {
  readonly mailingKey: BereavementMailingKey;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly leadDays: number;
  readonly schedule: MailingScheduleView;
  /** null = every relationship. */
  readonly audienceRelationships: readonly BereavedContactRelationship[] | null;
  readonly content: BereavementMailingContent;
  /** The `If-Match` token (0 when never configured). */
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface PutMailingConfigInput {
  readonly expectedVersion: number;
  readonly enabled: boolean;
  readonly leadDays: number;
  readonly schedule?: MailingScheduleView | undefined;
  readonly audienceRelationships: readonly BereavedContactRelationship[] | null;
  readonly content: BereavementMailingContent;
}

/** How many of a run's items are in each state (ids only). */
export interface MailingItemCounts {
  readonly included: number;
  readonly excluded: number;
  readonly logged: number;
  readonly excludedAfterRender: number;
}

export interface MailingRunView {
  readonly runId: string;
  readonly runKind: BereavementMailingRunKind;
  readonly mailingKey: BereavementMailingKey | null;
  readonly occurrenceKey: string;
  readonly scheduledFor: string;
  readonly status: BereavementMailingRunStatus;
  /** The wording snapshot the batch renders from. */
  readonly content: BereavementMailingContent;
  readonly recipientCount: number;
  readonly excludedCount: number;
  readonly failureCode: string | null;
  /** True once the batch PDF exists (the id itself is not exposed: download goes through the M22 seam). */
  readonly hasDocument: boolean;
  readonly generatedAt: string | null;
  readonly mailedAt: string | null;
  readonly itemCounts: MailingItemCounts;
  /** The `If-Match` token. */
  readonly version: number;
  readonly createdAt: string;
}

export interface ListMailingRunsInput {
  readonly status?: BereavementMailingRunStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** One contact's place in a run. No name, no address: the contact id leads to the contact screen. */
export interface MailingItemView {
  readonly itemId: string;
  readonly contactId: string;
  readonly planId: string;
  readonly relationshipCode: BereavedContactRelationship;
  readonly channel: BereavementMailingChannel;
  readonly status: BereavementMailingItemStatus;
  readonly exclusionReason: BereavementMailingExclusionReason | null;
  /** The letter's position in the batch PDF (null for an item that was never included). */
  readonly ordinal: number | null;
}

export interface ListMailingItemsInput {
  readonly status?: BereavementMailingItemStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** A short-lived URL for the batch PDF. Never logged. */
export interface MailingDownloadView {
  readonly runId: string;
  readonly url: string;
  readonly expiresAt: string;
}

export interface M16MailingService {
  /** Route 42 — the four built mailing keys, each merged with its stored config (or a disabled default). */
  listConfigs(actor: M16ReadActor): Promise<readonly MailingConfigView[]>;
  /** Route 43 — upsert one key's config; `If-Match` is the current version (0 when none yet). */
  putConfig(
    actor: M16WriteActor,
    mailingKey: BereavementMailingKey,
    input: PutMailingConfigInput,
  ): Promise<MailingConfigView>;
  /** Route 44 — runs, newest scheduled first (cursor-paginated). */
  listRuns(actor: M16ReadActor, input: ListMailingRunsInput): Promise<CursorPage<MailingRunView>>;
  /** Route 45 — one run with its item counts; null = absent. */
  getRun(actor: M16ReadActor, runId: string): Promise<MailingRunView | null>;
  /** Route 46 — a run's items, ordinal order (cursor-paginated); null = the run is absent. */
  listItems(
    actor: M16ReadActor,
    runId: string,
    input: ListMailingItemsInput,
  ): Promise<CursorPage<MailingItemView> | null>;
  /** Route 47 — replace a DRAFT run's wording. */
  updateRunContent(
    actor: M16WriteActor,
    runId: string,
    input: { readonly expectedVersion: number; readonly content: BereavementMailingContent },
  ): Promise<MailingRunView>;
  /** Route 48 — draft (or failed) -> generating: select the batch set-based, then hand the render to the worker. Refuses empty wording. */
  generateRun(
    actor: M16WriteActor,
    runId: string,
    input: { readonly expectedVersion: number },
  ): Promise<MailingRunView>;
  /** Route 49 — a short-lived URL for the rendered batch (ready or mailed). Writes the M22 access ledger row. */
  downloadRun(actor: M16WriteActor, runId: string): Promise<MailingDownloadView>;
  /** Route 50 — ready -> mailed: re-check eligibility, flag `excluded_after_render`, emit `mailing_run_mailed`. */
  confirmMailed(
    actor: M16WriteActor,
    runId: string,
    input: { readonly expectedVersion: number },
  ): Promise<MailingRunView>;
  /** Route 51 — draft | ready | failed -> cancelled. */
  cancelRun(
    actor: M16WriteActor,
    runId: string,
    input: { readonly expectedVersion: number },
  ): Promise<MailingRunView>;
}

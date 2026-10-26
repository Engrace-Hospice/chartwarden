import { randomUUID } from "node:crypto";
// apps/backend/src/modules/23-billing-medicare/services/dde-queue-service.ts — the M23 DDE work-queue service
// (ADR-0052): HUMAN WORK TRACKING for Medicare Direct Data Entry (FISS). ChartWarden holds no DDE credential and
// performs no DDE call; `record submission` is an operator attestation, never a verified fact.
//
// Every write runs in ONE `withOrgContext` unit of work (RLS on `app.org_id`), drives the pure
// `ddeWorkItemMachine`, is version-checked (§2.5 -> 412), appends a `dde_work_event` row (the item's append-only
// history) and emits its `m23.dde_item.*` event through the injected catalog-validating outbox in the same
// transaction. The M4 write-audit trigger on both tables records who changed what (notes are scrubbed).
//
// Deadline rule (ADR-0052 D5): an NOE/NOTR item copies the notice's `window_target_at`; the deadline is MET only by
// a recorded MAC acceptance date on or before it. Recording an ACCEPTED outcome on such an item applies the
// notice's EXISTING acceptance transition (`applyDdeNoticeAcceptance`) and stores the operator-entered date as
// `payer_status_date` with source `dde_manual`. No MBI is stored: notes are capped and refused when MBI-shaped, and
// are never copied into an event or log.
import {
  DDE_AGING_AT_RISK_BUSINESS_DAYS,
  DDE_AGING_OVERDUE_BUSINESS_DAYS,
  DDE_AT_RISK_DAYS,
  type DdeItemType,
  type DdeWorkItemEvent,
  type DdeWorkItemState,
  ddeAgingCutoffDate,
  ddeDeadlineStatus,
  ddeWorkItemMachine,
  isRealCalendarDate,
  medicareReceiptDay,
  repositories,
  validateDdeCodes,
  validateDdeNotes,
} from "@chartwarden/billing";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import { DDE, type DdeAccessProvider, type DdeOutcome } from "@chartwarden/x12-837-client";
import type { Static } from "@sinclair/typebox";
import type {
  AssignDdeItemBodySchema,
  CreateDdeItemBodySchema,
  DdeItemDetailViewSchema,
  DdeItemListViewSchema,
  DdeItemViewSchema,
  DdeProviderSyncViewSchema,
  RecordDdeAcceptanceBodySchema,
  RecordDdeOutcomeBodySchema,
  RecordDdeSubmissionBodySchema,
} from "../routes/dde-queue-typebox";
import {
  type BillingDb,
  type BillingTx,
  type BillingWriteActor,
  type WriteOutboxPort,
  assertNotAiActor,
  requireStepUp,
} from "./claim-state-service";
import type { DdeBeneficiaryPort } from "./dde-beneficiary";
import { applyDdeNoticeAcceptance } from "./dde-notice-acceptance";
import {
  DDE_PROVIDER_CALL_TIMEOUT_MS,
  type PlannedOutcome,
  PROVIDER_REFERENCE_PATTERN,
  REFUSED_BEFORE_SEND,
  ddeIdempotencyKey,
  ddeProviderAnswerRejected,
  ddeProviderRefusal,
  planProviderOutcome,
  runWithTimeout,
} from "./dde-provider-ops";
import {
  type DdeProviderIdentityReader,
  loadControlNumber,
  loadKeyingSheet,
  loadSubject,
} from "./dde-queue-subject";

type Item = repositories.DdeWorkItemRecord;
export type DdeItemView = Static<typeof DdeItemViewSchema>;
export type DdeItemDetailView = Static<typeof DdeItemDetailViewSchema>;
export type DdeItemListView = Static<typeof DdeItemListViewSchema>;
export type DdeProviderSyncView = Static<typeof DdeProviderSyncViewSchema>;
type CreateBody = Static<typeof CreateDdeItemBodySchema>;
type AssignBody = Static<typeof AssignDdeItemBodySchema>;
type SubmissionBody = Static<typeof RecordDdeSubmissionBodySchema>;
type OutcomeBody = Static<typeof RecordDdeOutcomeBodySchema>;
type AcceptanceBody = Static<typeof RecordDdeAcceptanceBodySchema>;
type Action = DdeItemView["allowedActions"][number];

export interface DdeListFilter {
  readonly state?: DdeWorkItemState;
  readonly itemType?: DdeItemType;
  readonly assigneeMembershipId?: string;
  readonly providerEntityId?: string;
  readonly patientId?: string;
  readonly overdue?: boolean;
  readonly atRisk?: boolean;
}

export interface DdeQueueReadActor {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * The write actor for the DDE queue. `ddeAdmin` is set by the route layer when the caller holds `billing.dde.admin`
 * over the item; only then may someone other than the assignee act on an assigned item.
 */
export type DdeWriteActor = BillingWriteActor & {
  readonly ddeAdmin?: boolean;
  readonly request?: { readonly correlationId?: string };
};

export interface DdeQueueServicePorts {
  readonly outbox?: WriteOutboxPort;
  readonly now?: () => Date;
  /**
   * Can this membership be assigned an item of this provider entity: an ACTIVE member holding `billing.dde.work`
   * whose provider-entity reach covers it? Injected at the composition root (membership and role grants are M2/M3
   * data). Absent => assigning is refused (fail closed).
   */
  /**
   * The bound DdeAccessProvider (ADR-0103). Absent => sending through a provider is refused with `DDE_NOT_WIRED`
   * (fail closed; manual keying is the baseline).
   */
  readonly ddeProvider?: DdeAccessProvider;
  /**
   * The read-only provider-identifier seam (#765): CCN + billing NPI for the keying sheet. Absent => the sheet has no
   * Provider CCN / Billing NPI fields (fail closed to "not shown", never a guess). Never an MBI (ADR-0052 D7).
   */
  readonly providerIdentity?: DdeProviderIdentityReader;
  /**
   * The audited MBI seam (#793): unlocks the beneficiary for ONE provider operation, in memory only. Absent => the
   * operation carries no beneficiary (the composition root always binds it; a real adapter refuses an operation
   * without one). Bound but failing => the send is refused before the in-doubt marker is set or any vendor call.
   */
  readonly ddeBeneficiary?: DdeBeneficiaryPort;
  /** `test` MUST reach only vendor test mode. Defaults to `test` so a mis-wired caller can never reach production FISS. */
  readonly ddeUsage?: "test" | "production";
  /** Bound on one vendor call (default {@link DDE_PROVIDER_CALL_TIMEOUT_MS}); past it the send is in doubt. */
  readonly ddeProviderTimeoutMs?: number;
  readonly assigneeCanWork?: (
    organizationId: string,
    membershipId: string,
    providerEntityId: string,
  ) => Promise<boolean>;
}

export interface DdeQueueService {
  /** `scope` is the actor's provider-entity reach (see `billingScopeReach`); it is applied in the query. */
  list(
    actor: DdeQueueReadActor,
    filter: DdeListFilter,
    cursor: string | undefined,
    limit: number | undefined,
    scope: repositories.DdeListScope,
  ): Promise<DdeItemListView>;
  get(actor: DdeQueueReadActor, id: string): Promise<DdeItemDetailView>;
  create(actor: BillingWriteActor, body: CreateBody): Promise<DdeItemView>;
  /** Take an unassigned item for yourself. */
  claim(actor: BillingWriteActor, id: string, expectedVersion: number): Promise<DdeItemView>;
  /** Assign (or reassign) an item to a named membership. */
  assign(actor: BillingWriteActor, id: string, body: AssignBody): Promise<DdeItemView>;
  start(actor: DdeWriteActor, id: string, expectedVersion: number): Promise<DdeItemView>;
  /** Attest the item was keyed in DDE (step-up required). */
  recordSubmission(actor: DdeWriteActor, id: string, body: SubmissionBody): Promise<DdeItemView>;
  /** Record a RETURNED / rejected outcome (with its RTP reason code). */
  recordOutcome(actor: DdeWriteActor, id: string, body: OutcomeBody): Promise<DdeItemView>;
  /**
   * Record that the MAC ACCEPTED the item (step-up). On an NOE/NOTR it applies the notice's existing acceptance
   * transition with the operator-entered date, so it is as privileged as keying: `billing.dde.mark_submitted`.
   */
  recordAcceptance(actor: DdeWriteActor, id: string, body: AcceptanceBody): Promise<DdeItemView>;
  /**
   * Send an in_progress item through the bound DdeAccessProvider as the acting operator (step-up, ownership rule). The
   * item becomes `submitted` with `submissionMode = "provider"`; a refusal leaves it in_progress.
   */
  submitViaProvider(
    actor: DdeWriteActor,
    id: string,
    expectedVersion: number,
  ): Promise<DdeItemView>;
  /**
   * Ask the provider what FISS did with a provider-submitted item and apply a final answer (accepted -> the notice's
   * acceptance with source `dde_provider`; returned/rejected -> the RTP path). A still-pending answer changes nothing.
   */
  syncProviderOutcome(actor: DdeWriteActor, id: string): Promise<DdeProviderSyncView>;
  /**
   * Apply one change-report outcome from the provider (#793, the daily-change ingest) as the system actor. Matches the
   * item by (provider entity, provider reference): none => `unmatched`; an item no longer awaiting an answer (already
   * accepted/returned/closed, a manual item, one possibly sent and not yet settled by a person, or one a DIFFERENT
   * operator submitted) => `already`, never moved backwards; otherwise the same edges as `syncProviderOutcome`.
   * `operatorMembershipId` is the operator whose DDE ID the change report was read under. Throws
   * DDE_PROVIDER_ANSWER_INVALID for an answer we will not act on (nothing is written). No vendor call is made here.
   */
  applyProviderChange(
    organizationId: string,
    providerEntityId: string,
    outcome: DdeOutcome,
    operatorMembershipId: string,
  ): Promise<"applied" | "already" | "unmatched">;
  retry(actor: DdeWriteActor, id: string, expectedVersion: number): Promise<DdeItemView>;
  cancel(actor: DdeWriteActor, id: string, expectedVersion: number): Promise<DdeItemView>;
  close(actor: DdeWriteActor, id: string, expectedVersion: number): Promise<DdeItemView>;
}

/** The UI actions legal from each state (the routes enforce the machine; this only drives buttons). */
const ACTIONS_BY_STATE: Record<DdeWorkItemState, readonly Action[]> = {
  queued: ["claim", "assign", "cancel"],
  assigned: ["assign", "start", "cancel"],
  in_progress: ["record_submission", "submit_via_provider", "cancel"],
  submitted: ["record_outcome", "record_acceptance", "sync_provider"],
  accepted: ["close"],
  returned: ["retry", "close"],
  closed: [],
  cancelled: [],
};

/** The calendar day on the CMS / CWF (Eastern) clock; deadlines are judged on it, not on the UTC date. */
function toIsoDate(d: Date): string {
  return medicareReceiptDay(d);
}

/** A real calendar date or a 422 (2026-02-31 passes the shape check and would fail the database cast as a 500). */
function assertRealDate(field: string, value: string | undefined): void {
  if (value === undefined || isRealCalendarDate(value)) return;
  throw new ValidationError("request validation failed", [
    { field, code: "INVALID_DATE", message: "that is not a real calendar date" },
  ]);
}

function screenCodes(codes: {
  dcn?: string;
  rtpReasonCode?: string;
  outcomeCode?: string;
}): void {
  const verdict = validateDdeCodes(codes);
  if (verdict.ok) return;
  throw new ValidationError("request validation failed", [
    { field: verdict.field, code: verdict.reason, message: "that value is not accepted here" },
  ]);
}

function screenNotes(notes: string | undefined): void {
  const verdict = validateDdeNotes(notes);
  if (verdict.ok) return;
  const message =
    verdict.reason === "NOTES_CONTAIN_MBI"
      ? "notes must not contain a Medicare Beneficiary Identifier"
      : "notes are too long";
  throw new ValidationError("request validation failed", [
    { field: "notes", code: verdict.reason, message },
  ]);
}

function viewOf(row: Item, asOf: string): DdeItemView {
  return {
    ddeWorkItemId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    patientId: row.patientId,
    itemType: row.itemType,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    state: row.state,
    attemptNumber: row.attemptNumber,
    assigneeMembershipId: row.assigneeMembershipId,
    priority: row.priority,
    source: row.source,
    deadlineAt: row.deadlineAt,
    deadlineStatus: ddeDeadlineStatus(
      { ...row, openedOn: row.createdAt.toISOString().slice(0, 10) },
      asOf,
    ),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    macAcceptedOn: row.macAcceptedOn,
    submissionMode: row.submissionMode,
    providerReference: row.providerReference,
    providerInDoubt: row.providerInDoubtAt !== null,
    providerInDoubtAt: row.providerInDoubtAt?.toISOString() ?? null,
    providerOperatorMembershipId: row.providerOperatorMembershipId,
    dcn: row.dcn,
    rtpReasonCode: row.rtpReasonCode,
    outcomeCode: row.outcomeCode,
    notes: row.notes,
    respawnedFromId: row.respawnedFromId,
    allowedActions: [...ACTIONS_BY_STATE[row.state]],
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The actor of work no person triggered (the daily-change-report ingest): history rows say `system`, no membership. */
const SYSTEM_ACTOR_KIND = "system";
const isSystemActor = (actor: BillingWriteActor): boolean => actor.actorKind === SYSTEM_ACTOR_KIND;
const systemDdeActor = (organizationId: string): BillingWriteActor => ({
  organizationId,
  userId: "",
  roles: [],
  membershipId: "",
  stepUpRecent: false,
  actorKind: SYSTEM_ACTOR_KIND,
});

export function buildDdeQueueService(
  db: BillingDb,
  ports: DdeQueueServicePorts = {},
): DdeQueueService {
  const now = ports.now ?? (() => new Date());

  const inOrg = <T>(
    actor: { organizationId: string; userId: string },
    fn: (tx: BillingTx) => Promise<T>,
  ) => withOrgContext<BillingTx, T>(db, actor, fn);

  const emit = async (
    tx: BillingTx,
    organizationId: string,
    eventName: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ) => {
    if (ports.outbox) {
      await ports.outbox.publish(tx, {
        eventName,
        organizationId,
        aggregateKind: "dde_work_item",
        aggregateId,
        payload,
      });
    }
  };

  const loadItem = async (tx: BillingTx, actor: BillingWriteActor, id: string): Promise<Item> => {
    const row = await new repositories.DdeWorkItemRepository(tx).findById(id);
    if (!row || row.organizationId !== actor.organizationId)
      throw new NotFoundError("dde work item");
    return row;
  };

  /**
   * Apply one machine event to an item: reduce, version-checked write, history row, event. `patch` carries the
   * columns that event sets; the attempt number comes from the reducer.
   */
  const applyEvent = async (
    tx: BillingTx,
    actor: BillingWriteActor,
    item: Item,
    expectedVersion: number,
    event: DdeWorkItemEvent,
    patch: repositories.DdeWorkItemPatch,
    historyDetail: Record<string, string | number | boolean | null> = {},
  ): Promise<Item> => {
    const reduced = ddeWorkItemMachine.reduce(item.state, event, {
      attemptNumber: item.attemptNumber,
    });
    if (reduced.error) {
      throw new ConflictError(`cannot '${event}' a DDE item in state '${item.state}'`);
    }
    return persist(
      tx,
      actor,
      item,
      expectedVersion,
      event,
      reduced.state,
      reduced.attemptNumber,
      patch,
      historyDetail,
    );
  };

  const persist = async (
    tx: BillingTx,
    actor: BillingWriteActor,
    item: Item,
    expectedVersion: number,
    eventName: string,
    nextState: DdeWorkItemState,
    attemptNumber: number,
    patch: repositories.DdeWorkItemPatch,
    historyDetail: Record<string, string | number | boolean | null>,
  ): Promise<Item> => {
    const versioned = await new repositories.DdeWorkItemRepository(tx).transitionToState(
      item.id,
      expectedVersion,
      nextState,
      { ...patch, attemptNumber },
    );
    if (!versioned.ok) {
      throw new ChartWardenError(
        "VERSION_CONFLICT",
        `the DDE item was modified concurrently (current version ${versioned.currentVersion ?? "unknown"})`,
        412,
      );
    }
    const updated = versioned.row;
    await new repositories.DdeWorkEventRepository(tx).append({
      organizationId: updated.organizationId,
      workItemId: updated.id,
      event: eventName,
      fromState: item.state,
      toState: updated.state,
      attemptNumber: updated.attemptNumber,
      // The change-report ingest (#793) is a system actor: no membership, kind `system`.
      actorMembershipId: isSystemActor(actor) ? null : actor.membershipId,
      actorKind: isSystemActor(actor) ? "system" : "user",
      detail: {
        ...historyDetail,
        ...(isSystemActor(actor) ? {} : { actorMembershipId: actor.membershipId }),
      },
    });
    await emit(tx, updated.organizationId, "m23.dde_item.state_changed", updated.id, {
      ddeItemId: updated.id,
      itemType: updated.itemType,
      providerEntityId: updated.providerEntityId,
      event: eventName,
      fromState: item.state,
      toState: updated.state,
      attemptNumber: updated.attemptNumber,
      deadlineAt: updated.deadlineAt,
      macAcceptedOn: updated.macAcceptedOn,
      dcn: updated.dcn,
      rtpReasonCode: updated.rtpReasonCode,
      outcomeCode: updated.outcomeCode,
      submissionMode: updated.submissionMode,
      providerReference: updated.providerReference,
    });
    return updated;
  };

  /**
   * Validate and plan a provider's FINAL answer (pure: no IO). Shared by the by-item sync route and the daily change
   * ingest (#793). Throws DDE_PROVIDER_ANSWER_INVALID for an answer we will not act on.
   */
  const planAnswer = (latest: DdeOutcome, submittedAt: Date | null) => {
    const recordedAt = now();
    const plan = planProviderOutcome(latest, toIsoDate(recordedAt));
    if (plan.kind === "invalid") throw ddeProviderAnswerRejected(plan.reason);
    // An answer cannot predate the submission it answers (Eastern day): a stale provider date would corrupt timeliness.
    if (plan.kind === "accepted" && submittedAt && plan.macAcceptedOn < toIsoDate(submittedAt)) {
      throw ddeProviderAnswerRejected("the provider's acceptance date predates the submission");
    }
    return { plan, recordedAt };
  };

  /** Apply a planned answer to the item as it is now (the reducer refuses anything but `submitted`). */
  const applyPlanned = async (
    tx: BillingTx,
    actor: BillingWriteActor,
    current: Item,
    plan: Exclude<PlannedOutcome, { kind: "invalid" }>,
    recordedAt: Date,
    detail: Record<string, string | number | boolean | null>,
  ): Promise<Item> => {
    if (plan.kind === "returned") {
      return applyEvent(
        tx,
        actor,
        current,
        current.version,
        "return",
        {
          rtpReasonCode: plan.rtpReasonCode,
          outcomeCode: plan.outcomeCode,
          ...(plan.dcn ? { dcn: plan.dcn } : {}),
        },
        { ...detail, rtpReasonCode: plan.rtpReasonCode, dcn: plan.dcn },
      );
    }
    let macAcceptedOn = plan.macAcceptedOn;
    if (current.itemType === "noe" || current.itemType === "notr") {
      const applied = await applyDdeNoticeAcceptance(tx, {
        organizationId: actor.organizationId,
        kind: current.itemType,
        noticeId: current.subjectId,
        macAcceptedOn,
        recordedAt,
        outbox: ports.outbox,
        source: "dde_provider",
      });
      // The electronic path got there first: the notice's own date is the truth, so the item takes it.
      if (!applied.applied && applied.existingPayerStatusDate) {
        macAcceptedOn = applied.existingPayerStatusDate;
      }
    }
    return applyEvent(
      tx,
      actor,
      current,
      current.version,
      "accept",
      { macAcceptedOn, outcomeCode: "accepted", ...(plan.dcn ? { dcn: plan.dcn } : {}) },
      { ...detail, macAcceptedOn, dcn: plan.dcn },
    );
  };

  /** One short org-scoped transaction on an item the actor may work (ADR-0052 D6 ownership rule). */
  const withOwnedItem = <T>(
    actor: DdeWriteActor,
    id: string,
    fn: (tx: BillingTx, item: Item) => Promise<T>,
  ): Promise<T> => {
    assertNotAiActor(actor);
    return inOrg(actor, async (tx) => {
      const item = await loadItem(tx, actor, id);
      // An assigned item belongs to its assignee; an admin may step in. Reassigning (admin-gated) hands it over.
      if (
        item.assigneeMembershipId &&
        item.assigneeMembershipId !== actor.membershipId &&
        actor.ddeAdmin !== true
      ) {
        throw new ForbiddenError("this item is assigned to another member");
      }
      return fn(tx, item);
    });
  };

  const mutate = async (
    actor: DdeWriteActor,
    id: string,
    fn: (tx: BillingTx, item: Item) => Promise<Item>,
  ): Promise<DdeItemView> => {
    const row = await withOwnedItem(actor, id, fn);
    return viewOf(row, toIsoDate(now()));
  };

  /** The bound provider, or the same fail-closed refusal an unbound registry answers with. */
  const requireProvider = (): DdeAccessProvider => {
    if (!ports.ddeProvider) throw ddeProviderRefusal(DDE.NOT_WIRED);
    return ports.ddeProvider;
  };

  /** The provider call context: the ACTING operator's membership (DDE IDs are per person, ADR-0103 D4). */
  const providerContext = (operatorMembershipId: string, actor: DdeWriteActor, item: Item) => ({
    organizationId: item.organizationId,
    providerEntityId: item.providerEntityId,
    operatorMembershipId,
    correlationId: actor.request?.correlationId ?? randomUUID(),
    usage: ports.ddeUsage ?? ("test" as const),
  });

  const providerTimeoutMs = ports.ddeProviderTimeoutMs ?? DDE_PROVIDER_CALL_TIMEOUT_MS;

  /** Append a lifecycle row to the item's history (no state change, no version bump), in its own transaction. */
  const recordLifecycle = (
    actor: DdeWriteActor,
    item: Item,
    event: "provider_send_refused" | "provider_in_doubt",
    detail: Record<string, string | number | boolean | null>,
  ): Promise<void> =>
    inOrg(actor, async (tx) => {
      await new repositories.DdeWorkEventRepository(tx).append({
        organizationId: item.organizationId,
        workItemId: item.id,
        event,
        fromState: item.state,
        toState: item.state,
        attemptNumber: item.attemptNumber,
        actorMembershipId: actor.membershipId,
        actorKind: "user",
        detail: { ...detail, actorMembershipId: actor.membershipId },
      });
    });

  /**
   * The send may have reached FISS and we hold no outcome. The durable marker (set before the call) stays; this adds
   * the history row, then refuses with `refusal`.
   */
  const leaveInDoubt = async (
    actor: DdeWriteActor,
    item: Item,
    reason: string,
    refusal: ChartWardenError,
  ): Promise<never> => {
    await recordLifecycle(actor, item, "provider_in_doubt", { reason });
    throw refusal;
  };

  const staleVersion = (item: Item, expectedVersion: number): void => {
    if (item.version === expectedVersion) return;
    throw new ChartWardenError(
      "VERSION_CONFLICT",
      `the DDE item was modified concurrently (current version ${item.version})`,
      412,
    );
  };

  return {
    async list(actor, filter, cursor, limit, scope) {
      const page = await inOrg(actor, (tx) =>
        new repositories.DdeWorkItemRepository(tx).listByOrgPage(
          actor.organizationId,
          {
            ...filter,
            scope,
            asOf: toIsoDate(now()),
            atRiskDays: DDE_AT_RISK_DAYS,
            ageOverdueCutoff: ddeAgingCutoffDate(toIsoDate(now()), DDE_AGING_OVERDUE_BUSINESS_DAYS),
            ageAtRiskCutoff: ddeAgingCutoffDate(toIsoDate(now()), DDE_AGING_AT_RISK_BUSINESS_DAYS),
          },
          cursor,
          limit,
        ),
      );
      const asOf = toIsoDate(now());
      return {
        items: page.items.map((r) => viewOf(r, asOf)),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },

    async get(actor, id) {
      const { row, events, keying } = await inOrg(actor, async (tx) => {
        const found = await new repositories.DdeWorkItemRepository(tx).findById(id);
        if (!found || found.organizationId !== actor.organizationId) {
          throw new NotFoundError("dde work item");
        }
        return {
          row: found,
          events: await new repositories.DdeWorkEventRepository(tx).listForItem(id),
          keying: await loadKeyingSheet(tx, found, ports.providerIdentity),
        };
      });
      return {
        ...viewOf(row, toIsoDate(now())),
        keying,
        events: events.map((e) => ({
          eventId: e.id,
          event: e.event,
          fromState: e.fromState,
          toState: e.toState,
          attemptNumber: e.attemptNumber,
          actorMembershipId: e.actorMembershipId,
          actorKind: e.actorKind,
          detail: e.detail,
          occurredAt: e.occurredAt.toISOString(),
        })),
      };
    },

    async create(actor, body) {
      assertNotAiActor(actor);
      screenNotes(body.notes);
      assertRealDate("deadlineAt", body.deadlineAt);
      const row = await inOrg(actor, async (tx) => {
        const subject = await loadSubject(tx, actor.organizationId, body.itemType, body.subjectId);
        const isNotice = body.itemType === "noe" || body.itemType === "notr";
        if (isNotice && body.deadlineAt !== undefined) {
          throw new ValidationError("request validation failed", [
            {
              field: "deadlineAt",
              code: "DEADLINE_IS_DERIVED",
              message: "an NOE/NOTR item takes the notice's filing window as its deadline",
            },
          ]);
        }
        const created = await new repositories.DdeWorkItemRepository(tx).insertIfNoOpen({
          organizationId: actor.organizationId,
          providerEntityId: subject.providerEntityId,
          patientId: subject.patientId,
          itemType: body.itemType,
          subjectKind: subject.subjectKind,
          subjectId: body.subjectId,
          priority: body.priority ?? 2,
          source: "manual",
          deadlineAt: isNotice ? subject.deadlineAt : (body.deadlineAt ?? null),
          notes: body.notes ?? null,
        });
        if (!created) {
          throw new ConflictError("an open DDE item of this type already exists for this subject");
        }
        await new repositories.DdeWorkEventRepository(tx).append({
          organizationId: created.organizationId,
          workItemId: created.id,
          event: "create",
          fromState: null,
          toState: "queued",
          attemptNumber: 1,
          actorMembershipId: actor.membershipId,
          actorKind: "user",
          detail: { source: "manual", actorMembershipId: actor.membershipId },
        });
        await emit(tx, created.organizationId, "m23.dde_item.created", created.id, {
          ddeItemId: created.id,
          itemType: created.itemType,
          subjectKind: created.subjectKind,
          subjectId: created.subjectId,
          providerEntityId: created.providerEntityId,
          source: created.source,
          deadlineAt: created.deadlineAt,
        });
        return created;
      });
      return viewOf(row, toIsoDate(now()));
    },

    claim(actor, id, expectedVersion) {
      return mutate(actor, id, async (tx, item) => {
        if (item.state === "assigned" && item.assigneeMembershipId === actor.membershipId)
          return item;
        if (item.state !== "queued") {
          throw new ConflictError("only an unassigned item can be claimed");
        }
        return applyEvent(tx, actor, item, expectedVersion, "assign", {
          assigneeMembershipId: actor.membershipId,
        });
      });
    },

    async assign(actor, id, body) {
      assertNotAiActor(actor);
      const target = await inOrg(actor, (tx) => loadItem(tx, actor, id));
      const eligible = ports.assigneeCanWork
        ? await ports.assigneeCanWork(
            actor.organizationId,
            body.assigneeMembershipId,
            target.providerEntityId,
          )
        : false;
      if (!eligible) {
        throw new ValidationError("request validation failed", [
          {
            field: "assigneeMembershipId",
            code: "ASSIGNEE_NOT_ELIGIBLE",
            message:
              "the assignee must be an active member of this organization who can work DDE items for this provider entity",
          },
        ]);
      }
      return mutate(actor, id, async (tx, item) => {
        if (item.state === "assigned") {
          // Reassignment: same state, new assignee; the history row records it.
          return persist(
            tx,
            actor,
            item,
            body.expectedVersion,
            "reassign",
            "assigned",
            item.attemptNumber,
            {
              assigneeMembershipId: body.assigneeMembershipId,
            },
            {},
          );
        }
        return applyEvent(tx, actor, item, body.expectedVersion, "assign", {
          assigneeMembershipId: body.assigneeMembershipId,
        });
      });
    },

    start(actor, id, expectedVersion) {
      return mutate(actor, id, (tx, item) =>
        applyEvent(tx, actor, item, expectedVersion, "start", {}),
      );
    },

    recordSubmission(actor, id, body) {
      assertNotAiActor(actor);
      requireStepUp(actor);
      screenNotes(body.notes);
      screenCodes(body);
      return mutate(actor, id, (tx, item) =>
        applyEvent(
          tx,
          actor,
          item,
          body.expectedVersion,
          "submit",
          {
            submittedAt: now(),
            submissionMode: "manual",
            // An operator who keyed it by hand settles any "possibly sent" provider attempt.
            providerInDoubtAt: null,
            providerOperatorMembershipId: null,
            ...(body.dcn !== undefined ? { dcn: body.dcn } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
          },
          {
            dcn: body.dcn ?? null,
            ...(item.providerInDoubtAt ? { resolvedProviderInDoubt: true } : {}),
          },
        ),
      );
    },

    recordOutcome(actor, id, body) {
      assertNotAiActor(actor);
      // Defence in depth: this route is returned-only; an acceptance acts on the notice and goes through
      // `recordAcceptance` (mark_submitted + step-up).
      if (body.outcome !== "returned") {
        throw new ValidationError("request validation failed", [
          {
            field: "outcome",
            code: "NOT_RETURNED",
            message: "use record-acceptance to record an acceptance",
          },
        ]);
      }
      screenNotes(body.notes);
      screenCodes(body);
      return mutate(actor, id, (tx, item) =>
        applyEvent(
          tx,
          actor,
          item,
          body.expectedVersion,
          "return",
          {
            rtpReasonCode: body.rtpReasonCode,
            // Always set: a code left from an earlier attempt must not outlive the state it described.
            outcomeCode: body.outcomeCode ?? null,
            // A person who recorded the real outcome settles any "possibly sent" marker.
            providerInDoubtAt: null,
            providerOperatorMembershipId: null,
            ...(body.dcn !== undefined ? { dcn: body.dcn } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
          },
          { rtpReasonCode: body.rtpReasonCode, dcn: body.dcn ?? null },
        ),
      );
    },

    recordAcceptance(actor, id, body) {
      assertNotAiActor(actor);
      requireStepUp(actor);
      screenNotes(body.notes);
      screenCodes(body);
      assertRealDate("macAcceptedOn", body.macAcceptedOn);
      return mutate(actor, id, async (tx, item) => {
        const isNotice = item.itemType === "noe" || item.itemType === "notr";
        if (isNotice && !body.macAcceptedOn) {
          throw new ValidationError("request validation failed", [
            {
              field: "macAcceptedOn",
              code: "REQUIRED",
              message: "an accepted NOE/NOTR needs the MAC acceptance date",
            },
          ]);
        }
        const recordedAt = now();
        // The MAC is not ahead of us: reject a future date (read on the Eastern CMS clock).
        if (body.macAcceptedOn && body.macAcceptedOn > toIsoDate(recordedAt)) {
          throw new ValidationError("request validation failed", [
            {
              field: "macAcceptedOn",
              code: "FUTURE_DATE",
              message: "the MAC acceptance date cannot be in the future",
            },
          ]);
        }
        let macAcceptedOn = body.macAcceptedOn;
        if (isNotice && body.macAcceptedOn) {
          const result = await applyDdeNoticeAcceptance(tx, {
            organizationId: actor.organizationId,
            kind: item.itemType as "noe" | "notr",
            noticeId: item.subjectId,
            macAcceptedOn: body.macAcceptedOn,
            recordedAt,
            outbox: ports.outbox,
          });
          // The electronic path got there first: the notice's own date is the truth, so the item takes it.
          if (!result.applied && result.existingPayerStatusDate) {
            macAcceptedOn = result.existingPayerStatusDate;
          }
        }
        return applyEvent(
          tx,
          actor,
          item,
          body.expectedVersion,
          "accept",
          {
            ...(macAcceptedOn ? { macAcceptedOn } : {}),
            outcomeCode: body.outcomeCode ?? null,
            // A person who recorded the real outcome settles any "possibly sent" marker.
            providerInDoubtAt: null,
            providerOperatorMembershipId: null,
            ...(body.dcn !== undefined ? { dcn: body.dcn } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
          },
          { macAcceptedOn: macAcceptedOn ?? null, dcn: body.dcn ?? null },
        );
      });
    },

    async submitViaProvider(actor, id, expectedVersion) {
      assertNotAiActor(actor);
      // Unbound first: never ask for a second factor for an operation that cannot run.
      const provider = requireProvider();
      requireStepUp(actor);

      // Phase 1 (short transaction): refuse a stale/wrong-state/in-doubt item, then durably mark it "possibly sent"
      // BEFORE the vendor is reached, so no outcome of phase 2 (timeout, crash, throw) can leave it unmarked.
      const started = await withOwnedItem(actor, id, async (tx, item) => {
        staleVersion(item, expectedVersion);
        // A send that may have reached FISS is never repeated through the provider (resolve it by hand first).
        if (item.providerInDoubtAt) throw ddeProviderRefusal(DDE.IN_DOUBT);
        if (
          ddeWorkItemMachine.reduce(item.state, "submit", { attemptNumber: item.attemptNumber })
            .error
        ) {
          throw new ConflictError(`cannot submit a DDE item in state '${item.state}'`);
        }
        const controlNumber = await loadControlNumber(tx, item);
        if (!controlNumber) throw new NotFoundError("dde subject");
        const keying = await loadKeyingSheet(tx, item, ports.providerIdentity);
        // The MBI is unlocked per call, audited by the seam, and rides only this call's memory: never an event, log or
        // row. Before the marker, so a refused unlock leaves the item untouched instead of falsely "possibly sent".
        const beneficiary = await ports.ddeBeneficiary?.unlock({
          organizationId: item.organizationId,
          patientId: item.patientId,
          ddeItemId: item.id,
          actorUserId: actor.userId,
          ...(actor.request?.correlationId ? { correlationId: actor.request.correlationId } : {}),
          onDate: toIsoDate(now()),
        });
        const marked = await persist(
          tx,
          actor,
          item,
          expectedVersion,
          "provider_send_started",
          item.state,
          item.attemptNumber,
          { providerInDoubtAt: now(), providerOperatorMembershipId: actor.membershipId },
          { idempotencyKey: ddeIdempotencyKey(item.id, item.attemptNumber) },
        );
        return { marked, controlNumber, keying, beneficiary };
      });
      const { marked, controlNumber, keying, beneficiary } = started;

      // Phase 2 (NO transaction held): the vendor call, bounded; the signal is handed to the port.
      const bounded = await runWithTimeout(
        (signal) =>
          provider.submitOperation(
            { ...providerContext(actor.membershipId, actor, marked), signal },
            {
              kind: marked.itemType,
              controlNumber,
              ...(beneficiary ? { beneficiary } : {}),
              ...(marked.dcn ? { dcn: marked.dcn } : {}),
              // Derived, never minted: a replay (double click, retry of a lost answer) is the same operation.
              idempotencyKey: ddeIdempotencyKey(marked.id, marked.attemptNumber),
              payload: {
                format: "json",
                document: {
                  itemType: marked.itemType,
                  attemptNumber: marked.attemptNumber,
                  keying,
                },
              },
            },
          ),
        providerTimeoutMs,
      );
      if (bounded.kind !== "done") {
        return leaveInDoubt(actor, marked, bounded.kind, ddeProviderRefusal(DDE.IN_DOUBT));
      }
      const result = bounded.value;

      // Phase 3 (short transaction): apply the outcome against the item as it is NOW (fresh version). Only the very
      // send that set the marker may clear it: same state, same attempt, same marker timestamp.
      const isThisSend = (cur: Item): boolean =>
        cur.state === marked.state &&
        cur.attemptNumber === marked.attemptNumber &&
        cur.providerInDoubtAt?.getTime() === marked.providerInDoubtAt?.getTime();
      if (!result.ok) {
        // Only a code that PROVES the operation never left (allowlist) clears the marker. UNAVAILABLE may be a
        // timeout after the request was written and IDEMPOTENCY_CONFLICT means a vendor operation exists: both stay in doubt.
        if (!REFUSED_BEFORE_SEND.has(result.degraded.code)) {
          return leaveInDoubt(
            actor,
            marked,
            result.degraded.code,
            ddeProviderRefusal(DDE.IN_DOUBT),
          );
        }
        await inOrg(actor, async (tx) => {
          const current = await loadItem(tx, actor, id);
          if (!isThisSend(current)) return; // a newer attempt's marker (or a manual resolution) is not ours to touch
          await persist(
            tx,
            actor,
            current,
            current.version,
            "provider_send_refused",
            current.state,
            current.attemptNumber,
            { providerInDoubtAt: null, providerOperatorMembershipId: null },
            { code: result.degraded.code },
          );
        });
        throw ddeProviderRefusal(result.degraded.code);
      }
      const reference = result.data.providerReference;
      if (!PROVIDER_REFERENCE_PATTERN.test(reference)) {
        return leaveInDoubt(
          actor,
          marked,
          "unusable_reference",
          ddeProviderAnswerRejected("the provider's operation reference is not usable"),
        );
      }
      const applied = await inOrg(actor, async (tx) => {
        const current = await loadItem(tx, actor, id);
        // Someone moved the item while the vendor worked (a cancel, a manual submit): the operation exists at the
        // vendor but cannot be attached to this attempt, so the item must read "possibly sent".
        if (!isThisSend(current)) return null;
        return applyEvent(
          tx,
          actor,
          current,
          current.version,
          "submit",
          {
            submittedAt: now(),
            submissionMode: "provider",
            providerReference: reference,
            providerInDoubtAt: null,
          },
          { submissionMode: "provider", providerReference: reference },
        );
      });
      if (!applied) {
        // A manual record-submission that raced the vendor call cleared the marker: put it back (the vendor holds a
        // live operation), unless a newer send already owns one. The reference goes in the history for reconciliation.
        await inOrg(actor, async (tx) => {
          const current = await loadItem(tx, actor, id);
          if (current.providerInDoubtAt || current.attemptNumber !== marked.attemptNumber) return;
          await persist(
            tx,
            actor,
            current,
            current.version,
            "provider_send_started",
            current.state,
            current.attemptNumber,
            { providerInDoubtAt: now(), providerOperatorMembershipId: actor.membershipId },
            { restored: true, providerReference: reference },
          );
        });
        return leaveInDoubt(
          actor,
          marked,
          `item_changed:${reference}`,
          ddeProviderRefusal(DDE.IN_DOUBT),
        );
      }
      return viewOf(applied, toIsoDate(now()));
    },

    async syncProviderOutcome(actor, id) {
      assertNotAiActor(actor);
      const provider = requireProvider();

      // Phase 1 (short transaction): ownership and eligibility. Provider calls about an operation are made as the
      // person whose DDE ID keyed it (ADR-0103 D4); older rows without one fall back to the syncing operator.
      const target = await withOwnedItem(actor, id, async (_tx, current) => {
        const reference = current.providerReference;
        if (current.state !== "submitted" || current.submissionMode !== "provider" || !reference) {
          throw new ConflictError(
            current.providerInDoubtAt
              ? "this item may already have been sent through the provider; check DDE and record the submission by hand"
              : "only a provider-submitted item awaiting an answer can be synced",
          );
        }
        return {
          reference,
          operatorMembershipId: current.providerOperatorMembershipId ?? actor.membershipId,
          item: current,
        };
      });

      // Phase 2 (NO transaction held): the status inquiry, bounded. Nothing is sent, so a timeout is just unavailable.
      const bounded = await runWithTimeout(
        (signal) =>
          provider.fetchOperationStatus(
            {
              ...providerContext(target.operatorMembershipId, actor, target.item),
              signal,
            },
            target.reference,
          ),
        providerTimeoutMs,
      );
      if (bounded.kind !== "done") throw ddeProviderRefusal(DDE.UNAVAILABLE);
      const result = bounded.value;
      if (!result.ok) throw ddeProviderRefusal(result.degraded.code);
      const status = result.data;
      const reference = target.reference;
      const providerState: DdeProviderSyncView["providerState"] = status.state;
      const latest = status.latest;
      if (status.state === "received" || status.state === "not_found") {
        return { item: viewOf(target.item, toIsoDate(now())), providerState };
      }
      if (
        !latest ||
        latest.providerReference !== reference ||
        latest.disposition !== status.state
      ) {
        throw ddeProviderAnswerRejected("the provider's answer does not match this operation");
      }
      const { plan, recordedAt } = planAnswer(latest, target.item.submittedAt);

      // Phase 3 (short transaction): apply to the item as it is now; the reducer refuses anything but `submitted`
      // (a concurrent sync or manual outcome got there first => 409), and the reference must be unchanged.
      const row = await inOrg(actor, async (tx) => {
        const current = await loadItem(tx, actor, id);
        if (current.providerReference !== reference) {
          throw new ConflictError("the item's provider operation changed while syncing");
        }
        return applyPlanned(tx, actor, current, plan, recordedAt, {
          submissionMode: "provider",
          providerReference: reference,
          // Whose DDE ID the inquiry ran under (may differ from the actor who synced).
          inquiryOperatorMembershipId: target.operatorMembershipId,
        });
      });
      return { item: viewOf(row, toIsoDate(now())), providerState };
    },

    async applyProviderChange(organizationId, providerEntityId, outcome, operatorMembershipId) {
      const actor = systemDdeActor(organizationId);
      return withOrgContext<BillingTx, "applied" | "already" | "unmatched">(
        db,
        systemOrgContext(organizationId),
        async (tx) => {
          const matches = await new repositories.DdeWorkItemRepository(tx).findByProviderReference(
            organizationId,
            providerEntityId,
            outcome.providerReference,
          );
          const [item, second] = matches;
          if (!item) return "unmatched";
          if (second) {
            throw ddeProviderAnswerRejected(
              "more than one queue item carries the provider's reference",
            );
          }
          if (item.state !== "submitted" || item.submissionMode !== "provider") return "already";
          // A possibly-sent item is settled by a person first (ADR-0103): the ingest never resolves it. It cannot carry
          // a provider reference today (the reference is recorded only on a confirmed receipt); this is the guard.
          if (item.providerInDoubtAt) return "already";
          // The change report was read under one operator's DDE ID: only that operator's items are answered by it.
          if (item.providerOperatorMembershipId !== operatorMembershipId) return "already";
          if ((await loadControlNumber(tx, item)) !== outcome.controlNumber) {
            throw ddeProviderAnswerRejected(
              "the provider's answer names a different control number",
            );
          }
          const { plan, recordedAt } = planAnswer(outcome, item.submittedAt);
          await applyPlanned(tx, actor, item, plan, recordedAt, {
            submissionMode: "provider",
            providerReference: outcome.providerReference,
          });
          return "applied";
        },
      );
    },

    retry(actor, id, expectedVersion) {
      return mutate(actor, id, (tx, item) => {
        // A possibly-sent operation is settled by a person first; a new attempt would key a second one.
        if (item.providerInDoubtAt) throw ddeProviderRefusal(DDE.IN_DOUBT);
        return applyEvent(tx, actor, item, expectedVersion, "retry", {
          outcomeCode: null,
          // A new attempt starts unsubmitted: the previous attempt's path and provider operation do not carry over.
          submissionMode: null,
          providerReference: null,
          providerInDoubtAt: null,
          providerOperatorMembershipId: null,
        });
      });
    },

    cancel(actor, id, expectedVersion) {
      return mutate(actor, id, (tx, item) => {
        // Cancelling a possibly-sent item would free its subject for a second keying; resolve it by hand first.
        if (item.providerInDoubtAt) throw ddeProviderRefusal(DDE.IN_DOUBT);
        return applyEvent(tx, actor, item, expectedVersion, "cancel", {});
      });
    },

    close(actor, id, expectedVersion) {
      return mutate(actor, id, (tx, item) =>
        applyEvent(tx, actor, item, expectedVersion, "close", {}),
      );
    },
  };
}

import type { Static } from "@sinclair/typebox";
// apps/backend/src/modules/23-billing-medicare/services/dde-queue-service.ts — the M23 DDE work-queue service
// (ADR-0052): HUMAN WORK TRACKING for Medicare Direct Data Entry (FISS). WardenX holds no DDE credential and
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
  DDE_AT_RISK_DAYS,
  type DdeItemType,
  type DdeWorkItemEvent,
  type DdeWorkItemState,
  ddeDeadlineStatus,
  ddeWorkItemMachine,
  medicareReceiptDay,
  repositories,
  validateDdeCodes,
  validateDdeNotes,
} from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError, ValidationError, WardenXError } from "@wardenx/types";
import type {
  AssignDdeItemBodySchema,
  CreateDdeItemBodySchema,
  DdeItemDetailViewSchema,
  DdeItemListViewSchema,
  DdeItemViewSchema,
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
import { applyDdeNoticeAcceptance } from "./dde-notice-acceptance";

type Item = repositories.DdeWorkItemRecord;
export type DdeItemView = Static<typeof DdeItemViewSchema>;
export type DdeItemDetailView = Static<typeof DdeItemDetailViewSchema>;
export type DdeItemListView = Static<typeof DdeItemListViewSchema>;
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

export interface DdeQueueServicePorts {
  readonly outbox?: WriteOutboxPort;
  readonly now?: () => Date;
  /**
   * Does this membership hold `billing.dde.work` through an active membership of the org? Injected at the composition
   * root (membership and role grants are M2/M3 data). Absent => assigning is refused (fail closed).
   */
  readonly assigneeCanWork?: (organizationId: string, membershipId: string) => Promise<boolean>;
}

export interface DdeQueueService {
  list(
    actor: DdeQueueReadActor,
    filter: DdeListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<DdeItemListView>;
  get(actor: DdeQueueReadActor, id: string): Promise<DdeItemDetailView>;
  create(actor: BillingWriteActor, body: CreateBody): Promise<DdeItemView>;
  /** Take an unassigned item for yourself. */
  claim(actor: BillingWriteActor, id: string, expectedVersion: number): Promise<DdeItemView>;
  /** Assign (or reassign) an item to a named membership. */
  assign(actor: BillingWriteActor, id: string, body: AssignBody): Promise<DdeItemView>;
  start(actor: BillingWriteActor, id: string, expectedVersion: number): Promise<DdeItemView>;
  /** Attest the item was keyed in DDE (step-up required). */
  recordSubmission(
    actor: BillingWriteActor,
    id: string,
    body: SubmissionBody,
  ): Promise<DdeItemView>;
  /** Record a RETURNED / rejected outcome (with its RTP reason code). */
  recordOutcome(actor: BillingWriteActor, id: string, body: OutcomeBody): Promise<DdeItemView>;
  /**
   * Record that the MAC ACCEPTED the item (step-up). On an NOE/NOTR it applies the notice's existing acceptance
   * transition with the operator-entered date, so it is as privileged as keying: `billing.dde.mark_submitted`.
   */
  recordAcceptance(
    actor: BillingWriteActor,
    id: string,
    body: AcceptanceBody,
  ): Promise<DdeItemView>;
  retry(actor: BillingWriteActor, id: string, expectedVersion: number): Promise<DdeItemView>;
  cancel(actor: BillingWriteActor, id: string, expectedVersion: number): Promise<DdeItemView>;
  close(actor: BillingWriteActor, id: string, expectedVersion: number): Promise<DdeItemView>;
}

/** The UI actions legal from each state (the routes enforce the machine; this only drives buttons). */
const ACTIONS_BY_STATE: Record<DdeWorkItemState, readonly Action[]> = {
  queued: ["claim", "assign", "cancel"],
  assigned: ["assign", "start", "cancel"],
  in_progress: ["record_submission", "cancel"],
  submitted: ["record_outcome", "record_acceptance"],
  accepted: ["close"],
  returned: ["retry", "close"],
  closed: [],
  cancelled: [],
};

/** The calendar day on the CMS / CWF (Eastern) clock; deadlines are judged on it, not on the UTC date. */
function toIsoDate(d: Date): string {
  return medicareReceiptDay(d);
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
    deadlineStatus: ddeDeadlineStatus(row, asOf),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    macAcceptedOn: row.macAcceptedOn,
    dcn: row.dcn,
    rtpReasonCode: row.rtpReasonCode,
    outcomeCode: row.outcomeCode,
    notes: row.notes,
    allowedActions: [...ACTIONS_BY_STATE[row.state]],
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The subject a new item acts on, resolved server-side (the body never names the provider entity). */
interface SubjectFacts {
  readonly subjectKind: Item["subjectKind"];
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly deadlineAt: string | null;
}

async function loadSubject(
  tx: BillingTx,
  organizationId: string,
  itemType: DdeItemType,
  subjectId: string,
): Promise<SubjectFacts> {
  if (itemType === "noe" || itemType === "notr") {
    const notice =
      itemType === "noe"
        ? await new repositories.NoeRepository(tx).findById(subjectId)
        : await new repositories.NotrRepository(tx).findById(subjectId);
    if (!notice || notice.organizationId !== organizationId) throw new NotFoundError(itemType);
    if (notice.state === "ack_accepted" || notice.state === "cancelled") {
      throw new ConflictError(
        `the ${itemType} is already ${notice.state}; there is nothing to key`,
      );
    }
    return {
      subjectKind: itemType === "noe" ? "noe_record" : "notr_record",
      providerEntityId: notice.providerEntityId,
      patientId: notice.patientId,
      deadlineAt: notice.windowTargetAt,
    };
  }
  const claim = await new repositories.ClaimRepository(tx).findById(subjectId);
  if (!claim || claim.organizationId !== organizationId) throw new NotFoundError("claim");
  return {
    subjectKind: "claim",
    providerEntityId: claim.providerEntityId,
    patientId: claim.patientId,
    deadlineAt: null,
  };
}

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
    historyDetail: Record<string, string | number | null> = {},
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
    historyDetail: Record<string, string | number | null>,
  ): Promise<Item> => {
    const versioned = await new repositories.DdeWorkItemRepository(tx).transitionToState(
      item.id,
      expectedVersion,
      nextState,
      { ...patch, attemptNumber },
    );
    if (!versioned.ok) {
      throw new WardenXError(
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
      actorMembershipId: actor.membershipId,
      actorKind: "user",
      detail: { ...historyDetail, actorMembershipId: actor.membershipId },
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
    });
    return updated;
  };

  const mutate = async (
    actor: BillingWriteActor,
    id: string,
    fn: (tx: BillingTx, item: Item) => Promise<Item>,
  ): Promise<DdeItemView> => {
    assertNotAiActor(actor);
    const row = await inOrg(actor, async (tx) => fn(tx, await loadItem(tx, actor, id)));
    return viewOf(row, toIsoDate(now()));
  };

  return {
    async list(actor, filter, cursor, limit) {
      const page = await inOrg(actor, (tx) =>
        new repositories.DdeWorkItemRepository(tx).listByOrgPage(
          actor.organizationId,
          { ...filter, asOf: toIsoDate(now()), atRiskDays: DDE_AT_RISK_DAYS },
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
      const { row, events } = await inOrg(actor, async (tx) => {
        const found = await new repositories.DdeWorkItemRepository(tx).findById(id);
        if (!found || found.organizationId !== actor.organizationId) {
          throw new NotFoundError("dde work item");
        }
        return {
          row: found,
          events: await new repositories.DdeWorkEventRepository(tx).listForItem(id),
        };
      });
      return {
        ...viewOf(row, toIsoDate(now())),
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
      const eligible = ports.assigneeCanWork
        ? await ports.assigneeCanWork(actor.organizationId, body.assigneeMembershipId)
        : false;
      if (!eligible) {
        throw new ValidationError("request validation failed", [
          {
            field: "assigneeMembershipId",
            code: "ASSIGNEE_NOT_ELIGIBLE",
            message:
              "the assignee must be an active member of this organization who can work DDE items",
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
            ...(body.dcn !== undefined ? { dcn: body.dcn } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
          },
          { dcn: body.dcn ?? null },
        ),
      );
    },

    recordOutcome(actor, id, body) {
      assertNotAiActor(actor);
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
            ...(body.dcn !== undefined ? { dcn: body.dcn } : {}),
            ...(body.outcomeCode !== undefined ? { outcomeCode: body.outcomeCode } : {}),
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
            ...(body.dcn !== undefined ? { dcn: body.dcn } : {}),
            ...(body.outcomeCode !== undefined ? { outcomeCode: body.outcomeCode } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
          },
          { macAcceptedOn: macAcceptedOn ?? null, dcn: body.dcn ?? null },
        );
      });
    },

    retry(actor, id, expectedVersion) {
      return mutate(actor, id, (tx, item) =>
        applyEvent(tx, actor, item, expectedVersion, "retry", {}),
      );
    },

    cancel(actor, id, expectedVersion) {
      return mutate(actor, id, (tx, item) =>
        applyEvent(tx, actor, item, expectedVersion, "cancel", {}),
      );
    },

    close(actor, id, expectedVersion) {
      return mutate(actor, id, (tx, item) =>
        applyEvent(tx, actor, item, expectedVersion, "close", {}),
      );
    },
  };
}

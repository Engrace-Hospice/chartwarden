// apps/backend/src/modules/36-messaging/governance/retention-governance-service.ts - WP 5.6 (ADR-0086, PROPOSED): the retention view and the
// legal-hold apply / release / preview behind /api/v1/messaging/governance. Ids, counts, dates and the hold name only: never a message body,
// a user or a patient name. Hold names and reasons are free text and are never logged here.
//
// M4 owns `legal_hold`; this module reaches it only through the injected `MessageGovernanceHoldPort` (bound in apps/backend/src/index.ts to
// the transaction-scoped functions in 04-audit/messaging-hold-workflow.ts), so apply and release write the same row, audit event and
// outbox payload as M4's own routes.
import type { AuditContext, AuditQuery } from "@wardenx/audit";
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type ApplyMessageLegalHoldRequest,
  MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH,
  MESSAGE_RETENTION_CLASSES,
  type MessageLegalHoldDto,
  type MessageLegalHoldListDto,
  type MessageLegalHoldReleasePreviewDto,
  type MessageRetentionClass,
  NotFoundError,
  RELEASE_PREVIEW_STALE_CODE,
  type ReleaseMessageLegalHoldRequest,
  type RetentionClassDto,
  type RetentionOverviewDto,
  ValidationError,
  WardenXError,
} from "@wardenx/types";
import { sql } from "drizzle-orm";
import {
  MESSAGE_RETENTION_YEARS,
  count,
  materialiseHold,
  pastWindow,
  windowEnd,
} from "../jobs/retention-scan";
import { type ActiveMessageHold, anyHoldPredicate, holdPredicate } from "../jobs/retention-hold-sql";

/** The selectors of a hold's criteria that messaging reads (M4's jsonb; extra keys ignored). */
export interface GovernanceCriteria {
  readonly patientIds?: readonly string[];
  readonly channelIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly resourceKinds?: readonly string[];
  readonly dateRange?: { readonly from: string; readonly to: string };
}

export interface GovernanceHoldRow {
  readonly id: string;
  readonly name: string;
  readonly criteria: GovernanceCriteria;
  readonly status: "active" | "released";
  readonly appliedBy: string | null;
  readonly appliedAt: Date;
  readonly releasedAt: Date | null;
}

/** M4's hold seam, bound at the composition root. Every call runs in the caller's tenant transaction. */
export interface MessageGovernanceHoldPort {
  list(tx: DbClient, organizationId: string, limit: number): Promise<readonly GovernanceHoldRow[]>;
  get(tx: DbClient, organizationId: string, id: string): Promise<GovernanceHoldRow | null>;
  activeHolds(tx: DbClient, organizationId: string): Promise<readonly ActiveMessageHold[]>;
  certificateStatuses(
    tx: DbClient,
    organizationId: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  apply(
    tx: DbClient,
    auditContext: AuditContext,
    input: {
      readonly organizationId: string;
      readonly userId: string;
      readonly name: string;
      readonly criteria: GovernanceCriteria;
      readonly reason: string;
      readonly matchedRecordCount: number;
    },
  ): Promise<{ readonly id: string }>;
  release(
    tx: DbClient,
    auditContext: AuditContext,
    input: {
      readonly organizationId: string;
      readonly holdId: string;
      readonly reason: string;
      readonly countRestored: () => Promise<number>;
    },
  ): Promise<{ readonly restoredRecordCount: number }>;
}

export interface GovernanceActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly auditContext: AuditContext;
}

export interface RetentionGovernanceDeps {
  readonly db: DbClient;
  readonly holds: MessageGovernanceHoldPort;
  /** Reads the last `m36.retention_scan.run` row (audit_event is helper-only: never queried directly). */
  readonly auditQuery: Pick<AuditQuery, "searchEvents">;
  readonly now?: () => Date;
}

/** Overlay statements run in the apply transaction (5000 rows each); the next weekly scan covers any remainder. */
export const APPLY_MATERIALISE_MAX_BATCHES = 4;
/** Holds listed (newest first). */
export const HOLD_LIST_LIMIT = 100;
/** The criteria marker of an org-wide messaging hold: M4 needs a selector, and "message" names no audit resource kind. */
export const ORG_WIDE_RESOURCE_KIND = "message";
const SCAN_EVENT_TYPE = "m36.retention_scan.run";

/** Next Sunday 02:00 UTC strictly after `from` (the weekly `messaging.retention_scan` cron). */
export function nextScanAfter(from: Date): Date {
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 2, 0, 0),
  );
  next.setUTCDate(next.getUTCDate() + ((7 - next.getUTCDay()) % 7));
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

const asHold = (row: GovernanceHoldRow): ActiveMessageHold => ({
  id: row.id,
  criteria: row.criteria,
});

function scopeOf(c: GovernanceCriteria): MessageLegalHoldDto["scope"] {
  const channel_ids = c.channelIds ?? [];
  const user_ids = c.userIds ?? [];
  const patient_ids = c.patientIds ?? [];
  return {
    channel_ids,
    user_ids,
    patient_ids,
    org_wide: channel_ids.length === 0 && user_ids.length === 0 && patient_ids.length === 0,
  };
}

function assertReason(reason: string): void {
  if (reason.trim().length < MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH) {
    throw new ValidationError("request validation failed", [
      {
        field: "reason",
        code: "INVALID",
        message: `a reason of at least ${MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH} characters is required`,
      },
    ]);
  }
}

function criteriaOf(body: ApplyMessageLegalHoldRequest): GovernanceCriteria {
  const channelIds = body.channel_ids ?? [];
  const userIds = body.user_ids ?? [];
  const patientIds = body.patient_ids ?? [];
  const named = channelIds.length + userIds.length + patientIds.length > 0;
  if (body.org_wide === true && named) {
    throw new ValidationError("request validation failed", [
      {
        field: "org_wide",
        code: "INVALID",
        message: "an org-wide hold cannot also name channels, users or patients",
      },
    ]);
  }
  if (body.org_wide !== true && !named) {
    throw new ValidationError("request validation failed", [
      {
        field: "channel_ids",
        code: "INVALID",
        message: "name at least one channel, user or patient, or hold the whole organisation",
      },
    ]);
  }
  if (body.org_wide === true) return { resourceKinds: [ORG_WIDE_RESOURCE_KIND] };
  return {
    ...(channelIds.length > 0 ? { channelIds } : {}),
    ...(userIds.length > 0 ? { userIds } : {}),
    ...(patientIds.length > 0 ? { patientIds } : {}),
  };
}

export function createRetentionGovernanceService(deps: RetentionGovernanceDeps) {
  const { db, holds } = deps;
  const clock = deps.now ?? (() => new Date());
  const inTx = <T>(actor: GovernanceActor, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext<DbClient, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  const heldMessages = (tx: DbClient, orgId: string, criteria: GovernanceCriteria) =>
    count(tx, sql`m.organization_id = ${orgId}::uuid AND ${holdPredicate(criteria)}`);

  const toDto = async (
    tx: DbClient,
    orgId: string,
    row: GovernanceHoldRow,
  ): Promise<MessageLegalHoldDto> => ({
    id: row.id,
    name: row.name,
    status: row.status,
    scope: scopeOf(row.criteria),
    placed_by: row.appliedBy ?? "",
    placed_at: row.appliedAt.toISOString(),
    released_at: row.releasedAt ? row.releasedAt.toISOString() : null,
    held_messages: row.status === "active" ? await heldMessages(tx, orgId, row.criteria) : 0,
  });

  async function requireHold(tx: DbClient, orgId: string, id: string): Promise<GovernanceHoldRow> {
    const row = await holds.get(tx, orgId, id);
    if (!row) throw new NotFoundError("legal_hold", id);
    return row;
  }

  /** Past their retention window and held by no OTHER active hold (so they become eligible once this hold is released). */
  async function eligibleOnRelease(tx: DbClient, orgId: string, row: GovernanceHoldRow) {
    const others = (await holds.activeHolds(tx, orgId)).filter((h) => h.id !== row.id);
    let eligible = 0;
    for (const cls of MESSAGE_RETENTION_CLASSES) {
      const base = pastWindow(orgId, cls, windowEnd(clock(), MESSAGE_RETENTION_YEARS[cls]));
      eligible += await count(
        tx,
        sql`${base} AND ${holdPredicate(row.criteria)} AND NOT ${anyHoldPredicate(others)}`,
      );
    }
    return eligible;
  }

  return {
    async overview(actor: GovernanceActor): Promise<RetentionOverviewDto> {
      const page = await deps.auditQuery.searchEvents(actor.organizationId, {
        eventType: SCAN_EVENT_TYPE,
        limit: 1,
      });
      const last = page.items[0];
      const ctx = asRecord(last?.context);
      const certs = (Array.isArray(ctx.certificates) ? ctx.certificates : []).map(asRecord);
      const certIds = certs.flatMap((c) => (typeof c.certificateId === "string" ? [c.certificateId] : []));
      const statuses = await inTx(actor, (tx) =>
        holds.certificateStatuses(tx, actor.organizationId, certIds),
      );
      const classes: RetentionClassDto[] = MESSAGE_RETENTION_CLASSES.map(
        (cls: MessageRetentionClass) => {
          const cert = certs.find((c) => c.dataClass === `message.${cls}`);
          const certificateId = typeof cert?.certificateId === "string" ? cert.certificateId : null;
          return {
            class: cls,
            period_years: MESSAGE_RETENTION_YEARS[cls],
            source: "platform_default",
            eligible: num(asRecord(ctx.eligibleByClass)[cls]),
            held: num(asRecord(ctx.heldByClass)[cls]),
            capped: ctx.capped === true,
            certificate_id: certificateId,
            certificate_status: certificateId ? (statuses.get(certificateId) ?? null) : null,
          };
        },
      );
      return {
        classes,
        next_scan_at: nextScanAfter(clock()).toISOString(),
        last_scan_at: last ? last.createdAt : null,
        destruction_built: false,
      };
    },

    async list(actor: GovernanceActor): Promise<MessageLegalHoldListDto> {
      return inTx(actor, async (tx) => {
        const rows = await holds.list(tx, actor.organizationId, HOLD_LIST_LIMIT);
        const out: MessageLegalHoldDto[] = [];
        for (const row of rows) out.push(await toDto(tx, actor.organizationId, row));
        return { holds: out };
      });
    },

    async apply(
      actor: GovernanceActor,
      body: ApplyMessageLegalHoldRequest,
    ): Promise<MessageLegalHoldDto> {
      assertReason(body.reason);
      const criteria = criteriaOf(body);
      return inTx(actor, async (tx) => {
        const matched = await heldMessages(tx, actor.organizationId, criteria);
        const { id } = await holds.apply(tx, actor.auditContext, {
          organizationId: actor.organizationId,
          userId: actor.userId,
          name: body.name,
          criteria,
          reason: body.reason,
          matchedRecordCount: matched,
        });
        // The overlay is the cheap half of the hold; enforcement also reads the live criteria, so a bounded batch is enough here.
        await materialiseHold(tx, actor.organizationId, { id, criteria }, APPLY_MATERIALISE_MAX_BATCHES);
        return toDto(tx, actor.organizationId, await requireHold(tx, actor.organizationId, id));
      });
    },

    async releasePreview(
      actor: GovernanceActor,
      id: string,
    ): Promise<MessageLegalHoldReleasePreviewDto> {
      return inTx(actor, async (tx) => {
        const row = await requireHold(tx, actor.organizationId, id);
        return {
          hold_id: row.id,
          held_messages: await heldMessages(tx, actor.organizationId, row.criteria),
          eligible_on_release: await eligibleOnRelease(tx, actor.organizationId, row),
        };
      });
    },

    async release(
      actor: GovernanceActor,
      id: string,
      body: ReleaseMessageLegalHoldRequest,
    ): Promise<MessageLegalHoldDto> {
      assertReason(body.reason);
      return inTx(actor, async (tx) => {
        const row = await requireHold(tx, actor.organizationId, id);
        if (row.status === "released") {
          throw new WardenXError("ALREADY_RELEASED", `legal_hold ${id} is already released`, 409);
        }
        const eligible = await eligibleOnRelease(tx, actor.organizationId, row);
        if (eligible !== body.confirmed_eligible_count) {
          throw new WardenXError(
            RELEASE_PREVIEW_STALE_CODE,
            "the number of messages this release makes eligible changed; review the preview again",
            409,
            [{ field: "confirmed_eligible_count", code: "STALE", message: String(eligible) }],
          );
        }
        await holds.release(tx, actor.auditContext, {
          organizationId: actor.organizationId,
          holdId: id,
          reason: body.reason,
          countRestored: () => heldMessages(tx, actor.organizationId, row.criteria),
        });
        return toDto(tx, actor.organizationId, await requireHold(tx, actor.organizationId, id));
      });
    },
  };
}

export type RetentionGovernanceService = ReturnType<typeof createRetentionGovernanceService>;

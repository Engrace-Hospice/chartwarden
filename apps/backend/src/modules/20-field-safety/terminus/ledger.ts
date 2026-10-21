// apps/backend/src/modules/20-field-safety/terminus/ledger.ts - GAP-032: the data access for
// `safety_sos_terminus_action`, the durable intent ledger behind the SOS emergency-terminus effects.
//
// Every function takes the caller's tenant tx (`withOrgContext`); none opens its own and none touches the
// network. Immutable in spirit: a row is only ever inserted once (ON CONFLICT DO NOTHING is the idempotency
// primitive) and settled once; the claim/settle updates are guarded on the status they expect.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import type {
  SafetyTerminusActionKind,
  SafetyTerminusActionStatus,
  SafetyTerminusOutcomeCode,
} from "@chartwarden/types";
import { and, asc, eq, sql } from "drizzle-orm";
import { type PriorDialRow, TERMINUS_LEASE_MS, terminusIdempotencyKey } from "./policy";

const ACTION = schema.safetySosTerminusAction;

export interface TerminusAlertAnchor {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
}

export interface NewTerminusAction {
  readonly anchor: TerminusAlertAnchor;
  readonly sosAlertId: string;
  readonly kind: SafetyTerminusActionKind;
  readonly loopIteration: number;
  readonly attemptNo: number;
  readonly at: Date;
  /** `pending` for work an executor must do; `skipped` records a decision made at entry (with its code). */
  readonly initial:
    | { readonly status: "pending" }
    | { readonly status: "skipped"; readonly outcomeCode: SafetyTerminusOutcomeCode };
}

/** Insert one intent row. Returns `true` only when THIS call created it (the idempotency win). */
export async function insertTerminusAction(
  tx: DbClient,
  action: NewTerminusAction,
): Promise<boolean> {
  const skipped = action.initial.status === "skipped";
  const inserted = await tx
    .insert(ACTION)
    .values({
      organizationId: action.anchor.organizationId,
      providerEntityId: action.anchor.providerEntityId,
      locationId: action.anchor.locationId,
      sosAlertId: action.sosAlertId,
      actionKind: action.kind,
      loopIteration: action.loopIteration,
      attemptNo: action.attemptNo,
      idempotencyKey: terminusIdempotencyKey(
        action.sosAlertId,
        action.kind,
        action.loopIteration,
        action.attemptNo,
      ),
      status: action.initial.status,
      outcomeCode: action.initial.status === "skipped" ? action.initial.outcomeCode : null,
      requestedAt: action.at,
      nextAttemptAt: action.at,
      settledAt: skipped ? action.at : null,
    })
    .onConflictDoNothing()
    .returning({ id: ACTION.id });
  return inserted.length === 1;
}

/** Every contact-call row for an alert, for the pacing decision. */
export async function listDialRows(tx: DbClient, sosAlertId: string): Promise<PriorDialRow[]> {
  const rows = await tx
    .select({
      attemptNo: ACTION.attemptNo,
      status: ACTION.status,
      outcomeCode: ACTION.outcomeCode,
      settledAt: ACTION.settledAt,
    })
    .from(ACTION)
    .where(and(eq(ACTION.sosAlertId, sosAlertId), eq(ACTION.actionKind, "dial_contact")))
    .orderBy(asc(ACTION.attemptNo));
  return rows.map((r) => ({ ...r, status: r.status as SafetyTerminusActionStatus }));
}

/** What the ledger can truthfully say about an alert's terminus effects so far (the event payload source). */
export interface TerminusLedgerFlags {
  readonly chartwardenOpsPaged: boolean;
  readonly emergencyContactCallInitiated: boolean;
  /** The jurisdiction the latest successful `resolve_psap` row used, or null. */
  readonly psapJurisdictionId: string | null;
}

export async function readLedgerFlags(
  tx: DbClient,
  sosAlertId: string,
): Promise<TerminusLedgerFlags> {
  const rows = await tx
    .select({
      kind: ACTION.actionKind,
      status: ACTION.status,
      jurisdictionId: ACTION.jurisdictionId,
      loopIteration: ACTION.loopIteration,
    })
    .from(ACTION)
    .where(and(eq(ACTION.sosAlertId, sosAlertId), eq(ACTION.status, "succeeded")))
    .orderBy(asc(ACTION.loopIteration));
  const latestPsap = [...rows].reverse().find((r) => r.kind === "resolve_psap" && r.jurisdictionId);
  return {
    chartwardenOpsPaged: rows.some((r) => r.kind === "page_ops"),
    emergencyContactCallInitiated: rows.some((r) => r.kind === "dial_contact"),
    psapJurisdictionId: latestPsap?.jurisdictionId ?? null,
  };
}

export interface ClaimedTerminusAction {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly sosAlertId: string;
  readonly kind: SafetyTerminusActionKind;
  readonly loopIteration: number;
  readonly attemptNo: number;
  readonly idempotencyKey: string;
  readonly attempts: number;
  /** True when the claim recovered a row an earlier executor left `attempting` past its lease. */
  readonly recoveredFromExpiredLease: boolean;
}

interface ClaimRow {
  id: string;
  organization_id: string;
  provider_entity_id: string;
  location_id: string | null;
  sos_alert_id: string;
  action_kind: SafetyTerminusActionKind;
  loop_iteration: number;
  attempt_no: number;
  idempotency_key: string;
  attempts: number;
  recovered: boolean;
}

/**
 * Claim up to `limit` rows that are due: `pending` with `next_attempt_at <= now`, or `attempting` whose lease
 * expired (a crashed executor). `FOR UPDATE SKIP LOCKED` means two executors never claim the same row.
 */
export async function claimDueTerminusActions(
  tx: DbClient,
  organizationId: string,
  now: Date,
  limit: number,
): Promise<ClaimedTerminusAction[]> {
  const leaseUntil = new Date(now.getTime() + TERMINUS_LEASE_MS);
  const result = await tx.execute(sql`
    WITH due AS (
      SELECT id, (status = 'attempting') AS recovered
        FROM safety_sos_terminus_action
       WHERE organization_id = ${organizationId}
         AND ((status = 'pending' AND next_attempt_at <= ${now})
              OR (status = 'attempting' AND lease_until < ${now}))
       ORDER BY next_attempt_at
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED)
    UPDATE safety_sos_terminus_action a
       SET status = 'attempting', lease_until = ${leaseUntil}, attempts = a.attempts + 1, updated_at = ${now}
      FROM due
     WHERE a.id = due.id
 RETURNING a.id, a.organization_id, a.provider_entity_id, a.location_id, a.sos_alert_id, a.action_kind,
           a.loop_iteration, a.attempt_no, a.idempotency_key, a.attempts, due.recovered`);
  return (result.rows as unknown as ClaimRow[]).map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    providerEntityId: r.provider_entity_id,
    locationId: r.location_id,
    sosAlertId: r.sos_alert_id,
    kind: r.action_kind,
    loopIteration: r.loop_iteration,
    attemptNo: r.attempt_no,
    idempotencyKey: r.idempotency_key,
    attempts: r.attempts,
    recoveredFromExpiredLease: r.recovered,
  }));
}

export type TerminusSettlement =
  | {
      readonly status: "succeeded";
      readonly outcomeCode: "ok";
      readonly externalRef?: string;
      readonly jurisdictionId?: string;
    }
  | {
      readonly status: "failed" | "skipped" | "superseded";
      readonly outcomeCode: SafetyTerminusOutcomeCode;
    }
  | {
      /** Transient failure: back to `pending`, retried after `nextAttemptAt`. */
      readonly status: "retry";
      readonly outcomeCode: SafetyTerminusOutcomeCode;
      readonly nextAttemptAt: Date;
    };

/** Turns a transient failure into a backoff retry, or a terminal `failed` once the row's budget is spent. */
export type RetryOrFail = (outcome: SafetyTerminusOutcomeCode) => TerminusSettlement;

/** Settle a claimed row. Guarded on `status = 'attempting'` so a late settle cannot overwrite a recovery. */
export async function settleTerminusAction(
  tx: DbClient,
  id: string,
  settlement: TerminusSettlement,
  at: Date,
): Promise<boolean> {
  const base = { leaseUntil: null, updatedAt: at, outcomeCode: settlement.outcomeCode };
  const patch =
    settlement.status === "retry"
      ? { ...base, status: "pending", nextAttemptAt: settlement.nextAttemptAt }
      : settlement.status === "succeeded"
        ? {
            ...base,
            status: "succeeded",
            settledAt: at,
            externalRef: settlement.externalRef ?? null,
            jurisdictionId: settlement.jurisdictionId ?? null,
          }
        : { ...base, status: settlement.status, settledAt: at };
  const updated = await tx
    .update(ACTION)
    .set(patch)
    .where(and(eq(ACTION.id, id), eq(ACTION.status, "attempting")))
    .returning({ id: ACTION.id });
  return updated.length === 1;
}

/** Rows still unsettled past `olderThanMs` - what the readiness probe reports as stuck. */
export async function countStuckTerminusActions(
  tx: DbClient,
  organizationId: string,
  now: Date,
  olderThanMs: number,
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const result = await tx.execute(sql`
    SELECT count(*)::int AS n FROM safety_sos_terminus_action
     WHERE organization_id = ${organizationId}
       AND (status IN ('pending','attempting') OR status = 'failed')
       AND requested_at < ${cutoff}
       AND (status <> 'failed' OR settled_at > ${new Date(now.getTime() - 24 * 3_600_000)})`);
  return (result.rows[0] as { n: number } | undefined)?.n ?? 0;
}

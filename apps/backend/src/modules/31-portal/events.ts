// apps/backend/src/modules/31-portal/events.ts - the M31 outbox emitter (GAP-159).
//
// One small port every emit site shares, built over the real catalog-validating publisher
// (`bindCallerModule(txOutboxPublisher, "m31")`). Two entry points, named for the guarantee they give:
//   - `emitInTx(tx, ...)`  - SAME-TRANSACTION emit: the event commits (or rolls back) with the row mutation
//     it describes. Used wherever M31 itself writes the row (suspend, room mint, lifecycle, grant
//     insert/revoke, eraser, sweeps, consumers).
//   - `emit(orgId, ...)`   - DECISION-POINT emit in its own short org transaction, for routes whose row
//     mutation lives in another module's transaction (M5 amendment intake, M36 message send, M2 session
//     binding, the M22 upload handoff). A failure here is LOGGED (never silently swallowed) and does not
//     undo the already-committed action it reports.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { M31EventName } from "@chartwarden/types";

/** The catalog-validating tx publisher slice (`bindCallerModule(txOutboxPublisher, "m31")`). */
export interface M31OutboxPublisher {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface M31Aggregate {
  readonly kind: "portal_account" | "portal_access_grant" | "telehealth_visit" | "portal_session";
  readonly id: string;
}

export interface M31EventEmitter {
  emitInTx(
    tx: unknown,
    organizationId: string,
    name: M31EventName,
    aggregate: M31Aggregate,
    payload: Record<string, unknown>,
  ): Promise<void>;
  emit(
    organizationId: string,
    name: M31EventName,
    aggregate: M31Aggregate,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

const SYSTEM_USER_ID = "";

export function createM31EventEmitter(deps: {
  readonly db: DbClient;
  readonly publisher: M31OutboxPublisher;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}): M31EventEmitter {
  const publishIn = (
    tx: unknown,
    organizationId: string,
    name: M31EventName,
    aggregate: M31Aggregate,
    payload: Record<string, unknown>,
  ): Promise<void> =>
    deps.publisher.publish(tx as DbClient, {
      eventName: name,
      payload,
      organizationId,
      aggregateKind: aggregate.kind,
      aggregateId: aggregate.id,
    });
  return {
    emitInTx: publishIn,
    async emit(organizationId, name, aggregate, payload) {
      try {
        await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, (tx) =>
          publishIn(tx, organizationId, name, aggregate, payload),
        );
      } catch (error) {
        deps.warn?.("m31 outbox emit failed", {
          event: name,
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

// -- grant / account event helpers (shared by every PAG write site) ---------------------------------------

export interface GrantEventRow {
  readonly id: string;
  readonly portalAccountId: string;
  readonly patientId: string;
}

export async function emitGrantsRevoked(
  events: M31EventEmitter | undefined,
  tx: unknown,
  organizationId: string,
  rows: readonly GrantEventRow[],
  revokeCascadeSource: string,
): Promise<void> {
  if (!events) return;
  for (const r of rows) {
    await events.emitInTx(
      tx,
      organizationId,
      "m31.portal_access_grant.revoked",
      { kind: "portal_access_grant", id: r.id },
      {
        grantId: r.id,
        portalAccountId: r.portalAccountId,
        patientId: r.patientId,
        revokeCascadeSource,
      },
    );
  }
}

export async function emitGrantGranted(
  events: M31EventEmitter | undefined,
  tx: unknown,
  organizationId: string,
  row: GrantEventRow & { readonly grantKind: string },
): Promise<void> {
  if (!events) return;
  await events.emitInTx(
    tx,
    organizationId,
    "m31.portal_access_grant.granted",
    { kind: "portal_access_grant", id: row.id },
    {
      grantId: row.id,
      portalAccountId: row.portalAccountId,
      patientId: row.patientId,
      grantKind: row.grantKind,
    },
  );
}

// -- boot holder (ONLY for registrations that run before the publisher exists: the eraser) --------------------

let bootEmitter: M31EventEmitter | undefined;

/** Bind the composition-root emitter once the publisher exists; the eraser reads it lazily at erase time. */
export function bindM31EventEmitter(emitter: M31EventEmitter | undefined): void {
  bootEmitter = emitter;
}

export function boundM31EventEmitter(): M31EventEmitter | undefined {
  return bootEmitter;
}

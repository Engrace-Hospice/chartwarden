// apps/backend/src/modules/03-authorization — the PRODUCTION BreakGlassStore (M3 §3.5 / §7.4, audit #M3).
//
// The break-glass route surface (POST /api/v1/breakglass + /:id/cosign + /:id/revoke) and the §2.2
// break-glass branch (`contract.ts` findActiveGrant) ran on an IN-MEMORY store, so emergency-access
// grants vanished on restart and were not shared across instances — a present-but-non-durable control.
// This is the live Drizzle implementation over the M3-owned `break_glass_event` table, run inside
// `withOrgContext` (org-bound list/invoke/find) / `withOrgContextFromRequest` (by-id get/cosign/revoke)
// so RLS (policy `break_glass_event_org`, migration 0009) scopes every row by `app.org_id`. M3 may import
// @wardenx/db + @wardenx/tenancy (dependsOn 1), so the store lives in the module dir (the role-store precedent).
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import {
  BreakGlassCosignError,
  type BreakGlassStatus,
  type BreakGlassStore,
  type BreakGlassView,
  type M3OutboxPublisher,
} from "./authz-ports";

const COLUMNS = {
  id: schema.breakGlassEvents.id,
  organizationId: schema.breakGlassEvents.organizationId,
  actorUserId: schema.breakGlassEvents.actorUserId,
  targetPatientId: schema.breakGlassEvents.targetPatientId,
  reason: schema.breakGlassEvents.reason,
  status: schema.breakGlassEvents.status,
  cosignRequired: schema.breakGlassEvents.cosignRequired,
  startedAt: schema.breakGlassEvents.startedAt,
  expiresAt: schema.breakGlassEvents.expiresAt,
} as const;

interface Row {
  id: string;
  organizationId: string;
  actorUserId: string;
  targetPatientId: string | null;
  reason: string;
  status: string;
  cosignRequired: boolean;
  startedAt: Date;
  expiresAt: Date;
}

function toView(r: Row): BreakGlassView {
  return {
    eventId: r.id,
    organizationId: r.organizationId,
    actorUserId: r.actorUserId,
    targetPatientId: r.targetPatientId,
    reason: r.reason,
    status: r.status as BreakGlassStatus,
    cosignRequired: r.cosignRequired,
    startedAt: r.startedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  };
}

/** Build the live BreakGlassStore over the pooled Drizzle client (org-scoped under RLS). */
export function createDbBreakGlassStore(db: DbClient, outbox?: M3OutboxPublisher): BreakGlassStore {
  return {
    async invoke(input): Promise<BreakGlassView> {
      // The invoker IS the org-bound actor; org + user drive the RLS context for the INSERT (WITH CHECK).
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: input.actorUserId },
        async (tx) => {
          const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
          const inserted = (await tx
            .insert(schema.breakGlassEvents)
            .values({
              organizationId: input.organizationId,
              actorUserId: input.actorUserId,
              targetPatientId: input.targetPatientId,
              reason: input.reason,
              status: input.cosignRequired ? "cosign_pending" : "active",
              cosignRequired: input.cosignRequired,
              expiresAt,
            })
            .returning(COLUMNS)) as Row[];
          const view = toView(inserted[0]!);
          // GAP-010 — the §7.4 "Compliance notified" guarantee: `m3.breakglass.invoked` is published on THIS
          // tx, so the notification commits or rolls back with the grant (M36's consumer delivers the alert).
          await outbox?.publish(tx as never, {
            eventName: "m3.breakglass.invoked",
            payload: {
              breakGlassId: view.eventId,
              organizationId: view.organizationId,
              actorUserId: view.actorUserId,
              targetPatientId: view.targetPatientId,
              expiresAt: view.expiresAt,
              cosignRequired: view.cosignRequired,
            },
            organizationId: view.organizationId,
            aggregateKind: "break_glass_event",
            aggregateId: view.eventId,
          });
          return view;
        },
      );
    },

    async get(eventId): Promise<BreakGlassView | null> {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = (await tx
          .select(COLUMNS)
          .from(schema.breakGlassEvents)
          .where(eq(schema.breakGlassEvents.id, eventId))
          .limit(1)) as Row[];
        return rows[0] ? toView(rows[0]) : null;
      });
    },

    async cosign(eventId, byUserId): Promise<BreakGlassView> {
      return withOrgContextFromRequest(db, async (tx) => {
        // BOTH guards live in the WHERE rather than in a read-then-write. `breakglass.cosign` is
        // held by several people by construction (it is the two-person control), so two of them
        // acting on the same pending event would both clear a prior SELECT; here the second
        // UPDATE simply matches no row. The `ne(...)` conjunct is the app-layer twin of the
        // `bge_cosigner_distinct` CHECK (migration 0210) — the constraint is what makes the
        // invariant survive a future caller, the predicate is what turns it into a 409 instead
        // of a raised integrity error.
        const updated = (await tx
          .update(schema.breakGlassEvents)
          .set({ status: "active", cosignedBy: byUserId })
          .where(
            and(
              eq(schema.breakGlassEvents.id, eventId),
              eq(schema.breakGlassEvents.status, "cosign_pending"),
              ne(schema.breakGlassEvents.actorUserId, byUserId),
            ),
          )
          .returning(COLUMNS)) as Row[];
        if (updated[0]) return toView(updated[0]);
        // Nothing matched: re-read to say WHY. Order matters — a settled event reports its status
        // rather than leaking whether the caller happens to be its invoker.
        const existing = (await tx
          .select(COLUMNS)
          .from(schema.breakGlassEvents)
          .where(eq(schema.breakGlassEvents.id, eventId))
          .limit(1)) as Row[];
        const row = existing[0];
        if (!row) throw new Error(`unknown break-glass event ${eventId}`);
        if (row.status !== "cosign_pending")
          throw new BreakGlassCosignError(
            "not_pending",
            `break-glass event ${eventId} is ${row.status}, not awaiting a co-signature`,
          );
        throw new BreakGlassCosignError(
          "self_cosign",
          "break-glass co-signature requires a user distinct from the invoker",
        );
      });
    },

    async revoke(eventId): Promise<BreakGlassView> {
      return withOrgContextFromRequest(db, async (tx) => {
        const updated = (await tx
          .update(schema.breakGlassEvents)
          .set({ status: "revoked" })
          .where(eq(schema.breakGlassEvents.id, eventId))
          .returning(COLUMNS)) as Row[];
        if (!updated[0]) throw new Error(`unknown break-glass event ${eventId}`);
        const view = toView(updated[0]);
        await outbox?.publish(tx as never, {
          eventName: "m3.breakglass.ended",
          payload: {
            breakGlassId: view.eventId,
            organizationId: view.organizationId,
            outcome: "revoked",
          },
          organizationId: view.organizationId,
          aggregateKind: "break_glass_event",
          aggregateId: view.eventId,
        });
        return view;
      });
    },

    async listForOrg(organizationId): Promise<BreakGlassView[]> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(COLUMNS)
          .from(schema.breakGlassEvents)
          .where(eq(schema.breakGlassEvents.organizationId, organizationId))
          .orderBy(desc(schema.breakGlassEvents.startedAt))) as Row[];
        return rows.map(toView);
      });
    },

    async findActiveGrant(organizationId, actorUserId, targetPatientId, nowMs) {
      // The §2.2 read on every ABAC denial: an ACTIVE, unexpired grant by this actor in this org.
      // Target match is applied in code and requires a real patient id on BOTH sides — a null on
      // either grants nothing. A null GRANT target was the scope-level wildcard that let one
      // `breakglass.invoke` satisfy every ABAC predicate in the org; a null REQUEST target means
      // the predicate is not patient-keyed, which emergency chart access does not cover.
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
        const rows = (await tx
          .select({
            id: schema.breakGlassEvents.id,
            targetPatientId: schema.breakGlassEvents.targetPatientId,
          })
          .from(schema.breakGlassEvents)
          .where(
            and(
              eq(schema.breakGlassEvents.organizationId, organizationId),
              eq(schema.breakGlassEvents.actorUserId, actorUserId),
              eq(schema.breakGlassEvents.status, "active"),
              gt(schema.breakGlassEvents.expiresAt, new Date(nowMs)),
            ),
          )) as Array<{ id: string; targetPatientId: string | null }>;
        const grant = rows.find(
          (r) => r.targetPatientId !== null && r.targetPatientId === targetPatientId,
        );
        return grant ? { eventId: grant.id } : null;
      });
    },
  };
}

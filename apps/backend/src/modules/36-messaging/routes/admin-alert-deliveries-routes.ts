import { type Static, Type } from "@sinclair/typebox";
// apps/backend/src/modules/36-messaging/routes/admin-alert-deliveries-routes.ts — M36 spec §4.1
// `GET /api/v1/admin/messaging/alert-deliveries` (`messaging.admin.read`, platform-ops: "failures and audit drill"),
// GAP-165.
//
// THREE LAYERS, because this is a cross-tenant read:
//   1. RBAC `messaging.admin.read` (platform category) AND the `messaging_admin_platform_ops` ABAC conjunct — a
//      permission key travels with whatever role template carries it, so a tenant role that acquired the key would
//      otherwise read EVERY tenant's delivery failures. The platform-only half is the predicate (M38/M40 shape).
//   2. The data door is the migration-0474 SECURITY DEFINER reader: delivery METADATA only (ids, org, category,
//      severity, channel, status, truncated failure reason, timestamps) — no recipient, destination or payload —
//      bounded and keyset-paginated.
//   3. AUDITED: every call writes an org-less platform audit event (who, which filter, how many rows) BEFORE the
//      response is released, and a failed audit write fails the request — an unaudited cross-tenant read must not
//      succeed.
import { type AbacContext, registerPredicateIdempotent, requireAbac } from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { UnauthorizedError, ValidationError } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse } from "./messaging-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const ADMIN_READ_KEY = "messaging.admin.read";
export const ADMIN_PLATFORM_PREDICATE = "messaging_admin_platform_ops";

/** `platform_ops` is an M3 RBAC ROLE on a staff session; an actor without it fails closed. */
export const messagingAdminPlatformOps = async (context: AbacContext): Promise<boolean> =>
  context.roles.includes("platform_ops");

/** Register the single-owner platform predicate (idempotent — re-boot / tests safe). */
export function registerMessagingAdminPredicates(): void {
  registerPredicateIdempotent(ADMIN_PLATFORM_PREDICATE, messagingAdminPlatformOps);
}

export const AlertDeliveriesQuerySchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union([
        Type.Literal("failed"),
        Type.Literal("pending"),
        Type.Literal("sent"),
        Type.Literal("delivered"),
        Type.Literal("skipped_quiet_hours"),
        Type.Literal("forwarded"),
        Type.Literal("all"),
      ]),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    before: Type.Optional(
      Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T[0-9:.]+(Z|[+-]\\d{2}:\\d{2})$" }),
    ),
  },
  { additionalProperties: false },
);

export const AlertDeliveryRowSchema = Type.Object({
  deliveryId: Type.String(),
  organizationId: Type.String(),
  alertId: Type.String(),
  alertCategory: Type.String(),
  alertSeverity: Type.String(),
  channel: Type.String(),
  status: Type.String(),
  failReason: Type.Union([Type.String(), Type.Null()]),
  queuedAt: Type.String(),
  sentAt: Type.Union([Type.String(), Type.Null()]),
  settledAt: Type.Union([Type.String(), Type.Null()]),
});

export const AlertDeliveriesResponseSchema = Type.Object({
  items: Type.Array(AlertDeliveryRowSchema),
  /** Pass as `before` for the next page; null when this page was the last. */
  nextBefore: Type.Union([Type.String(), Type.Null()]),
});

export type AlertDeliveryRow = Static<typeof AlertDeliveryRowSchema>;

const DEFAULT_LIMIT = 50;

export interface AlertDeliveriesFilter {
  readonly status: string;
  readonly limit: number;
  readonly before: string | null;
}

/** The injected ports: the cross-tenant reader and the platform audit writer (both over the pooled app db). */
export interface AdminAlertDeliveriesDeps {
  readonly list: (filter: AlertDeliveriesFilter) => Promise<readonly AlertDeliveryRow[]>;
  readonly audit: (entry: {
    readonly actorUserId: string;
    readonly filter: AlertDeliveriesFilter;
    readonly rowCount: number;
  }) => Promise<void>;
}

interface RawDeliveryRow {
  readonly delivery_id: string;
  readonly organization_id: string;
  readonly alert_id: string;
  readonly alert_category: string;
  readonly alert_severity: string;
  readonly channel: string;
  readonly status: string;
  readonly fail_reason: string | null;
  readonly queued_at: Date | string;
  readonly sent_at: Date | string | null;
  readonly settled_at: Date | string | null;
}

const iso = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : iso(v));

/** Production ports over the pooled app handle: the 0474 definer reader + the 0187 platform audit writer. */
export function buildAdminAlertDeliveriesDeps(db: DbClient): AdminAlertDeliveriesDeps {
  return {
    async list(filter) {
      const result = await db.execute(
        sql`SELECT * FROM messaging_admin_list_alert_deliveries(${filter.status}, ${filter.limit}, ${filter.before}::timestamptz)`,
      );
      const rows = (result as unknown as { rows?: readonly RawDeliveryRow[] }).rows ?? [];
      return rows.map((r) => ({
        deliveryId: r.delivery_id,
        organizationId: r.organization_id,
        alertId: r.alert_id,
        alertCategory: r.alert_category,
        alertSeverity: r.alert_severity,
        channel: r.channel,
        status: r.status,
        failReason: r.fail_reason,
        queuedAt: iso(r.queued_at),
        sentAt: isoOrNull(r.sent_at),
        settledAt: isoOrNull(r.settled_at),
      }));
    },
    async audit(entry) {
      await db.execute(sql`
        SELECT audit_writer_insert_platform_event(
          ${"messaging.admin.alert_deliveries.read"}, ${"notification_delivery"}, ${null}::uuid,
          ${"success"}, ${"info"}, ${`m36-admin-alert-deliveries:${entry.actorUserId}`},
          ${JSON.stringify({ actorUserId: entry.actorUserId, filter: entry.filter, rowCount: entry.rowCount })}::jsonb,
          ${"compliance"}
        )
      `);
    },
  };
}

/** Mount the route. Not tenant-scoped: there is deliberately no org context on this read. */
export function registerAdminAlertDeliveriesRoutes(
  app: FastifyInstance,
  deps: AdminAlertDeliveriesDeps,
): void {
  const guard = requireAbac(ADMIN_READ_KEY, ADMIN_PLATFORM_PREDICATE) as PreHandler;
  app.get("/api/v1/admin/messaging/alert-deliveries", { preHandler: [guard] }, async (request) => {
    const userId = request.context?.userId;
    if (!userId) throw new UnauthorizedError();
    const q = parse(AlertDeliveriesQuerySchema, request.query);
    if (q.before !== undefined && Number.isNaN(Date.parse(q.before))) {
      throw new ValidationError("request validation failed", [
        { field: "before", code: "INVALID", message: "before must be an ISO-8601 timestamp" },
      ]);
    }
    const filter: AlertDeliveriesFilter = {
      status: q.status ?? "failed",
      limit: q.limit ?? DEFAULT_LIMIT,
      before: q.before ?? null,
    };
    const items = await deps.list(filter);
    // Audit BEFORE release: a read that cannot be recorded must not be returned.
    await deps.audit({ actorUserId: userId, filter, rowCount: items.length });
    const last = items[items.length - 1];
    return {
      items,
      nextBefore: items.length === filter.limit && last ? last.queuedAt : null,
    };
  });
}

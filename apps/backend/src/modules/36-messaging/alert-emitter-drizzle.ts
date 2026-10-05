// apps/backend/src/modules/36-messaging/alert-emitter-drizzle.ts — GAP-096.
//
// The Drizzle-backed AlertEmitterPorts the M36-T04 resolution/fan-out engine (`createAlertEmitter`,
// @wardenx/messaging) composes over in production. Before this file, `registerMessagingSeams` never
// received `emitter:`, so it always fell back to `createInMemoryAlertEmitter()` — every alert emitted
// platform-wide ran in a per-process in-memory engine: no `alert`/`notification_delivery` row was ever
// written, and state never survived a restart or a second instance.
//
// TENANCY: mirrors `messaging-route-service-db.ts`'s established `withOrgContext(db, {organizationId,
// userId: ""}, fn)` pattern for every write; `alert_rule`/`user_notification_preferences` reads use the
// SAME pattern (RLS admits both the caller's own-org rows and the NULL-organization_id platform-default
// rows per their own `_read` policies, so a plain per-call withOrgContext is sufficient — no ambient
// request context needed, since `emit()` may run from a background consumer as often as a request).
//
// RECIPIENT SOURCES: `careTeamMembers`/`onCallMembers` bind the REAL M5/M19 seams (`CareTeamProvider`
// GAP-059, `OnCallProvider` already real at boot) — M36 dependsOn [1,2,3,4], so it reaches these only
// through `getSeam`, never a direct import. `roleSetMembers`/`tenantAdmins`/`orgMembers` are plain
// Drizzle joins over the M1/M3-owned `membership`/`membership_role`/`role` tables (M36 dependsOn 1,3 —
// no seam needed, mirrors GAP-021's M13 witness-facts membership_role→role join precedent).
// `tenantAdmins` mirrors `createDbAdminMembershipReader`'s real query (@wardenx/auth) — role key
// `org_admin`, enabled, non-expired grant — rather than re-importing it, since this store needs the
// membership's userId in the same query, not just the membershipId that reader returns.
//
// `disciplineMembers` REFUSES (DegradedError) rather than silently answering `[]`: M36's foundation
// tier has no clinical-discipline vocabulary to query (the only real one, M17's
// `membership_credential.credential_type`, GAP-093, is gated behind a dependsOn edge M36 does not
// have, and no platform-default alert_rule uses the `discipline` resolver today). A silent `[]` would
// make a tenant-configured `discipline` rule notify NOBODY forever with no error — the exact
// WIRED-but-fake-predicate trap GAP-020 already taught this codebase to avoid.
import { roleConfersKey } from "@wardenx/auth";
import { type DbClient, schema } from "@wardenx/db";
import type {
  AlertEmitter,
  AlertEmitterPorts,
  EmitAlertRule,
  PersistedAlert,
  QuietHoursConfig,
  RecipientPreferences,
  RecipientSourcePorts,
  ResolverArgs,
  RoutingMap,
} from "@wardenx/messaging";
import {
  type AlertCategory,
  type AlertRecipientResolver,
  type AlertSeverity,
  type NotificationChannel,
  createAlertEmitter,
  rollUpAlertOutcome,
  selectEffectiveAlertRules,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { DegradedError } from "@wardenx/types";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** Mirrors `createDbAdminMembershipReader`'s role key (@wardenx/auth's `ORG_ADMIN_ROLE_KEY`) — kept as
 *  its own local constant since that one isn't exported, and this query needs `membership.userId`
 *  directly rather than the membershipId that reader returns. */
const ORG_ADMIN_ROLE_KEY = "org_admin";

function toEmitAlertRule(r: typeof schema.alertRules.$inferSelect): EmitAlertRule {
  return {
    category: r.category as AlertCategory,
    severityFloor: r.severityFloor as AlertSeverity,
    recipientResolver: r.recipientResolver as AlertRecipientResolver,
    resolverArgs: r.resolverArgs as ResolverArgs,
    channelsOverride: r.channelsOverride as readonly NotificationChannel[] | null,
  };
}

function buildRecipientPorts(db: DbClient): RecipientSourcePorts {
  const MR = schema.membershipRoles;
  const R = schema.roles;
  const M = schema.memberships;

  const activeMembershipUserIds = (orgId: string, roleKeys: readonly string[]) =>
    withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx: Tx) => {
      if (roleKeys.length === 0) return [] as string[];
      // GAP-096 — a tenant-owned row carrying a reserved platform key (e.g. a legacy
      // `platform_security_owner`) confers nothing, so it must not pull a tenant user into a platform
      // alert either: the same `roleConfersKey` rule the enrichment reader applies.
      const rows = await tx
        .selectDistinct({
          userId: M.userId,
          organizationId: R.organizationId,
          key: R.key,
          category: R.category,
        })
        .from(MR)
        .innerJoin(R, eq(R.id, MR.roleId))
        .innerJoin(M, eq(M.id, MR.membershipId))
        .where(
          and(
            eq(MR.organizationId, orgId),
            inArray(R.key, roleKeys as string[]),
            eq(R.enabled, true),
            eq(M.status, "active"),
            or(isNull(MR.expiresAt), gt(MR.expiresAt, new Date())),
          ),
        );
      return [...new Set(rows.filter(roleConfersKey).map((r) => r.userId))];
    });

  return {
    async careTeamMembers(orgId, patientId) {
      return getSeam("CareTeamProvider").careTeamMembers({ organizationId: orgId, patientId });
    },
    async onCallMembers(orgId, providerEntityId) {
      const actors = await getSeam("OnCallProvider").currentOnCallActors(
        orgId,
        providerEntityId,
        new Date().toISOString(),
      );
      // `external_vendor` actors are structurally incapable of resolving to a user id (the type's own
      // discriminated-union design, packages/types/src/oncall.ts) — a vendor-covered shift correctly
      // yields no in-app/push/sms recipient here (the vendor's own channel covers it separately).
      return actors.filter((a) => a.kind === "membership").map((a) => a.userId);
    },
    async disciplineMembers(): Promise<readonly string[]> {
      throw new DegradedError(
        "m36-alert-recipients",
        "disciplineMembers has no bound discipline vocabulary at M36's foundation tier " +
          "(dependsOn [1,2,3,4] only) — no platform-default alert_rule uses the discipline " +
          "resolver; a tenant-configured rule naming it refuses loudly rather than silently " +
          "resolving to nobody",
      );
    },
    async roleSetMembers(orgId, roleKeys) {
      return activeMembershipUserIds(orgId, roleKeys);
    },
    async tenantAdmins(orgId) {
      return activeMembershipUserIds(orgId, [ORG_ADMIN_ROLE_KEY]);
    },
    async orgMembers(orgId) {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx: Tx) => {
        const rows = await tx
          .selectDistinct({ userId: M.userId })
          .from(M)
          .where(and(eq(M.organizationId, orgId), eq(M.status, "active")));
        return rows.map((r) => r.userId);
      });
    },
  };
}

/** Build the real {@link AlertEmitterPorts} over `db` (GAP-096). */
export function createDrizzleAlertEmitterPorts(db: DbClient): AlertEmitterPorts {
  const AR = schema.alertRules;
  const AL = schema.alerts;
  const ND = schema.notificationDeliveries;

  return {
    recipients: buildRecipientPorts(db),

    async rulesFor(orgId, eventType) {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx: Tx) => {
        const rows = await tx
          .select()
          .from(AR)
          .where(
            and(
              eq(AR.eventType, eventType),
              eq(AR.enabled, true),
              or(isNull(AR.organizationId), eq(AR.organizationId, orgId)),
            ),
          );
        // A tenant's own row for an eventType REPLACES the platform default (the clone-on-first-edit
        // model — the platform row is never deleted, just shadowed); every org row is kept so multiple
        // tenant-configured severity tiers for one event all fire. GAP-102: against a system_locked
        // platform rule an org row only counts if it TIGHTENS it (spec §7.4/D11) — a weaker row (legacy
        // data written before migration 0334) is ignored and the locked platform rule fires instead.
        return selectEffectiveAlertRules(rows, orgId).map(toEmitAlertRule);
      });
    },

    async preferencesFor(orgId, userIds) {
      const map = new Map<string, RecipientPreferences>();
      if (userIds.length === 0) return map;
      // `user_notification_preferences`'s own RLS is keyed on app.user_id, not app.org_id — "the
      // user's own rows only" (migration 0017), so no per-request wardenx_app session can ever read a
      // SECOND user's row. This calls migration 0194's SECURITY DEFINER cross-user reader instead of a
      // plain Drizzle select (confirmed live: the plain-select version failed with "invalid input
      // syntax for type uuid: ''" the moment more than the system-actor sentinel was in scope). Mirrors
      // getPreferences's established read shape otherwise (own-org row only — no NULL-org
      // cross-tenant-default fallback; a user with no row here gets the in-app floor, per this port's
      // own doc comment).
      const result = await db.execute<{
        user_id: string;
        routing_map: RoutingMap;
        quiet_hours: QuietHoursConfig;
        vacation_forward_to_user_id: string | null;
        vacation_until: string | null;
      }>(sql`
        SELECT * FROM user_notification_preferences_for_org_users(
          ${orgId},
          ${JSON.stringify(userIds)}::jsonb
        )
      `);
      for (const r of result.rows) {
        map.set(r.user_id, {
          userId: r.user_id,
          routingMap: r.routing_map,
          quietHours: r.quiet_hours,
          vacationForwardToUserId: r.vacation_forward_to_user_id,
          // db.execute() (raw query) does NOT apply Drizzle's column-type deserialization the way
          // .select().from(table) does — timestamptz comes back as a string here, confirmed live
          // ("prefs.vacationUntil.getTime is not a function"), the SAME db.execute-returns-strings
          // gotcha WX-PR-024 hit for withPlatformContext.
          vacationUntil: r.vacation_until === null ? null : new Date(r.vacation_until),
        });
      }
      return map;
    },

    async persist(record: PersistedAlert): Promise<{ alertId: string; occurrences?: number }> {
      return withOrgContext(db, { organizationId: record.orgId, userId: "" }, async (tx: Tx) => {
        // F-199 — count an absorbed repeat. ONE atomic `UPDATE … RETURNING`: concurrent repeats serialize on the
        // row lock and each RETURNS a distinct count, so exactly one caller ever sees any given value (the escalation
        // in M29 keys on "count == threshold"). A repeat pages NOBODY — no delivery rows are written for it.
        const bump = async (alertId: string): Promise<{ alertId: string; occurrences: number }> => {
          const res = await tx.execute<{ occurrences: number }>(sql`
            UPDATE alert
               SET payload = jsonb_set(payload, '{occurrences}',
                     to_jsonb(COALESCE((payload->>'occurrences')::int, 1) + 1))
             WHERE id = ${alertId}
         RETURNING (payload->>'occurrences')::int AS occurrences
          `);
          const occurrences = Number(res.rows[0]?.occurrences);
          if (!Number.isInteger(occurrences))
            throw new Error("alert occurrence bump returned no row");
          return { alertId, occurrences };
        };

        const [existing] = await tx
          .select({ id: AL.id })
          .from(AL)
          .where(
            and(eq(AL.organizationId, record.orgId), eq(AL.correlationId, record.correlationId)),
          )
          .limit(1);
        if (existing) return record.countRepeats ? bump(existing.id) : { alertId: existing.id };

        // F-109 — the §2.4.3 outcome is WRITTEN, not defaulted. The column used to be
        // `NOT NULL DEFAULT 'delivered'` and no code path ever set it, so every alert in every database
        // asserted successful delivery while every one of its `notification_delivery` children sat
        // `pending` forever. The roll-up settles a plan that is already terminal — most importantly the
        // EMPTY one: `emit()` writes a no-op alert when no `alert_rule` fires, and "delivered to the zero
        // people it reached" was the single most misleading value this column carried.
        const outcome = rollUpAlertOutcome(record.deliveries);
        const [row] = await tx
          .insert(AL)
          .values({
            organizationId: record.orgId,
            eventType: record.eventType,
            severity: record.severity,
            // F-199 — a counted alert is born with `occurrences: 1`; `bump` increments it from there.
            payload: record.countRepeats ? { ...record.payload, occurrences: 1 } : record.payload,
            correlationId: record.correlationId,
            outcome,
          })
          .onConflictDoNothing({ target: [AL.organizationId, AL.correlationId] })
          .returning({ id: AL.id });
        if (!row) {
          const [raced] = await tx
            .select({ id: AL.id })
            .from(AL)
            .where(
              and(eq(AL.organizationId, record.orgId), eq(AL.correlationId, record.correlationId)),
            )
            .limit(1);
          if (raced) return record.countRepeats ? bump(raced.id) : { alertId: raced.id };
          throw new Error("alert insert returned no row");
        }
        if (record.deliveries.length > 0) {
          await tx.insert(ND).values(
            record.deliveries.map((d) => ({
              alertId: row.id,
              recipientUserId: d.recipientUserId,
              forwardedFromUserId: d.forwardedFromUserId,
              alertCategory: d.alertCategory,
              alertSeverity: d.alertSeverity,
              channel: d.channel,
              status: d.status,
            })),
          );
        }
        return { alertId: row.id };
      });
    },

    now: () => new Date(),
  };
}

/** Build the real production {@link AlertEmitter} (GAP-096). */
export function createDrizzleAlertEmitter(db: DbClient): AlertEmitter {
  return createAlertEmitter(createDrizzleAlertEmitterPorts(db));
}

/** Resolve a membership id to its ACTIVE user id within `orgId` (or null when unknown / not active). Used by outbox
 *  consumers that must put a per-event audience member's USER id on an alert payload (the `role_set.userIdPaths`
 *  audience, e.g. the IDG carry-forward compliance alert's meeting coordinator). Org-explicit + `withOrgContext`:
 *  it runs in the relay, not a request. */
export function createDrizzleMembershipUserLookup(
  db: DbClient,
): (organizationId: string, membershipId: string) => Promise<string | null> {
  const M = schema.memberships;
  return (organizationId, membershipId) =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx: Tx) => {
      const [row] = await tx
        .select({ userId: M.userId })
        .from(M)
        .where(
          and(eq(M.id, membershipId), eq(M.organizationId, organizationId), eq(M.status, "active")),
        )
        .limit(1);
      return row?.userId ?? null;
    });
}

/** The permission keys that make a member an EXPECTED attendee of an IDG meeting: the participation key
 *  (`idg.attend`, CoP 418.56(a)(1)) and the coordinator key (`idg.coordinate`). Real M14 keys (M14 §4.6). */
const IDG_ATTENDEE_PERMISSION_KEYS = ["idg.attend", "idg.coordinate"] as const;

/** "Which memberships hold ANY of these permission keys through an enabled, unexpired role?" — M3's answer
 *  (`createMembershipsHoldingPermissionReader`), injected at the composition root: `role_permission` is an M3 table, so
 *  M36 never reads it (check-table-ownership) and declares the port locally. */
export type MembershipsHoldingPermissionPort = (
  organizationId: string,
  permissionKeys: readonly string[],
) => Promise<ReadonlySet<string>>;

/** The expected attendees of an IDG meeting at `locationId` — M14 has no invitee roster (`idg_attendance` rows are
 *  check-ins from START on), so the roster is DERIVED: every ACTIVE member holding `idg.attend` or `idg.coordinate`
 *  (M3's holders, via `holders`) whose location scope (`membership.default_location_ids`, what the
 *  `idg_meeting_scope` predicate reads) contains the meeting's location. Returns membership + user ids, ordered.
 *  Org-explicit + `withOrgContext` (relay, not a request); reads only the M1/M2 `membership` table itself. */
export function createDrizzleIdgAttendeeLookup(
  db: DbClient,
  holders: MembershipsHoldingPermissionPort,
): (
  organizationId: string,
  locationId: string,
) => Promise<readonly { membershipId: string; userId: string }[]> {
  const M = schema.memberships;
  return async (organizationId, locationId) => {
    const holding = await holders(organizationId, IDG_ATTENDEE_PERMISSION_KEYS);
    if (holding.size === 0) return [];
    return withOrgContext(db, { organizationId, userId: "" }, async (tx: Tx) => {
      const rows = await tx
        .select({ membershipId: M.id, userId: M.userId })
        .from(M)
        .where(
          and(
            eq(M.organizationId, organizationId),
            eq(M.status, "active"),
            inArray(M.id, [...holding]),
            sql`${M.defaultLocationIds} @> ${JSON.stringify([locationId])}::jsonb`,
          ),
        );
      return [...rows].sort((a, b) => a.membershipId.localeCompare(b.membershipId));
    });
  };
}

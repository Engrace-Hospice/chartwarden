// apps/backend/src/modules/36-messaging/routes/global-search-settings-typebox.ts - WP 2.7b C4 route schemas for the tenant
// global search switch. Named `*-typebox` so the table-ownership import heuristic never mistakes it for Drizzle.
import { Type } from "@sinclair/typebox";

export const PutGlobalSearchSettingsBodySchema = Type.Object(
  {
    enabled: Type.Boolean(),
    // F5: required when `enabled` is true (checked by the service so a missing/stale value is a typed 409, not a schema 400).
    acknowledgedNoticeVersion: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);

const NullableTimestamp = Type.Union([Type.String(), Type.Null()]);

export const GlobalSearchSettingsViewSchema = Type.Object({
  enabled: Type.Boolean(),
  changedAt: NullableTimestamp,
  purgeRequestedAt: NullableTimestamp,
  purgeCompletedAt: NullableTimestamp,
  checklist: Type.Object({
    platformEnabled: Type.Boolean(),
    legacyBodiesMigrated: Type.Boolean(),
    escrowAttested: Type.Boolean(),
    leakageAttested: Type.Boolean(),
    rateLimitActive: Type.Boolean(),
    excludedMembersCleared: Type.Boolean(),
  }),
  notice: Type.Object({ version: Type.String(), text: Type.String() }),
  noticeAcknowledgement: Type.Union([
    Type.Object({ version: Type.String(), byUserId: Type.String(), at: Type.String() }),
    Type.Null(),
  ]),
  rebuild: Type.Union([
    Type.Object({
      keyVersion: Type.String(),
      status: Type.Union([Type.Literal("building"), Type.Literal("ready"), Type.Literal("stale")]),
      checkpointCreatedAt: NullableTimestamp,
      reconciledAt: NullableTimestamp,
      changedAt: NullableTimestamp,
      effectiveReady: Type.Boolean(),
    }),
    Type.Null(),
  ]),
});

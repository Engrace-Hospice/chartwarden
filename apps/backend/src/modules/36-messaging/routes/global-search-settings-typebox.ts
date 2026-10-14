// apps/backend/src/modules/36-messaging/routes/global-search-settings-typebox.ts - WP 2.7b C4 route schemas for the tenant
// global search switch. Named `*-typebox` so the table-ownership import heuristic never mistakes it for Drizzle.
import { Type } from "@sinclair/typebox";

export const PutGlobalSearchSettingsBodySchema = Type.Object(
  { enabled: Type.Boolean() },
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
  }),
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

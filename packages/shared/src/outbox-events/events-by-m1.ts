// @wardenx/shared — M1 Foundation's outbox-event contributions (spec §3.17.1).
//
// M1 owns the platform broadcast events keyed on its own tables (system_status,
// feature_flag). Each event name follows the `mN.<resource>.<verb>` convention under
// M1's `m1.` namespace (M01 D8 / M03 D9) — check-fitness-gaps.ts scans this file for
// naming + ownership + valid consumers. Both are NOT outbox-only: M1 also pushes them
// over Socket.IO (degraded-mode banner / live flag refresh, §4.8), but they are
// registered in the catalog so the dispatcher validates their payloads (W-M1-11).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

export const M1_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m1.system_status.changed",
    moduleOwner: "m1",
    description:
      "Platform/tenant system-status transition (operational → degraded → outage); broadcast to all affected tenant clients (spec §4.8 / §376).",
    payloadSchema: Type.Object({
      // null organizationId = platform-wide status; otherwise a single tenant.
      // (String `format` constraints — uuid/date-time — are deferred until the platform
      // registers TypeBox formats centrally; minLength keeps validation deterministic now.)
      organizationId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      component: Type.String({ minLength: 1 }),
      fromStatus: Type.String({ minLength: 1 }),
      toStatus: Type.String({ minLength: 1 }),
      changedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [], // broadcast to all tenant clients — no single module consumer
    isOutboxOnly: false,
  },
  {
    eventName: "m1.feature_flag.updated",
    moduleOwner: "m1",
    description:
      "Feature-flag value changed for a tenant; broadcast to the org room for live UI refresh (spec §4.8 / §2520).",
    payloadSchema: Type.Object({
      organizationId: Type.String({ minLength: 1 }),
      key: Type.String({ minLength: 1 }),
      value: Type.Unknown(),
    }),
    declaredConsumers: [], // broadcast to the org room — no single module consumer
    isOutboxOnly: false,
  },
];

// apps/backend/src/modules/03-authorization/events-by-m3.ts — M3's transactional-outbox event catalog
// contribution (GAP-010; M3 spec §4.5 / M03-F04).
//
// Before this file M3 published NONE of its spec'd outbox events: `m3.*` names existed only as M4 AUDIT
// actions, and the break-glass "Compliance notified" guarantee (§7.4) was an in-memory array nothing
// read. The §4.5 outbox table names five events, emitted "in the same transaction as the state change":
//
//   • m3.breakglass.invoked — critical. Delivered to M36's alert rules (`consumers/breakglass-alert.ts`
//     in M36 hands it to the AlertEmitter; the platform-default `alert_rule` routes it to
//     compliance_officer with an org_admin backstop). M3 never writes M36's `alert.new` directly (SD-017).
//   • m3.breakglass.ended — revoke (and, when the reaper lands, expiry). Record-only.
//   • m3.role.assigned / m3.role.revoked — record-only; M2's invitation-accept attach is the other
//     producer of `m3.role.assigned`.
//   • m3.engagement.closed — REGISTERED, NOT YET PUBLISHED: the auditor-engagement store is still
//     in-memory (GAP-011), so there is no state change to hang the event on. Registering it now means
//     GAP-011 only has to add the publish.
//
// NO PHI / NO FREE TEXT: payloads carry ids and flags only. The invoker's free-text `reason` is in the
// audit row (which has the field denylist) and deliberately NOT here — an outbox row has no such
// protection. `targetPatientId` is a reference, not a patient record.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });

export const M3_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m3.breakglass.invoked",
    moduleOwner: "m3",
    description:
      "A break-glass emergency-access grant was opened (critical). Published in the invoke's own transaction; M36's alert rule notifies the Compliance Officer.",
    payloadSchema: Type.Object({
      breakGlassId: id,
      organizationId: id,
      actorUserId: id,
      targetPatientId: Type.Union([id, Type.Null()]),
      expiresAt: isoInstant,
      cosignRequired: Type.Boolean(),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m3.breakglass.ended",
    moduleOwner: "m3",
    description:
      "A break-glass grant ended before its time-box ran out (revoked). Record-only: the revoke is already audited.",
    payloadSchema: Type.Object({
      breakGlassId: id,
      organizationId: id,
      outcome: Type.Union([Type.Literal("revoked"), Type.Literal("expired")]),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m3.role.assigned",
    moduleOwner: "m3",
    description: "A role was granted on a membership (M3 assign route or M2 invitation accept).",
    payloadSchema: Type.Object({
      organizationId: id,
      membershipId: id,
      roleId: id,
      roleKey: id,
      grantedByUserId: Type.Union([id, Type.Null()]),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m3.role.revoked",
    moduleOwner: "m3",
    description: "A role grant was removed from a membership.",
    payloadSchema: Type.Object({
      organizationId: id,
      membershipId: id,
      roleId: id,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m3.engagement.closed",
    moduleOwner: "m3",
    description:
      "An auditor engagement reached end_at and was closed by the authz.close_engagements cron (GAP-011).",
    payloadSchema: Type.Object({
      engagementId: id,
      organizationId: id,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
];

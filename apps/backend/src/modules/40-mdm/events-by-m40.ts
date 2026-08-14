// apps/backend/src/modules/40-mdm/events-by-m40.ts — Module 40's outbox-event contributions
// (M40 §7.11, added by GAP-099).
//
// WHY THIS FILE ONLY APPEARS NOW. M40's canonical tables were read-only until the GAP-099
// `mdm_canonical_writer_*` functions (migration 0202) landed — there was no write for an event to
// announce. The §4.7 NPPES appliers are the first thing that mutates a canonical, so `m40.canonical_updated`
// is M40's first outbox event.
//
// PLATFORM-WIDE. Every canonical is org-less master data (§2.3: the same answer for every tenant), so a
// change to one belongs to no organization and publishes with `organizationId: null` through the
// migration-0186 SECURITY DEFINER insert — the same shape M29's `m29.nppes.*` events use.
//
// `declaredConsumers: []` — RECORD-ONLY, and deliberately so. §7.11 describes the event as the signal for
// downstream caches to refresh, but no module subscribes to it today: M23's `mdm.canonical_updated` topic
// string (23-billing-medicare/consumers/subscription-map.ts) is a different, older name in a different
// namespace and is not bound to this catalog. Declaring a consumer that does not exist would hold every
// row `pending` on the deferred clock forever; declaring none means the row IS the durable record and
// dispatches immediately. When a real consumer lands it adds itself here in the same diff that binds it.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

export const M40_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m40.canonical.updated",
    moduleOwner: "m40",
    description:
      "A canonical master-data record changed (§7.11) — today only the physician canonical, written by the §4.7.1 NPPES minimum-update applier. Carries the entity kind, its canonical id and the fields that actually changed, so a downstream cache can invalidate precisely rather than wholesale.",
    payloadSchema: Type.Object({
      kind: Type.Literal("physician"),
      canonicalId: Type.String({ minLength: 1 }),
      changedFields: Type.Array(Type.String({ minLength: 1 })),
      source: Type.Literal("m29_platform_sync"),
      updatedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m40.canonical.deactivated",
    moduleOwner: "m40",
    description:
      "A canonical physician was flipped to `deactivated` because NPPES reported the NPI deactivated (§4.7.2 — death, license revocation). Record-only; the per-tenant consequence is the M36 alert the applier fans out to every org whose overlay marked the provider preferred.",
    payloadSchema: Type.Object({
      kind: Type.Literal("physician"),
      canonicalId: Type.String({ minLength: 1 }),
      npi: Type.String({ minLength: 10, maxLength: 10 }),
      deactivationDate: Type.String({ minLength: 1 }),
      deactivationReason: Type.String({ minLength: 1 }),
      alertedOrganizationIds: Type.Array(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
];

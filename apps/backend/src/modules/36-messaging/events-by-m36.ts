// apps/backend/src/modules/36-messaging/events-by-m36.ts — M36's transactional-outbox event catalog
// contribution (§8.1.2, #205 hard-half follow-up).
//
// M36 contributed NO event catalog at all until this file (alongside M2 and M28, all now closed) — no
// `M36_OUTBOX_EVENTS` anywhere in the repo and no entry in `buildBootOutboxCatalog([...])`. The spec
// (§8.1.2) declares exactly ONE consumer-facing outbox event: `m36.notification.delivery_failed`, fired
// when a `notification_delivery` row settles to a terminal failed status after retries are exhausted
// (§2.4.4 D7). Everything else in §8.1/§8.1.1/§8.1.2 (`alert.fired`, `alert.delivered`,
// `m36.alert.dispatched`, `m36.integrity.hash_mismatch`, …) is an M4 AUDIT action or an M36-internal
// observability event, not a cross-module outbox contract — deliberately not catalogued here.
//
// THE PAYLOAD IS NOW REAL, NOT FORWARD-DECLARED — reconciled against what the three waiting consumers
// actually need, not just the spec's own narrower shape (`{notificationId, recipientMembershipId,
// organizationId, channel, failureReason, failedAt}`). M19's `consumers/m36-delivery-failed.ts` (the
// richest of the three) needed `recipientKind`, `providerEntityId` and a way to name the alert this
// delivery was FOR; M20's needs the same "which alert was this about" fact for its own domain. Rather than
// invent a per-module field (`triageCallId` here, `sosAlertId` there — the exact drift this catalog exists
// to prevent), the payload carries `alertEventType` (the `mN.*` alert eventType M36 was delivering) and
// `sourceAggregateId` (the id of the domain entity that alert was ABOUT, read out of `alert.payload` at
// the eventual producer) — a consumer interprets `sourceAggregateId` in its own domain, gated on
// `alertEventType`'s `mN.` prefix being its own, exactly as `declaredConsumers` below already gates who is
// allowed to act on the event at all.
//
// NO PRODUCER EXISTS YET, AND THAT IS A SEPARATE, LARGER, DECLARED ABSENCE — not this catalog's job to
// close. `notification_delivery.status` is never written `'failed'` anywhere in the codebase:
// `packages/messaging/src` has queue *descriptors* for send_push/send_sms/send_voice/send_email/
// delivery_reconcile (§4.4, jobs/queues.ts) but no Worker/Queue construction, no `dispatchers/` directory,
// no Twilio/Postmark/push adapter, and the webhook routes that would reconcile vendor delivery callbacks
// have no `MessagingWebhookService` behind them (a separately registered `route-reachability` deferral).
// Building that out-of-band dispatch + reconciliation pipeline is its own multi-part project, not a
// continuation of the M2/M28/M36 catalog-gap pattern — this catalog entry, and the two real consumer
// bindings it makes possible (M19, M20 — see their `consumers/`), are what a producer will satisfy the
// moment that pipeline lands, rather than an undeclared name a producer would need to invent too.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);
const isoInstant = Type.String({ minLength: 1 });
const recipientKind = Type.Union([
  Type.Literal("on_call"),
  Type.Literal("role_set"),
  Type.Literal("care_team"),
  Type.Literal("individual"),
  Type.Literal("other"),
]);
const channel = Type.Union([
  Type.Literal("in_app"),
  Type.Literal("push"),
  Type.Literal("sms"),
  Type.Literal("email"),
  Type.Literal("voice"),
]);

export const M36_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m36.notification.delivery_failed",
    moduleOwner: "m36",
    description:
      "A notification_delivery row settled to a terminal failed status after D7 retries were exhausted — an alert a consumer requested could not be delivered to a recipient on a given channel. PHI-free by construction (ids + failure class only). NO PRODUCER YET — see this file's header; the out-of-band dispatch pipeline that would settle a delivery to 'failed' is unbuilt.",
    payloadSchema: Type.Object({
      notificationId: id,
      organizationId: id,
      channel,
      failureReason: id,
      failedAt: isoInstant,
      recipientKind,
      recipientMembershipId: nullableId,
      providerEntityId: nullableId,
      /** The `mN.*` alert eventType M36 was delivering (e.g. `m19.triage.case_opened`), or null when the
       *  failed delivery had no source alert (a direct-dial or ad-hoc notification). */
      alertEventType: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      /** The id of the domain entity `alertEventType` was ABOUT — interpreted by the consumer named in
       *  `alertEventType`'s `mN.` prefix; meaningless to any other consumer. */
      sourceAggregateId: nullableId,
    }),
    // F-160 (#248) — m26 ADDED: M26's own `M26_SUBSCRIPTION_MAP` routes this topic to
    // `surface-stuck-alert` (`dispatchM26UpstreamEvent`'s real switch arm, now live-bound in
    // `26-cap/consumers/outbox-binding.ts`'s `BOUND_TOPICS`). The handler is a documented no-op today
    // (operational surfacing only, no ledger effect) and this event still has no real producer (see
    // this file's header) — binding it does not make a delivery observable yet, it only makes the
    // catalog/binding agreement true instead of false.
    declaredConsumers: ["m19", "m20", "m26"],
    isOutboxOnly: true,
  },
];

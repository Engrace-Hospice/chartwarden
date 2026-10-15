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
// THE PRODUCER (GAP-101): `delivery/delivery-settlement.ts` publishes this event, in the same transaction that
// settles a `notification_delivery` row `failed` — from the out-of-band dispatcher (retries exhausted, a
// non-retryable vendor refusal, no verified endpoint, or the fail-closed `transport_not_configured` deny-stub)
// and from the vendor-webhook reconcile (Twilio `undelivered`/`failed`, Postmark `Bounce`/`SpamComplaint`).
// `recipientKind` is read from the alert's `alert_rule` resolver; `recipientMembershipId` is null (the delivery
// row carries the user id, not the membership); `providerEntityId` / `sourceAggregateId` are read from
// `alert.payload` when the emitting module put them there, else null.
import { type TSchema, Type } from "@sinclair/typebox";
import {
  CHART_PROMOTION_TARGET_KINDS,
  CHART_PROMOTION_TARGET_MODULES,
  HANDOFF_UNACCEPTED_CAUSES,
  MEDICATION_QUESTION_UNROUTED_REASONS,
  type ModuleEventContribution,
  TASK_STATUSES,
} from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);
const isoInstant = Type.String({ minLength: 1 });
const handoffCause = Type.Union(HANDOFF_UNACCEPTED_CAUSES.map((cause) => Type.Literal(cause)));
const medicationQuestionReason = Type.Union(
  MEDICATION_QUESTION_UNROUTED_REASONS.map((reason) => Type.Literal(reason)),
);
const promotionTargetModule = Type.Union(
  CHART_PROMOTION_TARGET_MODULES.map((module) => Type.Literal(module)),
);
const promotionTargetKind = Type.Union(
  CHART_PROMOTION_TARGET_KINDS.map((kind) => Type.Literal(kind)),
);
const count = Type.Integer({ minimum: 0 });
const taskStatus = Type.Union(TASK_STATUSES.map((status) => Type.Literal(status)));
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

// WP 4.2 (ADR-0069): the acknowledgment-request lifecycle. PHI-free: ids, the class enum, the request version and one instant - no
// patient id, no name, no text. Each is published in the same transaction as the transition; an idempotent repeat publishes nothing.
const ackClass = Type.Union([
  Type.Literal("important"),
  Type.Literal("urgent"),
  Type.Literal("critical_symptom"),
]);
const ackPayload = (extra: Record<string, TSchema> = {}) =>
  Type.Object(
    {
      organizationId: id,
      requestId: id,
      messageId: id,
      channelId: id,
      ackClass,
      assignedUserId: id,
      actorUserId: nullableId,
      requestVersion: Type.Integer({ minimum: 0 }),
      at: isoInstant,
      ...extra,
    },
    { additionalProperties: false },
  );
const ackEntry = (
  eventName: `m36.ack.${string}`,
  description: string,
  declaredConsumers: readonly `m${number}`[],
  extra?: Record<string, TSchema>,
) => ({
  eventName,
  moduleOwner: "m36" as const,
  description,
  payloadSchema: ackPayload(extra),
  declaredConsumers,
  isOutboxOnly: true,
});
const ACK_EVENT_ENTRIES = [
  ackEntry(
    "m36.ack.requested",
    "One qualified colleague was asked to take clinical responsibility for a message (WP 4.2, ADR-0069). Created with an urgent message (same transaction) or for an important one by its author. M36 tells the assignee in-app for the important class (an urgent message already has its own alert). Not a page, not the emergency path.",
    ["m36"],
  ),
  ackEntry(
    "m36.ack.acknowledged",
    "The assigned clinician took clinical responsibility by an explicit action (WP 4.2). Opening or reading never produces this. No consumer yet: telling the sender arrives with the supervisor and queue screens (WP 4.9).",
    [],
  ),
  ackEntry(
    "m36.ack.reassigned",
    "A request moved to a new assignee; the window restarted, the original request time was kept (WP 4.2). M36 tells the new assignee in-app.",
    ["m36"],
    { previousAssignedUserId: id },
  ),
  ackEntry(
    "m36.ack.resolved",
    "The assigned clinician closed an acknowledged request (WP 4.2). No consumer yet (WP 4.9).",
    [],
  ),
  ackEntry(
    "m36.ack.cancelled",
    "A request was withdrawn because its message was deleted (WP 4.2). No consumer yet (WP 4.9).",
    [],
  ),
];

export const M36_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m36.message.sent",
    moduleOwner: "m36",
    description:
      "A message was committed to a channel. PHI-free realtime hint source (ADR-0054): ids and one timestamp only. Published in the same transaction as the write; the realtime consumer turns it into a Socket.IO hint and the client re-reads over REST.",
    payloadSchema: Type.Object({
      organizationId: id,
      channelId: id,
      messageId: id,
      parentMessageId: Type.Optional(id),
      at: isoInstant,
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.message.edited",
    moduleOwner: "m36",
    description:
      "A message body was edited. PHI-free realtime hint source (ADR-0054): ids and one timestamp only. Published in the same transaction as the write; the realtime consumer turns it into a Socket.IO hint and the client re-reads over REST.",
    payloadSchema: Type.Object({
      organizationId: id,
      channelId: id,
      messageId: id,
      parentMessageId: Type.Optional(id),
      at: isoInstant,
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.message.deleted",
    moduleOwner: "m36",
    description:
      "A message was soft-deleted (tombstoned). PHI-free realtime hint source (ADR-0054): ids and one timestamp only. Published in the same transaction as the write; the realtime consumer turns it into a Socket.IO hint and the client re-reads over REST.",
    payloadSchema: Type.Object({
      organizationId: id,
      channelId: id,
      messageId: id,
      parentMessageId: Type.Optional(id),
      at: isoInstant,
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.message.annotated",
    moduleOwner: "m36",
    description:
      "A message's reactions or pin changed (WP 2.4). PHI-free realtime hint source (ADR-0054): ids and one timestamp only - not which emoji, not who. Published in the same transaction as the write; the realtime consumer turns it into a Socket.IO hint and the client re-reads over REST. A reaction is not a sign-off and this event is never a delivery or read signal.",
    payloadSchema: Type.Object({
      organizationId: id,
      channelId: id,
      messageId: id,
      parentMessageId: Type.Optional(id),
      at: isoInstant,
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.message.mentioned",
    moduleOwner: "m36",
    description:
      "A structured staff reference was committed with a secure message. The PHI-free payload contains ids only; M36 revalidates current channel access before creating one in-app alert.",
    payloadSchema: Type.Object({
      organizationId: id,
      channelId: id,
      messageId: id,
      mentionedUserId: id,
      actorUserId: id,
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.task.created",
    moduleOwner: "m36",
    description:
      "A communication task was created from a message (WP 3.4). PHI-free: ids and one instant - no patient id, no message text. Published in the same transaction as the insert; an idempotent replay publishes nothing. M36 turns it into one generic in-app alert for the assignee after re-checking channel access.",
    payloadSchema: Type.Object(
      {
        organizationId: id,
        taskId: id,
        messageId: id,
        channelId: id,
        assigneeUserId: id,
        createdByUserId: id,
        at: isoInstant,
      },
      { additionalProperties: false },
    ),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.task.reassigned",
    moduleOwner: "m36",
    description:
      "A communication task changed assignee (WP 3.4), by a person, by offboarding or by a supervisor review decision (WP 3.8). PHI-free: ids, the source enum and one instant. M36 tells the new assignee with one generic in-app alert after re-checking channel access.",
    payloadSchema: Type.Object(
      {
        organizationId: id,
        taskId: id,
        channelId: id,
        fromUserId: id,
        toUserId: id,
        source: Type.Union([
          Type.Literal("manual"),
          Type.Literal("offboarding"),
          Type.Literal("review"),
        ]),
        at: isoInstant,
      },
      { additionalProperties: false },
    ),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.task.needs_owner",
    moduleOwner: "m36",
    description:
      "A communication task lost its assignee to offboarding and no eligible successor existed (WP 3.4), so it is flagged for its creator to reassign. PHI-free: ids and one instant. M36 tells the creator with one generic in-app alert.",
    payloadSchema: Type.Object(
      {
        organizationId: id,
        taskId: id,
        channelId: id,
        creatorUserId: id,
        at: isoInstant,
      },
      { additionalProperties: false },
    ),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.task.status_changed",
    moduleOwner: "m36",
    description:
      "A communication task moved between open, accepted, done and cancelled (WP 3.4). PHI-free: ids, the two status enums and one instant - never the closing reason. Record-only: the durable trail; no consumer.",
    payloadSchema: Type.Object(
      {
        organizationId: id,
        taskId: id,
        channelId: id,
        from: taskStatus,
        to: taskStatus,
        at: isoInstant,
      },
      { additionalProperties: false },
    ),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.handoff.offered",
    moduleOwner: "m36",
    description:
      "A clinical handoff was offered to a colleague (WP 3.5, ADR-0062). PHI-free: ids, an item COUNT and two instants - no patient id, no item reference. Published in the same transaction as the insert; an idempotent re-offer publishes nothing. M36 tells the receiver with one generic in-app alert, only if the handoff is still offered to them.",
    payloadSchema: Type.Object(
      {
        organizationId: id,
        handoffId: id,
        fromUserId: id,
        toUserId: id,
        itemCount: count,
        expiresAt: isoInstant,
        at: isoInstant,
      },
      { additionalProperties: false },
    ),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.handoff.accepted",
    moduleOwner: "m36",
    description:
      "A receiver accepted one or more items of a handoff (WP 3.5). PHI-free: ids and counts. Published once per accept call that changed something; a repeat publishes nothing. M36 tells the sender with one generic in-app alert (a 'part of your handoff' wording while items remain pending).",
    payloadSchema: Type.Object(
      {
        organizationId: id,
        handoffId: id,
        fromUserId: id,
        toUserId: id,
        acceptedItemCount: count,
        pendingItemCount: count,
        at: isoInstant,
      },
      { additionalProperties: false },
    ),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.handoff.unaccepted",
    moduleOwner: "m36",
    description:
      "A handoff ended with items nobody accepted (WP 3.5): declined, expired at the deadline, the receiver left, or the sender left. Accountability stays with the sender. PHI-free: ids, the cause enum and counts. M36 alerts the sender and the supervisor audience in-app; when no supervisor can be reached it records a needs_attention event and tells the sender.",
    payloadSchema: Type.Object(
      {
        organizationId: id,
        handoffId: id,
        fromUserId: id,
        toUserId: id,
        cause: handoffCause,
        unacceptedItemCount: count,
        acceptedItemCount: count,
        at: isoInstant,
      },
      { additionalProperties: false },
    ),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.medication_question.unrouted",
    moduleOwner: "m36",
    description:
      "A medication question has no assigned nurse (WP 3.10, ADR-0067): the asker sent it without one, or the assigned nurse left and nobody could take it. PHI-free: ids, the reason enum and one instant - no patient id and no text. Published in the same transaction as the write. M36 tells the supervisor audience with one fixed in-app alert; it is never the emergency path and never an order.",
    payloadSchema: Type.Object(
      {
        organizationId: id,
        channelId: id,
        messageId: id,
        askedByUserId: id,
        reason: medicationQuestionReason,
        at: isoInstant,
      },
      { additionalProperties: false },
    ),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.message.urgent_sent",
    moduleOwner: "m36",
    description:
      "An urgent clinical message was sent to one named, qualified colleague (WP 4.1, ADR-0068). PHI-free: ids and one instant - no patient id, no name, no text. Published in the same transaction as the message; an idempotent replay publishes nothing. M36 tells the recipient with one generic in-app alert; it is not a page, not a request for a clinician's response and not the emergency path (WP 4.2 - 4.4 add those).",
    payloadSchema: Type.Object(
      {
        organizationId: id,
        channelId: id,
        messageId: id,
        authorUserId: id,
        recipientUserId: id,
        at: isoInstant,
      },
      { additionalProperties: false },
    ),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  ...ACK_EVENT_ENTRIES,
  {
    eventName: "m36.promotion.requested",
    moduleOwner: "m36",
    description:
      "A clinician proposed that a secure message belong in the chart (WP 3.7, ADR-0063). PHI-free: ids, the closed target pair and one instant - no patient id, no message id, no body hash, no text. Published in the same transaction as the insert; a replayed request publishes nothing. M36 tells the people who can review it with one generic in-app alert per reviewer (or the IDG coordinators), only if the request is still proposed, and tells the requester when nobody can be reached.",
    payloadSchema: Type.Object(
      {
        organizationId: id,
        promotionRequestId: id,
        targetModule: promotionTargetModule,
        targetKind: promotionTargetKind,
        requestedByUserId: id,
        at: isoInstant,
      },
      { additionalProperties: false },
    ),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.message.schedule_blocked",
    moduleOwner: "m36",
    description:
      "A scheduled message came due and was NOT sent because a dispatch-time re-check failed (WP 2.6: membership, messaging.send, channel archived or closed with the patient's episode, announcement policy) or the send kept failing. Published in the same transaction that flips the row to blocked. PHI-free: ids and a reason code, never the body. M36 turns it into one generic in-app notification for the sender.",
    payloadSchema: Type.Object({
      organizationId: id,
      scheduledMessageId: id,
      channelId: id,
      senderUserId: id,
      reason: Type.String({ minLength: 1, maxLength: 64 }),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.attachment.cleared",
    moduleOwner: "m36",
    description:
      "A message attachment passed its malware scan and became deliverable (WP 1.5). PHI-free: ids, the scanner name and one timestamp. Record-only: the durable record of the verdict; clients learn availability by re-reading the message list.",
    payloadSchema: Type.Object({
      organizationId: id,
      attachmentId: id,
      channelId: id,
      /** Null while the attachment is still unbound (scanned before the message was sent). */
      messageId: nullableId,
      scanner: id,
      at: isoInstant,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.attachment.quarantined",
    moduleOwner: "m36",
    description:
      "A message attachment failed its malware scan and was quarantined (WP 1.5): it is never delivered to or downloadable by any member, including the uploader. PHI-free: ids, the signature name, the scanner name and one timestamp. Record-only.",
    payloadSchema: Type.Object({
      organizationId: id,
      attachmentId: id,
      channelId: id,
      messageId: nullableId,
      signature: id,
      scanner: id,
      at: isoInstant,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m36.notification.delivery_failed",
    moduleOwner: "m36",
    description:
      "A notification_delivery row settled to a terminal failed status after D7 retries were exhausted — an alert a consumer requested could not be delivered to a recipient on a given channel. PHI-free by construction (ids + failure class only). Produced by the out-of-band dispatcher and the vendor-webhook reconcile (see this file's header).",
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

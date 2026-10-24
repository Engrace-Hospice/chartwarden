// apps/backend/src/modules/31-portal/events-by-m31.ts - M31's transactional-outbox event contribution (GAP-159).
//
// The 22 spec section-4.10 events, catalogued so `m31OutboxPublisher` (`bindCallerModule(txOutboxPublisher,
// "m31")`) can validate every publish: an unlisted name throws `unknown_event` and rolls the caller back.
// Payloads are lean and PHI-free (ids + structural facts; the sealed suspend reason is never carried).
// Every event is record-only (`isOutboxOnly`, no declared consumer): M4 audits the row itself, and the
// metric/channel consumers (M30/M33/M36/M2) pull. Emit sites live next to the mutation they describe
// (`events.ts` documents which are same-transaction and which are decision-point emits).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@chartwarden/types";

const str = Type.String({ minLength: 1 });
const nstr = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

export const M31_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m31.portal_account.invited",
    moduleOwner: "m31",
    description: "A portal invitation was issued (section 2.2.4). Record-only; M4 audits the row.",
    payloadSchema: Type.Object({
      portalAccountId: str,
      patientId: str,
      relationship: str,
      issuedByMembershipId: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_account.activated",
    moduleOwner: "m31",
    description:
      "A portal account activated on first successful login after the invite. Record-only here; M36/M30 pull.",
    payloadSchema: Type.Object({
      portalAccountId: str,
      patientId: str,
      relationship: str,
      activatedAt: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_account.suspended",
    moduleOwner: "m31",
    description:
      "An org admin suspended a portal account (the sealed reason is never in the payload).",
    payloadSchema: Type.Object({
      portalAccountId: str,
      reason: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_account.revoked",
    moduleOwner: "m31",
    description: "A portal account was terminally revoked.",
    payloadSchema: Type.Object({
      portalAccountId: str,
      reason: str,
      affectedPatientIds: Type.Optional(Type.Array(str)),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_account.shredded",
    moduleOwner: "m31",
    description: "The section 3.7 eraser tombstoned a portal account.",
    payloadSchema: Type.Object({
      portalAccountId: str,
      certificateId: Type.Optional(nstr),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_account.bereaved_mode_entered",
    moduleOwner: "m31",
    description: "A portal account flipped to bereaved scope (M16 plan opened / contact active).",
    payloadSchema: Type.Object({
      portalAccountId: str,
      patientId: str,
      bereavementPlanId: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_account.bereaved_window_closed",
    moduleOwner: "m31",
    description:
      "A bereaved account's 13-month M16 window closed; its bereaved grants were revoked.",
    payloadSchema: Type.Object({
      portalAccountId: str,
      patientId: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_access_grant.granted",
    moduleOwner: "m31",
    description: "A portal access grant was inserted.",
    payloadSchema: Type.Object({
      grantId: str,
      portalAccountId: str,
      patientId: str,
      grantKind: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_access_grant.revoked",
    moduleOwner: "m31",
    description: "A portal access grant was revoked.",
    payloadSchema: Type.Object({
      grantId: str,
      portalAccountId: str,
      patientId: str,
      revokeCascadeSource: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.telehealth.room_created",
    moduleOwner: "m31",
    description: "A telehealth room was minted for an M17 visit.",
    payloadSchema: Type.Object({
      telehealthVisitId: str,
      m17VisitId: str,
      patientId: str,
      vendor: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.telehealth.visit_started",
    moduleOwner: "m31",
    description: "Both parties are present; the visit started.",
    payloadSchema: Type.Object({
      telehealthVisitId: str,
      m17VisitId: str,
      startedAt: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.telehealth.visit_ended",
    moduleOwner: "m31",
    description: "A telehealth visit ended.",
    payloadSchema: Type.Object({
      telehealthVisitId: str,
      m17VisitId: str,
      lifecycleState: str,
      endReason: str,
      totalDurationSec: Type.Optional(Type.Integer({ minimum: 0 })),
      audioOnlyFallback: Type.Optional(Type.Boolean()),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.telehealth.recording_started",
    moduleOwner: "m31",
    description: "Recording started on a telehealth visit.",
    payloadSchema: Type.Object({
      telehealthVisitId: str,
      twoPartyVerified: Type.Optional(Type.Boolean()),
      recordingId: Type.Optional(nstr),
      stateCode: Type.Optional(nstr),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.telehealth.recording_completed",
    moduleOwner: "m31",
    description: "A vendor recording finished (vendor webhook).",
    payloadSchema: Type.Object({
      telehealthVisitId: str,
      recordingId: str,
      durationSec: Type.Optional(Type.Integer({ minimum: 0 })),
      byteSize: Type.Optional(Type.Integer({ minimum: 0 })),
      sha256: Type.Optional(nstr),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.telehealth.recordings_shredded",
    moduleOwner: "m31",
    description: "The eraser destroyed telehealth recordings.",
    payloadSchema: Type.Object({
      certificateId: Type.Optional(nstr),
      recordingIds: Type.Optional(Type.Array(str)),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_document.upload_started",
    moduleOwner: "m31",
    description: "A portal document upload passed validation and an upload was minted.",
    payloadSchema: Type.Object({
      uploadId: str,
      portalAccountId: str,
      patientId: str,
      purpose: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_document.uploaded",
    moduleOwner: "m31",
    description: "A portal document upload completed.",
    payloadSchema: Type.Object({
      uploadId: str,
      portalAccountId: str,
      patientId: str,
      purpose: str,
      byteSize: Type.Optional(Type.Integer({ minimum: 0 })),
      mimeType: Type.Optional(nstr),
      m22IntakeBatchId: Type.Optional(nstr),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_document.upload_rejected",
    moduleOwner: "m31",
    description: "A portal document upload was rejected at validation (sanitized reason).",
    payloadSchema: Type.Object({
      portalAccountId: str,
      patientId: str,
      rejectionReason: str,
      uploadId: Type.Optional(nstr),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_amendment_request.submitted",
    moduleOwner: "m31",
    description: "A portal amendment request was handed to M5.",
    payloadSchema: Type.Object({
      amendmentRequestRefId: str,
      portalAccountId: str,
      patientId: str,
      m5AmendmentRequestId: Type.Optional(nstr),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_session.opened",
    moduleOwner: "m31",
    description: "A portal session was bound to a patient.",
    payloadSchema: Type.Object({
      sessionId: str,
      portalAccountId: str,
      patientId: str,
      ipHash: Type.Optional(nstr),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_session.closed",
    moduleOwner: "m31",
    description: "A portal session was closed.",
    payloadSchema: Type.Object({
      sessionId: str,
      closeReason: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m31.portal_message.sent_via_m36",
    moduleOwner: "m31",
    description: "A portal message was sent through M36 (engagement metric signal only).",
    payloadSchema: Type.Object({
      portalAccountId: str,
      patientId: str,
      channelId: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
];

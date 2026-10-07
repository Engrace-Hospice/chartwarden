// apps/backend/src/modules/36-messaging/outbox-consumers/channel-membership-sync.ts — GAP-104: the care_team
// channel membership LIFECYCLE (M36 spec §2.3, D5, §4.7 `messaging.channel_sync`). Until now the only trigger
// for `syncCareTeamChannel` was M31 portal traffic, so a clinician taken off a caseload kept PHI channel access
// and a discharged patient's channel never archived. These consumers are the push half; `canViewChannel`
// (messaging-route-service-db.ts) is the pull half (an auto member must be on the CURRENT roster).
//
//   event (outbox)                  -> action
//   m5.patient.assignment_created   -> reopen an archived channel (readmission), then reconcile membership
//   m5.patient.assignment_ended     -> reconcile membership (the unassigned clinician's row is soft-removed)
//   m5.patient.deceased             -> reconcile, then archive
//   m6.admission.discharged         -> archive (patient resolved through M6's AdmissionStatusReader seam)
//
// RETENTION: archive never deletes — `channel_member` rows and messages are kept (6+ yr `care_related`); an
// archived channel refuses new messages (410) and takes no new members; a removed member's row is soft-removed
// (`removed_at`) so the audit trail (M4 trigger on channel_member) records who lost access and when.
//
// TENANT: from the envelope `event.organizationId`, NEVER the payload. A malformed payload THROWS (relay retry
// -> DLQ — a visible failure, never a silently stale PHI channel). Every action is idempotent, so a redelivery
// converges. Reconcile is by ROSTER DIFF (not by the event's clinician), so out-of-order events converge too.
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_CHANNEL_MEMBERSHIP_SYNC_CONSUMER = "m36.channel-membership-sync" as const;

export const M36_CHANNEL_MEMBERSHIP_SYNC_EVENT_TYPES = [
  "m5.patient.assignment_created",
  "m5.patient.assignment_ended",
  "m5.patient.deceased",
  "m6.admission.discharged",
] as const;

export interface ChannelMembershipSyncDeps {
  /** Reconcile the patient's care_team channel `auto` membership against the live roster (M36 provider). */
  readonly syncCareTeam: (orgId: string, patientId: string) => Promise<unknown>;
  /** Archive the patient's care_team channel (no-op when absent / already archived). */
  readonly archiveCareTeam: (orgId: string, patientId: string) => Promise<unknown>;
  /** Un-archive it (readmission); returns whether a channel was reopened. */
  readonly reopenCareTeam: (orgId: string, patientId: string) => Promise<boolean>;
  /** Resolve an admission to its patient id (M6 AdmissionStatusReader), or null when unknown. */
  readonly patientIdForAdmission: (orgId: string, admissionId: string) => Promise<string | null>;
}

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${M36_CHANNEL_MEMBERSHIP_SYNC_CONSUMER}: ${eventName} payload has no ${key}`);
  }
  return v;
}

async function handleEvent(
  event: DispatchableOutboxEvent,
  deps: ChannelMembershipSyncDeps,
): Promise<void> {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const orgId = event.organizationId;
  switch (event.eventType) {
    case "m5.patient.assignment_created": {
      const patientId = requireString(p, "patientId", event.eventType);
      await deps.reopenCareTeam(orgId, patientId);
      await deps.syncCareTeam(orgId, patientId);
      return;
    }
    case "m5.patient.assignment_ended": {
      await deps.syncCareTeam(orgId, requireString(p, "patientId", event.eventType));
      return;
    }
    case "m5.patient.deceased": {
      const patientId = requireString(p, "patientId", event.eventType);
      await deps.syncCareTeam(orgId, patientId);
      await deps.archiveCareTeam(orgId, patientId);
      return;
    }
    case "m6.admission.discharged": {
      const admissionId = requireString(p, "admissionId", event.eventType);
      const patientId = await deps.patientIdForAdmission(orgId, admissionId);
      if (!patientId) {
        throw new Error(
          `${M36_CHANNEL_MEMBERSHIP_SYNC_CONSUMER}: admission ${admissionId} does not resolve to a patient`,
        );
      }
      await deps.archiveCareTeam(orgId, patientId);
      return;
    }
    default:
      throw new Error(
        `${M36_CHANNEL_MEMBERSHIP_SYNC_CONSUMER}: unexpected event ${event.eventType}`,
      );
  }
}

export function buildM36ChannelMembershipSyncConsumer(
  deps: ChannelMembershipSyncDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M36_CHANNEL_MEMBERSHIP_SYNC_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_CHANNEL_MEMBERSHIP_SYNC_EVENT_TYPES,
    handle: (event) => handleEvent(event, deps),
  };
}

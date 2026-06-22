// apps/backend/src/modules/18-evv/alerts-by-m18.ts — Module 18's M36 alert-payload contribution (M18-T07,
// spec §4.9). The typed alert payloads M18 OWNS under the `m18.` prefix, registered onto M36's Foundation
// alert-payload registry at M18 boot (NO import edge into M36 — M36 is foundation-tier and never imports M18;
// the registry is the mutable seam). Notification COMPOSITION + recipient resolution is M36's (ADR-0024): M18
// emits these deterministic, near-PHI-free payloads (IDs + structural facts + first-name only), and M36
// resolves recipient PHI per permission scope and never re-templates.
//
// M18-F16 (ARCH-185 / SEC-048): the payload fields below are for IN-APP RENDERING ONLY (the M36 in-app
// notification surface + the supervisor alert panel). Out-of-band channels (push / SMS) carry NO PHI — only a
// generic prompt + an authenticated deep-link URL. This restriction holds for every M18 alert regardless of
// severity, so the out-of-band `defaultChannels` are deliberately omitted from the platform floor here. The
// payload TYPES mirror the `EvvAlertPayload` discriminated union in @wardenx/types (§4.9). The platform-floor
// severity/cadence may be TIGHTENED by a tenant, never loosened (D11).
import { Type } from "@sinclair/typebox";
import type { ModuleAlertContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });

export const M18_ALERT_PAYLOADS: ModuleAlertContribution = [
  {
    payloadType: "m18.evv.late_check_out_detected",
    moduleOwner: "m18",
    severity: "WARN",
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "evv_assigned_clinician_and_supervisor",
    payloadSchema: Type.Object({
      visitId: id,
      patientFirstName: Type.String(), // first name only, never full PHI in alert
      assignedClinicianMembershipId: id,
      scheduledStartedAt: isoInstant,
      scheduledEndedAt: isoInstant,
      hoursPastGrace: Type.Number(),
      hasCheckIn: Type.Boolean(),
    }),
    requiresResponseTracking: true,
    description:
      "No checkout arrived within scheduled_ended_at + grace — the assigned clinician / supervisor / on-call warning to attest or override (§4.9 late checkout).",
  },
  {
    payloadType: "m18.evv.geofence_breach_recorded",
    moduleOwner: "m18",
    severity: "WARN",
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "evv_clinical_supervisor",
    payloadSchema: Type.Object({
      eventId: id,
      visitId: id,
      kind: Type.Union([
        Type.Literal("outside_geofence_at_checkin"),
        Type.Literal("outside_geofence_at_checkout"),
      ]),
      computedDistanceM: Type.Number(),
      appliedRadiusM: Type.Integer(),
      postingMembershipId: id,
    }),
    requiresResponseTracking: false,
    description:
      "A capture landed outside the applied geofence — the supervisor warning with the computed distance vs applied radius (§4.9 geofence breach).",
  },
  {
    payloadType: "m18.evv.gps_spoof_suspected",
    moduleOwner: "m18",
    severity: "WARN",
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "evv_supervisor_and_compliance",
    payloadSchema: Type.Object({
      eventId: id,
      visitId: id,
      postingMembershipId: id,
      detectionSignals: Type.Array(Type.String()), // e.g. ['implausible_speed', 'mock_location_api_enabled']
    }),
    requiresResponseTracking: false,
    description:
      "The gps-spoof-detector flagged an event (advisory, not blocking, D9) — the supervisor + compliance-officer warning with the detection signals (§4.9 GPS spoofing).",
  },
  {
    payloadType: "m18.evv.device_pending_approval",
    moduleOwner: "m18",
    severity: "INFO",
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "evv_clinical_supervisor",
    payloadSchema: Type.Object({
      deviceId: id,
      membershipId: id,
      platform: Type.Union([Type.Literal("ios"), Type.Literal("android")]),
      modelDescription: Type.String(),
    }),
    requiresResponseTracking: true,
    description:
      "A clinician self-registered a device — the supervisor approval prompt with platform + model (§4.9 device pending approval).",
  },
  {
    payloadType: "m18.evv.device_suspended",
    moduleOwner: "m18",
    severity: "WARN",
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "evv_assigned_clinician_and_supervisor",
    payloadSchema: Type.Object({
      deviceId: id,
      membershipId: id,
      reason: Type.String(),
    }),
    requiresResponseTracking: false,
    description:
      "A device was suspended — the clinician + supervisor warning; the device can no longer post EVV captures (§4.9 device suspended).",
  },
  {
    payloadType: "m18.evv.aggregator_rejected",
    moduleOwner: "m18",
    severity: "WARN",
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "evv_billing_operations",
    payloadSchema: Type.Object({
      submissionId: id,
      visitId: id,
      stateCode: Type.String(),
      rejectionCode: Type.String(),
      attemptCount: Type.Integer(),
    }),
    requiresResponseTracking: true,
    description:
      "A per-state aggregator submission was rejected — the billing-ops warning to triage the rejection-fix cycle (§4.9 aggregator rejected).",
  },
  {
    payloadType: "m18.evv.aggregator_timeout",
    moduleOwner: "m18",
    severity: "CRITICAL",
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "evv_billing_and_platform_ops",
    payloadSchema: Type.Object({
      submissionId: id,
      visitId: id,
      stateCode: Type.String(),
      attemptCount: Type.Integer(),
    }),
    requiresResponseTracking: true,
    description:
      "A submission timed out awaiting the aggregator — the critical billing-ops + platform-ops alert (vendor outage triage; §4.9 aggregator timeout).",
  },
];

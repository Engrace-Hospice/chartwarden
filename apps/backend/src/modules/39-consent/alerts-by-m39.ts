// apps/backend/src/modules/39-consent/alerts-by-m39.ts — Module 39's M36 alert-payload contribution
// (M39-T08, spec §4.10). The five typed alert payloads M39 OWNS under the `m39.` prefix, registered
// onto M36's Foundation alert-payload registry at M39 boot (NO import edge into a later module — M36
// is foundation-tier and never imports M39; the registry is the mutable seam, M36-F01). M39 routes
// these through M36's typed dispatch; the platform-floor severity/cadence may be tightened by a
// tenant, never loosened. `m39.consent.expiration_imminent` is re-tiered off CRITICAL for routine
// expiry (M39-F09) — only the 1-day window is CRITICAL; the voice/SOS escalation is removed (INT-031
// voice = field-safety SOS only).
import { Type } from "@sinclair/typebox";
import type { ModuleAlertContribution } from "@wardenx/types";

const consentRef = {
  organizationId: Type.String({ minLength: 1 }),
  patientId: Type.String({ minLength: 1 }),
  consentRecordId: Type.String({ minLength: 1 }),
  typeKey: Type.String({ minLength: 1 }),
};

export const M39_ALERT_PAYLOADS: ModuleAlertContribution = [
  {
    payloadType: "m39.consent.expiration_imminent",
    moduleOwner: "m39",
    severity: "HIGH", // platform floor at the 14/7-day window; the 1-day cron tightens to CRITICAL
    defaultChannels: ["inbox", "email"],
    defaultRecipientResolver: "consent_management_steward",
    payloadSchema: Type.Object({ ...consentRef, expiresAt: Type.String(), reminderKind: Type.String() }),
    requiresResponseTracking: false,
    description: "A consent is approaching expiry (90/30/14/7/1-day cadence, D9). Routine compliance reminder.",
  },
  {
    payloadType: "m39.consent.revoked_cascade_failed",
    moduleOwner: "m39",
    severity: "CRITICAL",
    defaultChannels: ["inbox", "socket_push", "email"],
    defaultRecipientResolver: "consent_management_steward",
    payloadSchema: Type.Object({ ...consentRef, revocationId: Type.String(), failedConsumers: Type.Array(Type.String()) }),
    requiresResponseTracking: true,
    description: "A revocation cascade exhausted its retry budget with un-ACKed consumers (§2.2.3 partial_failed).",
  },
  {
    payloadType: "m39.consent.dpoa_agent_appointed",
    moduleOwner: "m39",
    severity: "MEDIUM",
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "consent_management_steward",
    payloadSchema: Type.Object({ ...consentRef, dpoaAgentId: Type.String(), agentName: Type.String() }),
    requiresResponseTracking: false,
    description: "A DPOA agent was appointed — informational banner on the M7 care-plan UI.",
  },
  {
    payloadType: "m39.consent.recipient_disclosure_attempted_without_consent",
    moduleOwner: "m39",
    severity: "HIGH",
    defaultChannels: ["inbox", "email"],
    defaultRecipientResolver: "consent_management_steward",
    payloadSchema: Type.Object({ ...consentRef, recipientResolvedKind: Type.String(), recipientResolvedId: Type.Optional(Type.String()) }),
    requiresResponseTracking: true,
    description: "M22/M28 attempted a disclosure to a recipient no consent names — M39 routes the compliance alert.",
  },
  {
    payloadType: "m39.consent.renewal_overdue",
    moduleOwner: "m39",
    severity: "HIGH", // 7-day past expiry floor; the 30-day cron tightens to CRITICAL
    defaultChannels: ["inbox", "email"],
    defaultRecipientResolver: "consent_management_steward",
    payloadSchema: Type.Object({ ...consentRef, expiresAt: Type.String(), daysOverdue: Type.Integer() }),
    requiresResponseTracking: true,
    description: "A compliance-critical consent (42 CFR Part 2 / HIPAA / DPOA) expired without renewal.",
  },
];

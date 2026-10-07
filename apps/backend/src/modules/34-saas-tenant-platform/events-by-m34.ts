// apps/backend/src/modules/34-saas-tenant-platform/events-by-m34.ts — Module 34's outbox-event
// contributions (spec §4.9 Outbox Event Catalog + §4.8 M36 Alert-Rule Contributions). The full
// `m34.*` taxonomy keyed on M34's own tables, under the `m34.` namespace (M01 D8 outbox_event_catalog
// / M03 D9 / M04 D9). check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`),
// ownership (moduleOwner='m34'), and valid declared consumers (real module ids); the canonical wire
// `eventName`s here ALL carry the `m34.` prefix the event-catalog gate enforces.
//
// This file declares the EIGHTEEN typed alert payloads M34 emits (spec §2 / §ER "Depends on M36" — the
// eighteen typed alert payloads; §4.8 — the thirteen M36 alert-rule keys consult these). The spec prose
// lists several of these by their bare M36 alert-rule key (`tenant.onboarding_step_blocked`,
// `support_session.elevated`, `feature_flag.platform_emergency_changed`, …) — those bare names are M36
// rule keys, NOT outbox names. The OUTBOX event each rule fires from must carry the owning module's
// `m34.` prefix (M01 D8 / M03 D9), so every entry below is normalised to the canonical
// `m34.<resource>.<verb>` form; the M36 alert-rule seed maps its bare rule key onto the `m34.`-prefixed
// trigger event in M36's catalog (§4.8). Each entry adds the TypeBox `payloadSchema` + declared
// consumers the dispatcher validates each publish against, so "DB updated but the event never went out"
// is closed in the same transaction as the mutation (M1 §25.5/§25.6).
//
// Phase-1 boundary (§0): events whose declared consumers are future-wave modules (M35 subscription
// billing — consumes `m34.tenant.provisioned` / `m34.tenant.offboarding_initiated`; M33 reporting) are
// PUBLISHED now by M34 — the producer side ships, the consumer attaches when that module locks. M34
// never calls those modules' routes; it only emits the typed outbox event. M36 is the live alerts
// consumer for every alert event below (the alert-rule engine fans out to the registered
// `compliance_officer_for_tenant` / `platform_security_owner` resolvers per §4.8).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);

export const M34_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m34.tenant.provision_started",
    moduleOwner: "m34",
    description:
      "Durable provisioning command emitted with the tenant spine transaction; M34's queue bridge starts the provision worker.",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      organizationId: id,
      legalBusinessName: Type.String(),
      billingContactEmail: Type.String(),
      firstAdminEmail: Type.String(),
      firstAdminFullName: Type.String(),
      actorMembershipId: id,
      transitionReason: Type.String(),
    }),
    declaredConsumers: ["m34"],
    isOutboxOnly: true,
  },
  // ── tenant lifecycle alerts (§2 lifecycle machine / §4.8 alert rules) ──────────────────────────────
  {
    eventName: "m34.tenant.provisioned",
    moduleOwner: "m34",
    description:
      "`provisioning → onboarding` completed: key ring + MinIO prefix + M2 org + onboarding tasks + first-admin invitation are in place (§ER lifecycle step 6). M35 creates the Stripe Customer; M36 routes the provisioning notice.",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      orgId: id,
      legalBusinessName: Type.String(),
      billingContactEmail: Type.String(),
    }),
    // F-142 (#248) — m35 dropped: M35's own D19/D24 (locked) route tenant-lifecycle integration
    // through M2's organization outbox events, not M34's — M35's own D21 exhaustive subscription list
    // names `m2.organization.*`/`m2.session.created`/`m5.patient.*` only, and D24 states M35 does not
    // depend on M34 at all (M34 depends on M35, not the reverse; ratified by ADR-0025).
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.tenant.onboarding_step_blocked",
    moduleOwner: "m34",
    description:
      "An `onboarding_task` was marked blocked (or the §4.8 `tenant.onboarding_step_blocked_5d` sweep aged a `m34.onboarding.task_blocked` past 5d); M36 warns the tenant compliance officer + platform-ops.",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      taskId: id,
      templateKey: id,
      blockerReason: Type.String(),
      blockedSinceIso: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.tenant.onboarding_overdue",
    moduleOwner: "m34",
    description:
      "The daily onboarding sweep found an `onboarding_task.due_at < NOW()` (§4.8 `tenant.onboarding_overdue`); M36 warns the tenant compliance officer.",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      taskId: id,
      templateKey: id,
      dueAt: isoInstant,
      hoursOverdue: Type.Number(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.tenant.onboarding_completed",
    moduleOwner: "m34",
    description:
      "`onboarding → active` succeeded — every canonical task done/skipped and BAA executed (§ER lifecycle); mirror of `m34.tenant.activated` carrying the completion summary. M36 routes `tenant.onboarding_completed` to platform-ops (info).",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      orgId: id,
      activatedAt: isoInstant,
      tasksCompleted: Type.Integer({ minimum: 0 }),
      tasksSkipped: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.tenant.suspension_initiated",
    moduleOwner: "m34",
    description:
      "`active → suspended` ran the M2 session-revocation cascade (§ER lifecycle); M36 alerts the tenant compliance officer AND the platform security owner (error).",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      orgId: id,
      reason: Type.String(),
      initiatedByMembershipId: id,
      initiatedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.tenant.reactivated",
    moduleOwner: "m34",
    description:
      "`suspended → active` (cause resolved) or `at_risk → active` (health predicates resolved); M36 confirms to platform-ops, M33 records the reactivation.",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      orgId: id,
      reason: Type.String(),
      actorMembershipId: id,
      reactivatedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.tenant.at_risk",
    moduleOwner: "m34",
    description:
      "`active → at_risk`: the §2.2 lifecycle-health predicates failed (no claim 60d / no clinical write 30d); M36 warns platform-ops. Drives the admin banner + warning header off the status read.",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      orgId: id,
      reason: Type.String(),
      actorMembershipId: id,
      flaggedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.tenant.offboarding_initiated",
    moduleOwner: "m34",
    description:
      "`active/suspended → offboarding_initiated` began the offboarding flow (§ER lifecycle); M35 schedules subscription cancellation, M36 alerts the compliance officer + platform security owner (error).",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      orgId: id,
      purpose: Type.String(),
      initiatedByMembershipId: id,
      initiatedAt: isoInstant,
    }),
    // F-142 (#248) — m35 dropped: same D19/D21/D24 reasoning as `tenant.provisioned` above.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.tenant.retention_window_approaching",
    moduleOwner: "m34",
    description:
      "The retention sweep found a tenant whose `retention_ends_at` is within a §4.8 tier (30d → platform-ops warn; 7d → platform security owner error); M36 routes per tier.",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      orgId: id,
      retentionEndsAt: isoInstant,
      daysRemaining: Type.Integer({ minimum: 0 }),
      tier: Type.Union([Type.Literal("approaching_30d"), Type.Literal("approaching_7d")]),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.tenant.shred_pending_approval",
    moduleOwner: "m34",
    description:
      "`retained → destruction_pending`: the `tenant.shred_eligibility_check` cron flagged `retention_ends_at <= NOW()` with no legal hold and called M4 `requestDestruction('saas_tenant_platform_class', {orgId})` (§ER lifecycle); M36 routes `tenant.shred_pending_approval` to the platform security owner (error).",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      orgId: id,
      retentionEndedAt: isoInstant,
      destructionCertId: nullableId,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.tenant.destroyed",
    moduleOwner: "m34",
    description:
      "The certified M34 shred erased tenant data, destroyed object versions, zeroized all wrapped DEKs, and committed the terminal `destroyed` lifecycle state.",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      orgId: id,
      destructionCertId: id,
      destroyedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── per-tenant DEK key-ring alerts (§ER "M1 envelope/DEK" / §4.8) ──────────────────────────────────
  {
    eventName: "m34.tenant.dek_rotation_due",
    moduleOwner: "m34",
    description:
      "The key-ring rotation sweep found a `tenant_key_ring.current_dek_version` past its rotation cadence; M36 notifies the platform security owner so a `Rotate DEK` action is taken.",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      orgId: id,
      currentDekVersion: id,
      lastRotatedAt: nullableId,
      dueAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.tenant.dek_rotation_completed",
    moduleOwner: "m34",
    description:
      "A `Rotate DEK` action minted a new `tenant_key_ring` DEK version and re-wrapped under the active KEK (§4.9); M36 confirms to the platform security owner, M33 records the rotation, M18 re-seals its EVV coordinates under the new version (M18 §4.8 `m18.dek-rotation`).",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      orgId: id,
      fromVersion: id,
      toVersion: id,
      rotatedAt: isoInstant,
    }),
    declaredConsumers: ["m18"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── support break-glass session alerts (§ER support sessions / §4.8) ───────────────────────────────
  {
    eventName: "m34.support_session.started",
    moduleOwner: "m34",
    description:
      "A platform-ops actor opened a break-glass support session against a valid `support_consent_grant` (§ER support flow); M36 warns the grantor compliance officer (the §4.8 `support_session.started` rule).",
    payloadSchema: Type.Object({
      sessionId: id,
      grantId: id,
      tenantAccountId: id,
      actorMembershipId: id,
      scope: id,
      startedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.support_session.elevated",
    moduleOwner: "m34",
    description:
      "An in-session `Elevate for PHI read` step-up succeeded (§D10 step-up on `support_session.elevate_phi_read`); M36 alerts the grantor compliance officer that a break-glass PHI read window is open.",
    payloadSchema: Type.Object({
      sessionId: id,
      grantId: id,
      tenantAccountId: id,
      actorMembershipId: id,
      elevatedAt: isoInstant,
      elevationExpiresAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.support_session.expired",
    moduleOwner: "m34",
    description:
      "The close-sweep job (or grant revocation / manual close) ended a support session at `expires_at` (§ER support flow step 6); M36 notifies that the break-glass window closed.",
    payloadSchema: Type.Object({
      sessionId: id,
      grantId: id,
      tenantAccountId: id,
      closeReason: Type.Union([
        Type.Literal("expired"),
        Type.Literal("grant_revoked"),
        Type.Literal("manual_close"),
      ]),
      closedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── DSAR export alerts (§ER DSAR fulfillment / §4.8 SLA escalations) ───────────────────────────────
  {
    eventName: "m34.dsar_export.requested",
    moduleOwner: "m34",
    description:
      "A `dsar_export_job` was inserted `status='requested'` with `sla_due_at = NOW() + 30d` (§ER DSAR step 2); M36 opens the DSAR-officer queue item and the §4.8 SLA-aging sweeps watch the 20d/27d/30d tiers.",
    payloadSchema: Type.Object({
      jobId: id,
      orgId: id,
      tenantAccountId: id,
      patientId: id,
      slaDueAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.dsar_export.completed",
    moduleOwner: "m34",
    description:
      "DSAR fulfillment finished: the FHIR Bundle PDF + NDJSON manifest rendered via M22 and `dsar_export_job.bundle_document_id` was wired back (§ER DSAR / M22 handshake); M36 closes the DSAR-officer queue item.",
    payloadSchema: Type.Object({
      jobId: id,
      orgId: id,
      patientId: id,
      bundleDocumentId: nullableId,
      bundleSha256: id,
      fulfilledAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── feature-flag + platform-tenant BAA alerts (§4.7 / §4.8) ────────────────────────────────────────
  {
    eventName: "m34.feature_flag.platform_emergency_changed",
    moduleOwner: "m34",
    description:
      "A platform-global kill-switch toggle (`POST /feature-flags/:flagKey/kill-switch`, step-up, §4.7) flipped an emergency flag; M36 raises the critical `feature_flag.platform_emergency_changed` alert to the platform security owner.",
    payloadSchema: Type.Object({
      flagKey: id,
      killSwitchActive: Type.Boolean(),
      // The acting platform-ops USER. A platform operator toggling a global flag holds no membership in
      // any tenant the flag touches, so the membership id is optional; the user id is always known.
      actorUserId: id,
      actorMembershipId: nullableId,
      // The flag's scope: the owning org, or null for a platform-global flag.
      orgId: nullableId,
      changedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m34.baa.platform_tenant_expiring",
    moduleOwner: "m34",
    description:
      "The `tenant.baa_expiry_sweep` daily cron found a `platform_tenant_baa_record` approaching expiry (§ER BAA — 90d/60d/30d/7d/expired tiers); M36 alerts the tenant compliance officer at each tier.",
    payloadSchema: Type.Object({
      tenantAccountId: id,
      addendumVersion: id,
      expiresOn: nullableId,
      tier: Type.Union([
        Type.Literal("expiring_90d"),
        Type.Literal("expiring_60d"),
        Type.Literal("expiring_30d"),
        Type.Literal("expiring_7d"),
        Type.Literal("expired"),
      ]),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
];

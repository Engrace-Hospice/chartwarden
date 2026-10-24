// apps/backend/src/modules/32-ai-platform/governance/store-drizzle.ts — the Drizzle implementations of
// M32-T03's two governance stores.
//
// THE CREDENTIAL SPLIT IS THE WHOLE FILE. §3.3 / migration 0116:
//
//   · `createDrizzleAiCapabilityRegistryStore` writes `ai_capability`,
//     `ai_capability_lifecycle_event` and `ai_capability_calibration`, which grant `chartwarden_app` SELECT
//     ONLY. Its writes therefore run through `withPlatformContext` on the separately-pooled platform
//     credential, gated by the tenancy allowlist (`M32_PLATFORM_JOB_ID`, registered by
//     `wireM32Tenancy()`) and audited by the `platform.bypass_invoked` auditor. Reads take the ORDINARY
//     tenant handle: `ai_capability_read` is `USING (true)` for `chartwarden_app`, so listing the registry
//     needs no bypass and must not take one — a cross-tenant credential opened for a read a tenant
//     connection can already do is an audited bypass that teaches operators to ignore the alert.
//   · `createDrizzleAiTenantConsentStore` writes `ai_tenant_opt_in_record` and `ai_clinician_opt_out`,
//     both org-scoped, so EVERY method opens `withOrgContext` and RLS on `app.org_id` is what makes one
//     agency's consent invisible to the next. No method takes an org id it does not also pin into the
//     session variable — passing one without the other would read across tenants on a
//     BYPASSRLS-granted role and pass every test that did not check for it.
//
// TIMESTAMPS CROSS THE PORT AS ISO STRINGS, NOT `Date`. The pure rules in `@chartwarden/ai-platform` do
// date arithmetic on ISO instants and the in-memory store holds strings; a port that leaked `Date` here
// would make the two stores structurally different and the slice tests would stop proving anything
// about this one.
import { type DbClient, schema } from "@chartwarden/db";
import {
  type PlatformBypassAuditor,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import type { AiModelBackendKind, AiRoutingPreference } from "@chartwarden/types";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type M32EventEmitter, capabilityIdentity } from "../events";

import type {
  AiCalibrationRow,
  AiCapabilityGovernanceRow,
  AiCapabilityRegistryStore,
  AiClinicianOptOutRow,
  AiLifecycleEventRow,
  AiTenantConsentStore,
  AiTenantOptInRow,
} from "./store";

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

type CapabilitySelect = typeof schema.aiCapability.$inferSelect;
type LifecycleEventSelect = typeof schema.aiCapabilityLifecycleEvent.$inferSelect;
type CalibrationSelect = typeof schema.aiCapabilityCalibration.$inferSelect;
type OptInSelect = typeof schema.aiTenantOptInRecord.$inferSelect;
type OptOutSelect = typeof schema.aiClinicianOptOut.$inferSelect;

function toCapabilityRow(row: CapabilitySelect): AiCapabilityGovernanceRow {
  return {
    id: row.id,
    capabilityKey: row.capabilityKey,
    displayName: row.displayName,
    riskTier: row.riskTier,
    lifecycleState: row.lifecycleState,
    defaultBackendKey: row.defaultBackendKey,
    allowedBackendKeys: asStringArray(row.allowedBackendKeys),
    tenantOptInRequired: row.tenantOptInRequired,
    clinicianOptOutSupported: row.clinicianOptOutSupported,
    currentPromptTemplateKey: row.currentPromptTemplateKey,
    firstApprovedAt: iso(row.firstApprovedAt),
    lastReapprovedAt: iso(row.lastReapprovedAt),
    nextReapprovalDueAt: iso(row.nextReapprovalDueAt),
  };
}

function toLifecycleEventRow(row: LifecycleEventSelect): AiLifecycleEventRow {
  return {
    id: row.id,
    capabilityId: row.capabilityId,
    fromState: row.fromState,
    toState: row.toState,
    actorMembershipId: row.actorMembershipId,
    actorRole: row.actorRole,
    approvalKind: row.approvalKind,
    reason: row.reason,
    rationaleText: row.rationaleText,
    linkedEvaluationRunId: row.linkedEvaluationRunId,
    stageArtifacts: (row.stageArtifacts ?? {}) as Record<string, unknown>,
    transitionedAt: isoRequired(row.transitionedAt),
  };
}

function toCalibrationRow(row: CalibrationSelect): AiCalibrationRow {
  return {
    id: row.id,
    capabilityId: row.capabilityId,
    backendKey: row.backendKey,
    thresholds: row.thresholds,
    baselineMetrics: row.baselineMetrics,
    baselineSetAt: isoRequired(row.baselineSetAt),
    baselineEvaluationRunId: row.baselineEvaluationRunId,
    isCurrent: row.isCurrent,
    supersededReason: row.supersededReason,
    supersededById: row.supersededById,
    createdAt: isoRequired(row.createdAt),
    supersededAt: iso(row.supersededAt),
  };
}

function toOptInRow(row: OptInSelect): AiTenantOptInRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    capabilityId: row.capabilityId,
    status: row.status,
    orgAdminMembershipId: row.orgAdminMembershipId,
    routingPreferenceSnapshot: row.routingPreferenceSnapshot as AiRoutingPreference,
    pilotEnrollment: row.pilotEnrollment,
    optedInAt: iso(row.optedInAt),
    pausedAt: iso(row.pausedAt),
    pausedReason: row.pausedReason,
    optedOutAt: iso(row.optedOutAt),
    optedOutReason: row.optedOutReason,
  };
}

function toOptOutRow(row: OptOutSelect): AiClinicianOptOutRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    membershipId: row.membershipId,
    capabilityId: row.capabilityId,
    optedOut: row.optedOut,
    reason: row.reason,
    optedOutAt: isoRequired(row.optedOutAt),
    revertedAt: iso(row.revertedAt),
  };
}

/** What the platform-shared store needs to open its audited bypass. */
export interface AiCapabilityRegistryStoreDeps {
  /** The ORDINARY tenant handle — reads only (`ai_capability_read` is `USING (true)`). */
  readonly db: DbClient;
  /** The separately-pooled platform login role; every WRITE goes through it. */
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  /** The allowlisted job id (`M32_PLATFORM_JOB_ID`; `wireM32Tenancy()` registered it). */
  readonly jobId: string;
  /** GAP-161 - same-tx `m32.capability.*` emits (absent in slice/tests). */
  readonly events?: M32EventEmitter;
}

/** The §3.3 PLATFORM-SHARED half: reads on the tenant handle, writes under an audited bypass. */
export function createDrizzleAiCapabilityRegistryStore(
  deps: AiCapabilityRegistryStoreDeps,
): AiCapabilityRegistryStore {
  function asAdmin<T>(reason: string, fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return withPlatformContext<DbClient, T>(
      deps.platformDb,
      // `crossTenant: false` — a capability registry write touches no tenant's rows. The bypass is a
      // PRIVILEGE escalation (chartwarden_admin), not a tenant-boundary crossing, and marking it critical
      // would put a page-worthy severity on every routine governance edit.
      { jobId: deps.jobId, reason, crossTenant: false },
      deps.auditBypass,
      fn,
    );
  }

  return {
    findCapabilityById: async (capabilityId) => {
      const [row] = await deps.db
        .select()
        .from(schema.aiCapability)
        .where(eq(schema.aiCapability.id, capabilityId))
        .limit(1);
      return row ? toCapabilityRow(row) : null;
    },

    findCapabilityByKey: async (capabilityKey) => {
      const [row] = await deps.db
        .select()
        .from(schema.aiCapability)
        .where(eq(schema.aiCapability.capabilityKey, capabilityKey))
        .limit(1);
      return row ? toCapabilityRow(row) : null;
    },

    listCapabilities: async () => {
      const rows = await deps.db
        .select()
        .from(schema.aiCapability)
        .orderBy(schema.aiCapability.capabilityKey);
      return rows.map(toCapabilityRow);
    },

    registerCapability: (insert, event) =>
      asAdmin(`register AI capability ${insert.capabilityKey} (M32 §2.2 R1)`, async (tx) => {
        const [row] = await tx
          .insert(schema.aiCapability)
          .values({
            capabilityKey: insert.capabilityKey,
            displayName: insert.displayName,
            description: insert.description,
            riskTier: insert.riskTier,
            lifecycleState: "PROPOSED",
            defaultBackendKey: insert.defaultBackendKey,
            allowedBackendKeys: [...insert.allowedBackendKeys],
            fallbackChainKeys: [...insert.fallbackChainKeys],
            tenantOverrideAllowed: insert.tenantOverrideAllowed,
            tenantOptInRequired: insert.tenantOptInRequired,
            clinicianOptOutSupported: insert.clinicianOptOutSupported,
            clinicalReviewRequired: insert.clinicalReviewRequired,
            owningRole: insert.owningRole,
            currentPromptTemplateKey: insert.currentPromptTemplateKey,
          })
          .returning();
        if (!row) throw new Error(`ai_capability ${insert.capabilityKey} insert returned no row`);
        await tx.insert(schema.aiCapabilityLifecycleEvent).values({
          capabilityId: row.id,
          fromState: event.fromState,
          toState: event.toState,
          actorMembershipId: event.actorMembershipId,
          actorRole: event.actorRole,
          approvalKind: event.approvalKind,
          reason: event.reason,
          rationaleText: event.rationaleText,
          linkedEvaluationRunId: event.linkedEvaluationRunId,
          stageArtifacts: event.stageArtifacts,
          transitionedAt: new Date(event.transitionedAt),
        });
        await deps.events?.emitInTx(tx, {
          name: "m32.capability.created",
          organizationId: null,
          aggregate: { kind: "ai_capability", id: row.id },
          payload: {
            capabilityId: row.id,
            capabilityKey: row.capabilityKey,
            riskTier: row.riskTier,
            lifecycleState: row.lifecycleState,
            createdByMembershipId: event.actorMembershipId,
          },
        });
        return toCapabilityRow(row);
      }),

    applyTransition: (capabilityId, patch, event) =>
      asAdmin(
        `transition AI capability ${capabilityId} to ${patch.lifecycleState} (M32 §2.2 R4)`,
        async (tx) => {
          const [row] = await tx
            .update(schema.aiCapability)
            .set({
              lifecycleState: patch.lifecycleState,
              ...(patch.firstApprovedAt === undefined
                ? {}
                : { firstApprovedAt: new Date(patch.firstApprovedAt) }),
              ...(patch.lastReapprovedAt === undefined
                ? {}
                : { lastReapprovedAt: new Date(patch.lastReapprovedAt) }),
              nextReapprovalDueAt:
                patch.nextReapprovalDueAt === null ? null : new Date(patch.nextReapprovalDueAt),
              updatedAt: new Date(event.transitionedAt),
            })
            .where(eq(schema.aiCapability.id, capabilityId))
            .returning();
          if (!row) throw new Error(`ai_capability ${capabilityId} disappeared mid-transition`);
          await tx.insert(schema.aiCapabilityLifecycleEvent).values({
            capabilityId,
            fromState: event.fromState,
            toState: event.toState,
            actorMembershipId: event.actorMembershipId,
            actorRole: event.actorRole,
            approvalKind: event.approvalKind,
            reason: event.reason,
            rationaleText: event.rationaleText,
            linkedEvaluationRunId: event.linkedEvaluationRunId,
            stageArtifacts: event.stageArtifacts,
            transitionedAt: new Date(event.transitionedAt),
          });
          await deps.events?.emitInTx(tx, {
            name: "m32.capability.transitioned",
            organizationId: null,
            aggregate: { kind: "ai_capability", id: row.id },
            payload: {
              capabilityId: row.id,
              capabilityKey: row.capabilityKey,
              previousState: event.fromState,
              newState: event.toState,
              approvalKind: event.approvalKind,
              transitionedByMembershipId: event.actorMembershipId,
              rationale: event.rationaleText,
              linkedEvaluationRunId: event.linkedEvaluationRunId ?? null,
            },
          });
          return toCapabilityRow(row);
        },
      ),

    listLifecycleEvents: async (capabilityId) => {
      const rows = await deps.db
        .select()
        .from(schema.aiCapabilityLifecycleEvent)
        .where(eq(schema.aiCapabilityLifecycleEvent.capabilityId, capabilityId))
        .orderBy(desc(schema.aiCapabilityLifecycleEvent.transitionedAt));
      return rows.map(toLifecycleEventRow);
    },

    findCurrentCalibration: async (capabilityId, backendKey) => {
      const [row] = await deps.db
        .select()
        .from(schema.aiCapabilityCalibration)
        .where(
          and(
            eq(schema.aiCapabilityCalibration.capabilityId, capabilityId),
            eq(schema.aiCapabilityCalibration.backendKey, backendKey),
            eq(schema.aiCapabilityCalibration.isCurrent, true),
          ),
        )
        .limit(1);
      return row ? toCalibrationRow(row) : null;
    },

    publishCalibration: (capabilityId, plan, calibratedByMembershipId) =>
      asAdmin(
        `publish calibration for AI capability ${capabilityId}/${plan.insert.backendKey} (M32 §3.2.3 R5)`,
        async (tx) => {
          const [inserted] = await tx
            .insert(schema.aiCapabilityCalibration)
            .values({
              capabilityId,
              backendKey: plan.insert.backendKey,
              thresholds: plan.insert.thresholds,
              baselineMetrics: plan.insert.baselineMetrics,
              baselineSetAt: new Date(plan.insert.baselineSetAt),
              baselineEvaluationRunId: plan.insert.baselineEvaluationRunId,
              isCurrent: true,
            })
            .returning();
          if (!inserted) throw new Error("ai_capability_calibration insert returned no row");
          if (plan.supersede) {
            // Ordered AFTER the insert on purpose: `superseded_by_id` points at the row that replaced
            // it, and §3.2.3 keeps that column a LOGICAL self-reference precisely so both writes can
            // sit in one transaction without a circular FK forcing an impossible order. The partial
            // unique index tolerates the momentary two-current state only because the supersede lands
            // before COMMIT — which is why these are one store method and not two.
            await tx
              .update(schema.aiCapabilityCalibration)
              .set({
                isCurrent: false,
                supersededReason: plan.supersede.supersededReason,
                supersededAt: new Date(plan.supersede.supersededAt),
                supersededById: inserted.id,
              })
              .where(eq(schema.aiCapabilityCalibration.id, plan.supersede.calibrationId));
          }
          if (deps.events) {
            await deps.events.emitInTx(tx, {
              name: "m32.capability.calibrated",
              organizationId: null,
              aggregate: { kind: "ai_capability", id: capabilityId },
              payload: {
                ...(await capabilityIdentity(tx, { id: capabilityId })),
                calibrationId: inserted.id,
                supersededCalibrationId: plan.supersede?.calibrationId ?? null,
                backendKey: plan.insert.backendKey,
                calibratedByMembershipId: calibratedByMembershipId ?? "unattributed",
              },
            });
          }
          return toCalibrationRow(inserted);
        },
      ),

    listCalibrationHistory: async (capabilityId, backendKey) => {
      const rows = await deps.db
        .select()
        .from(schema.aiCapabilityCalibration)
        .where(
          backendKey
            ? and(
                eq(schema.aiCapabilityCalibration.capabilityId, capabilityId),
                eq(schema.aiCapabilityCalibration.backendKey, backendKey),
              )
            : eq(schema.aiCapabilityCalibration.capabilityId, capabilityId),
        )
        .orderBy(desc(schema.aiCapabilityCalibration.createdAt));
      return rows.map(toCalibrationRow);
    },

    resolveBackendKinds: async (backendKeys) => {
      const out = new Map<string, AiModelBackendKind>();
      if (backendKeys.length === 0) return out;
      const rows = await deps.db
        .select({
          backendKey: schema.aiModelBackend.backendKey,
          kind: schema.aiModelBackend.kind,
          isActive: schema.aiModelBackend.isActive,
        })
        .from(schema.aiModelBackend)
        .where(inArray(schema.aiModelBackend.backendKey, [...backendKeys]));
      for (const row of rows) {
        // An INACTIVE backend is not a route (§2.3 registers one inactive "for lifecycle continuity"),
        // so it must not make a `local_only` opt-in legal. Omitting it is the same fail-closed answer
        // as a key with no row at all.
        if (row.isActive) out.set(row.backendKey, row.kind);
      }
      return out;
    },
  };
}

/** The §3.3 TENANT-SCOPED half: every method under `withOrgContext` (RLS on `app.org_id`). */
export function createDrizzleAiTenantConsentStore(deps: {
  readonly db: DbClient;
  /** `app.user_id` for the session; the M4 write-audit trigger reads it. */
  readonly userId: string;
  /** GAP-161 - same-tx `m32.tenant_opt_in.*` / `m32.clinician_opt_out.recorded` emits. */
  readonly events?: M32EventEmitter;
}): AiTenantConsentStore {
  const ctx = (organizationId: string) => ({ organizationId, userId: deps.userId });

  return {
    findOptIn: (organizationId, capabilityId) =>
      withOrgContext(deps.db, ctx(organizationId), async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.aiTenantOptInRecord)
          .where(
            and(
              eq(schema.aiTenantOptInRecord.organizationId, organizationId),
              eq(schema.aiTenantOptInRecord.capabilityId, capabilityId),
            ),
          )
          .limit(1);
        return row ? toOptInRow(row) : null;
      }),

    listOptIns: (organizationId) =>
      withOrgContext(deps.db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select()
          .from(schema.aiTenantOptInRecord)
          .where(eq(schema.aiTenantOptInRecord.organizationId, organizationId));
        return rows.map(toOptInRow);
      }),

    upsertOptIn: (organizationId, capabilityId, write) =>
      withOrgContext(deps.db, ctx(organizationId), async (tx) => {
        const now = new Date();
        const [row] = await tx
          .insert(schema.aiTenantOptInRecord)
          .values({
            organizationId,
            capabilityId,
            status: write.status,
            orgAdminMembershipId: write.orgAdminMembershipId,
            disclosureAcknowledgments: write.disclosureAcknowledgments ?? {},
            routingPreferenceSnapshot: write.routingPreferenceSnapshot ?? "prefer_cloud",
            calibrationTradeOffAcknowledged: write.calibrationTradeOffAcknowledged ?? null,
            pilotEnrollment: write.pilotEnrollment ?? false,
            optedInAt: write.optedInAt ? new Date(write.optedInAt) : null,
            pausedAt: write.pausedAt ? new Date(write.pausedAt) : null,
            pausedReason: write.pausedReason ?? null,
            optedOutAt: write.optedOutAt ? new Date(write.optedOutAt) : null,
            optedOutReason: write.optedOutReason ?? null,
          })
          .onConflictDoUpdate({
            target: [
              schema.aiTenantOptInRecord.organizationId,
              schema.aiTenantOptInRecord.capabilityId,
            ],
            // Only the columns the caller SUPPLIED are overwritten. A withdrawal names no
            // acknowledgments, and clobbering them with `{}` would destroy the frozen evidence of what
            // the admin agreed to — the one thing §3.2.6 keeps the column for.
            set: {
              status: write.status,
              orgAdminMembershipId: write.orgAdminMembershipId,
              ...(write.disclosureAcknowledgments === undefined
                ? {}
                : { disclosureAcknowledgments: write.disclosureAcknowledgments }),
              ...(write.routingPreferenceSnapshot === undefined
                ? {}
                : { routingPreferenceSnapshot: write.routingPreferenceSnapshot }),
              ...(write.calibrationTradeOffAcknowledged === undefined
                ? {}
                : { calibrationTradeOffAcknowledged: write.calibrationTradeOffAcknowledged }),
              ...(write.pilotEnrollment === undefined
                ? {}
                : { pilotEnrollment: write.pilotEnrollment }),
              ...(write.optedInAt === undefined
                ? {}
                : { optedInAt: write.optedInAt ? new Date(write.optedInAt) : null }),
              ...(write.pausedAt === undefined
                ? {}
                : { pausedAt: write.pausedAt ? new Date(write.pausedAt) : null }),
              ...(write.pausedReason === undefined ? {} : { pausedReason: write.pausedReason }),
              ...(write.optedOutAt === undefined
                ? {}
                : { optedOutAt: write.optedOutAt ? new Date(write.optedOutAt) : null }),
              ...(write.optedOutReason === undefined
                ? {}
                : { optedOutReason: write.optedOutReason }),
              updatedAt: now,
            },
          })
          .returning();
        if (!row) throw new Error("ai_tenant_opt_in_record upsert returned no row");
        if (deps.events) {
          const identity = await capabilityIdentity(tx, { id: capabilityId });
          const ack = (row.disclosureAcknowledgments ?? {}) as Record<string, unknown>;
          await deps.events.emitInTx(tx, {
            name:
              row.status === "active" ? "m32.tenant_opt_in.recorded" : "m32.tenant_opt_in.revoked",
            organizationId,
            aggregate: { kind: "ai_tenant_opt_in_record", id: row.id },
            payload:
              row.status === "active"
                ? {
                    ...identity,
                    tenantOptInId: row.id,
                    acknowledgedByMembershipId: write.orgAdminMembershipId,
                    routingMode: row.routingPreferenceSnapshot,
                    baaReference: typeof ack.baaReference === "string" ? ack.baaReference : null,
                    zdrAcknowledged: typeof ack.zdrContractReference === "string",
                    pilotEnrollment: row.pilotEnrollment,
                  }
                : {
                    ...identity,
                    tenantOptInId: row.id,
                    revokedByMembershipId: write.orgAdminMembershipId,
                    mode: row.status === "paused" ? "paused" : "withdrawn",
                    reason: row.status === "paused" ? row.pausedReason : row.optedOutReason,
                  },
          });
        }
        return toOptInRow(row);
      }),

    findLiveOptOut: (organizationId, membershipId, capabilityId) =>
      withOrgContext(deps.db, ctx(organizationId), async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.aiClinicianOptOut)
          .where(
            and(
              eq(schema.aiClinicianOptOut.organizationId, organizationId),
              eq(schema.aiClinicianOptOut.membershipId, membershipId),
              eq(schema.aiClinicianOptOut.capabilityId, capabilityId),
              eq(schema.aiClinicianOptOut.optedOut, true),
              isNull(schema.aiClinicianOptOut.revertedAt),
            ),
          )
          .limit(1);
        return row ? toOptOutRow(row) : null;
      }),

    listOptOuts: (organizationId, membershipId) =>
      withOrgContext(deps.db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select()
          .from(schema.aiClinicianOptOut)
          .where(
            and(
              eq(schema.aiClinicianOptOut.organizationId, organizationId),
              eq(schema.aiClinicianOptOut.membershipId, membershipId),
            ),
          )
          .orderBy(desc(schema.aiClinicianOptOut.optedOutAt));
        return rows.map(toOptOutRow);
      }),

    insertOptOut: (row) =>
      withOrgContext(deps.db, ctx(row.organizationId), async (tx) => {
        const [inserted] = await tx
          .insert(schema.aiClinicianOptOut)
          .values({
            organizationId: row.organizationId,
            membershipId: row.membershipId,
            capabilityId: row.capabilityId,
            optedOut: true,
            reason: row.reason,
            optedOutAt: new Date(row.optedOutAt),
          })
          .returning();
        if (!inserted) throw new Error("ai_clinician_opt_out insert returned no row");
        await deps.events?.emitInTx(tx, {
          name: "m32.clinician_opt_out.recorded",
          organizationId: row.organizationId,
          aggregate: { kind: "ai_clinician_opt_out", id: inserted.id },
          payload: {
            ...(await capabilityIdentity(tx, { id: row.capabilityId })),
            optOutId: inserted.id,
            membershipId: row.membershipId,
          },
        });
        return toOptOutRow(inserted);
      }),

    revertOptOut: (organizationId, optOutId, revertedAt) =>
      withOrgContext(deps.db, ctx(organizationId), async (tx) => {
        const [row] = await tx
          .update(schema.aiClinicianOptOut)
          .set({ revertedAt: new Date(revertedAt), updatedAt: sql`now()` })
          .where(
            and(
              eq(schema.aiClinicianOptOut.id, optOutId),
              eq(schema.aiClinicianOptOut.organizationId, organizationId),
              isNull(schema.aiClinicianOptOut.revertedAt),
            ),
          )
          .returning();
        if (!row) throw new Error(`ai_clinician_opt_out ${optOutId} is not live for this org`);
        return toOptOutRow(row);
      }),
  };
}

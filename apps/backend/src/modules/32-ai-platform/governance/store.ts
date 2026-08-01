// apps/backend/src/modules/32-ai-platform/governance/store.ts — the data PORTS the M32-T03 governance
// services compose over, plus an in-memory implementation for the slice tests.
//
// TWO STORES, NOT ONE, BECAUSE THE TWO HALVES RUN UNDER DIFFERENT CREDENTIALS. §3.3 splits M32's
// tables in two and the split is a privilege boundary, not a naming convention:
//
//   · `ai_capability`, `ai_capability_lifecycle_event`, `ai_capability_calibration` are
//     PLATFORM-SHARED. Migration 0116 grants `wardenx_app` SELECT and nothing else; every write goes
//     through `wardenx_admin` on the separately-pooled platform credential, gated by the tenancy
//     allowlist and audited by the platform-bypass auditor. That is deliberate: the AI Safety Owner is
//     a PLATFORM role (§4.7), and a tenant connection that could promote a capability could promote it
//     for every other tenant too.
//   · `ai_tenant_opt_in_record` and `ai_clinician_opt_out` are TENANT-SCOPED and run under
//     `withOrgContext`, where RLS keyed on `app.org_id` is what makes one agency's opt-in invisible to
//     the next.
//
// Merging them into one store would mean one of the two halves ran under the wrong credential, and the
// direction that fails silently — a tenant-scoped read on the platform pool — is the one that bypasses
// RLS. So the ports are separate and the services take exactly the ones they need.
//
// The ports are NARROW ON PURPOSE: no `db` handle reaches a governance service, so every rule in
// `@wardenx/ai-platform/governance` is exercised against the in-memory store in the slice tests and the
// Drizzle implementation carries no branch a test cannot reach.
import type {
  AiCapabilityLifecycleState,
  AiCapabilityOwningRole,
  AiCapabilityRiskTier,
  AiLifecycleApprovalKind,
  AiModelBackendKind,
  AiRoutingPreference,
  AiTenantOptInStatus,
} from "@wardenx/types";

// ── projections ────────────────────────────────────────────────────────────────────────────────────

/** The `ai_capability` columns the governance layer reads. Deliberately not the whole row: the
 *  marketing template, the SaMD posture and the timestamps the gates never consult stay out, so a
 *  service cannot start depending on a column nobody decided it should see. */
export interface AiCapabilityGovernanceRow {
  readonly id: string;
  readonly capabilityKey: string;
  readonly displayName: string;
  readonly riskTier: AiCapabilityRiskTier;
  readonly lifecycleState: AiCapabilityLifecycleState;
  readonly defaultBackendKey: string;
  readonly allowedBackendKeys: readonly string[];
  readonly tenantOptInRequired: boolean;
  readonly clinicianOptOutSupported: boolean;
  readonly currentPromptTemplateKey: string | null;
  /** ISO instants. */
  readonly firstApprovedAt: string | null;
  readonly lastReapprovedAt: string | null;
  readonly nextReapprovalDueAt: string | null;
}

/** The `ai_capability_lifecycle_event` row a transition appends (the ledger entry). */
export interface AiLifecycleEventInsert {
  readonly capabilityId: string;
  readonly fromState: AiCapabilityLifecycleState | null;
  readonly toState: AiCapabilityLifecycleState;
  readonly actorMembershipId: string;
  readonly actorRole: AiCapabilityOwningRole;
  readonly approvalKind: AiLifecycleApprovalKind;
  readonly reason: string;
  readonly rationaleText: string;
  readonly linkedEvaluationRunId: string | null;
  readonly stageArtifacts: Record<string, unknown>;
  readonly transitionedAt: string;
}

/** A `ai_capability_lifecycle_event` row as read back. */
export interface AiLifecycleEventRow extends AiLifecycleEventInsert {
  readonly id: string;
}

/** The `ai_capability_calibration` columns the publication path reads/writes. */
export interface AiCalibrationRow {
  readonly id: string;
  readonly capabilityId: string;
  readonly backendKey: string;
  readonly thresholds: unknown;
  readonly baselineMetrics: unknown;
  readonly baselineSetAt: string;
  readonly baselineEvaluationRunId: string;
  readonly isCurrent: boolean;
  readonly supersededReason: string | null;
  readonly supersededById: string | null;
  readonly createdAt: string;
  readonly supersededAt: string | null;
}

/** `ai_tenant_opt_in_record`, projected. */
export interface AiTenantOptInRow {
  readonly id: string;
  readonly organizationId: string;
  readonly capabilityId: string;
  readonly status: AiTenantOptInStatus;
  readonly orgAdminMembershipId: string;
  readonly routingPreferenceSnapshot: AiRoutingPreference;
  readonly pilotEnrollment: boolean;
  readonly optedInAt: string | null;
  readonly pausedAt: string | null;
  readonly pausedReason: string | null;
  readonly optedOutAt: string | null;
  readonly optedOutReason: string | null;
}

/** `ai_clinician_opt_out`, projected. */
export interface AiClinicianOptOutRow {
  readonly id: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly capabilityId: string;
  readonly optedOut: boolean;
  readonly reason: string | null;
  readonly optedOutAt: string;
  readonly revertedAt: string | null;
}

// ── ports ──────────────────────────────────────────────────────────────────────────────────────────

/** What a capability registration writes (the PROPOSED row plus its registration ledger entry). */
export interface AiCapabilityRegistrationInsert {
  readonly capabilityKey: string;
  readonly displayName: string;
  readonly description: string;
  readonly riskTier: AiCapabilityRiskTier;
  readonly defaultBackendKey: string;
  readonly allowedBackendKeys: readonly string[];
  readonly fallbackChainKeys: readonly string[];
  readonly tenantOverrideAllowed: boolean;
  readonly tenantOptInRequired: boolean;
  readonly clinicianOptOutSupported: boolean;
  readonly clinicalReviewRequired: boolean;
  readonly owningRole: AiCapabilityOwningRole;
  readonly currentPromptTemplateKey: string | null;
}

/**
 * The PLATFORM-SHARED half (`wardenx_admin`, allowlisted + audited platform context).
 *
 * `applyTransition` and `publishCalibration` are single methods rather than a patch plus an insert
 * because both are TWO writes that must not be separable: a lifecycle patch with no ledger row is a
 * capability that moved with nobody accountable, and a calibration insert with no supersede violates
 * `ai_cap_calib_current_per_backend_idx` outright.
 */
export interface AiCapabilityRegistryStore {
  findCapabilityById(capabilityId: string): Promise<AiCapabilityGovernanceRow | null>;
  findCapabilityByKey(capabilityKey: string): Promise<AiCapabilityGovernanceRow | null>;
  listCapabilities(): Promise<readonly AiCapabilityGovernanceRow[]>;
  /** Insert the PROPOSED row and its `from_state IS NULL` registration ledger entry in one tx. */
  registerCapability(
    insert: AiCapabilityRegistrationInsert,
    event: Omit<AiLifecycleEventInsert, "capabilityId">,
  ): Promise<AiCapabilityGovernanceRow>;
  /** Patch `ai_capability` and append the ledger entry in ONE tx (see above). */
  applyTransition(
    capabilityId: string,
    patch: {
      readonly lifecycleState: AiCapabilityLifecycleState;
      readonly firstApprovedAt?: string;
      readonly lastReapprovedAt?: string;
      readonly nextReapprovalDueAt: string | null;
    },
    event: AiLifecycleEventInsert,
  ): Promise<AiCapabilityGovernanceRow>;
  listLifecycleEvents(capabilityId: string): Promise<readonly AiLifecycleEventRow[]>;
  findCurrentCalibration(
    capabilityId: string,
    backendKey: string,
  ): Promise<AiCalibrationRow | null>;
  /** Supersede the incumbent (when the plan names one) and insert the new current row in ONE tx. */
  publishCalibration(
    capabilityId: string,
    plan: {
      readonly supersede: {
        readonly calibrationId: string;
        readonly supersededReason: string;
        readonly supersededAt: string;
      } | null;
      readonly insert: {
        readonly backendKey: string;
        readonly thresholds: unknown;
        readonly baselineMetrics: unknown;
        readonly baselineSetAt: string;
        readonly baselineEvaluationRunId: string;
      };
    },
  ): Promise<AiCalibrationRow>;
  listCalibrationHistory(
    capabilityId: string,
    backendKey?: string,
  ): Promise<readonly AiCalibrationRow[]>;
  /** `ai_model_backend.kind` for each key, so the §10.8 routing guard knows what exists. A key with no
   *  registered backend is ABSENT from the map — never defaulted to a kind, because guessing `local`
   *  would let a `local_only` opt-in through onto a backend nobody registered. */
  resolveBackendKinds(
    backendKeys: readonly string[],
  ): Promise<ReadonlyMap<string, AiModelBackendKind>>;
}

/** The values written when a tenant opt-in is recorded, paused or withdrawn. */
export interface AiTenantOptInWrite {
  readonly status: AiTenantOptInStatus;
  readonly orgAdminMembershipId: string;
  readonly disclosureAcknowledgments?: Record<string, unknown>;
  readonly routingPreferenceSnapshot?: AiRoutingPreference;
  readonly calibrationTradeOffAcknowledged?: string | null;
  readonly pilotEnrollment?: boolean;
  readonly optedInAt?: string | null;
  readonly pausedAt?: string | null;
  readonly pausedReason?: string | null;
  readonly optedOutAt?: string | null;
  readonly optedOutReason?: string | null;
}

/** The TENANT-SCOPED half (`wardenx_app` under `withOrgContext`; RLS on `app.org_id`). */
export interface AiTenantConsentStore {
  findOptIn(organizationId: string, capabilityId: string): Promise<AiTenantOptInRow | null>;
  listOptIns(organizationId: string): Promise<readonly AiTenantOptInRow[]>;
  /** Upsert on `ai_tenant_opt_in_org_cap_idx` — the row may already exist at `opted_out` from an
   *  abandoned workflow (§3.2.6's default), so a plain insert would collide. */
  upsertOptIn(
    organizationId: string,
    capabilityId: string,
    write: AiTenantOptInWrite,
  ): Promise<AiTenantOptInRow>;
  findLiveOptOut(
    organizationId: string,
    membershipId: string,
    capabilityId: string,
  ): Promise<AiClinicianOptOutRow | null>;
  listOptOuts(
    organizationId: string,
    membershipId: string,
  ): Promise<readonly AiClinicianOptOutRow[]>;
  insertOptOut(row: {
    readonly organizationId: string;
    readonly membershipId: string;
    readonly capabilityId: string;
    readonly reason: string | null;
    readonly optedOutAt: string;
  }): Promise<AiClinicianOptOutRow>;
  /** Sets `reverted_at` on the LIVE row — never deletes it (§3.2.7's partial index is why). */
  revertOptOut(
    organizationId: string,
    optOutId: string,
    revertedAt: string,
  ): Promise<AiClinicianOptOutRow>;
}

// ── in-memory implementation (slice tests) ─────────────────────────────────────────────────────────

/** Seed for {@link createInMemoryAiGovernanceStores}. */
export interface InMemoryAiGovernanceSeed {
  readonly capabilities?: readonly AiCapabilityGovernanceRow[];
  readonly backendKinds?: Readonly<Record<string, AiModelBackendKind>>;
  readonly optIns?: readonly AiTenantOptInRow[];
  readonly optOuts?: readonly AiClinicianOptOutRow[];
}

let inMemorySequence = 0;
function nextId(prefix: string): string {
  inMemorySequence += 1;
  return `${prefix}-${String(inMemorySequence).padStart(6, "0")}`;
}

/**
 * In-memory stores for the slice tests. Enforces the two invariants a test would otherwise silently
 * violate and then "pass" on: one current calibration per (capability, backend), and one LIVE opt-out
 * per (membership, capability). Those are the partial unique indexes; a fake that does not hold them
 * proves nothing about the real path.
 */
export function createInMemoryAiGovernanceStores(seed: InMemoryAiGovernanceSeed = {}): {
  registry: AiCapabilityRegistryStore;
  consent: AiTenantConsentStore;
  capabilities: AiCapabilityGovernanceRow[];
  lifecycleEvents: AiLifecycleEventRow[];
  calibrations: AiCalibrationRow[];
  optIns: AiTenantOptInRow[];
  optOuts: AiClinicianOptOutRow[];
} {
  const capabilities: AiCapabilityGovernanceRow[] = [...(seed.capabilities ?? [])];
  const lifecycleEvents: AiLifecycleEventRow[] = [];
  const calibrations: AiCalibrationRow[] = [];
  const optIns: AiTenantOptInRow[] = [...(seed.optIns ?? [])];
  const optOuts: AiClinicianOptOutRow[] = [...(seed.optOuts ?? [])];
  const backendKinds = new Map<string, AiModelBackendKind>(
    Object.entries(seed.backendKinds ?? {}) as [string, AiModelBackendKind][],
  );

  function replaceCapability(next: AiCapabilityGovernanceRow): AiCapabilityGovernanceRow {
    const i = capabilities.findIndex((c) => c.id === next.id);
    if (i < 0) throw new Error(`in-memory capability ${next.id} vanished`);
    capabilities[i] = next;
    return next;
  }

  const registry: AiCapabilityRegistryStore = {
    findCapabilityById: async (id) => capabilities.find((c) => c.id === id) ?? null,
    findCapabilityByKey: async (key) => capabilities.find((c) => c.capabilityKey === key) ?? null,
    listCapabilities: async () => [...capabilities],
    registerCapability: async (insert, event) => {
      const row: AiCapabilityGovernanceRow = {
        id: nextId("cap"),
        capabilityKey: insert.capabilityKey,
        displayName: insert.displayName,
        riskTier: insert.riskTier,
        lifecycleState: "PROPOSED",
        defaultBackendKey: insert.defaultBackendKey,
        allowedBackendKeys: [...insert.allowedBackendKeys],
        tenantOptInRequired: insert.tenantOptInRequired,
        clinicianOptOutSupported: insert.clinicianOptOutSupported,
        currentPromptTemplateKey: insert.currentPromptTemplateKey,
        firstApprovedAt: null,
        lastReapprovedAt: null,
        nextReapprovalDueAt: null,
      };
      capabilities.push(row);
      lifecycleEvents.push({ ...event, capabilityId: row.id, id: nextId("evt") });
      return row;
    },
    applyTransition: async (capabilityId, patch, event) => {
      const current = capabilities.find((c) => c.id === capabilityId);
      if (!current) throw new Error(`in-memory capability ${capabilityId} not found`);
      lifecycleEvents.push({ ...event, id: nextId("evt") });
      return replaceCapability({
        ...current,
        lifecycleState: patch.lifecycleState,
        firstApprovedAt: patch.firstApprovedAt ?? current.firstApprovedAt,
        lastReapprovedAt: patch.lastReapprovedAt ?? current.lastReapprovedAt,
        nextReapprovalDueAt: patch.nextReapprovalDueAt,
      });
    },
    listLifecycleEvents: async (capabilityId) =>
      lifecycleEvents.filter((e) => e.capabilityId === capabilityId),
    findCurrentCalibration: async (capabilityId, backendKey) =>
      calibrations.find(
        (c) => c.capabilityId === capabilityId && c.backendKey === backendKey && c.isCurrent,
      ) ?? null,
    publishCalibration: async (capabilityId, plan) => {
      const row: AiCalibrationRow = {
        id: nextId("calib"),
        capabilityId,
        backendKey: plan.insert.backendKey,
        thresholds: plan.insert.thresholds,
        baselineMetrics: plan.insert.baselineMetrics,
        baselineSetAt: plan.insert.baselineSetAt,
        baselineEvaluationRunId: plan.insert.baselineEvaluationRunId,
        isCurrent: true,
        supersededReason: null,
        supersededById: null,
        createdAt: plan.supersede?.supersededAt ?? plan.insert.baselineSetAt,
        supersededAt: null,
      };
      if (plan.supersede) {
        const i = calibrations.findIndex((c) => c.id === plan.supersede?.calibrationId);
        const prior = i < 0 ? undefined : calibrations[i];
        if (!prior) throw new Error("in-memory calibration to supersede not found");
        calibrations[i] = {
          ...prior,
          isCurrent: false,
          supersededReason: plan.supersede.supersededReason,
          supersededAt: plan.supersede.supersededAt,
          supersededById: row.id,
        };
      }
      // The partial unique index, held explicitly (see the factory's doc comment).
      const clash = calibrations.find(
        (c) => c.capabilityId === capabilityId && c.backendKey === row.backendKey && c.isCurrent,
      );
      if (clash) throw new Error("ai_cap_calib_current_per_backend_idx violated");
      calibrations.push(row);
      return row;
    },
    listCalibrationHistory: async (capabilityId, backendKey) =>
      calibrations.filter(
        (c) => c.capabilityId === capabilityId && (!backendKey || c.backendKey === backendKey),
      ),
    resolveBackendKinds: async (keys) => {
      const out = new Map<string, AiModelBackendKind>();
      for (const k of keys) {
        const kind = backendKinds.get(k);
        if (kind) out.set(k, kind);
      }
      return out;
    },
  };

  const consent: AiTenantConsentStore = {
    findOptIn: async (organizationId, capabilityId) =>
      optIns.find((r) => r.organizationId === organizationId && r.capabilityId === capabilityId) ??
      null,
    listOptIns: async (organizationId) =>
      optIns.filter((r) => r.organizationId === organizationId),
    upsertOptIn: async (organizationId, capabilityId, write) => {
      const i = optIns.findIndex(
        (r) => r.organizationId === organizationId && r.capabilityId === capabilityId,
      );
      const existing = i < 0 ? undefined : optIns[i];
      const base: AiTenantOptInRow = existing ?? {
            id: nextId("optin"),
            organizationId,
            capabilityId,
            status: "opted_out",
            orgAdminMembershipId: write.orgAdminMembershipId,
            routingPreferenceSnapshot: "prefer_cloud",
            pilotEnrollment: false,
            optedInAt: null,
            pausedAt: null,
            pausedReason: null,
            optedOutAt: null,
            optedOutReason: null,
          };
      const next: AiTenantOptInRow = {
        ...base,
        status: write.status,
        orgAdminMembershipId: write.orgAdminMembershipId,
        routingPreferenceSnapshot:
          write.routingPreferenceSnapshot ?? base.routingPreferenceSnapshot,
        pilotEnrollment: write.pilotEnrollment ?? base.pilotEnrollment,
        optedInAt: write.optedInAt === undefined ? base.optedInAt : write.optedInAt,
        pausedAt: write.pausedAt === undefined ? base.pausedAt : write.pausedAt,
        pausedReason: write.pausedReason === undefined ? base.pausedReason : write.pausedReason,
        optedOutAt: write.optedOutAt === undefined ? base.optedOutAt : write.optedOutAt,
        optedOutReason:
          write.optedOutReason === undefined ? base.optedOutReason : write.optedOutReason,
      };
      if (i >= 0) optIns[i] = next;
      else optIns.push(next);
      return next;
    },
    findLiveOptOut: async (organizationId, membershipId, capabilityId) =>
      optOuts.find(
        (r) =>
          r.organizationId === organizationId &&
          r.membershipId === membershipId &&
          r.capabilityId === capabilityId &&
          r.optedOut &&
          r.revertedAt === null,
      ) ?? null,
    listOptOuts: async (organizationId, membershipId) =>
      optOuts.filter(
        (r) => r.organizationId === organizationId && r.membershipId === membershipId,
      ),
    insertOptOut: async (row) => {
      const live = optOuts.find(
        (r) =>
          r.organizationId === row.organizationId &&
          r.membershipId === row.membershipId &&
          r.capabilityId === row.capabilityId &&
          r.optedOut &&
          r.revertedAt === null,
      );
      // The partial unique index, held explicitly.
      if (live) throw new Error("ai_clin_optout_member_cap_idx violated");
      const next: AiClinicianOptOutRow = {
        id: nextId("optout"),
        organizationId: row.organizationId,
        membershipId: row.membershipId,
        capabilityId: row.capabilityId,
        optedOut: true,
        reason: row.reason,
        optedOutAt: row.optedOutAt,
        revertedAt: null,
      };
      optOuts.push(next);
      return next;
    },
    revertOptOut: async (organizationId, optOutId, revertedAt) => {
      const i = optOuts.findIndex((r) => r.id === optOutId && r.organizationId === organizationId);
      const live = i < 0 ? undefined : optOuts[i];
      if (!live) throw new Error(`in-memory opt-out ${optOutId} not found`);
      const next: AiClinicianOptOutRow = { ...live, revertedAt };
      optOuts[i] = next;
      return next;
    },
  };

  return { registry, consent, capabilities, lifecycleEvents, calibrations, optIns, optOuts };
}

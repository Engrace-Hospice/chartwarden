// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/service.ts — M34 the
// TenantPlatformRouteService + an in-memory slice (§4.1 platform-ops tenant-lifecycle surface).
//
// The four platform-ops route plugins (tenants / tenant-invitations / key-ring / onboarding-templates)
// compose over this service. Mirrors the M22 routes/service.ts precedent EXACTLY:
//   - READ/LIST methods are fully live: in the slice they read the in-memory dataset; PRODUCTION injects
//     a Drizzle-backed service whose reads run under `withPlatformContext` (M1 @wardenx/tenancy — the
//     separately-pooled, RLS-bypass, AUDITED cross-tenant platform read path, F03/F09) so the Phase-3
//     platform-ops screens get real cross-tenant data. A missing tenant is a non-leaking 404.
//   - COMMAND methods (provision / transition / offboard / shred / dek-rotate / invite issue+revoke)
//     ENQUEUE the matching worker job through the injected {@link EnqueuePort} and return the job/row id;
//     the live BullMQ worker construction + the real lifecycle-transition wiring is Phase 2D (the TODO at
//     the foot of this file). The command methods here record the lifecycle intent + emit the outbox
//     descriptor; they do NOT directly mutate cross-tenant rows from the request thread.
import { NotFoundError, type OrgId, WardenXError } from "@wardenx/types";
import { type CursorPage, paginate } from "./concurrency";

// ── enqueue port (the thin worker-trigger seam the command routes inject) ─────────────────────────────

/** The §4.3 BullMQ queue names the M34 lifecycle-command routes enqueue to. */
export type M34QueueName =
  | "tenant.provision"
  | "tenant.dek_rotate"
  | "tenant.shred"
  | "tenant.export";

/**
 * The thin worker-trigger port the command routes call. In the slice it records the enqueue (so the
 * route tests assert the job was scheduled); PRODUCTION binds it to the @wardenx/shared transactional
 * outbox / the BullMQ producer (Phase 2D). Keeping it injected keeps the route layer free of any
 * BullMQ/Valkey import while the live worker construction is still pending.
 */
export interface EnqueuePort {
  enqueue(
    queue: M34QueueName,
    jobKey: string,
    payload: Record<string, unknown>,
  ): Promise<{ jobId: string }>;
}

// ── route DTOs (in-memory; the Drizzle adapter projects rows to the SAME shapes) ──────────────────────

export interface TenantSummaryView {
  readonly id: string;
  readonly organizationId: string;
  readonly orgSlug: string;
  readonly legalBusinessName: string;
  readonly status: string;
  readonly planLabel: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The §5.2 full overview the `GET /platform/tenants/:orgSlug` screen renders. */
export interface TenantOverview extends TenantSummaryView {
  readonly latestStatusEvent: {
    id: string;
    toStatus: string;
    occurredAt: string;
    reason: string;
  } | null;
  readonly keyRing: {
    currentDekVersion: string;
    dekLastRotatedAt: string | null;
    destroyedAt: string | null;
  } | null;
  readonly onboarding: { totalTasks: number; doneTasks: number; currentStep: string | null };
  readonly baa: { status: string; expiresOn: string | null } | null;
  readonly activeGrants: number;
  readonly activeSessions: number;
}

export interface TenantInvitationView {
  readonly id: string;
  readonly tenantAccountId: string;
  readonly firstAdminEmail: string;
  readonly status: string;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
}

/** The §3.5 metadata-only key-ring view (ciphertext is NEVER exposed; `tenant_key_ring_metadata_v`). */
export interface KeyRingMetadataView {
  readonly id: string;
  readonly tenantAccountId: string;
  readonly currentDekVersion: string;
  readonly currentDekKekId: string;
  readonly priorDekVersionCount: number;
  readonly dekCreatedAt: string;
  readonly dekLastRotatedAt: string | null;
  readonly destroyedAt: string | null;
  readonly destructionCertificateId: string | null;
}

export interface OnboardingTemplateView {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly canonicalOrder: number;
  readonly isCanonical: boolean;
  readonly createdAt: string;
}

// ── support sessions (§4.1; F01/D8/D16) ──
export interface SupportSessionView {
  readonly id: string;
  readonly organizationId: string;
  readonly supportConsentGrantId: string;
  readonly tenantAccountId: string | null;
  readonly actorMembershipId: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
  readonly status: "open" | "expired" | "closed";
}
export interface SupportSessionEventView {
  readonly id: string;
  readonly supportSessionId: string;
  readonly eventKind: string;
  readonly resourceKind: string | null;
  readonly resourceId: string | null;
  readonly occurredAt: string;
  readonly actorIp: string | null;
}
export interface StartSupportSessionArgs {
  readonly organizationId: string;
  readonly supportConsentGrantId: string;
  readonly actorMembershipId: string;
  readonly actorIp: string | null;
}
export interface ElevateSupportSessionArgs {
  readonly organizationId: string;
  readonly supportSessionId: string;
  readonly actorMembershipId: string;
  readonly actorIp: string | null;
}
export interface CloseSupportSessionArgs {
  readonly organizationId: string;
  readonly supportSessionId: string;
  readonly actorMembershipId: string;
  readonly actorIp: string | null;
}

// ── signup intents (§4.1; F02 / ADR-0010 — org-less, withPlatformContext) ──
export interface SignupIntentView {
  readonly id: string;
  readonly contactEmail: string;
  readonly legalBusinessName: string;
  readonly intendedFirstAdminEmail: string;
  readonly intentStatus: string;
  readonly source: string;
  readonly rejectionReason: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly tenantAccountId: string | null;
}

// ── platform-tenant BAA register (§3.8 / D11) ──
export interface BaaRecordView {
  readonly id: string;
  readonly organizationId: string;
  readonly tenantAccountId: string;
  readonly addendumVersion: string;
  readonly baaStatus: string;
  readonly executedOn: string | null;
  readonly effectiveOn: string | null;
  readonly expiresOn: string | null;
  readonly documentId: string | null;
  readonly attestedAt: string | null;
}
/**
 * A tenant-export job as the §4.1 platform-ops list renders it (GAP-098).
 *
 * `heldForOversizedApproval` is DERIVED from the ledger — the newest `tenant_export_job_event` is an
 * `oversized_hold` — not stored. It has to be: a SEC-052 hold gives the job no status of its own (it
 * stays `generating`, GAP-094), which is exactly why a held bundle was invisible. The derivation is the
 * same test `approveOversizedExport` makes, so a row flagged held here is one that route will accept.
 *
 * The `held*` fields come off that hold event's receipt, so they are populated only while held. They
 * are the operator's decision inputs: co-signing the release of a 60 GB bundle is a different act from
 * co-signing a 51 GB one, and the size is the reason the hold exists.
 */
export interface TenantExportJobView {
  readonly id: string;
  readonly organizationId: string;
  readonly requestedPurpose: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly fulfilledAt: string | null;
  readonly heldForOversizedApproval: boolean;
  /** bigint-as-text (migration 0195) — an oversized bundle is past a 32-bit column's ceiling. */
  readonly heldBundleSizeBytes: string | null;
  readonly heldRecordCount: number | null;
  readonly heldAt: string | null;
  readonly bundleSizeBytes: string | null;
  readonly bundleDownloadedAt: string | null;
}

/** Filters for the §4.1 platform-ops tenant-export list (GAP-098). */
export interface TenantExportJobListFilter {
  readonly organizationId?: string;
  readonly status?: string;
  /** Narrow to bundles awaiting a SEC-052 co-sign — the reason this route exists. */
  readonly held?: boolean;
}

export interface CreateBaaRecordArgs {
  readonly tenantAccountId: string;
  readonly addendumVersion: string;
  readonly baaStatus: string;
  readonly executedOn: string | null;
  readonly effectiveOn: string | null;
  readonly expiresOn: string | null;
  readonly breachNotificationContactEmail: string | null;
  readonly breachNotificationContactPhone: string | null;
}
export interface UpdateBaaRecordArgs {
  readonly baaStatus?: string;
  readonly executedOn?: string;
  readonly effectiveOn?: string;
  readonly expiresOn?: string;
  readonly breachNotificationContactEmail?: string;
  readonly breachNotificationContactPhone?: string;
  readonly documentId?: string;
}

// ── feature-flag admin (§4.7 / D13 — M34 routes/UI; M1 owns schema + FeatureFlagAdmin seam) ──
export interface FeatureFlagView {
  readonly id: string;
  readonly flagKey: string;
  readonly organizationId: string | null;
  readonly flagKind: string;
  readonly valueType: string;
  readonly value: unknown;
  readonly rolloutPercent: number | null;
  readonly killSwitchActive: boolean;
  readonly updatedAt: string;
}
export interface UpsertFeatureFlagArgs {
  readonly flagKey: string;
  readonly organizationId: string | null;
  readonly flagKind: string;
  readonly valueType: string;
  readonly value: unknown;
  readonly rolloutPercent: number | null;
  readonly rationale: string | null;
}
export interface SetKillSwitchArgs {
  readonly flagKey: string;
  readonly organizationId: string | null;
  readonly killSwitchActive: boolean;
}

export interface ProvisionTenantArgs {
  readonly signupIntentId: string | null;
  readonly legalBusinessName: string;
  readonly billingContactEmail: string;
  readonly breachNotificationContactEmail: string;
  readonly firstAdminEmail: string;
  readonly firstAdminFullName: string;
  readonly planLabel: string;
}

export interface StatusTransitionArgs {
  readonly toStatus: string;
  readonly transitionReason: string;
}

/** The §4.1 platform-ops route service the handlers compose over. */
export interface TenantPlatformRouteService {
  // ── tenants (§4.1) ──
  listTenants(
    filter: { status?: string; planLabel?: string; createdAfter?: string; search?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<TenantSummaryView>>;
  getTenantOverview(orgSlug: string): Promise<TenantOverview>;
  provisionTenant(
    actorMembershipId: string,
    args: ProvisionTenantArgs,
  ): Promise<{ tenantAccountId: string; jobId: string }>;
  transitionStatus(
    orgSlug: string,
    actorUserId: string,
    args: StatusTransitionArgs,
  ): Promise<{ tenantAccountId: string; status: string }>;
  offboardTenant(
    orgSlug: string,
    actorUserId: string,
    args: { transitionReason: string; exportPurpose: string },
  ): Promise<{ tenantAccountId: string; status: string }>;
  requestShred(
    orgSlug: string,
    actorMembershipId: string,
    args: { transitionReason: string; destructionCertificateId: string },
  ): Promise<{ tenantAccountId: string; jobId: string }>;
  requestDekRotate(
    orgSlug: string,
    actorMembershipId: string,
    args: { reason: string },
  ): Promise<{ tenantAccountId: string; jobId: string }>;
  // ── tenant-invitations (§4.1) ──
  listInvitations(
    filter: { status?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<TenantInvitationView>>;
  issueInvitation(
    actorUserId: string,
    args: { orgSlug: string; firstAdminEmail: string; expiresInDays: number | undefined },
  ): Promise<TenantInvitationView>;
  revokeInvitation(invitationId: string): Promise<{ id: string; status: "revoked" }>;
  // ── key-ring (§3.5 metadata read + dek-rotate-request) ──
  getKeyRingMetadata(orgSlug: string): Promise<KeyRingMetadataView>;
  // ── onboarding-templates (§4.1) ──
  listOnboardingTemplates(
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<OnboardingTemplateView>>;
  upsertOnboardingTemplate(
    actorUserId: string,
    args: {
      key: string;
      title: string;
      description: string | null;
      canonicalOrder: number;
      isCanonical: boolean;
    },
  ): Promise<OnboardingTemplateView>;
  // ── support sessions (§4.1; F01/D8/D16) ──
  listSessions(
    filter: { tenantAccountId?: string; status?: "open" | "expired" | "closed" },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<SupportSessionView>>;
  listSessionEvents(
    sessionId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<SupportSessionEventView>>;
  startSession(args: StartSupportSessionArgs): Promise<{ sessionId: string; expiresAt: string }>;
  elevateSession(args: ElevateSupportSessionArgs): Promise<{ elevationExpiresAt: string }>;
  closeSession(args: CloseSupportSessionArgs): Promise<{ sessionId: string; closeReason: string }>;
  // ── signup intents (§4.1; F02 / ADR-0010) ──
  listSignupIntents(
    filter: { status?: string; source?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<SignupIntentView>>;
  qualifyIntent(
    intentId: string,
    actorMembershipId: string,
    args: { planLabel: string; firstAdminFullName: string },
  ): Promise<{ intentId: string; intentStatus: string; jobId: string }>;
  rejectIntent(
    intentId: string,
    actorUserId: string,
    args: { rejectionReason: string },
  ): Promise<{ intentId: string; intentStatus: string }>;
  // ── platform-tenant BAA register (§3.8 / D11) ──
  listBaaRecords(
    filter: { tenantAccountId?: string; status?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<BaaRecordView>>;
  createBaaRecord(actorUserId: string, args: CreateBaaRecordArgs): Promise<BaaRecordView>;
  updateBaaRecord(
    baaId: string,
    actorUserId: string,
    args: UpdateBaaRecordArgs,
  ): Promise<BaaRecordView>;
  // ── tenant export: the cross-tenant platform-ops list (§4.1; GAP-098) ──
  listTenantExportJobs(
    filter: TenantExportJobListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<TenantExportJobView>>;
  // ── tenant export: SEC-052 oversized-hold release (§3.7; GAP-097) ──
  approveOversizedExport(
    jobId: string,
    actorMembershipId: string,
    args: { approvalReason: string },
  ): Promise<{ jobId: string; status: string }>;
  // ── feature-flag admin (§4.7 / D13 — delegates to M1's FeatureFlagAdmin seam) ──
  listFeatureFlags(
    filter: { organizationId?: string; flagKind?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<FeatureFlagView>>;
  upsertFeatureFlag(actorUserId: string, args: UpsertFeatureFlagArgs): Promise<FeatureFlagView>;
  setKillSwitch(actorUserId: string, args: SetKillSwitchArgs): Promise<FeatureFlagView>;
}

// ── in-memory records + slice ─────────────────────────────────────────────────────────────────────────

interface TenantRecord {
  id: string;
  organizationId: string;
  orgSlug: string;
  legalBusinessName: string;
  planLabel: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  latestStatusEvent: { id: string; toStatus: string; occurredAt: string; reason: string } | null;
  keyRing: KeyRingMetadataView | null;
  onboarding: { totalTasks: number; doneTasks: number; currentStep: string | null };
  baa: { status: string; expiresOn: string | null } | null;
  activeGrants: number;
  activeSessions: number;
  invitations: Map<string, TenantInvitationView>;
}

interface SupportSessionRecord extends SupportSessionView {
  events: SupportSessionEventView[];
}

/** Deterministic, I/O-free seed for the in-memory route service (slice + smoke tests). */
export interface TenantPlatformRouteSeed {
  readonly tenants?: ReadonlyArray<Partial<TenantRecord> & { id: string; orgSlug: string }>;
  readonly templates?: ReadonlyArray<Partial<OnboardingTemplateView> & { key: string }>;
  readonly supportSessions?: ReadonlyArray<
    Partial<SupportSessionView> & { id: string; supportConsentGrantId: string }
  >;
  readonly signupIntents?: ReadonlyArray<Partial<SignupIntentView> & { id: string }>;
  readonly baaRecords?: ReadonlyArray<
    Partial<BaaRecordView> & { id: string; tenantAccountId: string; addendumVersion: string }
  >;
  readonly featureFlags?: ReadonlyArray<Partial<FeatureFlagView> & { flagKey: string }>;
  /** Active consent grants the start route may open a session against (grantorMembershipId for D16). */
  readonly consentGrants?: ReadonlyArray<{
    id: string;
    organizationId: string;
    tenantAccountId: string;
    grantorMembershipId: string;
    expiresAt: string;
  }>;
  /** Tenant-export jobs the approve-oversized route may act on (§3.7 SEC-052; GAP-097). A job seeded
   *  with `held: true` mirrors GAP-094's `holdForOversizedApproval` outcome (status stays `generating`,
   *  awaiting the co-sign); `held: false`/omitted seeds an already-fulfilled or never-held job so the
   *  route's "not actually held" 409 is exercisable too. */
  readonly tenantExportJobs?: ReadonlyArray<{
    id: string;
    organizationId?: string;
    held?: boolean;
    /** Who requested the export — the approve route must refuse this same membership (SEC-052). */
    requestingMembershipId?: string;
    requestedPurpose?: string;
    requestedAt?: string;
    heldBundleSizeBytes?: string;
    heldRecordCount?: number;
  }>;
}

/** Pads `n` to a uuid-shaped id so created ids round-trip through uuid-validated bodies (M22 slice). */
function uuidFromCounter(prefixNibble: string, n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${prefixNibble}0000000-0000-4000-8000-${hex}`;
}

const sessionView = (s: SupportSessionRecord): SupportSessionView => ({
  id: s.id,
  organizationId: s.organizationId,
  supportConsentGrantId: s.supportConsentGrantId,
  tenantAccountId: s.tenantAccountId,
  actorMembershipId: s.actorMembershipId,
  startedAt: s.startedAt,
  expiresAt: s.expiresAt,
  closedAt: s.closedAt,
  closeReason: s.closeReason,
  status: s.status,
});

const toSummary = (r: TenantRecord): TenantSummaryView => ({
  id: r.id,
  organizationId: r.organizationId,
  orgSlug: r.orgSlug,
  legalBusinessName: r.legalBusinessName,
  status: r.status,
  planLabel: r.planLabel,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** Read-only inspection surface over the slice (the route tests assert against it). */
export interface TenantPlatformBackendInspect {
  tenantCount(): number;
  statusOf(orgSlug: string): string | null;
  enqueuedJobs(): ReadonlyArray<{ queue: M34QueueName; jobKey: string }>;
}

export function createInMemoryTenantPlatformBackend(seed: TenantPlatformRouteSeed = {}): {
  service: TenantPlatformRouteService;
  enqueue: EnqueuePort;
  inspect: TenantPlatformBackendInspect;
} {
  const tenants = new Map<string, TenantRecord>(); // keyed by orgSlug
  const templates = new Map<string, OnboardingTemplateView>();
  const sessions = new Map<string, SupportSessionRecord>(); // keyed by session id
  const intents = new Map<string, SignupIntentView>(); // keyed by intent id
  const baaRecords = new Map<string, BaaRecordView>(); // keyed by baa id
  const flags = new Map<string, FeatureFlagView>(); // keyed by `${flagKey}@${organizationId ?? '*'}`
  // GAP-098: the slice record carries `held` explicitly so its LIST and its APPROVE agree the way the
  // Drizzle pair do (there, both derive held-ness from the same newest-ledger-event test).
  const tenantExportJobs = new Map<
    string,
    {
      id: string;
      organizationId: string;
      status: string;
      held: boolean;
      requestingMembershipId: string;
      requestedPurpose: string;
      requestedAt: string;
      heldBundleSizeBytes: string | null;
      heldRecordCount: number | null;
      heldAt: string | null;
    }
  >(); // keyed by job id
  const grants = new Map<
    string,
    {
      id: string;
      organizationId: string;
      tenantAccountId: string;
      grantorMembershipId: string;
      expiresAt: string;
    }
  >(); // keyed by grant id
  const enqueued: Array<{ queue: M34QueueName; jobKey: string }> = [];
  let created = 0;
  let sub = 0;
  const now = () => "2026-06-21T12:00:00.000Z";
  const subId = () => uuidFromCounter("a", ++sub);

  for (const t of seed.tenants ?? []) {
    tenants.set(t.orgSlug, {
      organizationId: uuidFromCounter("e", tenants.size + 1),
      legalBusinessName: "Seed Hospice",
      planLabel: "standard",
      status: "active",
      createdAt: now(),
      updatedAt: now(),
      latestStatusEvent: null,
      keyRing: {
        id: subId(),
        tenantAccountId: t.id ?? subId(),
        currentDekVersion: "v1",
        currentDekKekId: "kek-1",
        priorDekVersionCount: 0,
        dekCreatedAt: now(),
        dekLastRotatedAt: null,
        destroyedAt: null,
        destructionCertificateId: null,
      },
      onboarding: { totalTasks: 0, doneTasks: 0, currentStep: null },
      baa: { status: "executed", expiresOn: null },
      activeGrants: 0,
      activeSessions: 0,
      invitations: new Map(),
      ...t,
    } as TenantRecord);
  }
  for (const tpl of seed.templates ?? []) {
    templates.set(tpl.key, {
      id: tpl.id ?? subId(),
      key: tpl.key,
      title: tpl.title ?? tpl.key,
      canonicalOrder: tpl.canonicalOrder ?? 0,
      isCanonical: tpl.isCanonical ?? true,
      createdAt: tpl.createdAt ?? now(),
    });
  }
  for (const g of seed.consentGrants ?? []) grants.set(g.id, g);
  for (const s of seed.supportSessions ?? []) {
    sessions.set(s.id, {
      id: s.id,
      organizationId: s.organizationId ?? uuidFromCounter("e", 1),
      supportConsentGrantId: s.supportConsentGrantId,
      tenantAccountId: s.tenantAccountId ?? null,
      actorMembershipId: s.actorMembershipId ?? subId(),
      startedAt: s.startedAt ?? now(),
      expiresAt: s.expiresAt ?? now(),
      closedAt: s.closedAt ?? null,
      closeReason: s.closeReason ?? null,
      status: s.status ?? "open",
      events: [],
    });
  }
  for (const i of seed.signupIntents ?? []) {
    intents.set(i.id, {
      id: i.id,
      contactEmail: i.contactEmail ?? "prospect@example.com",
      legalBusinessName: i.legalBusinessName ?? "Prospect Hospice",
      intendedFirstAdminEmail: i.intendedFirstAdminEmail ?? "admin@example.com",
      intentStatus: i.intentStatus ?? "new",
      source: i.source ?? "platform_ops_manual",
      rejectionReason: i.rejectionReason ?? null,
      receivedAt: i.receivedAt ?? now(),
      processedAt: i.processedAt ?? null,
      tenantAccountId: i.tenantAccountId ?? null,
    });
  }
  for (const b of seed.baaRecords ?? []) {
    baaRecords.set(b.id, {
      id: b.id,
      organizationId: b.organizationId ?? uuidFromCounter("e", 1),
      tenantAccountId: b.tenantAccountId,
      addendumVersion: b.addendumVersion,
      baaStatus: b.baaStatus ?? "pending",
      executedOn: b.executedOn ?? null,
      effectiveOn: b.effectiveOn ?? null,
      expiresOn: b.expiresOn ?? null,
      documentId: b.documentId ?? null,
      attestedAt: b.attestedAt ?? null,
    });
  }
  for (const f of seed.featureFlags ?? []) {
    const key = `${f.flagKey}@${f.organizationId ?? "*"}`;
    flags.set(key, {
      id: f.id ?? subId(),
      flagKey: f.flagKey,
      organizationId: f.organizationId ?? null,
      flagKind: f.flagKind ?? "product",
      valueType: f.valueType ?? "boolean",
      value: f.value ?? false,
      rolloutPercent: f.rolloutPercent ?? null,
      killSwitchActive: f.killSwitchActive ?? false,
      updatedAt: f.updatedAt ?? now(),
    });
  }
  for (const j of seed.tenantExportJobs ?? []) {
    const held = j.held ?? true;
    tenantExportJobs.set(j.id, {
      id: j.id,
      organizationId: j.organizationId ?? uuidFromCounter("e", 1),
      status: held ? "generating" : "fulfilled",
      held,
      requestingMembershipId: j.requestingMembershipId ?? uuidFromCounter("f", 8),
      requestedPurpose: j.requestedPurpose ?? "migration",
      requestedAt: j.requestedAt ?? now(),
      heldBundleSizeBytes: held ? (j.heldBundleSizeBytes ?? "53687091200") : null,
      heldRecordCount: held ? (j.heldRecordCount ?? 1_000_000) : null,
      heldAt: held ? (j.requestedAt ?? now()) : null,
    });
  }

  function loadTenant(orgSlug: string): TenantRecord {
    const r = tenants.get(orgSlug);
    if (!r) throw new NotFoundError("tenant"); // non-leaking (the way platform-context filtering behaves)
    return r;
  }

  /** Rows already DESC-sorted by `(createdAt, id)` for keyset pagination. */
  const desc = <T extends { createdAt: string; id: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    );

  const service: TenantPlatformRouteService = {
    async listTenants(filter, cursor, limit) {
      const rows = desc(
        [...tenants.values()]
          .filter((r) => (filter.status ? r.status === filter.status : true))
          .filter((r) => (filter.planLabel ? r.planLabel === filter.planLabel : true))
          .filter((r) => (filter.createdAfter ? r.createdAt > filter.createdAfter : true))
          .filter((r) =>
            filter.search
              ? r.legalBusinessName.toLowerCase().includes(filter.search.toLowerCase())
              : true,
          )
          .map(toSummary),
      );
      return paginate(rows, cursor, limit);
    },
    async getTenantOverview(orgSlug) {
      const r = loadTenant(orgSlug);
      return {
        ...toSummary(r),
        latestStatusEvent: r.latestStatusEvent,
        keyRing: r.keyRing
          ? {
              currentDekVersion: r.keyRing.currentDekVersion,
              dekLastRotatedAt: r.keyRing.dekLastRotatedAt,
              destroyedAt: r.keyRing.destroyedAt,
            }
          : null,
        onboarding: r.onboarding,
        baa: r.baa,
        activeGrants: r.activeGrants,
        activeSessions: r.activeSessions,
      };
    },
    async provisionTenant(actorMembershipId, args) {
      const tenantAccountId = uuidFromCounter("c", ++created);
      const organizationId = uuidFromCounter("e", created);
      const { jobId } = await enqueuePort.enqueue("tenant.provision", tenantAccountId, {
        tenantAccountId,
        organizationId,
        legalBusinessName: args.legalBusinessName,
        billingContactEmail: args.billingContactEmail,
        firstAdminEmail: args.firstAdminEmail,
        firstAdminFullName: args.firstAdminFullName,
        actorMembershipId,
        transitionReason: "platform operator requested tenant provisioning",
      });
      const orgSlug = `tenant-${created}`;
      tenants.set(orgSlug, {
        id: tenantAccountId,
        organizationId,
        orgSlug,
        legalBusinessName: args.legalBusinessName,
        planLabel: args.planLabel,
        status: "provisioning",
        createdAt: now(),
        updatedAt: now(),
        latestStatusEvent: {
          id: subId(),
          toStatus: "provisioning",
          occurredAt: now(),
          reason: "provision requested",
        },
        keyRing: null,
        onboarding: { totalTasks: 0, doneTasks: 0, currentStep: null },
        baa: null,
        activeGrants: 0,
        activeSessions: 0,
        invitations: new Map(),
      });
      return { tenantAccountId, jobId };
    },
    async transitionStatus(orgSlug, _actorUserId, args) {
      const r = loadTenant(orgSlug);
      r.status = args.toStatus;
      r.updatedAt = now();
      r.latestStatusEvent = {
        id: subId(),
        toStatus: args.toStatus,
        occurredAt: now(),
        reason: args.transitionReason,
      };
      return { tenantAccountId: r.id, status: r.status };
    },
    async offboardTenant(orgSlug, _actorUserId, args) {
      const r = loadTenant(orgSlug);
      if (r.status !== "active" && r.status !== "suspended" && r.status !== "at_risk") {
        throw new WardenXError(
          "ILLEGAL_TENANT_TRANSITION",
          `tenant cannot offboard from '${r.status}'`,
          409,
        );
      }
      r.status = "offboarding_initiated";
      r.updatedAt = now();
      r.latestStatusEvent = {
        id: subId(),
        toStatus: "offboarding_initiated",
        occurredAt: now(),
        reason: args.transitionReason,
      };
      return { tenantAccountId: r.id, status: r.status };
    },
    async requestShred(orgSlug, actorMembershipId, args) {
      const r = loadTenant(orgSlug);
      if (r.status !== "destruction_pending") {
        throw new WardenXError(
          "ILLEGAL_TENANT_TRANSITION",
          "shred requires status='destruction_pending'",
          409,
        );
      }
      const { jobId } = await enqueuePort.enqueue(
        "tenant.shred",
        `${r.id}+${args.destructionCertificateId}`,
        {
          tenantAccountId: r.id,
          orgId: r.organizationId,
          destructionCertId: args.destructionCertificateId,
          actorMembershipId,
          transitionReason: args.transitionReason,
        },
      );
      return { tenantAccountId: r.id, jobId };
    },
    async requestDekRotate(orgSlug, actorMembershipId, args) {
      const r = loadTenant(orgSlug);
      const targetVersion = `v${(r.keyRing?.priorDekVersionCount ?? 0) + 2}`;
      const { jobId } = await enqueuePort.enqueue("tenant.dek_rotate", `${r.id}+${targetVersion}`, {
        orgId: r.organizationId,
        actorMembershipId,
        targetVersion,
      });
      return { tenantAccountId: r.id, jobId };
    },
    async listInvitations(filter, cursor, limit) {
      const rows = desc(
        [...tenants.values()]
          .flatMap((t) => [...t.invitations.values()])
          .filter((i) => (filter.status ? i.status === filter.status : true))
          .map((i) => ({ ...i, createdAt: i.issuedAt })),
      );
      const page = paginate(rows, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...i }) => i) };
    },
    async issueInvitation(_actorUserId, args) {
      const r = loadTenant(args.orgSlug);
      const id = subId();
      const view: TenantInvitationView = {
        id,
        tenantAccountId: r.id,
        firstAdminEmail: args.firstAdminEmail,
        status: "pending",
        issuedAt: now(),
        expiresAt: now(),
      };
      r.invitations.set(id, view);
      return view;
    },
    async revokeInvitation(invitationId) {
      for (const t of tenants.values()) {
        const inv = t.invitations.get(invitationId);
        if (inv) {
          t.invitations.set(invitationId, { ...inv, status: "revoked" });
          return { id: invitationId, status: "revoked" };
        }
      }
      throw new NotFoundError("tenant invitation");
    },
    async getKeyRingMetadata(orgSlug) {
      const r = loadTenant(orgSlug);
      if (!r.keyRing) throw new NotFoundError("tenant key ring");
      return r.keyRing;
    },
    async listOnboardingTemplates(cursor, limit) {
      const rows = desc([...templates.values()].map((t) => ({ ...t })));
      return paginate(rows, cursor, limit);
    },
    async upsertOnboardingTemplate(_actorUserId, args) {
      const existing = templates.get(args.key);
      const view: OnboardingTemplateView = {
        id: existing?.id ?? subId(),
        key: args.key,
        title: args.title,
        canonicalOrder: args.canonicalOrder,
        isCanonical: args.isCanonical,
        createdAt: existing?.createdAt ?? now(),
      };
      templates.set(args.key, view);
      return view;
    },

    // ── support sessions (§7.4; F01/D8/D16) ──
    async listSessions(filter, cursor, limit) {
      const rows = desc(
        [...sessions.values()]
          .filter((s) =>
            filter.tenantAccountId ? s.tenantAccountId === filter.tenantAccountId : true,
          )
          .filter((s) => (filter.status ? s.status === filter.status : true))
          .map((s) => ({ ...sessionView(s), createdAt: s.startedAt })),
      );
      const page = paginate(rows, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...s }) => s) };
    },
    async listSessionEvents(sessionId, cursor, limit) {
      const s = sessions.get(sessionId);
      if (!s) throw new NotFoundError("support session");
      const rows = desc([...s.events].map((e) => ({ ...e, createdAt: e.occurredAt })));
      const page = paginate(rows, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...e }) => e) };
    },
    async startSession(args) {
      const grant = grants.get(args.supportConsentGrantId);
      // §7.4 step 3 — the grant must exist + be active.
      if (!grant)
        throw new WardenXError("SUPPORT_GRANT_NOT_FOUND", "support_consent_grant not found", 404);
      if (grant.expiresAt <= now()) {
        throw new WardenXError(
          "SUPPORT_GRANT_INACTIVE",
          "the consent grant is revoked or expired",
          409,
        );
      }
      // D16 — defense-in-depth: the platform-ops actor cannot be the grantor (alongside the §4.6 ABAC).
      if (grant.grantorMembershipId === args.actorMembershipId) {
        throw new WardenXError(
          "SUPPORT_SESSION_ACTOR_NOT_DISTINCT",
          "the support-session actor must differ from the consent-grant grantor (D16)",
          403,
        );
      }
      // §7.4 step 3 — expires_at = LEAST(grant.expires_at, started_at + 8h). The slice clamps to the grant.
      const id = subId();
      const session: SupportSessionRecord = {
        id,
        organizationId: args.organizationId,
        supportConsentGrantId: grant.id,
        tenantAccountId: grant.tenantAccountId,
        actorMembershipId: args.actorMembershipId,
        startedAt: now(),
        expiresAt: grant.expiresAt,
        closedAt: null,
        closeReason: null,
        status: "open",
        events: [
          {
            id: subId(),
            supportSessionId: id,
            eventKind: "session.start",
            resourceKind: null,
            resourceId: null,
            occurredAt: now(),
            actorIp: args.actorIp,
          },
        ],
      };
      sessions.set(id, session);
      return { sessionId: id, expiresAt: session.expiresAt };
    },
    async elevateSession(args) {
      const s = sessions.get(args.supportSessionId);
      if (!s || s.closedAt !== null || s.status !== "open") {
        throw new WardenXError(
          "SUPPORT_SESSION_NOT_OPEN",
          "the support session is closed or expired",
          409,
        );
      }
      s.events.push({
        id: subId(),
        supportSessionId: s.id,
        eventKind: "session.elevate",
        resourceKind: null,
        resourceId: null,
        occurredAt: now(),
        actorIp: args.actorIp,
      });
      // §7.4 step 5 — the slice returns a fixed 2-minute window (the real clamp is the pure service's).
      return { elevationExpiresAt: now() };
    },
    async closeSession(args) {
      const s = sessions.get(args.supportSessionId);
      if (!s) throw new NotFoundError("support session");
      sessions.set(s.id, { ...s, closedAt: now(), closeReason: "manual", status: "closed" });
      s.events.push({
        id: subId(),
        supportSessionId: s.id,
        eventKind: "session.close",
        resourceKind: null,
        resourceId: null,
        occurredAt: now(),
        actorIp: args.actorIp,
      });
      return { sessionId: s.id, closeReason: "manual" };
    },

    // ── signup intents (§4.1; F02 / ADR-0010) ──
    async listSignupIntents(filter, cursor, limit) {
      const rows = desc(
        [...intents.values()]
          .filter((i) => (filter.status ? i.intentStatus === filter.status : true))
          .filter((i) => (filter.source ? i.source === filter.source : true))
          .map((i) => ({ ...i, createdAt: i.receivedAt })),
      );
      const page = paginate(rows, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...i }) => i) };
    },
    async qualifyIntent(intentId, actorMembershipId, args) {
      const i = intents.get(intentId);
      if (!i) throw new NotFoundError("signup intent");
      if (i.intentStatus !== "new") {
        throw new WardenXError(
          "ILLEGAL_INTENT_TRANSITION",
          `intent cannot qualify from '${i.intentStatus}'`,
          409,
        );
      }
      intents.set(intentId, { ...i, intentStatus: "qualified", processedAt: now() });
      // §7.1 — a qualified intent triggers the same provisioning flow as the Phase-1 platform-ops path.
      const tenantAccountId = intentId;
      const organizationId = intentId;
      const { jobId } = await enqueuePort.enqueue("tenant.provision", tenantAccountId, {
        tenantAccountId,
        organizationId,
        legalBusinessName: i.legalBusinessName,
        billingContactEmail: i.contactEmail,
        firstAdminEmail: i.intendedFirstAdminEmail,
        firstAdminFullName: args.firstAdminFullName,
        actorMembershipId,
        transitionReason: "platform operator qualified signup intent",
      });
      return { intentId, intentStatus: "qualified", jobId };
    },
    async rejectIntent(intentId, _actorUserId, args) {
      const i = intents.get(intentId);
      if (!i) throw new NotFoundError("signup intent");
      if (i.intentStatus !== "new") {
        throw new WardenXError(
          "ILLEGAL_INTENT_TRANSITION",
          `intent cannot reject from '${i.intentStatus}'`,
          409,
        );
      }
      intents.set(intentId, {
        ...i,
        intentStatus: "rejected",
        rejectionReason: args.rejectionReason,
        processedAt: now(),
      });
      return { intentId, intentStatus: "rejected" };
    },

    // ── platform-tenant BAA register (§3.8 / D11) ──
    async listBaaRecords(filter, cursor, limit) {
      const rows = desc(
        [...baaRecords.values()]
          .filter((b) =>
            filter.tenantAccountId ? b.tenantAccountId === filter.tenantAccountId : true,
          )
          .filter((b) => (filter.status ? b.baaStatus === filter.status : true))
          .map((b) => ({ ...b, createdAt: b.executedOn ?? b.effectiveOn ?? "0000-00-00" })),
      );
      const page = paginate(rows, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...b }) => b) };
    },
    async createBaaRecord(_actorUserId, args) {
      // UNIQUE (tenant_account, addendum_version) — a duplicate is a 409 (the DB index enforces it in prod).
      for (const b of baaRecords.values()) {
        if (
          b.tenantAccountId === args.tenantAccountId &&
          b.addendumVersion === args.addendumVersion
        ) {
          throw new WardenXError(
            "DUPLICATE_BAA_RECORD",
            "a BAA record for this addendum version exists",
            409,
          );
        }
      }
      const id = subId();
      const view: BaaRecordView = {
        id,
        organizationId: uuidFromCounter("e", 1),
        tenantAccountId: args.tenantAccountId,
        addendumVersion: args.addendumVersion,
        baaStatus: args.baaStatus,
        executedOn: args.executedOn,
        effectiveOn: args.effectiveOn,
        expiresOn: args.expiresOn,
        documentId: null,
        attestedAt: null,
      };
      baaRecords.set(id, view);
      return view;
    },
    async updateBaaRecord(baaId, _actorUserId, args) {
      const b = baaRecords.get(baaId);
      if (!b) throw new NotFoundError("platform-tenant BAA record");
      const view: BaaRecordView = {
        ...b,
        baaStatus: args.baaStatus ?? b.baaStatus,
        executedOn: args.executedOn ?? b.executedOn,
        effectiveOn: args.effectiveOn ?? b.effectiveOn,
        expiresOn: args.expiresOn ?? b.expiresOn,
        documentId: args.documentId ?? b.documentId,
      };
      baaRecords.set(baaId, view);
      return view;
    },

    // ── tenant export: the cross-tenant platform-ops list (§4.1; GAP-098) ──
    async listTenantExportJobs(filter, cursor, limit) {
      const rows = desc(
        [...tenantExportJobs.values()]
          .filter((j) =>
            filter.organizationId ? j.organizationId === filter.organizationId : true,
          )
          .filter((j) => (filter.status ? j.status === filter.status : true))
          .filter((j) => (filter.held === undefined ? true : j.held === filter.held))
          .map((j) => ({ ...j, createdAt: j.requestedAt })),
      );
      const page = paginate(rows, cursor, limit);
      return {
        ...page,
        items: page.items.map(({ createdAt: _c, held, ...j }) => ({
          ...j,
          fulfilledAt: null,
          heldForOversizedApproval: held,
          bundleSizeBytes: null,
          bundleDownloadedAt: null,
        })),
      };
    },

    // ── tenant export: SEC-052 oversized-hold release (§3.7; GAP-097) ──
    async approveOversizedExport(jobId, actorMembershipId, args) {
      const job = tenantExportJobs.get(jobId);
      if (!job) throw new NotFoundError("tenant export job");
      // SEC-052 second-actor property — the slice enforces the same distinct-approver rule as the
      // Drizzle service so route tests can exercise the refusal.
      if (job.requestingMembershipId === actorMembershipId) {
        throw new WardenXError(
          "TENANT_EXPORT_SELF_APPROVAL",
          "oversized-hold approval requires a platform-ops actor distinct from the export requestor",
          403,
        );
      }
      if (job.status !== "generating") {
        throw new WardenXError(
          "TENANT_EXPORT_NOT_HELD",
          "the bundle is not awaiting oversized-hold approval",
          409,
        );
      }
      void args.approvalReason;
      job.status = "fulfilled";
      job.held = false; // the list must stop calling it held the moment the release lands
      return { jobId, status: "fulfilled" };
    },

    // ── feature-flag admin (§4.7 / D13 — the slice stands in for M1's FeatureFlagAdmin seam) ──
    async listFeatureFlags(filter, cursor, limit) {
      const rows = desc(
        [...flags.values()]
          .filter((f) =>
            filter.organizationId ? f.organizationId === filter.organizationId : true,
          )
          .filter((f) => (filter.flagKind ? f.flagKind === filter.flagKind : true))
          .map((f) => ({ ...f, createdAt: f.updatedAt })),
      );
      const page = paginate(rows, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...f }) => f) };
    },
    async upsertFeatureFlag(_actorUserId, args) {
      const key = `${args.flagKey}@${args.organizationId ?? "*"}`;
      const existing = flags.get(key);
      const view: FeatureFlagView = {
        id: existing?.id ?? subId(),
        flagKey: args.flagKey,
        organizationId: args.organizationId,
        flagKind: args.flagKind,
        valueType: args.valueType,
        value: args.value,
        rolloutPercent: args.rolloutPercent,
        killSwitchActive: existing?.killSwitchActive ?? false,
        updatedAt: now(),
      };
      flags.set(key, view);
      return view;
    },
    async setKillSwitch(_actorUserId, args) {
      const key = `${args.flagKey}@${args.organizationId ?? "*"}`;
      const existing = flags.get(key);
      if (!existing) throw new NotFoundError("feature flag");
      const view: FeatureFlagView = {
        ...existing,
        killSwitchActive: args.killSwitchActive,
        updatedAt: now(),
      };
      flags.set(key, view);
      return view;
    },
  };

  // The slice-default enqueue port records the job (so the route tests assert the worker was scheduled).
  const enqueuePort: EnqueuePort = {
    async enqueue(queue, jobKey, _payload) {
      enqueued.push({ queue, jobKey });
      return { jobId: subId() };
    },
  };

  const inspect: TenantPlatformBackendInspect = {
    tenantCount: () => tenants.size,
    statusOf: (orgSlug) => tenants.get(orgSlug)?.status ?? null,
    enqueuedJobs: () => enqueued,
  };

  return { service, enqueue: enqueuePort, inspect };
}

// TODO(Phase 2D — live workers): bind the {@link EnqueuePort} to the @wardenx/shared transactional outbox
// + the real BullMQ producer (the §4.3 `tenant.provision` / `tenant.dek_rotate` / `tenant.shred` /
// `tenant.export` queues), and replace the in-memory command bodies with the Drizzle-backed service that
// runs the §2.2 `transitionTenant(...)` machine inside the tenant_account's optimistic-locked transaction
// under `withPlatformContext`. The READ/LIST methods already match the prod shape (the Drizzle adapter
// projects rows to the SAME DTOs); only the command-side worker construction is deferred.
// Re-export type so the route plugins / composition root reference one symbol.
export type { OrgId };

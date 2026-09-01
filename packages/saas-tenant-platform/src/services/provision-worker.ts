// @wardenx/saas-tenant-platform · services — the `tenant.provision` job handler (§2.5 r2 / §7.1, M34).
//
// The provisioning side-effects of the `provisioning → onboarding` transition (§2.5 r2 / §7.1 step 2):
//   (1) insert `tenant_key_ring` (v1 DEK) via the `m34_provision_tenant_key_ring` SECURITY DEFINER fn,
//   (2) create the per-tenant MinIO bucket `tenant-<orgId>` and confirm the logical prefix set,
//   (3) create / attach the M2 organization,
//   (4) materialize the eleven canonical `onboarding_task` rows from `onboarding_task_template`,
//   (5) issue the first-admin `tenant_invitation` (+ dispatch the M36 PHI-sanitized magic-link email),
//   (6) emit `m34.tenant.provisioned` (consumed by M35 to create the Stripe Customer), and
//   (7) drive the `provisioned` lifecycle event so the tenant lands in `onboarding`.
//
// PATTERN (the M40 `runNppesNightlyDelta` / M38 terminology-job convention, packages/mdm/src/jobs/
// processors.ts): this is PURE orchestration over an injected ports interface — no BullMQ, no Drizzle,
// no MinIO, no clock, no RNG in this module. The app composition root binds the production adapters to
// the identical port shapes at boot. CROSS-MODULE ACCESS GOES THROUGH PORTS the boot wiring binds to a
// seam / outbox publish (mirroring how 2A's abac-predicates reached M5 via `getSeam("CaseloadProvider")`)
// — this package adds NO direct M1/M2/M4/M22 import and NO new manifest `dependsOn` edge (M34 stays
// `[1,2,3,4,36]`). The repositories (`TenantAccountRepository`, `TenantKeyRingRepository`,
// `OnboardingRepository`) ARE used — through ports too, so the service layer owns the `withOrgContext`
// (M1 @wardenx/tenancy) RLS-scoping and the single optimistic-locked transaction.
//
// IDEMPOTENCY (§2.6 "Provision worker idempotency", keyed by `tenant_account_id`): every step is a
// SELECT-then-INSERT-IF-NOT-EXISTS, so a failure / replay re-runs cleanly. The handler resolves the
// current state first; if the tenant is already past `provisioning` it is a completed-replay no-op.
import { TenantLifecycleError, require_ } from "./lifecycle-errors";
import { transitionTenant } from "./lifecycle-transition";

/** The canonical logical prefix set confirmed after the per-tenant MinIO bucket `tenant-<orgId>` is
 *  ensured (§7.1 step 2 / Ops Runbook §6.6). S3/MinIO prefixes are logical; the adapter does not create
 *  `.keep` objects unless a future contract explicitly requires materialized folders. */
export const PROVISION_MINIO_PREFIXES = [
  "documents",
  "generated",
  "intake",
  "claims",
  "cost-reports",
  "exports",
] as const;

/** The platform-floor TTL for the first-admin invitation (§7.1 step 2: `expires_at = NOW() + 14d`). */
export const FIRST_ADMIN_INVITATION_TTL_DAYS = 14;

/** The input a `tenant.provision` job carries (§2.6 — keyed by `tenantAccountId` for idempotent replay).
 *  Every field is resolved by the route that enqueued the job (the §7.1 step-1 platform-ops POST) and is
 *  PHI-free; the worker performs no PHI read. `actorMembershipId` is preserved end-to-end for the §7.1
 *  step-3 surveyor trail (the `tenant_account_status_event` + per-step audit chain). */
export interface ProvisionJob {
  readonly tenantAccountId: string;
  readonly organizationId: string;
  readonly legalBusinessName: string;
  readonly billingContactEmail: string;
  /** The intended first admin (the magic-link invitee); never persisted raw alongside the token. */
  readonly firstAdminEmail: string;
  readonly firstAdminFullName: string;
  /** The platform-ops actor that accepted the intent (recorded on the status-event + every audit row). */
  readonly actorMembershipId: string;
  /** A non-empty transition reason for the `provisioned` event (§2.4.1 — no status change without one). */
  readonly transitionReason: string;
}

/** The `m34.tenant.provisioned` outbox payload (the §4.9 catalog shape — `events-by-m34.ts`). Emitted in
 *  the same transaction as the status mutation (§2.6 outbox semantics); M35 + M36 + M33 consume it. */
export interface TenantProvisionedEvent {
  readonly tenantAccountId: string;
  readonly orgId: string;
  readonly legalBusinessName: string;
  readonly billingContactEmail: string;
}

/** What the provision handler reports (the §7.1 step-3 surveyor summary; assertable in unit tests). */
export interface ProvisionResult {
  /** False when the handler short-circuited because the tenant was already past `provisioning` (replay). */
  readonly ran: boolean;
  readonly skippedReason?: "already_provisioned";
  /** The key-ring row id inserted (or the pre-existing one on a partial replay). */
  readonly tenantKeyRingId: string;
  /** The MinIO prefixes the helper ensured for the tenant (idempotent ensure). */
  readonly minioPrefixesCreated: readonly string[];
  /** The M2 organization id created / attached (echoed back from M2 / the tenant_account). */
  readonly organizationId: string;
  /** How many canonical `onboarding_task` rows were materialized (existing rows are not duplicated). */
  readonly onboardingTasksMaterialized: number;
  /** The first-admin `tenant_invitation` id issued (or the pre-existing pending one on replay). */
  readonly invitationId: string;
}

/**
 * The ports the `tenant.provision` handler binds (§2.5 r2). Each is bound at boot to a real adapter:
 * the repositories (org-scoped under `withOrgContext`), the M1 key-ring SECURITY DEFINER fn + MinIO
 * helper (via the package's own DB client / an M1 seam), the M2 org create (via outbox / an M2 seam),
 * the M36 PHI-sanitized email channel, and the outbox publisher. The handler resolves no IO itself —
 * the same unit-testable shape as the M40 nightly-delta ports.
 */
export interface ProvisionWorkerPorts {
  /** Injected clock — stamps the invitation `expiresAt` (NOW()+14d) deterministically (§7.1 step 2). */
  now(): Date;

  // ── §2.6 idempotency precondition ─────────────────────────────────────────────────────────────
  /** The tenant_account's current lifecycle status (the replay short-circuit; via `TenantAccountRepository
   *  .findById` under `withOrgContext`). Returns `null` if the row vanished (a hard error upstream). */
  currentStatus(tenantAccountId: string): Promise<string | null>;

  // ── step (1): tenant_key_ring (the m34_provision_tenant_key_ring SECURITY DEFINER fn) ───────────
  /** SELECT-THEN-CALL: return the existing key-ring id if one already exists for the tenant; else invoke
   *  `m34_provision_tenant_key_ring(tenant_account_id)` (SECURITY DEFINER — inserts the v1 DEK row,
   *  KEK-wrapped) and return the new id (§7.1 step 2 / §2.6). Bound over `TenantKeyRingRepository
   *  .findByTenantAccountId` + a `db.execute(sql\`SELECT m34_provision_tenant_key_ring(...)\`)`. */
  ensureTenantKeyRing(input: {
    tenantAccountId: string;
    organizationId: string;
  }): Promise<{ tenantKeyRingId: string }>;

  // ── step (2): per-tenant MinIO bucket + logical prefixes ───────────────────────────────────────
  /** Ensure the per-tenant MinIO bucket `tenant-<orgId>` and confirm the logical prefix set with the
   *  Ops-Runbook §6.6 retention policies (idempotent ensure — already-present buckets are a no-op). */
  ensureTenantStoragePrefixes(input: {
    organizationId: string;
    prefixes: readonly string[];
  }): Promise<{ prefixesEnsured: readonly string[] }>;

  // ── step (3): M2 organization (createOrganization — via an M2 seam / outbox at boot) ────────────
  /** Ensure the M2 organization exists for the tenant (SELECT-then-create). The organization spine is
   *  pre-created by the §7.1 step-1 route in Phase 1, so this is typically an idempotent confirm that
   *  echoes the `organizationId` back; the port exists so the Phase-3 self-serve path (where the org is
   *  minted here) binds the same handler. Bound to M2's `createOrganization` via seam / outbox. */
  ensureOrganization(input: {
    tenantAccountId: string;
    organizationId: string;
    legalBusinessName: string;
  }): Promise<{ organizationId: string }>;

  // ── step (4): eleven canonical onboarding_task rows from onboarding_task_template ───────────────
  /** Materialize the canonical onboarding tasks for the tenant from the template catalog, SELECT-then-
   *  INSERT-IF-NOT-EXISTS per template key (the `onboarding_task_tenant_template_unique` index makes a
   *  replay a no-op for already-seeded keys). Bound over `OnboardingRepository.listTemplates` +
   *  `listTasksByTenant` + `createTasks`, computing `dueAt = now + template.defaultDueDaysAfterProvisioning`.
   *  Returns the COUNT materialized this run (0 on a full replay). */
  materializeOnboardingTasks(input: {
    tenantAccountId: string;
    organizationId: string;
  }): Promise<{ materialized: number }>;

  // ── step (5): first-admin tenant_invitation (+ M36 PHI-sanitized magic-link email) ─────────────
  /** Issue the single first-admin invitation (SELECT-then-INSERT: if a `pending` invitation already
   *  exists for the tenant, return it without minting a new token). Mints the one-time token, persists
   *  only its SHA256 hash (raw token never persisted), and dispatches the magic-link email through M36's
   *  PHI-sanitization wrapper (no PHI in body, §2.5). Bound over `TenantAccountRepository.listInvitations`
   *  + `createInvitation` + the M36 email channel. Returns the invitation id (existing or new). */
  ensureFirstAdminInvitation(input: {
    tenantAccountId: string;
    organizationId: string;
    inviteeEmail: string;
    inviteeFullName: string;
    inviterMembershipId: string;
    expiresAt: Date;
  }): Promise<{ invitationId: string }>;

  // ── step (6) + (7): outbox emit + the `provisioned` lifecycle transition (same tx) ─────────────
  /** Apply the `provisioned` lifecycle event — append the `tenant_account_status_event`, stamp the
   *  status to `onboarding`, and PUBLISH the `m34.tenant.provisioned` outbox row in the SAME transaction
   *  (§2.6 outbox semantics). Bound over the lifecycle service (the §2.5 effect runner): the handler hands
   *  it the already-computed transition result + the typed event so the route/worker effect-runner stays
   *  the single home for the optimistic-locked tx. Returns nothing on success; throws on a lost race. */
  commitProvisionedTransition(input: {
    tenantAccountId: string;
    actorMembershipId: string;
    transitionReason: string;
    provisionedEvent: TenantProvisionedEvent;
  }): Promise<void>;
}

/**
 * Run the `tenant.provision` job (§2.5 r2 / §7.1 step 2). Single-concurrency + idempotent on
 * `tenantAccountId` (§2.6): each step is SELECT-then-INSERT-IF-NOT-EXISTS, so a crash / replay re-runs
 * cleanly. The handler:
 *   0. resolves the current status; if already past `provisioning` it is a completed-replay no-op,
 *   1. ensures the `tenant_key_ring` (v1 DEK) via the SECURITY DEFINER fn,
 *   2. ensures the per-tenant MinIO prefixes,
 *   3. ensures the M2 organization,
 *   4. materializes the canonical onboarding tasks,
 *   5. issues the first-admin invitation (+ M36 magic-link email),
 *   6+7. computes the `provisioned` transition (the pure machine validates `tenantKeyRingReady`) and
 *        commits it — appending the status-event, stamping `onboarding`, and emitting
 *        `m34.tenant.provisioned` in one transaction.
 *
 * Throws {@link TenantLifecycleError} `TENANT_KEY_MISSING` if the key ring could not be established
 * before the transition (the §2.4.4 guard), or `ILLEGAL_TENANT_TRANSITION` if the tenant is not in
 * `provisioning` when the handler reaches it (a concurrent transition raced — the caller retries).
 */
export async function runTenantProvision(
  job: ProvisionJob,
  ports: ProvisionWorkerPorts,
): Promise<ProvisionResult> {
  require_(
    job.transitionReason.trim().length > 0,
    "TRANSITION_REASON_REQUIRED",
    "a non-empty transition reason is required for the provisioned transition (§2.4.1)",
  );

  // 0. §2.6 idempotency: short-circuit a completed replay (the tenant already moved past provisioning).
  const status = await ports.currentStatus(job.tenantAccountId);
  if (status === null) {
    throw new TenantLifecycleError(
      "ILLEGAL_TENANT_TRANSITION",
      `tenant_account ${job.tenantAccountId} not found for provisioning`,
    );
  }
  if (status !== "provisioning") {
    // Already onboarding (or beyond): the worker ran to completion on a prior attempt. No-op replay.
    return {
      ran: false,
      skippedReason: "already_provisioned",
      tenantKeyRingId: "",
      minioPrefixesCreated: [],
      organizationId: job.organizationId,
      onboardingTasksMaterialized: 0,
      invitationId: "",
    };
  }

  // 1. tenant_key_ring — the v1 DEK via the m34_provision_tenant_key_ring SECURITY DEFINER fn.
  const { tenantKeyRingId } = await ports.ensureTenantKeyRing({
    tenantAccountId: job.tenantAccountId,
    organizationId: job.organizationId,
  });

  // 2. per-tenant MinIO bucket + logical prefix set — tenant-<orgId>/{documents,generated,…}.
  const { prefixesEnsured } = await ports.ensureTenantStoragePrefixes({
    organizationId: job.organizationId,
    prefixes: PROVISION_MINIO_PREFIXES,
  });

  // 3. M2 organization (idempotent confirm in Phase 1; the create site for Phase-3 self-serve).
  const { organizationId } = await ports.ensureOrganization({
    tenantAccountId: job.tenantAccountId,
    organizationId: job.organizationId,
    legalBusinessName: job.legalBusinessName,
  });

  // 4. eleven canonical onboarding_task rows from onboarding_task_template (idempotent per template key).
  const { materialized } = await ports.materializeOnboardingTasks({
    tenantAccountId: job.tenantAccountId,
    organizationId,
  });

  // 5. first-admin tenant_invitation (+ M36 PHI-sanitized magic-link email). 14-day platform-floor TTL.
  const expiresAt = new Date(
    ports.now().getTime() + FIRST_ADMIN_INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  const { invitationId } = await ports.ensureFirstAdminInvitation({
    tenantAccountId: job.tenantAccountId,
    organizationId,
    inviteeEmail: job.firstAdminEmail,
    inviteeFullName: job.firstAdminFullName,
    inviterMembershipId: job.actorMembershipId,
    expiresAt,
  });

  // 6 + 7. Compute the `provisioned` transition (pure machine: validates tenantKeyRingReady + reason),
  // then commit it — status-event + status='onboarding' + `m34.tenant.provisioned` outbox in one tx.
  // The pure call is the §2.4.4 TENANT_KEY_MISSING / §2.4.1 reason gate before any IO touches the tx;
  // `tenantKeyRingReady` is true because step 1 established (or confirmed) the v1 DEK above.
  const provisionedEvent: TenantProvisionedEvent = {
    tenantAccountId: job.tenantAccountId,
    orgId: organizationId,
    legalBusinessName: job.legalBusinessName,
    billingContactEmail: job.billingContactEmail,
  };
  transitionTenant("provisioning", {
    type: "provisioned",
    actorKind: "platform_ops",
    transitionReason: job.transitionReason,
    tenantKeyRingReady: true,
  });
  await ports.commitProvisionedTransition({
    tenantAccountId: job.tenantAccountId,
    actorMembershipId: job.actorMembershipId,
    transitionReason: job.transitionReason,
    provisionedEvent,
  });

  return {
    ran: true,
    tenantKeyRingId,
    minioPrefixesCreated: prefixesEnsured,
    organizationId,
    onboardingTasksMaterialized: materialized,
    invitationId,
  };
}

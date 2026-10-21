// @chartwarden/saas-tenant-platform — the M34 destruction-cert eraseFn for the `saas_tenant_platform_class`
// data class (spec §3.5 / §7.5 / §8.3 / §8.4, D6).
//
// Registered with the M4 destruction registry (over the app boundary's `DataEraser`) so a tenant
// offboarding / right-to-erasure request fires M34's OWN eraser for its OWN tenant-attributable rows.
// During the cryptographic shred (§3.5) the M4 destruction-cert workflow calls `callbackAllEraserFns`,
// which invokes THIS eraseFn alongside every other module's — M34 is just one shard among many, and it
// owns the destruction path for its own control-plane working data. The DEK is destroyed AFTER all
// erasers return non-refusal (M34-F08); this eraser is part of the "Phase 1 — per-module eraseFn" step
// whose receipts land in `tenant_account.per_module_eraser_receipts`.
//
// WHAT THIS ERASER REMOVES — the tenant's OPERATIONAL control-plane footprint (§8.4 "erase the tenant's
// view-of-the-world, not the world"): onboarding task rows, support consent grants + support sessions
// (the open/closed session rows), the platform→tenant BAA register, the platform→first-admin tenant
// invitations, the org-less signup intents + signup tokens, and the org-scoped tenant-export jobs (+ the
// export-job event ledger). These are the working rows that have no further compliance value once the
// tenant is destroyed and its DEK is gone.
//
// WHAT THIS ERASER NEVER TOUCHES (deliberate survivors):
//   - The DESTRUCTION / lifecycle LEDGER — `tenant_account`, `tenant_account_status_event`,
//     `tenant_key_ring`, `tenant_key_destruction_log`. §8.4: a destroyed tenant is a ROW with
//     `status='destroyed'` / `destroyed_at` set, NOT a deleted row; the key-ring DEK ciphertext is
//     NULLed by the SECURITY DEFINER `m34_destroy_tenant_key_ring` (§3.6), the ROW remains for the full
//     7-year `compliance` window so the destruction story is reconstructible end-to-end. Deleting these
//     would erase the very proof the destruction certificate is built on.
//   - The §164.528 DISCLOSURE-ACCOUNTING surfaces (§8.2 PHI-Sensitive / 42 CFR Part 2) —
//     `dsar_export_job` (+ `dsar_export_job_event`) and `support_session_event`. These record THAT a DSAR
//     ran for a patient / THAT a ChartWarden support actor touched a patient's chart; they are
//     disclosure-accounting metadata about access, not the patient record of authority, and must outlive
//     the tenant for the disclosure-accounting retention window. M34 never shortens that obligation (§8.4).
//   - `onboarding_task_template` — the org-less reference catalog (shared platform config, not tenant data).
//
// Pure orchestration over the narrow {@link SaasTenantPlatformEraseStore} port — the in-memory store
// implements it for the slice/tests; the Drizzle-backed store (injected by the app-side eraser) implements
// it over the operational tables under `withPlatformContext` so RLS scopes every DELETE. No clock, no I/O
// here, so the offboarding counts are deterministic and assertable.

/** The per-class row counts a tenant-offboarding erase removed (§3.5 destruction certificate receipt). */
export interface SaasTenantPlatformEraseCounts {
  /** `onboarding_task` rows deleted (the per-tenant onboarding checklist; the template catalog survives). */
  readonly onboardingTasks: number;
  /** `support_consent_grant` rows deleted (the tenant-consented break-glass grants). */
  readonly supportConsentGrants: number;
  /** `support_session` rows deleted (the session header rows; `support_session_event` SURVIVES — §164.528). */
  readonly supportSessions: number;
  /** `platform_tenant_baa_record` rows deleted (the platform→tenant BAA register; ≠ M40's tenant↔external). */
  readonly baaRecords: number;
  /** `tenant_invitation` rows deleted (the platform→first-admin invitations; ≠ M2 `organization_invitation`). */
  readonly tenantInvitations: number;
  /** `tenant_signup_intent` rows deleted (org-less pre-provisioning signup intents). */
  readonly signupIntents: number;
  /** `tenant_signup_token` rows deleted (org-less pre-provisioning signup tokens). */
  readonly signupTokens: number;
  /** `tenant_export_job` (+ `tenant_export_job_event`) rows deleted (org-scoped NDJSON-archive jobs). */
  readonly tenantExportJobs: number;
}

/**
 * The narrow data port the M34 eraseFn composes over (a slice of the Drizzle/in-memory backend). Each
 * method DELETEs that table's rows for the offboarding org and reports the count. The Drizzle backend wraps
 * the DELETEs in `withPlatformContext` so RLS scopes every statement; the deliberate survivors (the
 * lifecycle/key-ring ledger + the §164.528 disclosure-accounting tables) intentionally have NO method here.
 */
export interface SaasTenantPlatformEraseStore {
  /** Delete every `onboarding_task` row owned by `orgId`; report the count (the template catalog is untouched). */
  eraseOnboardingTasks(orgId: string): Promise<{ erased: number }>;
  /** Delete every `support_consent_grant` row owned by `orgId`; report the count. */
  eraseSupportConsentGrants(orgId: string): Promise<{ erased: number }>;
  /** Delete every `support_session` header row owned by `orgId`; report the count (events survive — §164.528). */
  eraseSupportSessions(orgId: string): Promise<{ erased: number }>;
  /** Delete every `platform_tenant_baa_record` row owned by `orgId`; report the count. */
  eraseBaaRecords(orgId: string): Promise<{ erased: number }>;
  /** Delete every `tenant_invitation` row owned by `orgId`; report the count. */
  eraseTenantInvitations(orgId: string): Promise<{ erased: number }>;
  /** Delete every `tenant_signup_intent` row owned by `orgId`; report the count. */
  eraseSignupIntents(orgId: string): Promise<{ erased: number }>;
  /** Delete every `tenant_signup_token` row owned by `orgId`; report the count. */
  eraseSignupTokens(orgId: string): Promise<{ erased: number }>;
  /** Delete every `tenant_export_job` (+ its event ledger) row owned by `orgId`; report the job count. */
  eraseTenantExportJobs(orgId: string): Promise<{ erased: number }>;
}

/**
 * Erase a tenant's M34 control-plane footprint on offboarding (D6, §3.5/§8.4): delete the org's
 * operational working rows (onboarding tasks, support grants/sessions, BAA register, tenant invitations,
 * signup intents/tokens, tenant-export jobs) — and NOTHING ELSE. The lifecycle/key-ring destruction ledger
 * and the §164.528 disclosure-accounting surfaces (`dsar_export_job`, `support_session_event`) are NEVER
 * touched (§8.4). `orgId` is the offboarding org (the `subjectId` the M4 destruction registry hands the
 * eraser). Returns the per-class counts the destruction certificate records, plus the `erased` total the
 * `DataEraser` contract reports.
 */
export async function eraseTenantSaasPlatform(
  orgId: string,
  store: SaasTenantPlatformEraseStore,
): Promise<{ erased: number; counts: SaasTenantPlatformEraseCounts }> {
  // Independent per-table deletes — order does not matter (the deliberate survivors are never affected, so
  // there is no FK cascade to sequence across them). Run concurrently for one round trip.
  const [
    onboardingTasks,
    supportConsentGrants,
    supportSessions,
    baaRecords,
    tenantInvitations,
    signupIntents,
    signupTokens,
    tenantExportJobs,
  ] = await Promise.all([
    store.eraseOnboardingTasks(orgId),
    store.eraseSupportConsentGrants(orgId),
    store.eraseSupportSessions(orgId),
    store.eraseBaaRecords(orgId),
    store.eraseTenantInvitations(orgId),
    store.eraseSignupIntents(orgId),
    store.eraseSignupTokens(orgId),
    store.eraseTenantExportJobs(orgId),
  ]);
  const counts: SaasTenantPlatformEraseCounts = {
    onboardingTasks: onboardingTasks.erased,
    supportConsentGrants: supportConsentGrants.erased,
    supportSessions: supportSessions.erased,
    baaRecords: baaRecords.erased,
    tenantInvitations: tenantInvitations.erased,
    signupIntents: signupIntents.erased,
    signupTokens: signupTokens.erased,
    tenantExportJobs: tenantExportJobs.erased,
  };
  const erased =
    counts.onboardingTasks +
    counts.supportConsentGrants +
    counts.supportSessions +
    counts.baaRecords +
    counts.tenantInvitations +
    counts.signupIntents +
    counts.signupTokens +
    counts.tenantExportJobs;
  return { erased, counts };
}

/**
 * An in-memory {@link SaasTenantPlatformEraseStore} for the slice/tests, seeded with per-class counts to
 * remove. A delete clears the org's seeded count, so a re-run reports 0 — the eraser is idempotent.
 */
export function createInMemorySaasTenantPlatformEraseStore(
  seed: {
    onboardingTasksByOrg?: Readonly<Record<string, number>>;
    supportConsentGrantsByOrg?: Readonly<Record<string, number>>;
    supportSessionsByOrg?: Readonly<Record<string, number>>;
    baaByOrg?: Readonly<Record<string, number>>;
    tenantInvitationsByOrg?: Readonly<Record<string, number>>;
    signupIntentsByOrg?: Readonly<Record<string, number>>;
    signupTokensByOrg?: Readonly<Record<string, number>>;
    tenantExportJobsByOrg?: Readonly<Record<string, number>>;
  } = {},
): { store: SaasTenantPlatformEraseStore } {
  const onboardingTasks = new Map(Object.entries(seed.onboardingTasksByOrg ?? {}));
  const supportConsentGrants = new Map(Object.entries(seed.supportConsentGrantsByOrg ?? {}));
  const supportSessions = new Map(Object.entries(seed.supportSessionsByOrg ?? {}));
  const baa = new Map(Object.entries(seed.baaByOrg ?? {}));
  const tenantInvitations = new Map(Object.entries(seed.tenantInvitationsByOrg ?? {}));
  const signupIntents = new Map(Object.entries(seed.signupIntentsByOrg ?? {}));
  const signupTokens = new Map(Object.entries(seed.signupTokensByOrg ?? {}));
  const tenantExportJobs = new Map(Object.entries(seed.tenantExportJobsByOrg ?? {}));
  /** Pop the seeded count for an org (a delete clears it, so a re-run reports 0 — idempotent). */
  const take = (m: Map<string, number>, orgId: string) => {
    const n = m.get(orgId) ?? 0;
    m.set(orgId, 0);
    return { erased: n };
  };
  return {
    store: {
      async eraseOnboardingTasks(orgId) {
        return take(onboardingTasks, orgId);
      },
      async eraseSupportConsentGrants(orgId) {
        return take(supportConsentGrants, orgId);
      },
      async eraseSupportSessions(orgId) {
        return take(supportSessions, orgId);
      },
      async eraseBaaRecords(orgId) {
        return take(baa, orgId);
      },
      async eraseTenantInvitations(orgId) {
        return take(tenantInvitations, orgId);
      },
      async eraseSignupIntents(orgId) {
        return take(signupIntents, orgId);
      },
      async eraseSignupTokens(orgId) {
        return take(signupTokens, orgId);
      },
      async eraseTenantExportJobs(orgId) {
        return take(tenantExportJobs, orgId);
      },
    },
  };
}

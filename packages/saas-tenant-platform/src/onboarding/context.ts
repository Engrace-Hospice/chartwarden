// @wardenx/saas-tenant-platform · onboarding — the structured `OnboardingContext` (M34 §2.3).
//
// The §2.3 onboarding machine is "strictly observable": it never mutates `onboarding_task` rows; it
// evaluates each step's `precondition_dsl` (onboarding_task_template, §3.4) against a structured,
// IO-free `OnboardingContext` that the worker POPULATES at advance-attempt time. Every fact the eleven
// canonical preconditions reference (the §3.12 seed expressions — `context.providerEntityCount > 0`,
// `context.providerEntities[*].ccn != null`, `context.macFeedConfigured == true`, …) is a field here.
//
// The context is gathered cross-module THROUGH SEAMS / READS by the worker (M2 org/provider-entity/
// location/membership reads, M27 external-feed reads, M40 BAA register, the M34 onboarding repo) — the
// pure DSL + machine resolve NO IO. Keeping the shape here (not in the worker) lets the DSL evaluator
// and the machine be unit-tested with a hand-built context and no DB.

/** One provider entity (M2-owned) as the onboarding context sees it — only the fields the §3.12
 *  precondition expressions read (`providerEntities[*].ccn`). M34 takes no `@wardenx/db` edge to M2;
 *  the worker projects this minimal shape from the M2 read it performs. */
export interface OnboardingProviderEntityView {
  readonly providerEntityId: string;
  /** The CCN, or `null` when not yet populated (drives `ccn_registered.precondition`). */
  readonly ccn: string | null;
}

/**
 * The structured, IO-free fact bag the §2.3 onboarding preconditions evaluate against. The worker
 * populates it once per advance attempt (cross-module reads happen there, behind seams); the DSL reads
 * it purely. Field names mirror the §3.12 seed `precondition_dsl` token paths VERBATIM so a seed change
 * (a new step / a tweaked expression) needs no code change — only a context field if a brand-new fact
 * is referenced (D3).
 */
export interface OnboardingContext {
  // ── org_seeded ───────────────────────────────────────────────────────────────────────────────
  /** Count of M2 `provider_entity` rows for the tenant org (`context.providerEntityCount > 0`). */
  readonly providerEntityCount: number;
  /** Count of M2 `location` rows for the tenant org (`context.locationCount > 0`). */
  readonly locationCount: number;
  // ── ccn_registered ───────────────────────────────────────────────────────────────────────────
  /** The tenant's provider entities (`context.providerEntities[*].ccn != null`). */
  readonly providerEntities: readonly OnboardingProviderEntityView[];
  // ── mac_configured ───────────────────────────────────────────────────────────────────────────
  /** Medicare MAC submitter feed configured (Phase 1: platform-ops attestation; M29 ExternalFeed later). */
  readonly macFeedConfigured: boolean;
  // ── dosespot_kickoff_initiated ───────────────────────────────────────────────────────────────
  /** DoseSpot clinic-registration row recorded (M12; Phase 1 attestation). */
  readonly dosespotKickoffRecorded: boolean;
  // ── xero_connected / payroll_connected ───────────────────────────────────────────────────────
  /** Xero OAuth handshake recorded (M27 owns; M34 reads ExternalFeedReader). */
  readonly xeroConnected: boolean;
  /** Gusto payroll OAuth handshake recorded (M27 owns; same pattern). */
  readonly gustoConnected: boolean;
  // ── locations_seeded ─────────────────────────────────────────────────────────────────────────
  /** At least one M2 `location.is_primary = true` exists (`context.primaryLocationExists == true`). */
  readonly primaryLocationExists: boolean;
  // ── first_admin_invited ──────────────────────────────────────────────────────────────────────
  /** Count of accepted `membership.role = 'org_admin'` (`context.orgAdminAcceptedMembershipCount > 0`). */
  readonly orgAdminAcceptedMembershipCount: number;
  // ── go_live_checklist_complete ───────────────────────────────────────────────────────────────
  /** Every canonical onboarding task is done/skipped (mirrors the TenantOnboardingProvider seam). */
  readonly allCanonicalTasksDoneOrSkipped: boolean;
  /** The latest `platform_tenant_baa_record` is `baa_status = 'executed'` (D11). */
  readonly baaExecuted: boolean;
}

/** A read-only projection of a single context path the DSL resolves (string | number | boolean | null,
 *  or an array of provider-entity views for the `[*]` quantifier). The evaluator never sees anything
 *  outside this closed value domain — the DSL is deliberately non-Turing-complete (D3). */
export type OnboardingContextValue =
  | string
  | number
  | boolean
  | null
  | readonly OnboardingProviderEntityView[];

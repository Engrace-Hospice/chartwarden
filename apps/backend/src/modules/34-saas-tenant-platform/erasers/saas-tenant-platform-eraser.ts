// apps/backend/src/modules/34-saas-tenant-platform/erasers/saas-tenant-platform-eraser.ts — M34 the
// `saas_tenant_platform_class` data eraser (D6, §3.5/§8.4). On tenant offboarding M34's eraseFn deletes the
// org's operational control-plane working rows (onboarding tasks, support grants/sessions, BAA register,
// tenant invitations, signup intents/tokens, tenant-export jobs) and NOTHING ELSE — the lifecycle/key-ring
// destruction ledger and the §164.528 disclosure-accounting surfaces (`dsar_export_job`,
// `support_session_event`) SURVIVE. Unlike every patient-subject eraser, `subjectId` here is the ORG being
// offboarded (the platform control plane has no patient subject), so the `DataEraser.erase(scope, subjectId)`
// bridge below passes `subjectId` (the org) straight to the package's `eraseTenantSaasPlatform(orgId, store)`.
//
// The pure eraseFn + its narrow store port + the in-memory store live in `@wardenx/saas-tenant-platform`
// (eraser.ts); this backend wrapper only adapts them to the M1 `DataEraser` contract and registers the REAL
// eraser over the Phase-0 `saas_tenant_platform_class` deny-stub via the composition-root hook (the
// `saas_tenant_platform_class` data class is in REQUIRED_ERASERS, so wireErasers() deny-stubs it first and
// this real eraser stands over the stub before validateErasers() — the same M22/M36/M40 registration shape).
import { type DbClient, schema } from "@wardenx/db";
import {
  type SaasTenantPlatformEraseStore,
  createInMemorySaasTenantPlatformEraseStore,
  eraseTenantSaasPlatform,
} from "@wardenx/saas-tenant-platform";
import { type PlatformBypassAuditor, withPlatformContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { eq, inArray } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";
import type { PlatformTx } from "../routes/platform/service-drizzle";
import { M34_PLATFORM_JOB_ID } from "../wiring";

/** Deps for the M34 eraser registration; absent ⇒ the in-memory slice store (prod injects the Drizzle store). */
export interface SaasTenantPlatformEraserDeps {
  /** The Drizzle-backed `SaasTenantPlatformEraseStore` in prod (DELETEs under `withPlatformContext` so RLS
   *  scopes each statement); the in-memory slice store by default. */
  readonly store?: SaasTenantPlatformEraseStore;
}

/** Deps the Drizzle-backed M34 erase store binds (the platform pool + the mandatory bypass auditor). */
export interface DrizzleSaasTenantPlatformEraseDeps {
  /** Separately-pooled platform credential (`DATABASE_PLATFORM_URL`; NOT the tenant pool). */
  readonly platformDb: DbClient;
  /** Emits the mandatory `platform.bypass_invoked` audit event for every platform-context entry (F09). */
  readonly auditBypass: PlatformBypassAuditor<PlatformTx>;
  /** The allowlisted platform-job id; defaults to {@link M34_PLATFORM_JOB_ID} (`wireM34Tenancy` registers it). */
  readonly platformJobId?: string;
}

/**
 * The Drizzle-backed {@link SaasTenantPlatformEraseStore}: the REAL §8.4 tenant-offboarding destruction
 * path (TASK-003 / ARCH-007). Every DELETE runs inside `withPlatformContext` (audited, allowlist-gated —
 * a caller whose `platformJobId` is not registered is REFUSED with the tenancy layer's
 * `PlatformContextDeniedError`, and every entry emits `platform.bypass_invoked`). Counts come from
 * `returning(...)` lengths — rows ACTUALLY removed. Only the eight operational classes the port names are
 * touched; the lifecycle/key-ring destruction ledger and the §164.528 disclosure-accounting surfaces
 * (`dsar_export_job`, `support_session_event`) have NO method here and are never reached.
 *
 * INTERNAL SERIALIZATION + FK CARRY. `eraseTenantSaasPlatform` fires the eight methods CONCURRENTLY
 * (`Promise.all`), but two pairs are ordered in the database:
 *   · `support_session.support_consent_grant_id` → `support_consent_grant` (FK, ON DELETE RESTRICT) —
 *     the grant delete must not run while the org's session headers exist;
 *   · `tenant_signup_token.tenant_signup_intent_id` → `tenant_signup_intent` (app-validated, no SQL FK) —
 *     tokens are only REACHABLE through their parent intents, so deleting intents first would orphan them.
 * The store therefore serializes its methods on an internal promise chain (call order = the orchestrator's
 * array order, deterministic), and the parent-side method removes the dependent rows first inside the same
 * transaction, CARRYING the count to the dependent method so every per-class count stays exact.
 *
 * The org-less signup rows are scoped through the provisioning bridge: `tenant_account.organization_id =
 * org` → `tenant_signup_intent.tenant_account_id` → `tenant_signup_token.tenant_signup_intent_id`. An
 * intent never provisioned into THIS org (`tenant_account_id` NULL or another org's) is untouched — it is
 * genuinely pre-organization and not this tenant's data. `tenant_export_job_event` (the job ledger) is
 * deleted with its jobs; the port reports the JOB count (the ledger rows ride along, per the port doc).
 */
export function createDrizzleSaasTenantPlatformEraseStore(
  deps: DrizzleSaasTenantPlatformEraseDeps,
): SaasTenantPlatformEraseStore {
  const jobId = deps.platformJobId ?? M34_PLATFORM_JOB_ID;
  const TASK = schema.onboardingTask;
  const GRANT = schema.supportConsentGrant;
  const SESSION = schema.supportSession;
  const BAA = schema.platformTenantBaaRecord;
  const INVITE = schema.tenantInvitation;
  const INTENT = schema.tenantSignupIntent;
  const TOKEN = schema.tenantSignupToken;
  const JOB = schema.tenantExportJob;
  const JOB_EVENT = schema.tenantExportJobEvent;
  const ACCOUNT = schema.tenantAccount;

  const inPlatform = <T>(reason: string, fn: (tx: PlatformTx) => Promise<T>): Promise<T> =>
    withPlatformContext<PlatformTx, T>(
      deps.platformDb,
      { jobId, reason, crossTenant: true },
      deps.auditBypass,
      fn,
    );

  // Serialize the per-class methods (see the factory header): call order = the orchestrator's order.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn); // run even when an earlier class failed — classes are independent
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  /** Cross-method carry for the two dependent classes (consumed once; keyed by org). */
  const carried = new Map<string, { supportSessions: number; signupTokens: number }>();
  const carryFor = (orgId: string) => {
    let c = carried.get(orgId);
    if (!c) {
      c = { supportSessions: 0, signupTokens: 0 };
      carried.set(orgId, c);
    }
    return c;
  };
  const takeCarry = (orgId: string, key: "supportSessions" | "signupTokens"): number => {
    const c = carried.get(orgId);
    if (!c) return 0;
    const n = c[key];
    c[key] = 0;
    return n;
  };

  /** The org's signup-intent ids, reached through the provisioning bridge (see the factory header). */
  const intentIdsFor = async (tx: PlatformTx, orgId: string): Promise<string[]> => {
    const accounts = await tx
      .select({ id: ACCOUNT.id })
      .from(ACCOUNT)
      .where(eq(ACCOUNT.organizationId, orgId));
    if (accounts.length === 0) return [];
    const intents = await tx
      .select({ id: INTENT.id })
      .from(INTENT)
      .where(
        inArray(
          INTENT.tenantAccountId,
          accounts.map((a) => a.id),
        ),
      );
    return intents.map((i) => i.id);
  };

  return {
    eraseOnboardingTasks(orgId) {
      return serialize(() =>
        inPlatform("m34 tenant-offboarding erase: onboarding_task", async (tx) => {
          const rows = await tx
            .delete(TASK)
            .where(eq(TASK.organizationId, orgId))
            .returning({ id: TASK.id });
          return { erased: rows.length };
        }),
      );
    },

    eraseSupportConsentGrants(orgId) {
      return serialize(() =>
        inPlatform("m34 tenant-offboarding erase: support_consent_grant", async (tx) => {
          // FK (RESTRICT): support_session → support_consent_grant. The org's session HEADERS go first
          // inside this tx (count carried to eraseSupportSessions); support_session_event SURVIVES
          // (§164.528 — app-validated parent ref, no SQL FK, so the header delete cannot cascade into it).
          const sessions = await tx
            .delete(SESSION)
            .where(eq(SESSION.organizationId, orgId))
            .returning({ id: SESSION.id });
          carryFor(orgId).supportSessions = sessions.length;
          const grants = await tx
            .delete(GRANT)
            .where(eq(GRANT.organizationId, orgId))
            .returning({ id: GRANT.id });
          return { erased: grants.length };
        }),
      );
    },

    eraseSupportSessions(orgId) {
      return serialize(() =>
        inPlatform("m34 tenant-offboarding erase: support_session", async (tx) => {
          const rows = await tx
            .delete(SESSION)
            .where(eq(SESSION.organizationId, orgId))
            .returning({ id: SESSION.id });
          return { erased: rows.length + takeCarry(orgId, "supportSessions") };
        }),
      );
    },

    eraseBaaRecords(orgId) {
      return serialize(() =>
        inPlatform("m34 tenant-offboarding erase: platform_tenant_baa_record", async (tx) => {
          const rows = await tx
            .delete(BAA)
            .where(eq(BAA.organizationId, orgId))
            .returning({ id: BAA.id });
          return { erased: rows.length };
        }),
      );
    },

    eraseTenantInvitations(orgId) {
      return serialize(() =>
        inPlatform("m34 tenant-offboarding erase: tenant_invitation", async (tx) => {
          const rows = await tx
            .delete(INVITE)
            .where(eq(INVITE.organizationId, orgId))
            .returning({ id: INVITE.id });
          return { erased: rows.length };
        }),
      );
    },

    eraseSignupIntents(orgId) {
      return serialize(() =>
        inPlatform("m34 tenant-offboarding erase: tenant_signup_intent", async (tx) => {
          const intentIds = await intentIdsFor(tx, orgId);
          if (intentIds.length === 0) return { erased: 0 };
          // Tokens are only reachable through their parent intents (no SQL FK): delete them first in
          // this tx (count carried to eraseSignupTokens) so the intent delete cannot orphan them.
          const tokens = await tx
            .delete(TOKEN)
            .where(inArray(TOKEN.tenantSignupIntentId, intentIds))
            .returning({ id: TOKEN.id });
          carryFor(orgId).signupTokens = tokens.length;
          const intents = await tx
            .delete(INTENT)
            .where(inArray(INTENT.id, intentIds))
            .returning({ id: INTENT.id });
          return { erased: intents.length };
        }),
      );
    },

    eraseSignupTokens(orgId) {
      return serialize(() =>
        inPlatform("m34 tenant-offboarding erase: tenant_signup_token", async (tx) => {
          const intentIds = await intentIdsFor(tx, orgId);
          const rows =
            intentIds.length === 0
              ? []
              : await tx
                  .delete(TOKEN)
                  .where(inArray(TOKEN.tenantSignupIntentId, intentIds))
                  .returning({ id: TOKEN.id });
          return { erased: rows.length + takeCarry(orgId, "signupTokens") };
        }),
      );
    },

    eraseTenantExportJobs(orgId) {
      return serialize(() =>
        inPlatform("m34 tenant-offboarding erase: tenant_export_job (+ event ledger)", async (tx) => {
          // The event ledger rides along with its jobs (app-validated parent ref, partitioned table);
          // the port reports the JOB count. `dsar_export_job` (+ events) is NEVER touched (§164.528).
          await tx.delete(JOB_EVENT).where(eq(JOB_EVENT.organizationId, orgId));
          const jobs = await tx
            .delete(JOB)
            .where(eq(JOB.organizationId, orgId))
            .returning({ id: JOB.id });
          return { erased: jobs.length };
        }),
      );
    },
  };
}

/** Adapt the package's pure `eraseTenantSaasPlatform(orgId, store)` to the M1 `DataEraser` contract. */
export function createSaasTenantPlatformEraser(store: SaasTenantPlatformEraseStore): DataEraser {
  return {
    // `subjectId` IS the offboarding org for this control-plane class (no patient subject); the M4
    // destruction registry hands it in as the subject the certificate records.
    async erase(_scope, subjectId) {
      const { erased } = await eraseTenantSaasPlatform(subjectId, store);
      return { erased };
    },
  };
}

/**
 * Register the REAL M34 control-plane eraser over the Phase-0 `saas_tenant_platform_class` deny-stub. Called
 * by the composition root's `registerModuleErasers` hook (after wireErasers(), before validateErasers()), the
 * same hook M5/M6/M22/M36/M40 use. The in-memory slice store is the default; prod injects the Drizzle store.
 *
 * Prod injects `createDrizzleSaasTenantPlatformEraseStore({ platformDb, auditBypass })` via `deps.store`
 * (every DELETE under `withPlatformContext`, allowlist-gated + bypass-audited) so the eraser runs against
 * the real M34 tables — `wireM34Tenancy()` must have registered {@link M34_PLATFORM_JOB_ID} first, or the
 * store's first statement is refused (fail-closed). The package's `seam-bootstrap.ts` carries the matching
 * TODO for registering this eraseFn into M4's destruction-cert callback registry once the M4 cert-driven
 * destruction binding lands.
 */
export function registerSaasTenantPlatformErasers(deps: SaasTenantPlatformEraserDeps = {}): void {
  const store = deps.store ?? createInMemorySaasTenantPlatformEraseStore().store;
  registerEraser("saas_tenant_platform_class", createSaasTenantPlatformEraser(store));
}

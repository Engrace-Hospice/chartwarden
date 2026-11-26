// apps/backend/src/modules/04-audit/jobs/security-review-job.ts — the scheduled review of the audit trail (CW-MON-01;
// HIPAA §164.308(a)(1)(ii)(D) information-system activity review, §164.308(a)(5)(ii)(C) log-in monitoring; SOC 2 CC7.2–CC7.3).
//
// Until this job, M4 recorded audit events and nothing read them. Every tick (a cron is not a request) this job:
//   · PLATFORM LANE — once: reviews the org-less authentication events (failed sign-ins, lockouts, successful sign-ins) that
//     no tenant context can read, under an audited `withPlatformContext` (job id `m4.security_review`, reading
//     `organization_id IS NULL` rows only, through three bounded SECURITY DEFINER readers: the platform login has no SELECT
//     on `audit_event` itself, migration 1566);
//   · ORG LANE — for every active or suspended organization: reviews that organization's events under its own `withOrgContext`
//     (`systemOrgContext`: a null system actor, never an ambient request actor), so RLS scopes every read.
// Each run evaluates the rules in `@chartwarden/audit` (`SECURITY_RULES`), raises every NEW finding through the alert sink
// (the existing ops alert path: a log line plus `OPS_ALERT_WEBHOOK_URL`), and appends the review record to the audit trail
// (`m4.security_review.completed`, `m4.security_review.alert_raised`). See `runSecurityReview` for the cursor and retry rules.
//
// FAIL LOUD. An alert that could not be delivered leaves the run `delivery_failed` (its cursor does not move, so the next run
// retries) and this job THROWS after the record is committed, so BullMQ fails the job and the DLQ alert fires; it never reports
// green over an undelivered alert. One scope's failure never skips the others (the tick collects them and fails once, naming them).
//
// ADDING A DETECTION is one entry in `SECURITY_RULES` (packages/audit/src/review/rules.ts); nothing here names a rule.
import {
  type ReviewSqlExecutor,
  type ReviewWriteExecutor,
  SECURITY_RULES,
  type SecurityAlertSink,
  type SecurityReviewResult,
  type SecurityRule,
  runSecurityReview,
} from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import {
  type PlatformBypassAuditor,
  systemOrgContext,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";

/** The platform job id the org-less lane enters `withPlatformContext` under (registered at boot, like the other M4 jobs). */
export const M4_SECURITY_REVIEW_PLATFORM_JOB_ID = "m4.security_review";
/** The BullMQ queue; one owner (M4), declared here for `arch:queue-names`. */
export const SECURITY_REVIEW_QUEUE = "audit.security_review";
/** Every 15 minutes: 96 review records per scope per day, and an alert reaches a human within one run of the event. */
export const SECURITY_REVIEW_CRON = "*/15 * * * *";

type ReviewTx = ReviewWriteExecutor & ReviewSqlExecutor;

export interface SecurityReviewDeps {
  /** The tenant pool (`chartwarden_app`, RLS enforced). */
  readonly db: DbClient;
  /** The platform pool (`chartwarden_platform_login`), for the org-less lane only. */
  readonly platformDb: DbClient;
  /** Audits every `withPlatformContext` entry (fail-closed). */
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly listOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly sink: SecurityAlertSink;
  /** Defaults to the full catalog; a test narrows it. */
  readonly rules?: readonly SecurityRule[];
  readonly now?: () => Date;
  readonly newCorrelationId?: () => string;
  /** Operational log line (a skipped scope). Ids only. */
  readonly log?: (message: string) => void;
}

const inputFor = (deps: SecurityReviewDeps, tx: unknown, organizationId: string | null) => ({
  tx: tx as ReviewTx,
  scope: { organizationId },
  rules: deps.rules ?? SECURITY_RULES,
  sink: deps.sink,
  now: (deps.now ?? (() => new Date()))(),
  correlationId: (deps.newCorrelationId ?? (() => `m4-security-review:${crypto.randomUUID()}`))(),
});

/** One organization's review, under that organization's own context. */
export function runSecurityReviewForOrg(
  deps: SecurityReviewDeps,
  organizationId: string,
): Promise<SecurityReviewResult> {
  return withOrgContext(deps.db, systemOrgContext(organizationId), (tx) =>
    runSecurityReview(inputFor(deps, tx, organizationId)),
  );
}

/** The org-less authentication lane, under an audited platform context. */
export function runSecurityReviewForPlatform(
  deps: SecurityReviewDeps,
): Promise<SecurityReviewResult> {
  return withPlatformContext(
    deps.platformDb,
    {
      jobId: M4_SECURITY_REVIEW_PLATFORM_JOB_ID,
      reason: "CW-MON-01 security review of org-less authentication events",
      // Reads `organization_id IS NULL` rows only: no tenant's data is touched, so this is not a cross-tenant read.
      crossTenant: false,
    },
    deps.auditBypass,
    (tx) => runSecurityReview(inputFor(deps, tx, null)),
  );
}

/**
 * A run that left an alert undelivered is committed, then reported as a failure of the job. A run that was `skipped` (another run
 * of the scope held its lock) did nothing and is not a failure: that other run is the one that reviews it.
 */
function assertDelivered(
  label: string,
  result: SecurityReviewResult,
  log?: (message: string) => void,
): void {
  if (result.skipped) {
    // Silent would hide a lock that is stuck for good (a transaction that never ends): say it every time it happens.
    log?.(`M4 security review: ${label} skipped, another run holds its lock`);
    return;
  }
  if (result.run.status === "ok") return;
  throw new Error(
    `M4_SECURITY_REVIEW: ${label} left ${result.run.failed} alert(s) undelivered and ${result.run.deferred} deferred; the next run retries`,
  );
}

/** Scopes named in a failure message (ids and a lane name only), capped so a mass failure stays one readable line. */
const MAX_LABELS_IN_MESSAGE = 5;

/**
 * One scheduled tick: the platform lane, then every reviewed organization. A scope's failure never skips the next; they are
 * collected and the job fails once, naming the scopes (the DLQ line carries only this message).
 */
export async function runSecurityReviewTick(
  deps: SecurityReviewDeps,
): Promise<{ readonly orgs: number }> {
  const failures: { readonly label: string; readonly error: unknown }[] = [];
  const attempt = async (
    label: string,
    run: () => Promise<SecurityReviewResult>,
  ): Promise<void> => {
    try {
      assertDelivered(label, await run(), deps.log);
    } catch (error) {
      failures.push({ label, error });
    }
  };
  await attempt("platform lane", () => runSecurityReviewForPlatform(deps));
  let orgs: readonly { readonly organizationId: string }[] = [];
  try {
    orgs = await deps.listOrgs();
  } catch (error) {
    failures.push({ label: "organization list", error });
  }
  for (const { organizationId } of orgs) {
    await attempt(`org ${organizationId}`, () => runSecurityReviewForOrg(deps, organizationId));
  }
  if (failures.length > 0) {
    const named = failures.slice(0, MAX_LABELS_IN_MESSAGE).map((f) => f.label);
    const more = failures.length > named.length ? `, +${failures.length - named.length} more` : "";
    throw new AggregateError(
      failures.map((f) => f.error),
      `M4_SECURITY_REVIEW: ${failures.length} scope failure(s): ${named.join(", ")}${more}`,
    );
  }
  return { orgs: orgs.length };
}

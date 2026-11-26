// CW-MON-01 — the review tick: both lanes, failures collected rather than short-circuiting, an undelivered alert failing the job,
// and a static guard that the composition root actually constructs the worker (a bound consumer is not a computing one).
// `runSecurityReview` and the tenancy contexts are replaced so only the job's own orchestration is under test; the real SQL,
// RLS and writers are proven in m4-security-review.live.test.ts. Identifiers are synthetic.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SecurityReviewResult } from "@chartwarden/audit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runSecurityReview = vi.fn();
const withOrgContext = vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
  fn({}),
);
const withPlatformContext = vi.fn(
  async (_db: unknown, _caller: unknown, _audit: unknown, fn: (tx: unknown) => unknown) => fn({}),
);

vi.mock("@chartwarden/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chartwarden/audit")>()),
  runSecurityReview: (input: unknown) => runSecurityReview(input),
}));
vi.mock("@chartwarden/tenancy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chartwarden/tenancy")>()),
  withOrgContext: (...args: Parameters<typeof withOrgContext>) => withOrgContext(...args),
  withPlatformContext: (...args: Parameters<typeof withPlatformContext>) =>
    withPlatformContext(...args),
}));

import {
  M4_SECURITY_REVIEW_PLATFORM_JOB_ID,
  SECURITY_REVIEW_CRON,
  SECURITY_REVIEW_QUEUE,
  type SecurityReviewDeps,
  runSecurityReviewTick,
} from "../src/modules/04-audit/jobs/security-review-job";

const ORG_A = "00000000-0000-4000-8000-0000000004a1";
const ORG_B = "00000000-0000-4000-8000-0000000004b1";

const result = (status: "ok" | "delivery_failed" = "ok"): SecurityReviewResult =>
  ({
    skipped: false,
    run: { status, failed: status === "ok" ? 0 : 1, deferred: 0 },
    raised: [],
  }) as unknown as SecurityReviewResult;
/** A run that found another run of its scope holding the lock. */
const skippedRun = { skipped: true, run: null, raised: [] } as unknown as SecurityReviewResult;

const deps = (over: Partial<SecurityReviewDeps> = {}): SecurityReviewDeps => ({
  db: {} as never,
  platformDb: {} as never,
  auditBypass: (async () => undefined) as never,
  listOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
  sink: async () => "delivered",
  newCorrelationId: () => "corr-test",
  ...over,
});

const scopes = (): (string | null)[] =>
  runSecurityReview.mock.calls.map(
    (c) => (c[0] as { scope: { organizationId: string | null } }).scope.organizationId,
  );

beforeEach(() => {
  vi.clearAllMocks();
  runSecurityReview.mockResolvedValue(result());
});

describe("runSecurityReviewTick", () => {
  it("reviews the platform lane once, then every active organization, each under its own context", async () => {
    await expect(runSecurityReviewTick(deps())).resolves.toEqual({ orgs: 2 });
    expect(scopes()).toEqual([null, ORG_A, ORG_B]);
    expect(withPlatformContext).toHaveBeenCalledTimes(1);
    expect(withPlatformContext.mock.calls[0]?.[1]).toMatchObject({
      jobId: M4_SECURITY_REVIEW_PLATFORM_JOB_ID,
      crossTenant: false,
    });
    // a cron tick is not a request: a null SYSTEM actor, never an ambient request actor
    expect(withOrgContext.mock.calls.map((c) => c[1])).toEqual([
      { organizationId: ORG_A, userId: "", systemActor: true },
      { organizationId: ORG_B, userId: "", systemActor: true },
    ]);
  });

  it("still reviews every organization when the platform lane fails, then fails the job", async () => {
    runSecurityReview.mockRejectedValueOnce(new Error("platform pool down"));
    const error = await runSecurityReviewTick(deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toMatchObject({ message: "platform pool down" });
    expect(scopes()).toEqual([null, ORG_A, ORG_B]);
  });

  it("does not let one organization's failure skip the next, and fails the job", async () => {
    runSecurityReview.mockResolvedValueOnce(result()); // platform
    runSecurityReview.mockRejectedValueOnce(new Error("org A read failed"));
    await expect(runSecurityReviewTick(deps())).rejects.toThrow(/M4_SECURITY_REVIEW/);
    expect(scopes()).toEqual([null, ORG_A, ORG_B]);
  });

  it("fails the job, after the record is committed, when a run left an alert undelivered", async () => {
    runSecurityReview.mockResolvedValueOnce(result());
    runSecurityReview.mockResolvedValueOnce(result("delivery_failed"));
    runSecurityReview.mockResolvedValueOnce(result());
    const error = await runSecurityReviewTick(deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String((error as AggregateError).errors[0])).toMatch(
      new RegExp(`org ${ORG_A} left 1 alert\\(s\\) undelivered`),
    );
    // the DLQ line carries only the message, so it names the scope (ids only)
    expect((error as AggregateError).message).toBe(
      `M4_SECURITY_REVIEW: 1 scope failure(s): org ${ORG_A}`,
    );
    expect(scopes()).toEqual([null, ORG_A, ORG_B]); // B was still reviewed
  });

  it("is not a failure when a scope was skipped because another run of it held the lock", async () => {
    runSecurityReview.mockResolvedValueOnce(skippedRun); // platform
    runSecurityReview.mockResolvedValueOnce(result()); // A
    runSecurityReview.mockResolvedValueOnce(skippedRun); // B
    const log = vi.fn();
    await expect(runSecurityReviewTick(deps({ log }))).resolves.toEqual({ orgs: 2 });
    // …but never silent: a lock that stays taken for good would otherwise be invisible
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      "M4 security review: platform lane skipped, another run holds its lock",
      `M4 security review: org ${ORG_B} skipped, another run holds its lock`,
    ]);
  });

  it("names at most five failed scopes and counts the rest", async () => {
    const orgs = Array.from({ length: 7 }, (_, i) => ({
      organizationId: `00000000-0000-4000-8000-00000000050${i}`,
    }));
    runSecurityReview.mockRejectedValue(new Error("pool down"));
    const error = await runSecurityReviewTick(deps({ listOrgs: async () => orgs })).catch(
      (e: unknown) => e,
    );
    const message = (error as AggregateError).message;
    expect(message).toContain(
      "8 scope failure(s): platform lane, org 00000000-0000-4000-8000-000000000500",
    );
    expect(message).toContain(", +3 more");
  });

  it("still runs the platform lane, and fails, when the organization list cannot be read", async () => {
    const error = await runSecurityReviewTick(
      deps({ listOrgs: async () => Promise.reject(new Error("platform pool down")) }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect(scopes()).toEqual([null]);
  });
});

describe("wiring (a bound consumer is not a computing one)", () => {
  const source = (path: string): string => readFileSync(join(__dirname, "..", "src", path), "utf8");

  it("is registered, constructed and scheduled by the composition root", () => {
    const root = source("index.ts");
    expect(root).toContain("registerPlatformJob(M4_SECURITY_REVIEW_PLATFORM_JOB_ID)");
    expect(root).toContain("buildSecurityAlertSink(");
    expect(root).toMatch(/registerAuditOpsWorkers\(\{[^}]*securityReview: m4SecurityReview/s);
    expect(root).toMatch(/scheduleAuditOpsJobs\(queueConnection, \{[^}]*securityReview: true/s);
  });

  it("builds a Worker on the queue and a repeatable job on the cron", () => {
    const workers = source("modules/04-audit/jobs/audit-ops-workers.ts");
    expect(workers).toContain(
      "new Worker(SECURITY_REVIEW_QUEUE, () => runSecurityReviewTick(securityReview)",
    );
    expect(workers).toContain("{ name: SECURITY_REVIEW_QUEUE, pattern: SECURITY_REVIEW_CRON }");
    expect(SECURITY_REVIEW_QUEUE).toBe("audit.security_review");
    expect(SECURITY_REVIEW_CRON).toBe("*/15 * * * *");
  });
});

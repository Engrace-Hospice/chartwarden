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
    run: { status, failed: status === "ok" ? 0 : 1, deferred: 0 },
    raised: [],
  }) as unknown as SecurityReviewResult;

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
    const orgFailures = (error as AggregateError).errors[0] as AggregateError; // the org fan-out's own aggregate
    expect(String(orgFailures.errors[0])).toMatch(
      new RegExp(`org ${ORG_A} left 1 alert\\(s\\) undelivered`),
    );
    expect(scopes()).toEqual([null, ORG_A, ORG_B]); // B was still reviewed
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

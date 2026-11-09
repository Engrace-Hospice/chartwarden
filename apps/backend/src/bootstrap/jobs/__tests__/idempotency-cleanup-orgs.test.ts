// The idempotency.cleanup sweeper must reach EVERY organization status. The enumerator defaults to ['active'], so an org in
// `created` (the onboarding orgs, where the platform writes onboarding data with an Idempotency-Key), `suspended` or `closed`
// kept its expired `idempotency_key` rows forever. The sweeper has its own enumeration over every status.
import { schema } from "@chartwarden/db";
import { describe, expect, it, vi } from "vitest";

const built: Array<Record<string, unknown>> = [];
vi.mock("../../active-org-enumerator", () => ({
  buildActiveOrgEnumerator: (deps: Record<string, unknown>) => {
    built.push(deps);
    return { listActiveOrgs: async () => [] };
  },
}));

import {
  IDEMPOTENCY_CLEANUP_JOB_ID,
  IDEMPOTENCY_CLEANUP_ORG_STATUSES,
  buildIdempotencyCleanupOrgs,
} from "../idempotency-cleanup";

describe("idempotency.cleanup org enumeration", () => {
  it("covers every organization status the database has (created, active, suspended, closed)", () => {
    expect([...IDEMPOTENCY_CLEANUP_ORG_STATUSES].sort()).toEqual(
      [...schema.organizationStatus.enumValues].sort(),
    );
  });

  it("enumerates under the cleanup's own platform job id and every status, not the active-only default", () => {
    const platformDb = {} as never;
    const auditBypass = (async () => {}) as never;
    buildIdempotencyCleanupOrgs({ platformDb, auditBypass });
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({
      platformDb,
      auditBypass,
      jobId: IDEMPOTENCY_CLEANUP_JOB_ID,
      statuses: [...IDEMPOTENCY_CLEANUP_ORG_STATUSES],
    });
    expect(String(built[0]?.reason)).toMatch(/every organization status/i);
  });
});

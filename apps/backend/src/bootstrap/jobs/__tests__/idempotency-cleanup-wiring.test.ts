// "Bound is not computing": the unit tests of the enumeration cannot see index.ts. The sweeper's registrar OWNS the every-status
// enumeration (it takes the platform pool and the bypass auditor, not an enumerator), so index.ts cannot hand it the active-only
// one; and the composition root's call is asserted at source level, so reverting it to an `activeOrgs:` binding fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const built: Array<Record<string, unknown>> = [];
let listCalls = 0;
const workers: Array<{ queue: string; processor: () => Promise<unknown> }> = [];

vi.mock("../../active-org-enumerator", () => ({
  buildActiveOrgEnumerator: (deps: Record<string, unknown>) => {
    built.push(deps);
    return {
      listActiveOrgs: async () => {
        listCalls += 1;
        return [];
      },
    };
  },
}));
vi.mock("bullmq", () => ({
  Worker: class {
    constructor(queue: string, processor: () => Promise<unknown>) {
      workers.push({ queue, processor });
    }
  },
  Queue: class {},
}));

import {
  IDEMPOTENCY_CLEANUP_JOB_ID,
  IDEMPOTENCY_CLEANUP_ORG_STATUSES,
  IDEMPOTENCY_CLEANUP_QUEUE,
  registerIdempotencyCleanupWorker,
} from "../idempotency-cleanup";

const indexSource = readFileSync(join(__dirname, "../../../index.ts"), "utf8");

describe("the idempotency.cleanup worker is bound to the every-status enumeration", () => {
  it("builds its own enumeration over every status under the cleanup's job id, and its processor runs it", async () => {
    const platformDb = {} as never;
    const auditBypass = (async () => {}) as never;
    registerIdempotencyCleanupWorker({} as never, { db: {} as never, platformDb, auditBypass });
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({
      platformDb,
      auditBypass,
      jobId: IDEMPOTENCY_CLEANUP_JOB_ID,
      statuses: [...IDEMPOTENCY_CLEANUP_ORG_STATUSES],
    });
    const worker = workers.find((w) => w.queue === IDEMPOTENCY_CLEANUP_QUEUE);
    expect(worker).toBeDefined();
    await worker?.processor();
    expect(listCalls).toBe(1);
  });

  it("the composition root registers it with the platform pool and auditor, never an enumerator of its own", () => {
    const call = /registerIdempotencyCleanupWorker\(queueConnection, \{([^}]*)\}\)/s.exec(
      indexSource,
    );
    expect(call, "index.ts no longer registers the idempotency cleanup worker").not.toBeNull();
    expect(call?.[1]).toMatch(/platformDb: platformDbHandle\?\.db/);
    expect(call?.[1]).toMatch(/auditBypass: m34PlatformBypassAuditor/);
    expect(call?.[1]).not.toMatch(/activeOrgs|m1m3ActiveOrgs/);
    expect(indexSource).not.toMatch(/m1m3ActiveOrgs\(\s*IDEMPOTENCY_CLEANUP_JOB_ID/);
  });
});

// apps/backend/__tests__/m10-iqies-pipeline.test.ts — F-072 (#177).
//
// §4.10 is three stages. F-058 (#150) built stage 1; stages 2 and 3 were unbuilt, and with them five
// pure planners that had shipped unit-tested with ZERO production callers — `decideSubmitReadiness`,
// `buildSubmissionEnvelope`, `planTransmitResult`, `planReconcile` — plus `hasBlockingError`, whose
// only job is to gate a transmit that had no transmit-time to run in. Every batch stopped at `queued`,
// so `m10.hope.submission_transmitted` / `_accepted` / `_rejected` were emitted by nothing.
//
// SCOPE OF THIS FILE, stated because it is narrow on purpose. Both workers are almost entirely
// orchestration over Drizzle — a CAS, a guarded roll-back, per-item writes — and a fake `DbClient`
// built to satisfy them would pass or fail on the fidelity of the fake rather than on the code. The
// first draft of this suite did exactly that: an "the unbound adapter is loud" case went green because
// the fake threw on `.select()` before the adapter was ever reached, which proves nothing.
//
// So the orchestration is proven against real Postgres in `m10-iqies-pipeline.live.test.ts`, and what
// stays here is what a unit test can honestly hold: the pieces reachable without a database.
import { describe, expect, it } from "vitest";
import {
  IQIES_BATCHES_PER_TICK,
  IQIES_SUBMIT_BLOCKED_RULE,
  type M10WorkerDeps,
  runIqiesReconcileCron,
  runIqiesSubmitCron,
  runSubmissionJob,
  transmitCorrelationId,
} from "../src/modules/10-hope/index";

/** Deps whose org enumerator is empty, so no tick ever reaches the database. */
function noOrgDeps(): M10WorkerDeps {
  return {
    connection: {} as never,
    db: {} as never,
    outbox: { async publish() {} },
    activeOrgs: { listActiveOrgs: async () => [] },
    now: () => new Date("2026-08-27T10:00:00.000Z"),
  };
}

describe("F-072 — the transmit idempotency key", () => {
  it("is deterministic in the submission id, so a retry is the SAME request", () => {
    // A transmit that times out may or may not have reached CMS. `releaseSubmission` puts the batch
    // back to `queued` so a later tick retries it, and the ONLY thing that makes that safe is the
    // retry carrying the same correlation id — the at-least-once-plus-idempotency-key posture
    // CHARTWARDEN_INTEGRATIONS_v0_1.md §5 prescribes for every outbox-driven external call.
    expect(transmitCorrelationId("sub-a")).toBe(transmitCorrelationId("sub-a"));
    expect(transmitCorrelationId("sub-a")).not.toBe(transmitCorrelationId("sub-b"));
  });
});

describe("F-072 — the shared hope.submission queue dispatches on the job name", () => {
  it("routes each of the three §4.10 stages", async () => {
    const seen: string[] = [];
    const deps = noOrgDeps();
    for (const name of [
      "assemble-hope-submission",
      "iqies-submit-worker",
      "iqies-reconcile-worker",
    ]) {
      await runSubmissionJob(name, deps);
      seen.push(name);
    }
    expect(seen).toHaveLength(3);
  });

  it("refuses an unrecognised job rather than succeeding quietly", async () => {
    // The §4.8 catalog names ONE queue for the whole submission pipeline, so the job name is the
    // dispatch key. A worker that no-opped on an unknown name would hide a disagreement between the
    // schedule and the dispatcher forever — the same silence this whole change exists to end.
    await expect(runSubmissionJob("not-a-job", noOrgDeps())).rejects.toThrow(
      /M10_UNKNOWN_SUBMISSION_JOB/,
    );
  });
});

describe("F-072 — a tick with no active orgs", () => {
  it("reports an empty outcome instead of throwing", async () => {
    await expect(runIqiesSubmitCron(noOrgDeps())).resolves.toEqual({
      transmitted: [],
      blocked: [],
      skipped: [],
      failed: [],
    });
    await expect(runIqiesReconcileCron(noOrgDeps())).resolves.toEqual({
      reconciled: [],
      failed: [],
    });
  });
});

describe("F-072 — constants the workers, the catalog and the live suite agree on", () => {
  it("names the rule a held-back batch records against each blocking assessment", () => {
    // §4.10: ANY blocking item refuses the WHOLE batch, never a partial transmit. The refusal has to
    // reach the clinician who can fix it, so it is a `hope_validation_finding` row and not a log line.
    expect(IQIES_SUBMIT_BLOCKED_RULE).toBe("iqies.submission_blocked");
  });

  it("bounds one tick's work so a backlog drains over ticks, not in one long transaction", () => {
    expect(IQIES_BATCHES_PER_TICK).toBeGreaterThan(0);
    expect(IQIES_BATCHES_PER_TICK).toBeLessThanOrEqual(100);
  });
});

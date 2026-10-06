// GAP-070 (M23): the `validation-run` executor settles stale jobs quietly and delegates live ones to the
// claim-validation service on the worker's own tx, as a typed machine principal.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  claims: new Map<string, Record<string, unknown>>(),
  runs: new Set<string>(),
}));

vi.mock("@wardenx/billing", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const repos = original.repositories as Record<string, unknown>;
  class ClaimRepository {
    findById = async (id: string) => fakes.claims.get(id) ?? null;
  }
  class ValidationRunRepository {
    findById = async (id: string) => (fakes.runs.has(id) ? { id } : null);
  }
  return { ...original, repositories: { ...repos, ClaimRepository, ValidationRunRepository } };
});

import {
  buildClaimValidationRunner,
  m23WorkerActor,
} from "../src/modules/23-billing-medicare/jobs/m23-worker-ports";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const RUN = "00000000-0000-4000-8000-0000000000c1";

function setup() {
  const calls: { actor: unknown; input: unknown }[] = [];
  const runner = buildClaimValidationRunner({
    validation: {
      validateClaimInTx: async (_tx: unknown, actor: unknown, input: unknown) => {
        calls.push({ actor, input });
        return {} as never;
      },
    },
  });
  const job = (overrides: Record<string, unknown> = {}) => ({
    tx: {} as never,
    organizationId: ORG,
    claimId: "c-1",
    validationRunId: RUN,
    trigger: "manual_re_run",
    ...overrides,
  });
  return { calls, runner, job };
}

beforeEach(() => {
  fakes.claims = new Map();
  fakes.runs = new Set();
});

describe("buildClaimValidationRunner", () => {
  it("runs a VALIDATING claim as the worker principal, carrying the route-minted run id", async () => {
    fakes.claims.set("c-1", { id: "c-1", organizationId: ORG, state: "validating" });
    const { calls, runner, job } = setup();

    await runner.run(job());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.actor).toEqual(m23WorkerActor(ORG));
    expect(calls[0]?.input).toEqual({
      claimId: "c-1",
      trigger: "manual_re_run",
      validationRunId: RUN,
    });
  });

  it("settles quietly when the claim moved on, is missing, belongs to another org, or the run exists", async () => {
    const { calls, runner, job } = setup();
    fakes.claims.set("c-1", { id: "c-1", organizationId: ORG, state: "submitted" });
    await runner.run(job());
    await runner.run(job({ claimId: "missing" }));
    fakes.claims.set("c-2", { id: "c-2", organizationId: "other", state: "ready" });
    await runner.run(job({ claimId: "c-2" }));
    fakes.claims.set("c-3", { id: "c-3", organizationId: ORG, state: "ready" });
    fakes.runs.add(RUN);
    await runner.run(job({ claimId: "c-3" }));

    expect(calls).toHaveLength(0);
  });

  it("refuses an unknown trigger loudly rather than persisting it", async () => {
    fakes.claims.set("c-1", { id: "c-1", organizationId: ORG, state: "validating" });
    const { runner, job } = setup();
    await expect(runner.run(job({ trigger: "bogus" }))).rejects.toThrow(
      /unknown validation-run trigger/,
    );
  });
});

describe("m23WorkerActor", () => {
  it("is a machine principal: no membership, no step-up, never an AI kind", () => {
    expect(m23WorkerActor(ORG)).toMatchObject({
      organizationId: ORG,
      actorKind: "worker",
      membershipId: "",
      stepUpRecent: false,
    });
  });
});

import * as billing from "@wardenx/billing";
import { BillingRuleRegistry, fail, pass } from "@wardenx/billing";
import type { Rule, ValidationContext } from "@wardenx/billing";
// apps/backend/src/modules/23-billing-medicare/__tests__/validation-service.test.ts — the §10 task-28 / §4.5
// pre-submission VALIDATION service tests (D1 / §2.6). The service walks an injected ValidationContextPort
// once, runs the FROZEN rule registry, persists ONE validation_run + its validation_result rows, and drives
// the claim lifecycle in the same unit of work via the injected ClaimStateService. As with the assembly
// suite, `@wardenx/billing` is PARTIAL-mocked so the repos are the in-memory store while `summarizeRuleRun`
// + the registry stay real; the claim-state-service is a recording STUB (the lifecycle reducer has its own
// pure tests). Asserted: the registry runs + run/results are written; the §2.6 run_input_hash makes a re-run
// on an unchanged claim an idempotent replay (no duplicate run, no second transition); a blocking failure
// drives `validation_failed`; an AI actor is rejected fail-closed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingWriteActor, ClaimStateService } from "../services/claim-state-service";
import { buildClaimValidationService } from "../services/claim-validation-service";
import type {
  ClaimValidationServicePorts,
  ValidationContextPort,
} from "../services/claim-validation-service";
import type { FakeStore } from "./_billing-repo-fakes";
import { makeFakeDb } from "./_billing-repo-fakes";

vi.mock("@wardenx/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wardenx/billing")>();
  const { buildFakeRepositories } = await import("./_billing-repo-fakes");
  const { repos, store } = buildFakeRepositories();
  return {
    ...actual,
    repositories: { ...actual.repositories, ...repos, __store: store },
  };
});

const store = (billing.repositories as unknown as { __store: FakeStore }).__store;

const ORG = "org-1";
const ACTOR: BillingWriteActor = {
  organizationId: ORG,
  userId: "user-1",
  roles: ["billing_clerk"],
  membershipId: "mem-1",
  stepUpRecent: false,
  actorKind: "user",
};

function seedValidatingClaim(): void {
  store.claims.set("claim-1", {
    id: "claim-1",
    organizationId: ORG,
    state: "validating",
    version: 0,
    providerEntityId: "pe-1",
    patientId: "pat-1",
    admissionId: "adm-1",
    claimControlNumber: "cc-1",
    macJurisdiction: "ngs_j6",
  });
}

/** A recording ClaimStateService stub — the lifecycle reducer is tested separately (machines/claim). */
function recordingStateService(): {
  readonly service: ClaimStateService;
  readonly calls: { event: string }[];
} {
  const calls: { event: string }[] = [];
  const service = {
    async applyInTx(_tx: unknown, _actor: unknown, input: { event: string }) {
      calls.push({ event: input.event });
      const claim = store.claims.get("claim-1");
      const toState = input.event === "validation_failed" ? "validating" : "ready";
      return {
        claim: { ...claim, state: toState },
        fromState: claim.state,
        toState,
        historyId: "hist-1",
        emittedEvents: [],
      };
    },
    async transition() {
      throw new Error("transition() is not used by the validation service path under test");
    },
  } as unknown as ClaimStateService;
  return { service, calls };
}

/** A ValidationContextPort that always materializes the SAME context (so the §2.6 hash is stable). */
function constantContextPort(): ValidationContextPort {
  return {
    build: async (_tx, _actor, claim) => ({
      context: {
        claimId: claim.id,
        claim: {
          dischargeClaimCodes: {
            patientStatus: "30",
            conditionCodes: [],
            occurrenceCodes: [],
            unresolved: null,
          },
        },
      } as unknown as ValidationContext,
      overlays: {},
    }),
  };
}

function buildRegistry(rules: readonly Rule[]): BillingRuleRegistry {
  const registry = new BillingRuleRegistry();
  registry.registerRules(rules);
  registry.freeze();
  return registry;
}

const passRule: Rule = {
  key: "test.always_pass",
  version: 1,
  category: "hipps",
  title: "pass",
  description: "d",
  severity: "error",
  regulatoryRequired: false,
  check: () => pass("test.always_pass", "error", "ok"),
};

const blockingFailRule: Rule = {
  key: "test.regulatory_block",
  version: 2,
  category: "eligibility",
  title: "block",
  description: "d",
  severity: "error",
  regulatoryRequired: true,
  check: () => fail("test.regulatory_block", "error", "missing eligibility"),
};

function makeService(rules: readonly Rule[], ports: ClaimValidationServicePorts) {
  return buildClaimValidationService(
    makeFakeDb() as never,
    buildRegistry(rules),
    recordingStateService().service,
    ports,
  );
}

beforeEach(() => store.reset());
afterEach(() => vi.clearAllMocks());

describe("a clean run writes the validation_run + results and drives the claim to READY", () => {
  it("executes the registry, persists run + result rows, and transitions via validation_passed", async () => {
    seedValidatingClaim();
    const { service: stateService, calls } = recordingStateService();
    const svc = buildClaimValidationService(
      makeFakeDb() as never,
      buildRegistry([passRule]),
      stateService,
      { contextPort: constantContextPort() },
    );

    const view = await svc.validateClaim(ACTOR, { claimId: "claim-1", trigger: "pre_submission" });

    expect(view.idempotentReplay).toBe(false);
    expect(view.outcome).toBe("all_pass");
    expect(view.rulesExecuted).toBe(1);
    expect(view.blockingFailures).toBe(0);
    expect(view.claimState).toBe("ready");

    expect(store.runs.size).toBe(1);
    const run = [...store.runs.values()][0];
    expect(run.trigger).toBe("pre_submission");
    expect(run.outcome).toBe("all_pass");
    expect(store.results.size).toBe(1);

    expect(calls).toEqual([{ event: "validation_passed" }]);
  });
});

describe("§2.6 run_input_hash idempotency — same context ⇒ same hash ⇒ no duplicate run", () => {
  it("a re-run on an unchanged claim is an idempotent replay (no second run, no second transition)", async () => {
    seedValidatingClaim();
    const { service: stateService, calls } = recordingStateService();
    const svc = buildClaimValidationService(
      makeFakeDb() as never,
      buildRegistry([passRule]),
      stateService,
      { contextPort: constantContextPort() },
    );

    const first = await svc.validateClaim(ACTOR, { claimId: "claim-1", trigger: "pre_submission" });
    const second = await svc.validateClaim(ACTOR, {
      claimId: "claim-1",
      trigger: "pre_submission",
    });

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.validationRunId).toBe(first.validationRunId);
    expect(store.runs.size).toBe(1); // collapsed to the original run
    expect(calls).toEqual([{ event: "validation_passed" }]); // no second lifecycle transition
  });

  it("a DIFFERENT trigger is a distinct idempotency key and produces its own run", async () => {
    seedValidatingClaim();
    const { service: stateService } = recordingStateService();
    const svc = buildClaimValidationService(
      makeFakeDb() as never,
      buildRegistry([passRule]),
      stateService,
      { contextPort: constantContextPort() },
    );
    await svc.validateClaim(ACTOR, { claimId: "claim-1", trigger: "pre_submission" });
    await svc.validateClaim(ACTOR, { claimId: "claim-1", trigger: "manual_re_run" });
    expect(store.runs.size).toBe(2);
  });
});

describe("a blocking regulatory failure drives validation_failed", () => {
  it("records the failure run + result and transitions via validation_failed", async () => {
    seedValidatingClaim();
    const { service: stateService, calls } = recordingStateService();
    const svc = buildClaimValidationService(
      makeFakeDb() as never,
      buildRegistry([blockingFailRule]),
      stateService,
      { contextPort: constantContextPort() },
    );

    const view = await svc.validateClaim(ACTOR, { claimId: "claim-1", trigger: "pre_submission" });

    expect(view.outcome).toBe("failures_present");
    expect(view.blockingFailures).toBe(1);
    expect(view.failedRuleKeys).toContain("test.regulatory_block");
    expect(view.claimState).toBe("validating");
    expect(calls).toEqual([{ event: "validation_failed" }]);
    const run = [...store.runs.values()][0];
    expect(run.outcome).toBe("failures_present");
  });
});

describe("guards", () => {
  it("rejects an ai_* actor fail-closed (D13) before running anything", async () => {
    seedValidatingClaim();
    const svc = makeService([passRule], { contextPort: constantContextPort() });
    await expect(
      svc.validateClaim(
        { ...ACTOR, actorKind: "ai_agent" },
        { claimId: "claim-1", trigger: "pre_submission" },
      ),
    ).rejects.toMatchObject({ code: "AI_ACTOR_FORBIDDEN" });
    expect(store.runs.size).toBe(0);
  });

  it("rejects validating a claim that is not in a validatable state (e.g. draft) with a conflict", async () => {
    store.claims.set("claim-2", {
      id: "claim-2",
      organizationId: ORG,
      state: "draft",
      version: 0,
    });
    const svc = makeService([passRule], { contextPort: constantContextPort() });
    await expect(
      svc.validateClaim(ACTOR, { claimId: "claim-2", trigger: "pre_submission" }),
    ).rejects.toBeTruthy();
    expect(store.runs.size).toBe(0);
  });
});

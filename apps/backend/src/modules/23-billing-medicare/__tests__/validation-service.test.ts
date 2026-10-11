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

/** The M40 resolution a hand-built context carries when the test is not about physicians. */
const NO_PHYSICIANS = { attending: null, hospicePhysician: null, placeOfService: null } as const;

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
          icd10Sequence: [],
          dischargeClaimCodes: {
            patientStatus: "30",
            conditionCodes: [],
            occurrenceCodes: [],
            unresolved: null,
          },
        },
        mdm: NO_PHYSICIANS,
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

describe("Type of Bill refresh on re-validation (812/813 → 811/814 once the stay-end counts)", () => {
  function contextEndingOn(
    dischargeDate: string | null,
    reason: string | null,
  ): ValidationContextPort {
    return {
      build: async (_tx, _actor, claim) => ({
        context: {
          claimId: claim.id,
          claim: {
            icd10Sequence: [],
            tob: claim.tob,
            dischargeDate,
            dischargeReason: reason,
            dischargeClaimCodes: {
              patientStatus: "01",
              conditionCodes: [],
              occurrenceCodes: [],
              unresolved: null,
            },
          },
          mdm: NO_PHYSICIANS,
        } as unknown as ValidationContext,
        overlays: {},
      }),
    };
  }
  const seen: string[] = [];
  const tobProbe: Rule = {
    ...passRule,
    key: "test.tob_probe",
    check: (ctx) => {
      seen.push(ctx.claim.tob);
      return pass("test.tob_probe", "error", "ok");
    },
  };

  it("re-types an unsubmitted interim claim whose stay ended by revocation inside the window", async () => {
    seedValidatingClaim();
    store.claims.set("claim-1", {
      ...store.claims.get("claim-1"),
      tob: "812",
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-31",
    });
    seen.length = 0;
    const svc = makeService([tobProbe], {
      contextPort: contextEndingOn("2026-03-20", "revocation"),
    });
    await svc.validateClaim(ACTOR, { claimId: "claim-1", trigger: "manual_re_run" });
    expect(store.claims.get("claim-1").tob).toBe("811");
    expect(store.claims.get("claim-1").version).toBe(0); // a derived projection, not a user edit
    expect(seen).toEqual(["811"]); // the rules validate the corrected TOB
  });

  it("keeps a continuing interim claim (813 → 814 only when discharged on/before the Through date)", async () => {
    seedValidatingClaim();
    store.claims.set("claim-1", {
      ...store.claims.get("claim-1"),
      tob: "813",
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-31",
    });
    const svc = makeService([passRule], { contextPort: contextEndingOn("2026-04-05", "transfer") });
    await svc.validateClaim(ACTOR, { claimId: "claim-1", trigger: "manual_re_run" });
    expect(store.claims.get("claim-1").tob).toBe("813");
    const svc2 = makeService([passRule], {
      contextPort: contextEndingOn("2026-03-31", "transfer"),
    });
    await svc2.validateClaim(ACTOR, { claimId: "claim-1", trigger: "pre_submission" });
    expect(store.claims.get("claim-1").tob).toBe("814");
  });

  it("persists a re-validated result's remediation flat (summary at the top level, defects alongside)", async () => {
    seedValidatingClaim();
    const defectRule: Rule = {
      ...blockingFailRule,
      check: () => {
        const r = fail("test.regulatory_block", "error", "x", { summary: "Fix it" }, { n: 1 });
        return {
          ...r,
          annotations: {
            ...r.annotations,
            defects: [{ code: "PLACE_OF_DEATH_MISSING", message: "m" }],
          },
        };
      },
    };
    const svc = makeService([defectRule], { contextPort: constantContextPort() });
    await svc.validateClaim(ACTOR, { claimId: "claim-1", trigger: "manual_re_run" });
    const result = [...store.results.values()][0];
    expect(result.remediation).toEqual({
      summary: "Fix it",
      observed: { n: 1 },
      defects: [{ code: "PLACE_OF_DEATH_MISSING", message: "m" }],
    });
  });
});

describe("late-NOE occurrence span 77 on re-validation (CMS Pub. 100-04 ch. 11 §20.1.1)", () => {
  function contextWithNoe(acceptedDate: string): ValidationContextPort {
    return {
      build: async (_tx, _actor, claim) => ({
        context: {
          claimId: claim.id,
          claim: {
            icd10Sequence: [],
            serviceFrom: "2026-03-01",
            serviceTo: "2026-03-31",
            dischargeClaimCodes: {
              patientStatus: "30",
              conditionCodes: [],
              occurrenceCodes: [],
              unresolved: null,
            },
          },
          noe: {
            state: "ack_accepted",
            admissionDay: 20,
            windowBreached: false,
            electionEffectiveDate: "2026-03-01",
            acceptedDate,
            acceptedDateSource: "277ca_stc02",
          },
          mdm: NO_PHYSICIANS,
        } as unknown as ValidationContext,
        overlays: {},
      }),
    };
  }

  it("persists OSC 77 (admission through the day before acceptance) for a NOE accepted late", async () => {
    seedValidatingClaim();
    const svc = makeService([passRule], { contextPort: contextWithNoe("2026-03-09") });
    await svc.validateClaim(ACTOR, { claimId: "claim-1", trigger: "manual_re_run" });
    expect(store.claims.get("claim-1").occurrenceSpans).toEqual([
      { code: "77", from: "2026-03-01", through: "2026-03-08" },
    ]);
    expect(store.claims.get("claim-1").version).toBe(0); // a derived projection, not a user edit
  });

  it("clears the span once the NOE reads as timely (e.g. a corrected payer date)", async () => {
    seedValidatingClaim();
    await makeService([passRule], { contextPort: contextWithNoe("2026-03-09") }).validateClaim(
      ACTOR,
      { claimId: "claim-1", trigger: "manual_re_run" },
    );
    await makeService([passRule], { contextPort: contextWithNoe("2026-03-05") }).validateClaim(
      ACTOR,
      { claimId: "claim-1", trigger: "pre_submission" },
    );
    expect(store.claims.get("claim-1").occurrenceSpans).toEqual([]);
  });
});

describe("physician NPIs on re-validation (UB-04 FL 76 / FL 78)", () => {
  const physician = (npi: string, firstName?: string, lastName?: string) => ({
    npi,
    ...(firstName !== undefined ? { firstName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
    status: "active",
    licenseUnexpiredOnServiceDates: true,
  });
  function contextWithPhysicians(
    attending: ReturnType<typeof physician> | null,
    hospicePhysician: ReturnType<typeof physician> | null,
  ): ValidationContextPort {
    return {
      build: async (_tx, _actor, claim) => ({
        context: {
          claimId: claim.id,
          claim: {
            icd10Sequence: [],
            dischargeClaimCodes: {
              patientStatus: "30",
              conditionCodes: [],
              occurrenceCodes: [],
              unresolved: null,
            },
          },
          mdm: { attending, hospicePhysician, placeOfService: "home" },
        } as unknown as ValidationContext,
        overlays: {},
      }),
    };
  }

  it("keeps the persisted NPIs in step with the physicians the run resolved", async () => {
    seedValidatingClaim();
    const svc = makeService([passRule], {
      contextPort: contextWithPhysicians(physician("1234567893"), physician("1982736455")),
    });
    await svc.validateClaim(ACTOR, { claimId: "claim-1", trigger: "manual_re_run" });
    const claim = store.claims.get("claim-1");
    expect(claim.attendingPhysicianNpi).toBe("1234567893");
    expect(claim.certifyingPhysicianNpi).toBe("1982736455");
    expect(claim.version).toBe(0); // a derived projection, not a user edit
  });

  it("keeps the persisted admission codes in step with the admission the run read", async () => {
    seedValidatingClaim();
    const port = contextWithPhysicians(null, null);
    const withCodes = {
      build: async (...args: Parameters<typeof port.build>) => {
        const built = await port.build(...args);
        const context = built.context as unknown as { claim: Record<string, unknown> };
        return {
          ...built,
          context: {
            ...built.context,
            claim: { ...context.claim, admissionTypeCode: "3", admissionSourceCode: "1" },
          },
        };
      },
    };
    await makeService([passRule], { contextPort: withCodes as never }).validateClaim(ACTOR, {
      claimId: "claim-1",
      trigger: "manual_re_run",
    });
    const claim = store.claims.get("claim-1");
    expect(claim.admissionTypeCode).toBe("3");
    expect(claim.admissionSourceCode).toBe("1");
    expect(claim.version).toBe(0); // a derived projection, not a user edit
  });

  it("re-derives the names and diagnosis snapshot WITH the NPIs, so an NPI and its name never drift apart", async () => {
    seedValidatingClaim();
    const withDx = (port: ValidationContextPort, codes: string[]): ValidationContextPort => ({
      build: async (...args) => {
        const built = await port.build(...args);
        const ctx = built.context as unknown as { claim: Record<string, unknown> };
        const icd10Sequence = codes.map((code, i) => ({
          position: i + 1,
          code,
          relationship: i === 0 ? "terminal" : "related",
        }));
        return {
          ...built,
          context: { ...built.context, claim: { ...ctx.claim, icd10Sequence } },
        } as never;
      },
    });
    await makeService([passRule], {
      contextPort: withDx(
        contextWithPhysicians(
          physician("1234567893", "Ada", "Lovelace"),
          physician("1982736455", "Grace", "Hopper"),
        ),
        ["C3490"],
      ),
    }).validateClaim(ACTOR, { claimId: "claim-1", trigger: "manual_re_run" });
    let claim = store.claims.get("claim-1");
    expect(claim.attendingPhysicianLastName).toBe("Lovelace");
    expect(claim.certifyingPhysicianLastName).toBe("Hopper");
    expect(claim.diagnosisSnapshot).toEqual([
      { icd10Code: "C3490", sequence: 1, qualifier: "ABK" },
    ]);

    // M40 now says a DIFFERENT attending, and the certifying physician is the same person (no separate NPI).
    await makeService([passRule], {
      contextPort: withDx(
        contextWithPhysicians(
          physician("1245319599", "Alan", "Turing"),
          physician("1245319599", "Alan", "Turing"),
        ),
        ["C787", "J449"],
      ),
    }).validateClaim(ACTOR, { claimId: "claim-1", trigger: "pre_submission" });
    claim = store.claims.get("claim-1");
    expect(claim.attendingPhysicianNpi).toBe("1245319599");
    expect(claim.attendingPhysicianFirstName).toBe("Alan");
    expect(claim.attendingPhysicianLastName).toBe("Turing");
    // certifying name is null exactly when the certifying NPI is
    expect(claim.certifyingPhysicianNpi).toBeNull();
    expect(claim.certifyingPhysicianFirstName).toBeNull();
    expect(claim.certifyingPhysicianLastName).toBeNull();
    expect(claim.diagnosisSnapshot).toEqual([
      { icd10Code: "C787", sequence: 1, qualifier: "ABK" },
      { icd10Code: "J449", sequence: 2, qualifier: "ABF" },
    ]);
    expect(claim.version).toBe(0);
  });

  it("clears an NPI the run could no longer resolve", async () => {
    seedValidatingClaim();
    await makeService([passRule], {
      contextPort: contextWithPhysicians(physician("1234567893"), null),
    }).validateClaim(ACTOR, { claimId: "claim-1", trigger: "manual_re_run" });
    await makeService([passRule], {
      contextPort: contextWithPhysicians(null, null),
    }).validateClaim(ACTOR, { claimId: "claim-1", trigger: "pre_submission" });
    const claim = store.claims.get("claim-1");
    expect(claim.attendingPhysicianNpi).toBeNull();
    expect(claim.certifyingPhysicianNpi).toBeNull();
  });
});

// apps/backend/src/modules/23-billing-medicare/__tests__/override-service.test.ts — the §10 task-29 / §4.5 /
// §4.7 validation-OVERRIDE service tests (D5 / D13 / D14). The override is the human compliance act that lets
// a claim proceed past a FAILING validation result; the service enforces four fail-closed gates in order:
// never-via-AI (D13), step-up (D14), role-eligibility (§4.7 / §2.2), and the ≥40-char reason floor, then
// writes the override + its mandatory M4 audit linkage + the audit-prominent outbox event in one unit of
// work. `@wardenx/billing` is PARTIAL-mocked for the in-memory repos; the FROZEN rule registry carries the
// `regulatoryRequired` / `overrideRoleRequired` metadata the role gate keys on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as billing from "@wardenx/billing";
import { BillingRuleRegistry, fail } from "@wardenx/billing";
import type { Rule } from "@wardenx/billing";
import { buildOverrideService } from "../services/override-service";
import type { OverrideAuditPort, OverrideServicePorts } from "../services/override-service";
import type { BillingWriteActor, WriteOutboxPort } from "../services/claim-state-service";
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
const LONG_REASON =
  "Documented compliance justification for overriding this validation failure per facility policy.";

function actor(overrides: Partial<BillingWriteActor> = {}): BillingWriteActor {
  return {
    organizationId: ORG,
    userId: "user-1",
    roles: ["billing_manager"],
    membershipId: "mem-1",
    stepUpRecent: true,
    actorKind: "user",
    ...overrides,
  };
}

/** A rule carrying only the override-relevant metadata (check body is irrelevant to the override path). */
function rule(key: string, regulatoryRequired: boolean, overrideRoleRequired?: Rule["overrideRoleRequired"]): Rule {
  return {
    key,
    version: 1,
    category: "eligibility",
    title: key,
    description: "d",
    severity: "error",
    regulatoryRequired,
    ...(overrideRoleRequired ? { overrideRoleRequired } : {}),
    check: () => fail(key, "error", "failed"),
  };
}

function registry(): BillingRuleRegistry {
  const r = new BillingRuleRegistry();
  r.registerRules([
    rule("ovr.plain", false), // non-regulatory: any held override role may override
    rule("ovr.reg.overridable", true, "compliance_officer"), // regulatory WITH an override path
    rule("ovr.reg.hard", true), // regulatory with NO override path — cannot be overridden at all
  ]);
  r.freeze();
  return r;
}

/** Seed the claim → run → FAILING result chain the override targets. */
function seedFailingResult(resultId: string, ruleKey: string): void {
  if (!store.claims.has("claim-1")) {
    store.claims.set("claim-1", { id: "claim-1", organizationId: ORG, state: "validating", version: 0 });
  }
  if (!store.runs.has("run-1")) {
    store.runs.set("run-1", { id: "run-1", organizationId: ORG, claimId: "claim-1", trigger: "pre_submission" });
  }
  store.results.set(resultId, {
    id: resultId,
    organizationId: ORG,
    validationRunId: "run-1",
    ruleKey,
    severity: "error",
    outcome: "fail",
  });
}

function makePorts(): {
  readonly ports: OverrideServicePorts;
  readonly auditCalls: unknown[];
  readonly emitted: { eventName: string }[];
} {
  const auditCalls: unknown[] = [];
  const emitted: { eventName: string }[] = [];
  const audit: OverrideAuditPort = {
    recordOverride: async (_tx, input) => {
      auditCalls.push(input);
      return "audit-evt-1";
    },
  };
  const outbox: WriteOutboxPort = {
    publish: async (_tx, input) => {
      emitted.push({ eventName: input.eventName });
    },
  };
  return { ports: { audit, outbox }, auditCalls, emitted };
}

function input(resultId: string, reason = LONG_REASON) {
  return { claimId: "claim-1", validationRunId: "run-1", resultId, reason };
}

beforeEach(() => store.reset());
afterEach(() => vi.clearAllMocks());

describe("gate 1 — never via AI (D13)", () => {
  it("rejects an ai_* principal before any other work", async () => {
    seedFailingResult("res-1", "ovr.plain");
    const { ports } = makePorts();
    const svc = buildOverrideService(makeFakeDb() as never, registry(), ports);
    await expect(
      svc.overrideValidationResult(actor({ actorKind: "ai_agent" }), input("res-1")),
    ).rejects.toMatchObject({ code: "AI_ACTOR_FORBIDDEN" });
    expect(store.overrides.size).toBe(0);
  });
});

describe("gate 2 — step-up required (D14)", () => {
  it("rejects when the actor has no recent step-up", async () => {
    seedFailingResult("res-1", "ovr.plain");
    const { ports } = makePorts();
    const svc = buildOverrideService(makeFakeDb() as never, registry(), ports);
    await expect(
      svc.overrideValidationResult(actor({ stepUpRecent: false }), input("res-1")),
    ).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
  });
});

describe("gate 4 — the ≥40-char reason floor", () => {
  it("rejects a too-short reason with a 422", async () => {
    seedFailingResult("res-1", "ovr.plain");
    const { ports } = makePorts();
    const svc = buildOverrideService(makeFakeDb() as never, registry(), ports);
    await expect(
      svc.overrideValidationResult(actor(), input("res-1", "too short")),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(store.overrides.size).toBe(0);
  });
});

describe("gate 3 — role-eligibility (§4.7)", () => {
  it("rejects when the actor does not hold the rule's required override role", async () => {
    seedFailingResult("res-1", "ovr.reg.overridable"); // requires compliance_officer
    const { ports } = makePorts();
    const svc = buildOverrideService(makeFakeDb() as never, registry(), ports);
    await expect(
      svc.overrideValidationResult(actor({ roles: ["billing_manager"] }), input("res-1")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(store.overrides.size).toBe(0);
  });

  it("a non-regulatory rule may be overridden by any held override role (records the applied role)", async () => {
    seedFailingResult("res-1", "ovr.plain");
    const { ports, auditCalls } = makePorts();
    const svc = buildOverrideService(makeFakeDb() as never, registry(), ports);
    const view = await svc.overrideValidationResult(actor({ roles: ["billing_manager"] }), input("res-1"));
    expect(view.overrideRoleApplied).toBe("billing_manager");
    expect(view.m4AuditEventId).toBe("audit-evt-1");
    expect(store.overrides.size).toBe(1);
    expect(auditCalls).toHaveLength(1);
  });
});

describe("a regulatory rule WITH an override path is overridable per-instance by the matching role", () => {
  it("succeeds for compliance_officer, links the M4 audit event, and emits override_applied", async () => {
    seedFailingResult("res-1", "ovr.reg.overridable");
    const { ports, emitted, auditCalls } = makePorts();
    const svc = buildOverrideService(makeFakeDb() as never, registry(), ports);
    const view = await svc.overrideValidationResult(actor({ roles: ["compliance_officer"] }), input("res-1"));
    expect(view.overrideRoleApplied).toBe("compliance_officer");
    expect(view.ruleKey).toBe("ovr.reg.overridable");
    expect(auditCalls).toHaveLength(1);
    expect(emitted.map((e) => e.eventName)).toContain("m23.claim.override_applied");
    expect(store.overrides.size).toBe(1);
  });

  it("org_admin may stand in for the required role", async () => {
    seedFailingResult("res-1", "ovr.reg.overridable");
    const { ports } = makePorts();
    const svc = buildOverrideService(makeFakeDb() as never, registry(), ports);
    const view = await svc.overrideValidationResult(actor({ roles: ["org_admin"] }), input("res-1"));
    expect(view.overrideRoleApplied).toBe("org_admin");
  });
});

describe("a regulatory rule with NO override path can never be overridden (§2.2 / D5)", () => {
  it("rejects with FORBIDDEN even for an elevated role", async () => {
    seedFailingResult("res-1", "ovr.reg.hard");
    const { ports } = makePorts();
    const svc = buildOverrideService(makeFakeDb() as never, registry(), ports);
    await expect(
      svc.overrideValidationResult(actor({ roles: ["org_admin", "compliance_officer"] }), input("res-1")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(store.overrides.size).toBe(0);
  });
});

describe("integrity", () => {
  it("rejects overriding a non-failing (e.g. already-passed) result", async () => {
    store.claims.set("claim-1", { id: "claim-1", organizationId: ORG, state: "validating", version: 0 });
    store.runs.set("run-1", { id: "run-1", organizationId: ORG, claimId: "claim-1", trigger: "pre_submission" });
    store.results.set("res-pass", {
      id: "res-pass",
      organizationId: ORG,
      validationRunId: "run-1",
      ruleKey: "ovr.plain",
      severity: "error",
      outcome: "pass",
    });
    const { ports } = makePorts();
    const svc = buildOverrideService(makeFakeDb() as never, registry(), ports);
    await expect(
      svc.overrideValidationResult(actor(), input("res-pass")),
    ).rejects.toBeTruthy();
    expect(store.overrides.size).toBe(0);
  });

  it("a second override of the same result collapses idempotently (one override row)", async () => {
    seedFailingResult("res-1", "ovr.plain");
    const { ports } = makePorts();
    const svc = buildOverrideService(makeFakeDb() as never, registry(), ports);
    await svc.overrideValidationResult(actor(), input("res-1"));
    // The repo's findByResult now returns the existing override, so the service rejects the duplicate.
    await expect(svc.overrideValidationResult(actor(), input("res-1"))).rejects.toBeTruthy();
    expect(store.overrides.size).toBe(1);
  });
});

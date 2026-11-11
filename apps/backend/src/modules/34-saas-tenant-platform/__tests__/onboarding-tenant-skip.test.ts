// Slice 7 (piece 7K): the tenant's own skip. An org_admin may say "this does not apply to us" on MAC credentials, payer
// enrollment and DoseSpot kickoff, and on nothing else; the skip records its actor kind, voids a pending go-live
// attestation like any onboarding-data change, and shows the tenant its own skip but never an operator's identity.
// Over the in-memory store; the live suite repeats the load-bearing parts on the real roles.
import { ChartWardenError } from "@chartwarden/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PlatformActor,
  SKIPPABLE_STEP_KEYS,
  type StepTemplate,
  TENANT_SKIPPABLE_STEP_KEYS,
  type TenantActor,
  type TenantRef,
  isTenantSkippableStep,
  skipActorKindOf,
} from "../onboarding/model";
import { createOnboardingWizard } from "../onboarding/wizard-service";
import {
  type MemoryWizardState,
  createMemoryOrgProfile,
  createMemoryWizardRunner,
  createMemoryWizardState,
  memoryMember,
  memoryTask,
} from "../onboarding/wizard-store-memory";
import { PLATFORM_OPERATOR_LABEL } from "../onboarding/wizard-view";

const ORG = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-09T12:00:00Z");
const OPS: PlatformActor = { kind: "platform", membershipId: "ops-m", userId: "ops-u" };
const actor = (membershipId: string, userId: string, roles: string[]): TenantActor => ({
  kind: "tenant",
  membershipId,
  userId,
  roles,
});
const ADMIN = actor("admin-m", "admin-u", ["org_admin"]);
const ADMINISTRATOR = actor("administrator-m", "administrator-u", ["administrator"]);
const OFFICER = actor("co-m", "co-u", ["compliance_officer"]);
const OFFICER_AND_ADMIN = actor("both-m", "both-u", ["org_admin", "compliance_officer"]);
const RATIONALE = "We bill our payers outside the system";
const SSN = "900-12-3456"; // area 9xx is never issued

const tpl = (key: string, sequence: number, over: Partial<StepTemplate> = {}): StepTemplate => ({
  key,
  title: key,
  description: "",
  sequence,
  owner: "either",
  completionMode: "attestation",
  optional: false,
  canonical: true,
  ...over,
});

const TEMPLATES: StepTemplate[] = [
  tpl("account_created", 1, { owner: "platform_ops" }),
  tpl("ccn_registered", 2),
  tpl("mac_configured", 3, { completionMode: "either" }),
  tpl("payer_enrollment", 4),
  tpl("dosespot_kickoff_initiated", 5, { completionMode: "either" }),
  tpl("sample_data_loaded", 6, { owner: "platform_ops", optional: true }),
  tpl("operator_added_step", 7, { canonical: false }),
  tpl("go_live_checklist_complete", 8, { owner: "compliance_officer" }),
];

let state: MemoryWizardState;
let advance: ReturnType<typeof vi.fn>;
const taskOf = (key: string) =>
  state.tasks.find((t) => t.templateKey === key) as MemoryWizardState["tasks"][number];
const statusOf = (key: string): string => taskOf(key).status;
const settle = (...keys: string[]): void => {
  state.tasks = state.tasks.map((t) =>
    keys.includes(t.templateKey) ? { ...t, status: "done" as const } : t,
  );
};

function wizard() {
  return createOnboardingWizard({
    runner: createMemoryWizardRunner(state),
    orgProfile: createMemoryOrgProfile(state),
    advance: advance as never,
    activateOrganization: async () => undefined,
    warn: () => undefined,
    now: () => NOW,
  });
}

const skip = (who: TenantActor, key: string, rationale: unknown = RATIONALE) =>
  wizard().tenantSkip(who, ORG, taskOf(key).id, rationale as string);

const refusal = async (p: Promise<unknown>): Promise<{ code: string; status: number }> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ChartWardenError);
    return { code: (e as ChartWardenError).code, status: (e as ChartWardenError).statusCode };
  }
  throw new Error("expected a refusal");
};

beforeEach(() => {
  advance = vi.fn(async () => undefined);
  const ref: TenantRef = {
    tenantAccountId: TENANT,
    organizationId: ORG,
    orgSlug: "acme",
    status: "onboarding",
    legalBusinessName: "Acme Hospice",
    complianceOfficerMembershipId: null,
  };
  state = createMemoryWizardState({
    tenants: [ref],
    templates: TEMPLATES,
    tasks: TEMPLATES.map((t) => memoryTask(TENANT, t.key)),
    members: new Map([
      memoryMember(ORG, "admin-m", "admin-u", ["org_admin"]),
      memoryMember(ORG, "co-m", "co-u", ["compliance_officer"]),
    ]),
    baa: new Map([[TENANT, { baaStatus: "executed", expiresOn: "2028-01-01" }]]),
    profiles: new Map([[ORG, { displayName: "Acme", orgTimezone: "America/New_York" }]]),
  });
  settle("account_created", "ccn_registered");
});

describe("the tenant-skippable list", () => {
  it("is exactly MAC credentials, payer enrollment and DoseSpot kickoff, inside the operator's list", () => {
    expect([...TENANT_SKIPPABLE_STEP_KEYS].sort()).toEqual([
      "dosespot_kickoff_initiated",
      "mac_configured",
      "payer_enrollment",
    ]);
    for (const key of TENANT_SKIPPABLE_STEP_KEYS) expect(SKIPPABLE_STEP_KEYS.has(key)).toBe(true);
    expect(SKIPPABLE_STEP_KEYS.has("sample_data_loaded")).toBe(true);
    expect(TENANT_SKIPPABLE_STEP_KEYS.has("sample_data_loaded")).toBe(false);
  });

  it("refuses a canonical step re-owned to platform ops, a non-canonical step of the same key and go-live", () => {
    const mac = TEMPLATES.find((t) => t.key === "mac_configured") as StepTemplate;
    expect(isTenantSkippableStep(mac)).toBe(true);
    expect(isTenantSkippableStep({ ...mac, owner: "platform_ops" })).toBe(false);
    expect(isTenantSkippableStep({ ...mac, canonical: false })).toBe(false);
    expect(isTenantSkippableStep({ ...mac, key: "go_live_checklist_complete" })).toBe(false);
  });
});

describe("skipActorKindOf", () => {
  it("reads the recorded kind and derives it for a record written before slice 7", () => {
    expect(skipActorKindOf({ skippedByActorKind: "tenant" })).toBe("tenant");
    expect(skipActorKindOf({ skippedByActorKind: "system" })).toBe("system");
    expect(skipActorKindOf({ skippedByMembershipId: "system" })).toBe("system");
    expect(skipActorKindOf({ skippedByMembershipId: "ops-m" })).toBe("platform_ops");
    expect(skipActorKindOf(undefined)).toBe("platform_ops");
  });

  it("never trusts a value outside the three kinds", () => {
    expect(skipActorKindOf({ skippedByActorKind: "root", skippedByMembershipId: "ops-m" })).toBe(
      "platform_ops",
    );
    expect(skipActorKindOf({ skippedByActorKind: 7, skippedByMembershipId: "system" })).toBe(
      "system",
    );
  });
});

describe("tenant skip: what is allowed", () => {
  it.each(["mac_configured", "payer_enrollment", "dosespot_kickoff_initiated"])(
    "settles %s for the org_admin, records the actor kind and shows the tenant its own skip",
    async (key) => {
      const index = [...TENANT_SKIPPABLE_STEP_KEYS].indexOf(key);
      settle(...[...TENANT_SKIPPABLE_STEP_KEYS].slice(0, index));
      const step = await skip(ADMIN, key);
      expect(step).toMatchObject({
        key,
        status: "skipped",
        skipRationale: RATIONALE,
        skippedBy: "tenant",
        skippedByLabel: "Your organization",
        systemSkipped: false,
        tenantSkippable: false,
      });
      expect(statusOf(key)).toBe("skipped");
      expect(taskOf(key).completionEvidence.skip).toEqual({
        rationale: RATIONALE,
        skippedByMembershipId: "admin-m",
        skippedByUserId: "admin-u",
        skippedByActorKind: "tenant",
        skippedAt: NOW.toISOString(),
      });
    },
  );

  it("counts as settled for the next step and lets the sweep run", async () => {
    await skip(ADMIN, "mac_configured");
    const view = await wizard().getPlatform("acme");
    expect(view.steps.find((s) => s.key === "payer_enrollment")?.locked).toBe(false);
    expect(view.currentStepKey).toBe("payer_enrollment");
    expect(advance).toHaveBeenCalledWith({ tenantAccountId: TENANT, organizationId: ORG });
  });

  it("takes a rationale after trimming and strips control characters", async () => {
    const step = await skip(ADMIN, "mac_configured", `  ${RATIONALE}\u0007  `);
    expect(step.skipRationale).toBe(RATIONALE);
  });

  it("lets a user who is org_admin and compliance_officer skip too (the owner rule is the org_admin's)", async () => {
    const step = await skip(OFFICER_AND_ADMIN, "mac_configured");
    expect(step).toMatchObject({ status: "skipped", skippedBy: "tenant" });
  });
});

describe("tenant skip: what is refused", () => {
  it.each([
    ["sample data (the operator's own content)", "sample_data_loaded"],
    ["go-live", "go_live_checklist_complete"],
    ["a step an operator added", "operator_added_step"],
    ["a canonical step that cannot be skipped at all", "ccn_registered"],
    ["the Organisation step", "account_created"],
  ])("409 ONBOARDING_STEP_NOT_TENANT_SKIPPABLE for %s", async (_what, key) => {
    const before = JSON.stringify(state.tasks);
    expect(await refusal(skip(OFFICER_AND_ADMIN, key))).toEqual({
      code: "ONBOARDING_STEP_NOT_TENANT_SKIPPABLE",
      status: 409,
    });
    expect(JSON.stringify(state.tasks)).toBe(before);
  });

  it("answers the step's own refusal even while an earlier step is open, and for any actor", async () => {
    state.tasks = state.tasks.map((t) =>
      t.templateKey === "ccn_registered" ? { ...t, status: "pending" as const } : t,
    );
    expect((await refusal(skip(ADMIN, "operator_added_step"))).code).toBe(
      "ONBOARDING_STEP_NOT_TENANT_SKIPPABLE",
    );
    expect((await refusal(skip(ADMINISTRATOR, "sample_data_loaded"))).code).toBe(
      "ONBOARDING_STEP_NOT_TENANT_SKIPPABLE",
    );
  });

  it("403 owner mismatch for an administrator without the org_admin role, and for a compliance officer alone", async () => {
    expect(await refusal(skip(ADMINISTRATOR, "mac_configured"))).toEqual({
      code: "ONBOARDING_STEP_OWNER_MISMATCH",
      status: 403,
    });
    expect((await refusal(skip(OFFICER, "mac_configured"))).code).toBe(
      "ONBOARDING_STEP_OWNER_MISMATCH",
    );
    expect(statusOf("mac_configured")).toBe("pending");
  });

  it("409 ONBOARDING_STEP_NOT_TENANT_SKIPPABLE when an operator re-owned a skippable step to platform ops", async () => {
    state.templates = state.templates.map((t) =>
      t.key === "mac_configured" ? { ...t, owner: "platform_ops" as const } : t,
    );
    expect((await refusal(skip(ADMIN, "mac_configured"))).code).toBe(
      "ONBOARDING_STEP_NOT_TENANT_SKIPPABLE",
    );
  });

  it("422 EVIDENCE_LOOKS_LIKE_PHI for an identifier in the rationale, without echoing it or changing the step", async () => {
    const error = await wizard()
      .tenantSkip(ADMIN, ORG, taskOf("mac_configured").id, `not needed for ${SSN}`)
      .catch((e: unknown) => e as ChartWardenError);
    expect(error).toBeInstanceOf(ChartWardenError);
    expect((error as ChartWardenError).code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
    expect((error as ChartWardenError).statusCode).toBe(422);
    expect(JSON.stringify(error)).not.toContain(SSN);
    expect(statusOf("mac_configured")).toBe("pending");
    expect(taskOf("mac_configured").completionEvidence).toEqual({});
  });

  it.each([
    ["too short", "no"],
    ["blank", "        "],
    ["not text", 42],
    ["over 2000 characters", "x".repeat(2001)],
  ])("422 ONBOARDING_REASON_REQUIRED for a rationale that is %s", async (_what, rationale) => {
    expect(await refusal(skip(ADMIN, "mac_configured", rationale))).toEqual({
      code: "ONBOARDING_REASON_REQUIRED",
      status: 422,
    });
  });

  it("422 ONBOARDING_TEXT_INVALID for NUL, never a 500", async () => {
    expect((await refusal(skip(ADMIN, "mac_configured", "text\u0000more"))).code).toBe(
      "ONBOARDING_TEXT_INVALID",
    );
  });

  it("409 ONBOARDING_STEP_OUT_OF_ORDER while an earlier gating step is open", async () => {
    expect(await refusal(skip(ADMIN, "payer_enrollment"))).toEqual({
      code: "ONBOARDING_STEP_OUT_OF_ORDER",
      status: 409,
    });
    expect(statusOf("payer_enrollment")).toBe("pending");
  });

  it("409 ONBOARDING_STEP_ALREADY_SETTLED for a done or skipped step", async () => {
    settle("mac_configured");
    expect((await refusal(skip(ADMIN, "mac_configured"))).code).toBe(
      "ONBOARDING_STEP_ALREADY_SETTLED",
    );
    await skip(ADMIN, "payer_enrollment");
    expect((await refusal(skip(ADMIN, "payer_enrollment"))).code).toBe(
      "ONBOARDING_STEP_ALREADY_SETTLED",
    );
  });

  it("404 for a task the tenant does not have", async () => {
    expect((await refusal(wizard().tenantSkip(ADMIN, ORG, "no-such-task", RATIONALE))).status).toBe(
      404,
    );
  });

  it("409 TENANT_NOT_ONBOARDING once the tenant is live", async () => {
    state.tenants = state.tenants.map((t) => ({ ...t, status: "active" }));
    expect((await refusal(skip(ADMIN, "mac_configured"))).code).toBe("TENANT_NOT_ONBOARDING");
  });

  it("skips a blocked step and clears its blocker", async () => {
    await wizard().blockTask(
      ADMIN,
      ORG,
      taskOf("mac_configured").id,
      "waiting for the MAC to reply",
    );
    const step = await skip(ADMIN, "mac_configured");
    expect(step).toMatchObject({ status: "skipped", blockerReason: null });
  });
});

describe("tenant skip: it voids a pending go-live attestation; an operator's and the system's skip do not", () => {
  const pending = () => ({
    id: "att-1",
    organizationId: ORG,
    tenantAccountId: TENANT,
    status: "pending" as const,
    attestedByMembershipId: "co-m",
    attestedByUserId: "co-u",
    attestedAt: new Date("2026-11-08T12:00:00Z"),
    attestationNote: null,
    approvedByMembershipId: null,
    approvedByUserId: null,
    approvedAt: null,
    approvalReason: null,
    revokedByMembershipId: null,
    revokedByUserId: null,
    revokedAt: null,
    revokeReason: null,
  });

  it("revokes the pending attestation in the same transaction, naming the skipping user", async () => {
    state.goLive = [pending()];
    await skip(ADMIN, "mac_configured");
    expect(state.goLive[0]).toMatchObject({
      status: "revoked",
      revokedByUserId: "admin-u",
      revokedByMembershipId: "admin-m",
    });
  });

  it("is a no-op when nothing is pending, and leaves an approved attestation alone", async () => {
    state.goLive = [{ ...pending(), status: "approved" }];
    await skip(ADMIN, "mac_configured");
    expect(state.goLive[0]?.status).toBe("approved");
  });

  it("does not void anything when the skip is refused", async () => {
    state.goLive = [pending()];
    await refusal(skip(ADMIN, "payer_enrollment"));
    await refusal(skip(ADMIN, "sample_data_loaded"));
    expect(state.goLive[0]?.status).toBe("pending");
  });

  it("an operator's skip of an optional step leaves the officer's pending attestation alone, as an operator's attestation of it does", async () => {
    // The officer attests with the optional sample-data step still open (a normal state); the operator then settles it.
    settle(
      "mac_configured",
      "payer_enrollment",
      "dosespot_kickoff_initiated",
      "operator_added_step",
    );
    state.goLive = [pending()];
    await wizard().skipPlatform(
      "acme",
      taskOf("sample_data_loaded").id,
      OPS,
      "the customer asked us to",
    );
    expect(statusOf("sample_data_loaded")).toBe("skipped");
    expect(state.goLive[0]?.status).toBe("pending");

    state.tasks = state.tasks.map((t) =>
      t.templateKey === "sample_data_loaded"
        ? { ...t, status: "pending" as const, completionEvidence: {} }
        : t,
    );
    await wizard().attestPlatform("acme", taskOf("sample_data_loaded").id, OPS, {
      evidenceNote: "loaded the demo set",
      reason: "the customer asked us to",
    });
    expect(statusOf("sample_data_loaded")).toBe("done");
    expect(state.goLive[0]?.status).toBe("pending");
  });

  it("the system's own skip never voids anything", async () => {
    settle("account_created", "ccn_registered");
    state.goLive = [pending()];
    const outside = createOnboardingWizard({
      runner: createMemoryWizardRunner(state),
      orgProfile: createMemoryOrgProfile(state),
      activateOrganization: async () => undefined,
      clearinghouseChoice: async () => "outside",
      warn: () => undefined,
      now: () => NOW,
    });
    await outside.syncClearinghouseSteps(ORG);
    expect(statusOf("mac_configured")).toBe("skipped");
    expect(statusOf("payer_enrollment")).toBe("skipped");
    expect(state.goLive[0]?.status).toBe("pending");
  });
});

describe("every step write is one transaction under the shared onboarding lock, as the org-profile write is", () => {
  type Wizard = ReturnType<typeof createOnboardingWizard>;
  type Runner = ReturnType<typeof createMemoryWizardRunner>;
  const spy = <S extends object>(store: S, calls: string[]): S =>
    new Proxy(store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(property));
          return value.apply(target, args);
        };
      },
    });
  /** A runner over the memory store, with every transaction's store wrapped by `wrap`. */
  function runnerWith(wrap: <S extends object>(store: S) => S): Runner {
    const base = createMemoryWizardRunner(state);
    return {
      inTenant: (who: TenantActor, org: string, fn: Parameters<Runner["inTenant"]>[2]) =>
        base.inTenant(who, org, (store) => fn(wrap(store))),
      inPlatform: (reason: string, fn: Parameters<Runner["inPlatform"]>[1], user?: string) =>
        base.inPlatform(reason, (store) => fn(wrap(store)), user),
    } as Runner;
  }
  const wizardOver = (runner: Runner, choice?: "outside" | "vendor" | "none"): Wizard =>
    createOnboardingWizard({
      runner,
      orgProfile: createMemoryOrgProfile(state),
      activateOrganization: async () => undefined,
      ...(choice ? { clearinghouseChoice: async () => choice } : {}),
      warn: () => undefined,
      now: () => NOW,
    });
  const recording = (calls: string[]): Wizard =>
    wizardOver(runnerWith((store) => spy(store, calls)));
  /** Go-live approval commits while the write waits for the lock: the lock request itself flips the tenant to active. */
  const approvalCommitsWhileWaiting = (): Wizard =>
    wizardOver(
      runnerWith((store) => ({
        ...store,
        lockOnboardingShared: async () => {
          state.tenants = state.tenants.map((t) => ({ ...t, status: "active" }));
        },
      })),
    );

  const mac = () => taskOf("mac_configured").id;
  const ccn = () => taskOf("ccn_registered").id; // settled in beforeEach: the one a re-open can act on
  const TENANT_WRITES: [string, (w: Wizard) => Promise<unknown>][] = [
    ["skip", (w) => w.tenantSkip(ADMIN, ORG, mac(), RATIONALE)],
    ["start", (w) => w.startTask(ADMIN, ORG, mac())],
    ["block", (w) => w.blockTask(ADMIN, ORG, mac(), "waiting for the MAC to reply")],
    ["attest", (w) => w.attestTask(ADMIN, ORG, mac(), { evidenceNote: "credential on file" })],
    ["re-open", (w) => w.reopenTask(ADMIN, ORG, ccn(), "the number was entered wrongly")],
  ];
  const PLATFORM_WRITES: [string, (w: Wizard) => Promise<unknown>][] = [
    ["skip", (w) => w.skipPlatform("acme", mac(), OPS, RATIONALE)],
    [
      "attest",
      (w) =>
        w.attestPlatform("acme", mac(), OPS, {
          evidenceNote: "credential on file",
          reason: "the customer sent it to us",
        }),
    ],
    ["re-open", (w) => w.reopenPlatform("acme", ccn(), OPS, "the number was entered wrongly")],
  ];

  /** One shared lock, taken before the tenant's status, tasks or attestations are read (only the platform's slug lookup may precede it). */
  const lockedFirst = (calls: string[]) => {
    const lock = calls.indexOf("lockOnboardingShared");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(calls.slice(0, lock).filter((c) => c !== "loadTenant")).toEqual([]);
    expect(calls.lastIndexOf("loadTenant")).toBeGreaterThan(lock);
    expect(calls.indexOf("listTasks")).toBeGreaterThan(lock);
    expect(calls.indexOf("updateTask")).toBeGreaterThan(lock);
    expect(calls.filter((c) => c === "lockOnboardingShared")).toHaveLength(1);
    expect(calls).not.toContain("lockOnboardingExclusive");
  };

  it.each(TENANT_WRITES)(
    "the tenant's %s takes the lock before it reads anything",
    async (_name, run) => {
      const calls: string[] = [];
      await run(recording(calls));
      expect(calls[0]).toBe("lockOnboardingShared");
      lockedFirst(calls);
    },
  );

  it.each(PLATFORM_WRITES)(
    "the operator's %s takes it too, and judges the tenant's status again under it",
    async (_name, run) => {
      const calls: string[] = [];
      await run(recording(calls));
      lockedFirst(calls);
    },
  );

  it("the tenant's skip voids a pending attestation after the lock, the operator's never does", async () => {
    const calls: string[] = [];
    await TENANT_WRITES[0]?.[1](recording(calls));
    expect(calls.indexOf("voidPendingGoLiveForDataChange")).toBeGreaterThan(
      calls.indexOf("lockOnboardingShared"),
    );
    state.tasks = state.tasks.map((t) =>
      t.templateKey === "mac_configured"
        ? { ...t, status: "pending" as const, completionEvidence: {} }
        : t,
    );
    const operatorCalls: string[] = [];
    await PLATFORM_WRITES[0]?.[1](recording(operatorCalls));
    expect(operatorCalls).not.toContain("voidPendingGoLiveForDataChange");
  });

  it.each([
    ...TENANT_WRITES.map(([name, run]) => [`tenant ${name}`, run] as const),
    ...PLATFORM_WRITES.map(([name, run]) => [`operator ${name}`, run] as const),
  ])(
    "the %s answers 409 TENANT_NOT_ONBOARDING for a tenant that went live while it waited for the lock, and changes nothing",
    async (_name, run) => {
      const before = JSON.stringify(state.tasks);
      expect(await refusal(run(approvalCommitsWhileWaiting()))).toEqual({
        code: "TENANT_NOT_ONBOARDING",
        status: 409,
      });
      expect(JSON.stringify(state.tasks)).toBe(before);
    },
  );

  it("a re-open cannot put a step back in progress on a tenant approval just made live (the status and the attestations are one read under the lock)", async () => {
    state.goLive = [
      {
        id: "att-1",
        organizationId: ORG,
        tenantAccountId: TENANT,
        status: "pending",
        attestedByMembershipId: "co-m",
        attestedByUserId: "co-u",
        attestedAt: NOW,
        attestationNote: null,
        approvedByMembershipId: null,
        approvedByUserId: null,
        approvedAt: null,
        approvalReason: null,
        revokedByMembershipId: null,
        revokedByUserId: null,
        revokedAt: null,
        revokeReason: null,
      },
    ];
    // approval commits under its exclusive lock: the attestation is approved and the tenant active
    const approved = wizardOver(
      runnerWith((store) => ({
        ...store,
        lockOnboardingShared: async () => {
          state.tenants = state.tenants.map((t) => ({ ...t, status: "active" }));
          state.goLive = state.goLive.map((g) => ({ ...g, status: "approved" as const }));
        },
      })),
    );
    expect(
      (await refusal(approved.reopenTask(ADMIN, ORG, ccn(), "the number was entered wrongly")))
        .code,
    ).toBe("TENANT_NOT_ONBOARDING");
    expect(statusOf("ccn_registered")).toBe("done");
  });

  it("the clearinghouse sync takes the lock first too, and leaves a tenant that went live alone", async () => {
    settle("account_created", "ccn_registered");
    const calls: string[] = [];
    await wizardOver(
      runnerWith((store) => spy(store, calls)),
      "outside",
    ).syncClearinghouseSteps(ORG);
    expect(calls[0]).toBe("lockOnboardingShared");
    expect(statusOf("mac_configured")).toBe("skipped");

    state.tasks = state.tasks.map((t) => ({
      ...t,
      status: "pending" as const,
      completionEvidence: {},
    }));
    settle("account_created", "ccn_registered");
    const live = wizardOver(
      runnerWith((store) => ({
        ...store,
        lockOnboardingShared: async () => {
          state.tenants = state.tenants.map((t) => ({ ...t, status: "active" }));
        },
      })),
      "outside",
    );
    await live.syncClearinghouseSteps(ORG);
    expect(statusOf("mac_configured")).toBe("pending");
    expect(statusOf("payer_enrollment")).toBe("pending");
  });
});

describe("reopening a tenant skip", () => {
  it("the tenant can undo its own skip: back to in progress, the skip record gone, the history kept", async () => {
    await skip(ADMIN, "mac_configured");
    const step = await wizard().reopenTask(
      ADMIN,
      ORG,
      taskOf("mac_configured").id,
      "we do bill Medicare after all",
    );
    expect(step).toMatchObject({ status: "in_progress", skippedBy: null, skipRationale: null });
    const bag = taskOf("mac_configured").completionEvidence;
    expect(bag.skip).toBeUndefined();
    expect(bag.reopened).toMatchObject([
      {
        reopenedBy: { actorKind: "tenant", membershipId: "admin-m" },
        previous: {
          status: "skipped",
          skipRationale: RATIONALE,
          skippedByActorKind: "tenant",
        },
      },
    ]);
    // and it can be skipped again
    expect((await skip(ADMIN, "mac_configured")).status).toBe("skipped");
  });

  it("the history of a re-opened skip says who skipped it and when: the tenant or an operator", async () => {
    await skip(ADMIN, "mac_configured");
    await wizard().skipPlatform("acme", taskOf("payer_enrollment").id, OPS, "customer asked us");
    for (const key of ["mac_configured", "payer_enrollment"]) {
      await wizard().reopenPlatform("acme", taskOf(key).id, OPS, "the customer changed their mind");
    }
    const previousOf = (key: string) =>
      (taskOf(key).completionEvidence.reopened as { previous: Record<string, unknown> }[])[0]
        ?.previous;
    // the history keeps the kind, the member and the time of the skip, as an attestation's keeps its attester and time
    expect(previousOf("mac_configured")).toMatchObject({
      status: "skipped",
      skippedByActorKind: "tenant",
      skippedByMembershipId: "admin-m",
      skippedAt: NOW.toISOString(),
    });
    expect(previousOf("payer_enrollment")).toMatchObject({
      skippedByActorKind: "platform_ops",
      skippedByMembershipId: "ops-m",
      skippedAt: NOW.toISOString(),
    });
    // a step that was attested, not skipped, carries no skip kind
    settle("dosespot_kickoff_initiated");
    await wizard().reopenPlatform(
      "acme",
      taskOf("dosespot_kickoff_initiated").id,
      OPS,
      "re-checking it",
    );
    expect(
      (
        taskOf("dosespot_kickoff_initiated").completionEvidence.reopened as {
          previous: Record<string, unknown>;
        }[]
      )[0]?.previous,
    ).not.toHaveProperty("skippedByActorKind");
  });

  it("the history of a re-opened system skip says system: the clearinghouse sync skips for `outside` and re-opens for `vendor`", async () => {
    settle("account_created", "ccn_registered");
    const sync = (choice: "outside" | "vendor") =>
      createOnboardingWizard({
        runner: createMemoryWizardRunner(state),
        orgProfile: createMemoryOrgProfile(state),
        activateOrganization: async () => undefined,
        clearinghouseChoice: async () => choice,
        warn: () => undefined,
        now: () => NOW,
      }).syncClearinghouseSteps(ORG);
    await sync("outside");
    expect(statusOf("mac_configured")).toBe("skipped");
    await sync("vendor");
    expect(statusOf("mac_configured")).toBe("in_progress");
    const reopened = taskOf("mac_configured").completionEvidence.reopened as {
      previous: Record<string, unknown>;
    }[];
    expect(reopened[0]?.previous).toMatchObject({
      status: "skipped",
      skipRationale: "bills outside ChartWarden",
      skippedByActorKind: "system",
      skippedByMembershipId: "system",
      skippedAt: NOW.toISOString(),
    });
  });

  it("is refused 409 GO_LIVE_PENDING while a go-live attestation is pending", async () => {
    await skip(ADMIN, "mac_configured");
    state.goLive = [
      {
        id: "att-1",
        organizationId: ORG,
        tenantAccountId: TENANT,
        status: "pending",
        attestedByMembershipId: "co-m",
        attestedByUserId: "co-u",
        attestedAt: NOW,
        attestationNote: null,
        approvedByMembershipId: null,
        approvedByUserId: null,
        approvedAt: null,
        approvalReason: null,
        revokedByMembershipId: null,
        revokedByUserId: null,
        revokedAt: null,
        revokeReason: null,
      },
    ];
    expect(
      await refusal(
        wizard().reopenTask(ADMIN, ORG, taskOf("mac_configured").id, "changed our mind"),
      ),
    ).toEqual({ code: "GO_LIVE_PENDING", status: 409 });
    expect(statusOf("mac_configured")).toBe("skipped");
  });
});

describe("who skipped, as each surface shows it", () => {
  it("the platform view lists a tenant's skip with its rationale, apart from an operator's and the system's", async () => {
    await skip(ADMIN, "mac_configured");
    await wizard().skipPlatform("acme", taskOf("payer_enrollment").id, OPS, "customer asked us");
    const view = await wizard().getPlatform("acme");
    const byKey = (key: string) => view.steps.find((s) => s.key === key);
    expect(byKey("mac_configured")).toMatchObject({
      status: "skipped",
      skippedBy: "tenant",
      skipRationale: RATIONALE,
      systemSkipped: false,
      skippedByLabel: null,
    });
    expect(byKey("payer_enrollment")).toMatchObject({
      skippedBy: "platform_ops",
      skipRationale: "customer asked us",
    });
    expect(taskOf("payer_enrollment").completionEvidence.skip).toMatchObject({
      skippedByActorKind: "platform_ops",
      skippedByMembershipId: "ops-m",
    });
    expect(view.steps.filter((s) => s.skippedBy === "tenant").map((s) => s.key)).toEqual([
      "mac_configured",
    ]);
  });

  it("the tenant view shows an operator's skip as ChartWarden operations and its own as the organization's, naming no operator", async () => {
    await skip(ADMIN, "mac_configured");
    await wizard().skipPlatform("acme", taskOf("payer_enrollment").id, OPS, "customer asked us");
    const view = await wizard().getTenant(ORG, { roles: ADMIN.roles });
    const byKey = (key: string) => view.steps.find((s) => s.key === key);
    expect(byKey("mac_configured")).toMatchObject({
      skippedBy: "tenant",
      skippedByLabel: "Your organization",
    });
    expect(byKey("payer_enrollment")).toMatchObject({
      skippedBy: "platform_ops",
      skippedByLabel: PLATFORM_OPERATOR_LABEL,
    });
    expect(JSON.stringify(view)).not.toMatch(/ops-m|ops-u/);
  });

  it("a skip recorded before slice 7 (no actor kind) reads as the operator's, and the system's by its membership", async () => {
    state.tasks = state.tasks.map((t) =>
      t.templateKey === "mac_configured"
        ? {
            ...t,
            status: "skipped" as const,
            completionEvidence: { skip: { rationale: "legacy", skippedByMembershipId: "old-ops" } },
          }
        : t.templateKey === "payer_enrollment"
          ? {
              ...t,
              status: "skipped" as const,
              completionEvidence: {
                skip: { rationale: "bills outside ChartWarden", skippedByMembershipId: "system" },
              },
            }
          : t,
    );
    const view = await wizard().getPlatform("acme");
    expect(view.steps.find((s) => s.key === "mac_configured")).toMatchObject({
      skippedBy: "platform_ops",
      systemSkipped: false,
    });
    expect(view.steps.find((s) => s.key === "payer_enrollment")).toMatchObject({
      skippedBy: "system",
      systemSkipped: true,
    });
  });
});

describe("tenantSkippable on the view", () => {
  const flag = async (key: string, roles: readonly string[] | undefined) => {
    const view = roles ? await wizard().getTenant(ORG, { roles }) : await wizard().getTenant(ORG);
    return view.steps.find((s) => s.key === key)?.tenantSkippable;
  };

  it("is true for a step of the three that is open and not locked, as the org_admin sees it", async () => {
    expect(await flag("mac_configured", ["org_admin"])).toBe(true);
    // the next step opens as soon as the one before it is settled
    settle("mac_configured");
    expect(await flag("payer_enrollment", ["org_admin"])).toBe(true);
    settle("payer_enrollment");
    expect(await flag("dosespot_kickoff_initiated", ["org_admin"])).toBe(true);
  });

  it("is false for a step an earlier gating step still locks: the skip would be refused 409 ONBOARDING_STEP_OUT_OF_ORDER", async () => {
    for (const key of ["payer_enrollment", "dosespot_kickoff_initiated"]) {
      expect(await flag(key, ["org_admin"])).toBe(false);
      expect((await refusal(skip(ADMIN, key))).code).toBe("ONBOARDING_STEP_OUT_OF_ORDER");
    }
  });

  it("is false for a viewer who is not an org_admin, and when the viewer is not named", async () => {
    expect(await flag("mac_configured", ["administrator"])).toBe(false);
    expect(await flag("mac_configured", ["compliance_officer"])).toBe(false);
    expect(await flag("mac_configured", [])).toBe(false);
    expect(await flag("mac_configured", undefined)).toBe(false);
  });

  it("is false once the step is settled, and for every other step", async () => {
    await skip(ADMIN, "mac_configured");
    settle("payer_enrollment");
    expect(await flag("mac_configured", ["org_admin"])).toBe(false);
    expect(await flag("payer_enrollment", ["org_admin"])).toBe(false);
    for (const key of [
      "sample_data_loaded",
      "operator_added_step",
      "go_live_checklist_complete",
      "ccn_registered",
    ]) {
      expect(await flag(key, ["org_admin"])).toBe(false);
    }
  });

  it("on the platform view it is true for the open, unlocked step of the list and false for the locked ones (the operator reads what the tenant may do)", async () => {
    const offered = async () =>
      (await wizard().getPlatform("acme")).steps.filter((s) => s.tenantSkippable).map((s) => s.key);
    expect(await offered()).toEqual(["mac_configured"]);
    await skip(ADMIN, "mac_configured");
    expect(await offered()).toEqual(["payer_enrollment"]);
  });

  it("the step a tenant action returns carries the same flag for the acting viewer", async () => {
    const step = await wizard().startTask(ADMIN, ORG, taskOf("mac_configured").id);
    expect(step).toMatchObject({ status: "in_progress", tenantSkippable: true });
    const other = await wizard().startTask(OFFICER_AND_ADMIN, ORG, taskOf("mac_configured").id);
    expect(other.tenantSkippable).toBe(true);
  });
});

describe("the system's own skip keeps its kind", () => {
  it("records system for the clearinghouse sync's skip, and a person's skip of the same words stays a person's", async () => {
    const outside = createOnboardingWizard({
      runner: createMemoryWizardRunner(state),
      orgProfile: createMemoryOrgProfile(state),
      activateOrganization: async () => undefined,
      clearinghouseChoice: async () => "outside",
      warn: () => undefined,
      now: () => NOW,
    });
    await outside.syncClearinghouseSteps(ORG);
    expect(taskOf("mac_configured").completionEvidence.skip).toMatchObject({
      skippedByMembershipId: "system",
      skippedByActorKind: "system",
    });
    const view = await wizard().getPlatform("acme");
    expect(view.steps.find((s) => s.key === "mac_configured")).toMatchObject({
      skippedBy: "system",
      systemSkipped: true,
    });
    await skip(ADMIN, "dosespot_kickoff_initiated", "bills outside ChartWarden");
    expect(
      (await wizard().getPlatform("acme")).steps.find(
        (s) => s.key === "dosespot_kickoff_initiated",
      ),
    ).toMatchObject({ skippedBy: "tenant", systemSkipped: false });
  });

  it("choosing a vendor again leaves the tenant's own skip alone, even one that uses the system's words", async () => {
    await skip(ADMIN, "mac_configured", "bills outside ChartWarden");
    const vendor = createOnboardingWizard({
      runner: createMemoryWizardRunner(state),
      orgProfile: createMemoryOrgProfile(state),
      activateOrganization: async () => undefined,
      clearinghouseChoice: async () => "vendor",
      warn: () => undefined,
      now: () => NOW,
    });
    await vendor.syncClearinghouseSteps(ORG);
    // the rationale matches the system's but the membership is the tenant's: only the system's own skips are the system's to undo
    expect(statusOf("mac_configured")).toBe("skipped");
  });
});

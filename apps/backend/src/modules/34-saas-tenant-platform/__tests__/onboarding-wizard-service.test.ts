// The wizard's rules end to end over the in-memory store: strict sequence, owner role, attestation evidence, re-open,
// skip, compliance-officer assignment, org profile, and the two-party go-live. No database; the live suite repeats the
// load-bearing ones on the real roles.
import { ChartWardenError } from "@chartwarden/types";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformActor, StepTemplate, TenantActor, TenantRef } from "../onboarding/model";
import { type OnboardingWizardDeps, createOnboardingWizard } from "../onboarding/wizard-service";
import {
  type MemoryWizardState,
  createMemoryOrgProfile,
  createMemoryWizardRunner,
  createMemoryWizardState,
  memoryMember,
  memoryTask,
} from "../onboarding/wizard-store-memory";

const ORG = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const OPS: PlatformActor = { kind: "platform", membershipId: "ops-m", userId: "ops-u" };
const ADMIN: TenantActor = {
  kind: "tenant",
  membershipId: "admin-m",
  userId: "admin-u",
  roles: ["org_admin"],
};
const OFFICER: TenantActor = {
  kind: "tenant",
  membershipId: "co-m",
  userId: "co-u",
  roles: ["compliance_officer"],
};
const NOW = new Date("2026-11-05T12:00:00Z");

const tpl = (key: string, sequence: number, over: Partial<StepTemplate> = {}): StepTemplate => ({
  key,
  title: key,
  description: "",
  sequence,
  owner: "platform_ops",
  completionMode: "attestation",
  optional: false,
  canonical: true,
  ...over,
});

const TEMPLATES: StepTemplate[] = [
  tpl("organisation", 1),
  tpl("billing", 2, { owner: "either" }),
  tpl("locations", 3, { owner: "org_admin", completionMode: "either" }),
  tpl("baa_auto", 4, { completionMode: "auto" }),
  tpl("sample", 5, { optional: true }),
  tpl("go_live_checklist_complete", 6, { owner: "compliance_officer" }),
];

let state: MemoryWizardState;
let advance: Mock<(tenant: { tenantAccountId: string; organizationId: string }) => Promise<void>>;
let bindOfficerRole: Mock<NonNullable<OnboardingWizardDeps["bindComplianceOfficerRole"]>>;
let activateOrganization: Mock<NonNullable<OnboardingWizardDeps["activateOrganization"]>>;
let warnings: string[];
const taskId = (key: string): string =>
  (state.tasks.find((t) => t.templateKey === key) as { id: string }).id;
const statusOf = (key: string): string =>
  (state.tasks.find((t) => t.templateKey === key) as { status: string }).status;
const tenant = (): TenantRef => state.tenants[0] as TenantRef;

function wizard(at: Date = NOW) {
  return createOnboardingWizard({
    runner: createMemoryWizardRunner(state),
    orgProfile: createMemoryOrgProfile(state),
    advance,
    bindComplianceOfficerRole: bindOfficerRole,
    activateOrganization,
    warn: (message) => warnings.push(message),
    now: () => at,
  });
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ChartWardenError);
    return (e as ChartWardenError).code;
  }
  throw new Error("expected a refusal");
};

const evidence = {
  evidenceNote: "signed order form on file",
  evidenceRef: "DOC-1",
  reason: "customer confirmed by phone",
};

function settle(...keys: string[]): void {
  for (const key of keys) {
    const index = state.tasks.findIndex((t) => t.templateKey === key);
    state.tasks[index] = {
      ...(state.tasks[index] as (typeof state.tasks)[number]),
      status: "done",
    };
  }
}

beforeEach(() => {
  advance = vi.fn(async () => undefined);
  warnings = [];
  activateOrganization = vi.fn(async () => undefined);
  // The real binder commits a `compliance_officer` grant on the tenant pool; this one gives the memory member the same role.
  bindOfficerRole = vi.fn(async ({ organizationId, membershipId }) => {
    const member = state.members.get(membershipId);
    if (!member || member.organizationId !== organizationId) throw new Error("no such member");
    state.members.set(membershipId, {
      ...member,
      roleKeys: [...member.roleKeys, "compliance_officer"],
    });
  });
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
      memoryMember(ORG, "co-m", "co-u", ["compliance_officer"]),
      memoryMember(ORG, "admin-m", "admin-u", ["org_admin"]),
    ]),
    baa: new Map([[TENANT, { baaStatus: "executed", expiresOn: "2028-01-01" }]]),
    profiles: new Map([[ORG, { displayName: "Acme", orgTimezone: "America/New_York" }]]),
  });
});

describe("strict sequence", () => {
  it("refuses to attest, start or skip a later step while an earlier one is open (platform and tenant)", async () => {
    expect(await code(wizard().attestPlatform("acme", taskId("billing"), OPS, evidence))).toBe(
      "ONBOARDING_STEP_OUT_OF_ORDER",
    );
    expect(await code(wizard().startTask(ADMIN, ORG, taskId("billing")))).toBe(
      "ONBOARDING_STEP_OUT_OF_ORDER",
    );
    expect(
      await code(wizard().skipPlatform("acme", taskId("billing"), OPS, "not needed here")),
    ).toBe("ONBOARDING_STEP_OUT_OF_ORDER");
    expect(statusOf("billing")).toBe("pending");
  });

  it("unlocks the next step once the previous is attested", async () => {
    await wizard().attestPlatform("acme", taskId("organisation"), OPS, evidence);
    const step = await wizard().attestPlatform("acme", taskId("billing"), OPS, evidence);
    expect(step).toMatchObject({ key: "billing", status: "done", locked: false });
  });

  it("an unsettled optional step does not lock the next one", async () => {
    settle("organisation", "billing", "locations", "baa_auto");
    const view = await wizard().getPlatform("acme");
    expect(view.steps.find((s) => s.key === "go_live_checklist_complete")?.locked).toBe(false);
    expect(view.currentStepKey).toBe("go_live_checklist_complete");
  });
});

describe("attestation", () => {
  it("stores the evidence, the attester and the time on the task, and asks the sweep to run", async () => {
    const step = await wizard().attestPlatform("acme", taskId("organisation"), OPS, {
      ...evidence,
      evidenceNote: "  signed order form on file  ",
    });
    expect(step).toMatchObject({
      status: "done",
      evidence: { note: "signed order form on file", ref: "DOC-1" },
      attestedBy: { membershipId: "ops-m", actorKind: "platform_ops", at: NOW.toISOString() },
      completedAt: NOW.toISOString(),
    });
    expect(advance).toHaveBeenCalledWith({ tenantAccountId: TENANT, organizationId: ORG });
  });

  it("requires evidence, and a reason from a platform operator", async () => {
    expect(
      await code(
        wizard().attestPlatform("acme", taskId("organisation"), OPS, { evidenceNote: "  " }),
      ),
    ).toBe("ONBOARDING_EVIDENCE_REQUIRED");
    expect(
      await code(
        wizard().attestPlatform("acme", taskId("organisation"), OPS, { evidenceNote: "ok" }),
      ),
    ).toBe("ONBOARDING_REASON_REQUIRED");
    expect(statusOf("organisation")).toBe("pending");
  });

  it("refuses to attest an auto step, the go-live step, or an already settled step", async () => {
    settle("organisation", "billing", "locations");
    expect(await code(wizard().attestPlatform("acme", taskId("baa_auto"), OPS, evidence))).toBe(
      "ONBOARDING_STEP_NOT_ATTESTABLE",
    );
    expect(
      await code(
        wizard().attestPlatform("acme", taskId("go_live_checklist_complete"), OPS, evidence),
      ),
    ).toBe("ONBOARDING_STEP_NOT_ATTESTABLE");
    expect(await code(wizard().attestPlatform("acme", taskId("organisation"), OPS, evidence))).toBe(
      "ONBOARDING_STEP_ALREADY_SETTLED",
    );
  });

  it("a tenant actor may only attest a step it owns", async () => {
    // organisation is platform_ops-owned; the org_admin cannot touch it.
    expect(
      await code(wizard().attestTask(ADMIN, ORG, taskId("organisation"), { evidenceNote: "done" })),
    ).toBe("ONBOARDING_STEP_OWNER_MISMATCH");
    settle("organisation");
    // billing is `either`: the org_admin may, a compliance officer may not.
    expect(
      await code(wizard().attestTask(OFFICER, ORG, taskId("billing"), { evidenceNote: "done" })),
    ).toBe("ONBOARDING_STEP_OWNER_MISMATCH");
    const step = await wizard().attestTask(ADMIN, ORG, taskId("billing"), {
      evidenceNote: "chose Stedi",
      evidenceRef: "ticket-9",
    });
    expect(step.attestedBy?.actorKind).toBe("tenant");
    expect(step.evidence).toEqual({ note: "chose Stedi", ref: "ticket-9" });
  });

  it("refuses every change once the tenant is no longer onboarding", async () => {
    state.tenants = [{ ...tenant(), status: "active" }];
    expect(await code(wizard().attestPlatform("acme", taskId("organisation"), OPS, evidence))).toBe(
      "TENANT_NOT_ONBOARDING",
    );
    expect(
      await code(wizard().reopenPlatform("acme", taskId("organisation"), OPS, "need to fix this")),
    ).toBe("TENANT_NOT_ONBOARDING");
  });

  it("a stale write loses cleanly (compare-and-set)", async () => {
    const base = createMemoryWizardRunner(state);
    const racing = createOnboardingWizard({
      activateOrganization,
      runner: {
        ...base,
        // Another actor starts the step after this call has read it but before it writes.
        inPlatform: (reason, fn) =>
          base.inPlatform(reason, (store) =>
            fn({
              ...store,
              async listTasks(id) {
                const rows = await store.listTasks(id);
                const i = state.tasks.findIndex((t) => t.templateKey === "organisation");
                state.tasks[i] = {
                  ...(state.tasks[i] as (typeof state.tasks)[number]),
                  status: "in_progress",
                };
                return rows;
              },
            }),
          ),
      },
      orgProfile: createMemoryOrgProfile(state),
      now: () => NOW,
    });
    expect(await code(racing.attestPlatform("acme", taskId("organisation"), OPS, evidence))).toBe(
      "ONBOARDING_TASK_CHANGED",
    );
    expect(statusOf("organisation")).toBe("in_progress");
  });
});

describe("skip", () => {
  it("skips with a recorded rationale and counts as settled for the next step", async () => {
    const step = await wizard().skipPlatform(
      "acme",
      taskId("organisation"),
      OPS,
      "customer migrating from another system",
    );
    expect(step).toMatchObject({
      status: "skipped",
      skipRationale: "customer migrating from another system",
    });
    expect((await wizard().attestPlatform("acme", taskId("billing"), OPS, evidence)).status).toBe(
      "done",
    );
  });

  it("refuses to skip go-live", async () => {
    settle("organisation", "billing", "locations", "baa_auto");
    expect(
      await code(
        wizard().skipPlatform(
          "acme",
          taskId("go_live_checklist_complete"),
          OPS,
          "skip the go-live",
        ),
      ),
    ).toBe("ONBOARDING_STEP_NOT_SKIPPABLE");
  });
});

describe("re-open", () => {
  it("re-opens a done step, keeps its history and leaves later steps untouched", async () => {
    await wizard().attestPlatform("acme", taskId("organisation"), OPS, evidence);
    await wizard().attestPlatform("acme", taskId("billing"), OPS, evidence);

    const step = await wizard().reopenPlatform(
      "acme",
      taskId("organisation"),
      OPS,
      "wrong legal name recorded",
    );

    expect(step).toMatchObject({
      status: "in_progress",
      evidence: null,
      attestedBy: null,
      completedAt: null,
    });
    expect(statusOf("billing")).toBe("done");
    const bag = state.tasks.find((t) => t.templateKey === "organisation")?.completionEvidence as {
      reopened: { previous: { evidenceNote: string }; reason: string }[];
    };
    expect(bag.reopened[0]).toMatchObject({
      reason: "wrong legal name recorded",
      previous: { evidenceNote: "signed order form on file" },
    });
  });

  it("re-locks a later step that is not yet settled", async () => {
    await wizard().attestPlatform("acme", taskId("organisation"), OPS, evidence);
    await wizard().reopenPlatform("acme", taskId("organisation"), OPS, "wrong legal name recorded");
    expect(await code(wizard().attestPlatform("acme", taskId("billing"), OPS, evidence))).toBe(
      "ONBOARDING_STEP_OUT_OF_ORDER",
    );
  });

  it("refuses an open step, and a re-open while a go-live attestation is pending", async () => {
    expect(
      await code(wizard().reopenPlatform("acme", taskId("organisation"), OPS, "reason given here")),
    ).toBe("ONBOARDING_STEP_NOT_SETTLED");
    settle("organisation", "billing", "locations", "baa_auto");
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    expect(
      await code(wizard().reopenPlatform("acme", taskId("organisation"), OPS, "reason given here")),
    ).toBe("GO_LIVE_PENDING");
  });

  it("a tenant owner may re-open its own step, but only with a real written reason", async () => {
    settle("organisation");
    await wizard().attestTask(ADMIN, ORG, taskId("billing"), { evidenceNote: "chose Stedi" });
    for (const reason of [undefined, "", "no", "        "]) {
      expect(await code(wizard().reopenTask(ADMIN, ORG, taskId("billing"), reason))).toBe(
        "ONBOARDING_REASON_REQUIRED",
      );
    }
    expect(statusOf("billing")).toBe("done");
    const step = await wizard().reopenTask(ADMIN, ORG, taskId("billing"), "chose the wrong vendor");
    expect(step.status).toBe("in_progress");
    const bag = state.tasks.find((t) => t.templateKey === "billing")?.completionEvidence as {
      reopened: { reason: string }[];
    };
    expect(bag.reopened[0]?.reason).toBe("chose the wrong vendor");
  });
});

describe("free text: no patient identifiers, no NUL", () => {
  const SSN = "900-12-3456"; // area 9xx is never issued
  const MBI = "1EG4TE5MK73"; // synthetic registry value

  it("refuses an identifier in an evidence note or its reference, and changes nothing", async () => {
    expect(
      await code(
        wizard().attestPlatform("acme", taskId("organisation"), OPS, {
          ...evidence,
          evidenceNote: `verified for ${SSN}`,
        }),
      ),
    ).toBe("EVIDENCE_LOOKS_LIKE_PHI");
    expect(
      await code(
        wizard().attestPlatform("acme", taskId("organisation"), OPS, {
          ...evidence,
          evidenceRef: MBI,
        }),
      ),
    ).toBe("EVIDENCE_LOOKS_LIKE_PHI");
    expect(
      await code(
        wizard().attestPlatform("acme", taskId("organisation"), OPS, {
          ...evidence,
          reason: `confirmed for ${SSN}`,
        }),
      ),
    ).toBe("EVIDENCE_LOOKS_LIKE_PHI");
    expect(statusOf("organisation")).toBe("pending");
  });

  it("refuses an identifier in a skip rationale, a blocker reason and a go-live note", async () => {
    expect(
      await code(wizard().skipPlatform("acme", taskId("organisation"), OPS, `not needed ${SSN}`)),
    ).toBe("EVIDENCE_LOOKS_LIKE_PHI");
    expect(await code(wizard().blockTask(ADMIN, ORG, taskId("billing"), `waiting on ${MBI}`))).toBe(
      "EVIDENCE_LOOKS_LIKE_PHI",
    );
    settle("organisation", "billing", "locations", "baa_auto");
    expect(await code(wizard().attestGoLive(OFFICER, ORG, `reviewed ${SSN}`))).toBe(
      "EVIDENCE_LOOKS_LIKE_PHI",
    );
    expect(statusOf("organisation")).toBe("done");
    expect(state.goLive).toHaveLength(0);
  });

  it("refuses NUL as a typed 422 everywhere text is accepted, never a 500", async () => {
    const nul = "text\u0000more";
    const refusals: Array<() => Promise<unknown>> = [
      () =>
        wizard().attestPlatform("acme", taskId("organisation"), OPS, {
          ...evidence,
          evidenceNote: nul,
        }),
      () => wizard().skipPlatform("acme", taskId("organisation"), OPS, `not needed ${nul}`),
      () => wizard().blockTask(ADMIN, ORG, taskId("billing"), `waiting ${nul}`),
      () => wizard().reopenPlatform("acme", taskId("organisation"), OPS, `reason ${nul}`),
    ];
    for (const run of refusals) {
      expect(await code(run())).toBe("ONBOARDING_TEXT_INVALID");
    }
  });

  it("strips control characters from what it stores", async () => {
    const step = await wizard().attestPlatform("acme", taskId("organisation"), OPS, {
      ...evidence,
      evidenceNote: "order\u0007 form\r\nsigned",
    });
    expect(step.evidence?.note).toBe("order form\nsigned");
  });
});

const OPS_REASON = "customer named a new officer on the call";

describe("compliance officer and org profile", () => {
  it("assigns an active member and refuses a stranger", async () => {
    expect(await wizard().setComplianceOfficerPlatform("acme", OPS, "co-m", OPS_REASON)).toEqual({
      complianceOfficerMembershipId: "co-m",
    });
    expect(tenant().complianceOfficerMembershipId).toBe("co-m");
    expect(await code(wizard().setComplianceOfficer(ADMIN, ORG, "ghost-m"))).toBe(
      "COMPLIANCE_OFFICER_NOT_A_MEMBER",
    );
    expect(advance).toHaveBeenCalled();
  });

  it("refuses a member of ANOTHER organisation and a member that is not active, as not a member", async () => {
    state.members.set(
      ...memoryMember("other-org", "foreign-m", "foreign-u", ["compliance_officer"]),
    );
    state.members.set(...memoryMember(ORG, "gone-m", "gone-u", ["compliance_officer"], false));
    for (const membership of ["foreign-m", "gone-m"]) {
      expect(await code(wizard().setComplianceOfficer(ADMIN, ORG, membership))).toBe(
        "COMPLIANCE_OFFICER_NOT_A_MEMBER",
      );
    }
    expect(tenant().complianceOfficerMembershipId).toBeNull();
  });

  it("refuses an active member who does not hold the compliance_officer role (422)", async () => {
    try {
      await wizard().setComplianceOfficer(ADMIN, ORG, "admin-m"); // an org_admin, not an officer
      expect.unreachable("assignment should have been refused");
    } catch (e) {
      const err = e as ChartWardenError;
      expect(err.code).toBe("COMPLIANCE_OFFICER_LACKS_ROLE");
      expect(err.statusCode).toBe(422);
    }
    // With no role binder wired, the platform route is as strict as the tenant's.
    const unbound = createOnboardingWizard({
      activateOrganization,
      runner: createMemoryWizardRunner(state),
      orgProfile: createMemoryOrgProfile(state),
      now: () => NOW,
    });
    expect(
      await code(unbound.setComplianceOfficerPlatform("acme", OPS, "admin-m", OPS_REASON)),
    ).toBe("COMPLIANCE_OFFICER_LACKS_ROLE");
    expect(tenant().complianceOfficerMembershipId).toBeNull();
  });

  it("a platform assignment needs a written reason of 8 to 500 characters", async () => {
    for (const reason of [undefined, "", "short", "       ", "r".repeat(501)]) {
      expect(await code(wizard().setComplianceOfficerPlatform("acme", OPS, "co-m", reason))).toBe(
        "ONBOARDING_REASON_REQUIRED",
      );
    }
    expect(tenant().complianceOfficerMembershipId).toBeNull();
    await wizard().setComplianceOfficerPlatform("acme", OPS, "co-m", "r".repeat(500));
    expect(tenant().complianceOfficerMembershipId).toBe("co-m");
  });

  it("a platform assignment is attributed: the platform transaction carries the operator and an audit entry names operator, organisation and reason", async () => {
    state.tenants = [{ ...tenant(), complianceOfficerMembershipId: "old-officer-m" }];

    await wizard().setComplianceOfficerPlatform("acme", OPS, "co-m", `  ${OPS_REASON}  `);

    expect(state.platformTransactions).toContainEqual({
      reason: "platform-ops compliance officer assignment",
      actorUserId: "ops-u",
    });
    expect(state.platformAudit).toEqual([
      {
        eventType: "m34.onboarding.compliance_officer_assigned",
        tenantAccountId: TENANT,
        organizationId: ORG,
        operator: { userId: "ops-u", membershipId: "ops-m" },
        reason: OPS_REASON,
        detail: {
          previousOfficerMembershipId: "old-officer-m",
          newOfficerMembershipId: "co-m",
          roleBoundByOperator: "false",
        },
      },
    ]);
  });

  describe("a platform assignment binds the compliance_officer role during onboarding", () => {
    // The tenant's org_admin cannot grant it (anti-escalation: the role carries keys org_admin deliberately lacks), so the
    // platform route, which is step-up, reasoned and audited, is the one place the role is bound.
    it("binds the role to an active member who lacks it, then designates them, and the audit entry says so", async () => {
      const result = await wizard().setComplianceOfficerPlatform(
        "acme",
        OPS,
        "admin-m",
        OPS_REASON,
      );

      expect(result).toEqual({ complianceOfficerMembershipId: "admin-m" });
      expect(bindOfficerRole).toHaveBeenCalledTimes(1);
      expect(bindOfficerRole).toHaveBeenCalledWith({
        organizationId: ORG,
        tenantAccountId: TENANT,
        membershipId: "admin-m",
        operator: OPS,
        reason: OPS_REASON,
      });
      expect(tenant().complianceOfficerMembershipId).toBe("admin-m");
      expect(state.platformAudit[0]?.detail).toMatchObject({
        newOfficerMembershipId: "admin-m",
        roleBoundByOperator: "true",
      });
    });

    it("does not bind when the member already holds the role", async () => {
      await wizard().setComplianceOfficerPlatform("acme", OPS, "co-m", OPS_REASON);
      expect(bindOfficerRole).not.toHaveBeenCalled();
    });

    it("never binds for the tenant's own route: its org_admin still needs the role to exist", async () => {
      expect(await code(wizard().setComplianceOfficer(ADMIN, ORG, "admin-m"))).toBe(
        "COMPLIANCE_OFFICER_LACKS_ROLE",
      );
      expect(bindOfficerRole).not.toHaveBeenCalled();
    });

    it("binds nothing for a stranger or an inactive member, and nothing once the tenant is live or before onboarding", async () => {
      state.members.set(...memoryMember(ORG, "gone-m", "gone-u", ["org_admin"], false));
      state.members.set(...memoryMember("other-org", "foreign-m", "foreign-u", ["org_admin"]));
      for (const membership of ["gone-m", "foreign-m", "ghost-m"]) {
        expect(
          await code(wizard().setComplianceOfficerPlatform("acme", OPS, membership, OPS_REASON)),
        ).toBe("COMPLIANCE_OFFICER_NOT_A_MEMBER");
      }
      for (const [status, expected] of [
        ["active", "COMPLIANCE_OFFICER_LACKS_ROLE"],
        ["provisioning", "COMPLIANCE_OFFICER_LOCKED"],
        ["suspended", "COMPLIANCE_OFFICER_LOCKED"],
      ] as const) {
        state.tenants = [{ ...tenant(), status }];
        expect(
          await code(wizard().setComplianceOfficerPlatform("acme", OPS, "admin-m", OPS_REASON)),
        ).toBe(expected);
      }
      expect(bindOfficerRole).not.toHaveBeenCalled();
      expect(tenant().complianceOfficerMembershipId).toBeNull();
    });

    it("a failed bind fails the assignment with its own error and designates nobody", async () => {
      bindOfficerRole.mockRejectedValueOnce(
        new ChartWardenError("COMPLIANCE_OFFICER_ROLE_UNAVAILABLE", "no such role", 422),
      );
      expect(
        await code(wizard().setComplianceOfficerPlatform("acme", OPS, "admin-m", OPS_REASON)),
      ).toBe("COMPLIANCE_OFFICER_ROLE_UNAVAILABLE");
      expect(tenant().complianceOfficerMembershipId).toBeNull();
    });
  });

  it("every platform write runs attributed to its operator", async () => {
    await wizard().attestPlatform("acme", taskId("organisation"), OPS, evidence);
    await wizard().reopenPlatform("acme", taskId("organisation"), OPS, "wrong legal name recorded");
    const writes = state.platformTransactions.filter((t) => /attest|reopen/.test(t.reason));
    expect(writes).toHaveLength(2);
    expect(writes.every((t) => t.actorUserId === "ops-u")).toBe(true);
  });

  it("changes the officer of an ACTIVE tenant too (staff turnover), without waking the onboarding sweep", async () => {
    state.tenants = [{ ...tenant(), status: "active", complianceOfficerMembershipId: "old-m" }];
    advance.mockClear();

    await wizard().setComplianceOfficer(ADMIN, ORG, "co-m");

    expect(tenant().complianceOfficerMembershipId).toBe("co-m");
    expect(advance).not.toHaveBeenCalled();
  });

  it("freezes the officer of a suspended or closing tenant", async () => {
    for (const status of ["suspended", "offboarding_initiated", "destroyed"]) {
      state.tenants = [{ ...tenant(), status }];
      expect(await code(wizard().setComplianceOfficer(ADMIN, ORG, "co-m"))).toBe(
        "COMPLIANCE_OFFICER_LOCKED",
      );
    }
    expect(tenant().complianceOfficerMembershipId).toBeNull();
  });

  it("validates the time zone and display name, and only edits during onboarding", async () => {
    expect(
      await wizard().setOrgProfile(ADMIN, ORG, {
        orgTimezone: "America/Chicago",
        displayName: "  Acme Hospice  ",
      }),
    ).toEqual({
      orgTimezone: "America/Chicago",
      displayName: "Acme Hospice",
    });
    expect(await code(wizard().setOrgProfile(ADMIN, ORG, { orgTimezone: "Mars/Olympus" }))).toBe(
      "INVALID_ORG_TIMEZONE",
    );
    expect(await code(wizard().setOrgProfile(ADMIN, ORG, { orgTimezone: "EST" }))).toBe(
      "INVALID_ORG_TIMEZONE",
    );
    expect(await code(wizard().setOrgProfile(ADMIN, ORG, { displayName: "   " }))).toBe(
      "INVALID_DISPLAY_NAME",
    );
    expect(await code(wizard().setOrgProfile(ADMIN, ORG, {}))).toBe("ORG_PROFILE_EMPTY");
    state.tenants = [{ ...tenant(), status: "active" }];
    expect(await code(wizard().setOrgProfilePlatform("acme", OPS, { orgTimezone: "UTC" }))).toBe(
      "TENANT_NOT_ONBOARDING",
    );
  });
});

describe("two-party go-live", () => {
  beforeEach(() => settle("organisation", "billing", "locations", "baa_auto"));

  it("attest then approve takes the tenant active, recording both actors", async () => {
    const attested = await wizard().attestGoLive(OFFICER, ORG, "all checks reviewed");
    expect(attested.goLive).toMatchObject({
      state: "awaiting_approval",
      attestation: { status: "pending", attestedByMembershipId: "co-m" },
    });
    expect(statusOf("go_live_checklist_complete")).toBe("in_progress");

    const live = await wizard().approveGoLive("acme", OPS, "reviewed the evidence and the BAA");

    expect(live.goLive.state).toBe("live");
    expect(live.goLive.attestation).toMatchObject({
      status: "approved",
      approvedByMembershipId: "ops-m",
      approvalReason: "reviewed the evidence and the BAA",
    });
    expect(tenant().status).toBe("active");
    expect(statusOf("go_live_checklist_complete")).toBe("done");
    expect(state.activations).toHaveLength(1);
  });

  describe("approval activates the organization (the M2 org stays `created` until go-live)", () => {
    const APPROVAL = "reviewed the evidence and the BAA";

    it("activates the organization after the tenant is active, naming the operator and the reason", async () => {
      await wizard().attestGoLive(OFFICER, ORG, undefined);
      let tenantWasActive = false;
      activateOrganization.mockImplementationOnce(async () => {
        tenantWasActive = tenant().status === "active";
      });

      await wizard().approveGoLive("acme", OPS, `  ${APPROVAL}  `);

      expect(activateOrganization).toHaveBeenCalledTimes(1);
      expect(activateOrganization).toHaveBeenCalledWith({
        organizationId: ORG,
        operator: OPS,
        reason: APPROVAL,
      });
      expect(tenantWasActive, "the organization is activated only once the tenant is live").toBe(
        true,
      );
    });

    it("activates nothing for a refused approval or a revoke", async () => {
      expect(await code(wizard().approveGoLive("acme", OPS, APPROVAL))).toBe(
        "GO_LIVE_NOT_ATTESTED",
      );
      await wizard().attestGoLive(OFFICER, ORG, undefined);
      await wizard().revokeGoLive("acme", OPS, "BAA addendum is being renegotiated");
      expect(activateOrganization).not.toHaveBeenCalled();
      expect(tenant().status).toBe("onboarding");
    });

    it("a failed activation is a loud typed 503 (not a 500) naming the recovery; the tenant stays live and the failure is logged", async () => {
      await wizard().attestGoLive(OFFICER, ORG, undefined);
      activateOrganization.mockRejectedValueOnce(new Error("organization update unavailable"));

      try {
        await wizard().approveGoLive("acme", OPS, APPROVAL);
        expect.unreachable("a failed organization activation must not look like success");
      } catch (e) {
        const err = e as ChartWardenError;
        expect(err.code).toBe("ORGANIZATION_ACTIVATION_FAILED");
        expect(err.statusCode).toBe(503);
        expect(err.message).toMatch(/repeat the approval/);
        expect(err.message).not.toMatch(/organizations\/.*\/status/); // not the manual M2 route platform_ops cannot call
      }
      expect(tenant().status).toBe("active");
      expect(warnings).toHaveLength(1);
    });

    describe("repeating the approval finishes an organization the first pass could not open", () => {
      beforeEach(async () => {
        await wizard().attestGoLive(OFFICER, ORG, undefined);
        activateOrganization.mockRejectedValueOnce(new Error("organization update unavailable"));
        await code(wizard().approveGoLive("acme", OPS, APPROVAL));
        activateOrganization.mockClear();
      });

      it("skips the guards, activates nothing twice and re-runs only the organization activation", async () => {
        // Guards that would now fail (a step re-opened after go-live) must not matter: the approval already happened.
        settle("organisation");
        state.tasks[0] = { ...(state.tasks[0] as (typeof state.tasks)[number]), status: "pending" };
        const other: PlatformActor = { kind: "platform", membershipId: "ops2-m", userId: "ops2-u" };

        const view = await wizard().approveGoLive(
          "acme",
          other,
          "completing the organization activation",
        );

        expect(view.goLive.state).toBe("live");
        expect(activateOrganization).toHaveBeenCalledTimes(1);
        expect(activateOrganization).toHaveBeenCalledWith({
          organizationId: ORG,
          operator: other,
          reason: "completing the organization activation",
        });
        expect(state.activations).toHaveLength(1); // the tenant was activated once, by the first approval
        expect(state.goLive[0]).toMatchObject({ status: "approved", approvedByUserId: "ops-u" });
      });

      it("is repeatable until it works, and a second failure is the same typed 503", async () => {
        activateOrganization.mockRejectedValueOnce(new Error("still unavailable"));
        expect(await code(wizard().approveGoLive("acme", OPS, APPROVAL))).toBe(
          "ORGANIZATION_ACTIVATION_FAILED",
        );
        await expect(wizard().approveGoLive("acme", OPS, APPROVAL)).resolves.toBeDefined();
      });

      it("still refuses the attester completing it (two people, not one)", async () => {
        const attesterAsOperator: PlatformActor = {
          kind: "platform",
          membershipId: "somewhere-m",
          userId: OFFICER.userId,
        };
        expect(await code(wizard().approveGoLive("acme", attesterAsOperator, APPROVAL))).toBe(
          "GO_LIVE_SAME_PERSON",
        );
        expect(activateOrganization).not.toHaveBeenCalled();
      });
    });

    it("an active tenant with no approved attestation is still refused (the repeat is not a way around the approval)", async () => {
      state.tenants = [{ ...tenant(), status: "active" }];
      expect(await code(wizard().approveGoLive("acme", OPS, APPROVAL))).toBe(
        "TENANT_NOT_ONBOARDING",
      );
      expect(activateOrganization).not.toHaveBeenCalled();
    });
  });

  it("approve without an attestation is refused and the tenant stays in onboarding", async () => {
    expect(await code(wizard().approveGoLive("acme", OPS, "reviewed everything twice"))).toBe(
      "GO_LIVE_NOT_ATTESTED",
    );
    expect(tenant().status).toBe("onboarding");
  });

  it("only a compliance officer attests, and only the assigned one when one is assigned", async () => {
    expect(await code(wizard().attestGoLive(ADMIN, ORG, undefined))).toBe(
      "GO_LIVE_NOT_COMPLIANCE_OFFICER",
    );
    state.tenants = [{ ...tenant(), complianceOfficerMembershipId: "someone-else" }];
    expect(await code(wizard().attestGoLive(OFFICER, ORG, undefined))).toBe(
      "GO_LIVE_NOT_ASSIGNED_OFFICER",
    );
  });

  it("attestation needs the earlier steps settled, and a second attestation is refused", async () => {
    const index = state.tasks.findIndex((t) => t.templateKey === "baa_auto");
    state.tasks[index] = {
      ...(state.tasks[index] as (typeof state.tasks)[number]),
      status: "pending",
    };
    expect(await code(wizard().attestGoLive(OFFICER, ORG, undefined))).toBe(
      "ONBOARDING_STEP_OUT_OF_ORDER",
    );
    settle("baa_auto");
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    expect(await code(wizard().attestGoLive(OFFICER, ORG, undefined))).toBe(
      "GO_LIVE_ALREADY_ATTESTED",
    );
  });

  it("approve re-checks the guards at approval time and lists what failed", async () => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    state.baa = new Map([[TENANT, { baaStatus: "executed", expiresOn: "2026-12-01" }]]); // expires within 90 days
    const index = state.tasks.findIndex((t) => t.templateKey === "billing");
    state.tasks[index] = {
      ...(state.tasks[index] as (typeof state.tasks)[number]),
      status: "in_progress",
    }; // reopened after attestation
    try {
      await wizard().approveGoLive("acme", OPS, "reviewed the evidence and the BAA");
      expect.unreachable("approval should have been refused");
    } catch (e) {
      const err = e as ChartWardenError;
      expect(err.code).toBe("ACTIVATION_GUARDS_FAILED");
      expect(err.details?.map((d) => `${d.field}:${d.code}`)).toEqual([
        "guard:canonicalTasksComplete",
        "templateKey:billing",
        "guard:baaExpiryClearsNinetyDays",
      ]);
    }
    expect(tenant().status).toBe("onboarding");
    expect(state.activations).toHaveLength(0);
  });

  it("a platform operator can revoke a pending attestation, after which the officer may attest again", async () => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    const revoked = await wizard().revokeGoLive("acme", OPS, "BAA addendum is being renegotiated");
    expect(revoked.goLive).toMatchObject({
      state: "awaiting_attestation",
      attestation: { status: "revoked", revokedByMembershipId: "ops-m" },
    });
    expect(statusOf("go_live_checklist_complete")).toBe("pending");
    expect(await code(wizard().revokeGoLive("acme", OPS, "nothing is pending now"))).toBe(
      "GO_LIVE_NOT_ATTESTED",
    );
    expect((await wizard().attestGoLive(OFFICER, ORG, undefined)).goLive.state).toBe(
      "awaiting_approval",
    );
  });
});

describe("platform staff are never the compliance officer or the attester (one operator must not hold both hats)", () => {
  // Every platform_ops operator holds an active membership in every tenant (bootstrap/bind-platform-staff.ts), so without
  // this rule an operator could be bound compliance_officer, attest go-live themselves, and let a colleague approve.
  const COLLEAGUE: TenantActor = {
    kind: "tenant",
    membershipId: "colleague-m",
    userId: "colleague-u",
    roles: ["compliance_officer", "platform_alert_audience"],
  };
  const PLATFORM_REFUSAL = "COMPLIANCE_OFFICER_PLATFORM_STAFF";
  beforeEach(() => {
    state.members.set(
      ...memoryMember(ORG, "colleague-m", "colleague-u", [
        "compliance_officer",
        "platform_alert_audience",
      ]),
    );
    state.members.set(...memoryMember(ORG, "ops-own-m", "ops-u", ["org_admin"]));
    state.members.set(...memoryMember(ORG, "ops-home-m", "colleague2-u", ["org_admin"]));
    state.platformStaffUserIds = new Set(["colleague2-u"]);
  });

  it("refuses to bind or assign the operator's own membership in the tenant (422), and binds nothing", async () => {
    try {
      await wizard().setComplianceOfficerPlatform("acme", OPS, "ops-own-m", OPS_REASON);
      expect.unreachable("an operator cannot name themselves the compliance officer");
    } catch (e) {
      expect((e as ChartWardenError).code).toBe(PLATFORM_REFUSAL);
      expect((e as ChartWardenError).statusCode).toBe(422);
    }
    expect(bindOfficerRole).not.toHaveBeenCalled();
    expect(tenant().complianceOfficerMembershipId).toBeNull();
  });

  it("refuses a colleague operator's tenant membership: audience-bound, and a platform role holder without the binding", async () => {
    for (const membership of ["colleague-m", "ops-home-m"]) {
      expect(
        await code(wizard().setComplianceOfficerPlatform("acme", OPS, membership, OPS_REASON)),
        membership,
      ).toBe(PLATFORM_REFUSAL);
    }
    expect(bindOfficerRole).not.toHaveBeenCalled();
    expect(tenant().complianceOfficerMembershipId).toBeNull();
  });

  it("the tenant route refuses a platform operator too, even one that already holds the role", async () => {
    expect(await code(wizard().setComplianceOfficer(ADMIN, ORG, "colleague-m"))).toBe(
      PLATFORM_REFUSAL,
    );
    expect(tenant().complianceOfficerMembershipId).toBeNull();
  });

  it("a platform operator who is already the assigned officer cannot attest go-live (colleague scenario)", async () => {
    settle("organisation", "billing", "locations", "baa_auto");
    state.tenants = [{ ...tenant(), complianceOfficerMembershipId: "colleague-m" }];
    expect(await code(wizard().attestGoLive(COLLEAGUE, ORG, undefined))).toBe(PLATFORM_REFUSAL);
    expect(state.goLive).toHaveLength(0);
  });

  it("refuses an attester who is a platform role holder through the tenant session's roles alone", async () => {
    settle("organisation", "billing", "locations", "baa_auto");
    state.members.set(...memoryMember(ORG, "co-m", "co-u", ["compliance_officer"]));
    state.platformStaffUserIds = new Set(["co-u"]);
    expect(await code(wizard().attestGoLive(OFFICER, ORG, undefined))).toBe(PLATFORM_REFUSAL);
  });

  it("an attestation filed before the attester became platform staff is stale at approval, with its own detail", async () => {
    settle("organisation", "billing", "locations", "baa_auto");
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    state.platformStaffUserIds = new Set(["co-u"]);
    try {
      await wizard().approveGoLive("acme", OPS, "reviewed the evidence and the BAA");
      expect.unreachable("approval should have been refused");
    } catch (e) {
      const err = e as ChartWardenError;
      expect(err.code).toBe("GO_LIVE_ATTESTATION_STALE");
      expect(err.details?.map((d) => d.code)).toEqual(["attester_platform_staff"]);
    }
    expect(tenant().status).toBe("onboarding");
  });

  it("an ordinary tenant member is still assignable and can still attest", async () => {
    settle("organisation", "billing", "locations", "baa_auto");
    await wizard().setComplianceOfficerPlatform("acme", OPS, "co-m", OPS_REASON);
    await expect(wizard().attestGoLive(OFFICER, ORG, undefined)).resolves.toBeDefined();
  });
});

describe("a pending attestation does not survive a change to the data it attested", () => {
  beforeEach(async () => {
    settle("organisation", "billing", "locations", "baa_auto");
    await wizard().attestGoLive(OFFICER, ORG, "all checks reviewed");
  });
  const pendingCount = () => state.goLive.filter((g) => g.status === "pending").length;

  it("an org-profile edit by the tenant's admin voids the pending attestation, audited with its reason and the actor", async () => {
    expect(statusOf("go_live_checklist_complete")).toBe("in_progress");
    await wizard().setOrgProfile(ADMIN, ORG, { displayName: "Acme Hospice East" });
    expect(pendingCount()).toBe(0);
    expect(state.goLive[0]).toMatchObject({
      status: "revoked",
      revokeReason: "onboarding data changed after attestation",
      revokedByUserId: "admin-u",
      revokedByMembershipId: "admin-m",
    });
    expect(statusOf("go_live_checklist_complete")).toBe("pending");
    // approval can no longer rest on it
    expect(
      await code(wizard().approveGoLive("acme", OPS, "reviewed the evidence and the BAA")),
    ).toBe("GO_LIVE_NOT_ATTESTED");
    expect(tenant().status).toBe("onboarding");
  });

  it("the same edit by a platform operator voids it, attributed to the operator's USER (their membership is in their home organisation, so none is recorded)", async () => {
    await wizard().setOrgProfilePlatform("acme", OPS, { orgTimezone: "America/Chicago" });
    expect(state.goLive[0]).toMatchObject({
      status: "revoked",
      revokedByUserId: "ops-u",
      revokedByMembershipId: null,
    });
  });

  it("the officer can attest again after the void", async () => {
    await wizard().setOrgProfile(ADMIN, ORG, { displayName: "Acme Hospice East" });
    await wizard().attestGoLive(OFFICER, ORG, "re-checked after the change");
    expect(pendingCount()).toBe(1);
  });

  it("a refused or invalid edit voids nothing", async () => {
    expect(await code(wizard().setOrgProfile(ADMIN, ORG, { orgTimezone: "Mars/Olympus" }))).toBe(
      "INVALID_ORG_TIMEZONE",
    );
    expect(pendingCount()).toBe(1);
    state.tenants = [{ ...tenant(), status: "active" }];
    expect(await code(wizard().setOrgProfile(ADMIN, ORG, { displayName: "Too Late" }))).toBe(
      "TENANT_NOT_ONBOARDING",
    );
    expect(pendingCount()).toBe(1);
  });

  it("an edit with no pending attestation is a plain edit", async () => {
    await wizard().revokeGoLive("acme", OPS, "BAA addendum is being renegotiated");
    const before = JSON.stringify(state.goLive);
    await wizard().setOrgProfile(ADMIN, ORG, { displayName: "Acme Hospice East" });
    expect(JSON.stringify(state.goLive)).toBe(before);
  });
});

describe("a BAA recorded or last changed by the approving operator cannot take the tenant live", () => {
  const APPROVAL = "reviewed the evidence and the BAA";
  beforeEach(async () => {
    settle("organisation", "billing", "locations", "baa_auto");
    await wizard().attestGoLive(OFFICER, ORG, undefined);
  });

  it.each([
    ["recorded", { recordedByUserId: "ops-u" }],
    ["last changed", { recordedByUserId: "someone-u", updatedByUserId: "ops-u" }],
  ])(
    "refuses (409 GO_LIVE_APPROVER_WROTE_BAA) an approver who %s the governing BAA, and changes nothing",
    async (_label, writer) => {
      state.baa = new Map([
        [
          TENANT,
          { baaStatus: "executed", expiresOn: "2028-01-01", documentId: "doc-1", ...writer },
        ],
      ]);
      try {
        await wizard().approveGoLive("acme", OPS, APPROVAL);
        expect.unreachable("the BAA's own writer cannot approve the go-live");
      } catch (e) {
        expect((e as ChartWardenError).code).toBe("GO_LIVE_APPROVER_WROTE_BAA");
        expect((e as ChartWardenError).statusCode).toBe(409);
      }
      expect(tenant().status).toBe("onboarding");
      expect(state.goLive[0]?.status).toBe("pending");
      expect(activateOrganization).not.toHaveBeenCalled();
    },
  );

  it("another operator approves, and a legacy row with no recorded writer cannot be judged", async () => {
    state.baa = new Map([
      [
        TENANT,
        {
          baaStatus: "executed",
          expiresOn: "2028-01-01",
          documentId: "doc-1",
          recordedByUserId: "someone-u",
        },
      ],
    ]);
    await expect(wizard().approveGoLive("acme", OPS, APPROVAL)).resolves.toBeDefined();
  });

  it("a legacy BAA row with no writer columns still lets the approval through", async () => {
    await expect(wizard().approveGoLive("acme", OPS, APPROVAL)).resolves.toBeDefined();
  });
});

describe("a failed officer assignment leaves no stray role grant", () => {
  const unbind = vi.fn(async () => undefined);
  const wizardWithUnbind = () =>
    createOnboardingWizard({
      activateOrganization,
      runner: createMemoryWizardRunner(state),
      orgProfile: createMemoryOrgProfile(state),
      bindComplianceOfficerRole: bindOfficerRole,
      unbindComplianceOfficerRole: unbind,
      warn: (message) => warnings.push(message),
      now: () => NOW,
    });
  beforeEach(() => unbind.mockClear());

  it("expires the grant the assignment just bound when a later step fails, and the original error reaches the caller", async () => {
    const runner = createMemoryWizardRunner(state);
    const failingAudit = createOnboardingWizard({
      activateOrganization,
      runner: {
        inTenant: runner.inTenant,
        inPlatform: (reason, fn, actor) =>
          runner.inPlatform(
            reason,
            (store) =>
              fn({
                ...store,
                recordPlatformAudit: async () => {
                  throw new Error("audit write unavailable");
                },
              }),
            actor,
          ),
      },
      orgProfile: createMemoryOrgProfile(state),
      bindComplianceOfficerRole: bindOfficerRole,
      unbindComplianceOfficerRole: unbind,
      now: () => NOW,
    });
    await expect(
      failingAudit.setComplianceOfficerPlatform("acme", OPS, "admin-m", OPS_REASON),
    ).rejects.toThrow("audit write unavailable");
    expect(bindOfficerRole).toHaveBeenCalledTimes(1);
    expect(unbind).toHaveBeenCalledWith({
      organizationId: ORG,
      tenantAccountId: TENANT,
      membershipId: "admin-m",
      operator: OPS,
      reason: OPS_REASON,
    });
  });

  it("does not undo a grant it did not make", async () => {
    await wizardWithUnbind().setComplianceOfficerPlatform("acme", OPS, "co-m", OPS_REASON);
    expect(unbind).not.toHaveBeenCalled();
  });

  it("a failing undo is logged and never replaces the assignment's own error", async () => {
    unbind.mockRejectedValueOnce(new Error("tenant database unavailable"));
    const runner = createMemoryWizardRunner(state);
    const w = createOnboardingWizard({
      activateOrganization,
      runner: {
        inTenant: runner.inTenant,
        inPlatform: (reason, fn, actor) =>
          runner.inPlatform(
            reason,
            (store) =>
              fn({
                ...store,
                recordPlatformAudit: async () => {
                  throw new Error("audit write unavailable");
                },
              }),
            actor,
          ),
      },
      orgProfile: createMemoryOrgProfile(state),
      bindComplianceOfficerRole: bindOfficerRole,
      unbindComplianceOfficerRole: unbind,
      warn: (message) => warnings.push(message),
      now: () => NOW,
    });
    await expect(
      w.setComplianceOfficerPlatform("acme", OPS, "admin-m", OPS_REASON),
    ).rejects.toThrow("audit write unavailable");
    expect(warnings.some((m) => /undoing the compliance officer role bind/.test(m))).toBe(true);
  });
});

describe("go-live approval takes the exclusive onboarding lock before it reads or writes anything", () => {
  // Data writers hold the SHARED onboarding lock and then update the attestation row; an approval that row-locked the attestation
  // first and asked for the exclusive lock afterwards would deadlock against them. So the lock is the first thing it does.
  beforeEach(() => settle("organisation", "billing", "locations", "baa_auto"));

  it("locks exclusively first, then re-reads the tenant and its attestations under the lock", async () => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    const calls: string[] = [];
    const runner = createMemoryWizardRunner(state);
    const spying = createOnboardingWizard({
      runner: {
        inTenant: runner.inTenant,
        inPlatform: (reason, fn, actor) =>
          runner.inPlatform(
            reason,
            (store) =>
              fn({
                ...store,
                lockOnboardingExclusive: async (organizationId) => {
                  calls.push(`lock:${organizationId}`);
                },
                listGoLive: async (scope) => {
                  calls.push("listGoLive");
                  return store.listGoLive(scope);
                },
                settleGoLive: async (organizationId, id, patch) => {
                  calls.push("settleGoLive");
                  return store.settleGoLive(organizationId, id, patch);
                },
              }),
            actor,
          ),
      },
      orgProfile: createMemoryOrgProfile(state),
      activateOrganization,
      now: () => NOW,
    });

    await spying.approveGoLive("acme", OPS, "reviewed the evidence and the BAA");

    expect(calls[0]).toBe(`lock:${ORG}`);
    expect(calls.indexOf("settleGoLive")).toBeGreaterThan(calls.indexOf("listGoLive"));
    expect(calls.indexOf("listGoLive")).toBeGreaterThan(0);
  });

  it("judges the attestation as it is under the lock: one a writer voided while the approval waited is refused", async () => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    const runner = createMemoryWizardRunner(state);
    const racing = createOnboardingWizard({
      runner: {
        inTenant: runner.inTenant,
        inPlatform: (reason, fn, actor) =>
          runner.inPlatform(
            reason,
            (store) =>
              fn({
                ...store,
                // while this approval waits for the exclusive lock, a data write commits and voids the attestation
                lockOnboardingExclusive: async () => {
                  await store.voidPendingGoLiveForDataChange({
                    organizationId: ORG,
                    revokedByUserId: "admin-u",
                    revokedByMembershipId: "admin-m",
                  });
                },
              }),
            actor,
          ),
      },
      orgProfile: createMemoryOrgProfile(state),
      activateOrganization,
      now: () => NOW,
    });
    expect(await code(racing.approveGoLive("acme", OPS, "reviewed the evidence and the BAA"))).toBe(
      "GO_LIVE_NOT_ATTESTED",
    );
    expect(tenant().status).toBe("onboarding");
    expect(activateOrganization).not.toHaveBeenCalled();
  });

  it("hands the M2 activation the NORMALIZED reason the approval recorded (control characters stripped), not a bare trim", async () => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    await wizard().approveGoLive("acme", OPS, "  reviewed the\u0007 evidence and the BAA  ");
    expect(activateOrganization).toHaveBeenCalledWith({
      organizationId: ORG,
      operator: OPS,
      reason: "reviewed the evidence and the BAA",
    });
    expect(state.goLive[0]?.approvalReason).toBe("reviewed the evidence and the BAA");
  });
});

describe("go-live: two people, a live attester, a fresh attestation", () => {
  beforeEach(() => settle("organisation", "billing", "locations", "baa_auto"));
  const DAY_MS = 24 * 3600 * 1000;

  it("records both parties as a membership and as the user behind it", async () => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    expect(state.goLive[0]).toMatchObject({
      organizationId: ORG,
      attestedByMembershipId: "co-m",
      attestedByUserId: "co-u",
    });
    await wizard().approveGoLive("acme", OPS, "reviewed the evidence and the BAA");
    expect(state.goLive[0]).toMatchObject({
      status: "approved",
      approvedByMembershipId: "ops-m",
      approvedByUserId: "ops-u",
    });
  });

  it("refuses to let one human attest and approve, even through two memberships, and changes nothing", async () => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    // The platform operator is ALSO invited into the tenant as its compliance officer: a different membership, one user.
    const samePerson: PlatformActor = {
      kind: "platform",
      membershipId: "ops-membership-of-the-officer",
      userId: OFFICER.userId,
    };

    const refused = await code(
      wizard().approveGoLive("acme", samePerson, "reviewed everything twice"),
    );

    expect(refused).toBe("GO_LIVE_SAME_PERSON");
    expect(tenant().status).toBe("onboarding");
    expect(state.goLive[0]?.status).toBe("pending");
    expect(state.activations).toHaveLength(0);
  });

  it("refuses an approval by the attester's own membership as well", async () => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    const sameMembership: PlatformActor = {
      kind: "platform",
      membershipId: "co-m",
      userId: "ops-u",
    };
    expect(
      await code(wizard().approveGoLive("acme", sameMembership, "reviewed everything twice")),
    ).toBe("GO_LIVE_SAME_PERSON");
  });

  it.each([
    ["has left the organization", () => state.members.delete("co-m"), "attester_not_active"],
    [
      "was deactivated",
      () => state.members.set(...memoryMember(ORG, "co-m", "co-u", ["compliance_officer"], false)),
      "attester_not_active",
    ],
    [
      "lost the compliance_officer role",
      () => state.members.set(...memoryMember(ORG, "co-m", "co-u", ["org_admin"])),
      "attester_not_compliance_officer",
    ],
    [
      "is no longer the assigned officer",
      () => {
        state.tenants = [{ ...tenant(), complianceOfficerMembershipId: "someone-else" }];
      },
      "attester_not_assigned_officer",
    ],
  ])("refuses to approve once the attester %s", async (_label, change, detail) => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    change();

    try {
      await wizard().approveGoLive("acme", OPS, "reviewed the evidence and the BAA");
      expect.unreachable("approval should have been refused");
    } catch (e) {
      const err = e as ChartWardenError;
      expect(err.code).toBe("GO_LIVE_ATTESTATION_STALE");
      expect(err.statusCode).toBe(409);
      expect(err.details?.map((d) => d.code)).toEqual([detail]);
    }
    expect(tenant().status).toBe("onboarding");
    expect(state.goLive[0]?.status).toBe("pending");
  });

  it("approves up to 14 days after the attestation and refuses after, until platform operations revoke it", async () => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    const filedAt = (state.goLive[0] as { attestedAt: Date }).attestedAt;
    const afterTtl = new Date(filedAt.getTime() + 14 * DAY_MS + 1);

    expect(
      await code(wizard(afterTtl).approveGoLive("acme", OPS, "reviewed the evidence and the BAA")),
    ).toBe("GO_LIVE_ATTESTATION_EXPIRED");
    // The officer cannot simply attest again: the expired one still holds the tenant's only pending slot.
    expect(await code(wizard(afterTtl).attestGoLive(OFFICER, ORG, undefined))).toBe(
      "GO_LIVE_ATTESTATION_EXPIRED",
    );
    await wizard(afterTtl).revokeGoLive("acme", OPS, "the attestation expired after fourteen days");
    expect((await wizard(afterTtl).attestGoLive(OFFICER, ORG, undefined)).goLive.state).toBe(
      "awaiting_approval",
    );
  });

  it("an attestation filed exactly 14 days ago is still approvable", async () => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    const filedAt = (state.goLive[0] as { attestedAt: Date }).attestedAt;

    const live = await wizard(new Date(filedAt.getTime() + 14 * DAY_MS)).approveGoLive(
      "acme",
      OPS,
      "reviewed the evidence and the BAA",
    );

    expect(live.goLive.state).toBe("live");
  });

  it("shows when a pending attestation stops being approvable", async () => {
    const view = await wizard().attestGoLive(OFFICER, ORG, undefined);
    const filedAt = (state.goLive[0] as { attestedAt: Date }).attestedAt;
    expect(view.goLive.attestation?.expiresAt).toBe(
      new Date(filedAt.getTime() + 14 * DAY_MS).toISOString(),
    );
  });

  describe("reassigning the compliance officer voids a pending attestation", () => {
    const OFFICER_TWO: TenantActor = {
      kind: "tenant",
      membershipId: "co2-m",
      userId: "co2-u",
      roles: ["compliance_officer"],
    };
    beforeEach(() => {
      state.members.set(...memoryMember(ORG, "co2-m", "co2-u", ["compliance_officer"]));
      state.tenants = [{ ...tenant(), complianceOfficerMembershipId: "co-m" }];
    });

    it("a tenant org_admin's reassignment revokes it as the admin, resets the go-live step, and the new officer can attest", async () => {
      await wizard().attestGoLive(OFFICER, ORG, undefined);
      expect(statusOf("go_live_checklist_complete")).toBe("in_progress");

      await wizard().setComplianceOfficer(ADMIN, ORG, "co2-m");

      expect(state.goLive[0]).toMatchObject({
        status: "revoked",
        revokedByMembershipId: "admin-m",
        revokeReason: expect.stringContaining("reassigned"),
      });
      expect(statusOf("go_live_checklist_complete")).toBe("pending");
      expect(tenant().complianceOfficerMembershipId).toBe("co2-m");
      // the void ran on a platform transaction attributed to the admin (a tenant session cannot write the table)
      expect(state.platformTransactions).toContainEqual({
        reason: "system: void go-live attestation after compliance officer change",
        actorUserId: "admin-u",
      });
      expect((await wizard().attestGoLive(OFFICER_TWO, ORG, undefined)).goLive.state).toBe(
        "awaiting_approval",
      );
    });

    it("a platform operator's reassignment revokes it as the operator, in the same transaction", async () => {
      await wizard().attestGoLive(OFFICER, ORG, undefined);

      await wizard().setComplianceOfficerPlatform("acme", OPS, "co2-m", OPS_REASON);

      expect(state.goLive[0]).toMatchObject({ status: "revoked", revokedByMembershipId: "ops-m" });
      expect(statusOf("go_live_checklist_complete")).toBe("pending");
    });

    it("assigning the officer who already attested voids nothing", async () => {
      await wizard().attestGoLive(OFFICER, ORG, undefined);

      await wizard().setComplianceOfficer(ADMIN, ORG, "co-m");

      expect(state.goLive[0]?.status).toBe("pending");
    });

    it("a failed void is logged, never hidden, and the stale attestation still cannot be approved", async () => {
      await wizard().attestGoLive(OFFICER, ORG, undefined);
      const warn = vi.fn();
      const base = createMemoryWizardRunner(state);
      const flaky = createOnboardingWizard({
        activateOrganization,
        runner: {
          inTenant: base.inTenant,
          inPlatform: (reason, fn, actorUserId) =>
            reason.startsWith("system:")
              ? Promise.reject(new Error("platform database unavailable"))
              : base.inPlatform(reason, fn, actorUserId),
        },
        orgProfile: createMemoryOrgProfile(state),
        warn,
        now: () => NOW,
      });

      await flaky.setComplianceOfficer(ADMIN, ORG, "co2-m");

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("void"),
        expect.objectContaining({
          tenantAccountId: TENANT,
          // The raw error, for the redacting serializer: never its message (a database error's message holds bound values).
          err: expect.objectContaining({ message: "platform database unavailable" }),
        }),
      );
      expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("error");
      expect(state.goLive[0]?.status).toBe("pending");
      expect(
        await code(wizard().approveGoLive("acme", OPS, "reviewed the evidence and the BAA")),
      ).toBe("GO_LIVE_ATTESTATION_STALE");
    });
  });

  it("scopes the attestations it reads to the organization as well as the tenant", async () => {
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    // A row of ANOTHER organisation that names this tenant account (the shape the composite FK now forbids in the real table).
    state.goLive = [
      ...state.goLive,
      {
        ...(state.goLive[0] as (typeof state.goLive)[number]),
        id: "foreign",
        organizationId: "other-org",
      },
    ];

    const view = await wizard(NOW).getPlatform("acme");

    expect(view.goLive.attestation?.id).not.toBe("foreign");
  });
});

describe("the tenant never sees a ChartWarden operator's ids", () => {
  it("a platform-attested step shows as ChartWarden operations to the tenant, with its id to the platform", async () => {
    await wizard().attestPlatform("acme", taskId("organisation"), OPS, evidence);

    const forTenant = await wizard().getTenant(ORG);
    const forPlatform = await wizard().getPlatform("acme");

    expect(forTenant.steps[0]?.attestedBy).toMatchObject({
      membershipId: null,
      actorKind: "platform_ops",
      label: "ChartWarden operations",
    });
    expect(forPlatform.steps[0]?.attestedBy).toMatchObject({ membershipId: "ops-m", label: null });
    expect(JSON.stringify(forTenant)).not.toMatch(/ops-m|ops-u/);
  });

  it("every tenant response (start, attest, re-open, go-live attest) is redacted, and the evidence text stays", async () => {
    await wizard().attestPlatform("acme", taskId("organisation"), OPS, evidence);
    const started = await wizard().startTask(ADMIN, ORG, taskId("billing"));
    expect(JSON.stringify(started)).not.toMatch(/ops-m|ops-u/);
    const reopened = await wizard().reopenPlatform(
      "acme",
      taskId("organisation"),
      OPS,
      "wrong legal name recorded",
    );
    expect(reopened.status).toBe("in_progress");
    await wizard().attestPlatform("acme", taskId("organisation"), OPS, evidence);
    settle("billing", "locations", "baa_auto");
    const attested = await wizard().attestGoLive(OFFICER, ORG, "all checks reviewed");
    expect(JSON.stringify(attested)).not.toMatch(/ops-m|ops-u/);
    expect(attested.steps.find((s) => s.key === "organisation")?.evidence?.note).toBe(
      "signed order form on file",
    );
  });

  it("an approval shows the tenant who approved only as ChartWarden operations, with the reason and the time", async () => {
    settle("organisation", "billing", "locations", "baa_auto");
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    await wizard().approveGoLive("acme", OPS, "reviewed the evidence and the BAA");

    const view = await wizard().getTenant(ORG);

    expect(view.goLive.attestation).toMatchObject({
      status: "approved",
      approvedByMembershipId: null,
      approvedByLabel: "ChartWarden operations",
      approvalReason: "reviewed the evidence and the BAA",
    });
    expect(view.goLive.attestation?.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(view)).not.toMatch(/ops-m|ops-u/);
  });

  it("a revocation by the tenant's own admin keeps the admin visible; one by an operator does not", async () => {
    settle("organisation", "billing", "locations", "baa_auto");
    state.members.set(...memoryMember(ORG, "co2-m", "co2-u", ["compliance_officer"]));
    state.tenants = [{ ...tenant(), complianceOfficerMembershipId: "co-m" }];
    await wizard().attestGoLive(OFFICER, ORG, undefined);
    await wizard().setComplianceOfficer(ADMIN, ORG, "co2-m"); // voids it as the tenant admin
    expect((await wizard().getTenant(ORG)).goLive.attestation).toMatchObject({
      status: "revoked",
      revokedByMembershipId: "admin-m",
      revokedByLabel: null,
    });

    await wizard().attestGoLive(
      { kind: "tenant", membershipId: "co2-m", userId: "co2-u", roles: ["compliance_officer"] },
      ORG,
      undefined,
    );
    await wizard().revokeGoLive("acme", OPS, "BAA addendum is being renegotiated");
    expect((await wizard().getTenant(ORG)).goLive.attestation).toMatchObject({
      status: "revoked",
      revokedByMembershipId: null,
      revokedByLabel: "ChartWarden operations",
      revokeReason: "BAA addendum is being renegotiated",
    });
  });
});

describe("read model", () => {
  it("returns the ordered steps with lock state, the current step and the go-live state", async () => {
    await wizard().attestPlatform("acme", taskId("organisation"), OPS, evidence);
    const view = await wizard().getTenant(ORG);
    expect(view.steps.map((s) => s.key)).toEqual(TEMPLATES.map((t) => t.key));
    expect(view.currentStepKey).toBe("billing");
    expect(view.steps.find((s) => s.key === "locations")).toMatchObject({
      locked: true,
      lockedBy: "billing",
    });
    expect(view.goLive.state).toBe("not_ready");
    expect(view.orgProfile).toEqual({ displayName: "Acme", orgTimezone: "America/New_York" });
  });
});

// Owner decision D5 (2026-11-06): choosing `outside` auto-skips the billing steps that only matter to a tenant ChartWarden
// transmits for (MAC credentials, payer enrollment) with a SYSTEM reason, through the wizard's own skip path (so the audit and
// the strict sequence hold); switching back to a vendor reopens exactly the steps the system skipped.
describe("choosing outside ChartWarden: the billing steps follow (D5)", () => {
  const SKIP_REASON = "bills outside ChartWarden";
  const BILLING_TEMPLATES: StepTemplate[] = [
    tpl("organisation", 1),
    tpl("clearinghouse_selected", 2, { owner: "either", completionMode: "either" }),
    tpl("mac_configured", 3, { owner: "either", completionMode: "either" }),
    tpl("payer_enrollment", 4, { owner: "either" }),
    tpl("go_live_checklist_complete", 5, { owner: "compliance_officer" }),
  ];
  let choice: "outside" | "vendor" | "none";

  function billingWizard() {
    return createOnboardingWizard({
      runner: createMemoryWizardRunner(state),
      orgProfile: createMemoryOrgProfile(state),
      advance,
      clearinghouseChoice: async () => choice,
      warn: (message) => warnings.push(message),
      now: () => NOW,
    });
  }

  beforeEach(() => {
    choice = "outside";
    const ref = state.tenants[0] as TenantRef;
    state = createMemoryWizardState({
      tenants: [ref],
      templates: BILLING_TEMPLATES,
      tasks: BILLING_TEMPLATES.map((t) => memoryTask(TENANT, t.key)),
      members: state.members,
      baa: new Map([[TENANT, { baaStatus: "executed", expiresOn: "2028-01-01" }]]),
      profiles: new Map([[ORG, { displayName: "Acme", orgTimezone: "America/New_York" }]]),
    });
  });

  it("skips the MAC and payer-enrollment steps with the system reason, once the earlier steps are settled", async () => {
    settle("organisation", "clearinghouse_selected");
    await billingWizard().syncClearinghouseSteps(ORG);
    expect(statusOf("mac_configured")).toBe("skipped");
    expect(statusOf("payer_enrollment")).toBe("skipped");
    expect(statusOf("go_live_checklist_complete")).toBe("pending"); // nothing else is touched
    const skipped = state.tasks.find((t) => t.templateKey === "mac_configured");
    expect(skipped?.completionEvidence.skip).toMatchObject({
      rationale: SKIP_REASON,
      skippedByMembershipId: "system",
    });
    // a second pass changes nothing (idempotent)
    const before = JSON.stringify(state.tasks);
    await billingWizard().syncClearinghouseSteps(ORG);
    expect(JSON.stringify(state.tasks)).toBe(before);
  });

  it("keeps the strict sequence: while an earlier gating step is open nothing is skipped, and it is not an error", async () => {
    settle("organisation"); // clearinghouse_selected is still open
    await expect(billingWizard().syncClearinghouseSteps(ORG)).resolves.toBeUndefined();
    expect(statusOf("mac_configured")).toBe("pending");
    expect(statusOf("payer_enrollment")).toBe("pending");
    // ...and the skip lands as soon as the wizard settles that step (the wizard re-runs the sync after every change)
    settle("clearinghouse_selected");
    await billingWizard()
      .attestPlatform("acme", taskId("go_live_checklist_complete"), OPS, evidence)
      .catch(() => undefined);
    await billingWizard().syncClearinghouseSteps(ORG);
    expect(statusOf("mac_configured")).toBe("skipped");
  });

  it("leaves a step an operator already settled alone, and leaves a tenant that is no longer onboarding alone", async () => {
    settle("organisation", "clearinghouse_selected", "mac_configured");
    await billingWizard().syncClearinghouseSteps(ORG);
    expect(statusOf("mac_configured")).toBe("done");
    expect(statusOf("payer_enrollment")).toBe("skipped");
    state.tenants[0] = { ...(state.tenants[0] as TenantRef), status: "active" };
    const live = state.tasks.map((t) => ({ ...t }));
    state.tasks = state.tasks.map((t) =>
      t.templateKey === "payer_enrollment" ? { ...t, status: "pending" as const } : t,
    );
    await billingWizard().syncClearinghouseSteps(ORG);
    expect(statusOf("payer_enrollment")).toBe("pending");
    void live;
  });

  it("switching back to a vendor reopens ONLY the steps the system skipped", async () => {
    settle("organisation", "clearinghouse_selected");
    await billingWizard().syncClearinghouseSteps(ORG);
    // an operator, not the system, skips another step on its own account
    const idx = state.tasks.findIndex((t) => t.templateKey === "organisation");
    state.tasks[idx] = { ...(state.tasks[idx] as (typeof state.tasks)[number]), status: "skipped" };
    choice = "vendor";
    await billingWizard().syncClearinghouseSteps(ORG);
    expect(statusOf("mac_configured")).toBe("in_progress");
    expect(statusOf("payer_enrollment")).toBe("in_progress");
    expect(statusOf("organisation")).toBe("skipped"); // not ours to reopen
  });

  it("does not reopen a step a person skipped for their own reason, even when the org is back on a vendor", async () => {
    settle("organisation", "clearinghouse_selected");
    await billingWizard().skipPlatform(
      "acme",
      taskId("mac_configured"),
      OPS,
      "carrier handles MAC enrollment",
    );
    choice = "vendor";
    await billingWizard().syncClearinghouseSteps(ORG);
    expect(statusOf("mac_configured")).toBe("skipped");
  });

  it("does nothing while the org has chosen nothing", async () => {
    choice = "none";
    settle("organisation", "clearinghouse_selected");
    await billingWizard().syncClearinghouseSteps(ORG);
    expect(statusOf("mac_configured")).toBe("pending");
  });

  it("runs after every wizard change, so a skip that was waiting on an earlier step lands as soon as it settles", async () => {
    settle("clearinghouse_selected"); // the clearinghouse step is settled; `organisation` (earlier) is open
    await billingWizard().syncClearinghouseSteps(ORG);
    expect(statusOf("mac_configured")).toBe("pending");
    await billingWizard().attestPlatform("acme", taskId("organisation"), OPS, evidence);
    expect(statusOf("organisation")).toBe("done");
    expect(statusOf("mac_configured")).toBe("skipped");
    expect(statusOf("payer_enrollment")).toBe("skipped");
  });
});

// The wizard's rules end to end over the in-memory store: strict sequence, owner role, attestation evidence, re-open,
// skip, compliance-officer assignment, org profile, and the two-party go-live. No database; the live suite repeats the
// load-bearing ones on the real roles.
import { ChartWardenError } from "@chartwarden/types";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformActor, StepTemplate, TenantActor, TenantRef } from "../onboarding/model";
import { createOnboardingWizard } from "../onboarding/wizard-service";
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
    expect(
      await code(wizard().setComplianceOfficerPlatform("acme", OPS, "admin-m", OPS_REASON)),
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
        detail: { previousOfficerMembershipId: "old-officer-m", newOfficerMembershipId: "co-m" },
      },
    ]);
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
          error: "platform database unavailable",
        }),
      );
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

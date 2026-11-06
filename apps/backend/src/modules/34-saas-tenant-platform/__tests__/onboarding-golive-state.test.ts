// The two-party go-live state machine, as pure functions: tenant compliance officer attests readiness, a platform
// operator approves, and only then may the tenant go active - and only if the activation guards pass at that moment.
import type { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  GO_LIVE_ATTESTATION_TTL_DAYS,
  assertAttesterStillValid,
  assertCanApprove,
  assertCanAttest,
  assertCanRevoke,
  assertGuardsPass,
  attestationExpiresAt,
  evaluateGoLiveGuards,
  goLiveStateOf,
} from "../onboarding/go-live";
import type {
  GoLiveAttestation,
  StepTask,
  StepTemplate,
  TaskStatus,
  WizardMember,
} from "../onboarding/model";

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
const task = (templateKey: string, status: TaskStatus): StepTask => ({
  id: `t-${templateKey}`,
  templateKey,
  status,
  assignedToMembershipId: null,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  dueAt: null,
  startedAt: null,
  completedAt: null,
  blockerReason: null,
  evidenceNote: null,
  evidenceRef: null,
  attestedByMembershipId: null,
  attestedByActorKind: null,
  attestedAt: null,
  skipRationale: null,
});
const TEMPLATES = [
  tpl("a", 1),
  tpl("b", 2),
  tpl("sample", 3, { optional: true }),
  tpl("go_live_checklist_complete", 4, { owner: "compliance_officer" }),
];
const NOW = new Date("2026-11-05T00:00:00Z");
const BAA_OK = { baaStatus: "executed", expiresOn: "2027-12-31" };

const att = (over: Partial<GoLiveAttestation> = {}): GoLiveAttestation => ({
  id: "att-1",
  tenantAccountId: "ta",
  status: "pending",
  attestedByMembershipId: "m-co",
  attestedByUserId: "u-co",
  attestedAt: NOW,
  attestationNote: null,
  approvedByMembershipId: null,
  approvedByUserId: null,
  approvedAt: null,
  approvalReason: null,
  revokedByMembershipId: null,
  revokedAt: null,
  revokeReason: null,
  ...over,
});

const code = (fn: () => unknown): { code: string; status: number; details: string[] } => {
  try {
    fn();
  } catch (e) {
    const err = e as ChartWardenError;
    return {
      code: err.code,
      status: err.statusCode,
      details: (err.details ?? []).map((d) => `${d.field}:${d.code}`),
    };
  }
  throw new Error("expected a refusal");
};

describe("evaluateGoLiveGuards", () => {
  it("counts the go-live step itself as the thing being approved, and ignores optional steps", () => {
    const tasks = [
      task("a", "done"),
      task("b", "skipped"),
      task("go_live_checklist_complete", "in_progress"),
    ];
    const g = evaluateGoLiveGuards({ templates: TEMPLATES, tasks, latestBaa: BAA_OK, today: NOW });
    expect(g).toMatchObject({
      canonicalTasksComplete: true,
      baaExecuted: true,
      baaExpiryClearsNinetyDays: true,
    });
  });

  it("fails canonicalTasksComplete while an earlier gating step is open", () => {
    const tasks = [
      task("a", "done"),
      task("b", "pending"),
      task("go_live_checklist_complete", "in_progress"),
    ];
    expect(
      evaluateGoLiveGuards({ templates: TEMPLATES, tasks, latestBaa: BAA_OK, today: NOW })
        .canonicalTasksComplete,
    ).toBe(false);
  });
});

describe("assertGuardsPass", () => {
  it("passes when every guard holds", () => {
    expect(() =>
      assertGuardsPass(
        {
          canonicalTasksComplete: true,
          baaExecuted: true,
          baaExpiryClearsNinetyDays: true,
          tasksCompleted: 1,
          tasksSkipped: 0,
        },
        TEMPLATES,
        [task("a", "done"), task("b", "done")],
      ),
    ).not.toThrow();
  });

  it("lists which guards failed, and which steps are open, in a typed 409", () => {
    const r = code(() =>
      assertGuardsPass(
        {
          canonicalTasksComplete: false,
          baaExecuted: false,
          baaExpiryClearsNinetyDays: false,
          tasksCompleted: 0,
          tasksSkipped: 0,
        },
        TEMPLATES,
        [task("a", "done"), task("b", "pending")],
      ),
    );
    expect(r.code).toBe("ACTIVATION_GUARDS_FAILED");
    expect(r.status).toBe(409);
    expect(r.details).toEqual([
      "guard:canonicalTasksComplete",
      "templateKey:b",
      "guard:baaExecuted",
      "guard:baaExpiryClearsNinetyDays",
    ]);
  });
});

describe("goLiveStateOf", () => {
  const settled = [
    task("a", "done"),
    task("b", "done"),
    task("go_live_checklist_complete", "pending"),
  ];
  const open = [
    task("a", "done"),
    task("b", "pending"),
    task("go_live_checklist_complete", "pending"),
  ];

  it("is not_ready while an earlier gating step is open", () => {
    expect(
      goLiveStateOf({
        tenantStatus: "onboarding",
        templates: TEMPLATES,
        tasks: open,
        attestations: [],
      }),
    ).toBe("not_ready");
  });
  it("is awaiting_attestation once every earlier step is settled", () => {
    expect(
      goLiveStateOf({
        tenantStatus: "onboarding",
        templates: TEMPLATES,
        tasks: settled,
        attestations: [],
      }),
    ).toBe("awaiting_attestation");
  });
  it("is awaiting_approval while an attestation is pending", () => {
    expect(
      goLiveStateOf({
        tenantStatus: "onboarding",
        templates: TEMPLATES,
        tasks: settled,
        attestations: [att()],
      }),
    ).toBe("awaiting_approval");
  });
  it("a revoked attestation sends the tenant back to awaiting_attestation", () => {
    expect(
      goLiveStateOf({
        tenantStatus: "onboarding",
        templates: TEMPLATES,
        tasks: settled,
        attestations: [att({ status: "revoked" })],
      }),
    ).toBe("awaiting_attestation");
  });
  it("is live once the tenant is active, and closed for any other status", () => {
    expect(
      goLiveStateOf({
        tenantStatus: "active",
        templates: TEMPLATES,
        tasks: settled,
        attestations: [att({ status: "approved" })],
      }),
    ).toBe("live");
    expect(
      goLiveStateOf({
        tenantStatus: "suspended",
        templates: TEMPLATES,
        tasks: settled,
        attestations: [],
      }),
    ).toBe("closed");
  });
});

describe("assertCanAttest", () => {
  const settled = [
    task("a", "done"),
    task("b", "done"),
    task("go_live_checklist_complete", "pending"),
  ];
  const base = {
    tenantStatus: "onboarding",
    templates: TEMPLATES,
    tasks: settled,
    attestations: [] as GoLiveAttestation[],
    assignedOfficer: null as string | null,
    actorMembershipId: "m-co",
    now: NOW,
  };

  it("passes for an onboarding tenant whose earlier steps are settled", () => {
    expect(() => assertCanAttest(base)).not.toThrow();
  });
  it("refuses a tenant that is not onboarding", () => {
    expect(code(() => assertCanAttest({ ...base, tenantStatus: "active" })).code).toBe(
      "TENANT_NOT_ONBOARDING",
    );
  });
  it("refuses while an earlier step is open (strict sequence)", () => {
    const tasks = [
      task("a", "done"),
      task("b", "pending"),
      task("go_live_checklist_complete", "pending"),
    ];
    expect(code(() => assertCanAttest({ ...base, tasks })).code).toBe(
      "ONBOARDING_STEP_OUT_OF_ORDER",
    );
  });
  it("refuses a second attestation while one is pending", () => {
    expect(code(() => assertCanAttest({ ...base, attestations: [att()] })).code).toBe(
      "GO_LIVE_ALREADY_ATTESTED",
    );
  });
  it("says an expired pending attestation must be revoked by platform operations, not that it awaits approval", () => {
    const later = new Date(NOW.getTime() + (GO_LIVE_ATTESTATION_TTL_DAYS * 24 * 3600 + 1) * 1000);
    const r = code(() => assertCanAttest({ ...base, attestations: [att()], now: later }));
    expect(r.code).toBe("GO_LIVE_ATTESTATION_EXPIRED");
    expect(r.status).toBe(409);
  });
  it("when an officer is assigned, only that officer may attest", () => {
    const r = code(() => assertCanAttest({ ...base, assignedOfficer: "m-other" }));
    expect(r.code).toBe("GO_LIVE_NOT_ASSIGNED_OFFICER");
    expect(r.status).toBe(403);
    expect(() => assertCanAttest({ ...base, assignedOfficer: "m-co" })).not.toThrow();
  });
});

const OPS = { membershipId: "m-ops", userId: "u-ops" };
const DAY_MS = 24 * 3600 * 1000;

describe("attestationExpiresAt", () => {
  it("is the attestation time plus the named time to live (14 days)", () => {
    expect(GO_LIVE_ATTESTATION_TTL_DAYS).toBe(14);
    expect(attestationExpiresAt(att()).getTime()).toBe(NOW.getTime() + 14 * DAY_MS);
  });
});

describe("assertCanApprove / assertCanRevoke", () => {
  const base = { tenantStatus: "onboarding", attestations: [att()], approver: OPS, now: NOW };

  it("approve without an attestation is refused", () => {
    const r = code(() => assertCanApprove({ ...base, attestations: [] }));
    expect(r.code).toBe("GO_LIVE_NOT_ATTESTED");
    expect(r.status).toBe(409);
  });
  it("approve refuses a revoked attestation and a tenant that is not onboarding", () => {
    expect(
      code(() => assertCanApprove({ ...base, attestations: [att({ status: "revoked" })] })).code,
    ).toBe("GO_LIVE_NOT_ATTESTED");
    expect(code(() => assertCanApprove({ ...base, tenantStatus: "active" })).code).toBe(
      "TENANT_NOT_ONBOARDING",
    );
  });
  it("the approver cannot be the attester's membership", () => {
    const r = code(() =>
      assertCanApprove({ ...base, approver: { membershipId: "m-co", userId: "u-other" } }),
    );
    expect(r.code).toBe("GO_LIVE_SAME_PERSON");
    expect(r.status).toBe(409);
  });
  it("nor the same human holding a different membership (one user, a tenant membership and a platform one)", () => {
    const r = code(() =>
      assertCanApprove({
        ...base,
        approver: { membershipId: "m-ops-of-the-same-person", userId: "u-co" },
      }),
    );
    expect(r.code).toBe("GO_LIVE_SAME_PERSON");
    expect(r.status).toBe(409);
  });
  it("approve returns the pending attestation", () => {
    expect(assertCanApprove(base).id).toBe("att-1");
  });
  it("an attestation is approvable up to exactly 14 days after it was filed, and not a moment later", () => {
    const edge = new Date(NOW.getTime() + 14 * DAY_MS);
    expect(assertCanApprove({ ...base, now: edge }).id).toBe("att-1");
    const r = code(() => assertCanApprove({ ...base, now: new Date(edge.getTime() + 1) }));
    expect(r.code).toBe("GO_LIVE_ATTESTATION_EXPIRED");
    expect(r.status).toBe(409);
  });
  it("revoke needs a pending attestation", () => {
    expect(code(() => assertCanRevoke({ tenantStatus: "onboarding", attestations: [] })).code).toBe(
      "GO_LIVE_NOT_ATTESTED",
    );
    expect(assertCanRevoke({ tenantStatus: "onboarding", attestations: [att()] }).id).toBe("att-1");
  });
});

describe("assertAttesterStillValid", () => {
  const officer: WizardMember = {
    membershipId: "m-co",
    userId: "u-co",
    active: true,
    roleKeys: ["compliance_officer"],
  };
  const base = {
    pending: att(),
    attester: officer,
    assignedOfficer: "m-co" as string | null,
    attesterIsPlatformStaff: false,
  };

  it("passes while the attester is an active member, still a compliance officer, and still the assigned one", () => {
    expect(() => assertAttesterStillValid(base)).not.toThrow();
  });
  it("passes when no officer is assigned (the attester then held the role by itself)", () => {
    expect(() => assertAttesterStillValid({ ...base, assignedOfficer: null })).not.toThrow();
  });
  it.each([
    ["is gone from the organisation", { ...base, attester: null }, "attester_not_active"],
    [
      "is no longer active",
      { ...base, attester: { ...officer, active: false } },
      "attester_not_active",
    ],
    [
      "no longer holds compliance_officer",
      { ...base, attester: { ...officer, roleKeys: ["org_admin"] } },
      "attester_not_compliance_officer",
    ],
    [
      "is no longer the assigned officer",
      { ...base, assignedOfficer: "m-someone-else" },
      "attester_not_assigned_officer",
    ],
    [
      "is ChartWarden platform staff",
      { ...base, attesterIsPlatformStaff: true },
      "attester_platform_staff",
    ],
  ])("refuses when the attester %s", (_label, input, detail) => {
    const r = code(() => assertAttesterStillValid(input));
    expect(r.code).toBe("GO_LIVE_ATTESTATION_STALE");
    expect(r.status).toBe(409);
    expect(r.details).toEqual([`attestation:${detail}`]);
  });
});

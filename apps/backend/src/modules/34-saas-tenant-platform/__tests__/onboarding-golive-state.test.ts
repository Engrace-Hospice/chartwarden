// The two-party go-live state machine, as pure functions: tenant compliance officer attests readiness, a platform
// operator approves, and only then may the tenant go active - and only if the activation guards pass at that moment.
import type { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  assertCanApprove,
  assertCanAttest,
  assertCanRevoke,
  assertGuardsPass,
  evaluateGoLiveGuards,
  goLiveStateOf,
} from "../onboarding/go-live";
import type { GoLiveAttestation, StepTask, StepTemplate, TaskStatus } from "../onboarding/model";

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
  attestedAt: NOW,
  attestationNote: null,
  approvedByMembershipId: null,
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
  it("when an officer is assigned, only that officer may attest", () => {
    const r = code(() => assertCanAttest({ ...base, assignedOfficer: "m-other" }));
    expect(r.code).toBe("GO_LIVE_NOT_ASSIGNED_OFFICER");
    expect(r.status).toBe(403);
    expect(() => assertCanAttest({ ...base, assignedOfficer: "m-co" })).not.toThrow();
  });
});

describe("assertCanApprove / assertCanRevoke", () => {
  it("approve without an attestation is refused", () => {
    const r = code(() =>
      assertCanApprove({
        tenantStatus: "onboarding",
        attestations: [],
        approverMembershipId: "m-ops",
      }),
    );
    expect(r.code).toBe("GO_LIVE_NOT_ATTESTED");
    expect(r.status).toBe(409);
  });
  it("approve refuses a revoked attestation and a tenant that is not onboarding", () => {
    expect(
      code(() =>
        assertCanApprove({
          tenantStatus: "onboarding",
          attestations: [att({ status: "revoked" })],
          approverMembershipId: "m-ops",
        }),
      ).code,
    ).toBe("GO_LIVE_NOT_ATTESTED");
    expect(
      code(() =>
        assertCanApprove({
          tenantStatus: "active",
          attestations: [att()],
          approverMembershipId: "m-ops",
        }),
      ).code,
    ).toBe("TENANT_NOT_ONBOARDING");
  });
  it("the approver cannot be the attester", () => {
    expect(
      code(() =>
        assertCanApprove({
          tenantStatus: "onboarding",
          attestations: [att()],
          approverMembershipId: "m-co",
        }),
      ).code,
    ).toBe("GO_LIVE_SELF_APPROVAL");
  });
  it("approve returns the pending attestation", () => {
    expect(
      assertCanApprove({
        tenantStatus: "onboarding",
        attestations: [att()],
        approverMembershipId: "m-ops",
      }).id,
    ).toBe("att-1");
  });
  it("revoke needs a pending attestation", () => {
    expect(code(() => assertCanRevoke({ tenantStatus: "onboarding", attestations: [] })).code).toBe(
      "GO_LIVE_NOT_ATTESTED",
    );
    expect(assertCanRevoke({ tenantStatus: "onboarding", attestations: [att()] }).id).toBe("att-1");
  });
});

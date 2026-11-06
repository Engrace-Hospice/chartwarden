// The one-line progress of a tenant's onboarding (the hub list's "7 of 13, current step, go-live state"), as a pure function.
// It judges exactly the steps the activation guard judges: canonical, not optional, not retired. A task that belongs to a
// retired template (xero_connected and the like are kept as history) or to a tenant-added step is never part of the count.
import { describe, expect, it } from "vitest";
import type { GoLiveAttestation, StepTask, StepTemplate, TaskStatus } from "../onboarding/model";
import { summarizeOnboarding } from "../onboarding/progress";

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
const TEMPLATES: StepTemplate[] = [
  tpl("org", 1),
  tpl("plan", 2),
  tpl("sample", 3, { optional: true }),
  tpl("custom", 4, { canonical: false }),
  tpl("go_live_checklist_complete", 5, { owner: "compliance_officer" }),
];
const pending = (): GoLiveAttestation => ({
  id: "att-1",
  tenantAccountId: "ta",
  status: "pending",
  attestedByMembershipId: "m-co",
  attestedByUserId: "u-co",
  attestedAt: new Date("2026-11-05T00:00:00Z"),
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

describe("summarizeOnboarding", () => {
  it("counts only the gating steps: optional and tenant-added steps are not part of the total", () => {
    const p = summarizeOnboarding({
      tenantStatus: "onboarding",
      templates: TEMPLATES,
      tasks: [],
      attestations: [],
    });
    expect(p.totalCount).toBe(3);
    expect(p.doneCount).toBe(0);
    expect(p.currentStepKey).toBe("org");
    expect(p.goLiveState).toBe("not_ready");
  });

  it("counts a skipped step as settled, and points at the first gating step that is not", () => {
    const p = summarizeOnboarding({
      tenantStatus: "onboarding",
      templates: TEMPLATES,
      tasks: [
        task("org", "done"),
        task("plan", "skipped"),
        task("go_live_checklist_complete", "pending"),
      ],
      attestations: [],
    });
    expect(p).toMatchObject({
      doneCount: 2,
      totalCount: 3,
      currentStepKey: "go_live_checklist_complete",
      goLiveState: "awaiting_attestation",
    });
  });

  it("ignores a task whose template is not a gating template (retired history, an optional step)", () => {
    const p = summarizeOnboarding({
      tenantStatus: "onboarding",
      templates: TEMPLATES,
      tasks: [task("xero_connected", "done"), task("sample", "done"), task("custom", "done")],
      attestations: [],
    });
    expect(p.doneCount).toBe(0);
    expect(p.totalCount).toBe(3);
  });

  it("reports awaiting_approval while a go-live attestation is pending", () => {
    const p = summarizeOnboarding({
      tenantStatus: "onboarding",
      templates: TEMPLATES,
      tasks: [
        task("org", "done"),
        task("plan", "done"),
        task("go_live_checklist_complete", "pending"),
      ],
      attestations: [pending()],
    });
    expect(p.goLiveState).toBe("awaiting_approval");
  });

  it("is live for an active tenant and closed for any other status", () => {
    const base = { templates: TEMPLATES, tasks: [], attestations: [] };
    expect(summarizeOnboarding({ ...base, tenantStatus: "active" }).goLiveState).toBe("live");
    expect(summarizeOnboarding({ ...base, tenantStatus: "suspended" }).goLiveState).toBe("closed");
    expect(summarizeOnboarding({ ...base, tenantStatus: "provisioning" }).goLiveState).toBe(
      "closed",
    );
  });
});

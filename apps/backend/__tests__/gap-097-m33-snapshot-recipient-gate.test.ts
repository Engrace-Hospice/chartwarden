// M33 recipient-disclosure follow-up: the worker's recipient port narrows by the snapshot's scope.
import { handleScheduledRun } from "@wardenx/reporting";
import { describe, expect, it } from "vitest";
import { gateRecipientsBySnapshotScope } from "../src/modules/33-reporting/jobs/snapshot-recipient-gate";

const ORG = "org-1";
const VIEW = "view-1";
const OWNER = "m-owner";

const harness = (opts: {
  admins: string[] | "throw" | "absent";
  recipients: string[];
  baseDenies?: string[];
}) => {
  const lost: string[] = [];
  const settled: unknown[] = [];
  let rendered = 0;
  const gate = gateRecipientsBySnapshotScope(
    {
      async isRecipientEntitled(id) {
        return !(opts.baseDenies ?? []).includes(id);
      },
    },
    {
      findViewOwner: async () => OWNER,
      adminMemberships:
        opts.admins === "absent"
          ? undefined
          : {
              async adminMembershipIds() {
                if (opts.admins === "throw") throw new Error("boom");
                return new Set(opts.admins as string[]);
              },
            },
    },
  );
  const ports = {
    now: () => new Date("2026-10-04T00:00:00Z"),
    runs: {
      findRun: async () => ({ status: "queued" }),
      settle: async (...a: unknown[]) => void settled.push(a),
    },
    schedules: {
      findById: async () => ({
        id: "s1",
        status: "active",
        reportViewId: VIEW,
        format: "pdf",
        recipientMembershipIds: opts.recipients,
      }),
    },
    recipients: gate,
    snapshot: {
      build: async () => ({
        snapshotQuery: "q",
        viewId: VIEW,
        viewName: "v",
        snapshot: { columns: [], rows: [], rowCount: 0 },
      }),
    },
    outbox: {
      emitRenderRequested: async () => void rendered++,
      emitFailed: async () => undefined,
    },
    audit: {
      recordRecipientLostAccess: async (_s: string, m: string) => void lost.push(m),
      recordAllRecipientsRevoked: async () => undefined,
    },
    pause: { autoPause: async () => undefined },
  };
  const run = () =>
    handleScheduledRun(
      {
        scheduleId: "s1",
        runId: "r1",
        organizationId: ORG,
        scheduledFor: "2026-10-04T00:00:00Z",
      } as any,
      ports as any,
    );
  return { run, lost, rendered: () => rendered };
};

describe("gateRecipientsBySnapshotScope via the runner", () => {
  it("org-scope snapshot: non-admin recipient dropped + audited, admin delivered", async () => {
    const h = harness({ admins: [OWNER, "m-admin"], recipients: ["m-admin", "m-nurse"] });
    const res = await h.run();
    expect(h.lost).toEqual(["m-nurse"]);
    expect(res).toEqual({ kind: "render_requested", recipientCount: 1 });
  });
  it("self-scope snapshot: only owner/admin survive", async () => {
    const h = harness({ admins: ["m-admin"], recipients: [OWNER, "m-admin", "m-x"] });
    const res = await h.run();
    expect(h.lost).toEqual(["m-x"]);
    expect(res).toEqual({ kind: "render_requested", recipientCount: 2 });
  });
  it("fails closed when the admin reader throws (owner scope unknown => all dropped, audited)", async () => {
    const h = harness({ admins: "throw", recipients: [OWNER, "m-x"] });
    const res = await h.run();
    expect(h.lost).toEqual([OWNER, "m-x"]);
    expect(res.kind).toBe("all_recipients_revoked");
  });
  it("no admin reader wired: self scope, only the owner", async () => {
    const h = harness({ admins: "absent", recipients: [OWNER, "m-x"] });
    await h.run();
    expect(h.lost).toEqual(["m-x"]);
  });
  it("base-port denial still drops, and the scope reader is not needed", async () => {
    const h = harness({ admins: [OWNER], recipients: [OWNER], baseDenies: [OWNER] });
    const res = await h.run();
    expect(res.kind).toBe("all_recipients_revoked");
  });
});

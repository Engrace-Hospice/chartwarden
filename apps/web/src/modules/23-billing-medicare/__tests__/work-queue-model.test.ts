// The pure model behind the Billing work queue: claims, NOE/NOTR notices and DDE items become one list of work, a
// notice and the DDE item that files it are ONE row, each source keeps its own status vocabulary, and a source that
// failed or is still paged is never reported as a clean zero.
import { describe, expect, it } from "vitest";
import type { DdeItem } from "../dde-queue-model";
import {
  type ClaimRow,
  type NoticeRow,
  type SourceState,
  buildWorkItems,
  countLabel,
} from "../work-queue-model";

const NOW = new Date("2026-10-25T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

function claim(over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    claimId: "c1",
    patientId: "p1",
    state: "ready",
    tob: "811",
    serviceFrom: "2026-10-01",
    serviceTo: "2026-10-31",
    claimControlNumber: "CCN-1",
    ...over,
  };
}
function notice(over: Partial<NoticeRow> = {}): NoticeRow {
  return {
    id: "n1",
    state: "draft",
    patientId: "p1",
    windowTargetAt: day(1),
    windowBreachedAt: null,
    ...over,
  };
}
function dde(over: Partial<DdeItem> = {}): DdeItem {
  return {
    ddeWorkItemId: "d1",
    patientId: "p1",
    providerEntityId: "e1",
    itemType: "noe",
    subjectKind: "noe_record",
    subjectId: "n1",
    state: "queued",
    attemptNumber: 1,
    assigneeMembershipId: null,
    priority: 0,
    source: "manual",
    deadlineAt: day(1),
    deadlineStatus: "at_risk",
    submittedAt: null,
    macAcceptedOn: null,
    dcn: null,
    rtpReasonCode: null,
    outcomeCode: null,
    notes: null,
    allowedActions: [],
    version: 1,
    createdAt: day(-1),
    ...over,
  };
}
const build = (parts: Partial<Parameters<typeof buildWorkItems>[0]> = {}) =>
  buildWorkItems({ claims: [], noe: [], notr: [], dde: [], ...parts }, NOW);

describe("claims", () => {
  it("lists claims that need a person, with the next step for their state", () => {
    const items = build({
      claims: [
        claim({ claimId: "a", state: "draft" }),
        claim({ claimId: "b", state: "ready" }),
        claim({ claimId: "c", state: "denied" }),
      ],
    });
    expect(items.map((i) => [i.key, i.nextAction])).toEqual(
      expect.arrayContaining([
        ["claim:a", "Complete the claim"],
        ["claim:b", "Submit the claim"],
        ["claim:c", "Review the denial"],
      ]),
    );
    expect(items.find((i) => i.key === "claim:b")?.href).toBe("/billing/claims/b");
  });

  it("leaves claims alone that are in flight or finished", () => {
    const items = build({
      claims: ["submitted", "ack_pending", "ack_accepted", "paid", "voided", "replaced"].map((s) =>
        claim({ claimId: s, state: s }),
      ),
    });
    expect(items).toEqual([]);
  });
});

describe("notices", () => {
  it("takes the deadline from the record and ranks at-risk and breached ahead of the rest", () => {
    const items = build({
      noe: [
        notice({ id: "later", windowTargetAt: day(10) }),
        notice({ id: "soon", windowTargetAt: day(1) }),
        notice({ id: "late", windowTargetAt: day(-3) }),
      ],
    });
    expect(items.map((i) => [i.key, i.urgency])).toEqual([
      ["noe:late", "overdue"],
      ["noe:soon", "at_risk"],
      ["noe:later", "on_track"],
    ]);
  });

  it("treats a record the server flagged breached as overdue whatever the clock says", () => {
    const [item] = build({
      noe: [notice({ windowTargetAt: day(5), windowBreachedAt: day(-1) })],
    });
    expect(item?.urgency).toBe("overdue");
  });

  it("drops accepted and cancelled notices, keeps rejected ones for correction", () => {
    const items = build({
      noe: [
        notice({ id: "a", state: "accepted" }),
        notice({ id: "b", state: "ack_accepted" }),
        notice({ id: "c", state: "cancelled" }),
        notice({ id: "d", state: "rejected" }),
      ],
    });
    expect(items.map((i) => [i.key, i.nextAction])).toEqual([["noe:d", "Correct and resubmit"]]);
  });

  it("keeps NOE and NOTR with the same id apart", () => {
    const items = build({ noe: [notice({ id: "x" })], notr: [notice({ id: "x" })] });
    expect(items.map((i) => i.key).sort()).toEqual(["noe:x", "notr:x"]);
  });
});

describe("DDE items", () => {
  it("is one row with its notice, and the row's next step is the DDE step", () => {
    const items = build({ noe: [notice()], dde: [dde()] });
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("noe");
    expect(items[0]?.dde?.id).toBe("d1");
    expect(items[0]?.href).toBe("/billing/dde?item=d1");
    expect(items[0]?.subjectHref).toBe("/billing/noe/n1");
    expect(items[0]?.nextAction).toBe("Claim it and key it in DDE");
  });

  it("stands alone when its subject is not in the loaded notices", () => {
    const items = build({ dde: [dde({ subjectId: "elsewhere" })] });
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("dde");
    expect(items[0]?.what).toBe("NOE");
  });

  it("merges a claim-entry item into its claim", () => {
    const items = build({
      claims: [claim({ claimId: "c9", state: "ready" })],
      dde: [dde({ itemType: "claim_entry", subjectKind: "claim", subjectId: "c9" })],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("claim:c9");
    expect(items[0]?.dde?.id).toBe("d1");
  });

  it("skips closed, cancelled and accepted items", () => {
    const items = build({
      dde: ["closed", "cancelled", "accepted"].map((s, n) =>
        dde({ ddeWorkItemId: s, subjectId: `s${n}`, state: s as DdeItem["state"] }),
      ),
    });
    expect(items).toEqual([]);
  });

  it("says who filed it only once a submission is recorded", () => {
    const rows = build({
      dde: [
        dde({ ddeWorkItemId: "q", subjectId: "q", state: "queued" }),
        dde({ ddeWorkItemId: "m", subjectId: "m", state: "submitted", submissionMode: "manual" }),
        dde({ ddeWorkItemId: "p", subjectId: "p", state: "submitted", submissionMode: "provider" }),
      ],
    });
    const via = Object.fromEntries(rows.map((r) => [r.dde?.id, r.dde?.viaProvider]));
    expect(via).toEqual({ q: null, m: false, p: true });
  });

  it("flags an in-doubt provider send on the row", () => {
    const [item] = build({
      dde: [dde({ state: "in_progress", submissionMode: "provider", providerInDoubt: true })],
    });
    expect(item?.dde?.inDoubt).toBe(true);
  });

  it("never turns a keyed-but-unaccepted notice into a met deadline", () => {
    const [item] = build({
      dde: [dde({ state: "submitted", submissionMode: "manual", deadlineStatus: "at_risk" })],
    });
    expect(item?.urgency).toBe("at_risk");
    expect(item?.nextAction).toBe("Record the MAC answer");
  });
});

describe("source counts", () => {
  const ok = (n: number, hasMore = false): SourceState<number> => ({
    status: "ok",
    items: Array.from({ length: n }, (_, i) => i),
    hasMore,
  });
  it("shows the number when the source is whole", () => {
    expect(countLabel(ok(3), 3)).toBe("3");
    expect(countLabel(ok(0), 0)).toBe("0");
  });
  it("shows N+ when the source has more pages", () => {
    expect(countLabel(ok(50, true), 50)).toBe("50+");
  });
  it("never shows 0 for a source that failed, was denied, or is loading", () => {
    for (const status of ["error", "denied", "loading"] as const)
      expect(countLabel({ status } as SourceState<number>, 0)).toBe("—");
  });
});

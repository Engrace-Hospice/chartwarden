// M23 — the 999 / 277CA acknowledgment crons route a NOE's or NOTR's acknowledgment to the notice.
//
// Before: `runAckPull999` / `runAckPull277ca` special-cased only `claim_submission.kind = 'transfer_notice'`;
// every other ack went down the claim path — appended to `claim_acknowledgment` with no claim, then
// `claims.findById` returned null and the job returned. A rejected NOE looked valid, a rejected NOTR counted as
// filed, no acceptance date was ever recorded and no biller was told.
//
// No database: the repositories are in-memory fakes that honour the contracts the routing depends on (the
// idempotent `(mac_jurisdiction, ack_file_uri)` append, the version-checked transition). Every outbox payload is
// checked against the real catalog schema — the same Value.Check the catalog-validating publisher runs.
import { Value } from "@sinclair/typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const fakes = vi.hoisted(() => ({
  submissions: new Map<string, Record<string, unknown>>(),
  noes: new Map<string, Record<string, unknown>>(),
  notrs: new Map<string, Record<string, unknown>>(),
  claims: new Map<string, Record<string, unknown>>(),
  acks: [] as Record<string, unknown>[],
}));

vi.mock("@wardenx/billing", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const repos = original.repositories as Record<string, unknown>;
  const versioned = (table: Map<string, Row>) =>
    class {
      findById = async (id: string) => table.get(id) ?? null;
      transitionToState = async (id: string, expected: number, state: string, patch: Row = {}) => {
        const row = table.get(id);
        if (!row || row.version !== expected) {
          return { ok: false, code: "VERSION_CONFLICT", currentVersion: row?.version ?? null };
        }
        const next = { ...row, ...patch, state, version: expected + 1 };
        table.set(id, next);
        return { ok: true, row: next };
      };
    };
  class ClaimSubmissionRepository {
    findById = async (id: string) => fakes.submissions.get(id) ?? null;
  }
  class ClaimAcknowledgmentRepository {
    append = async (values: Row) => {
      const existing = fakes.acks.find(
        (a) => a.macJurisdiction === values.macJurisdiction && a.ackFileUri === values.ackFileUri,
      );
      if (existing) return existing;
      const row = { id: `ack-${fakes.acks.length + 1}`, ...values };
      fakes.acks.push(row);
      return row;
    };
    listForSubmission = async (submissionId: string) =>
      fakes.acks.filter((a) => a.submissionId === submissionId).reverse();
  }
  return {
    ...original,
    repositories: {
      ...repos,
      ClaimSubmissionRepository,
      ClaimAcknowledgmentRepository,
      NoeRepository: versioned(fakes.noes),
      NotrRepository: versioned(fakes.notrs),
      ClaimRepository: versioned(fakes.claims),
    },
  };
});

vi.mock("@wardenx/tenancy", () => ({
  withOrgContext: async (
    _db: unknown,
    _ctx: { organizationId: string; userId: string },
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn({ transaction: async (inner: (sp: unknown) => Promise<unknown>) => inner({}) }),
}));

import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/events-by-m23";
import {
  type M23WorkerDeps,
  type Parsed277ca,
  type Parsed999,
  runAckPull277ca,
  runAckPull999,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { applyNoticeAck } from "../src/modules/23-billing-medicare/jobs/notice-ack-jobs";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const PE = "00000000-0000-4000-8000-0000000000e1";
const ADMISSION = "00000000-0000-4000-8000-0000000000d1";
const RECEIVED = new Date("2026-10-06T15:30:00.000Z");
const MAC = "ngs_j6";

type Published = { eventName: string; payload: Record<string, unknown>; aggregateId: string };
type Alert = { alertCode: string; severity: string; organizationId: string; payload: Row };

function catalogAccepts(event: Published): boolean {
  const def = M23_OUTBOX_EVENTS.find((e) => e.eventName === event.eventName);
  if (!def) throw new Error(`no catalog entry for ${event.eventName}`);
  return Value.Check(def.payloadSchema as never, event.payload);
}

function harness() {
  const published: Published[] = [];
  const alerts: Alert[] = [];
  let files999: Parsed999[] = [];
  let files277: Parsed277ca[] = [];
  const deps = {
    connection: {} as never,
    db: {} as never,
    now: () => RECEIVED,
    outbox: {
      publish: async (_tx: unknown, input: Published) => {
        published.push(input);
      },
    },
    alerts: {
      dispatch: async (a: Alert) => {
        alerts.push(a);
      },
    },
    x12: {
      generate837i: async () => ({ x12: "", correlationId: "" }),
      generateNoe: async () => ({ x12: "", correlationId: "" }),
      generateNotr: async () => ({ x12: "", correlationId: "" }),
      parse999: async () => files999,
      parse277ca: async () => files277,
    },
    macPortal: {
      upload: async () => ({ accepted: true, generatedFileUri: "" }),
      pullPending999: async () => [{ rawFileUri: "s3://acks/999.x12" }],
      pullPending277ca: async () => [{ rawFileUri: "s3://acks/277.x12" }],
      probeHealth: async () => true,
    },
    jurisdictions: { listJurisdictions: async () => [{ macJurisdiction: MAC }] },
  } as unknown as M23WorkerDeps;
  return {
    deps,
    published,
    alerts,
    set999: (r: Parsed999[]) => {
      files999 = r;
    },
    set277: (r: Parsed277ca[]) => {
      files277 = r;
    },
  };
}

const ack999 = (submissionId: string, accepted: boolean, over: Partial<Parsed999> = {}) =>
  ({
    organizationId: ORG,
    claimId: "",
    submissionId,
    claimControlNumber: "CTL-1",
    accepted,
    reasonCodes: accepted ? [] : ["IK5:R", "IK3:8"],
    ackFileUri: `s3://acks/999/${submissionId}-${accepted ? "a" : "r"}.json`,
    ...over,
  }) satisfies Parsed999;

const ack277 = (
  submissionId: string,
  outcome: Parsed277ca["outcome"],
  over: Partial<Parsed277ca> = {},
) =>
  ({
    organizationId: ORG,
    claimId: "",
    submissionId,
    outcome,
    payerClaimControlNumber: "PAYER-778",
    reasonCodes: outcome === "accepted" ? [] : ["A7:21", "A7:562"],
    ackFileUri: `s3://acks/277/${submissionId}-${outcome}.json`,
    ...over,
  }) satisfies Parsed277ca;

beforeEach(() => {
  fakes.submissions.clear();
  fakes.noes.clear();
  fakes.notrs.clear();
  fakes.claims.clear();
  fakes.acks.length = 0;
});

// ── NOE and NOTR route identically; only the table, the pointer and the event family differ ──────────────────
const KINDS = [
  {
    kind: "noe" as const,
    table: () => fakes.noes,
    pointer: "noeId",
    payerColumn: "payerNoeControlNumber",
    idKey: "noeId",
  },
  {
    kind: "notr" as const,
    table: () => fakes.notrs,
    pointer: "notrId",
    payerColumn: "payerNotrControlNumber",
    idKey: "notrId",
  },
];

describe.each(KINDS)("$kind acknowledgments", ({ kind, table, pointer, payerColumn, idKey }) => {
  const NOTICE = `notice-${kind}`;
  const SUB = `sub-${kind}`;

  function seed(state: string) {
    table().set(NOTICE, {
      id: NOTICE,
      organizationId: ORG,
      providerEntityId: PE,
      admissionId: ADMISSION,
      state,
      version: 3,
      latestSubmissionId: SUB,
      latestAcknowledgmentId: null,
    });
    fakes.submissions.set(SUB, {
      id: SUB,
      organizationId: ORG,
      kind,
      claimId: null,
      [pointer]: NOTICE,
    });
  }
  const notice = () => table().get(NOTICE) as Row;

  it("999 accepted: SUBMITTED → ACK_PENDING, the ack recorded against the notice (no claim), nothing alerted", async () => {
    seed("submitted");
    const h = harness();
    h.set999([ack999(SUB, true)]);

    await runAckPull999(h.deps);

    expect(notice()).toMatchObject({ state: "ack_pending", latestAcknowledgmentId: "ack-1" });
    expect(notice().acceptedAt ?? null).toBeNull();
    expect(notice().rejectedAt ?? null).toBeNull();
    expect(fakes.acks).toHaveLength(1);
    expect(fakes.acks[0]).toMatchObject({
      submissionId: SUB,
      claimId: null,
      kind: "ack_999",
      outcomeStatus: "accepted",
    });
    expect(fakes.acks[0]?.parsedPayload).toMatchObject({ [idKey]: NOTICE });
    expect(h.published).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it("999 rejected: SUBMITTED → ACK_REJECTED with the stage, timestamp and codes; emits .rejected and alerts the billers", async () => {
    seed("submitted");
    const h = harness();
    h.set999([ack999(SUB, false)]);

    await runAckPull999(h.deps);

    expect(notice()).toMatchObject({
      state: "ack_rejected",
      rejectedAt: RECEIVED,
      rejectionStage: "999",
      rejectionCodes: ["IK5:R", "IK3:8"],
      latestAcknowledgmentId: "ack-1",
    });
    expect(notice().acceptedAt ?? null).toBeNull();
    expect(fakes.acks[0]).toMatchObject({ claimId: null, outcomeStatus: "rejected" });

    expect(h.published).toHaveLength(1);
    const [event] = h.published;
    expect(event?.eventName).toBe(`m23.${kind}.rejected`);
    expect(event?.aggregateId).toBe(NOTICE);
    expect(event?.payload).toMatchObject({
      [idKey]: NOTICE,
      acknowledgmentId: "ack-1",
      rejectionStage: "999",
      rejectionCodes: ["IK5:R", "IK3:8"],
      rejectedAt: RECEIVED.toISOString(),
    });
    expect(catalogAccepts(event as Published)).toBe(true);

    expect(h.alerts).toEqual([
      {
        alertCode: `m23.${kind}.rejected`,
        severity: "critical",
        organizationId: ORG,
        payload: {
          [idKey]: NOTICE,
          providerEntityId: PE,
          admissionId: ADMISSION,
          rejectionStage: "999",
          rejectionCodes: ["IK5:R", "IK3:8"],
        },
      },
    ]);
  });

  it("277CA accepted: ACK_PENDING → ACK_ACCEPTED with the acceptance date and the payer control number; emits .accepted", async () => {
    seed("ack_pending");
    const h = harness();
    h.set277([ack277(SUB, "accepted")]);

    await runAckPull277ca(h.deps);

    expect(notice()).toMatchObject({
      state: "ack_accepted",
      acceptedAt: RECEIVED,
      [payerColumn]: "PAYER-778",
      latestAcknowledgmentId: "ack-1",
    });
    expect(notice().rejectedAt ?? null).toBeNull();
    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.eventName).toBe(`m23.${kind}.accepted`);
    expect(h.published[0]?.payload).toMatchObject({
      [idKey]: NOTICE,
      acknowledgmentId: "ack-1",
      acceptedAt: RECEIVED.toISOString(),
    });
    expect(catalogAccepts(h.published[0] as Published)).toBe(true);
    expect(h.alerts).toEqual([]);
  });

  it("277CA rejected: ACK_PENDING → ACK_REJECTED (stage 277ca); emits .rejected and alerts", async () => {
    seed("ack_pending");
    const h = harness();
    h.set277([ack277(SUB, "rejected")]);

    await runAckPull277ca(h.deps);

    expect(notice()).toMatchObject({
      state: "ack_rejected",
      rejectedAt: RECEIVED,
      rejectionStage: "277ca",
      rejectionCodes: ["A7:21", "A7:562"],
    });
    expect(h.published.map((e) => e.eventName)).toEqual([`m23.${kind}.rejected`]);
    expect(catalogAccepts(h.published[0] as Published)).toBe(true);
    expect(h.alerts.map((a) => a.alertCode)).toEqual([`m23.${kind}.rejected`]);
  });

  it("277CA partial: a notice has no lines, so a partial acceptance is a rejection", async () => {
    seed("ack_pending");
    const h = harness();
    h.set277([ack277(SUB, "partial")]);

    await runAckPull277ca(h.deps);

    expect(notice()).toMatchObject({ state: "ack_rejected", rejectionStage: "277ca" });
    expect(fakes.acks[0]).toMatchObject({ outcomeStatus: "rejected" });
    expect(h.published.map((e) => e.eventName)).toEqual([`m23.${kind}.rejected`]);
  });

  it("a re-pulled ack is a no-op: one ack row, one transition, one event, one alert", async () => {
    seed("submitted");
    const h = harness();
    h.set999([ack999(SUB, false)]);

    await runAckPull999(h.deps);
    const afterFirst = { ...notice() };
    await runAckPull999(h.deps);

    expect(fakes.acks).toHaveLength(1);
    expect(notice()).toEqual(afterFirst);
    expect(h.published).toHaveLength(1);
    expect(h.alerts).toHaveLength(1);
  });

  it("an ack that does not fit the notice's state is kept in the audit trail but drives nothing", async () => {
    // A 277CA acceptance for a notice whose 999 has not been processed: no SUBMITTED → ACK_ACCEPTED edge.
    seed("submitted");
    const h = harness();
    h.set277([ack277(SUB, "accepted")]);

    await runAckPull277ca(h.deps);

    expect(fakes.acks).toHaveLength(1);
    expect(notice()).toMatchObject({ state: "submitted", version: 3 });
    expect(h.published).toEqual([]);
  });

  it("a 277CA that arrived before its 999 is applied when the 999 accepts the notice", async () => {
    seed("submitted");
    const h = harness();
    h.set277([ack277(SUB, "rejected")]);
    await runAckPull277ca(h.deps);
    expect(notice()).toMatchObject({ state: "submitted" });

    h.set999([ack999(SUB, true)]);
    await runAckPull999(h.deps);

    expect(notice()).toMatchObject({
      state: "ack_rejected",
      rejectionStage: "277ca",
      rejectionCodes: ["A7:21", "A7:562"],
      latestAcknowledgmentId: "ack-1",
    });
    expect(h.published.map((e) => e.eventName)).toEqual([`m23.${kind}.rejected`]);
    expect(h.alerts).toHaveLength(1);
  });

  it("only code-shaped reason codes reach the notice, the event and the alert (no free text, no PHI)", async () => {
    seed("submitted");
    const h = harness();
    h.set999([
      ack999(SUB, false, {
        reasonCodes: [
          "IK5:R",
          "Smith, John DOB 01/02/1950",
          "ik3:8",
          "IK5:R",
          "1EG4TE5MK73", // MBI-shaped
          "1245319599", // NPI-shaped
          "x".repeat(40),
        ],
      }),
    ]);

    await runAckPull999(h.deps);

    expect(notice().rejectionCodes).toEqual(["IK5:R", "IK3:8"]);
    expect(h.published[0]?.payload.rejectionCodes).toEqual(["IK5:R", "IK3:8"]);
    expect(h.alerts[0]?.payload.rejectionCodes).toEqual(["IK5:R", "IK3:8"]);
    expect(JSON.stringify(fakes.acks[0])).not.toContain("Smith");
  });
});

describe("routing", () => {
  it("an ack for an unknown submission is skipped (nothing appended) and the rest of the file is still processed", async () => {
    fakes.noes.set("noe-1", {
      id: "noe-1",
      organizationId: ORG,
      providerEntityId: PE,
      admissionId: ADMISSION,
      state: "submitted",
      version: 0,
    });
    fakes.submissions.set("sub-noe", {
      id: "sub-noe",
      organizationId: ORG,
      kind: "noe",
      noeId: "noe-1",
    });
    const h = harness();
    h.set999([ack999("sub-unknown", false), ack999("sub-noe", true)]);

    await runAckPull999(h.deps);

    expect(fakes.acks.map((a) => a.submissionId)).toEqual(["sub-noe"]);
    expect(fakes.noes.get("noe-1")?.state).toBe("ack_pending");
    expect(h.published).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it("one failing ack does not stop the rest of the file; the run still fails loudly afterwards", async () => {
    fakes.noes.set("noe-1", {
      id: "noe-1",
      organizationId: ORG,
      providerEntityId: PE,
      admissionId: ADMISSION,
      state: "submitted",
      version: 0,
    });
    fakes.submissions.set("sub-noe", {
      id: "sub-noe",
      organizationId: ORG,
      kind: "noe",
      noeId: "noe-1",
    });
    fakes.notrs.set("notr-1", {
      id: "notr-1",
      organizationId: ORG,
      providerEntityId: PE,
      admissionId: ADMISSION,
      state: "submitted",
      version: 0,
    });
    fakes.submissions.set("sub-notr", {
      id: "sub-notr",
      organizationId: ORG,
      kind: "notr",
      notrId: "notr-1",
    });
    const h = harness();
    // The NOE's rejection alert fails (M36 down) …
    (h.deps as unknown as { alerts: { dispatch: () => Promise<void> } }).alerts.dispatch =
      async () => {
        throw new Error("M36 unavailable");
      };
    h.set999([ack999("sub-noe", false), ack999("sub-notr", true)]);

    await expect(runAckPull999(h.deps)).rejects.toThrow(/1 of 2 acknowledgment/);
    // … the NOTR behind it was still applied.
    expect(fakes.notrs.get("notr-1")?.state).toBe("ack_pending");
  });

  it("a NOE submission whose notice row is gone records nothing and drives nothing", async () => {
    fakes.submissions.set("sub-orphan", {
      id: "sub-orphan",
      organizationId: ORG,
      kind: "noe",
      noeId: "noe-gone",
    });
    const h = harness();
    h.set999([ack999("sub-orphan", false)]);

    await runAckPull999(h.deps);

    expect(fakes.acks).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it("a claim's 999 rejection still drives the claim, with a catalog-valid m23.claim.rejected", async () => {
    fakes.claims.set("claim-1", { id: "claim-1", state: "submitted", version: 2 });
    fakes.submissions.set("sub-claim", {
      id: "sub-claim",
      organizationId: ORG,
      kind: "claim_837i",
      claimId: "claim-1",
    });
    const h = harness();
    h.set999([ack999("sub-claim", false, { claimId: "claim-1" })]);

    await runAckPull999(h.deps);

    expect(fakes.claims.get("claim-1")?.state).toBe("ack_rejected");
    expect(fakes.acks[0]).toMatchObject({ claimId: "claim-1", outcomeStatus: "rejected" });
    expect(h.published.map((e) => e.eventName)).toEqual(["m23.claim.rejected"]);
    expect(h.published[0]?.payload).toMatchObject({
      claimId: "claim-1",
      rejectionStage: "999",
      rejectionCodes: ["IK5:R", "IK3:8"],
    });
    expect(catalogAccepts(h.published[0] as Published)).toBe(true);
  });

  it("a clearinghouse-stage claim accept stays ack_pending, stamps clearinghouse_accepted_at and emits nothing", async () => {
    fakes.claims.set("claim-1", { id: "claim-1", state: "submitted", version: 2 });
    fakes.submissions.set("sub-claim", {
      id: "sub-claim",
      organizationId: ORG,
      kind: "claim_837i",
      claimId: "claim-1",
    });
    const h = harness();
    h.set999([ack999("sub-claim", true, { claimId: "claim-1", stage: "clearinghouse" })]);

    await runAckPull999(h.deps);

    expect(fakes.claims.get("claim-1")).toMatchObject({
      state: "ack_pending",
      clearinghouseAcceptedAt: RECEIVED,
    });
    expect(fakes.acks[0]).toMatchObject({ stage: "clearinghouse", outcomeStatus: "accepted" });
    expect(h.published).toEqual([]);
  });

  it("a clearinghouse-stage claim rejection says so in the catalog-valid event", async () => {
    fakes.claims.set("claim-1", { id: "claim-1", state: "submitted", version: 2 });
    fakes.submissions.set("sub-claim", {
      id: "sub-claim",
      organizationId: ORG,
      kind: "claim_837i",
      claimId: "claim-1",
    });
    const h = harness();
    h.set999([ack999("sub-claim", false, { claimId: "claim-1", stage: "clearinghouse" })]);

    await runAckPull999(h.deps);

    expect(h.published[0]?.payload).toMatchObject({ rejectionStage: "clearinghouse" });
    expect(catalogAccepts(h.published[0] as Published)).toBe(true);
  });

  it.each([
    ["accepted", "ack_accepted", "m23.claim.acknowledged"],
    ["rejected", "ack_rejected", "m23.claim.rejected"],
    ["partial", "ack_partial", "m23.claim.acknowledgment_partial"],
  ] as const)(
    "a claim's 277CA %s drives the claim with a catalog-valid event",
    async (outcome, state, eventName) => {
      fakes.claims.set("claim-1", { id: "claim-1", state: "ack_pending", version: 2 });
      fakes.submissions.set("sub-claim", {
        id: "sub-claim",
        organizationId: ORG,
        kind: "claim_837i",
        claimId: "claim-1",
      });
      const h = harness();
      h.set277([ack277("sub-claim", outcome, { claimId: "claim-1" })]);

      await runAckPull277ca(h.deps);

      expect(fakes.claims.get("claim-1")?.state).toBe(state);
      expect(h.published.map((e) => e.eventName)).toEqual([eventName]);
      expect(catalogAccepts(h.published[0] as Published)).toBe(true);
    },
  );
});

// ── Medicare's own date for the answer (migration 0378): STC02 / GS04 / ISA09, else our receipt date ─────────
describe.each(KINDS)("$kind payer status date", ({ kind, table, pointer, idKey }) => {
  const NOTICE = `dated-${kind}`;
  const SUB = `dated-sub-${kind}`;
  function seed(state: string) {
    table().set(NOTICE, {
      id: NOTICE,
      organizationId: ORG,
      providerEntityId: PE,
      admissionId: ADMISSION,
      state,
      version: 1,
      latestSubmissionId: SUB,
      latestAcknowledgmentId: null,
    });
    fakes.submissions.set(SUB, {
      id: SUB,
      organizationId: ORG,
      kind,
      claimId: null,
      [pointer]: NOTICE,
    });
  }
  const notice = () => table().get(NOTICE) as Row;

  it("277CA accepted: stamps the STC02 status effective date, keeps accepted_at as our receipt time", async () => {
    seed("ack_pending");
    const h = harness();
    h.set277([ack277(SUB, "accepted", { statusEffectiveDate: "2026-10-05" })]);
    await runAckPull277ca(h.deps);
    expect(notice()).toMatchObject({
      state: "ack_accepted",
      acceptedAt: RECEIVED,
      payerStatusDate: "2026-10-05",
      payerStatusDateSource: "277ca_stc02",
    });
    expect(h.published[0]?.payload).toMatchObject({
      [idKey]: NOTICE,
      payerStatusDate: "2026-10-05",
      payerStatusDateSource: "277ca_stc02",
    });
    expect(catalogAccepts(h.published[0] as Published)).toBe(true);
  });

  it("999 rejected: stamps the 999's GS04, else its ISA09", async () => {
    seed("submitted");
    const h = harness();
    h.set999([
      ack999(SUB, false, { functionalGroupDate: "2026-10-04", interchangeDate: "2026-10-03" }),
    ]);
    await runAckPull999(h.deps);
    expect(notice()).toMatchObject({
      payerStatusDate: "2026-10-04",
      payerStatusDateSource: "999_gs04",
    });
    expect(catalogAccepts(h.published[0] as Published)).toBe(true);

    fakes.acks.length = 0;
    seed("submitted");
    const h2 = harness();
    h2.set999([
      ack999(SUB, false, { interchangeDate: "2026-10-03", ackFileUri: "s3://acks/999/isa.json" }),
    ]);
    await runAckPull999(h2.deps);
    expect(notice()).toMatchObject({
      payerStatusDate: "2026-10-03",
      payerStatusDateSource: "999_isa09",
    });
  });

  it("no payer date on the ack: falls back to our receipt date, flagged as such", async () => {
    seed("ack_pending");
    const h = harness();
    h.set277([ack277(SUB, "rejected")]);
    await runAckPull277ca(h.deps);
    expect(notice()).toMatchObject({
      payerStatusDate: RECEIVED.toISOString().slice(0, 10),
      payerStatusDateSource: "receipt",
    });
  });

  it("a 999 acceptance stamps no payer date (it is not Medicare's answer yet)", async () => {
    seed("submitted");
    const h = harness();
    h.set999([ack999(SUB, true, { functionalGroupDate: "2026-10-04" })]);
    await runAckPull999(h.deps);
    expect(notice().state).toBe("ack_pending");
    expect(notice().payerStatusDate ?? null).toBeNull();
  });

  it("a 277CA that arrived before its 999 keeps its STC02 when applied later", async () => {
    seed("submitted");
    const h = harness();
    h.set277([ack277(SUB, "accepted", { statusEffectiveDate: "2026-10-02" })]);
    await runAckPull277ca(h.deps);
    expect(notice().state).toBe("submitted");
    h.set999([ack999(SUB, true)]);
    await runAckPull999(h.deps);
    expect(notice()).toMatchObject({
      state: "ack_accepted",
      payerStatusDate: "2026-10-02",
      payerStatusDateSource: "277ca_stc02",
    });
  });
});

// ── Ack stage (ADR-0053 D2): a clearinghouse answers before the payer and must never look like payer acceptance ──
describe.each(KINDS)("$kind ack stage", ({ kind, table, pointer }) => {
  const NOTICE = `stage-${kind}`;
  const SUB = `stage-sub-${kind}`;
  const published: Published[] = [];
  const alerts: Alert[] = [];
  const ports = {
    outbox: {
      publish: async (_tx: unknown, input: Published) => {
        published.push(input);
      },
    },
    alerts: {
      dispatch: async (a: Alert) => {
        alerts.push(a);
      },
    },
  } as never;
  const submission = {
    id: SUB,
    kind,
    noeId: kind === "noe" ? NOTICE : null,
    notrId: kind === "notr" ? NOTICE : null,
  };
  const seed = (state: string) => {
    published.length = 0;
    alerts.length = 0;
    table().set(NOTICE, {
      id: NOTICE,
      organizationId: ORG,
      providerEntityId: PE,
      admissionId: ADMISSION,
      state,
      version: 1,
      latestSubmissionId: SUB,
      latestAcknowledgmentId: null,
    });
    fakes.submissions.set(SUB, {
      id: SUB,
      organizationId: ORG,
      kind,
      claimId: null,
      [pointer]: NOTICE,
    });
  };
  const ack = (over: Record<string, unknown>) => ({
    organizationId: ORG,
    kind: "ack_999" as const,
    outcome: "accepted" as const,
    payerControlNumber: null,
    reasonCodes: [] as string[],
    macJurisdiction: MAC,
    ackFileUri: `s3://acks/${kind}-${Math.random()}.json`,
    receivedAt: RECEIVED,
    ...over,
  });
  const row = () => table().get(NOTICE) as Row;

  it("a clearinghouse-stage accept records the stage and stamps clearinghouse_accepted_at, never ack_accepted or a payer date", async () => {
    seed("submitted");
    await applyNoticeAck({} as never, ports, submission, ack({ stage: "clearinghouse" }));

    expect(row()).toMatchObject({ state: "ack_pending", clearinghouseAcceptedAt: RECEIVED });
    expect(row().acceptedAt ?? null).toBeNull();
    expect(row().payerStatusDate ?? null).toBeNull();
    expect(fakes.acks.at(-1)).toMatchObject({ stage: "clearinghouse", outcomeStatus: "accepted" });
    expect(published).toEqual([]);
  });

  it("a payer-stage accept after it is the only thing that reaches ack_accepted, and keeps the clearinghouse stamp", async () => {
    seed("submitted");
    await applyNoticeAck({} as never, ports, submission, ack({ stage: "clearinghouse" }));
    await applyNoticeAck(
      {} as never,
      ports,
      submission,
      ack({ kind: "ack_277ca", stage: "payer", payerControlNumber: "PAYER-1" }),
    );

    expect(row()).toMatchObject({
      state: "ack_accepted",
      clearinghouseAcceptedAt: RECEIVED,
      acceptedAt: RECEIVED,
    });
    expect(fakes.acks.at(-1)).toMatchObject({ stage: "payer" });
  });

  it("a clearinghouse-stage rejection is stamped rejection_stage 'clearinghouse' and the event says so (catalog-valid)", async () => {
    seed("submitted");
    await applyNoticeAck(
      {} as never,
      ports,
      submission,
      ack({ stage: "clearinghouse", outcome: "rejected", reasonCodes: ["CL103"] }),
    );

    expect(row()).toMatchObject({
      state: "ack_rejected",
      rejectionStage: "clearinghouse",
      rejectionCodes: ["CL103"],
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.payload.rejectionStage).toBe("clearinghouse");
    expect(catalogAccepts(published[0] as Published)).toBe(true);
    expect(alerts).toHaveLength(1);
  });

  it("without a stage the kind decides it (999 = clearinghouse, 277CA = payer), as the pre-clearinghouse crons send", async () => {
    seed("submitted");
    await applyNoticeAck({} as never, ports, submission, ack({}));
    expect(fakes.acks.at(-1)).toMatchObject({ stage: "clearinghouse" });
    await applyNoticeAck({} as never, ports, submission, ack({ kind: "ack_277ca" }));
    expect(fakes.acks.at(-1)).toMatchObject({ stage: "payer" });
  });
});

// ── ADR-0052: a payer-stage (277CA) claim rejection queues ONE rtp_correction DDE item ──────────────────────────
describe("claim 277CA rejection queues an RTP correction (ADR-0052)", () => {
  const seedClaim = (state = "ack_pending") => {
    fakes.claims.set("claim-1", {
      id: "claim-1",
      state,
      version: 2,
      providerEntityId: PE,
      patientId: "patient-1",
    });
    fakes.submissions.set("sub-claim", {
      id: "sub-claim",
      organizationId: ORG,
      kind: "claim_837i",
      claimId: "claim-1",
    });
  };
  const watchdogSpy = () => {
    const calls: Record<string, unknown>[] = [];
    return {
      calls,
      port: {
        ensureNoticeItem: async () => ({ created: false }),
        ensureClaimRtpItem: async (_tx: unknown, claim: Record<string, unknown>) => {
          calls.push(claim);
          return { created: true };
        },
      },
    };
  };
  const withWatchdog = (h: ReturnType<typeof harness>, port: unknown, logger?: unknown) =>
    ({ ...h.deps, ddeWatchdog: port, logger }) as unknown as M23WorkerDeps;

  it("queues exactly one item carrying ids and sanitised status codes only", async () => {
    seedClaim();
    const spy = watchdogSpy();
    const h = harness();
    // an MBI-shaped token and free text are dropped by the existing ack sanitiser before they get anywhere
    h.set277([
      ack277("sub-claim", "rejected", {
        claimId: "claim-1",
        reasonCodes: ["A7:21", "1EG4TE5MK73", "patient John Smith"],
      }),
    ]);

    await runAckPull277ca(withWatchdog(h, spy.port));

    expect(fakes.claims.get("claim-1")?.state).toBe("ack_rejected");
    expect(spy.calls).toEqual([
      {
        organizationId: ORG,
        claimId: "claim-1",
        providerEntityId: PE,
        patientId: "patient-1",
        acknowledgmentId: "ack-1",
        rejectionCodes: ["A7:21"],
      },
    ]);
  });

  it("a replay of the same ack does not queue again (the claim already left ack_pending)", async () => {
    seedClaim();
    const spy = watchdogSpy();
    const h = harness();
    h.set277([ack277("sub-claim", "rejected", { claimId: "claim-1" })]);

    await runAckPull277ca(withWatchdog(h, spy.port));
    await runAckPull277ca(withWatchdog(h, spy.port));

    expect(spy.calls).toHaveLength(1);
  });

  it("queues nothing for an accepted or partial 277CA, a 999 rejection or a clearinghouse-stage rejection", async () => {
    const spy = watchdogSpy();
    for (const outcome of ["accepted", "partial"] as const) {
      seedClaim();
      const h = harness();
      h.set277([ack277("sub-claim", outcome, { claimId: "claim-1" })]);
      await runAckPull277ca(withWatchdog(h, spy.port));
    }
    for (const stage of [undefined, "clearinghouse"] as const) {
      seedClaim("submitted");
      fakes.acks.length = 0;
      const h = harness();
      h.set999([ack999("sub-claim", false, { claimId: "claim-1", ...(stage ? { stage } : {}) })]);
      await runAckPull999(withWatchdog(h, spy.port));
      expect(fakes.claims.get("claim-1")?.state).toBe("ack_rejected");
    }
    expect(spy.calls).toEqual([]);
  });

  it("a queueing failure is logged and never undoes the recorded rejection or its event", async () => {
    seedClaim();
    const errors: Record<string, unknown>[] = [];
    const boom = {
      ensureNoticeItem: async () => ({ created: false }),
      ensureClaimRtpItem: async () => {
        throw new Error("db down 1EG4TE5MK73");
      },
    };
    const h = harness();
    h.set277([ack277("sub-claim", "rejected", { claimId: "claim-1" })]);

    await runAckPull277ca(
      withWatchdog(h, boom, { error: (fields: Record<string, unknown>) => errors.push(fields) }),
    );

    expect(fakes.claims.get("claim-1")?.state).toBe("ack_rejected");
    expect(h.published.map((e) => e.eventName)).toContain("m23.claim.rejected");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ organizationId: ORG, claimId: "claim-1" });
  });

  it("is a no-op when no DDE watchdog is bound", async () => {
    seedClaim();
    const h = harness();
    h.set277([ack277("sub-claim", "rejected", { claimId: "claim-1" })]);

    await runAckPull277ca(h.deps);

    expect(fakes.claims.get("claim-1")?.state).toBe("ack_rejected");
  });
});

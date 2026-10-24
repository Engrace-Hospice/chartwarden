import { schema } from "@chartwarden/db";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
// GAP-073 — manual match + adjustment override commands, driven over a scripted fake transaction (no DB).
// The fake serves each awaited chain from a per-table queue, so the assertions pin WHAT is written, not the
// ORM call shape. Live RLS / partition behaviour is covered by the live suite.
import { Value } from "@sinclair/typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { M25_OUTBOX_EVENTS } from "../../events-by-m25";
import type { M25WriteActor } from "../actor";
import { buildRemittanceCommands } from "../remittance-commands-drizzle";
import type { ClaimFactsPort, RemittanceAuditPort } from "../remittance-ports";
import type { OutboxEmission, WriteOutboxPort } from "../write-service";

type Script = Map<unknown, unknown[][]>;
interface Recorded {
  readonly op: "update" | "insert";
  readonly table: unknown;
  readonly values: Record<string, unknown>;
}

let selects: Script;
let updates: Script;
let inserts: Script;
let recorded: Recorded[];

function pop(script: Script, table: unknown): unknown[] {
  const queue = script.get(table);
  return queue?.shift() ?? [];
}

function chain(resolve: () => unknown[], onValues?: (v: Record<string, unknown>) => void) {
  const node: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "for", "returning", "orderBy"]) node[m] = () => node;
  node.set = (v: Record<string, unknown>) => {
    onValues?.(v);
    return node;
  };
  node.values = (v: Record<string, unknown>) => {
    onValues?.(v);
    return node;
  };
  // biome-ignore lint/suspicious/noThenProperty: a drizzle query chain is awaitable; the stub mirrors that
  node.then = (ok: (v: unknown[]) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve().then(resolve).then(ok, bad);
  return node;
}

const fakeTx = {
  select: () => {
    let table: unknown;
    const node = chain(() => pop(selects, table));
    node.from = (t: unknown) => {
      table = t;
      return node;
    };
    return node;
  },
  update: (table: unknown) =>
    chain(
      () => pop(updates, table),
      (values) => recorded.push({ op: "update", table, values }),
    ),
  insert: (table: unknown) =>
    chain(
      () => pop(inserts, table),
      (values) => recorded.push({ op: "insert", table, values }),
    ),
};

vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx),
}));

const RL = schema.remittanceLine;
const RA = schema.remittanceAdvice;
const ADJ = schema.remittanceAdjustment;
const RSL = schema.remittanceServiceLine;
const DC = schema.denialCase;
const PR = schema.patientResponsibilityLedger;

const ORG = "00000000-0000-4000-8000-000000000001";
const PE = "00000000-0000-4000-8000-0000000000a1";
const PE_OTHER = "00000000-0000-4000-8000-0000000000a2";
const LINE = "00000000-0000-4000-8000-0000000000b1";
const ADV = "00000000-0000-4000-8000-0000000000c1";
const CLAIM = "00000000-0000-4000-8000-0000000000d1";
const PATIENT = "00000000-0000-4000-8000-0000000000e1";
const ADJID = "00000000-0000-4000-8000-0000000000f1";
const MEMBERSHIP = "00000000-0000-4000-8000-000000000099";
const RECEIVED = new Date("2026-09-01T00:00:00Z");
const REASON = "Matched by hand against the payer portal claim number and DOS range.";

const actor: M25WriteActor = {
  organizationId: ORG,
  userId: "u1",
  roles: ["billing_clerk"],
  membershipId: MEMBERSHIP,
  stepUpRecent: true,
  providerEntityScope: [PE],
};

const unmatchedLine = {
  id: LINE,
  matchState: "unmatched",
  matchStrategy: null,
  claimId: null,
  remittanceAdviceId: ADV,
  clp02StatusCode: 1,
  clp03TotalChargeAmount: "100.00",
  clp04TotalPaymentAmount: "100.00",
  receivedAt: RECEIVED,
};

let emitted: OutboxEmission[];
let audits: Array<{ eventType: string; resourceId?: string; context: Record<string, unknown> }>;
let claimLookups: string[];
let claimRow: { id: string; providerEntityId: string; patientId: string } | null;

const outbox: WriteOutboxPort = {
  async publish(_tx, e) {
    emitted.push(e);
  },
};
const audit: RemittanceAuditPort = {
  async record(_tx, _actor, event) {
    audits.push(event);
  },
};
const claims: ClaimFactsPort = {
  async byId(_tx, claimId) {
    claimLookups.push(claimId);
    return claimRow;
  },
};

const cmds = () => buildRemittanceCommands({ db: {} as never, outbox, claims, audit });
const queue = (s: Script, table: unknown, ...rows: unknown[][]) => s.set(table, rows);
const eventNames = () => emitted.map((e) => e.eventName);

beforeEach(() => {
  selects = new Map();
  updates = new Map();
  inserts = new Map();
  recorded = [];
  emitted = [];
  audits = [];
  claimLookups = [];
  claimRow = { id: CLAIM, providerEntityId: PE, patientId: PATIENT };
});

describe("manualMatch", () => {
  const arrange = (
    line: Record<string, unknown> = unmatchedLine,
    adviceStatus = "partial_posted",
  ) => {
    queue(selects, RL, [line], []); // the line, then "any unmatched line left?" (none)
    queue(selects, RA, [{ providerEntityId: PE, parseStatus: adviceStatus }]);
    queue(updates, RL, [{ id: LINE }]);
  };

  it("404s a missing line", async () => {
    await expect(
      cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s a claim id that does not exist, writing nothing", async () => {
    arrange();
    claimRow = null;
    await expect(
      cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(recorded).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("404s a claim that belongs to another provider entity", async () => {
    arrange();
    claimRow = { id: CLAIM, providerEntityId: PE_OTHER, patientId: PATIENT };
    await expect(
      cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(recorded).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("404s a line outside the actor's provider-entity scope before touching the claim seam", async () => {
    arrange();
    const scoped = { ...actor, providerEntityScope: [PE_OTHER] };
    await expect(
      cmds().manualMatch(scoped, LINE, { proposedClaimId: CLAIM, reason: REASON }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(claimLookups).toEqual([]);
  });

  it("an actor with an empty scope sees nothing", async () => {
    arrange();
    await expect(
      cmds().manualMatch({ ...actor, providerEntityScope: [] }, LINE, {
        proposedClaimId: CLAIM,
        reason: REASON,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("binds, posts, audits the rationale and emits claim_paid + manual_match_recorded", async () => {
    arrange();
    const res = await cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON });
    expect(res.matchState).toBe("posted");
    const upd = recorded.find((r) => r.table === RL);
    expect(upd?.values).toMatchObject({
      claimId: CLAIM,
      matchState: "posted",
      matchStrategy: "manual",
      matchConfidence: 100,
      matchedByMembershipId: MEMBERSHIP,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.context.reason).toBe(REASON);
    expect(audits[0]?.resourceId).toBe(LINE);
    expect(eventNames()).toEqual([
      "m25.remittance.claim_paid",
      "m25.remittance.manual_match_recorded",
    ]);
    const paid = emitted[0]?.payload;
    expect(paid).toMatchObject({
      claimId: CLAIM,
      remittanceLineId: LINE,
      remittanceAdviceId: ADV,
      paidAmount: "100.00",
    });
    expect(JSON.stringify(emitted)).not.toContain(REASON);
  });

  it("flips a partial_posted advice to posted once no unmatched line remains", async () => {
    arrange();
    await cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON });
    expect(recorded.find((r) => r.table === RA)?.values).toMatchObject({ parseStatus: "posted" });
  });

  it("leaves the advice alone while other lines stay unmatched", async () => {
    queue(selects, RL, [unmatchedLine], [{ id: "other" }]);
    queue(selects, RA, [{ providerEntityId: PE, parseStatus: "partial_posted" }]);
    queue(updates, RL, [{ id: LINE }]);
    await cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON });
    expect(recorded.find((r) => r.table === RA)).toBeUndefined();
  });

  it("emits claim_partial_paid for a part payment", async () => {
    arrange({ ...unmatchedLine, clp04TotalPaymentAmount: "40.00" });
    await cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON });
    expect(emitted[0]).toMatchObject({
      eventName: "m25.remittance.claim_partial_paid",
      payload: { paidAmount: "40.00", adjustedAmount: "60.00" },
    });
  });

  it.each([
    ["m25.remittance.claim_paid", "100.00"],
    ["m25.remittance.claim_partial_paid", "40.00"],
  ] as const)(
    "%s carries the catalogued per-claim cap facts (patientId, cents, null dates)",
    async (eventName, paid) => {
      arrange({ ...unmatchedLine, clp04TotalPaymentAmount: paid });
      await cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON });
      const event = emitted.find((e) => e.eventName === eventName);
      const def = M25_OUTBOX_EVENTS.find((d) => d.eventName === eventName);
      expect(event).toBeDefined();
      expect(event?.payload).toMatchObject({
        patientId: PATIENT,
        paidAmountCents: Math.round(Number(paid) * 100),
        serviceFrom: null,
        serviceTo: null,
      });
      expect(Value.Check(def?.payloadSchema as never, event?.payload)).toBe(true);
    },
  );

  it("emits a null patientId (still catalog-valid) when the claim carries none", async () => {
    claimRow = { id: CLAIM, providerEntityId: PE, patientId: undefined as unknown as string };
    arrange();
    await cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON });
    const def = M25_OUTBOX_EVENTS.find((d) => d.eventName === "m25.remittance.claim_paid");
    expect(emitted[0]?.payload).toMatchObject({ patientId: null });
    expect(Value.Check(def?.payloadSchema as never, emitted[0]?.payload)).toBe(true);
  });

  it("emits claim_denied with the line's CARC codes for a zero payment", async () => {
    arrange({ ...unmatchedLine, clp04TotalPaymentAmount: "0.00" });
    queue(selects, ADJ, [{ code: "16" }, { code: "16" }, { code: "50" }]);
    await cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON });
    expect(emitted[0]).toMatchObject({
      eventName: "m25.remittance.claim_denied",
      payload: { carcCodes: ["16", "50"] },
    });
  });

  it("emits claim_recouped with the patient for a reversal and lands the line in reversed", async () => {
    arrange({ ...unmatchedLine, clp02StatusCode: 22 });
    const res = await cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON });
    expect(res.matchState).toBe("reversed");
    expect(emitted[0]).toMatchObject({
      eventName: "m25.remittance.claim_recouped",
      payload: { patientId: PATIENT, recoupedAmountCents: 10000 },
    });
  });

  it("is an idempotent replay once posted to the same claim: no writes, no events", async () => {
    queue(selects, RL, [
      { ...unmatchedLine, matchState: "posted", matchStrategy: "manual", claimId: CLAIM },
    ]);
    queue(selects, RA, [{ providerEntityId: PE, parseStatus: "posted" }]);
    const res = await cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON });
    expect(res.matchState).toBe("posted");
    expect(recorded).toEqual([]);
    expect(emitted).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("409s an auto-matched line", async () => {
    arrange({
      ...unmatchedLine,
      matchState: "auto_matched",
      matchStrategy: "payer_icn",
      claimId: CLAIM,
    });
    await expect(
      cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(emitted).toEqual([]);
  });

  it("409s and emits nothing when a concurrent match wins the race", async () => {
    arrange();
    queue(updates, RL, []);
    await expect(
      cmds().manualMatch(actor, LINE, { proposedClaimId: CLAIM, reason: REASON }),
    ).rejects.toBeInstanceOf(ChartWardenError);
    expect(emitted).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe("overrideAdjustment", () => {
  const flagged = {
    id: ADJID,
    remittanceLineId: LINE,
    remittanceServiceLineId: null,
    postAction: "flagged_review",
    taxonomyStatus: "mapped",
    casReasonCode: "45",
    adjustmentAmount: "25.00",
    denialCaseId: null,
    receivedAt: RECEIVED,
  };
  const LONG =
    "Reviewed the OA adjustment against the payer remark codes; reclassifying per policy.";

  const arrange = (adj: Record<string, unknown> = flagged, lineClaimId: string | null = CLAIM) => {
    queue(selects, ADJ, [adj]);
    queue(selects, RL, [
      { id: LINE, claimId: lineClaimId, remittanceAdviceId: ADV, receivedAt: RECEIVED },
    ]);
    queue(selects, RA, [{ providerEntityId: PE }]);
    queue(updates, ADJ, [{ id: ADJID }]);
  };

  it("404s a missing adjustment", async () => {
    await expect(
      cmds().overrideAdjustment(actor, ADJID, { newPostAction: "auto_posted", reason: LONG }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s an adjustment outside the actor's provider-entity scope", async () => {
    arrange();
    await expect(
      cmds().overrideAdjustment({ ...actor, providerEntityScope: [PE_OTHER] }, ADJID, {
        newPostAction: "auto_posted",
        reason: LONG,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(recorded).toEqual([]);
  });

  it("resolves a service-line adjustment to its line", async () => {
    arrange({ ...flagged, remittanceLineId: null, remittanceServiceLineId: "svc" });
    queue(selects, RSL, [{ remittanceLineId: LINE }]);
    const res = await cmds().overrideAdjustment(actor, ADJID, {
      newPostAction: "auto_posted",
      reason: LONG,
    });
    expect(res.postAction).toBe("auto_posted");
  });

  it("write-off persists the reason and writes nothing else", async () => {
    arrange();
    await cmds().overrideAdjustment(actor, ADJID, { newPostAction: "auto_posted", reason: LONG });
    expect(recorded.filter((r) => r.table === ADJ)[0]?.values).toMatchObject({
      postAction: "auto_posted",
    });
    expect(recorded.some((r) => r.op === "insert")).toBe(false);
    expect(audits[0]).toMatchObject({
      resourceId: ADJID,
      context: { reason: LONG, from: "flagged_review", to: "auto_posted" },
    });
    expect(JSON.stringify(emitted)).not.toContain(LONG);
  });

  it("ledger_recorded seeds the PR ledger for the claim's patient and announces it", async () => {
    arrange();
    queue(inserts, PR, [{ id: "pr1" }]);
    await cmds().overrideAdjustment(actor, ADJID, {
      newPostAction: "ledger_recorded",
      reason: LONG,
    });
    expect(recorded.find((r) => r.table === PR)?.values).toMatchObject({
      patientId: PATIENT,
      remittanceLineId: LINE,
      remittanceAdjustmentId: ADJID,
      prAmount: "25.00",
    });
    expect(eventNames()).toEqual(["m25.patient_responsibility.recorded"]);
  });

  it("ledger_recorded on an unmatched line fails closed without changing the adjustment", async () => {
    arrange(flagged, null);
    await expect(
      cmds().overrideAdjustment(actor, ADJID, { newPostAction: "ledger_recorded", reason: LONG }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(recorded).toEqual([]);
  });

  it("ledger_recorded refuses a claim from another provider entity", async () => {
    arrange();
    claimRow = { id: CLAIM, providerEntityId: PE_OTHER, patientId: PATIENT };
    await expect(
      cmds().overrideAdjustment(actor, ADJID, { newPostAction: "ledger_recorded", reason: LONG }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(recorded).toEqual([]);
  });

  it("denial_seeded opens a denial case carrying the reason, links it and emits denial.opened", async () => {
    arrange();
    queue(inserts, DC, [{ id: "dc1" }]);
    await cmds().overrideAdjustment(actor, ADJID, { newPostAction: "denial_seeded", reason: LONG });
    const seed = recorded.find((r) => r.table === DC)?.values;
    expect(seed).toMatchObject({
      providerEntityId: PE,
      claimId: CLAIM,
      remittanceAdjustmentId: ADJID,
      carcCode: "45",
      source: "remittance_adjustment",
      category: "denial",
      taxonomyStatus: "mapped",
      dollarValue: "25.00",
    });
    expect(seed?.overridePayload).toMatchObject({
      overriddenByMembershipId: MEMBERSHIP,
      reason: LONG,
    });
    expect(recorded.filter((r) => r.table === ADJ).map((r) => r.values)).toContainEqual({
      denialCaseId: "dc1",
    });
    expect(eventNames()).toEqual(["m25.denial.opened"]);
    expect(JSON.stringify(emitted)).not.toContain(LONG);
  });

  it("an unmapped CARC seeds under the unmapped category and announces the gap", async () => {
    arrange({ ...flagged, taxonomyStatus: "unmapped" });
    queue(inserts, DC, [{ id: "dc1" }]);
    await cmds().overrideAdjustment(actor, ADJID, { newPostAction: "denial_seeded", reason: LONG });
    expect(recorded.find((r) => r.table === DC)?.values).toMatchObject({
      category: "unmapped",
      taxonomyStatus: "unmapped",
    });
    expect(eventNames()).toEqual(["m25.denial.opened", "m25.taxonomy.unmapped_code_observed"]);
  });

  it("re-asserting the current action is a no-op", async () => {
    arrange({ ...flagged, postAction: "auto_posted" });
    const res = await cmds().overrideAdjustment(actor, ADJID, {
      newPostAction: "auto_posted",
      reason: LONG,
    });
    expect(res.postAction).toBe("auto_posted");
    expect(recorded).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("409s re-classifying an already-classified adjustment", async () => {
    arrange({ ...flagged, postAction: "auto_posted" });
    await expect(
      cmds().overrideAdjustment(actor, ADJID, { newPostAction: "denial_seeded", reason: LONG }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("409s with no side effects when a concurrent override wins", async () => {
    arrange();
    queue(updates, ADJ, []);
    await expect(
      cmds().overrideAdjustment(actor, ADJID, { newPostAction: "denial_seeded", reason: LONG }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(recorded.some((r) => r.op === "insert")).toBe(false);
    expect(emitted).toEqual([]);
  });
});

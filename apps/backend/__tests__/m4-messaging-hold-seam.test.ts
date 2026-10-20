// WP 5.6 S1 (ADR-0086 proposed): the M4 messaging seam - criteria selectors, the certificate guard, and the extracted
// transaction-scoped apply/release/openMessageCertificate/activeLegalHolds functions (stub tx, no database).
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

const auditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@wardenx/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wardenx/audit")>()),
  audit: auditMock,
}));

import type { AuditContext } from "@wardenx/audit";
import type { DbClient } from "@wardenx/db";
import {
  activeLegalHolds,
  applyLegalHoldInTx,
  hasSelector,
  openMessageCertificate,
  releaseLegalHoldInTx,
} from "../src/modules/04-audit/messaging-hold-workflow";
import { LegalHoldCriteriaSchema } from "../src/modules/04-audit/routes/audit-typebox";
import { holdCoversDataClass } from "../src/modules/04-audit/routes/destruction-certificates";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CH = "44444444-4444-4444-8444-444444444444";
const RANGE = { start: new Date("2026-03-01T00:00:00Z"), end: new Date("2026-03-31T00:00:00Z") };
const CTX = { organizationId: ORG, userId: USER } as AuditContext;

/** A drizzle-ish stub: every chain method returns the chain; awaiting it (or .returning/.limit) yields the next queued result. */
function stubTx(results: unknown[][]): { tx: DbClient; calls: string[] } {
  const calls: string[] = [];
  const next = () => Promise.resolve(results.shift() ?? []);
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "insert", "values", "update", "set"]) {
    chain[m] = () => {
      calls.push(m);
      return chain;
    };
  }
  chain.returning = next;
  chain.limit = next;
  // biome-ignore lint/suspicious/noThenProperty: drizzle query builders are thenables; the stub must be awaitable.
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    next().then(res, rej);
  return { tx: chain as unknown as DbClient, calls };
}

describe("criteria selectors", () => {
  it("accepts channelIds/userIds as uuids and rejects other strings", () => {
    expect(Value.Check(LegalHoldCriteriaSchema, { channelIds: [CH], userIds: [USER] })).toBe(true);
    expect(Value.Check(LegalHoldCriteriaSchema, { channelIds: ["nope"] })).toBe(false);
  });
  it("hasSelector accepts a channel-only or user-only hold, rejects an empty one", () => {
    expect(hasSelector({ channelIds: [CH] })).toBe(true);
    expect(hasSelector({ userIds: [USER] })).toBe(true);
    expect(hasSelector({})).toBe(false);
    expect(hasSelector({ channelIds: [] })).toBe(false);
  });
});

describe("holdCoversDataClass with messaging holds", () => {
  it("a messaging-only hold does not block an audit-class certificate", () => {
    expect(holdCoversDataClass({ channelIds: [CH] }, "audit_event", RANGE)).toBe(false);
    expect(holdCoversDataClass({ userIds: [USER] }, "patient_address", RANGE)).toBe(false);
  });
  it("a messaging-only hold still covers a message.<class> certificate (subject to its date range)", () => {
    expect(holdCoversDataClass({ channelIds: [CH] }, "message.care_related", RANGE)).toBe(true);
    const outside = {
      channelIds: [CH],
      dateRange: { from: "2027-01-01T00:00:00Z", to: "2027-02-01T00:00:00Z" },
    };
    expect(holdCoversDataClass(outside, "message.care_related", RANGE)).toBe(false);
  });
  it("an audit hold with no resourceKinds still covers everything (unchanged)", () => {
    expect(holdCoversDataClass({ patientIds: [USER] }, "audit_event", RANGE)).toBe(true);
  });
});

describe("applyLegalHoldInTx / releaseLegalHoldInTx", () => {
  it("apply writes the row, the audit event and the outbox payload the route always did", async () => {
    auditMock.mockClear();
    const row = { id: "h1" };
    const { tx } = stubTx([[row]]);
    const publish = vi.fn(async () => undefined);
    const out = await applyLegalHoldInTx(tx, { outbox: { publish } }, CTX, {
      organizationId: ORG,
      userId: USER,
      name: "Hold",
      criteria: { channelIds: [CH] },
      reason: "litigation hold reason",
      matchedRecordCount: 3,
    });
    expect(out).toBe(row);
    expect(auditMock).toHaveBeenCalledWith(tx, CTX, {
      eventType: "data.legal_hold_applied",
      resourceKind: "legal_hold",
      resourceId: "h1",
      outcome: "success",
      severity: "warn",
      retentionClass: "compliance",
      context: { name: "Hold", matchedRecordCount: 3, reason: "litigation hold reason" },
    });
    expect(publish).toHaveBeenCalledWith(tx, {
      eventName: "m4.legal_hold.applied",
      payload: { holdId: "h1", matched: 3, reason: "litigation hold reason" },
      organizationId: ORG,
      aggregateKind: "legal_hold",
      aggregateId: "h1",
    });
  });

  it("release counts from the hold's own criteria, audits and publishes", async () => {
    auditMock.mockClear();
    const { tx } = stubTx([
      [{ id: "h1", status: "active", criteria: { channelIds: [CH] } }],
      [{ id: "h1" }],
    ]);
    const publish = vi.fn(async () => undefined);
    const countRestored = vi.fn(async () => 5);
    const out = await releaseLegalHoldInTx(tx, { outbox: { publish } }, CTX, {
      organizationId: ORG,
      holdId: "h1",
      reason: "no longer required",
      countRestored,
    });
    expect(out).toEqual({ released: true, restoredRecordCount: 5 });
    expect(countRestored).toHaveBeenCalledWith({ channelIds: [CH] });
    expect(auditMock).toHaveBeenCalledWith(
      tx,
      CTX,
      expect.objectContaining({
        eventType: "data.legal_hold_released",
        context: { reason: "no longer required", restoredRecordCount: 5 },
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventName: "m4.legal_hold.released",
        payload: { holdId: "h1", matched: 5, reason: "no longer required" },
      }),
    );
  });

  it("release refuses an unknown hold (404) and an already-released one (409)", async () => {
    const input = {
      organizationId: ORG,
      holdId: "h1",
      reason: "x".repeat(10),
      countRestored: async () => 0,
    };
    await expect(releaseLegalHoldInTx(stubTx([[]]).tx, {}, CTX, input)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      releaseLegalHoldInTx(
        stubTx([[{ id: "h1", status: "released", criteria: {} }]]).tx,
        {},
        CTX,
        input,
      ),
    ).rejects.toMatchObject({ code: "ALREADY_RELEASED", statusCode: 409 });
  });
});

describe("releaseLegalHoldInTx concurrency", () => {
  it("the loser of a concurrent release (conditional update matches no row) gets 409 and writes no audit or outbox", async () => {
    auditMock.mockClear();
    const { tx } = stubTx([[{ id: "h1", status: "active", criteria: { channelIds: [CH] } }], []]);
    const publish = vi.fn(async () => undefined);
    await expect(
      releaseLegalHoldInTx(tx, { outbox: { publish } }, CTX, {
        organizationId: ORG,
        holdId: "h1",
        reason: "no longer required",
        countRestored: async () => 5,
      }),
    ).rejects.toMatchObject({ code: "ALREADY_RELEASED", statusCode: 409 });
    expect(auditMock).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("openMessageCertificate", () => {
  const input = {
    organizationId: ORG,
    dataClass: "message.operational",
    rangeStart: RANGE.start,
    rangeEnd: RANGE.end,
    recordCount: 7,
  };
  it("returns the existing certificate without inserting", async () => {
    const { tx, calls } = stubTx([[{ id: "c1" }]]);
    expect(await openMessageCertificate(tx, input)).toEqual({ id: "c1", created: false });
    expect(calls).not.toContain("insert");
  });
  it("inserts a pending certificate when none exists for (dataClass, rangeStart)", async () => {
    const { tx, calls } = stubTx([[], [{ id: "c2" }]]);
    expect(await openMessageCertificate(tx, input)).toEqual({ id: "c2", created: true });
    expect(calls).toContain("insert");
  });
});

describe("activeLegalHolds", () => {
  it("projects id and criteria of the active holds", async () => {
    const { tx } = stubTx([[{ id: "h1", criteria: { channelIds: [CH] } }]]);
    expect(await activeLegalHolds(tx, ORG)).toEqual([{ id: "h1", criteria: { channelIds: [CH] } }]);
  });
});

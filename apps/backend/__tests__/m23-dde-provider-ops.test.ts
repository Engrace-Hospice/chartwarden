import { DDE, type DdeOutcome } from "@chartwarden/x12-837-client";
import { describe, expect, it } from "vitest";
import {
  classifyProviderSubmissionResponse,
  ddeIdempotencyKey,
  ddeProviderRefusal,
  isUsableDdeReceipt,
  planProviderOutcome,
  runWithTimeout,
} from "../src/modules/23-billing-medicare/services/dde-provider-ops";

const outcome = (over: Partial<DdeOutcome>): DdeOutcome => ({
  eventId: "e1",
  providerReference: "ref-1",
  controlNumber: "CN1",
  disposition: "accepted",
  occurredAt: "2026-01-17T15:00:00Z",
  reasonCodes: [],
  ...over,
});

describe("DDE provider ops (#760)", () => {
  it("derives one key per item and attempt", () => {
    expect(ddeIdempotencyKey("item", 1)).toBe(ddeIdempotencyKey("item", 1));
    expect(ddeIdempotencyKey("item", 1)).not.toBe(ddeIdempotencyKey("item", 2));
    expect(ddeIdempotencyKey("a", 1)).not.toBe(ddeIdempotencyKey("b", 1));
  });

  it("maps every port error code to a stable typed refusal and never echoes a reason", () => {
    const status: Record<string, number> = {
      [DDE.NOT_WIRED]: 503,
      [DDE.NOT_PROVISIONED]: 503,
      [DDE.OPERATOR_NOT_ENROLLED]: 409,
      [DDE.UNAVAILABLE]: 503,
      [DDE.IDEMPOTENCY_CONFLICT]: 409,
      [DDE.IN_DOUBT]: 409,
      [DDE.INVALID_REQUEST]: 422,
    };
    for (const [code, http] of Object.entries(status)) {
      const err = ddeProviderRefusal(code);
      expect(err.code).toBe(code);
      expect(err.statusCode).toBe(http);
    }
    expect(ddeProviderRefusal("SOMETHING_ELSE")).toMatchObject({
      code: "DDE_PROVIDER_ERROR",
      statusCode: 502,
    });
  });

  it("accepts only complete receipts bound to the expected attempt and control number", () => {
    const expected = { idempotencyKey: "dde:item-1:2", controlNumber: "CN-1" };
    const valid = {
      providerReference: "ref-1",
      ...expected,
      receivedAt: "2026-01-17T15:00:00Z",
      replayed: false,
    };
    expect(isUsableDdeReceipt(valid, expected)).toBe(true);
    expect(isUsableDdeReceipt(undefined, expected)).toBe(false);
    expect(isUsableDdeReceipt({ ...valid, providerReference: undefined }, expected)).toBe(false);
    expect(isUsableDdeReceipt({ ...valid, idempotencyKey: "dde:other:2" }, expected)).toBe(false);
    expect(isUsableDdeReceipt({ ...valid, controlNumber: "CN-OTHER" }, expected)).toBe(false);
    expect(isUsableDdeReceipt({ ...valid, receivedAt: "2026-02-30T15:00:00Z" }, expected)).toBe(
      false,
    );
    expect(isUsableDdeReceipt({ ...valid, replayed: "false" }, expected)).toBe(false);
  });

  it("classifies malformed provider envelopes without trusting their payloads", () => {
    expect(classifyProviderSubmissionResponse(null)).toEqual({ kind: "invalid" });
    expect(classifyProviderSubmissionResponse({ ok: true })).toEqual({ kind: "invalid" });
    expect(classifyProviderSubmissionResponse({ ok: false, degraded: null })).toEqual({
      kind: "invalid",
    });
    expect(classifyProviderSubmissionResponse({ ok: false, degraded: { code: 17 } })).toEqual({
      kind: "invalid",
    });
    expect(
      classifyProviderSubmissionResponse({ ok: false, degraded: { code: "UNAVAILABLE" } }),
    ).toEqual({ kind: "degraded", code: "UNAVAILABLE" });
    expect(classifyProviderSubmissionResponse({ ok: true, data: { raw: "ignored" } })).toEqual({
      kind: "success",
      data: { raw: "ignored" },
    });
  });

  it("plans an acceptance on the MAC's day: an instant on the Eastern clock, a date as given", () => {
    expect(
      planProviderOutcome(outcome({ occurredAt: "2026-01-18T03:00:00Z" }), "2026-02-01"),
    ).toMatchObject({
      kind: "accepted",
      macAcceptedOn: "2026-01-17",
    });
    expect(planProviderOutcome(outcome({ occurredAt: "2026-01-17" }), "2026-02-01")).toMatchObject({
      kind: "accepted",
      macAcceptedOn: "2026-01-17",
    });
  });

  it("refuses an unreadable or future acceptance date and drops an unusable DCN", () => {
    expect(planProviderOutcome(outcome({ occurredAt: "nope" }), "2026-02-01").kind).toBe("invalid");
    expect(planProviderOutcome(outcome({ occurredAt: "2026-02-30" }), "2026-03-05").kind).toBe(
      "invalid",
    );
    expect(planProviderOutcome(outcome({ occurredAt: "2026-03-01" }), "2026-02-01").kind).toBe(
      "invalid",
    );
    expect(planProviderOutcome(outcome({ dcn: "short" }), "2026-02-01")).toMatchObject({
      dcn: null,
    });
  });

  it("plans a return with the first code-shaped reason and the matching outcome code", () => {
    expect(
      planProviderOutcome(
        outcome({ disposition: "rejected", reasonCodes: ["free text!", "U5001"] }),
        "2026-02-01",
      ),
    ).toEqual({ kind: "returned", rtpReasonCode: "U5001", outcomeCode: "rejected", dcn: null });
    expect(planProviderOutcome(outcome({ disposition: "returned" }), "2026-02-01")).toMatchObject({
      outcomeCode: "rtp",
      rtpReasonCode: null,
    });
  });

  it("runWithTimeout returns the value when the call settles in time", async () => {
    expect(await runWithTimeout(async () => 7, 1000)).toEqual({ kind: "done", value: 7 });
  });

  it("runWithTimeout aborts the signal and reports a timeout past the bound", async () => {
    let seen: AbortSignal | undefined;
    const r = await runWithTimeout((signal) => {
      seen = signal;
      return new Promise<number>(() => undefined);
    }, 10);
    expect(r).toEqual({ kind: "timeout" });
    expect(seen?.aborted).toBe(true);
  });

  it("runWithTimeout reports a throw as 'threw' instead of rejecting", async () => {
    const r = await runWithTimeout(async () => {
      throw new Error("boom");
    }, 1000);
    expect(r).toEqual({ kind: "threw" });
  });
});

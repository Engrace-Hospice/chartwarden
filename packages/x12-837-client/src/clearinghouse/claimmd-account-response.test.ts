import { describe, expect, it, vi } from "vitest";
import {
  captureAccountResponsePage,
  createClaimMdAccountResponseReader,
  decodeClaimMdCapturedPayload,
  encodeClaimMdCapturedPayload,
} from "./claimmd-account-response";

describe("Claim.MD account response capture", () => {
  it("retains all parents and nested messages, including unknown and missing fields", () => {
    const body = {
      result: {
        last_responseid: "9007199254740994",
        claim: [
          {
            bill_npi: "synthetic",
            pcn: "C1",
            status: "A",
            senderid: "CLMMD",
            messages: [
              { responseid: "9007199254740992", status: "A", mesgid: "ACK" },
              { responseid: "9007199254740993", status: "Z", mesgid: "NEW" },
            ],
          },
          { status: "Z", messages: { responseid: "9007199254740994", mesgid: "FUTURE" } },
          { messages: { mesgid: "NO_ID" } },
        ],
      },
    };
    const result = captureAccountResponsePage(body, "9007199254740991");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.events).toHaveLength(4);
    expect(result.page.events.map((e) => e.responseId)).toEqual([
      "9007199254740992",
      "9007199254740993",
      "9007199254740994",
      null,
    ]);
    expect(result.page.events.map((e) => e.state)).toEqual([
      "captured",
      "needs_review",
      "needs_review",
      "needs_review",
    ]);
    expect(result.page.nextCursor).toBe("9007199254740994");
    expect(result.page.body).toEqual(body);
  });
  it("fails closed on missing or regressing watermark and malformed envelope", () => {
    expect(captureAccountResponsePage({ claim: { messages: { responseid: "2" } } }, "0")).toEqual({
      ok: false,
      code: "BAD_ENVELOPE",
    });
    expect(
      captureAccountResponsePage(
        { last_responseid: "1", claim: { messages: { responseid: "2" } } },
        "0",
      ),
    ).toEqual({ ok: false, code: "BAD_ENVELOPE" });
    expect(captureAccountResponsePage({ last_responseid: "1", claim: [] }, "2")).toEqual({
      ok: false,
      code: "CURSOR_REGRESSION",
    });
  });
  it("uses the shared budget and never sends a provider filter", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const fields = init.body as URLSearchParams;
      expect(fields.get("ResponseID")).toBe("0");
      expect([...fields.keys()].sort()).toEqual(["AccountKey", "ResponseID"]);
      return new Response(JSON.stringify({ last_responseid: "0", claim: [] }), { status: 200 });
    });
    const counter = { increment: vi.fn(async () => 1) };
    const reader = createClaimMdAccountResponseReader({
      accounts: { "acct-test": { test: "offline-fixture" } },
      counter,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect((await reader.fetchAccountResponses("acct-test", "test", "0")).ok).toBe(true);
    expect(counter.increment).toHaveBeenCalledWith("claimmd:test", 5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parses the documented XML attribute envelope and preserves exact source text", async () => {
    const raw =
      '<result last_responseid="9"><claim bill_npi="123" pcn="SYNTH" status="A" senderid="CLMMD"><messages responseid="9" status="A" mesgid="ACK" message="Accepted"/></claim></result>';
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect((init.body as URLSearchParams).get("ResponseID")).toBe("8");
      return new Response(raw, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    });
    const reader = createClaimMdAccountResponseReader({
      accounts: { "acct-test": { test: "offline-fixture" } },
      counter: { increment: async () => 1 },
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const result = await reader.fetchAccountResponses("acct-test", "test", "8");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.sourceFormat).toBe("xml");
    expect(result.page.rawPayload).toBe(raw);
    expect(result.page.events[0]?.responseId).toBe("9");
    expect(
      decodeClaimMdCapturedPayload(
        encodeClaimMdCapturedPayload({
          rawPayload: raw,
          sourceFormat: "xml",
        }),
      ),
    ).toEqual(result.page.body);
  });

  it("rejects DTD/entity declarations and malformed XML", async () => {
    const values = [
      '<!DOCTYPE result [<!ENTITY x "boom">]><result last_responseid="0"/>',
      "<result><claim></result>",
    ];
    for (const raw of values) {
      const reader = createClaimMdAccountResponseReader({
        accounts: { "acct-test": { test: "offline-fixture" } },
        counter: { increment: async () => 1 },
        fetch: (async () =>
          new Response(raw, {
            status: 200,
            headers: { "content-type": "application/xml" },
          })) as typeof fetch,
      });
      expect(await reader.fetchAccountResponses("acct-test", "test", "0")).toEqual({
        ok: false,
        code: "BAD_ENVELOPE",
      });
    }
  });
});

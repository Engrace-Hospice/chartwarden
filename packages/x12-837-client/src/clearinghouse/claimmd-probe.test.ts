import { describe, expect, it } from "vitest";
import { CLAIMMD_PROBE_DAY, probeClaimMdAccountKey } from "./claimmd-probe";

const FAKE_KEY = "00000_not-a-real-key";
const reply = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("probeClaimMdAccountKey", () => {
  it("passes on the empty list Claim.MD answers for a day with no uploads", async () => {
    expect(await probeClaimMdAccountKey(FAKE_KEY, { fetch: reply({}) })).toBe("ok");
    expect(await probeClaimMdAccountKey(FAKE_KEY, { fetch: reply({ file: [] }) })).toBe("ok");
  });

  it("reports a rejected key (error 21, or HTTP 401)", async () => {
    const bad = reply({ error: { error_code: "21", error_mesg: "Invalid AccountKey." } });
    expect(await probeClaimMdAccountKey(FAKE_KEY, { fetch: bad })).toBe("credential_rejected");
    expect(await probeClaimMdAccountKey(FAKE_KEY, { fetch: reply({}, 401) })).toBe(
      "credential_rejected",
    );
  });

  it("is inconclusive, never a pass, on a rate block, an outage, a vendor fault or an unreadable answer", async () => {
    expect(await probeClaimMdAccountKey(FAKE_KEY, { fetch: reply({}, 403) })).toBe("unreachable");
    expect(await probeClaimMdAccountKey(FAKE_KEY, { fetch: reply({}, 503) })).toBe("unreachable");
    expect(
      await probeClaimMdAccountKey(FAKE_KEY, { fetch: reply({ error: { error_code: "99" } }) }),
    ).toBe("unreachable");
    expect(await probeClaimMdAccountKey(FAKE_KEY, { fetch: reply({ surprise: true }) })).toBe(
      "unreachable",
    );
    const down = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await probeClaimMdAccountKey(FAKE_KEY, { fetch: down })).toBe("unreachable");
  });

  it("sends only the key and a long-past day, in the form body (never the URL)", async () => {
    let seen: { url: string; body: string } | undefined;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, body: String(init.body) };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await probeClaimMdAccountKey(FAKE_KEY, { fetch: spy });
    expect(seen?.url).toBe("https://svc.claim.md/services/uploadlist/");
    expect(seen?.url).not.toContain(FAKE_KEY);
    const form = new URLSearchParams(seen?.body);
    expect(form.get("AccountKey")).toBe(FAKE_KEY);
    expect(form.get("UploadDate")).toBe(CLAIMMD_PROBE_DAY);
  });
});

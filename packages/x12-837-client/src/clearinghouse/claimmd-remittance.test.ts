import { describe, expect, it } from "vitest";
import { InMemoryAttemptStore } from "./attempt-store";
import { type ClaimMdAnomaly, ClaimMdTransport } from "./claimmd-transport";
import { DEFAULT_SCOPE } from "./conformance";
import { CH, type ClearinghouseContext } from "./types";

// How the Claim.MD adapter reads the `era835` `data` array (contract doc, open item 1). Synthetic 835 envelopes only:
// no claims, no patients; the NPI is the conformance suite's synthetic, Luhn-valid value.

const KEY = "claimmd_remit_key_do_not_leak";
const NPI = DEFAULT_SCOPE.billingNpi as string;
const ctx: ClearinghouseContext = {
  ...DEFAULT_SCOPE,
  payerId: "15004",
  correlationId: "corr-remit",
};

/** A whole (empty-bodied) 835 interchange with control number `ctl`. */
const interchange = (ctl: string): string =>
  `ISA*00*          *00*          *ZZ*15004          *ZZ*34652          *261104*1015*^*00501*${ctl}*0*T*:~` +
  `GS*HP*15004*34652*20261104*1015*1*X*005010X221A1~ST*835*0001~SE*2*0001~GE*1*1~IEA*1*${ctl}~`;

/** A fake Claim.MD answering `eralist` and `era835` from `eras` (eraid → the `data` value it answers). */
function setup(eras: Record<string, unknown>) {
  const anomalies: ClaimMdAnomaly[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
      .replace(/^https:\/\/svc\.claim\.md\/services\//, "")
      .replace(/\/$/, "");
    const body = init?.body as URLSearchParams;
    if (path === "eralist") {
      const after = Number(body.get("ERAID"));
      const ids = Object.keys(eras).filter((id) => Number(id) > after);
      return Response.json({ era: ids.map((eraid) => ({ eraid: Number(eraid), prov_npi: NPI })) });
    }
    if (path === "era835") {
      const eraid = String(body.get("eraid"));
      return Response.json({ eraid: Number(eraid), data: eras[eraid] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const transport = new ClaimMdTransport({
    keys: { test: KEY },
    attempts: new InMemoryAttemptStore(),
    fetch: fetchImpl,
    onAnomaly: (a) => anomalies.push(a),
  });
  return { transport, anomalies };
}

const files = async (eras: Record<string, unknown>) => {
  const r = await setup(eras).transport.fetchRemittances(ctx, null);
  if (!r.ok) throw new Error(`page failed: ${r.degraded.code}`);
  return r.data.items.map((f) => [f.remittanceId, f.rawX12]);
};

describe("Claim.MD era835 `data` shapes", () => {
  const a = interchange("000000101");
  const b = interchange("000000102");

  it("reads a plain string or a one-element array as one file, byte-for-byte", async () => {
    expect(await files({ "701": a })).toEqual([["claimmd-701", a]]);
    expect(await files({ "701": [a] })).toEqual([["claimmd-701", a]]);
  });

  it("splits an array of whole interchanges into one file each, the first keeping the single-file id", async () => {
    const eras = { "701": [a, b], "702": [b] };
    const first = await files(eras);
    expect(first).toEqual([
      ["claimmd-701", a],
      ["claimmd-701-2", b],
      ["claimmd-702", b],
    ]);
    // A re-fetch of the same answers yields the same ids, so the M25 pull's quarantine/object keys stay put.
    expect(await files(eras)).toEqual(first);
  });

  it("joins fragments in order only when they form exactly one interchange", async () => {
    const cut = [a.slice(0, 40), a.slice(40, 130), a.slice(130)];
    expect(await files({ "701": cut })).toEqual([["claimmd-701", a]]);
  });

  it.each([
    ["a whole interchange followed by junk", [a, "not x12"], 2],
    ["fragments that do not close (IEA02 != ISA13)", [a.slice(0, 120), b.slice(120)], 2],
    ["fragments out of order", [a.slice(60), a.slice(0, 60)], 2],
    ["a non-string element", [a, 7], 2],
    ["an empty element", [a, ""], 2],
    ["an empty array", [], 0],
  ])(
    "delivers the ERAs before it, never passes it and flags the ERA for %s",
    async (_label, data, elements) => {
      const s = setup({ "700": a, "701": data });
      // The good ERA before it is delivered, the cursor stops on it (never past the bad one) and more is signalled.
      const r = await s.transport.fetchRemittances(ctx, "699");
      expect(r.ok && r.data).toEqual({
        items: [expect.objectContaining({ remittanceId: "claimmd-700" })],
        nextCursor: "700",
        hasMore: true,
      });
      // Next call: the bad ERA comes first and fails alone, so the M25 pull keeps its stored cursor and retries.
      const again = await s.transport.fetchRemittances(ctx, "700");
      expect(!again.ok && again.degraded.code).toBe(CH.UNAVAILABLE);
      expect(s.anomalies).toEqual([
        { type: "era_unreadable", eraid: "701", elements },
        { type: "era_unreadable", eraid: "701", elements },
      ]);
    },
  );

  it("raises no anomaly when the ERA has no `data` at all (still fails closed)", async () => {
    const s = setup({ "701": undefined });
    const r = await s.transport.fetchRemittances(ctx, null);
    expect(!r.ok && r.degraded.code).toBe(CH.UNAVAILABLE);
    expect(s.anomalies).toEqual([]);
  });
});

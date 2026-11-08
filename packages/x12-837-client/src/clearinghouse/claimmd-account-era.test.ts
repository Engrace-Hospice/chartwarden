import { describe, expect, it } from "vitest";
import {
  captureClaimMdEraListPage,
  createClaimMdAccountEraReader,
  discoverClaimMdEraSnapshot,
} from "./claimmd-account-era";

const KEY = "synthetic_claimmd_account_key";
const account = "synthetic-central-account";
const usage = "test" as const;
const x12 = (ctl: string) =>
  `ISA*00*          *00*          *ZZ*PAYER          *ZZ*PAYEE          *261107*1015*^*00501*${ctl}*0*T*:~GS*HP*P*R*20261107*1015*1*X*005010X221A1~ST*835*0001~SE*2*0001~GE*1*1~IEA*1*${ctl}~`;

describe("account-scoped Claim.MD ERA reader", () => {
  it("commits only after all pages, keeps cursor fixed while paging, and fences commit", async () => {
    const requested: number[] = [];
    const persisted: number[] = [];
    const reader = {
      async list(_account: string, _usage: "test", cursor: string, page: number) {
        expect(cursor).toBe("0");
        requested.push(page);
        const ids = page === 1 ? Array.from({ length: 100 }, (_, i) => String(i + 1)) : ["101"];
        return {
          ok: true as const,
          page: {
            afterEraId: "0",
            lastEraId: "101",
            page,
            items: ids.map((eraId) => ({ eraId, digest: `d${eraId}`, metadata: { eraid: eraId } })),
            digest: `p${page}`,
          },
        };
      },
    };
    const result = await discoverClaimMdEraSnapshot({
      reader,
      accountReference: "central",
      usage: "test",
      cursor: "0",
      leaseGeneration: 9n,
      commit: {
        async commit(input) {
          persisted.push(input.pages.flatMap((p) => p.items).length);
          expect(input.nextEraId).toBe("101");
          expect(input.leaseGeneration).toBe(9n);
        },
      },
    });
    expect(requested).toEqual([1, 2]);
    expect(persisted).toEqual([101]);
    expect(result).toEqual({ ok: true, discovered: 101, cursor: "101", pages: 2 });
  });

  it("does not advance on a changed watermark or intermediate failure", async () => {
    const commits: number[] = [];
    const commit = {
      async commit() {
        commits.push(1);
      },
    };
    const changed = await discoverClaimMdEraSnapshot({
      accountReference: "central",
      usage: "test",
      cursor: "0",
      leaseGeneration: 1n,
      commit,
      reader: {
        async list(_a, _u, _c, page) {
          return {
            ok: true as const,
            page: {
              afterEraId: "0",
              lastEraId: page === 1 ? "200" : "201",
              page,
              items: Array.from({ length: 100 }, (_, i) => ({
                eraId: String(page * 100 + i),
                digest: "x",
                metadata: {},
              })),
              digest: "p",
            },
          };
        },
      },
    });
    expect(changed).toEqual({ ok: false, code: "WATERMARK_CHANGED" });
    const failed = await discoverClaimMdEraSnapshot({
      accountReference: "central",
      usage: "test",
      cursor: "0",
      leaseGeneration: 1n,
      commit,
      reader: {
        async list(_a, _u, _c, page) {
          return page === 1
            ? {
                ok: true as const,
                page: {
                  afterEraId: "0",
                  lastEraId: "100",
                  page,
                  items: Array.from({ length: 100 }, (_, i) => ({
                    eraId: String(i + 1),
                    digest: "x",
                    metadata: {},
                  })),
                  digest: "p",
                },
              }
            : { ok: false as const, code: "TRANSPORT" };
        },
      },
    });
    expect(failed).toEqual({ ok: false, code: "VENDOR_READ" });
    expect(commits).toHaveLength(0);
  });

  it("retains decimal ERA IDs beyond Number precision and deduplicates identical rows", () => {
    const result = captureClaimMdEraListPage(
      {
        result: {
          last_eraid: "90071992547409931234",
          era: [
            { eraid: "90071992547409931234", prov_npi: "synthetic" },
            { eraid: "90071992547409931234", prov_npi: "synthetic" },
          ],
        },
      },
      "90071992547409931233",
      1,
    );
    expect(result).toMatchObject({
      ok: true,
      page: { lastEraId: "90071992547409931234", items: [{ eraId: "90071992547409931234" }] },
    });
  });

  it("fails closed on missing watermarks, out-of-range IDs, and conflicting duplicates", () => {
    expect(captureClaimMdEraListPage({ era: [{ eraid: "11" }] }, "10", 1)).toMatchObject({
      ok: false,
      code: "CURSOR_REGRESSION",
    });
    expect(
      captureClaimMdEraListPage({ last_eraid: "10", era: [{ eraid: "9" }] }, "10", 1),
    ).toMatchObject({ ok: false, code: "BAD_ENVELOPE" });
    expect(
      captureClaimMdEraListPage(
        {
          last_eraid: "12",
          era: [
            { eraid: "11", paid_amount: "1" },
            { eraid: "11", paid_amount: "2" },
          ],
        },
        "10",
        1,
      ),
    ).toMatchObject({ ok: false, code: "ID_CONFLICT" });
  });

  it("requests account-wide discovery with explicit NewOnly=0 and 100-row page numbers", async () => {
    const sent: URLSearchParams[] = [];
    const reader = createClaimMdAccountEraReader({
      accounts: { [account]: { test: KEY } },
      counter: {
        async increment() {
          return 1;
        },
      },
      fetch: (async (_input, init) => {
        sent.push(init?.body as URLSearchParams);
        return Response.json({ last_eraid: "101", era: [] });
      }) as typeof fetch,
    });
    const result = await reader.list(account, usage, "0", 2);
    expect(result.ok).toBe(true);
    expect(sent[0]?.get("ERAID")).toBe("0");
    expect(sent[0]?.get("Page")).toBe("2");
    expect(sent[0]?.get("NewOnly")).toBe("0");
    expect(sent[0]?.has("NPI")).toBe(false);
    expect(sent[0]?.has("TaxID")).toBe(false);
    expect(sent[0]?.get("AccountKey")).toBe(KEY);
  });

  it("captures the original X12 and structured details only for the requested ERA identity", async () => {
    const calls: string[] = [];
    const reader = createClaimMdAccountEraReader({
      accounts: { [account]: { test: KEY } },
      counter: {
        async increment() {
          return 1;
        },
      },
      fetch: (async (input, init) => {
        const path = String(input).split("/").filter(Boolean).at(-1) ?? "";
        const body = init?.body as URLSearchParams;
        calls.push(`${path}:${body.get("eraid")}`);
        if (path === "era835") return Response.json({ eraid: "77", data: x12("000000077") });
        return Response.json({
          eraid: "77",
          result: { payment_method: "ACH", claim: [{ pcn: "synthetic-pcn" }] },
        });
      }) as typeof fetch,
    });
    const file = await reader.download835(account, usage, "77");
    const details = await reader.details(account, usage, "77");
    expect(file.ok && file.files).toEqual([x12("000000077")]);
    expect(details).toMatchObject({ ok: true, details: { payment_method: "ACH" } });
    expect(calls).toEqual(["era835:77", "eradata:77"]);
  });

  it("does not send requests for missing credentials or mismatched IDs", async () => {
    let requests = 0;
    const reader = createClaimMdAccountEraReader({
      accounts: { [account]: { test: KEY } },
      counter: {
        async increment() {
          return 1;
        },
      },
      fetch: (async () => {
        requests++;
        return Response.json({ eraid: "78", data: x12("000000078") });
      }) as typeof fetch,
    });
    expect(await reader.list(account, "production", "0", 1)).toMatchObject({
      ok: false,
      code: "CREDENTIAL",
    });
    expect(await reader.download835(account, usage, "77")).toMatchObject({
      ok: false,
      code: "ID_MISMATCH",
    });
    expect(requests).toBe(1);
  });
});

import { randomBytes } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { DegradedError, ValidationError } from "@chartwarden/types";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createPsrFileStore } from "../psr/psr-file-store";
import { CapPsrImportViewDto } from "../routes/m26-typebox";
import { buildDrizzleM26WriteService } from "../routes/write-service-drizzle";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const actor = { organizationId: ORG_A, userId: "u-1", roles: [], stepUpRecent: false };
const input = (fileBase64: string) => ({
  macRegion: "palmetto",
  psrPeriodFrom: "2026-01-01",
  psrPeriodTo: "2026-03-31",
  fileBase64,
});
const db = {} as DbClient; // every assertion below fires before any DB access

function memoryStore() {
  const objects = new Map<string, Uint8Array>();
  const key = randomBytes(32);
  const store = createPsrFileStore({
    keys: {
      dekForOrg: async () => ({ version: "1", key }),
      dekForOrgVersion: async () => ({ version: "1", key }),
    },
    objects: {
      putObject: async ({ organizationId, objectKey, bytes }) => {
        objects.set(`${organizationId}/${objectKey}`, bytes);
      },
      getObject: async ({ organizationId, objectKey }) => {
        const o = objects.get(`${organizationId}/${objectKey}`);
        if (!o) throw new Error("missing");
        return o;
      },
    },
  });
  return { store, objects };
}

describe("PS&R file store (DEK envelope)", () => {
  it("round-trips the bytes and never stores the plaintext", async () => {
    const { store, objects } = memoryStore();
    const csv = Buffer.from("MBI,Paid Amount\n1EG4TE5MK73,100.00\n");
    await store.put(ORG_A, "psr/a/x.csv", csv);
    const stored = Buffer.from(objects.get(`${ORG_A}/psr/a/x.csv`)!).toString("utf8");
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain("1EG4TE5MK73");
    expect(Buffer.from(await store.get(ORG_A, "psr/a/x.csv")).toString()).toBe(csv.toString());
  });

  it("refuses to open another tenant's ciphertext (AAD bound to the org)", async () => {
    const { store, objects } = memoryStore();
    await store.put(ORG_A, "psr/a/x.csv", Buffer.from("secret"));
    objects.set(`${ORG_B}/psr/a/x.csv`, objects.get(`${ORG_A}/psr/a/x.csv`)!);
    await expect(store.get(ORG_B, "psr/a/x.csv")).rejects.toThrow();
  });
});

describe("importPsr guards", () => {
  const enqueue = { enqueue: async () => {} };
  it("fails closed (typed degraded) when file storage / the queue is not bound", async () => {
    const svc = buildDrizzleM26WriteService(db);
    await expect(svc.importPsr(actor, "p-1", input("QUJD"))).rejects.toBeInstanceOf(DegradedError);
  });

  it("rejects non-base64 and empty payloads before touching the database", async () => {
    const { store } = memoryStore();
    const svc = buildDrizzleM26WriteService(db, undefined, { files: store, enqueue });
    await expect(svc.importPsr(actor, "p-1", input("not base64!"))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(svc.importPsr(actor, "p-1", input("===="))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("PS&R import read view (quarantine, GAP-078 follow-up)", () => {
  const base = {
    id: "i-1",
    capPeriodId: "p-1",
    macRegion: "palmetto",
    psrPeriodFrom: "2026-01-01",
    psrPeriodTo: "2026-03-31",
    parseStatus: "reconciled",
    parseError: null,
    beneficiaryCountPsr: 9,
    paidTotalCentsPsr: 90_000,
    importedAt: "2026-10-05T00:00:00.000Z",
  };
  it("keeps the quarantine fields optional (older rows / clients without them still validate)", () => {
    expect(Value.Check(CapPsrImportViewDto, base)).toBe(true);
    expect(
      Value.Check(CapPsrImportViewDto, {
        ...base,
        rowsQuarantined: 1,
        quarantineDetail: {
          lines: [{ line: 4, code: "invalid_paid_amount" }],
          truncated: false,
          flaggedBeneficiaries: 1,
          unattributableRows: 0,
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(CapPsrImportViewDto, { ...base, rowsQuarantined: null, quarantineDetail: null }),
    ).toBe(true);
  });
});

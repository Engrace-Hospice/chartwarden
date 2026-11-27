// The presigned (verified) upload's `initiate` validates its input before anything is issued. The tenant_baa kind is filed once by a
// platform operator through the onboarding port; the generic write routes refuse it (immutable-kinds.ts). Alongside the server upload's
// own refusal (server-upload.test.ts), the presigned upload's NEW document path must refuse the kind itself: the route schema is not the
// only thing that keeps a tenant from filing evidence of its own BAA.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import {
  type InitiateVerifiedUploadInput,
  createVerifiedUploadService,
  scanVerifiedUploadedObject,
  uploadObjectVerdict,
} from "./verified-upload";

describe("uploadObjectVerdict (CW-AC-05)", () => {
  const expected = { byteSize: 10, mimeType: "application/pdf", sha256Hex: "b".repeat(64) };
  const stored = { ...expected, serverSideEncryption: "AES256" as string | null };

  it("accepts an object with the declared bytes, encrypted or not when encryption is not required", () => {
    expect(uploadObjectVerdict(stored, expected, true)).toBe("ok");
    expect(uploadObjectVerdict({ ...stored, serverSideEncryption: null }, expected, false)).toBe(
      "ok",
    );
    expect(uploadObjectVerdict({ ...expected }, expected, false)).toBe("ok"); // a store that reports nothing
  });

  it("refuses an object the store reports as not encrypted when encryption is required", () => {
    expect(uploadObjectVerdict({ ...stored, serverSideEncryption: null }, expected, true)).toBe(
      "unencrypted",
    );
    expect(uploadObjectVerdict({ ...expected }, expected, true)).toBe("unencrypted");
    expect(
      uploadObjectVerdict({ ...stored, serverSideEncryption: "aws:kms" }, expected, true),
    ).toBe("unencrypted");
  });

  it("an unencrypted object is refused as such even when its bytes also differ", () => {
    expect(
      uploadObjectVerdict({ ...stored, serverSideEncryption: null, byteSize: 11 }, expected, true),
    ).toBe("unencrypted");
  });

  it("still refuses a size, type or checksum that does not match", () => {
    expect(uploadObjectVerdict({ ...stored, byteSize: 11 }, expected, true)).toBe("mismatch");
    expect(uploadObjectVerdict({ ...stored, mimeType: "image/png" }, expected, true)).toBe(
      "mismatch",
    );
    expect(uploadObjectVerdict({ ...stored, sha256Hex: "c".repeat(64) }, expected, true)).toBe(
      "mismatch",
    );
  });
});

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";

const INPUT: InitiateVerifiedUploadInput = {
  mode: "new_document",
  targetDocumentId: null,
  patientId: null,
  admissionId: null,
  retentionClass: "operational",
  aggregateType: "tenant_baa",
  aggregateId: null,
  title: "Signed BAA",
  patientFacing: false,
  mimeType: "application/pdf",
  byteSize: 1024,
  sha256Hex: "a".repeat(64),
};

/** A store and a database that fail the test if anything past the validation touches them. */
function service() {
  const touched: string[] = [];
  const trap = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          touched.push(`${name}.${String(prop)}`);
          throw new Error(`${name} was touched`);
        },
      },
    );
  const svc = createVerifiedUploadService({
    db: trap("db") as unknown as DbClient,
    objects: trap("objects") as never,
  });
  return { svc, touched };
}

describe("createVerifiedUploadService.initiate", () => {
  it("refuses an operator-filed kind (tenant_baa) on a new document with 409 DOCUMENT_IMMUTABLE, before the database or the store is touched", async () => {
    const { svc, touched } = service();
    await expect(
      svc.initiate({ organizationId: ORG, userId: USER, membershipId: MEMBERSHIP, input: INPUT }),
    ).rejects.toMatchObject({ code: "DOCUMENT_IMMUTABLE", statusCode: 409 });
    expect(touched).toEqual([]);
  });

  it("does not refuse an ordinary kind on that check (it goes on to the database, which the trap here refuses)", async () => {
    const { svc, touched } = service();
    await expect(
      svc.initiate({
        organizationId: ORG,
        userId: USER,
        membershipId: MEMBERSHIP,
        input: { ...INPUT, aggregateType: "other" as never },
      }),
    ).rejects.not.toMatchObject({ code: "DOCUMENT_IMMUTABLE" });
    expect(touched.length).toBeGreaterThan(0);
  });

  it("refuses a large video before creating a ledger or presign when scanning is mandatory", async () => {
    const touched: string[] = [];
    const trap = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            touched.push(`${name}.${String(property)}`);
            throw new Error(`${name} was touched`);
          },
        },
      );
    const svc = createVerifiedUploadService({
      db: trap("db") as unknown as DbClient,
      objects: trap("objects") as never,
      scanRequired: true,
    });
    await expect(
      svc.initiate({
        organizationId: ORG,
        userId: USER,
        membershipId: MEMBERSHIP,
        input: {
          ...INPUT,
          aggregateType: "bereavement_library_item" as never,
          mimeType: "video/mp4",
          byteSize: 500 * 1024 * 1024,
        },
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_SCAN_SIZE_UNSUPPORTED", statusCode: 422 });
    expect(touched).toEqual([]);
  });

  it("provisions the tenant bucket before creating an upload row or issuing a presign", async () => {
    const touched: string[] = [];
    const trap = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            touched.push(`${name}.${String(property)}`);
            throw new Error(`${name} was touched`);
          },
        },
      );
    const svc = createVerifiedUploadService({
      db: trap("db") as unknown as DbClient,
      objects: trap("objects") as never,
      ensureTenantBucket: async (organizationId) => {
        touched.push(`ensure:${organizationId}`);
        throw new Error("provisioning unavailable");
      },
    });

    await expect(
      svc.initiate({
        organizationId: ORG,
        userId: USER,
        membershipId: MEMBERSHIP,
        input: { ...INPUT, aggregateType: "other" as never },
      }),
    ).rejects.toThrow("provisioning unavailable");
    expect(touched).toEqual([`ensure:${ORG}`]);
  });

  it("validates a version target before provisioning object storage", async () => {
    const touched: string[] = [];
    const db = new Proxy(
      {},
      {
        get: (_target, property) => {
          touched.push(`db.${String(property)}`);
          throw new Error(`db.${String(property)} was touched`);
        },
      },
    );
    const svc = createVerifiedUploadService({
      db: db as unknown as DbClient,
      objects: {} as never,
      ensureTenantBucket: async () => {
        touched.push("ensure");
      },
    });

    await expect(
      svc.initiate({
        organizationId: ORG,
        userId: USER,
        membershipId: MEMBERSHIP,
        input: {
          ...INPUT,
          mode: "new_version",
          targetDocumentId: "44444444-4444-4444-8444-444444444444",
          aggregateType: "other" as never,
        },
      }),
    ).rejects.toThrow(/db\..* was touched/);
    expect(touched).not.toContain("ensure");
  });
});

describe("scanVerifiedUploadedObject", () => {
  const bytes = Buffer.from("%PDF-1.4 synthetic");
  const input = {
    organizationId: ORG,
    objectKey: "uploads/synthetic",
    mimeType: "application/pdf",
    byteSize: bytes.byteLength,
  };

  it("reads the checksum-verified object and accepts only an explicit clean verdict", async () => {
    const seen: string[] = [];
    await expect(
      scanVerifiedUploadedObject(
        {
          reader: {
            getObject: async (args) => {
              seen.push(`${args.bucket}/${args.objectKey}:${args.maxBytes}`);
              return bytes;
            },
          },
          scanner: {
            scan: async (scan) => {
              expect(scan.bytes).toEqual(bytes);
              return { verdict: "clean" };
            },
          },
          scanRequired: true,
        },
        input,
      ),
    ).resolves.toBe("clean");
    expect(seen).toEqual([`tenant-${ORG}/uploads/synthetic:${bytes.byteLength}`]);
  });

  it("returns infected so completion can abort the ledger and destroy the object", async () => {
    await expect(
      scanVerifiedUploadedObject(
        {
          reader: { getObject: async () => bytes },
          scanner: { scan: async () => ({ verdict: "infected" }) },
          scanRequired: true,
        },
        input,
      ),
    ).resolves.toBe("infected");
  });

  it("fails closed when production requires scanning but either dependency is absent", async () => {
    await expect(
      scanVerifiedUploadedObject({ reader: null, scanner: null, scanRequired: true }, input),
    ).rejects.toMatchObject({ code: "DEGRADED", statusCode: 503 });
  });

  it("does not let video bypass a required production scan", async () => {
    await expect(
      scanVerifiedUploadedObject(
        { reader: null, scanner: null, scanRequired: true },
        { ...input, mimeType: "video/mp4" },
      ),
    ).rejects.toMatchObject({ code: "DEGRADED", statusCode: 503 });
  });

  it("rejects objects above the scanner contract before reading them into API memory", async () => {
    let reads = 0;
    await expect(
      scanVerifiedUploadedObject(
        {
          reader: {
            getObject: async () => {
              reads += 1;
              return bytes;
            },
          },
          scanner: { scan: async () => ({ verdict: "clean" }) },
          scanRequired: true,
        },
        { ...input, mimeType: "video/mp4", byteSize: 500 * 1024 * 1024 },
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_SCAN_SIZE_UNSUPPORTED", statusCode: 422 });
    expect(reads).toBe(0);
  });
});

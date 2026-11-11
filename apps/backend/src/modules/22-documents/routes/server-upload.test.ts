// GAP-068 — the single-request upload service: content gate (pure) + store-then-commit ordering over a
// recording fake transaction (no DB, no MinIO). The real-DB/real-MinIO proof is the live suite.
import { createHash } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryObjectStore } from "../seams/store";
import {
  type DocumentContentScanner,
  type ServerUploadDeps,
  type UploadLogger,
  createServerUploadService as createUploadService,
  decodeBase64Content,
  verifyUploadContent,
} from "./server-upload";

/** The production service always has a logger (it is a required dep); a test that does not look at it gets a silent one. */
const silent: UploadLogger = { warn: () => undefined };
const createServerUploadService = (
  deps: Omit<ServerUploadDeps, "logger"> & { logger?: UploadLogger },
) => createUploadService({ logger: silent, ...deps });

vi.mock("@chartwarden/tenancy", () => ({
  // `failCommit` models a COMMIT that fails after the callback finished: the rows may or may not be there.
  withOrgContext: async (
    db: { tx: unknown; failCommit?: boolean | Error },
    _ctx: unknown,
    fn: (tx: unknown) => unknown,
  ) => {
    const result = await fn(db.tx);
    if (db.failCommit)
      throw db.failCommit instanceof Error ? db.failCommit : new Error("commit failed");
    return result;
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111" as never;
const ACTOR = {
  userId: "55555555-5555-4555-8555-555555555555",
  membershipId: "66666666-6666-4666-8666-666666666666",
};
const PDF = new TextEncoder().encode("%PDF-1.7 test body");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ARGS = {
  patientId: null,
  admissionId: null,
  retentionClass: "clinical_record" as const,
  aggregateType: "other",
  aggregateId: null,
  title: "Outside records",
  patientFacing: false,
  tags: [{ tagKind: "free", tagKey: "src", tagValue: null }],
  content: { bytes: PDF, mimeType: "application/pdf" },
};

/** A tx that records inserts per table and answers selects from `selects` in order. */
function fakeDb(
  opts: { failInsertOn?: unknown; selects?: unknown[][]; failCommit?: boolean | Error } = {},
) {
  const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
  const updates: Record<string, unknown>[] = [];
  const selects = [...(opts.selects ?? [])];
  const chain = (rows: unknown[]) => {
    const c = Object.assign(Promise.resolve(rows), {}) as Promise<unknown[]> &
      Record<string, unknown>;
    for (const k of ["from", "where", "orderBy", "limit"]) c[k] = () => c;
    return c;
  };
  const tx = {
    execute: async () => [],
    select: () => chain(selects.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (opts.failInsertOn === table) throw new Error("boom");
        inserts.push({ table, values });
        const out = [{ id: `id-${inserts.length}` }];
        return Object.assign(Promise.resolve(undefined), { returning: async () => out });
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updates.push(v);
        return { where: async () => undefined };
      },
    }),
  };
  const failCommit = opts.failCommit ?? false;
  return { db: { tx, failCommit } as unknown as DbClient, inserts, updates };
}

describe("verifyUploadContent", () => {
  it("returns the server-computed size and digest", () => {
    expect(verifyUploadContent({ bytes: PDF, mimeType: "application/pdf" })).toEqual({
      mimeType: "application/pdf",
      byteSize: PDF.byteLength,
      sha256Hex: sha(PDF),
    });
  });
  it("rejects a disallowed MIME with 415", () => {
    expect(() => verifyUploadContent({ bytes: PDF, mimeType: "text/html" })).toThrowError(
      expect.objectContaining({ statusCode: 415 }),
    );
  });
  it("rejects bytes that do not match the declared MIME", () => {
    expect(() =>
      verifyUploadContent({
        bytes: new TextEncoder().encode("<html>"),
        mimeType: "application/pdf",
      }),
    ).toThrowError(expect.objectContaining({ code: "UPLOAD_CONTENT_MISMATCH" }));
  });
  it("rejects empty content and a declared digest that differs", () => {
    expect(() =>
      verifyUploadContent({ bytes: new Uint8Array(), mimeType: "application/pdf" }),
    ).toThrowError(expect.objectContaining({ code: "UPLOAD_SIZE_INVALID" }));
    expect(() =>
      verifyUploadContent({ bytes: PDF, mimeType: "application/pdf", sha256Hex: "0".repeat(64) }),
    ).toThrowError(expect.objectContaining({ code: "UPLOAD_INTEGRITY_MISMATCH" }));
  });
});

describe("decodeBase64Content", () => {
  it("round-trips and refuses malformed base64", () => {
    expect(decodeBase64Content(Buffer.from(PDF).toString("base64"))).toEqual(PDF);
    expect(() => decodeBase64Content("not base64!!")).toThrowError(
      expect.objectContaining({ statusCode: 422 }),
    );
  });
});

describe("createServerUploadService.createDocument", () => {
  it("stores the object then commits document + version + tag under the actor", async () => {
    const { db, inserts, updates } = fakeDb();
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store });
    const res = await svc.createDocument(ORG, ACTOR, ARGS);
    expect(res).toMatchObject({ versionNumber: 1 });
    expect(mem.objects.size).toBe(1);
    const version = inserts.find((i) => i.table === schema.documentVersions)?.values;
    expect(version).toMatchObject({
      organizationId: ORG,
      byteSize: String(PDF.byteLength),
      sha256Hex: sha(PDF),
      uploadedByMembershipId: ACTOR.membershipId,
      uploadedByKind: "user",
    });
    expect(inserts.some((i) => i.table === schema.documentTags)).toBe(true);
    expect(updates[0]).toHaveProperty("activeVersionId");
  });

  it("returns 503 and stores nothing when no object store is bound", async () => {
    const { db, inserts } = fakeDb();
    const svc = createServerUploadService({ db, objects: null });
    await expect(svc.createDocument(ORG, ACTOR, ARGS)).rejects.toMatchObject({ statusCode: 503 });
    expect(inserts).toHaveLength(0);
  });

  it("fails closed (503) when a scanner is required but not bound, before storing", async () => {
    const { db } = fakeDb();
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store, scanRequired: true });
    await expect(svc.createDocument(ORG, ACTOR, ARGS)).rejects.toMatchObject({ statusCode: 503 });
    expect(mem.objects.size).toBe(0);
  });

  it("refuses an infected verdict without storing", async () => {
    const { db } = fakeDb();
    const mem = createInMemoryObjectStore();
    const scanner: DocumentContentScanner = { scan: async () => ({ verdict: "infected" }) };
    const svc = createServerUploadService({ db, objects: mem.store, scanner });
    await expect(svc.createDocument(ORG, ACTOR, ARGS)).rejects.toMatchObject({ statusCode: 422 });
    expect(mem.objects.size).toBe(0);
  });

  it("removes the stored object when the commit fails", async () => {
    const { db } = fakeDb({ failInsertOn: schema.documentVersions });
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store });
    await expect(svc.createDocument(ORG, ACTOR, ARGS)).rejects.toThrow("boom");
    expect(mem.objects.size).toBe(0);
  });

  it("refuses to file a document under an internal-only aggregate type (render-only), storing nothing", async () => {
    const { db, inserts } = fakeDb();
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store });
    await expect(
      svc.createDocument(ORG, ACTOR, { ...ARGS, aggregateType: "bereavement_physician_letter" }),
    ).rejects.toMatchObject({ code: "DOCUMENT_INTERNAL_ONLY", statusCode: 422 });
    expect(inserts).toHaveLength(0);
    expect(mem.objects.size).toBe(0);
  });

  // The signed BAA is filed once by a platform operator through the onboarding port (createDocumentOn). The tenant-facing upload (this
  // method) must refuse the kind itself: the route schema is not the only thing that keeps a tenant from filing evidence of its own BAA.
  it("refuses an operator-filed kind (tenant_baa) with 409 DOCUMENT_IMMUTABLE, storing nothing", async () => {
    const { db, inserts } = fakeDb();
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store });
    await expect(
      svc.createDocument(ORG, ACTOR, { ...ARGS, aggregateType: "tenant_baa" }),
    ).rejects.toMatchObject({ code: "DOCUMENT_IMMUTABLE", statusCode: 409 });
    expect(inserts).toHaveLength(0);
    expect(mem.objects.size).toBe(0);
  });

  // ADR-0109 D10 (PR 3) — the same org-level rule the verified upload applies (one shared assertion).
  it("refuses a grief-library document that names a patient or an admission, storing nothing", async () => {
    for (const named of [
      { patientId: "44444444-4444-4444-8444-444444444444" },
      { admissionId: "55555555-5555-4555-8555-555555555555" },
    ]) {
      const { db, inserts } = fakeDb();
      const mem = createInMemoryObjectStore();
      const svc = createServerUploadService({ db, objects: mem.store });
      await expect(
        svc.createDocument(ORG, ACTOR, {
          ...ARGS,
          aggregateType: "bereavement_library_item",
          ...named,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
      expect(inserts).toHaveLength(0);
      expect(mem.objects.size).toBe(0);
    }
  });

  it("requires the referral reader for a referral aggregate", async () => {
    const { db } = fakeDb();
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store });
    await expect(
      svc.createDocument(ORG, ACTOR, {
        ...ARGS,
        aggregateType: "referral",
        aggregateId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("createServerUploadService.createDocumentOn", () => {
  // The caller's own transaction: a `withOrgContext` call would reach `db.tx` too in this harness, so the counter on the mock proves the
  // service opened none of its own.
  it("files on the caller's transaction without opening one, and reports what it verified", async () => {
    const { db, inserts } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db: {} as DbClient, objects: mem.store });
    const filed = await svc.createDocumentOn(tx, ORG, ACTOR, ARGS);
    expect(filed).toMatchObject({
      versionNumber: 1,
      mimeType: "application/pdf",
      byteSize: PDF.byteLength,
      sha256Hex: sha(PDF),
    });
    expect(inserts.find((i) => i.table === schema.documents)?.values).toMatchObject({
      organizationId: ORG,
      createdByMembershipId: ACTOR.membershipId,
    });
    expect(mem.objects.size).toBe(1);
  });

  it("still files the operator-filed kind (tenant_baa): the onboarding port's door is createDocumentOn", async () => {
    const { db } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db: {} as DbClient, objects: mem.store });
    await expect(
      svc.createDocumentOn(tx, ORG, ACTOR, { ...ARGS, aggregateType: "tenant_baa" }),
    ).resolves.toMatchObject({ versionNumber: 1 });
    expect(mem.objects.size).toBe(1);
  });

  it("discard() removes the stored object (the caller's later step failed and its transaction rolled back)", async () => {
    const { db } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db: {} as DbClient, objects: mem.store });
    const filed = await svc.createDocumentOn(tx, ORG, ACTOR, ARGS);
    await filed.discard();
    expect(mem.objects.size).toBe(0);
  });

  it("removes the object itself when the insert fails, and still gates on the content first", async () => {
    const { db } = fakeDb({ failInsertOn: schema.documentVersions });
    const { tx } = db as unknown as { tx: DbClient };
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db: {} as DbClient, objects: mem.store });
    await expect(svc.createDocumentOn(tx, ORG, ACTOR, ARGS)).rejects.toThrow("boom");
    expect(mem.objects.size).toBe(0);
    await expect(
      svc.createDocumentOn(tx, ORG, ACTOR, {
        ...ARGS,
        content: { bytes: new TextEncoder().encode("<html>"), mimeType: "application/pdf" },
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_CONTENT_MISMATCH" });
  });
});

describe("createServerUploadService: the put and the commit while the caller holds a transaction", () => {
  /** A store whose put never answers until it is aborted: what a hung object store looks like to a caller holding a transaction. */
  function hangingStore() {
    const destroyed: string[] = [];
    const destroySignals: (AbortSignal | undefined)[] = [];
    const base = createInMemoryObjectStore();
    return {
      destroyed,
      destroySignals,
      store: {
        ...base.store,
        putObject: ({ signal }: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        destroyAllVersions: async ({
          objectKey,
          signal,
        }: { objectKey: string; signal?: AbortSignal }) => {
          destroyed.push(objectKey);
          destroySignals.push(signal);
        },
      } as unknown as ReturnType<typeof createInMemoryObjectStore>["store"],
    };
  }

  it("aborts a put that never answers and answers 503 document-storage, writing no row (createDocumentOn)", async () => {
    const { db, inserts } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const { store, destroyed, destroySignals } = hangingStore();
    const svc = createServerUploadService({
      db: {} as DbClient,
      objects: store,
      heldTimeoutMs: 25,
    });

    await expect(svc.createDocumentOn(tx, ORG, ACTOR, ARGS)).rejects.toMatchObject({
      statusCode: 503,
    });

    expect(inserts).toHaveLength(0);
    expect(destroyed).toHaveLength(1); // a put that timed out may still have landed: cleaned up best effort
    // ... and that clean-up is bounded too: the caller still holds its transaction while it runs
    expect(destroySignals[0]).toBeInstanceOf(AbortSignal);
  });

  it("stops waiting for a put that IGNORES the abort signal (503 document-storage, no row), and cleans up best effort", async () => {
    const { db, inserts } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const base = createInMemoryObjectStore();
    const destroyed: string[] = [];
    const store = {
      ...base.store,
      putObject: () => new Promise<never>(() => undefined), // never settles, signal or not
      destroyAllVersions: async ({ objectKey }: { objectKey: string }) => {
        destroyed.push(objectKey);
      },
    } as unknown as ReturnType<typeof createInMemoryObjectStore>["store"];
    const svc = createServerUploadService({
      db: {} as DbClient,
      objects: store,
      heldTimeoutMs: 25,
    });

    await expect(svc.createDocumentOn(tx, ORG, ACTOR, ARGS)).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining("document-storage"),
    });

    expect(inserts).toHaveLength(0);
    expect(destroyed).toHaveLength(1);
  });

  it("stops waiting for a clean-up delete that ignores the signal: the failure is still answered, the orphan is warned about", async () => {
    const { db } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const base = createInMemoryObjectStore();
    const warn = vi.fn();
    const store = {
      ...base.store,
      putObject: async () => ({ sha256Hex: "f".repeat(64) }), // a digest that is not the verified one: the clean-up runs
      destroyAllVersions: () => new Promise<never>(() => undefined), // never settles, signal or not
    } as unknown as ReturnType<typeof createInMemoryObjectStore>["store"];
    const svc = createServerUploadService({
      db: {} as DbClient,
      objects: store,
      heldTimeoutMs: 25,
      logger: { warn },
    });

    await expect(svc.createDocumentOn(tx, ORG, ACTOR, ARGS)).rejects.toMatchObject({
      code: "UPLOAD_INTEGRITY_MISMATCH",
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toContain("orphan");
  });

  it("gives the scan and the put ONE deadline: a scan and a put that each fit it, but not together, are a 503", async () => {
    const { db, inserts } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const base = createInMemoryObjectStore();
    const later = <T>(ms: number, value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
    const store = {
      ...base.store,
      putObject: async (input: Parameters<typeof base.store.putObject>[0]) => {
        await later(60, undefined); // 60 ms, signal ignored
        return base.store.putObject(input);
      },
    } as unknown as ReturnType<typeof createInMemoryObjectStore>["store"];
    const scanner: DocumentContentScanner = {
      scan: () => later(60, { verdict: "clean" as const }),
    };
    const svc = createServerUploadService({
      db: {} as DbClient,
      objects: store,
      scanner,
      heldTimeoutMs: 100, // 60 + 60 > 100, each alone < 100
    });

    await expect(svc.createDocumentOn(tx, ORG, ACTOR, ARGS)).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining("document-storage"),
    });

    expect(inserts).toHaveLength(0);
  });

  it("warns, naming the objectKey, when a put is abandoned at the deadline, and deletes the object AGAIN if the abandoned put lands late", async () => {
    const { db } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const base = createInMemoryObjectStore();
    const destroyed: string[] = [];
    const warn = vi.fn();
    const store = {
      ...base.store,
      putObject: () =>
        new Promise((resolve) => setTimeout(() => resolve({ sha256Hex: sha(PDF) }), 120)), // ignores the signal, lands after the deadline
      destroyAllVersions: async ({ objectKey }: { objectKey: string }) => {
        destroyed.push(objectKey);
      },
    } as unknown as ReturnType<typeof createInMemoryObjectStore>["store"];
    const svc = createServerUploadService({
      db: {} as DbClient,
      objects: store,
      heldTimeoutMs: 25,
      logger: { warn },
    });

    await expect(svc.createDocumentOn(tx, ORG, ACTOR, ARGS)).rejects.toMatchObject({
      statusCode: 503,
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      objectKey: expect.stringMatching(/^uploads\//),
    });
    expect(warn.mock.calls[0]?.[1]).toContain("abandoned");
    expect(warn.mock.calls[0]?.[1]).toContain("reconcile by objectKey");
    expect(destroyed).toHaveLength(1); // the clean-up made at the deadline
    await vi.waitFor(() => expect(destroyed).toHaveLength(2)); // ... and again once the abandoned put settled
    expect(destroyed[1]).toBe(destroyed[0]);
  });

  it("does not delete again when the abandoned put fails late (nothing landed)", async () => {
    const { db } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const base = createInMemoryObjectStore();
    const destroyed: string[] = [];
    let failLate: () => void = () => undefined;
    const store = {
      ...base.store,
      putObject: () =>
        new Promise((_resolve, reject) => {
          failLate = () => reject(new Error("late"));
        }),
      destroyAllVersions: async ({ objectKey }: { objectKey: string }) => {
        destroyed.push(objectKey);
      },
    } as unknown as ReturnType<typeof createInMemoryObjectStore>["store"];
    const svc = createServerUploadService({
      db: {} as DbClient,
      objects: store,
      heldTimeoutMs: 25,
    });
    await expect(svc.createDocumentOn(tx, ORG, ACTOR, ARGS)).rejects.toMatchObject({
      statusCode: 503,
    });
    failLate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(destroyed).toHaveLength(1);
  });

  it("warns, naming the objectKey, when the clean-up itself fails: the orphan is not silent", async () => {
    const { db } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const base = createInMemoryObjectStore();
    const warn = vi.fn();
    const store = {
      ...base.store,
      putObject: async () => ({ sha256Hex: "f".repeat(64) }), // not the verified digest: the clean-up runs
      destroyAllVersions: async () => {
        throw new Error("store refused the delete");
      },
    } as unknown as ReturnType<typeof createInMemoryObjectStore>["store"];
    const svc = createServerUploadService({
      db: {} as DbClient,
      objects: store,
      heldTimeoutMs: 25,
      logger: { warn },
    });

    await expect(svc.createDocumentOn(tx, ORG, ACTOR, ARGS)).rejects.toMatchObject({
      code: "UPLOAD_INTEGRITY_MISMATCH",
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      objectKey: expect.stringMatching(/^uploads\//),
    });
    expect(warn.mock.calls[0]?.[1]).toContain("reconcile by objectKey");
  });

  it("bounds the clean-up after an integrity mismatch and the discard() the same way, and a generic upload (no transaction held) stays unbounded", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const base = createInMemoryObjectStore();
    const lyingStore = {
      ...base.store,
      putObject: async () => ({ sha256Hex: "f".repeat(64) }), // the store reports a digest that is not the verified one
      destroyAllVersions: async ({ signal }: { signal?: AbortSignal }) => {
        signals.push(signal);
      },
    } as unknown as ReturnType<typeof createInMemoryObjectStore>["store"];
    const { db } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const held = createServerUploadService({ db: {} as DbClient, objects: lyingStore });
    await expect(held.createDocumentOn(tx, ORG, ACTOR, ARGS)).rejects.toMatchObject({
      code: "UPLOAD_INTEGRITY_MISMATCH",
    });
    expect(signals[0]).toBeInstanceOf(AbortSignal);

    const honest = createServerUploadService({
      db: {} as DbClient,
      objects: {
        ...base.store,
        destroyAllVersions: async ({ signal }: { signal?: AbortSignal }) => {
          signals.push(signal);
        },
      } as unknown as ReturnType<typeof createInMemoryObjectStore>["store"],
    });
    const filed = await honest.createDocumentOn(tx, ORG, ACTOR, ARGS);
    await filed.discard();
    expect(signals[1]).toBeInstanceOf(AbortSignal);

    // the generic upload opens its own transaction AFTER the put and holds none during it: nothing to bound
    const generic = createServerUploadService({
      db: fakeDb({ failInsertOn: schema.documentVersions }).db,
      objects: {
        ...base.store,
        destroyAllVersions: async ({ signal }: { signal?: AbortSignal }) => {
          signals.push(signal);
        },
      } as unknown as ReturnType<typeof createInMemoryObjectStore>["store"],
    });
    await expect(generic.createDocument(ORG, ACTOR, ARGS)).rejects.toThrow("boom");
    expect(signals[2]).toBeUndefined();
  });

  it("stops waiting for a scanner that never answers while the transaction is held: 503 document-scanner, nothing stored, no row", async () => {
    const { db, inserts } = fakeDb();
    const { tx } = db as unknown as { tx: DbClient };
    const mem = createInMemoryObjectStore();
    const scanner: DocumentContentScanner = { scan: () => new Promise(() => undefined) };
    const svc = createServerUploadService({
      db: {} as DbClient,
      objects: mem.store,
      scanner,
      heldTimeoutMs: 25,
    });

    await expect(svc.createDocumentOn(tx, ORG, ACTOR, ARGS)).rejects.toMatchObject({
      statusCode: 503,
    });

    expect(mem.objects.size).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("keeps the object, and logs it, when the COMMIT itself fails after the rows were written WITHOUT an answer from the database (the document may exist)", async () => {
    const { db } = fakeDb({ failCommit: true });
    const mem = createInMemoryObjectStore();
    const warn = vi.fn();
    const svc = createServerUploadService({ db, objects: mem.store, logger: { warn } });

    await expect(svc.createDocument(ORG, ACTOR, ARGS)).rejects.toThrow("commit failed");

    expect(mem.objects.size).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      objectKey: expect.stringMatching(/^uploads\//),
    });
    expect(warn.mock.calls[0]?.[1]).toContain("reconcile by objectKey");
  });

  it("removes the object when the COMMIT fails WITH a SQLSTATE: the database answered no and rolled back, so the object points at nothing", async () => {
    const refused = Object.assign(new Error("could not serialize access"), {
      code: "40001",
      severity: "ERROR",
    });
    const { db } = fakeDb({ failCommit: refused });
    const mem = createInMemoryObjectStore();
    const warn = vi.fn();
    const svc = createServerUploadService({ db, objects: mem.store, logger: { warn } });

    await expect(svc.createDocument(ORG, ACTOR, ARGS)).rejects.toThrow("could not serialize");

    expect(mem.objects.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["08P01", "a protocol violation answered by a pooler"],
    ["57P01", "an admin shutdown"],
    ["40003", "statement completion unknown"],
    ["58030", "a server I/O error"],
    ["XX000", "an internal error"],
  ])(
    "KEEPS the object when the COMMIT fails with SQLSTATE %s (%s): the database spoke, but the outcome is unknown",
    async (code) => {
      const unknown = Object.assign(new Error(`terminated ${code}`), { code, severity: "FATAL" });
      const { db } = fakeDb({ failCommit: unknown });
      const mem = createInMemoryObjectStore();
      const warn = vi.fn();
      const svc = createServerUploadService({ db, objects: mem.store, logger: { warn } });

      await expect(svc.createDocument(ORG, ACTOR, ARGS)).rejects.toThrow(`terminated ${code}`);

      expect(mem.objects.size).toBe(1);
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it("finds the SQLSTATE on the cause of a wrapped error (a driver wrapper), and a Node EPIPE is not a SQLSTATE", async () => {
    const wrapped = Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error("deadlock detected"), { code: "40P01", severity: "ERROR" }),
    });
    const a = createInMemoryObjectStore();
    await expect(
      createServerUploadService({
        db: fakeDb({ failCommit: wrapped }).db,
        objects: a.store,
      }).createDocument(ORG, ACTOR, ARGS),
    ).rejects.toThrow("Failed query");
    expect(a.objects.size).toBe(0); // the database answered: rolled back

    const b = createInMemoryObjectStore();
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); // five uppercase characters, but not the database
    await expect(
      createServerUploadService({
        db: fakeDb({ failCommit: epipe }).db,
        objects: b.store,
      }).createDocument(ORG, ACTOR, ARGS),
    ).rejects.toThrow("EPIPE");
    expect(b.objects.size).toBe(1); // the connection died: the commit may have landed
  });

  it("still removes the object when the failure was inside the transaction (rolled back)", async () => {
    const { db } = fakeDb({ failInsertOn: schema.documentVersions, failCommit: true });
    const mem = createInMemoryObjectStore();
    const warn = vi.fn();
    const svc = createServerUploadService({ db, objects: mem.store, logger: { warn } });

    await expect(svc.createDocument(ORG, ACTOR, ARGS)).rejects.toThrow("boom");

    expect(mem.objects.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("createServerUploadService.createVersion", () => {
  const DOC_ID = "44444444-4444-4444-8444-444444444444";
  const writable = { id: DOC_ID, status: "active", aggregateType: "other", activeVersionId: "v1" };

  it("numbers the new version after the highest existing one and chains replacesVersionId", async () => {
    const { db, inserts } = fakeDb({
      // pre-check: doc, hold(none); commit: doc, hold(none), versions
      selects: [[writable], [], [writable], [], [{ versionNumber: "1" }, { versionNumber: "2" }]],
    });
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store });
    const res = await svc.createVersion(ORG, ACTOR, DOC_ID, { content: ARGS.content });
    expect(res.versionNumber).toBe(3);
    expect(inserts[0]?.values).toMatchObject({ versionNumber: "3", replacesVersionId: "v1" });
  });

  it("refuses a tenant_baa document with 409 DOCUMENT_IMMUTABLE and stores nothing: the generic upload cannot add a version to the signed BAA", async () => {
    const { db } = fakeDb({ selects: [[{ ...writable, aggregateType: "tenant_baa" }], []] });
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store });
    await expect(
      svc.createVersion(ORG, ACTOR, DOC_ID, { content: ARGS.content }),
    ).rejects.toMatchObject({ statusCode: 409, code: "DOCUMENT_IMMUTABLE" });
    expect(mem.objects.size).toBe(0);
  });

  it("refuses a new version of an internal-only document (render-only), storing nothing", async () => {
    const { db } = fakeDb({
      selects: [[{ ...writable, aggregateType: "bereavement_discharge_summary" }]],
    });
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store });
    await expect(
      svc.createVersion(ORG, ACTOR, DOC_ID, { content: ARGS.content }),
    ).rejects.toMatchObject({ code: "DOCUMENT_INTERNAL_ONLY", statusCode: 422 });
    expect(mem.objects.size).toBe(0);
  });

  it("refuses a legal-hold document with 409 and stores nothing", async () => {
    const { db } = fakeDb({ selects: [[{ ...writable, status: "legal_hold" }], []] });
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store });
    await expect(
      svc.createVersion(ORG, ACTOR, DOC_ID, { content: ARGS.content }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mem.objects.size).toBe(0);
  });

  it("refuses an ACTIVE-status document that has an unreleased legal-hold row, storing nothing", async () => {
    const { db } = fakeDb({ selects: [[writable], [{ id: "hold-1" }]] });
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store });
    await expect(
      svc.createVersion(ORG, ACTOR, DOC_ID, { content: ARGS.content }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mem.objects.size).toBe(0);
  });

  it("re-checks the legal hold inside the commit and removes the stored object when one landed meanwhile", async () => {
    const { db, inserts } = fakeDb({
      selects: [[writable], [], [writable], [{ id: "hold-1" }]],
    });
    const mem = createInMemoryObjectStore();
    const svc = createServerUploadService({ db, objects: mem.store });
    await expect(
      svc.createVersion(ORG, ACTOR, DOC_ID, { content: ARGS.content }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(inserts.some((i) => i.table === schema.documentVersions)).toBe(false);
    expect(mem.objects.size).toBe(0);
  });

  it("404s a missing document", async () => {
    const { db } = fakeDb({ selects: [[]] });
    const svc = createServerUploadService({ db, objects: createInMemoryObjectStore().store });
    await expect(
      svc.createVersion(ORG, ACTOR, DOC_ID, { content: ARGS.content }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

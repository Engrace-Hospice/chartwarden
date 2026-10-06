// GAP-068 — the single-request upload service: content gate (pure) + store-then-commit ordering over a
// recording fake transaction (no DB, no MinIO). The real-DB/real-MinIO proof is the live suite.
import { createHash } from "node:crypto";
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryObjectStore } from "../seams/store";
import {
  type DocumentContentScanner,
  createServerUploadService,
  decodeBase64Content,
  verifyUploadContent,
} from "./server-upload";

vi.mock("@wardenx/tenancy", () => ({
  withOrgContext: async (db: { tx: unknown }, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn(db.tx),
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
function fakeDb(opts: { failInsertOn?: unknown; selects?: unknown[][] } = {}) {
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
  return { db: { tx } as unknown as DbClient, inserts, updates };
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

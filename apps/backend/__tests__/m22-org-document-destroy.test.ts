// CW-BR-10 — M22's org-level destroy and list seam (`OrgDocumentAccessProvider.destroyOrgDocument` / `listOrgDocumentsForPurge`) over a fake port and the
// in-memory object store: the refusals, objects-before-rows, an interrupted destroy that retries, and that only a seam-only type is ever touched.
import type { DocumentAggregateType, DocumentId, OrgId } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  type OrgDocumentAccessPort,
  type OrgDocumentDestroyTarget,
  createOrgDocumentAccessProvider,
} from "../src/modules/22-documents/seams/org-document-access";
import { createInMemoryObjectStore } from "../src/modules/22-documents/seams/store";

const ORG = "a1630000-0000-4000-8000-0000000000a1" as OrgId;
const DOC = "d1630000-0000-4000-8000-0000000000d1" as DocumentId;
const BATCH: DocumentAggregateType = "bereavement_mailing_batch";
const BUCKET = `tenant-${ORG}`;

function setup(
  target: OrgDocumentDestroyTarget | null,
  opts: { marks?: boolean; storeFails?: boolean } = {},
) {
  const store = createInMemoryObjectStore();
  const events: string[] = [];
  const destroyed: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const port: OrgDocumentAccessPort = {
    async loadDocument() {
      return null;
    },
    async activeMembershipId() {
      return null;
    },
    async listPurgeCandidates({ limit }) {
      events.push(`list:${limit}`);
      return Array.from({ length: limit }, (_, i) => ({
        documentId: `doc-${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
        held: i === 0,
      }));
    },
    async loadDestroyTarget() {
      return target;
    },
    async markDestroyed() {
      events.push("mark");
      return opts.marks ?? true;
    },
  };
  const provider = createOrgDocumentAccessProvider({
    port,
    objects: {
      presign: store.store.presign,
      async destroyAllVersions(args) {
        if (opts.storeFails) throw new Error("store down");
        signals.push(args.signal);
        events.push(`destroy:${args.objectKey}`);
        destroyed.push(`${args.bucket}/${args.objectKey}`);
        return store.store.destroyAllVersions(args);
      },
    },
    accessLog: {
      async append() {
        throw new Error("no ledger row for a destroy");
      },
    },
  });
  return { provider, events, destroyed, signals };
}

const healthy: OrgDocumentDestroyTarget = {
  aggregateType: BATCH,
  patientId: null,
  status: "active",
  held: false,
  objectKeys: ["documents/org/k1", "documents/org/k2"],
};
const destroy = (
  p: ReturnType<typeof setup>["provider"],
  allowed: DocumentAggregateType[] = [BATCH],
) => p.destroyOrgDocument({ organizationId: ORG, documentId: DOC, allowedAggregateTypes: allowed });

describe("CW-BR-10 — M22 destroyOrgDocument", () => {
  it("destroys every version's object in the tenant's own bucket, then marks the row, in that order", async () => {
    const { provider, events, destroyed } = setup(healthy);
    expect(await destroy(provider)).toEqual({ destroyed: true, objectVersionsDestroyed: 2 });
    expect(events).toEqual(["destroy:documents/org/k1", "destroy:documents/org/k2", "mark"]);
    expect(destroyed).toEqual([`${BUCKET}/documents/org/k1`, `${BUCKET}/documents/org/k2`]);
  });

  it("bounds every object delete with an abort signal (the caller may hold a lock across it)", async () => {
    const { provider, signals } = setup(healthy);
    await destroy(provider);
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a missing document without touching anything", async () => {
    const { provider, events } = setup(null);
    expect(await destroy(provider)).toEqual({ refused: true, reason: "not_found" });
    expect(events).toEqual([]);
  });

  it.each([
    ["a library item (never the seam's to destroy)", "bereavement_library_item"],
    ["a physician letter", "bereavement_physician_letter"],
  ])("refuses %s as the wrong type", async (_label, aggregateType) => {
    const { provider, events } = setup({ ...healthy, aggregateType });
    expect(await destroy(provider, [BATCH, aggregateType as DocumentAggregateType])).toEqual({
      refused: true,
      reason: "wrong_type",
    });
    expect(events).toEqual([]);
  });

  it("refuses a batch the CALLER did not allow", async () => {
    const { provider, events } = setup(healthy);
    expect(await destroy(provider, [])).toEqual({ refused: true, reason: "wrong_type" });
    expect(events).toEqual([]);
  });

  it("refuses a document that belongs to a patient", async () => {
    const { provider, events } = setup({ ...healthy, patientId: "p1" });
    expect(await destroy(provider)).toEqual({ refused: true, reason: "not_org_level" });
    expect(events).toEqual([]);
  });

  it("a second destroy is already_destroyed, not an error and not another delete", async () => {
    const { provider, events } = setup({ ...healthy, status: "destroyed_tombstone" });
    expect(await destroy(provider)).toEqual({ refused: true, reason: "already_destroyed" });
    expect(events).toEqual([]);
  });

  it.each([
    ["a hold row or Part 2 class", { held: true }],
    ["status legal_hold", { status: "legal_hold" }],
  ])("never destroys a held document (%s)", async (_label, over) => {
    const { provider, events } = setup({ ...healthy, ...over });
    expect(await destroy(provider)).toEqual({ refused: true, reason: "held" });
    expect(events).toEqual([]);
  });

  it("a failed object delete throws with the row untouched, so the next run retries", async () => {
    const { provider, events } = setup(healthy, { storeFails: true });
    await expect(destroy(provider)).rejects.toThrow("store down");
    expect(events).toEqual([]);
  });

  it("refuses by throwing, before anything is touched, when no object store is bound for deletes", async () => {
    const events: string[] = [];
    const provider = createOrgDocumentAccessProvider({
      port: {
        async loadDocument() {
          return null;
        },
        async activeMembershipId() {
          return null;
        },
        async listPurgeCandidates() {
          return [];
        },
        async loadDestroyTarget() {
          return healthy;
        },
        async markDestroyed() {
          events.push("mark");
          return true;
        },
      },
      objects: { presign: createInMemoryObjectStore().store.presign },
      accessLog: { async append() {} },
    });
    await expect(destroy(provider)).rejects.toThrow(/no object store is bound for deletes/);
    expect(events).toEqual([]);
  });

  it("refuses by throwing, before anything is touched, when no object store is bound for deletes", async () => {
    const events: string[] = [];
    const provider = createOrgDocumentAccessProvider({
      port: {
        async loadDocument() {
          return null;
        },
        async activeMembershipId() {
          return null;
        },
        async listPurgeCandidates() {
          return [];
        },
        async loadDestroyTarget() {
          return healthy;
        },
        async markDestroyed() {
          events.push("mark");
          return true;
        },
      },
      objects: { presign: createInMemoryObjectStore().store.presign },
      accessLog: { async append() {} },
    });
    await expect(destroy(provider)).rejects.toThrow(/no object store is bound for deletes/);
    expect(events).toEqual([]);
  });

  it("a hold that lands between the check and the row change leaves the row as it was and answers held_after_destroy (the bytes are gone, so the caller alarms)", async () => {
    const { provider, events } = setup(healthy, { marks: false });
    expect(await destroy(provider)).toEqual({ refused: true, reason: "held_after_destroy" });
    expect(events.at(-1)).toBe("mark");
  });
});

describe("CW-BR-10 — M22 listOrgDocumentsForPurge", () => {
  it("is denied for any type that is not seam-only", async () => {
    const { provider, events } = setup(null);
    for (const type of [
      "bereavement_library_item",
      "bereavement_physician_letter",
      "cti",
    ] as DocumentAggregateType[]) {
      expect(
        await provider.listOrgDocumentsForPurge({
          organizationId: ORG,
          aggregateType: type,
          createdBefore: "2027-01-01T00:00:00.000Z" as never,
          limit: 5,
        }),
      ).toEqual({ denied: true, reason: "wrong_type" });
    }
    expect(events).toEqual([]);
  });

  it("asks the port for one more than the limit and says truncated only when it got it", async () => {
    const { provider, events } = setup(null);
    const out = await provider.listOrgDocumentsForPurge({
      organizationId: ORG,
      aggregateType: BATCH,
      createdBefore: "2027-01-01T00:00:00.000Z" as never,
      limit: 3,
    });
    expect(events).toEqual(["list:4"]);
    if ("denied" in out) throw new Error("unexpected denial");
    expect(out.truncated).toBe(true);
    expect(out.documents).toHaveLength(3);
    // ids, an ISO timestamp and the hold flag: nothing else leaves the seam
    expect(Object.keys(out.documents[0] as object).sort()).toEqual([
      "createdAt",
      "documentId",
      "held",
    ]);
    expect(out.documents[0]).toMatchObject({ documentId: "doc-0", held: true });
    expect(out.documents[1]?.createdAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

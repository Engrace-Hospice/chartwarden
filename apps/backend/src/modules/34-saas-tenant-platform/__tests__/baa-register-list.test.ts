// The BAA register list (in-memory twin): the governing record is judged over each tenant's whole register, before the status
// filter, and M22's filed check runs only for a governing row on the returned page.
import { describe, expect, it, vi } from "vitest";
import { createInMemoryTenantPlatformBackend } from "../routes/platform/service";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const seed = {
  baaRecords: [
    // Each tenant: an undated termination (it governs) and an older executed record (it does not).
    {
      id: "t1-term",
      tenantAccountId: T1,
      addendumVersion: "v2",
      baaStatus: "terminated",
      documentId: "doc-t1-term",
    },
    {
      id: "t1-exec",
      tenantAccountId: T1,
      addendumVersion: "v1",
      baaStatus: "executed",
      executedOn: "2026-01-01",
      documentId: "doc-t1-exec",
    },
    {
      id: "t2-term",
      tenantAccountId: T2,
      addendumVersion: "v2",
      baaStatus: "terminated",
      documentId: "doc-t2-term",
    },
    {
      id: "t2-exec",
      tenantAccountId: T2,
      addendumVersion: "v1",
      baaStatus: "executed",
      executedOn: "2026-02-01",
      documentId: "doc-t2-exec",
    },
  ],
};

function backend() {
  const isFiled = vi.fn(async () => true);
  const { service } = createInMemoryTenantPlatformBackend(seed, { baaDocumentFiled: isFiled });
  return { service, isFiled };
}

describe("listBaaRecords (in-memory)", () => {
  it("a status filter does not change which record governs: no executed row governs when an undated termination does", async () => {
    const { service, isFiled } = backend();
    const page = await service.listBaaRecords({ status: "executed" }, undefined, 50);
    expect(page.items.map((r) => r.id).sort()).toEqual(["t1-exec", "t2-exec"]);
    expect(page.items.every((r) => r.governing === false && r.documentFiled === null)).toBe(true);
    expect(isFiled).not.toHaveBeenCalled();
  });

  it("asks M22 only about the governing row on the page (limit 1), never about the rows on other pages", async () => {
    const { service, isFiled } = backend();
    const page = await service.listBaaRecords({ status: "terminated" }, undefined, 1);
    expect(page.items).toHaveLength(1);
    const [row] = page.items;
    expect(row).toMatchObject({ governing: true, documentFiled: true });
    expect(isFiled).toHaveBeenCalledTimes(1);
    expect(isFiled).toHaveBeenCalledWith({
      organizationId: row?.organizationId,
      documentId: row?.documentId,
    });
  });

  it("a page holding no governing row makes no M22 call", async () => {
    const { service, isFiled } = backend();
    const page = await service.listBaaRecords({}, undefined, 1);
    expect(page.items[0]?.governing).toBe(false);
    expect(isFiled).not.toHaveBeenCalled();
  });
});

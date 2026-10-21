import { randomBytes } from "node:crypto";
/**
 * GAP-087 — R-14 / R-11 / R-15 over the Drizzle route services (no database; see `_fake-drizzle.ts`).
 * R-14 persists a real job row and enqueues it onto `m30.cahps_export` (it used to return a random "queued" id
 * nothing could run); R-11 seals a supplied vendor configuration; R-15 reads the job back with a download path.
 */
import { CAHPS_ADAPTER_FACTORIES } from "@chartwarden/cahps-vendors";
import { describe, expect, it, vi } from "vitest";
import { readExportFile } from "../src/modules/30-quality/cahps/export-job-store";
import { createCahpsPhiCipher } from "../src/modules/30-quality/cahps/phi-cipher";
import type { M30ReadActor, M30WriteActor } from "../src/modules/30-quality/routes/actor";
import { buildDrizzleM30ReadService } from "../src/modules/30-quality/routes/read-service-drizzle";
import { buildDrizzleM30WriteService } from "../src/modules/30-quality/routes/write-service-drizzle";
import { fakeDb } from "./_fake-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const BINDING = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const actor = {
  organizationId: ORG,
  userId: "55555555-5555-4555-8555-555555555555",
} as M30WriteActor;

const bindingRow = {
  id: BINDING,
  organizationId: ORG,
  vendorAdapterId: "manual",
  active: true,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveUntil: null,
  configurationCipher: "pending_secure_configuration",
};
const pendingSample = { id: "s1", organizationId: ORG, status: "pending_export" };
const jobRow = (over: Record<string, unknown> = {}) => ({
  id: JOB,
  organizationId: ORG,
  vendorBindingId: BINDING,
  vendorAdapterId: "manual",
  samplingCycleMonth: "2026-09-01",
  samplePeriodStart: "2026-09-01",
  samplePeriodEnd: "2026-09-30",
  status: "queued",
  decedentCount: 1,
  filename: null,
  mimeType: null,
  fileCipher: null,
  fileSha256: null,
  pushStatus: null,
  vendorJobId: null,
  failureReason: null,
  requestedByUserId: actor.userId,
  createdAt: new Date("2026-10-05T00:00:00.000Z"),
  startedAt: null,
  completedAt: null,
  ...over,
});
const ARGS = {
  samplePeriodStart: "2026-09-01T00:00:00.000Z",
  samplePeriodEnd: "2026-09-30T23:59:59.000Z",
};

describe("R-14 createCahpsExport", () => {
  it("persists a queued job and enqueues it onto m30.cahps_export", async () => {
    const { db } = fakeDb({
      cahps_vendor_binding: [bindingRow],
      cahps_decedent_sample: [pendingSample],
      cahps_export_job: [jobRow()],
    });
    const enqueue = vi.fn(async () => ({ jobId: "bull-1" }));
    const service = buildDrizzleM30WriteService(db, { recompute: { enqueue } });

    const view = await service.createCahpsExport(actor, ARGS);

    expect(view).toMatchObject({
      exportId: JOB,
      status: "queued",
      decedentCount: 1,
      downloadUrl: null,
      vendorAdapterId: "manual",
    });
    expect(enqueue).toHaveBeenCalledWith(
      "m30.cahps_export",
      `${ORG}:${JOB}`,
      expect.objectContaining({
        exportId: JOB,
        organizationId: ORG,
        samplingCycleMonth: "2026-09-01",
        vendorBindingId: BINDING,
      }),
    );
  });

  it("refuses without an active binding, and when nothing is pending export", async () => {
    const none = buildDrizzleM30WriteService(fakeDb({}).db);
    await expect(none.createCahpsExport(actor, ARGS)).rejects.toThrow(
      /no active CAHPS vendor binding/,
    );
    const empty = buildDrizzleM30WriteService(fakeDb({ cahps_vendor_binding: [bindingRow] }).db);
    await expect(empty.createCahpsExport(actor, ARGS)).rejects.toThrow(
      /no sampled decedents pending/,
    );
  });

  it("closes the job out as failed when it cannot be enqueued (no queued ghost)", async () => {
    const { db, rec } = fakeDb({
      cahps_vendor_binding: [bindingRow],
      cahps_decedent_sample: [pendingSample],
      cahps_export_job: [jobRow()],
    });
    const service = buildDrizzleM30WriteService(db, {
      recompute: {
        enqueue: async () => {
          throw new Error("valkey down");
        },
      },
    });
    await expect(service.createCahpsExport(actor, ARGS)).rejects.toThrow("valkey down");
    expect(
      rec.updates.some((u) => u.table === "cahps_export_job" && u.set.status === "failed"),
    ).toBe(true);
  });
});

describe("R-15 getCahpsExport", () => {
  const reader = { organizationId: ORG, userId: actor.userId } as M30ReadActor;

  it("returns the job with a download path once completed", async () => {
    const { db } = fakeDb({
      cahps_export_job: [
        jobRow({
          status: "completed",
          fileCipher: "v1.x.y.z.w",
          fileSha256: "ab",
          filename: "cahps.csv",
          mimeType: "text/csv",
          completedAt: new Date("2026-10-05T00:01:00.000Z"),
        }),
      ],
    });
    const view = await buildDrizzleM30ReadService(db).getCahpsExport(reader, JOB);
    expect(view.status).toBe("completed");
    expect(view.downloadUrl).toBe(`/api/v1/quality/cahps/export/${JOB}/file`);
    expect(view.completedAt).toBe("2026-10-05T00:01:00.000Z");
  });

  it("404s an unknown job and never exposes a path before completion", async () => {
    await expect(
      buildDrizzleM30ReadService(fakeDb({}).db).getCahpsExport(reader, JOB),
    ).rejects.toMatchObject({ statusCode: 404 });
    const { db } = fakeDb({ cahps_export_job: [jobRow({ status: "running" })] });
    expect(
      (await buildDrizzleM30ReadService(db).getCahpsExport(reader, JOB)).downloadUrl,
    ).toBeNull();
  });
});

describe("R-11 bindCahpsVendor configuration", () => {
  const ring = new Map([["v1", randomBytes(32)]]);
  const cipher = createCahpsPhiCipher({
    dekForOrg: async () => ({ version: "v1", key: ring.get("v1") as Buffer }),
    dekForOrgVersion: async (_o, v) => ({ version: v, key: ring.get(v) as Buffer }),
  });
  const base = { vendorAdapterId: "manual", effectiveFrom: "2026-10-01" };

  it("seals a supplied configuration (never stores it in the clear)", async () => {
    const { db, rec } = fakeDb({ cahps_vendor_binding: [bindingRow] });
    const service = buildDrizzleM30WriteService(db, {
      cahpsCipher: cipher,
      cahpsAdapterFactories: CAHPS_ADAPTER_FACTORIES,
    });
    await service.bindCahpsVendor(actor, { ...base, configuration: { accountId: "acct-1" } });
    const inserted = rec.inserts.find((i) => i.table === "cahps_vendor_binding");
    expect(String(inserted?.values.configurationCipher)).not.toContain("acct-1");
    expect(String(inserted?.values.configurationCipher)).toMatch(/^v1\./);
  });

  it("keeps the placeholder when no configuration is supplied, and refuses one it cannot seal", async () => {
    const { db, rec } = fakeDb({ cahps_vendor_binding: [bindingRow] });
    await buildDrizzleM30WriteService(db).bindCahpsVendor(actor, base);
    expect(
      rec.inserts.find((i) => i.table === "cahps_vendor_binding")?.values.configurationCipher,
    ).toBe("pending_secure_configuration");
    await expect(
      buildDrizzleM30WriteService(fakeDb({}).db).bindCahpsVendor(actor, {
        ...base,
        configuration: { a: 1 },
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("rejects a configuration the vendor adapter does not accept", async () => {
    const service = buildDrizzleM30WriteService(fakeDb({}).db, {
      cahpsCipher: cipher,
      cahpsAdapterFactories: CAHPS_ADAPTER_FACTORIES,
    });
    await expect(
      service.bindCahpsVendor(actor, {
        vendorAdapterId: "shp",
        effectiveFrom: "2026-10-01",
        configuration: {},
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("R-15b readExportFile", () => {
  const ring = new Map([["v1", randomBytes(32)]]);
  const cipher = createCahpsPhiCipher({
    dekForOrg: async () => ({ version: "v1", key: ring.get("v1") as Buffer }),
    dekForOrgVersion: async (_o, v) => ({ version: v, key: ring.get(v) as Buffer }),
  });

  it("opens the sealed artifact of a completed job, and nothing before that", async () => {
    const sealed = await cipher.encrypt(
      ORG,
      "cahps_export_job.file_cipher",
      "id,name\n1,Jane Doe\n",
    );
    const done = fakeDb({
      cahps_export_job: [
        jobRow({
          status: "completed",
          fileCipher: sealed.envelope,
          filename: "cahps.csv",
          mimeType: "text/csv",
        }),
      ],
    });
    const file = await readExportFile(done.db, cipher, ORG, JOB);
    expect(file?.filename).toBe("cahps.csv");
    expect(file?.bytes.toString("utf8")).toContain("Jane Doe");

    const running = fakeDb({ cahps_export_job: [jobRow({ status: "running" })] });
    await expect(readExportFile(running.db, cipher, ORG, JOB)).resolves.toBeNull();
    await expect(readExportFile(fakeDb({}).db, cipher, ORG, JOB)).resolves.toBeNull();
  });
});

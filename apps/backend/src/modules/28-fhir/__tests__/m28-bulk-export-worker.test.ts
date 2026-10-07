// GAP-084 — the bulk-export worker's decisions, with the Drizzle store mocked (the live suite proves the SQL):
// the claim is exactly-once, the request-time checks are RE-RUN at execution time (client status, BAA, scopes),
// the D3-gated projection is the only source of bytes, a cancel or an over-cap job never reports `completed`,
// and a failure destroys whatever it had put and fails the job with a PHI-free reason.
import { createHash } from "node:crypto";
import type { FhirReadDisclosureEnvelope } from "@wardenx/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  claimExportJob: vi.fn(),
  loadExportClient: vi.fn(),
  loadExportConfig: vi.fn(),
  exportJobStatus: vi.fn(),
  completeExportJob: vi.fn(),
  failExportJob: vi.fn(),
}));
vi.mock("../jobs/export-store", () => store);

import { type BulkExportWorkerDeps, runBulkExportJob } from "../jobs/bulk-export-worker";
import { buildFhirExportObjectStore } from "../jobs/object-store-adapter";
import { parseBulkExportJobData } from "../jobs/workers";

const ORG = "11111111-1111-1111-1111-111111111111";
const JOB = "22222222-2222-2222-2222-222222222222";
const CLIENT = "33333333-3333-3333-3333-333333333333";
const P1 = "44444444-4444-4444-4444-444444444441";
const P2 = "44444444-4444-4444-4444-444444444442";
type PutArgs = { organizationId: string; objectKey: string; bytes: Uint8Array };
const NOW = new Date("2026-10-05T12:00:00.000Z");

const job = (over: Record<string, unknown> = {}) => ({
  id: JOB,
  organizationId: ORG,
  clientId: CLIENT,
  requestKind: "system",
  groupId: null,
  patientIds: null,
  resourceTypes: ["Patient", "Encounter"],
  since: null,
  initiatedByMembershipId: null,
  ...over,
});
const client = (over: Record<string, unknown> = {}) => ({
  id: CLIENT,
  status: "active",
  allowedScopes: ["system/Patient.read", "system/Encounter.read"],
  baaContractReference: "baa-1",
  ...over,
});

function makeDeps(over: Partial<BulkExportWorkerDeps> = {}) {
  const put = vi.fn(async ({ bytes }: PutArgs) => ({
    sha256Hex: createHash("sha256").update(bytes).digest("hex"),
  }));
  const destroy = vi.fn(async () => {});
  const recordDisclosure = vi.fn(async (_e: FhirReadDisclosureEnvelope) => {});
  const project = vi.fn(async (_ctx, type: string, params: { patient?: string; _id?: string }) => ({
    resources: [{ resourceType: type, id: params.patient ?? params._id }],
    warnings: [],
  }));
  const deps: BulkExportWorkerDeps = {
    db: {} as never,
    outbox: { publish: vi.fn(async () => {}) },
    objects: { put, destroy, presignGet: vi.fn() },
    patients: {
      patientIdsPage: vi.fn(async (_org, after) => (after === null ? [P1, P2] : [])),
    },
    baa: { isBaaActive: async () => true },
    disclosures: { recordDisclosure },
    now: () => NOW,
    log: { error: vi.fn(), warn: vi.fn() },
    project: project as never,
    ...over,
  };
  return { deps, put, destroy, recordDisclosure, project };
}

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
  store.claimExportJob.mockResolvedValue(job());
  store.loadExportClient.mockResolvedValue(client());
  store.loadExportConfig.mockResolvedValue({ tenantFhirHost: "h", identifierUriBase: "b" });
  store.exportJobStatus.mockResolvedValue("in_progress");
  store.completeExportJob.mockResolvedValue(true);
  store.failExportJob.mockResolvedValue(true);
});

const run = (deps: BulkExportWorkerDeps) =>
  runBulkExportJob(deps, { organizationId: ORG, jobId: JOB });

describe("runBulkExportJob", () => {
  it("skips a job it could not claim (duplicate delivery) and touches nothing", async () => {
    store.claimExportJob.mockResolvedValue(null);
    const { deps, put, project } = makeDeps();
    expect(await run(deps)).toEqual({ status: "skipped" });
    expect(put).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    expect(store.completeExportJob).not.toHaveBeenCalled();
  });

  it("projects every patient x type, puts one NDJSON per type under the tenant prefix, and completes", async () => {
    const { deps, put, recordDisclosure } = makeDeps();
    const out = await run(deps);
    expect(out).toEqual({ status: "completed", totalResources: 4, artifacts: 2 });
    const keys = put.mock.calls.map(([a]) => a.objectKey).sort();
    expect(keys).toEqual([
      `tenants/${ORG}/fhir-exports/${JOB}/Encounter.ndjson`,
      `tenants/${ORG}/fhir-exports/${JOB}/Patient.ndjson`,
    ]);
    const patientCall = put.mock.calls.find(([a]) => a.objectKey.endsWith("Patient.ndjson"));
    const patientBytes = Buffer.from(patientCall?.[0].bytes ?? new Uint8Array()).toString("utf8");
    expect(
      patientBytes
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).id),
    ).toEqual([P1, P2]);
    const completion = store.completeExportJob.mock.calls[0]?.[2];
    expect(completion.totalResources).toBe(4);
    expect(completion.expiresAt).toEqual(new Date(NOW.getTime() + 24 * 3_600_000));
    expect(
      completion.artifacts.map((a: { checksumSha256: string }) => a.checksumSha256),
    ).toHaveLength(2);
    expect(completion.event.eventName).toBe("m28.fhir.bulk_export.completed");
    // §164.528: one accounting row per resource type, carrying the job id.
    expect(recordDisclosure).toHaveBeenCalledTimes(2);
    expect(recordDisclosure.mock.calls[0]?.[0]).toMatchObject({
      organizationId: ORG,
      fhirClientId: CLIENT,
      queryParameters: { $export: JOB },
    });
  });

  it("projects with the job's client as the D3 recipient and the job's own org (never anything else)", async () => {
    const { deps, project } = makeDeps();
    await run(deps);
    for (const call of project.mock.calls) {
      expect(call[0]).toMatchObject({ organizationId: ORG, recipientClientId: CLIENT });
    }
    expect(deps.patients.patientIdsPage).toHaveBeenCalledWith(ORG, null, expect.any(Number));
  });

  it.each([
    [
      "the client was revoked",
      () => store.loadExportClient.mockResolvedValue(client({ status: "revoked" })),
    ],
    ["the client is gone", () => store.loadExportClient.mockResolvedValue(null)],
    [
      "a requested scope was removed",
      () =>
        store.loadExportClient.mockResolvedValue(
          client({ allowedScopes: ["system/Patient.read"] }),
        ),
    ],
  ])("fails WITHOUT projecting a single resource when %s", async (_label, arrange) => {
    arrange();
    const { deps, put, project } = makeDeps();
    const out = await run(deps);
    expect(out.status).toBe("failed");
    expect(project).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(store.failExportJob.mock.calls[0]?.[4]).toBeTypeOf("object");
  });

  it("honours a wildcard read scope", async () => {
    store.loadExportClient.mockResolvedValue(client({ allowedScopes: ["system/*.read"] }));
    const { deps } = makeDeps();
    expect((await run(deps)).status).toBe("completed");
  });

  it("fails closed when the BAA is not in force, is unbound, or the check throws", async () => {
    for (const baa of [
      { isBaaActive: async () => false },
      undefined,
      {
        isBaaActive: async () => {
          throw new Error("m40 down");
        },
      },
    ]) {
      store.failExportJob.mockClear();
      const { deps, project } = makeDeps({ baa });
      expect((await run(deps)).status).toBe("failed");
      expect(project).not.toHaveBeenCalled();
      expect(store.failExportJob.mock.calls[0]?.[3]).toBe(
        "no BAA is in force for the requesting client",
      );
    }
  });

  it("fails a Group export and a type the gateway does not serve", async () => {
    store.claimExportJob.mockResolvedValue(job({ requestKind: "group", groupId: "g" }));
    expect((await run(makeDeps().deps)).status).toBe("failed");
    store.claimExportJob.mockResolvedValue(job({ resourceTypes: ["Condition"] }));
    store.loadExportClient.mockResolvedValue(client({ allowedScopes: ["system/*.read"] }));
    expect((await run(makeDeps().deps)).status).toBe("failed");
  });

  it("uses an explicit patientIds list instead of enumerating the tenant", async () => {
    store.claimExportJob.mockResolvedValue(job({ patientIds: [P2], resourceTypes: ["Patient"] }));
    const { deps, project } = makeDeps();
    expect((await run(deps)).status).toBe("completed");
    expect(deps.patients.patientIdsPage).not.toHaveBeenCalled();
    expect(project).toHaveBeenCalledTimes(1);
  });

  it("carries D3 advisories into an OperationOutcome file, de-duplicated, and does not count it as data", async () => {
    const advisory = {
      resourceType: "OperationOutcome",
      issue: [{ severity: "warning", code: "suppressed", details: { text: "Part 2 withheld" } }],
    };
    const project = vi.fn(async (_c, type: string) => ({
      resources: type === "Patient" ? [{ resourceType: "Patient", id: "x" }] : [],
      warnings: [advisory],
    }));
    const { deps, put } = makeDeps({ project: project as never });
    const out = await run(deps);
    expect(out).toMatchObject({ status: "completed", totalResources: 2 });
    const completion = store.completeExportJob.mock.calls[0]?.[2];
    expect(
      completion.artifacts.map((a: { resourceType: string }) => a.resourceType).sort(),
    ).toEqual(["OperationOutcome", "Patient"]);
    expect(
      completion.artifacts.find(
        (a: { resourceType: string }) => a.resourceType === "OperationOutcome",
      ).rowCount,
    ).toBe(1);
    expect(completion.totalResources).toBe(2);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("degrades ONE type to an advisory when its reader seam is unbound, and still exports the rest", async () => {
    const unbound = Object.assign(new Error("M8 not bound"), { name: "NotImplementedError" });
    const project = vi.fn(async (_c, type: string, params: { patient?: string; _id?: string }) => {
      if (type === "Encounter") throw unbound;
      return { resources: [{ resourceType: type, id: params._id }], warnings: [] };
    });
    const { deps } = makeDeps({ project: project as never });
    expect((await run(deps)).status).toBe("completed");
    // Encounter is attempted once, then skipped for every later patient.
    expect(project.mock.calls.filter((c) => c[1] === "Encounter")).toHaveLength(1);
    const types = store.completeExportJob.mock.calls[0]?.[2].artifacts.map(
      (a: { resourceType: string }) => a.resourceType,
    );
    expect(types.sort()).toEqual(["OperationOutcome", "Patient"]);
  });

  it("stops without writing anything when the job was cancelled while projecting", async () => {
    store.exportJobStatus.mockResolvedValue("cancelled");
    const { deps, put } = makeDeps();
    expect(await run(deps)).toEqual({ status: "cancelled" });
    expect(put).not.toHaveBeenCalled();
    expect(store.completeExportJob).not.toHaveBeenCalled();
  });

  it("destroys what it wrote when the job was cancelled between the put and the commit", async () => {
    store.completeExportJob.mockResolvedValue(false);
    const { deps, destroy } = makeDeps();
    expect(await run(deps)).toEqual({ status: "cancelled" });
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("FAILS (never truncates) an export over the resource cap", async () => {
    const big = vi.fn(async () => ({
      resources: Array.from({ length: 9_999 }, (_, i) => ({ id: i })),
      warnings: [],
    }));
    const patients = {
      patientIdsPage: vi.fn(async (_o, after) =>
        after === null
          ? new Array(60).fill(P1).map((p, i) => `${p.slice(0, -2)}${String(i).padStart(2, "0")}`)
          : [],
      ),
    };
    const { deps, put } = makeDeps({ project: big as never, patients });
    const out = await run(deps);
    expect(out.status).toBe("failed");
    expect((out as { reason: string }).reason).toMatch(/narrow _type or _since/);
    expect(put).not.toHaveBeenCalled();
  });

  it("destroys already-put objects and fails with a generic PHI-free reason when a later put throws", async () => {
    const { deps, put, destroy } = makeDeps();
    put.mockImplementationOnce(async ({ bytes }) => ({
      sha256Hex: createHash("sha256").update(bytes).digest("hex"),
    }));
    put.mockRejectedValueOnce(new Error("S3 exploded for patient 123-45-6789"));
    const out = await run(deps);
    expect(out).toEqual({
      status: "failed",
      reason: "the export could not be completed; see the server log",
    });
    expect(destroy).toHaveBeenCalledTimes(2);
    const event = store.failExportJob.mock.calls[0]?.[4];
    expect(JSON.stringify(event)).not.toContain("123-45-6789");
    expect(event.eventName).toBe("m28.fhir.bulk_export.failed");
  });

  it("fails when the object store's checksum disagrees with the plan", async () => {
    const { deps, destroy } = makeDeps();
    (deps.objects.put as ReturnType<typeof vi.fn>).mockResolvedValue({ sha256Hex: "deadbeef" });
    expect((await run(deps)).status).toBe("failed");
    expect(destroy).toHaveBeenCalled();
    expect(store.completeExportJob).not.toHaveBeenCalled();
  });
});

describe("parseBulkExportJobData", () => {
  it("accepts a uuid org + job and refuses anything else (a malformed job never runs against a tenant)", () => {
    expect(parseBulkExportJobData({ organizationId: ORG, jobId: JOB })).toEqual({
      organizationId: ORG,
      jobId: JOB,
    });
    for (const bad of [
      null,
      {},
      { organizationId: ORG },
      { organizationId: "x", jobId: JOB },
      { organizationId: ORG, jobId: 5 },
    ]) {
      expect(() => parseBulkExportJobData(bad)).toThrow();
    }
  });
});

describe("buildFhirExportObjectStore", () => {
  it("resolves the bucket from the organization on EVERY call", async () => {
    const s3 = {
      putObject: vi.fn(async (_a: { bucket: string }) => ({ sha256Hex: "h" })),
      presign: vi.fn(async (_a: { descriptor: { bucket: string; ttlSeconds: number } }) => ({
        url: "u",
        expiresAt: "e",
      })),
      destroyAllVersions: vi.fn(async (_a: { bucket: string }) => {}),
    };
    const objects = buildFhirExportObjectStore(s3 as never, (org) => `tenant-${org}`);
    await objects.put({ organizationId: "orgA", objectKey: "k", bytes: new Uint8Array() });
    await objects.presignGet({ organizationId: "orgB", objectKey: "k", ttlSeconds: 900 });
    await objects.destroy({ organizationId: "orgC", objectKey: "k" });
    expect(s3.putObject.mock.calls[0]?.[0].bucket).toBe("tenant-orgA");
    expect(s3.presign.mock.calls[0]?.[0].descriptor).toMatchObject({
      bucket: "tenant-orgB",
      ttlSeconds: 900,
    });
    expect(s3.destroyAllVersions.mock.calls[0]?.[0].bucket).toBe("tenant-orgC");
  });
});

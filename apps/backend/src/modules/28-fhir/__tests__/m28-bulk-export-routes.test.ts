// GAP-084 — the `$export` request/poll surface over the in-memory store: the job is enqueued after commit,
// a second job for the same client is a 429, the poll mints presigned output URLs from the artifact rows,
// another client's job is invisible, and an unbound deployment answers 501 instead of accepting a dead job.
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { FhirExportObjectStore } from "../jobs/ports";
import { registerFhirR4Routes } from "../routes/fhir-r4.routes";
import { createInMemoryFhirGatewayStore } from "../routes/store";

const ORG = "11111111-1111-1111-1111-111111111111";
const CLIENT = "44444444-4444-4444-4444-444444444444";
const OTHER_CLIENT = "66666666-6666-6666-6666-666666666666";
const TOKEN = "55555555-5555-5555-5555-555555555555";
const OTHER_TOKEN = "77777777-7777-7777-7777-777777777777";
const NOW = "2026-10-05T12:00:00.000Z";
const baaOn = { isBaaActive: async () => true };

const session = (jti: string, clientId: string) => ({
  jti,
  token: jti,
  clientId,
  organizationId: ORG,
  scopesGranted: ["system/Patient.read", "system/Encounter.read"],
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  revokedAt: null,
});

function seedStore(over: Record<string, unknown> = {}) {
  return createInMemoryFhirGatewayStore({
    now: () => NOW,
    clients: [
      { id: CLIENT, organizationId: ORG, type: "api_key", status: "active" },
      { id: OTHER_CLIENT, organizationId: ORG, type: "api_key", status: "active" },
    ],
    sessions: [session(TOKEN, CLIENT), session(OTHER_TOKEN, OTHER_CLIENT)],
    ...over,
  });
}

function fakeObjects(): FhirExportObjectStore {
  return {
    put: vi.fn(),
    destroy: vi.fn(),
    presignGet: vi.fn(async ({ objectKey, ttlSeconds }) => ({
      url: `https://minio.test/${objectKey}?ttl=${ttlSeconds}`,
      expiresAt: "2026-10-05T12:15:00.000Z",
    })),
  };
}

async function build(store: ReturnType<typeof seedStore>, withExports = true) {
  const enqueue = vi.fn(async () => {});
  const objects = fakeObjects();
  const app = Fastify({ trustProxy: false });
  registerFhirR4Routes(app, {
    store,
    baa: baaOn,
    now: () => NOW,
    ...(withExports ? { exports: { enqueue: { enqueue }, objects } } : {}),
  });
  await app.ready();
  return { app, enqueue, objects };
}

const kickOff = (
  app: Awaited<ReturnType<typeof build>>["app"],
  url = "/fhir/r4/$export?_type=Patient",
  token = TOKEN,
) => app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` } });

describe("POST /$export", () => {
  it("answers 501, not 202, when no export machinery is bound", async () => {
    const { app } = await build(seedStore(), false);
    const res = await kickOff(app);
    expect(res.statusCode).toBe(501);
    expect(res.json().issue[0].code).toBe("not-supported");
    expect(await seedStore().listJobs(ORG, {})).toHaveLength(0);
  });

  it("accepts, points Content-Location at the poll URL and enqueues the job for THIS org", async () => {
    const store = seedStore();
    const { app, enqueue } = await build(store);
    const res = await kickOff(app, "/fhir/r4/$export?_type=Patient");
    expect(res.statusCode).toBe(202);
    const [job] = await store.listJobs(ORG, { clientId: CLIENT });
    expect(job?.status).toBe("accepted");
    expect(job?.resourceTypes).toEqual(["Patient"]);
    expect(res.headers["content-location"]).toBe(`/fhir/r4/$export-poll-status/${job?.id}`);
    expect(enqueue).toHaveBeenCalledWith(ORG, job?.id);
  });

  it("still 202s when the enqueue fails (the job exists; the sweeper re-queues it)", async () => {
    const store = seedStore();
    const { app, enqueue } = await build(store);
    enqueue.mockRejectedValueOnce(new Error("valkey down"));
    expect((await kickOff(app)).statusCode).toBe(202);
    expect(await store.listJobs(ORG, { status: "accepted" })).toHaveLength(1);
  });

  it("429s a second export while the client's first is active, but not another client's", async () => {
    const { app } = await build(seedStore());
    expect((await kickOff(app)).statusCode).toBe(202);
    const second = await kickOff(app);
    expect(second.statusCode).toBe(429);
    expect(second.json().issue[0].code).toBe("throttled");
    expect((await kickOff(app, undefined, OTHER_TOKEN)).statusCode).toBe(202);
  });

  it("refuses a type the client's granted scopes do not cover, and a type this gateway does not serve", async () => {
    const { app } = await build(seedStore());
    const noScope = await kickOff(app, "/fhir/r4/$export?_type=MedicationRequest");
    expect(noScope.statusCode).toBe(403);
    const unserved = await kickOff(app, "/fhir/r4/$export?_type=Condition");
    expect(unserved.statusCode).toBe(400);
  });

  it("answers 501 for Group export (no Group membership source) and creates no job", async () => {
    const store = seedStore();
    const { app, enqueue } = await build(store);
    const res = await kickOff(app, "/fhir/r4/Group/abc/$export");
    expect(res.statusCode).toBe(501);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await store.listJobs(ORG, {})).toHaveLength(0);
  });
});

describe("GET /$export-poll-status/:jobId", () => {
  const completedStore = (expiresAt: string) =>
    seedStore({
      jobs: [
        {
          id: "job-1",
          clientId: CLIENT,
          organizationId: ORG,
          status: "completed",
          completedAt: "2026-10-05T10:00:00.000Z",
          expiresAt,
        },
      ],
      artifacts: {
        "job-1": [
          {
            resourceType: "Patient",
            objectKey: `tenants/${ORG}/fhir-exports/job-1/Patient.ndjson`,
            byteSize: 10,
            rowCount: 2,
            checksumSha256: "abc",
          },
          {
            resourceType: "OperationOutcome",
            objectKey: `tenants/${ORG}/fhir-exports/job-1/OperationOutcome.ndjson`,
            byteSize: 5,
            rowCount: 1,
            checksumSha256: "def",
          },
          {
            resourceType: "Encounter",
            objectKey: "",
            byteSize: 1,
            rowCount: 1,
            checksumSha256: "x",
          },
        ],
      },
    });
  const poll = (app: Awaited<ReturnType<typeof build>>["app"], token = TOKEN) =>
    app.inject({
      method: "GET",
      url: "/fhir/r4/$export-poll-status/job-1",
      headers: { authorization: `Bearer ${token}` },
    });

  it("returns output[] with 15-minute presigned URLs and the OperationOutcome file under error[]", async () => {
    const { app, objects } = await build(completedStore("2026-10-06T10:00:00.000Z"));
    const res = await poll(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.output).toHaveLength(1);
    expect(body.output[0]).toMatchObject({ type: "Patient", count: 2 });
    expect(body.output[0].url).toContain("fhir-exports/job-1/Patient.ndjson?ttl=900");
    expect(body.output[0].extension[0].valueString).toBe("abc");
    expect(body.error).toHaveLength(1);
    expect(body.error[0].type).toBe("OperationOutcome");
    // A purged (blank-key) artifact is never presigned.
    expect(objects.presignGet).toHaveBeenCalledTimes(2);
  });

  it("answers 410 once expires_at has passed even if the sweeper has not run yet", async () => {
    const { app, objects } = await build(completedStore("2026-10-05T11:59:00.000Z"));
    expect((await poll(app)).statusCode).toBe(410);
    expect(objects.presignGet).not.toHaveBeenCalled();
  });

  it("hides another client's job as 404 (the job id is not a capability)", async () => {
    const { app, objects } = await build(completedStore("2026-10-06T10:00:00.000Z"));
    expect((await poll(app, OTHER_TOKEN)).statusCode).toBe(404);
    expect(objects.presignGet).not.toHaveBeenCalled();
  });

  it("DELETE on another client's job is a 404 and does not cancel it", async () => {
    const store = seedStore({
      jobs: [{ id: "job-1", clientId: CLIENT, organizationId: ORG, status: "in_progress" }],
    });
    const { app } = await build(store);
    const res = await app.inject({
      method: "DELETE",
      url: "/fhir/r4/$export-poll-status/job-1",
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    expect((await store.getJob(ORG, "job-1"))?.status).toBe("in_progress");
  });

  it("answers 202 with X-Progress while the job is queued or running", async () => {
    const store = seedStore({
      jobs: [{ id: "job-1", clientId: CLIENT, organizationId: ORG, status: "in_progress" }],
    });
    const { app } = await build(store);
    const res = await poll(app);
    expect(res.statusCode).toBe(202);
    expect(res.headers["x-progress"]).toBe("in_progress");
  });
});

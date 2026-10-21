// ADR-0089 S2 - the export service's decision matrix over an in-memory store (the SQL half is the live suite): flag, permission, role category,
// scope, caps, the two-person rule, double decisions, cancel, and the download path's fail-closed behaviour and expiry boundary.
import type { CreateMessagingExportRequest } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { M36_EXPORT_EVENTS } from "./export-events";
import type { ExportArtefactReader } from "./export-ports";
import { createExportService } from "./export-service";
import type {
  ExportActor,
  ExportJobRow,
  ExportStore,
  ExportTx,
  NewExportJob,
} from "./export-store";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQUESTER = "22222222-2222-4222-8222-222222222222";
const APPROVER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "55555555-5555-4555-8555-555555555555";
const PATIENT = "66666666-6666-4666-8666-666666666666";
const JUSTIFICATION = "Subject access request from the patient's representative";

interface World {
  jobs: ExportJobRow[];
  downloads: { jobId: string; userId: string; bytes: number | null }[];
  events: { eventName: string; payload: Record<string, unknown> }[];
  now: Date;
  nextId: number;
  excluded: Set<string>;
  channels: Set<string>;
  patients: Set<string>;
  failTrail: boolean;
  failDecideWith: Error | null;
}

const fresh = (): World => ({
  jobs: [],
  downloads: [],
  events: [],
  now: new Date("2026-10-21T10:00:00.000Z"),
  nextId: 1,
  excluded: new Set(),
  channels: new Set([CHANNEL]),
  patients: new Set([PATIENT]),
  failTrail: false,
  failDecideWith: null,
});

function makeJob(world: World, requestedBy: string, input: NewExportJob): ExportJobRow {
  const id = `00000000-0000-4000-8000-${String(world.nextId++).padStart(12, "0")}`;
  return {
    id,
    organizationId: ORG,
    requestedBy,
    requestedByName: "Pat Requester",
    ...input,
    status: "pending_approval",
    requestedAt: world.now,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    buildingAt: null,
    readyAt: null,
    expiresAt: null,
    artefactKey: null,
    artefactSha256: null,
    artefactBytes: null,
    wrappedDek: null,
    messageCount: null,
    heldExcluded: null,
    part2Excluded: null,
    failureCode: null,
    downloadCount: 0,
    dbNow: world.now,
  };
}

function memoryStore(world: World): ExportStore {
  const stamp = (j: ExportJobRow): ExportJobRow => ({ ...j, dbNow: world.now });
  return {
    async run<T>(_actor: ExportActor, fn: (tx: ExportTx) => Promise<T>): Promise<T> {
      const snapshot = {
        jobs: [...world.jobs],
        downloads: [...world.downloads],
        events: [...world.events],
      };
      const tx: ExportTx = {
        raw: world,
        eligible: async (userId) => !world.excluded.has(userId),
        scopeExists: async (s) =>
          s.scopeKind === "channel"
            ? world.channels.has(s.channelId ?? "")
            : world.patients.has(s.patientId ?? ""),
        lockRequester: async () => undefined,
        counts: async (userId) => {
          const mine = world.jobs.filter((j) => j.requestedBy === userId);
          return {
            live: mine.filter((j) =>
              ["pending_approval", "approved", "building", "ready"].includes(j.status),
            ).length,
            day: mine.length,
          };
        },
        insertJob: async (requestedBy, input) => {
          const job = makeJob(world, requestedBy, input);
          world.jobs.push(job);
          return job;
        },
        getJob: async (id) => {
          const j = world.jobs.find((x) => x.id === id);
          return j ? stamp(j) : null;
        },
        decide: async (id, status, decidedBy, note) => {
          if (world.failDecideWith) throw world.failDecideWith;
          const i = world.jobs.findIndex((x) => x.id === id && x.status === "pending_approval");
          const current = world.jobs[i];
          if (!current) return null;
          const next = { ...current, status, decidedBy, decisionNote: note, decidedAt: world.now };
          world.jobs[i] = next;
          return stamp(next);
        },
        cancel: async (id, requestedBy) => {
          const i = world.jobs.findIndex(
            (x) => x.id === id && x.requestedBy === requestedBy && x.status === "pending_approval",
          );
          const current = world.jobs[i];
          if (!current) return null;
          const next = { ...current, status: "cancelled" as const, decidedAt: world.now };
          world.jobs[i] = next;
          return stamp(next);
        },
        listMine: async (userId) => world.jobs.filter((j) => j.requestedBy === userId).map(stamp),
        listPending: async (exclude) =>
          world.jobs
            .filter((j) => j.status === "pending_approval" && j.requestedBy !== exclude)
            .map(stamp),
        recordDownload: async (jobId, userId, bytes) => {
          if (world.failTrail) throw new Error("trail insert failed");
          const i = world.jobs.findIndex((x) => x.id === jobId);
          const job = world.jobs[i];
          const live =
            job?.requestedBy === userId &&
            job.status === "ready" &&
            job.expiresAt !== null &&
            job.expiresAt.getTime() > world.now.getTime();
          if (!job || !live) {
            throw new Error("message_export_download_job: refused by the guard");
          }
          world.downloads.push({ jobId, userId, bytes });
          world.jobs[i] = { ...job, downloadCount: job.downloadCount + 1 };
          return world.now;
        },
      };
      try {
        return await fn(tx);
      } catch (error) {
        world.jobs = snapshot.jobs;
        world.downloads = snapshot.downloads;
        world.events = snapshot.events;
        throw error;
      }
    },
  };
}

const BODY: CreateMessagingExportRequest = {
  scopeKind: "channel",
  channelId: CHANNEL,
  justification: JUSTIFICATION,
};
const asRequester: ExportActor = { organizationId: ORG, userId: REQUESTER };
const asApprover: ExportActor = { organizationId: ORG, userId: APPROVER };

function setup(
  over: {
    flagOn?: boolean;
    permissions?: (userId: string, key: string) => boolean;
    reader?: ReturnType<typeof vi.fn>;
    noOutbox?: boolean;
  } = {},
) {
  const world = fresh();
  const reader = over.reader ?? vi.fn(async () => Buffer.from('{"messages":[]}'));
  const service = createExportService({
    store: memoryStore(world),
    outbox: over.noOutbox
      ? undefined
      : {
          publish: async (_tx, e) => {
            world.events.push({ eventName: e.eventName, payload: e.payload });
          },
        },
    flags: { forOrg: async () => ({ "messaging.export": over.flagOn ?? true }) },
    holds: async (_org, userId, key) => (over.permissions ? over.permissions(userId, key) : true),
    artefactReader: reader as unknown as ExportArtefactReader,
  });
  return { world, service, reader };
}

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: { code?: string; statusCode?: number }) => `${e.code}:${e.statusCode}`,
  );

/** Move the one job straight to ready, the way the builder would (expires 24 h after ready). */
function makeReady(world: World, jobId: string, readyAt = world.now): void {
  const i = world.jobs.findIndex((j) => j.id === jobId);
  const job = world.jobs[i];
  if (!job) throw new Error("no job");
  world.jobs[i] = {
    ...job,
    status: "ready",
    decidedBy: APPROVER,
    readyAt,
    expiresAt: new Date(readyAt.getTime() + 24 * 3_600_000),
    artefactKey: "k",
    artefactSha256: "a".repeat(64),
    artefactBytes: 15,
    wrappedDek: "dek",
  };
}

describe("create", () => {
  it("opens a pending job and publishes one PHI-free requested event in the same transaction", async () => {
    const { service, world } = setup();
    const job = await service.create(asRequester, BODY);
    expect(job).toMatchObject({
      status: "pending_approval",
      requestedBy: REQUESTER,
      downloadable: false,
    });
    expect(world.events).toHaveLength(1);
    expect(world.events[0]).toMatchObject({ eventName: M36_EXPORT_EVENTS.requested });
    expect(Object.keys(world.events[0]?.payload ?? {}).sort()).toEqual(
      ["at", "jobId", "organizationId", "requestedBy"].sort(),
    );
    expect(JSON.stringify(world.events)).not.toContain(JUSTIFICATION);
  });

  it("answers the same 404 for flag off, a missing permission, an excluded category and an unknown scope", async () => {
    const refusals = [
      setup({ flagOn: false }).service.create(asRequester, BODY),
      setup({ permissions: () => false }).service.create(asRequester, BODY),
      (() => {
        const s = setup();
        s.world.excluded.add(REQUESTER);
        return s.service.create(asRequester, BODY);
      })(),
      setup().service.create(asRequester, { ...BODY, channelId: OTHER }),
      setup().service.create(asRequester, {
        scopeKind: "patient",
        patientId: OTHER,
        justification: JUSTIFICATION,
      }),
    ];
    const results = await Promise.all(
      refusals.map((p) =>
        p.then(
          () => null,
          (e: Error & { code?: string }) => [e.code, e.message],
        ),
      ),
    );
    for (const r of results) expect(r).toEqual(["NOT_FOUND", "export scope not found"]);
  });

  it("accepts a patient scope when the patient has a channel", async () => {
    const { service } = setup();
    const job = await service.create(asRequester, {
      scopeKind: "patient",
      patientId: PATIENT,
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      justification: JUSTIFICATION,
    });
    expect(job.scope).toMatchObject({ scopeKind: "patient", patientId: PATIENT, channelId: null });
  });

  it("refuses anything but exactly one matching scope, a short justification and a bad range with 422", async () => {
    const { service, world } = setup();
    const bad: CreateMessagingExportRequest[] = [
      { ...BODY, patientId: PATIENT },
      { scopeKind: "patient", justification: JUSTIFICATION },
      { ...BODY, justification: "too short" },
      { ...BODY, dateFrom: "2026-01-01" },
      { ...BODY, dateFrom: "2026-02-01", dateTo: "2026-01-01" },
      { ...BODY, dateFrom: "2026-02-30", dateTo: "2026-03-01" },
      { ...BODY, dateFrom: "2025-01-01", dateTo: "2026-01-03" },
    ];
    for (const body of bad)
      expect(await codeOf(service.create(asRequester, body))).toBe("VALIDATION_FAILED:422");
    expect(world.jobs).toHaveLength(0);
    // 366 days apart is the edge that still passes
    await expect(
      service.create(asRequester, { ...BODY, dateFrom: "2025-01-01", dateTo: "2026-01-02" }),
    ).resolves.toBeDefined();
  });

  it("429 EXPORT_LIMIT past three live jobs, and past ten in a day", async () => {
    const { service, world } = setup();
    for (let i = 0; i < 3; i += 1) await service.create(asRequester, BODY);
    expect(await codeOf(service.create(asRequester, BODY))).toBe("EXPORT_LIMIT:429");
    expect(world.jobs).toHaveLength(3);

    const daily = setup();
    for (let i = 0; i < 10; i += 1) {
      const job = await daily.service.create(asRequester, BODY);
      await daily.service.cancel(asRequester, job.id);
    }
    expect(await codeOf(daily.service.create(asRequester, BODY))).toBe("EXPORT_LIMIT:429");
  });

  it("writes nothing and throws when no outbox is bound", async () => {
    const { service, world } = setup({ noOutbox: true });
    await expect(service.create(asRequester, BODY)).rejects.toThrow(/outbox/);
    expect(world.jobs).toHaveLength(0);
  });

  it("rolls the job back when the event cannot be published", async () => {
    const world = fresh();
    const service = createExportService({
      store: memoryStore(world),
      outbox: {
        publish: async () => {
          throw new Error("outbox down");
        },
      },
      flags: { forOrg: async () => ({ "messaging.export": true }) },
      holds: async () => true,
    });
    await expect(service.create(asRequester, BODY)).rejects.toThrow("outbox down");
    expect(world.jobs).toHaveLength(0);
  });
});

describe("decide", () => {
  it("approves a pending job for a second person and publishes approved", async () => {
    const { service, world } = setup();
    const job = await service.create(asRequester, BODY);
    const done = await service.decide(asApprover, job.id, "approve", { note: "  ok  " });
    expect(done).toMatchObject({ status: "approved", decidedBy: APPROVER, decisionNote: "ok" });
    expect(world.events.at(-1)).toMatchObject({
      eventName: "m36.export.approved",
      payload: { organizationId: ORG, jobId: job.id, requestedBy: REQUESTER, decidedBy: APPROVER },
    });
    expect(JSON.stringify(world.events)).not.toContain("ok");
  });

  it("rejects and publishes rejected, with no builder event", async () => {
    const { service, world } = setup();
    const job = await service.create(asRequester, BODY);
    expect((await service.decide(asApprover, job.id, "reject", {})).status).toBe("rejected");
    expect(world.events.map((e) => e.eventName)).toEqual([
      "m36.export.requested",
      "m36.export.rejected",
    ]);
  });

  it("never lets the requester decide their own job, even holding the permission", async () => {
    const { service, world } = setup();
    const job = await service.create(asRequester, BODY);
    expect(await codeOf(service.decide(asRequester, job.id, "approve", {}))).toBe("FORBIDDEN:403");
    expect(world.jobs[0]?.status).toBe("pending_approval");
  });

  it("maps the table's two-person CHECK to 403 too", async () => {
    const { service, world } = setup();
    const job = await service.create(asRequester, BODY);
    world.failDecideWith = new Error('violates check constraint "message_export_job_two_people"');
    expect(await codeOf(service.decide(asApprover, job.id, "approve", {}))).toBe("FORBIDDEN:403");
  });

  it("409 EXPORT_ALREADY_DECIDED for a second decision, a cancelled job, and the other verb", async () => {
    const { service } = setup();
    const a = await service.create(asRequester, BODY);
    await service.decide(asApprover, a.id, "approve", {});
    expect(await codeOf(service.decide(asApprover, a.id, "approve", {}))).toBe(
      "EXPORT_ALREADY_DECIDED:409",
    );
    expect(await codeOf(service.decide(asApprover, a.id, "reject", {}))).toBe(
      "EXPORT_ALREADY_DECIDED:409",
    );
    const b = await service.create(asRequester, BODY);
    await service.cancel(asRequester, b.id);
    expect(await codeOf(service.decide(asApprover, b.id, "approve", {}))).toBe(
      "EXPORT_ALREADY_DECIDED:409",
    );
  });

  it("404 for an unknown job, 403 when the approver permission is gone, 422 for an over-long note", async () => {
    const { service } = setup();
    const job = await service.create(asRequester, BODY);
    expect(await codeOf(service.decide(asApprover, OTHER, "approve", {}))).toBe("NOT_FOUND:404");
    expect(
      await codeOf(service.decide(asApprover, job.id, "approve", { note: "x".repeat(1001) })),
    ).toBe("VALIDATION_FAILED:422");
    const noPerm = setup({ permissions: (_u, key) => key !== "messaging.export.approve" });
    const j2 = await noPerm.service.create(asRequester, BODY);
    expect(await codeOf(noPerm.service.decide(asApprover, j2.id, "approve", {}))).toBe(
      "FORBIDDEN:403",
    );
  });

  it("still decides while the request flag is off (the flag gates requesting only)", async () => {
    const world = fresh();
    let flagOn = true;
    const service = createExportService({
      store: memoryStore(world),
      outbox: { publish: async () => undefined },
      flags: { forOrg: async () => ({ "messaging.export": flagOn }) },
      holds: async () => true,
    });
    const job = await service.create(asRequester, BODY);
    flagOn = false;
    expect((await service.decide(asApprover, job.id, "approve", {})).status).toBe("approved");
  });
});

describe("cancel, lists and detail", () => {
  it("cancel is the requester's, while pending; anyone else gets the unknown-id 404", async () => {
    const { service } = setup();
    const job = await service.create(asRequester, BODY);
    expect(await codeOf(service.cancel(asApprover, job.id))).toBe("NOT_FOUND:404");
    expect((await service.cancel(asRequester, job.id)).status).toBe("cancelled");
    expect(await codeOf(service.cancel(asRequester, job.id))).toBe("EXPORT_ALREADY_DECIDED:409");
  });

  it("the approvers' queue excludes their own requests; mine lists only mine", async () => {
    const { service } = setup();
    const mine = await service.create(asApprover, BODY);
    const theirs = await service.create(asRequester, BODY);
    expect((await service.listPending(asApprover)).map((j) => j.id)).toEqual([theirs.id]);
    expect((await service.listMine(asApprover)).map((j) => j.id)).toEqual([mine.id]);
    expect(JSON.stringify(await service.listPending(asApprover))).not.toContain(JUSTIFICATION);
  });

  it("the pending queue needs the approve permission", async () => {
    const { service } = setup({ permissions: () => false });
    expect(await codeOf(service.listPending(asApprover))).toBe("FORBIDDEN:403");
  });

  it("detail is for the requester or an approver; anyone else gets the unknown-id 404", async () => {
    const { service } = setup();
    const job = await service.create(asRequester, BODY);
    expect((await service.get(asRequester, job.id, { canApprove: false })).justification).toBe(
      JUSTIFICATION,
    );
    expect((await service.get(asApprover, job.id, { canApprove: true })).id).toBe(job.id);
    expect(
      await codeOf(
        service.get({ organizationId: ORG, userId: OTHER }, job.id, { canApprove: false }),
      ),
    ).toBe("NOT_FOUND:404");
  });
});

describe("download", () => {
  async function readyJob(over?: Parameters<typeof setup>[0]) {
    const s = setup(over);
    const job = await s.service.create(asRequester, BODY);
    makeReady(s.world, job.id);
    return { ...s, jobId: job.id };
  }

  it("records the trail, bumps the count, publishes downloaded, then returns the bytes", async () => {
    const { service, world, reader, jobId } = await readyJob();
    const file = await service.download(asRequester, jobId);
    expect(file.bytes.toString()).toBe('{"messages":[]}');
    expect(file.filename).toBe(`messaging-export-${jobId}.json`);
    expect(world.downloads).toEqual([{ jobId, userId: REQUESTER, bytes: 15 }]);
    expect(world.jobs[0]?.downloadCount).toBe(1);
    expect(world.events.at(-1)).toMatchObject({
      eventName: "m36.export.downloaded",
      payload: { jobId, downloadedBy: REQUESTER },
    });
    expect(reader).toHaveBeenCalledWith(
      expect.objectContaining({ jobId, organizationId: ORG, artefactKey: "k", wrappedDek: "dek" }),
    );
  });

  it("fails closed: no trail row means no bytes, and nothing is left behind", async () => {
    const { service, world, jobId } = await readyJob();
    world.failTrail = true;
    await expect(service.download(asRequester, jobId)).rejects.toThrow("trail insert failed");
    expect(world.downloads).toHaveLength(0);
    expect(world.jobs[0]?.downloadCount).toBe(0);
  });

  it("is the requester's alone: an approver and a stranger get the unknown-id 404 and the reader is never called", async () => {
    const { service, reader, jobId } = await readyJob();
    expect(await codeOf(service.download(asApprover, jobId))).toBe("NOT_FOUND:404");
    expect(await codeOf(service.download({ organizationId: ORG, userId: OTHER }, jobId))).toBe(
      "NOT_FOUND:404",
    );
    expect(reader).not.toHaveBeenCalled();
  });

  it("409 EXPORT_NOT_READY for pending, approved and building; EXPORT_EXPIRED once the status is expired", async () => {
    const { service, world } = setup();
    const job = await service.create(asRequester, BODY);
    expect(await codeOf(service.download(asRequester, job.id))).toBe("EXPORT_NOT_READY:409");
    await service.decide(asApprover, job.id, "approve", {});
    expect(await codeOf(service.download(asRequester, job.id))).toBe("EXPORT_NOT_READY:409");
    makeReady(world, job.id);
    const i = world.jobs.findIndex((j) => j.id === job.id);
    world.jobs[i] = { ...(world.jobs[i] as ExportJobRow), status: "expired" };
    expect(await codeOf(service.download(asRequester, job.id))).toBe("EXPORT_EXPIRED:409");
  });

  it("judges expiry on the database clock: ready but past expires_at is expired, one millisecond before still downloads", async () => {
    const { service, world, jobId } = await readyJob();
    const expiresAt = world.jobs[0]?.expiresAt as Date;
    world.now = new Date(expiresAt.getTime() - 1);
    await expect(service.download(asRequester, jobId)).resolves.toBeDefined();
    world.now = expiresAt;
    expect(await codeOf(service.download(asRequester, jobId))).toBe("EXPORT_EXPIRED:409");
    world.now = new Date(expiresAt.getTime() + 1);
    expect(await codeOf(service.download(asRequester, jobId))).toBe("EXPORT_EXPIRED:409");
  });

  it("maps a guard refusal after the artefact was read (the link expired meanwhile) to EXPORT_EXPIRED", async () => {
    const world = fresh();
    const reader = vi.fn(async () => {
      world.now = new Date(world.now.getTime() + 25 * 3_600_000);
      return Buffer.from("{}");
    });
    const service = createExportService({
      store: memoryStore(world),
      outbox: { publish: async () => undefined },
      flags: { forOrg: async () => ({ "messaging.export": true }) },
      holds: async () => true,
      artefactReader: reader,
    });
    const job = await service.create(asRequester, BODY);
    makeReady(world, job.id);
    expect(await codeOf(service.download(asRequester, job.id))).toBe("EXPORT_EXPIRED:409");
    expect(world.downloads).toHaveLength(0);
  });

  it("403 when the download permission was removed, 503 when no reader is bound, and a reader error leaves no trail", async () => {
    const gone = await readyJob({ permissions: (_u, key) => key !== "messaging.export.download" });
    expect(await codeOf(gone.service.download(asRequester, gone.jobId))).toBe("FORBIDDEN:403");

    const world = fresh();
    const unbound = createExportService({
      store: memoryStore(world),
      outbox: { publish: async () => undefined },
      holds: async () => true,
    });
    expect(await codeOf(unbound.download(asRequester, CHANNEL))).toBe("EXPORT_UNAVAILABLE:503");

    const broken = await readyJob({
      reader: vi.fn(async () => {
        throw new Error("sha256 mismatch");
      }),
    });
    await expect(broken.service.download(asRequester, broken.jobId)).rejects.toThrow(
      "sha256 mismatch",
    );
    expect(broken.world.downloads).toHaveLength(0);
  });
});

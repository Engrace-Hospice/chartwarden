// WP 5.7 - the artefact builder over an in-memory store: scope (channel / patient), the date window, held and Part 2 exclusion (counted), the
// message cap (fail closed), a decrypt failure (failed, no plaintext in the outcome), idempotency, and the manifest's counts.
import { randomBytes } from "node:crypto";
import { EXPORT_MAX_MESSAGES } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import {
  type ExportBuildStore,
  type ExportChannel,
  type ExportJobRow,
  type ExportMessageQuery,
  type ExportMessageRow,
  createExportBuilder,
} from "./export-builder";
import { openArtefact } from "./export-crypto";

const ORG = "00000000-0000-4000-8000-00000000000a";
const JOB = "00000000-0000-4000-8000-0000000000b1";
const dek = randomBytes(32);

interface FakeMessage extends ExportMessageRow {
  held?: boolean;
}

const job = (over: Partial<ExportJobRow> = {}): ExportJobRow => ({
  id: JOB,
  organizationId: ORG,
  requestedBy: "u-req",
  decidedBy: "u-app",
  scopeKind: "channel",
  channelId: "ch1",
  patientId: null,
  dateFrom: null,
  dateTo: null,
  ...over,
});

const msg = (
  id: string,
  channelId: string,
  at: string,
  over: Partial<FakeMessage> = {},
): FakeMessage => ({
  id,
  channelId,
  authorUserId: "u1",
  createdAt: new Date(at),
  bodyKind: "plain",
  status: "sent",
  bodyCipher: Buffer.from(`cipher:${id}`),
  ...over,
});

function fakeStore(opts: {
  job: ExportJobRow | null;
  channels: ExportChannel[];
  messages: FakeMessage[];
}) {
  const state = {
    status: opts.job ? "approved" : "none",
    ready: null as unknown,
    failure: null as string | null,
  };
  const inQuery = (m: FakeMessage, q: ExportMessageQuery) =>
    q.channelIds.includes(m.channelId) &&
    (!q.from || m.createdAt >= q.from) &&
    (!q.to || m.createdAt < q.to) &&
    m.createdAt <= q.until;
  const store: ExportBuildStore = {
    claim: async () => {
      if (state.status !== "approved") return null;
      state.status = "building";
      return opts.job;
    },
    channelsFor: async () => opts.channels,
    count: async (_o, q) => {
      const rows = opts.messages.filter((m) => inQuery(m, q));
      return { total: rows.length, held: rows.filter((m) => m.held).length };
    },
    page: async (_o, q, after, limit) =>
      opts.messages
        .filter((m) => inQuery(m, q) && !m.held)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .filter(
          (m) =>
            !after ||
            m.createdAt > after.createdAt ||
            (m.createdAt.getTime() === after.createdAt.getTime() && m.id > after.id),
        )
        .slice(0, limit),
    attachments: async (_o, ids) =>
      ids.includes("m1")
        ? [
            {
              id: "a1",
              messageId: "m1",
              name: "x.pdf",
              mimeType: "application/pdf",
              byteSize: 9,
              scanState: "clean",
            },
          ]
        : [],
    complete: async (_o, _j, r) => {
      state.status = "ready";
      state.ready = r;
    },
    fail: async (_o, _j, code) => {
      state.status = "failed";
      state.failure = code;
    },
  };
  return { store, state };
}

function build(opts: Parameters<typeof fakeStore>[0], over: Record<string, unknown> = {}) {
  const fake = fakeStore(opts);
  const stored = new Map<string, Uint8Array>();
  const builder = createExportBuilder({
    store: fake.store,
    keys: { mint: async () => ({ dek: Buffer.from(dek), wrapped: "kek1:wrapped" }) },
    openBody: async (_o, c) => c.toString().replace("cipher:", "body of "),
    part2Patients: async () => new Set<string>(),
    putObject: async ({ objectKey, bytes }) => {
      stored.set(objectKey, bytes);
    },
    now: () => new Date("2026-03-10T12:00:00Z"),
    ...over,
  });
  return { ...fake, stored, builder };
}

const readArtefact = (stored: Map<string, Uint8Array>) => {
  const [bytes] = [...stored.values()];
  return JSON.parse(
    openArtefact(bytes as Uint8Array, dek, { organizationId: ORG, jobId: JOB }).toString(),
  );
};

describe("export builder", () => {
  it("exports one channel into an encrypted artefact with attachment metadata only", async () => {
    const t = build({
      job: job(),
      channels: [{ id: "ch1", kind: "group", subjectId: null }],
      messages: [
        msg("m1", "ch1", "2026-03-01T10:00:00Z"),
        msg("m2", "ch2", "2026-03-01T11:00:00Z"),
      ],
    });
    const out = await t.builder.buildJob(ORG, JOB);
    expect(out).toEqual({ outcome: "ready", messageCount: 1 });
    const doc = readArtefact(t.stored);
    expect(doc.messages).toHaveLength(1);
    expect(doc.messages[0]).toMatchObject({
      id: "m1",
      channelId: "ch1",
      senderId: "u1",
      body: "body of m1",
    });
    expect(doc.messages[0].attachments).toEqual([
      { id: "a1", name: "x.pdf", mimeType: "application/pdf", byteSize: 9, scanState: "clean" },
    ]);
    expect(doc.manifest).toMatchObject({
      jobId: JOB,
      requestedBy: "u-req",
      approvedBy: "u-app",
      messageCount: 1,
      heldExcluded: 0,
      part2Excluded: 0,
    });
    const ready = t.state.ready as {
      artefactSha256: string;
      wrappedDek: string;
      artefactKey: string;
    };
    expect(ready.wrappedDek).toBe("kek1:wrapped");
    expect(ready.artefactKey).toBe(`messaging-export/${JOB}.enc`);
    // the stored bytes are ciphertext, not the JSON
    expect(Buffer.from([...t.stored.values()][0] as Uint8Array).toString()).not.toContain(
      "body of m1",
    );
  });

  it("patient scope covers the patient's care-team channels", async () => {
    const t = build({
      job: job({ scopeKind: "patient", channelId: null, patientId: "p1" }),
      channels: [{ id: "ct", kind: "care_team", subjectId: "p1" }],
      messages: [
        msg("m1", "ct", "2026-03-01T10:00:00Z"),
        msg("m9", "other", "2026-03-01T10:00:00Z"),
      ],
    });
    expect(await t.builder.buildJob(ORG, JOB)).toEqual({ outcome: "ready", messageCount: 1 });
  });

  it("applies the date window (UTC days, end inclusive)", async () => {
    const t = build({
      job: job({ dateFrom: "2026-03-02", dateTo: "2026-03-03" }),
      channels: [{ id: "ch1", kind: "group", subjectId: null }],
      messages: [
        msg("before", "ch1", "2026-03-01T23:59:59Z"),
        msg("first", "ch1", "2026-03-02T00:00:00Z"),
        msg("last", "ch1", "2026-03-03T23:59:59Z"),
        msg("after", "ch1", "2026-03-04T00:00:00Z"),
      ],
    });
    await t.builder.buildJob(ORG, JOB);
    expect(readArtefact(t.stored).messages.map((m: { id: string }) => m.id)).toEqual([
      "first",
      "last",
    ]);
  });

  it("excludes held messages and counts them", async () => {
    const t = build({
      job: job(),
      channels: [{ id: "ch1", kind: "group", subjectId: null }],
      messages: [
        msg("m1", "ch1", "2026-03-01T10:00:00Z"),
        msg("m2", "ch1", "2026-03-01T11:00:00Z", { held: true }),
      ],
    });
    await t.builder.buildJob(ORG, JOB);
    const doc = readArtefact(t.stored);
    expect(doc.messages.map((m: { id: string }) => m.id)).toEqual(["m1"]);
    expect(doc.manifest).toMatchObject({ messageCount: 1, heldExcluded: 1, part2Excluded: 0 });
    expect(JSON.stringify(doc)).not.toContain("body of m2");
  });

  it("excludes Part 2 gated channels and counts them", async () => {
    const t = build(
      {
        job: job({ scopeKind: "patient", channelId: null, patientId: "p1" }),
        channels: [{ id: "ct", kind: "care_team", subjectId: "p1" }],
        messages: [
          msg("m1", "ct", "2026-03-01T10:00:00Z"),
          msg("m2", "ct", "2026-03-01T11:00:00Z"),
        ],
      },
      { part2Patients: async () => new Set(["p1"]) },
    );
    expect(await t.builder.buildJob(ORG, JOB)).toEqual({ outcome: "ready", messageCount: 0 });
    expect(readArtefact(t.stored).manifest).toMatchObject({
      messageCount: 0,
      part2Excluded: 2,
      heldExcluded: 0,
    });
  });

  it("fails closed when the Part 2 flag cannot be read", async () => {
    const t = build(
      { job: job(), channels: [{ id: "ct", kind: "care_team", subjectId: "p1" }], messages: [] },
      {
        part2Patients: async () => {
          throw new Error("seam down");
        },
      },
    );
    expect(await t.builder.buildJob(ORG, JOB)).toEqual({
      outcome: "failed",
      failureCode: "EXPORT_PART2_UNKNOWN",
    });
    expect(t.stored.size).toBe(0);
  });

  it("fails with EXPORT_TOO_LARGE over the cap and stores nothing", async () => {
    const t = build({
      job: job(),
      channels: [{ id: "ch1", kind: "group", subjectId: null }],
      messages: [],
    });
    const store = { ...t.store, count: async () => ({ total: EXPORT_MAX_MESSAGES + 1, held: 0 }) };
    const builder = createExportBuilder({
      store,
      keys: { mint: async () => ({ dek, wrapped: "k:w" }) },
      openBody: async () => "x",
      part2Patients: async () => new Set(),
      putObject: async () => {
        throw new Error("must not store");
      },
    });
    expect(await builder.buildJob(ORG, JOB)).toEqual({
      outcome: "failed",
      failureCode: "EXPORT_TOO_LARGE",
    });
    expect(t.state.failure).toBe("EXPORT_TOO_LARGE");
  });

  it("a decrypt failure fails the job and the outcome carries no plaintext", async () => {
    const t = build(
      {
        job: job(),
        channels: [{ id: "ch1", kind: "group", subjectId: null }],
        messages: [msg("m1", "ch1", "2026-03-01T10:00:00Z")],
      },
      {
        openBody: async () => {
          throw new Error("SECRET PLAINTEXT 4111");
        },
      },
    );
    const out = await t.builder.buildJob(ORG, JOB);
    expect(out).toEqual({ outcome: "failed", failureCode: "EXPORT_BUILD_FAILED" });
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(t.state.failure).toBe("EXPORT_BUILD_FAILED");
    expect(t.stored.size).toBe(0);
  });

  it("a key outage is its own code", async () => {
    const err = Object.assign(new Error("x"), { name: "BodyKeyUnavailableError" });
    const t = build(
      {
        job: job(),
        channels: [{ id: "ch1", kind: "group", subjectId: null }],
        messages: [msg("m1", "ch1", "2026-03-01T10:00:00Z")],
      },
      {
        openBody: async () => {
          throw err;
        },
      },
    );
    expect(await t.builder.buildJob(ORG, JOB)).toEqual({
      outcome: "failed",
      failureCode: "EXPORT_KEY_UNAVAILABLE",
    });
  });

  it("a storage failure fails the job; a failed complete deletes the stored object", async () => {
    const t = build(
      { job: job(), channels: [{ id: "ch1", kind: "group", subjectId: null }], messages: [] },
      {
        putObject: async () => {
          throw new Error("s3 down");
        },
      },
    );
    expect(await t.builder.buildJob(ORG, JOB)).toEqual({
      outcome: "failed",
      failureCode: "EXPORT_STORE_FAILED",
    });

    const deleted = vi.fn(async () => undefined);
    const fake = fakeStore({
      job: job(),
      channels: [{ id: "ch1", kind: "group", subjectId: null }],
      messages: [],
    });
    const builder = createExportBuilder({
      store: {
        ...fake.store,
        complete: async () => {
          throw new Error("db down");
        },
      },
      keys: { mint: async () => ({ dek: Buffer.from(dek), wrapped: "k:w" }) },
      openBody: async () => "x",
      part2Patients: async () => new Set(),
      putObject: async () => undefined,
      deleteObject: deleted,
    });
    expect(await builder.buildJob(ORG, JOB)).toMatchObject({ outcome: "failed" });
    expect(deleted).toHaveBeenCalledWith({
      organizationId: ORG,
      objectKey: `messaging-export/${JOB}.enc`,
    });
  });

  it("is idempotent: a job already past approved is a no-op", async () => {
    const t = build({
      job: job(),
      channels: [{ id: "ch1", kind: "group", subjectId: null }],
      messages: [],
    });
    expect((await t.builder.buildJob(ORG, JOB)).outcome).toBe("ready");
    expect(await t.builder.buildJob(ORG, JOB)).toEqual({ outcome: "skipped" });
    expect(t.stored.size).toBe(1);
  });

  it("pages through more messages than one page, in order, without loss", async () => {
    const messages = Array.from({ length: 1203 }, (_, i) =>
      msg(
        `m${String(i).padStart(5, "0")}`,
        "ch1",
        new Date(Date.UTC(2026, 2, 1, 0, 0, i)).toISOString(),
      ),
    );
    const t = build({
      job: job(),
      channels: [{ id: "ch1", kind: "group", subjectId: null }],
      messages,
    });
    expect(await t.builder.buildJob(ORG, JOB)).toEqual({ outcome: "ready", messageCount: 1203 });
    const ids = readArtefact(t.stored).messages.map((m: { id: string }) => m.id);
    expect(ids).toEqual(messages.map((m) => m.id));
  });
});

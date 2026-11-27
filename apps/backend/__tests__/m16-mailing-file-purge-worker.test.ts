// CW-BR-10 — the mailing-file purge worker WITHOUT a database: it is registered and scheduled with the M16 crons, it refuses to run blind, it hands the M22 seam
// an org-explicit request context, one tenant's refusal never starves the next, and an oversize list is refused whole. (The destroy itself, the holds and
// the tenancy are proven against real Postgres in m16-mailing-file-purge.live.test.ts.)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRequestContext } from "@chartwarden/tenancy";
import type { DocumentId, OrgDocumentAccessProvider } from "@chartwarden/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bull = vi.hoisted(() => {
  const workers: {
    name: string;
    processor: (job: unknown) => Promise<unknown>;
    opts: Record<string, unknown>;
  }[] = [];
  const added: { queue: string; name: string; opts: Record<string, unknown> }[] = [];
  return { workers, added };
});

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(
      public name: string,
      public processor: (job: unknown) => Promise<unknown>,
      public opts: Record<string, unknown>,
    ) {
      bull.workers.push(this);
    }
    on() {
      return this;
    }
    async close() {}
  },
  Queue: class {
    constructor(public name: string) {}
    async add(name: string, _data: unknown, opts: Record<string, unknown>) {
      bull.added.push({ queue: this.name, name, opts });
    }
    async close() {}
  },
}));

import {
  buildM16WorkerDeps,
  registerM16CronWorkers,
  scheduleM16Jobs,
} from "../src/modules/16-bereavement/jobs/cron-workers";
import {
  M16_DLQ,
  M16_JOB_NAMES,
  M16_JOB_SCHEDULES,
  M16_QUEUES,
  M16_QUEUE_PARAMS,
  MAILING_FILE_PURGE_EXECUTE_SUPPORTED,
} from "../src/modules/16-bereavement/jobs/index";
import {
  MailingFilePurgeRefusedError,
  purgeMailingFilesForOrg,
  resolvePurgeMode,
  runMailingFilePurgeCron,
} from "../src/modules/16-bereavement/jobs/mailing-file-purge";

const ORG_A = "a1630000-0000-4000-8000-0000000000a1";
const ORG_B = "b1630000-0000-4000-8000-0000000000b1";
const ORG_C = "c1630000-0000-4000-8000-0000000000c1";
const NOW = new Date("2027-06-30T12:00:00.000Z");

const logged: string[] = [];

const noHolds = {
  activeScopeForOrg: async () => ({ orgWide: false, patientIds: new Set<string>() }),
};

type ListArgs = Parameters<OrgDocumentAccessProvider["listOrgDocumentsForPurge"]>[0];

/** A seam double: `list` answers per org; `destroy` is never expected on these paths. */
function seam(
  list: (args: ListArgs) => ReturnType<OrgDocumentAccessProvider["listOrgDocumentsForPurge"]>,
) {
  const destroyed: string[] = [];
  const provider = {
    listOrgDocumentsForPurge: list,
    destroyOrgDocument: async (args: { documentId: DocumentId }) => {
      destroyed.push(args.documentId);
      return { destroyed: true as const, objectVersionsDestroyed: 1 };
    },
  } as unknown as OrgDocumentAccessProvider;
  return { provider: () => provider, destroyed };
}
const emptyList = async () => ({ documents: [], truncated: false });

const baseDeps = (over: Record<string, unknown> = {}) =>
  ({
    db: {} as never, // never reached: every path here lists nothing, so no tenant row is read
    activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
    legalHolds: noHolds,
    now: () => NOW,
    ...over,
  }) as never;

beforeEach(() => {
  bull.workers.length = 0;
  bull.added.length = 0;
  logged.length = 0;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(JSON.stringify(args));
  });
});

describe("CW-BR-10 — the purge is wired with the M16 crons", () => {
  it("declares one queue, a matching DLQ name, a job name and a daily schedule", () => {
    expect(M16_QUEUES.mailingFilePurge).toBe("m16-mailing-file-purge");
    expect(M16_DLQ.mailingFilePurge).toBe("m16-mailing-file-purge-dlq");
    expect(M16_JOB_NAMES.mailingFilePurge).toBe("m16.mailing-file-purge.cron");
    expect(M16_JOB_SCHEDULES.mailingFilePurge).toBe("30 4 * * *");
    const names = Object.values(M16_QUEUES);
    expect(new Set(names).size).toBe(names.length);
  });

  it("registerM16CronWorkers builds a Worker on that queue (so index.ts's attachDlqAlertsToAll covers it)", () => {
    const deps = buildM16WorkerDeps({
      connection: {} as never,
      db: {} as never,
      outbox: {} as never,
    });
    const workers = registerM16CronWorkers(deps);
    expect(workers.map((w) => w.name)).toContain(M16_QUEUES.mailingFilePurge);
    expect(bull.workers.find((w) => w.name === M16_QUEUES.mailingFilePurge)?.opts.concurrency).toBe(
      M16_QUEUE_PARAMS.mailingFilePurge.concurrency,
    );
  });

  it("scheduleM16Jobs adds the repeatable daily job, keeping failed jobs (the DLQ set the alert watches)", async () => {
    await scheduleM16Jobs({} as never);
    const added = bull.added.find((a) => a.queue === M16_QUEUES.mailingFilePurge);
    expect(added?.name).toBe(M16_JOB_NAMES.mailingFilePurge);
    expect(added?.opts).toMatchObject({
      repeat: { pattern: "30 4 * * *" },
      attempts: 3,
      removeOnFail: false,
    });
  });

  it("the registered processor refuses to run without the M4 legal-hold read (a purge must not run blind)", async () => {
    const deps = buildM16WorkerDeps({
      connection: {} as never,
      db: {} as never,
      outbox: {} as never,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
    });
    registerM16CronWorkers(deps);
    const worker = bull.workers.find((w) => w.name === M16_QUEUES.mailingFilePurge);
    await expect(worker?.processor({})).rejects.toThrow(/M16_WORKER_PORT_UNBOUND: legalHolds/);
  });

  it("the registered processor runs the purge over the deps it was built with", async () => {
    const listActiveOrgs = vi.fn(async () => []);
    const deps = buildM16WorkerDeps({
      connection: {} as never,
      db: {} as never,
      outbox: {} as never,
      activeOrgs: { listActiveOrgs },
      legalHolds: noHolds,
    });
    registerM16CronWorkers(deps);
    const worker = bull.workers.find((w) => w.name === M16_QUEUES.mailingFilePurge);
    await worker?.processor({});
    expect(listActiveOrgs).toHaveBeenCalledOnce();
  });
});

describe("CW-BR-10 — one org's pass", () => {
  it("asks the M22 seam for the org's batch files inside that org's request context, older than the shortest grace", async () => {
    let seenOrg: string | undefined;
    let args: ListArgs | undefined;
    const s = seam(async (a) => {
      seenOrg = getRequestContext()?.organizationId;
      args = a;
      return { documents: [], truncated: false };
    });
    const out = await purgeMailingFilesForOrg(baseDeps({ orgDocuments: s.provider }), ORG_B);
    expect(seenOrg).toBe(ORG_B);
    expect(args).toMatchObject({
      organizationId: ORG_B,
      aggregateType: "bereavement_mailing_batch",
      limit: 1000,
      createdBefore: "2027-06-23T12:00:00.000Z", // now - 7 days
    });
    expect(out).toMatchObject({ mode: "dry_run", due: 0, destroyed: 0 });
  });

  it("EXECUTION IS DISABLED IN CODE: the constant is false (flip it only after the retention class and the §24.2 certificate model are implemented)", () => {
    expect(MAILING_FILE_PURGE_EXECUTE_SUPPORTED).toBe(false);
  });

  it("resolvePurgeMode: the operator's request destroys only when the code allows it; the constant is the only thing to flip", () => {
    for (const config of [undefined, {}, { execute: false }]) {
      expect(resolvePurgeMode(config)).toMatchObject({
        mode: "dry_run",
        executeDisabledInCode: false,
      });
    }
    // asked, but the code gate (the constant, as shipped) is false: a dry run that says so
    expect(resolvePurgeMode({ execute: true })).toEqual({
      mode: "dry_run",
      executeRequested: true,
      executeDisabledInCode: true,
    });
    // the same request with the code gate open is the ONLY way to execute (what the constant being true would mean)
    expect(resolvePurgeMode({ execute: true, executionSupported: true }).mode).toBe("execute");
    expect(
      resolvePurgeMode({ execute: true, executionSupported: MAILING_FILE_PURGE_EXECUTE_SUPPORTED })
        .mode,
    ).toBe("dry_run");
    // the code gate alone never executes: the operator must still ask
    expect(resolvePurgeMode({ executionSupported: true }).mode).toBe("dry_run");
  });

  it("with execute=true and a due file, a pass STILL destroys nothing while execution is disabled in code, and says so; opening the gate is the only difference", async () => {
    const destroyed: string[] = [];
    const provider = {
      listOrgDocumentsForPurge: async () => ({
        documents: [
          {
            documentId: "d1630000-0000-4000-8000-0000000000d1" as DocumentId,
            createdAt: "2027-05-01T00:00:00.000Z" as never,
            held: false,
          },
        ],
        truncated: false as const,
      }),
      destroyOrgDocument: async (args: { documentId: DocumentId }) => {
        destroyed.push(args.documentId);
        return { destroyed: true as const, objectVersionsDestroyed: 1 };
      },
    } as unknown as OrgDocumentAccessProvider;
    // a minimal fake database: the pass reads no run for an unreferenced file and only sets the tenant GUCs
    const tx = {
      execute: async () => [],
      select: () => ({ from: () => ({ where: async () => [] }) }),
    };
    const db = { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };

    logged.length = 0;
    const blocked = await purgeMailingFilesForOrg(
      baseDeps({ db, orgDocuments: () => provider, mailingFilePurge: { execute: true } }),
      ORG_A,
    );
    expect(blocked).toMatchObject({ mode: "dry_run", due: 1, destroyed: 0, failed: 0 });
    expect(destroyed).toEqual([]);
    const line = logged.find((l) => l.includes("DISABLED IN CODE"));
    expect(line).toContain("executeDisabledInCode");
    expect(line).toContain("d1630000-0000-4000-8000-0000000000d1"); // ids and counts only
    expect(logged.filter((l) => l.includes("DISABLED IN CODE"))).toHaveLength(1);

    // the same dependencies with the code gate open: the destroy path runs (proof the gate is the only difference)
    const open = await purgeMailingFilesForOrg(
      baseDeps({
        db,
        orgDocuments: () => provider,
        mailingFilePurge: { execute: true, executionSupported: true },
      }),
      ORG_A,
    );
    expect(open).toMatchObject({ mode: "execute", due: 1, destroyed: 1 });
    expect(destroyed).toEqual(["d1630000-0000-4000-8000-0000000000d1"]);
  });

  it("the composition root never opens the code gate: index.ts and the deps builder do not mention executionSupported", () => {
    const root = join(__dirname, "../src");
    for (const file of ["index.ts", "modules/16-bereavement/jobs/cron-workers.ts"]) {
      // a property being SET (`executionSupported:`), not a comment that names it
      expect(readFileSync(join(root, file), "utf8")).not.toMatch(/executionSupported\s*:/);
    }
  });

  it("refuses a list too long to evaluate, deleting nothing", async () => {
    const s = seam(async () => ({ documents: [], truncated: true }));
    await expect(
      purgeMailingFilesForOrg(
        baseDeps({ orgDocuments: s.provider, mailingFilePurge: { execute: true } }),
        ORG_A,
      ),
    ).rejects.toMatchObject({ name: "MailingFilePurgeRefusedError", code: "LIST_TOO_LARGE" });
    expect(s.destroyed).toEqual([]);
  });

  it("fails closed when the seam refuses the batch type", async () => {
    const s = seam(async () => ({ denied: true as const, reason: "wrong_type" as const }));
    await expect(
      purgeMailingFilesForOrg(baseDeps({ orgDocuments: s.provider }), ORG_A),
    ).rejects.toThrow(/refused the batch type/);
  });

  it("the refusal carries counts and the org id only", () => {
    const err = new MailingFilePurgeRefusedError(
      "PLAN_TOO_LARGE",
      `m16-mailing-file-purge: PLAN_TOO_LARGE org=${ORG_A} due=60 cap=50; nothing was deleted`,
    );
    expect(err.message).toMatch(
      /^m16-mailing-file-purge: PLAN_TOO_LARGE org=[0-9a-f-]{36} due=60 cap=50;/,
    );
  });
});

describe("CW-BR-10 — the daily fan-out", () => {
  it("isolates a tenant that is refused: the next org still runs, then the tick fails so the DLQ alert can fire", async () => {
    const listed: string[] = [];
    const s = seam(async (a) => {
      listed.push(a.organizationId);
      if (a.organizationId === ORG_B) return { documents: [], truncated: true };
      return { documents: [], truncated: false };
    });
    const deps = baseDeps({
      orgDocuments: s.provider,
      activeOrgs: {
        listActiveOrgs: async () => [
          { organizationId: ORG_A },
          { organizationId: ORG_B },
          { organizationId: ORG_C },
        ],
      },
    });
    await expect(runMailingFilePurgeCron(deps)).rejects.toThrow(
      "m16-mailing-file-purge: 1 org(s) refused or failed, 0 file(s) failed; see the ids in the log",
    );
    expect(listed).toEqual([ORG_A, ORG_B, ORG_C]);
  });

  it("a clean tick returns its totals and does not throw", async () => {
    const s = seam(emptyList);
    expect(await runMailingFilePurgeCron(baseDeps({ orgDocuments: s.provider }))).toMatchObject({
      orgs: 1,
      destroyed: 0,
      failedOrgs: 0,
      failedFiles: 0,
    });
  });

  it("refuses to start without the active-org enumerator or the legal-hold read", async () => {
    await expect(runMailingFilePurgeCron(baseDeps({ activeOrgs: undefined }))).rejects.toThrow(
      /activeOrgs/,
    );
    await expect(runMailingFilePurgeCron(baseDeps({ legalHolds: undefined }))).rejects.toThrow(
      /legalHolds/,
    );
  });
});

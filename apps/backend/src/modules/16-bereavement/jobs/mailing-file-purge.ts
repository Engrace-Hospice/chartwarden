// apps/backend/src/modules/16-bereavement/jobs/mailing-file-purge.ts — CW-BR-10: the retention purge of the rendered bereavement mailing batch files.
//
// WHAT IT PURGES. The M22 document of aggregate type `bereavement_mailing_batch` (a name-and-address list for every recipient of one batch): the object in the
// tenant bucket, every version of it, and the document's own state (`destroyed_tombstone`, no active version, cipher shredded; the `document` and
// `document_version` rows stay: ids, hash, size and the opaque key, no PHI). WHICH files are due is the pure rule in `../mailings/file-purge-plan.ts`
// (mailed + 13 months, cancelled + 30 days, a `ready` batch abandoned for 13 months, an unreferenced file after 7 days), and a hold always wins.
//
// THE SPLIT. M16 owns the rule, the runs and the per-run work; M22 owns the document, its versions and the object store, so the destroy goes through M22's
// published `OrgDocumentAccessProvider` seam (`listOrgDocumentsForPurge`, `destroyOrgDocument`), never M22's tables. M16 reads M4's legal-hold scope
// through the `legalHolds` port the composition root binds (`activeLegalHoldScopeForOrg`); unbound, the job REFUSES to run (a purge that cannot see a hold
// must not purge).
//
// WORKERS ARE NOT REQUESTS. Every tenant read opens `withOrgContext` with the org named explicitly, and each seam call runs inside
// `runWithRequestContext` for the same org (the seam reads the ambient context); one tenant's failure never starves the rest of the fan-out.
//
// BOUNDED, DRY-RUN CAPABLE, IDEMPOTENT, RESUMABLE.
//   · DRY RUN is the default: the plan is computed and logged (ids and counts only) and nothing is touched. EXECUTION IS DISABLED IN CODE
//     (`MAILING_FILE_PURGE_EXECUTE_SUPPORTED = false`, jobs/index.ts): the `execute` env switch alone destroys nothing until both owner decisions (retention
//     class, ARCHITECTURE §24.2 certificate model) are implemented and that constant is flipped. Tests enable the destroy path through `executionSupported`.
//   · A per-org CAP: a plan with more due files than the cap is REFUSED WHOLE (nothing is deleted) and the pass throws, so the queue's retries run out and the
//     platform's DLQ promotion alert (CW-MON-01 path, `attachDlqAlertsToAll`) fires. So does a list too long to evaluate.
//   · Each file is independent, destroyed objects-before-rows, and picked from STATE (a destroyed document is no longer listed), so a re-run after any
//     interruption continues where it stopped and a second run over a finished org is a no-op.
//   · The M4 hold scope is read again right before each destroy, under M4's per-org hold advisory lock held SHARED (the M36 protocol; see `purgeOneFile`),
//     so a hold applied in that instant either is seen or waits. A hold that still gets in after the objects went (an M22-level one) makes the file an ALARM
//     (`held_after_destroy`, counted as failed), never a quiet refusal.
// THE RECORD. Destroying flips the document row, and the audit triggers on `document` and `document_version` write one `audit_event` row each (ids, status
// and timestamps; the title, the object key and the cipher are denylisted). The log lines below carry ids and counts and never a name, an address or a key.
import { type DbClient, schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import type {
  DocumentAggregateType,
  DocumentId,
  IsoInstant,
  OrgDocumentAccessProvider,
  OrgId,
} from "@chartwarden/types";
import { messagingHoldLockName } from "@chartwarden/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import {
  DEFAULT_MAILING_FILE_RETENTION,
  type MailingFilePurgeBasis,
  type MailingFileRetention,
  type PlanRun,
  type PlannedPurge,
  clampRetention,
  planMailingFilePurge,
} from "../mailings/file-purge-plan";
import {
  M16_MAILING_FILE_PURGE_DEFAULT_MAX_PER_RUN,
  M16_MAILING_FILE_PURGE_LIST_LIMIT,
  MAILING_FILE_PURGE_EXECUTE_SUPPORTED,
} from "./index";

const RUN = schema.bereavementMailingRun;
const ITEM = schema.bereavementMailingItem;
const PLAN = schema.bereavementPlan;

const BATCH_TYPE: DocumentAggregateType = "bereavement_mailing_batch";
const DAY_MS = 86_400_000;
/** A cron-driven write names no acting membership (the mailing-workers convention). */
const SYSTEM_USER_ID = "";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** M4's active legal-hold scope for one org (the structural slice of `activeLegalHoldScopeForOrg`; M16 does not import M4). */
export interface ActiveLegalHolds {
  /** An active hold names no patient: it covers the whole org. */
  readonly orgWide: boolean;
  /** Patients named by the patient-scoped active holds. */
  readonly patientIds: ReadonlySet<string>;
}

/** What the purge job needs (`M16WorkerDeps` satisfies it structurally). */
export interface MailingFilePurgeDeps {
  readonly db: DbClient;
  readonly activeOrgs?: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  /** M4's legal-hold read, bound at the composition root. Unbound => the job refuses to run. */
  readonly legalHolds?: { activeScopeForOrg(organizationId: string): Promise<ActiveLegalHolds> };
  /** M22's org-document seam; defaults to the registry's `OrgDocumentAccessProvider`. */
  readonly orgDocuments?: () => OrgDocumentAccessProvider;
  readonly mailingFilePurge?: {
    /** The operator's request to destroy (the env switch). It destroys ONLY when the code also allows it (see `executionSupported`); anything else is a DRY RUN. */
    readonly execute?: boolean;
    /**
     * Whether the code allows a destroy. Defaults to `MAILING_FILE_PURGE_EXECUTE_SUPPORTED` (false: execution is disabled in code until the retention class and
     * the §24.2 certificate model are decided and implemented). Set by tests to prove the destroy path; the composition root NEVER sets it.
     */
    readonly executionSupported?: boolean;
    /** The most files one org's pass may destroy; a bigger plan is refused whole. */
    readonly maxFilesPerOrgRun?: number;
    /** Lengthen the retention periods; each is clamped up to its floor. */
    readonly retention?: Partial<MailingFileRetention>;
  };
  now?: () => Date;
}

/** One org's pass, in counts. */
export interface MailingFilePurgeOutcome {
  readonly organizationId: string;
  readonly mode: "dry_run" | "execute";
  /** Files the seam listed (older than the shortest grace). */
  readonly listed: number;
  /** Files the rule made due (a dry run: would be destroyed). */
  readonly due: number;
  /** Files a hold protects. */
  readonly held: number;
  /** Files no rule makes due yet. */
  readonly retained: number;
  readonly destroyed: number;
  /** Due files left alone at the last moment (a hold arrived, the run moved on, M22 refused). */
  readonly refused: number;
  /** Due files whose destroy threw; the next run retries them. */
  readonly failed: number;
  /** `ready` runs moved to `cancelled` because their file is abandoned. */
  readonly runsCancelled: number;
}

/** A plan the job will not act on. The message carries counts only. */
export class MailingFilePurgeRefusedError extends Error {
  constructor(
    readonly code: "PLAN_TOO_LARGE" | "LIST_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "MailingFilePurgeRefusedError";
  }
}

const log = (msg: string, meta: Record<string, unknown>): void => {
  // eslint-disable-next-line no-console -- standalone workers log via console (M9/M20 precedent). IDS AND COUNTS ONLY: never a name, an address or a key.
  console.log(msg, meta);
};

/** One org-scoped transaction, org-explicit (a worker has no request). */
function inOrg<T>(
  deps: MailingFilePurgeDeps,
  organizationId: string,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T> {
  return withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (handle) =>
    fn(handle as DbClient),
  );
}

/** Run a seam call for one org: the seam reads the ambient request context. */
function asOrg<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ organizationId, userId: SYSTEM_USER_ID }, fn);
}

/** Of `runIds`, the runs holding a family of one of `patientIds` (a patient-scoped M4 hold). A non-uuid id fails CLOSED: it holds every run. */
async function runsOfHeldPatients(
  tx: DbClient,
  runIds: readonly string[],
  patientIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const ids = [...patientIds];
  const patients = ids.filter((id) => UUID_SHAPE.test(id));
  // A held id that is not a uuid cannot be matched to anyone, so it must not be dropped (that would fail OPEN): every run then counts as holding a held patient.
  if (patients.length !== ids.length && runIds.length > 0) return new Set(runIds);
  if (runIds.length === 0 || patients.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ runId: ITEM.runId })
    .from(ITEM)
    .innerJoin(PLAN, eq(PLAN.id, ITEM.planId))
    .where(and(inArray(ITEM.runId, [...runIds]), inArray(PLAN.patientId, patients)));
  return new Set(rows.map((r) => r.runId));
}

/** The run (if any) that names each file. */
async function runsNaming(
  deps: MailingFilePurgeDeps,
  organizationId: string,
  documentIds: readonly string[],
  scope: ActiveLegalHolds,
): Promise<Map<string, PlanRun>> {
  if (documentIds.length === 0) return new Map();
  return inOrg(deps, organizationId, async (tx) => {
    const rows = await tx
      .select({
        runId: RUN.id,
        documentId: RUN.renderedDocumentId,
        status: RUN.status,
        version: RUN.version,
        mailedAt: RUN.mailedAt,
        generatedAt: RUN.generatedAt,
        updatedAt: RUN.updatedAt,
      })
      .from(RUN)
      .where(
        and(
          eq(RUN.organizationId, organizationId),
          inArray(RUN.renderedDocumentId, [...documentIds]),
        ),
      );
    const heldRuns = await runsOfHeldPatients(
      tx,
      rows.map((r) => r.runId),
      scope.patientIds,
    );
    const byDocument = new Map<string, PlanRun>();
    for (const r of rows) {
      if (r.documentId === null) continue;
      byDocument.set(r.documentId, {
        runId: r.runId,
        status: r.status,
        version: r.version,
        mailedAt: r.mailedAt,
        generatedAt: r.generatedAt,
        updatedAt: r.updatedAt,
        touchesHeldPatient: heldRuns.has(r.runId),
      });
    }
    return byDocument;
  });
}

type FileResult = "destroyed" | "refused" | "run_moved_on" | "held_after_destroy";
type FileOutcome = { result: FileResult };
/** Run-cancel count shared with the caller: a cancel that was committed counts even when the destroy after it throws. */
type Tally = { runsCancelled: number };

/**
 * One due file. THE HOLD LOCK (the M36 protocol): M4 takes the per-org advisory lock EXCLUSIVE in every hold application (`POST /legal-holds`), so holding it
 * SHARED across the re-read, the run cancel and the destroy means a hold either committed before we look (and we see it) or waits until we are done. The
 * outer transaction only carries the lock; every step below opens its own.
 */
async function purgeOneFile(
  deps: MailingFilePurgeDeps,
  docs: OrgDocumentAccessProvider,
  legalHolds: NonNullable<MailingFilePurgeDeps["legalHolds"]>,
  organizationId: string,
  item: PlannedPurge,
  tally: Tally,
): Promise<FileOutcome> {
  return inOrg(deps, organizationId, async (lockTx) => {
    await lockTx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${messagingHoldLockName(organizationId)}, 0))`,
    );
    return purgeOneFileUnderLock(deps, docs, legalHolds, organizationId, item, tally);
  });
}

/** Re-check M4 holds, cancel an abandoned `ready` run, destroy through the M22 seam. */
async function purgeOneFileUnderLock(
  deps: MailingFilePurgeDeps,
  docs: OrgDocumentAccessProvider,
  legalHolds: NonNullable<MailingFilePurgeDeps["legalHolds"]>,
  organizationId: string,
  item: PlannedPurge,
  tally: Tally,
): Promise<FileOutcome> {
  const holds = await legalHolds.activeScopeForOrg(organizationId);
  if (holds.orgWide) return { result: "refused" };
  if (holds.patientIds.size > 0) {
    // an unreferenced file's recipients are unknown: any patient-scoped hold protects it
    const runId = item.runId;
    const heldRuns =
      runId === null
        ? null
        : await inOrg(deps, organizationId, (tx) =>
            runsOfHeldPatients(tx, [runId], holds.patientIds),
          );
    if (heldRuns === null || heldRuns.size > 0) return { result: "refused" };
  }

  if (item.cancelRunFirst && item.runId !== null && item.runVersion !== null) {
    const { runId, runVersion } = item;
    // A `ready` run must name a document, so the run goes first, in one compare-and-set on the version read at plan time.
    const cancelled = await inOrg(deps, organizationId, (tx) =>
      tx
        .update(RUN)
        .set({
          status: "cancelled",
          version: runVersion + 1,
          updatedAt: (deps.now ?? (() => new Date()))(),
        })
        .where(
          and(
            eq(RUN.id, runId),
            eq(RUN.organizationId, organizationId),
            eq(RUN.status, "ready"),
            eq(RUN.version, runVersion),
          ),
        )
        .returning({ id: RUN.id }),
    );
    if (cancelled.length === 0) return { result: "run_moved_on" };
    tally.runsCancelled += 1;
  }

  const outcome = await asOrg(organizationId, () =>
    docs.destroyOrgDocument({
      organizationId: organizationId as OrgId,
      documentId: item.documentId as DocumentId,
      allowedAggregateTypes: [BATCH_TYPE],
    }),
  );
  if ("destroyed" in outcome) return { result: "destroyed" };
  return { result: outcome.reason === "held_after_destroy" ? "held_after_destroy" : "refused" };
}

const idsByBasis = (due: readonly PlannedPurge[]): Record<MailingFilePurgeBasis, string[]> => ({
  mailed_retention: due.filter((d) => d.basis === "mailed_retention").map((d) => d.documentId),
  cancelled_grace: due.filter((d) => d.basis === "cancelled_grace").map((d) => d.documentId),
  cancelled_past_floor: due
    .filter((d) => d.basis === "cancelled_past_floor")
    .map((d) => d.documentId),
  abandoned_ready: due.filter((d) => d.basis === "abandoned_ready").map((d) => d.documentId),
  unreferenced: due.filter((d) => d.basis === "unreferenced").map((d) => d.documentId),
});

const UNBOUND_LEGAL_HOLDS =
  "M16_WORKER_PORT_UNBOUND: legalHolds.activeScopeForOrg — bind M4's active legal-hold read; a purge that cannot see a hold must not run";

/**
 * Whether a pass may destroy: the operator asked (`execute`, the env switch) AND the code allows it (`MAILING_FILE_PURGE_EXECUTE_SUPPORTED`, or a test's
 * `executionSupported`). Pure. With the code gate false, `execute: true` is a dry run that says so.
 */
export function resolvePurgeMode(config: MailingFilePurgeDeps["mailingFilePurge"]): {
  readonly mode: "dry_run" | "execute";
  readonly executeRequested: boolean;
  readonly executeDisabledInCode: boolean;
} {
  const executeRequested = config?.execute === true;
  const supported = config?.executionSupported ?? MAILING_FILE_PURGE_EXECUTE_SUPPORTED;
  return {
    mode: executeRequested && supported ? "execute" : "dry_run",
    executeRequested,
    executeDisabledInCode: executeRequested && !supported,
  };
}

/** One org's pass. Throws {@link MailingFilePurgeRefusedError} (nothing deleted) when the plan is too big to act on. */
export async function purgeMailingFilesForOrg(
  deps: MailingFilePurgeDeps,
  organizationId: string,
): Promise<MailingFilePurgeOutcome> {
  const legalHolds = deps.legalHolds;
  if (legalHolds === undefined) throw new Error(UNBOUND_LEGAL_HOLDS);
  const now = (deps.now ?? (() => new Date()))();
  const { mode, executeDisabledInCode } = resolvePurgeMode(deps.mailingFilePurge);
  const execute = mode === "execute";
  const cap = Math.max(
    1,
    Math.floor(
      deps.mailingFilePurge?.maxFilesPerOrgRun ?? M16_MAILING_FILE_PURGE_DEFAULT_MAX_PER_RUN,
    ),
  );
  const retention = clampRetention({
    ...DEFAULT_MAILING_FILE_RETENTION,
    ...deps.mailingFilePurge?.retention,
  });
  const docs = (deps.orgDocuments ?? (() => getSeam("OrgDocumentAccessProvider")))();

  const scope = await legalHolds.activeScopeForOrg(organizationId);
  // Nothing younger than the shortest grace can be due under any rule (the long ones count from the run, never before the render), so the list stops there.
  const shortestGraceDays = Math.min(retention.unreferencedGraceDays, retention.cancelledGraceDays);
  const createdBefore = new Date(now.getTime() - shortestGraceDays * DAY_MS);
  const listed = await asOrg(organizationId, () =>
    docs.listOrgDocumentsForPurge({
      organizationId: organizationId as OrgId,
      aggregateType: BATCH_TYPE,
      createdBefore: createdBefore.toISOString() as IsoInstant,
      limit: M16_MAILING_FILE_PURGE_LIST_LIMIT,
    }),
  );
  if ("denied" in listed) {
    throw new Error("m16-mailing-file-purge: the document seam refused the batch type");
  }
  if (listed.truncated) {
    throw new MailingFilePurgeRefusedError(
      "LIST_TOO_LARGE",
      `m16-mailing-file-purge: LIST_TOO_LARGE org=${organizationId} more than ${M16_MAILING_FILE_PURGE_LIST_LIMIT} files to evaluate; nothing was deleted`,
    );
  }

  const files = listed.documents.map((d) => ({
    documentId: d.documentId as string,
    createdAt: new Date(d.createdAt),
    heldByDocumentStore: d.held,
  }));
  const runsByDocument = await runsNaming(
    deps,
    organizationId,
    files.map((f) => f.documentId),
    scope,
  );
  const plan = planMailingFilePurge({
    files,
    runsByDocument,
    holds: { orgWide: scope.orgWide, patientScoped: scope.patientIds.size > 0 },
    retention,
    now,
  });
  const base = {
    organizationId,
    mode,
    listed: files.length,
    due: plan.due.length,
    held: plan.held,
    retained: plan.retained,
  } as const;

  if (!execute) {
    log(
      executeDisabledInCode
        ? "m16.mailing-file-purge: EXECUTE REQUESTED BUT DISABLED IN CODE (CW-BR-10 owner decisions pending): DRY RUN, nothing destroyed"
        : "m16.mailing-file-purge: DRY RUN (nothing destroyed)",
      {
        ...base,
        cap,
        wouldRefuse: plan.due.length > cap,
        executeDisabledInCode,
        documentIdsByBasis: idsByBasis(plan.due),
      },
    );
    return { ...base, destroyed: 0, refused: 0, failed: 0, runsCancelled: 0 };
  }

  if (plan.due.length > cap) {
    log("m16.mailing-file-purge: plan refused whole (nothing destroyed)", { ...base, cap });
    throw new MailingFilePurgeRefusedError(
      "PLAN_TOO_LARGE",
      `m16-mailing-file-purge: PLAN_TOO_LARGE org=${organizationId} due=${plan.due.length} cap=${cap}; nothing was deleted`,
    );
  }

  let destroyed = 0;
  let refused = 0;
  let failed = 0;
  const tally: Tally = { runsCancelled: 0 };
  for (const item of plan.due) {
    try {
      const one = await purgeOneFile(deps, docs, legalHolds, organizationId, item, tally);
      if (one.result === "destroyed") {
        destroyed += 1;
        // the record of the purge: ids and the rule only (the audit triggers on `document` / `document_version` hold the durable copy)
        log("m16.mailing-file-purge: file destroyed", {
          organizationId,
          documentId: item.documentId,
          basis: item.basis,
          runId: item.runId,
        });
      } else if (one.result === "held_after_destroy") {
        // The bytes are gone but a hold got in: not a quiet refusal. Counted as FAILED so the tick throws and the DLQ alert fires for a human.
        failed += 1;
        log(
          "m16.mailing-file-purge: ALARM objects destroyed but the document is held (needs a human)",
          {
            organizationId,
            documentId: item.documentId,
            basis: item.basis,
            runId: item.runId,
          },
        );
      } else {
        refused += 1;
        log("m16.mailing-file-purge: file left alone at the last check", {
          organizationId,
          documentId: item.documentId,
          basis: item.basis,
          why: one.result,
        });
      }
    } catch (error) {
      failed += 1;
      // NEVER the message: a store error can echo a key. The class and the ids find it.
      log("m16.mailing-file-purge: file destroy failed (retried next run)", {
        organizationId,
        documentId: item.documentId,
        basis: item.basis,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  const outcome = { ...base, destroyed, refused, failed, runsCancelled: tally.runsCancelled };
  log("m16.mailing-file-purge: org pass done", outcome);
  return outcome;
}

/** The daily fan-out: every active org, isolated. Throws (so the queue retries, then the DLQ alert fires) when any org was refused or any file failed. */
export async function runMailingFilePurgeCron(deps: MailingFilePurgeDeps): Promise<{
  orgs: number;
  destroyed: number;
  due: number;
  held: number;
  failedOrgs: number;
  failedFiles: number;
}> {
  const orgs = deps.activeOrgs;
  if (orgs === undefined) {
    throw new Error(
      "M16_WORKER_PORT_UNBOUND: activeOrgs.listActiveOrgs — bind the M2 active-org enumerator",
    );
  }
  if (deps.legalHolds === undefined) throw new Error(UNBOUND_LEGAL_HOLDS);
  const totals = { orgs: 0, destroyed: 0, due: 0, held: 0, failedOrgs: 0, failedFiles: 0 };
  for (const { organizationId } of await orgs.listActiveOrgs()) {
    totals.orgs += 1;
    try {
      const outcome = await purgeMailingFilesForOrg(deps, organizationId);
      totals.destroyed += outcome.destroyed;
      totals.due += outcome.due;
      totals.held += outcome.held;
      totals.failedFiles += outcome.failed;
    } catch (error) {
      totals.failedOrgs += 1;
      log("m16.mailing-file-purge: an org was refused or failed", {
        organizationId,
        code: error instanceof MailingFilePurgeRefusedError ? error.code : "ERROR",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  log("m16.mailing-file-purge: tick done", totals);
  if (totals.failedOrgs > 0 || totals.failedFiles > 0) {
    throw new Error(
      `m16-mailing-file-purge: ${totals.failedOrgs} org(s) refused or failed, ${totals.failedFiles} file(s) failed; see the ids in the log`,
    );
  }
  return totals;
}

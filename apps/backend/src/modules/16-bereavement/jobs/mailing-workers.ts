import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
// apps/backend/src/modules/16-bereavement/jobs/mailing-workers.ts — ADR-0109 D10: the two mailing workers.
//
//   · `m16-mailing-sweep` (*/5) — for every active org, three idempotent passes:
//       1. DRAFT   each enabled config's due occurrence becomes a run, `ON CONFLICT (organization_id, occurrence_key) DO NOTHING`, so a hundred ticks draft one.
//       2. RE-SEND a run that has sat in `generating` too long (a lost enqueue after the claim commit, or a dead worker): the BullMQ job id carries the run
//          version, so a duplicate send collapses.
//       3. LOG     a `mailed` run's `included` items become contact-log ACTIVITY rows in chunks of 500, set-based (`INSERT ... SELECT ... SKIP LOCKED`),
//          idempotent on the activity unique index. Activity rows satisfy no cadence item and never count in M30.
//   · `m16-mailing-generate` — one job per claimed run. Decrypts every addressee's mailing address IN-PROCESS, then RE-CHECKS eligibility (an opt-out or a
//     closure since `generate` drops that item as `excluded` with its reason; nobody left fails the run `NO_RECIPIENTS`) and touches the run's `updated_at` so
//     the sweep's stale re-send does not fire on a slow decrypt, and hands name, address lines and greeting to
//     `getSeam("DocumentRenderer").render(...)` in memory: the addresses are never on the outbox, in a queue payload, in a log line or in a run column. It numbers the
//     letters (ordinal = the letter's position, 1-based; a long letter spans several pages), moves the run to `ready` in one compare-and-set (each attempt renders under its OWN document id, so the run names exactly the
//     winner's PDF; the claim is abandoned if a rendered recipient was excluded meanwhile), and on the FINAL failed attempt moves it to `failed` (the retry budget exhausted
//     is the DLQ: `removeOnFail: false` keeps the failed set, and the platform's DLQ promotion alert watches it).
//
// WORKERS ARE NOT REQUESTS: each step opens its own org-explicit `withOrgContext` (the cron-workers convention); a render is never held inside a transaction.
import {
  BEREAVEMENT_MAILING_BATCH_TEMPLATE_KEY,
  type BereavementMailingBatchRenderPayload,
  type BereavementMailingContent,
  type DocumentRenderer,
} from "@chartwarden/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import { type BereavementCipher, BereavementCipherBlobError } from "../bereavement-crypto";
import { assertMailingContentComplete, personalizeGreeting } from "../mailings/content";
import {
  type MailingGenerateEnqueuePort,
  type MailingGenerateJob,
  mailingGenerateJobId,
} from "../mailings/enqueue-port";
import { flagItems, ineligibleIncludedItems } from "../mailings/facts-drizzle";
import { activityKindOfRun, nextOccurrences, runKindOf } from "../mailings/occurrence";
import {
  M16_MAILING_LOG_CHUNK,
  M16_MAILING_LOG_MAX_CHUNKS_PER_TICK,
  M16_MAILING_STALE_GENERATING_MS,
  M16_QUEUES,
  M16_QUEUE_PARAMS,
} from "./index";

/** The renderer hand-off: org + typed payload in, the rendered document's id out. Defaults to the registry's `DocumentRenderer`. */
export type MailingBatchRenderer = (
  organizationId: string,
  payload: BereavementMailingBatchRenderPayload,
) => Promise<{ readonly documentId: string }>;

/** What the mailing workers need (`M16WorkerDeps` satisfies it structurally). */
export interface MailingWorkerDeps {
  readonly db: DbClient;
  readonly connection: ConnectionOptions;
  readonly activeOrgs?: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  /** The tenant-DEK envelope the mailing addresses are opened with. Unbound => a generate job fails closed. */
  readonly cipher?: BereavementCipher;
  /** Re-sends a stale `generating` run. Unbound => the sweep skips that pass (the next boot with a queue catches up). */
  readonly mailingEnqueue?: MailingGenerateEnqueuePort;
  readonly render?: MailingBatchRenderer;
  /** Is an email channel bound for this tenant? Defaults to false (see mailings/eligibility.ts); must match the route service's value. */
  readonly emailChannelAvailable?: boolean;
  now?: () => Date;
}

const RUN = schema.bereavementMailingRun;
const ITEM = schema.bereavementMailingItem;
const CONFIG = schema.bereavementMailingConfig;
const CONTACT = schema.bereavedContact;

/** A cron-driven write names no acting membership (the cron-workers convention). */
const SYSTEM_USER_ID = "";
const MAX_ADDRESS_LINES = 8;

const log = (msg: string, meta: Record<string, unknown>): void => {
  // eslint-disable-next-line no-console -- standalone workers log via console (M9/M20 precedent). IDS AND COUNTS ONLY: never a name or an address.
  console.log(msg, meta);
};

/** One org-scoped transaction, org-explicit (a worker has no request). */
function inOrg<T>(
  deps: MailingWorkerDeps,
  organizationId: string,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T> {
  return runWithRequestContext({ organizationId, userId: SYSTEM_USER_ID }, () =>
    withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (handle) =>
      fn(handle as DbClient),
    ),
  );
}

const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

// ── the sweep ───────────────────────────────────────────────────────────────────────────────────────

/** Draft a run for every enabled config occurrence whose draft window is open today. Returns the runs actually created. */
export async function draftDueMailingRuns(
  deps: MailingWorkerDeps,
  organizationId: string,
  now: Date,
): Promise<number> {
  return inOrg(deps, organizationId, async (tx) => {
    const configs = await tx.select().from(CONFIG).where(eq(CONFIG.enabled, true));
    if (configs.length === 0) return 0;
    const byKey = new Map(configs.map((c) => [c.mailingKey, c]));
    const occurrences = nextOccurrences(
      configs.map((c) => ({
        mailingKey: c.mailingKey,
        enabled: c.enabled,
        leadDays: c.leadDays,
        schedule: c.scheduleJsonb as never,
      })),
      utcDate(now),
    );
    let created = 0;
    for (const occ of occurrences) {
      const config = byKey.get(occ.mailingKey);
      if (config === undefined) continue;
      const inserted = await tx
        .insert(RUN)
        .values({
          organizationId,
          runKind: runKindOf(occ.mailingKey),
          mailingKey: occ.mailingKey,
          occurrenceKey: occ.occurrenceKey,
          scheduledFor: occ.scheduledFor,
          // The wording is SNAPSHOT here: an edit to the config afterwards does not rewrite a draft (staff edit the draft's own wording).
          contentJsonb: config.contentJsonb,
        })
        .onConflictDoNothing({ target: [RUN.organizationId, RUN.occurrenceKey] })
        .returning({ id: RUN.id });
      created += inserted.length;
    }
    return created;
  });
}

/** Re-send the render hand-off of every run stuck in `generating`. Returns how many were re-sent. */
export async function requeueStaleGeneratingRuns(
  deps: MailingWorkerDeps,
  organizationId: string,
  now: Date,
): Promise<number> {
  if (deps.mailingEnqueue === undefined) return 0;
  const stale = await inOrg(deps, organizationId, (tx) =>
    tx
      .select({ id: RUN.id, version: RUN.version })
      .from(RUN)
      .where(
        and(
          eq(RUN.status, "generating"),
          lt(RUN.updatedAt, new Date(now.getTime() - M16_MAILING_STALE_GENERATING_MS)),
        ),
      )
      .orderBy(asc(RUN.updatedAt))
      .limit(50),
  );
  // The re-send carries a time bucket in its job id: the original job (or its failed record, retained as the DLQ) holds the plain id, so a
  // re-send under the same id would be a no-op and a run whose worker died would stay `generating` for ever.
  const resendEpoch = Math.floor(now.getTime() / M16_MAILING_STALE_GENERATING_MS);
  for (const run of stale) {
    await deps.mailingEnqueue.enqueue({
      organizationId,
      runId: run.id,
      version: run.version,
      resendEpoch,
    });
  }
  return stale.length;
}

/** One chunk of activity rows for one mailed run, set-based. Returns how many items it moved to `logged`. */
async function logOneChunk(
  tx: DbClient,
  run: {
    readonly id: string;
    readonly activityKind: string;
    readonly mailedAt: Date;
    readonly mailedBy: string;
  },
): Promise<number> {
  // `log.id = item.id`: the item names its activity row without a lookup, and a replayed chunk conflicts on the activity unique index instead of double-logging.
  const rows = await tx.execute(sql`
    WITH chunk AS (
      SELECT i.id, i.organization_id, i.provider_entity_id, i.location_id, i.plan_id, i.bereaved_contact_id
        FROM bereavement_mailing_item i
       WHERE i.run_id = ${run.id}::uuid AND i.status = 'included'
       ORDER BY i.ordinal NULLS LAST, i.id
       LIMIT ${M16_MAILING_LOG_CHUNK}
         FOR UPDATE SKIP LOCKED
    ), ins AS (
      INSERT INTO bereavement_contact_log
        (id, organization_id, provider_entity_id, location_id, plan_id, bereaved_contact_id, contact_at, outcome,
         activity_kind, activity_ref_id, logged_by_user_id, contact_responded_directly)
      SELECT c.id, c.organization_id, c.provider_entity_id, c.location_id, c.plan_id, c.bereaved_contact_id,
             ${run.mailedAt.toISOString()}::timestamptz, 'mailed', ${run.activityKind}, ${run.id}::uuid, ${run.mailedBy}::uuid, false
        FROM chunk c
      ON CONFLICT (activity_ref_id, bereaved_contact_id, activity_kind, contact_at) WHERE activity_ref_id IS NOT NULL DO NOTHING
      RETURNING id
    )
    UPDATE bereavement_mailing_item i
       SET status = 'logged', log_id = i.id, updated_at = now()
      FROM chunk
     WHERE i.id = chunk.id
    RETURNING i.id
  `);
  return (rows as unknown as { rowCount: number | null }).rowCount ?? 0;
}

/** Write the activity rows of every mailed run that still owes some. Returns the items logged. */
export async function logMailedRuns(
  deps: MailingWorkerDeps,
  organizationId: string,
): Promise<number> {
  const owing = await inOrg(deps, organizationId, (tx) =>
    tx
      .select({
        id: RUN.id,
        runKind: RUN.runKind,
        mailedAt: RUN.mailedAt,
        mailedBy: RUN.mailedByMembershipId,
      })
      .from(RUN)
      .where(
        and(
          eq(RUN.status, "mailed"),
          sql`EXISTS (SELECT 1 FROM ${ITEM} i WHERE i.run_id = ${RUN.id} AND i.status = 'included')`,
        ),
      )
      .orderBy(asc(RUN.mailedAt))
      .limit(20),
  );
  let logged = 0;
  for (const run of owing) {
    if (run.mailedAt === null || run.mailedBy === null) continue; // the run CHECK makes this unreachable
    const target = {
      id: run.id,
      activityKind: activityKindOfRun(run.runKind),
      mailedAt: run.mailedAt,
      mailedBy: run.mailedBy,
    };
    for (let chunk = 0; chunk < M16_MAILING_LOG_MAX_CHUNKS_PER_TICK; chunk += 1) {
      const n = await inOrg(deps, organizationId, (tx) => logOneChunk(tx, target));
      logged += n;
      if (n === 0) break;
    }
  }
  return logged;
}

/** §4.9-style fan-out: the three sweep passes for every active org. */
export async function runMailingSweepCron(
  deps: MailingWorkerDeps,
): Promise<{ drafted: number; requeued: number; logged: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = deps.activeOrgs;
  if (orgs === undefined) {
    throw new Error(
      "M16_WORKER_PORT_UNBOUND: activeOrgs.listActiveOrgs — bind the M2 active-org enumerator",
    );
  }
  let drafted = 0;
  let requeued = 0;
  let logged = 0;
  let failedOrgs = 0;
  for (const { organizationId } of await orgs.listActiveOrgs()) {
    // One tenant's failure must not starve every later tenant on every tick: isolate per org, finish the fan-out, then fail the tick.
    try {
      drafted += await draftDueMailingRuns(deps, organizationId, now);
      requeued += await requeueStaleGeneratingRuns(deps, organizationId, now);
      logged += await logMailedRuns(deps, organizationId);
    } catch (error) {
      failedOrgs += 1;
      log("m16.mailing-sweep: an org failed", {
        organizationId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  if (drafted + requeued + logged > 0) log("m16.mailing-sweep", { drafted, requeued, logged });
  // BullMQ retries the tick; every pass is idempotent, so the orgs that succeeded are not redone.
  if (failedOrgs > 0) throw new Error(`m16-mailing-sweep: ${failedOrgs} org(s) failed`);
  return { drafted, requeued, logged };
}

// ── the generate job ────────────────────────────────────────────────────────────────────────────────

/** A mailing address as printable lines: one per input line, blanks dropped, at most {@link MAX_ADDRESS_LINES}. Pure. */
export function addressLinesOf(address: string): string[] {
  // ponytail: newline-split only; a single-line address prints on one line. Parsing / validating addresses is deferred (blueprint section 4).
  return address
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_ADDRESS_LINES);
}

const defaultRender: MailingBatchRenderer = (organizationId, payload) =>
  (getSeam("DocumentRenderer") as DocumentRenderer).render(
    { orgId: organizationId as never },
    BEREAVEMENT_MAILING_BATCH_TEMPLATE_KEY,
    payload,
  );

async function failRun(
  deps: MailingWorkerDeps,
  organizationId: string,
  runId: string,
  version: number,
  code: string,
): Promise<void> {
  await inOrg(deps, organizationId, (tx) =>
    tx
      .update(RUN)
      .set({ status: "failed", failureCode: code, version: version + 1, updatedAt: new Date() })
      .where(and(eq(RUN.id, runId), eq(RUN.status, "generating"), eq(RUN.version, version))),
  );
}

/** Thrown inside the ready compare-and-set to roll it back: the rendered PDF names someone excluded since this attempt's re-check. */
class AbandonedRenderError extends Error {
  constructor() {
    super("ABANDONED_RENDER");
    this.name = "AbandonedRenderError";
  }
}

/** Thrown for a failure that retrying cannot fix (the run is failed at once, not after the retry budget). */
class TerminalMailingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TerminalMailingError";
  }
}

/**
 * Render one claimed run. Idempotent: a run that is no longer `generating` at this version (already rendered, cancelled-and-regenerated, a duplicate delivery)
 * is a logged skip. `finalAttempt` is true on the last BullMQ attempt: a failure then moves the run to `failed` so staff can see it and retry.
 */
export async function runMailingGenerateJob(
  deps: MailingWorkerDeps,
  job: MailingGenerateJob,
  opts: { readonly finalAttempt: boolean } = { finalAttempt: true },
): Promise<void> {
  const { organizationId, runId, version } = job;
  const claim = await inOrg(deps, organizationId, async (tx) => {
    const [run] = await tx.select().from(RUN).where(eq(RUN.id, runId)).limit(1);
    if (!run || run.status !== "generating" || run.version !== version) return null;
    const items = await tx
      .select({
        itemId: ITEM.id,
        displayName: CONTACT.displayName,
        addressCipher: CONTACT.mailingAddressCipher,
      })
      .from(ITEM)
      .innerJoin(CONTACT, eq(CONTACT.id, ITEM.bereavedContactId))
      .where(and(eq(ITEM.runId, runId), eq(ITEM.status, "included")))
      .orderBy(asc(CONTACT.createdAt), asc(CONTACT.id));
    return { run, items };
  });
  if (claim === null) {
    log("m16.mailing-generate: run is not generating at this version — skipped", {
      organizationId,
      runId,
      version,
    });
    return;
  }

  /** This attempt's rendered document, once filed: named in the log when it ends up unreferenced, so a later purge can find it. */
  let documentId: string | null = null;
  try {
    if (deps.cipher === undefined) throw new TerminalMailingError("CIPHER_UNBOUND");
    const wording = assertMailingContentComplete(
      claim.run.contentJsonb as BereavementMailingContent,
    );

    // Decrypt OUTSIDE any transaction (the key provider takes its own connection), in-process, and keep the plaintext in this frame only.
    const letters: Omit<BereavementMailingBatchRenderPayload["letters"][number], "ref">[] = [];
    const letterItemIds: string[] = [];
    const dropped: string[] = [];
    for (const item of claim.items) {
      const address = await openAddress(deps.cipher, organizationId, item.addressCipher);
      const lines = address === null ? [] : addressLinesOf(address);
      if (lines.length === 0 || item.displayName.trim().length === 0) {
        dropped.push(item.itemId);
        continue;
      }
      letterItemIds.push(item.itemId);
      letters.push({
        recipientName: item.displayName.trim(),
        addressLines: lines,
        greeting: personalizeGreeting(wording.greeting, item.displayName),
      });
    }

    // Immediately before rendering: re-decide every included item against TODAY's facts (an opt-out or a closure since `generate` must not be printed),
    // and touch `updated_at` so a slow decrypt does not look like a lost job to the sweep's stale re-send.
    const recheck = await inOrg(deps, organizationId, async (tx) => {
      const [touched] = await tx
        .update(RUN)
        .set({ updatedAt: new Date() })
        .where(and(eq(RUN.id, runId), eq(RUN.status, "generating"), eq(RUN.version, version)))
        .returning({ id: RUN.id, mailingKey: RUN.mailingKey });
      if (!touched) return null;
      const ineligible = await ineligibleIncludedItems(
        tx,
        touched,
        deps.emailChannelAvailable ?? false,
      );
      await flagItems(tx, ineligible, "excluded");
      return ineligible;
    });
    if (recheck === null) {
      log("m16.mailing-generate: run moved on before rendering — skipped", {
        organizationId,
        runId,
        version,
      });
      return;
    }
    const kept = letterItemIds.flatMap((itemId, i) =>
      recheck.has(itemId) ? [] : [{ itemId, letter: letters[i] as (typeof letters)[number] }],
    );
    // the printed "Ref N" is the ordinal written below (the letter's 1-based position in the batch)
    const numbered = kept.map((k, i) => ({ ...k.letter, ref: i + 1 }));
    const unaddressed = dropped.filter((itemId) => !recheck.has(itemId));
    if (kept.length === 0) throw new TerminalMailingError("NO_RECIPIENTS");

    // Every ATTEMPT files its OWN document (never the run id): a late or duplicate job (a sweep re-send, a stalled redelivery) that loses the
    // compare-and-set below leaves an unreferenced document behind, instead of appending a version that would become the active PDF of the
    // document the winner's `rendered_document_id` names.
    ({ documentId } = await (deps.render ?? defaultRender)(organizationId, {
      aggregateId: randomUUID(),
      heading: wording.title,
      paragraphs: wording.paragraphs,
      // no default wording ships: an empty sign-off is simply not printed
      ...(wording.signoff.length > 0 ? { signoff: wording.signoff } : {}),
      letters: numbered,
    }));
    const renderedDocumentId = documentId;

    const at = (deps.now ?? (() => new Date()))();
    const won = await inOrg(deps, organizationId, async (tx) => {
      // The RUN row first (the compare-and-set takes its lock), then the items: the order every other mailing writer takes them in.
      const [ready] = await tx
        .update(RUN)
        .set({
          status: "ready",
          renderedDocumentId,
          generatedAt: at,
          recipientCount: kept.length,
          version: version + 1,
          updatedAt: at,
        })
        .where(and(eq(RUN.id, runId), eq(RUN.status, "generating"), eq(RUN.version, version)))
        .returning({ id: RUN.id });
      if (!ready) return false; // moved on while rendering: this attempt's document is an unreferenced orphan, the run is not touched
      if (unaddressed.length > 0) {
        await tx
          .update(ITEM)
          .set({
            status: "excluded",
            exclusionReason: "no_mailing_address",
            ordinal: null,
            updatedAt: at,
          })
          // only items still `included`: an overlapping attempt may have excluded one meanwhile, and its reason stands
          .where(and(inArray(ITEM.id, unaddressed), eq(ITEM.status, "included")));
      }
      // The PDF holds exactly `kept`. An overlapping attempt's re-check may have excluded one of them since OUR re-check (an opt-out in
      // between): then this PDF names someone it must not, so the whole claim rolls back and the newer attempt (or the sweep) renders it.
      const [{ n: included } = { n: -1 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(ITEM)
        .where(and(eq(ITEM.runId, runId), eq(ITEM.status, "included")));
      if (included !== kept.length) throw new AbandonedRenderError();
      // ordinal = the letter's position in the batch (a letter longer than a page spans several pages)
      const keptIds = kept.map((k) => k.itemId);
      for (let i = 0; i < keptIds.length; i += M16_MAILING_LOG_CHUNK) {
        const slice = keptIds.slice(i, i + M16_MAILING_LOG_CHUNK);
        const values = sql.join(
          slice.map((id, k) => sql`(${id}::uuid, ${i + k + 1}::int)`),
          sql`, `,
        );
        await tx.execute(
          sql`UPDATE bereavement_mailing_item AS t SET ordinal = v.ord, updated_at = now() FROM (VALUES ${values}) AS v(id, ord) WHERE t.id = v.id`,
        );
      }
      // The excluded count is the items', not a sum carried from the claim (an overlapping attempt may already have flagged some).
      const [{ n: excluded } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(ITEM)
        .where(and(eq(ITEM.runId, runId), eq(ITEM.status, "excluded")));
      await tx.update(RUN).set({ excludedCount: excluded }).where(eq(RUN.id, runId));
      return true;
    });
    if (!won) {
      log(
        "m16.mailing-generate: run moved on while rendering — this attempt's document is unreferenced",
        {
          organizationId,
          runId,
          version,
          documentId,
        },
      );
      return;
    }
    log("m16.mailing-generate: rendered", {
      organizationId,
      runId,
      letters: kept.length,
      dropped: unaddressed.length,
      noLongerEligible: recheck.size,
    });
  } catch (error) {
    if (error instanceof AbandonedRenderError) {
      // Not a failure: the run stays `generating` and a newer attempt (or the sweep's stale re-send) renders the current batch.
      // this attempt's document is unreferenced (the claim rolled back): its id is logged so a purge can find it
      log("m16.mailing-generate: a rendered recipient was excluded meanwhile — claim abandoned", {
        organizationId,
        runId,
        version,
        documentId,
      });
      return;
    }
    const terminal = error instanceof TerminalMailingError;
    const code = terminal ? error.code : "RENDER_FAILED";
    // NEVER the message: a renderer error can echo its payload (names and addresses). The class name and the ids are enough to find it.
    log("m16.mailing-generate: failed", {
      organizationId,
      runId,
      code,
      error: error instanceof Error ? error.name : "unknown",
      finalAttempt: opts.finalAttempt,
    });
    if (terminal || opts.finalAttempt) await failRun(deps, organizationId, runId, version, code);
    // A terminal failure (nothing to render, no cipher) is recorded on the run and is not worth a retry; anything else is retried by BullMQ.
    // The thrown error is SANITIZED: BullMQ keeps `failedReason` and the stack in Valkey for good (`removeOnFail: false`), and a renderer
    // error can echo its payload (names and addresses). A code and the error class are enough to find the cause.
    if (!terminal) throw new Error(`${code}:${error instanceof Error ? error.name : "unknown"}`);
  }
}

async function openAddress(
  cipher: BereavementCipher,
  organizationId: string,
  blob: string | null,
): Promise<string | null> {
  if (blob === null) return null;
  try {
    return await cipher.decrypt(organizationId, "bereaved_contact.mailing_address", blob);
  } catch (error) {
    // A blob that cannot be opened reads as an ABSENT address, never a guessed one. A key-provider failure is NOT that: it propagates so
    // BullMQ retries the job instead of silently dropping a family from the mailing for good.
    if (error instanceof BereavementCipherBlobError) return null;
    throw error;
  }
}

// ── BullMQ construction ─────────────────────────────────────────────────────────────────────────────

/** The `m16-mailing-generate` Worker: one job per claimed run. */
export function registerM16MailingGenerateWorker(deps: MailingWorkerDeps): Worker {
  const params = M16_QUEUE_PARAMS.mailingGenerate;
  return new Worker(
    M16_QUEUES.mailingGenerate,
    async (job) => {
      const data = job.data as Partial<MailingGenerateJob>;
      if (
        typeof data.organizationId !== "string" ||
        typeof data.runId !== "string" ||
        typeof data.version !== "number"
      ) {
        throw new Error(
          "m16-mailing-generate: malformed job (ids only: organizationId, runId, version)",
        );
      }
      await runMailingGenerateJob(deps, data as MailingGenerateJob, {
        finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? params.attempts),
      });
    },
    { connection: deps.connection, concurrency: params.concurrency },
  );
}

/** The enqueue side the route service uses (a Queue on the same name); fails closed per call when no connection is configured. */
export function buildM16MailingEnqueuePort(connection: ConnectionOptions | undefined): {
  readonly port: MailingGenerateEnqueuePort;
  readonly queues: readonly Queue[];
} {
  if (!connection) {
    return {
      port: {
        async enqueue() {
          throw new Error(
            "M16_WORKER_PORT_UNBOUND: no Valkey connection configured — cannot enqueue 'm16-mailing-generate'",
          );
        },
      },
      queues: [],
    };
  }
  const queue = new Queue(M16_QUEUES.mailingGenerate, { connection });
  const params = M16_QUEUE_PARAMS.mailingGenerate;
  return {
    port: {
      async enqueue(job) {
        await queue.add(M16_QUEUES.mailingGenerate, job, {
          jobId: mailingGenerateJobId(job),
          priority: params.priority,
          attempts: params.attempts,
          backoff: { type: params.backoff.type, delay: params.backoff.delay },
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        });
      },
    },
    queues: [queue],
  };
}

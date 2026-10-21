// apps/backend/src/modules/36-messaging/jobs/body-backfill.ts — WP 2.13 / ADR-0058 P1: re-seal one tenant's legacy
// message bodies (HKDF key from MESSAGING_ENCRYPTION_KEY) under the M34 ring DEK.
//
// This is NOT a request and NOT a scheduled job: an operator runs it per tenant (scripts/m36-body-backfill.ts) after the
// escrow restore drill has passed. It is org-explicit (a worker is not a request), runs each batch in its own
// `withOrgContext` system transaction, and is built to be interrupted:
//   * RESUMABLE and IDEMPOTENT: the work list is "rows whose envelope is still legacy" (partial index, migration 1089), so a
//     killed run is resumed by running it again, and a finished row is never seen twice.
//   * SAFE UNDER CONCURRENT WRITES: each row is replaced with a compare-and-swap on the exact ciphertext that was read. An
//     edit that lands in between changes that ciphertext, the swap matches nothing, and the row is counted `skippedConcurrent`
//     (the next run sees its new state). Nothing is lost and nothing is sealed twice.
//   * PLAINTEXT-HASH CHECKED BOTH SIDES: the stored `body_sha256` must match the decrypted legacy plaintext BEFORE (a
//     mismatch is evidence of tampering: the row is left alone and reported, never "fixed" by re-sealing) and the freshly
//     sealed ring envelope must open back to the same plaintext AFTER, before it is written. `body_sha256` itself is never
//     touched, so hash_verify passes across the migration.
//   * RATE LIMITED: `batchSize` rows per transaction, `pauseMs` between batches, `maxRows` / `deadlineMs` per run.
//   * AUDITED: one `m36.body_backfill.batch` row per batch inside that batch's own transaction (so an interruption leaves an
//     exact trail) and one `m36.body_backfill.run` row at the end; the table audit triggers add one row per re-sealed row
//     (the cipher is scrubbed from those). Ids and counts only.
// Message heads are updated directly (the app role may UPDATE `message`); revisions are append-only for the app role and go
// through the ONE audited definer function `m36_reseal_message_revision` (migration 1089).
import { randomUUID } from "node:crypto";
import { type AuditExecutor, audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { messageBodySha256 } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { isLegalHoldViolation } from "../governance/under-hold";
import type { MessageBodyCipher } from "../messaging-write-core";

const MSG = schema.messages;
const REV = schema.messageRevisions;
const OPT = schema.messagePollOptions;

/** The operator-set flag that records "the escrow restore drill passed" (ADR-0058 P1: no backfill without it). */
export const BODY_BACKFILL_ESCROW_DRILL_ENV = "M36_BODY_BACKFILL_ESCROW_DRILL_CONFIRMED";
export const BODY_BACKFILL_DEFAULT_BATCH_SIZE = 100;
export const BODY_BACKFILL_DEFAULT_PAUSE_MS = 250;
export const BODY_BACKFILL_DEFAULT_MAX_ROWS = 5_000;
const LEGACY_ENVELOPE = 1;

// `message_poll_option` (migration 1094) holds a label sealed like a body; it has no plaintext digest, so its pre-seal check
// is GCM authenticity (the legacy open must succeed) and its post-seal check is plaintext equality.
export type BackfillTable = "message" | "message_revision" | "message_poll_option";
const TABLES: readonly BackfillTable[] = ["message", "message_revision", "message_poll_option"];

export class BodyBackfillRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyBackfillRefusedError";
  }
}

/** Production-shaped = `NODE_ENV=production`. A dry run never writes, so it is allowed without the flag. */
export function assertBodyBackfillAllowed(env: NodeJS.ProcessEnv, dryRun: boolean): void {
  if (dryRun || env.NODE_ENV !== "production") return;
  if (env[BODY_BACKFILL_ESCROW_DRILL_ENV]?.trim().toLowerCase() !== "true") {
    throw new BodyBackfillRefusedError(
      `refusing to re-seal message bodies in a production environment: ${BODY_BACKFILL_ESCROW_DRILL_ENV} is not 'true'. Set it only after the MESSAGING_ENCRYPTION_KEY / M34_TENANT_KEK escrow restore drill has passed and is on record (ADR-0058 P1, docs/runbooks/m36-body-key-ring.md).`,
    );
  }
}

export interface BodyBackfillOptions {
  readonly dryRun?: boolean;
  /** Environment the escrow gate reads (default `process.env`); tests inject. */
  readonly env?: NodeJS.ProcessEnv;
  readonly batchSize?: number;
  readonly pauseMs?: number;
  /** Stop after this many rows have been examined in this run (the next run resumes). */
  readonly maxRows?: number;
  /** Stop starting new batches after this many ms. */
  readonly deadlineMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newRunId?: () => string;
  readonly onBatch?: (progress: BodyBackfillBatchProgress) => void;
  /** Tests only: runs between reading a batch and writing it (to land a concurrent edit in the gap). */
  readonly beforeWrite?: (table: BackfillTable) => Promise<void>;
}

export interface BodyBackfillBatchProgress {
  readonly table: BackfillTable;
  readonly scanned: number;
  readonly migrated: number;
}

export interface TableBackfillCounts {
  readonly scanned: number;
  readonly migrated: number;
  readonly wouldMigrate: number;
  readonly skippedConcurrent: number;
  /** Held by an active legal hold (migration 1138 guard): left on the legacy envelope, so `complete` stays false until the hold is released. */
  readonly skippedLegalHold: number;
  readonly hashMismatch: number;
  readonly failed: number;
}

export interface LegacyBodyCounts {
  readonly message: number;
  readonly message_revision: number;
  readonly message_poll_option: number;
}

export interface BodyBackfillReport {
  readonly runId: string;
  readonly organizationId: string;
  readonly dryRun: boolean;
  readonly tables: Readonly<Record<BackfillTable, TableBackfillCounts>>;
  /** Rows still on the legacy envelope after this run (the completion count). */
  readonly remainingLegacy: LegacyBodyCounts;
  /** True only for a real run that ended with zero legacy rows. */
  readonly complete: boolean;
  readonly stoppedBy: "exhausted" | "max_rows" | "deadline";
}

const zeroCounts = (): TableBackfillCounts => ({
  scanned: 0,
  migrated: 0,
  wouldMigrate: 0,
  skippedConcurrent: 0,
  skippedLegalHold: 0,
  hashMismatch: 0,
  failed: 0,
});

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** Legacy-envelope row counts for one tenant, inside the caller's tenant transaction (partial indexes, migration 1089). */
export async function countLegacyBodiesInTx(
  tx: Pick<Tx, "select">,
  organizationId: string,
): Promise<LegacyBodyCounts> {
  const count = async (table: typeof MSG | typeof REV) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(
        and(
          eq(table.organizationId, organizationId),
          eq(table.bodyEnvelopeVersion, LEGACY_ENVELOPE),
        ),
      );
    return Number(row?.n ?? 0);
  };
  const [options] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(OPT)
    .where(
      and(eq(OPT.organizationId, organizationId), eq(OPT.labelEnvelopeVersion, LEGACY_ENVELOPE)),
    );
  return {
    message: await count(MSG),
    message_revision: await count(REV),
    message_poll_option: Number(options?.n ?? 0),
  };
}

/** Legacy-envelope row counts for one tenant (its own system transaction). */
export async function countLegacyBodiesForOrg(
  db: DbClient,
  organizationId: string,
): Promise<LegacyBodyCounts> {
  return withOrgContext(db, systemOrgContext(organizationId), (tx) =>
    countLegacyBodiesInTx(tx, organizationId),
  );
}

interface Candidate {
  readonly id: string;
  readonly bodyCipher: Buffer;
  /** Null for a poll option label (no stored digest). */
  readonly bodySha256: string | null;
}

async function nextBatch(
  db: DbClient,
  organizationId: string,
  table: BackfillTable,
  after: string | null,
  limit: number,
): Promise<readonly Candidate[]> {
  return withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
    if (table === "message_poll_option") {
      const rows = await tx
        .select({ id: OPT.id, bodyCipher: OPT.labelCipher })
        .from(OPT)
        .where(
          and(
            eq(OPT.organizationId, organizationId),
            eq(OPT.labelEnvelopeVersion, LEGACY_ENVELOPE),
            after ? gt(OPT.id, after) : undefined,
          ),
        )
        .orderBy(asc(OPT.id))
        .limit(limit);
      return rows.map((r) => ({ ...r, bodySha256: null }));
    }
    const t = table === "message" ? MSG : REV;
    return (await tx
      .select({ id: t.id, bodyCipher: t.bodyCipher, bodySha256: t.bodySha256 })
      .from(t)
      .where(
        and(
          eq(t.organizationId, organizationId),
          eq(t.bodyEnvelopeVersion, LEGACY_ENVELOPE),
          after ? gt(t.id, after) : undefined,
        ),
      )
      .orderBy(asc(t.id))
      .limit(limit)) as Candidate[];
  });
}

type Outcome =
  | "migrated"
  | "wouldMigrate"
  | "skippedConcurrent"
  | "skippedLegalHold"
  | "hashMismatch"
  | "failed";

async function resealRow(
  tx: Tx,
  cipher: MessageBodyCipher,
  organizationId: string,
  table: BackfillTable,
  row: Candidate,
  dryRun: boolean,
  resealDb: DbClient | undefined,
): Promise<Outcome> {
  let plaintext: string;
  try {
    plaintext = await cipher.open(organizationId, row.bodyCipher);
  } catch {
    return "failed"; // undecryptable under the legacy key: hash_verify's territory, never re-sealed
  }
  if (row.bodySha256 !== null && messageBodySha256(plaintext) !== row.bodySha256)
    return "hashMismatch";
  let sealed: Buffer;
  try {
    sealed = (await cipher.sealRing(organizationId, plaintext)).cipher;
    // The ring envelope must read back to the SAME plaintext before it is allowed to replace the legacy one.
    const reopened = await cipher.open(organizationId, sealed);
    const readsBack =
      row.bodySha256 === null
        ? reopened === plaintext
        : messageBodySha256(reopened) === row.bodySha256;
    if (!readsBack) return "failed";
  } catch {
    return "failed";
  }
  if (dryRun) return "wouldMigrate";
  if (table === "message") {
    try {
      // A savepoint per row: migration 1138's guard raises 23001 for a message under an active legal hold, and an unguarded
      // error would abort the whole batch transaction (and, being legacy forever, every later run).
      const swapped = await tx.transaction((sp) =>
        sp
          .update(MSG)
          .set({ bodyCipher: sealed })
          .where(
            and(
              eq(MSG.organizationId, organizationId),
              eq(MSG.id, row.id),
              sql`${MSG.bodyCipher} = ${row.bodyCipher}`,
            ),
          )
          .returning({ id: MSG.id }),
      );
      return swapped.length === 1 ? "migrated" : "skippedConcurrent";
    } catch (err) {
      if (isLegalHoldViolation(err)) return "skippedLegalHold";
      throw err;
    }
  }
  // Revisions and poll options are append-only for the app role: the re-seal runs on the dedicated backfill credential
  // (migrations 1090 / 1094), through one audited SECURITY DEFINER function per table.
  if (!resealDb)
    throw new BodyBackfillRefusedError(
      "a real run needs the revision re-seal credential (resealDb)",
    );
  const res = await withOrgContext(resealDb, systemOrgContext(organizationId), (rtx) =>
    rtx.execute(
      table === "message_poll_option"
        ? sql`SELECT m36_reseal_poll_option(${organizationId}::uuid, ${row.id}::uuid, ${row.bodyCipher}::bytea, ${sealed}::bytea) AS ok`
        : sql`SELECT m36_reseal_message_revision(${organizationId}::uuid, ${row.id}::uuid, ${row.bodyCipher}::bytea, ${sealed}::bytea) AS ok`,
    ),
  );
  const ok = (res as unknown as { rows?: Array<{ ok: boolean }> }).rows?.[0]?.ok;
  return ok ? "migrated" : "skippedConcurrent";
}

/** Re-seal one tenant's legacy message heads and revisions under the ring. See the file header for the guarantees. */
export async function backfillBodiesForOrg(
  deps: {
    readonly db: DbClient;
    readonly cipher: MessageBodyCipher;
    /** Connection as a member of `wardenx_m36_reseal` (the only role that may re-seal a revision). Required for a real run. */
    readonly resealDb?: DbClient;
  },
  organizationId: string,
  opts: BodyBackfillOptions = {},
): Promise<BodyBackfillReport> {
  const dryRun = opts.dryRun ?? false;
  // The gate lives in the library, not only the CLI: every real run in a production environment needs the recorded drill.
  assertBodyBackfillAllowed(opts.env ?? process.env, dryRun);
  if (!dryRun && !deps.resealDb) {
    throw new BodyBackfillRefusedError(
      "a real run needs deps.resealDb (the wardenx_m36_reseal credential)",
    );
  }
  const batchSize = Math.max(1, opts.batchSize ?? BODY_BACKFILL_DEFAULT_BATCH_SIZE);
  const maxRows = opts.maxRows ?? BODY_BACKFILL_DEFAULT_MAX_ROWS;
  const pauseMs = opts.pauseMs ?? BODY_BACKFILL_DEFAULT_PAUSE_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runId = (opts.newRunId ?? randomUUID)();
  const startedAt = now();
  const counts: Record<BackfillTable, TableBackfillCounts> = {
    message: zeroCounts(),
    message_revision: zeroCounts(),
    message_poll_option: zeroCounts(),
  };
  let examined = 0;
  let stopReason: BodyBackfillReport["stoppedBy"] = "exhausted";

  // Fail before touching a row if this tenant has no usable ring (absent / destroyed / KEK unbound).
  await deps.cipher.sealRing(organizationId, "");

  tables: for (const table of TABLES) {
    let cursor: string | null = null;
    for (;;) {
      if (examined >= maxRows) {
        stopReason = "max_rows";
        break tables;
      }
      if (opts.deadlineMs !== undefined && now() - startedAt >= opts.deadlineMs) {
        stopReason = "deadline";
        break tables;
      }
      const batch = await nextBatch(
        deps.db,
        organizationId,
        table,
        cursor,
        Math.min(batchSize, maxRows - examined),
      );
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]?.id ?? cursor;
      await opts.beforeWrite?.(table);
      const outcomes = await withOrgContext(
        deps.db,
        systemOrgContext(organizationId),
        async (tx) => {
          const results: Outcome[] = [];
          for (const row of batch) {
            const outcome = await resealRow(
              tx,
              deps.cipher,
              organizationId,
              table,
              row,
              dryRun,
              deps.resealDb,
            );
            results.push(outcome);
            if (outcome === "hashMismatch" && !dryRun) {
              await audit(tx as unknown as AuditExecutor, systemContext(organizationId, runId), {
                eventType: "m36.integrity.hash_mismatch",
                resourceKind: table,
                resourceId: row.id,
                outcome: "failure",
                severity: "critical",
                context: { runId, phase: "body_backfill_pre_seal", storedHash: row.bodySha256 },
              });
            }
          }
          if (!dryRun) {
            await audit(tx as unknown as AuditExecutor, systemContext(organizationId, runId), {
              eventType: "m36.body_backfill.batch",
              resourceKind: "message_body_backfill_run",
              resourceId: runId,
              outcome: "success",
              context: { runId, table, ...tally(results) },
            });
          }
          return results;
        },
      );
      const t = tally(outcomes);
      counts[table] = addCounts(counts[table], batch.length, t);
      examined += batch.length;
      opts.onBatch?.({ table, scanned: batch.length, migrated: t.migrated });
      if (pauseMs > 0) await sleep(pauseMs);
    }
  }

  const remainingLegacy = await countLegacyBodiesForOrg(deps.db, organizationId);
  const drained =
    remainingLegacy.message === 0 &&
    remainingLegacy.message_revision === 0 &&
    remainingLegacy.message_poll_option === 0;
  const complete = !dryRun && drained;
  const stoppedBy = complete ? "exhausted" : stopReason;
  const report: BodyBackfillReport = {
    runId,
    organizationId,
    dryRun,
    tables: counts,
    remainingLegacy,
    complete,
    stoppedBy,
  };
  if (!dryRun) {
    await withOrgContext(deps.db, systemOrgContext(organizationId), (tx) =>
      audit(tx as unknown as AuditExecutor, systemContext(organizationId, runId), {
        eventType: "m36.body_backfill.run",
        resourceKind: "message_body_backfill_run",
        resourceId: runId,
        outcome: "success",
        context: { runId, stoppedBy, complete, tables: counts, remainingLegacy },
      }),
    );
  }
  return report;
}

function systemContext(organizationId: string, runId: string) {
  return {
    organizationId,
    userId: null,
    actorKind: "system" as const,
    correlationId: runId,
  };
}

function tally(outcomes: readonly Outcome[]): Omit<TableBackfillCounts, "scanned"> {
  const n = (o: Outcome) => outcomes.filter((x) => x === o).length;
  return {
    migrated: n("migrated"),
    wouldMigrate: n("wouldMigrate"),
    skippedConcurrent: n("skippedConcurrent"),
    skippedLegalHold: n("skippedLegalHold"),
    hashMismatch: n("hashMismatch"),
    failed: n("failed"),
  };
}

function addCounts(
  prev: TableBackfillCounts,
  scanned: number,
  t: Omit<TableBackfillCounts, "scanned">,
): TableBackfillCounts {
  return {
    scanned: prev.scanned + scanned,
    migrated: prev.migrated + t.migrated,
    wouldMigrate: prev.wouldMigrate + t.wouldMigrate,
    skippedConcurrent: prev.skippedConcurrent + t.skippedConcurrent,
    skippedLegalHold: prev.skippedLegalHold + t.skippedLegalHold,
    hashMismatch: prev.hashMismatch + t.hashMismatch,
    failed: prev.failed + t.failed,
  };
}

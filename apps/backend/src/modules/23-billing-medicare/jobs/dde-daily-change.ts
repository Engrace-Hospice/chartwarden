// apps/backend/src/modules/23-billing-medicare/jobs/dde-daily-change.ts — #793 (ADR-0103): the DDE provider's
// cursor-paged daily change report feeding the DDE work queue. For every operator who has a provider-submitted item
// still awaiting its answer, it resumes from the persisted cursor (`dde_change_cursor`, migration 1273), pages the
// provider's `fetchOutcomes`, and applies each outcome through `DdeQueueService.applyProviderChange` — the SAME code as
// the by-item sync route (source `dde_provider`, same state edges), as the system actor.
//
// Failure posture (the M25 835 pull and M23 ack pull patterns; no silent loss, no silent restart):
//   - the cursor moves only after every event of a page was handled, as a compare-and-set on `version`, so two
//     overlapping ticks can neither double-advance nor regress it;
//   - a cursor the provider refuses (INVALID_REQUEST) is reported and left AS IS, never reset: a null cursor re-reads the
//     whole chain;
//   - a chain that comes back to a position this tick already read (A, B, A) is a cycle, not progress: the entity fails;
//   - an event for an item we do not know is IGNORED with a bounded, deduped trace (one `dde_change_exception` row per
//     event id, logged once, at most MAX_NEW_UNMATCHED_TRACES_PER_TICK new rows per tick); it never stalls the stream;
//   - an event whose answer is unusable (DDE_PROVIDER_ANSWER_INVALID) stops the chain at that page and is retried; after
//     MAX_REFUSALS_PER_CHANGE refusals it is quarantined, skipped, and the cursor moves on;
//   - any other failure (vendor outage, a concurrent edit) is transient: the cursor stays and the next tick retries;
//   - an item already finalised is never moved backwards (`already`), so replaying a page is idempotent.
// Nothing here receives, stores or logs an MBI: outcomes carry ids and codes (ADR-0103 D6), logs carry ids and codes.
import { randomUUID } from "node:crypto";
import { ChartWardenError } from "@chartwarden/types";
import { DDE, type DdeAccessProvider, type DdeOutcome } from "@chartwarden/x12-837-client";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { PROVIDER_REFERENCE_PATTERN } from "../services/dde-provider-ops";

/** The cron queue. Module-prefixed: arch:queue-names keeps every queue name owned by exactly one module. */
export const DDE_DAILY_CHANGE_QUEUE = "m23.dde-daily-change";
/** Every 30 minutes: cheap when idle (no awaiting provider item => no vendor call). */
export const DDE_DAILY_CHANGE_SCHEDULE = "*/30 * * * *";
/** Most pages one operator's chain may read in one tick; the persisted cursor resumes the rest next tick. */
export const MAX_CHANGE_PAGES_PER_TICK = 20;
/** Refusals of one event (answer unusable) before it is quarantined and the cursor moves past it. */
export const MAX_REFUSALS_PER_CHANGE = 5;
/** New `unmatched` trace rows one tick may write; further unknown events are counted, not stored. */
export const MAX_NEW_UNMATCHED_TRACES_PER_TICK = 100;
/** Operators read per org per tick. */
export const MAX_OPERATORS_PER_TICK = 200;

/** An unknown reference is ignored (and the page released) once it has been seen this many times. */
export const UNMATCHED_SIGHTINGS_BEFORE_IGNORE = 2;
/** Bound on one change-report read; the signal is handed to the port (no DB transaction is open during it). */
export const DDE_CHANGE_CALL_TIMEOUT_MS = 30_000;
const MAX_CURSOR_LENGTH = 512;
const EVENT_ID_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/;
const DISPOSITIONS: ReadonlySet<string> = new Set(["accepted", "returned", "rejected"]);
/** The code `ddeProviderAnswerRejected` throws; the unit test pins the two together. */
export const ANSWER_INVALID_CODE = "DDE_PROVIDER_ANSWER_INVALID";
const UNKNOWN_ITEM = "DDE_ITEM_UNKNOWN";
export const CHANGE_QUARANTINED = "DDE_CHANGE_QUARANTINED";

export interface DdeChangeCursorKey {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly vendor: string;
  readonly usage: "test" | "production";
  readonly operatorMembershipId: string;
}

export interface DdeChangeCursorState {
  readonly cursor: string | null;
  readonly version: number;
}

/** Durable state of the ingest. Every call opens its own org context: a cron tick is not a request. */
export interface DdeChangeStore {
  readCursor(key: DdeChangeCursorKey): Promise<DdeChangeCursorState>;
  /** Compare-and-set on `version`; false when another tick moved the position first. */
  advanceCursor(key: DdeChangeCursorKey, expectedVersion: number, next: string): Promise<boolean>;
  isQuarantined(key: DdeChangeCursorKey, eventId: string): Promise<boolean>;
  /** Count one more refusal of this event (durable); `quarantined` once `count >= cap`. Code only: no vendor text. */
  recordRefusal(
    key: DdeChangeCursorKey,
    eventId: string,
    reasonCode: string,
    cap: number,
  ): Promise<{ readonly count: number; readonly quarantined: boolean }>;
  /** The event applied after earlier refusals: zero its not-yet-quarantined count (the cap means CONSECUTIVE). */
  clearRefusals(key: DdeChangeCursorKey, eventId: string): Promise<void>;
  /** Trace an event for an unknown item (deduped on the event id); `firstSeen` is true once per event. */
  traceUnmatched(
    key: DdeChangeCursorKey,
    eventId: string,
  ): Promise<{ readonly firstSeen: boolean; readonly seenCount: number }>;
  /** Operators with a provider-submitted item awaiting an answer, per provider entity (empty when idle). */
  awaitingOperators(
    organizationId: string,
    limit: number,
  ): Promise<readonly { providerEntityId: string; operatorMembershipId: string }[]>;
}

export interface DdeChangeApplier {
  applyProviderChange(
    organizationId: string,
    providerEntityId: string,
    outcome: DdeOutcome,
    operatorMembershipId: string,
  ): Promise<"applied" | "already" | "unmatched">;
}

export interface DdeChangeLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface DdeChangeIngestDeps {
  readonly provider: DdeAccessProvider;
  readonly usage: "test" | "production";
  readonly store: DdeChangeStore;
  readonly applier: DdeChangeApplier;
  readonly logger?: DdeChangeLogger;
}

/** PHI-free: counts, event ids and codes only. */
export interface DdeChangeIngestResult {
  readonly applied: number;
  readonly already: number;
  readonly unmatched: number;
  /** Events skipped because they were malformed (unusable ids or disposition); counted, never stored. */
  readonly malformed: number;
  /** `<label>: change <eventId> DDE_CHANGE_QUARANTINED`, new and still-quarantined. */
  readonly quarantined: readonly string[];
  /** Operators that stopped at MAX_CHANGE_PAGES_PER_TICK with more to read. */
  readonly backlog: readonly string[];
  readonly failures: readonly string[];
}

interface Tally {
  applied: number;
  already: number;
  unmatched: number;
  malformed: number;
  newTraces: number;
  readonly quarantined: string[];
}

function isUsableOutcome(value: unknown): value is DdeOutcome {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.eventId === "string" &&
    EVENT_ID_PATTERN.test(o.eventId) &&
    typeof o.providerReference === "string" &&
    PROVIDER_REFERENCE_PATTERN.test(o.providerReference) &&
    typeof o.controlNumber === "string" &&
    o.controlNumber.length > 0 &&
    typeof o.disposition === "string" &&
    DISPOSITIONS.has(o.disposition) &&
    typeof o.occurredAt === "string" &&
    Array.isArray(o.reasonCodes)
  );
}

/** An error whose message is composed here from ids and fixed text only: the only kind that may reach a job record. */
class SafeIngestError extends Error {}
const failure = (label: string, what: string, code: string): Error =>
  new SafeIngestError(`${label}: ${what} (${code})`);
const UNKNOWN_FAILURE_CODE = "DDE_INGEST_ERROR";
const CODE_SHAPE = /^[A-Z0-9_]{1,64}$/;
/** A fixed code for any error: our own safe text passes through; anything else is reduced to its code, never its message. */
function safeFailure(label: string, err: unknown): string {
  if (err instanceof SafeIngestError) return err.message;
  const code =
    err instanceof ChartWardenError && CODE_SHAPE.test(err.code) ? err.code : UNKNOWN_FAILURE_CODE;
  return `${label}: failed (${code})`;
}

/** Read and apply every pending change for one org. A failing operator does not stop the others. */
export async function ingestDdeChanges(
  deps: DdeChangeIngestDeps,
  organizationId: string,
): Promise<DdeChangeIngestResult> {
  const tally: Tally = {
    applied: 0,
    already: 0,
    unmatched: 0,
    malformed: 0,
    newTraces: 0,
    quarantined: [],
  };
  const failures: string[] = [];
  const backlog: string[] = [];
  const vendor = deps.provider.vendor;
  if (vendor === "not_wired") {
    return resultOf(tally, backlog, failures);
  }
  let operators: Awaited<ReturnType<DdeChangeStore["awaitingOperators"]>>;
  try {
    operators = await deps.store.awaitingOperators(organizationId, MAX_OPERATORS_PER_TICK);
  } catch {
    failures.push(`org ${organizationId}: awaiting operators could not be listed`);
    return resultOf(tally, backlog, failures);
  }
  for (const { providerEntityId, operatorMembershipId } of operators) {
    const key: DdeChangeCursorKey = {
      organizationId,
      providerEntityId,
      vendor,
      usage: deps.usage,
      operatorMembershipId,
    };
    const label = `org ${organizationId} provider ${providerEntityId} operator ${operatorMembershipId}`;
    try {
      if ((await pullOperator(deps, key, label, tally)) === "backlog") backlog.push(label);
    } catch (err) {
      failures.push(safeFailure(label, err));
    }
  }
  return resultOf(tally, backlog, failures);
}

function resultOf(
  tally: Tally,
  backlog: readonly string[],
  failures: readonly string[],
): DdeChangeIngestResult {
  return {
    applied: tally.applied,
    already: tally.already,
    unmatched: tally.unmatched,
    malformed: tally.malformed,
    quarantined: tally.quarantined,
    backlog,
    failures,
  };
}

async function pullOperator(
  deps: DdeChangeIngestDeps,
  key: DdeChangeCursorKey,
  label: string,
  tally: Tally,
): Promise<"done" | "backlog"> {
  const { store, provider } = deps;
  let state = await store.readCursor(key);
  // Every position this tick has read from: a chain that comes back to one (A, B, A) is a cycle, not progress.
  const seen = new Set<string | null>([state.cursor]);
  for (let pages = 0; pages < MAX_CHANGE_PAGES_PER_TICK; ) {
    const result = await provider.fetchOutcomes(
      {
        organizationId: key.organizationId,
        providerEntityId: key.providerEntityId,
        operatorMembershipId: key.operatorMembershipId,
        correlationId: randomUUID(),
        usage: key.usage,
        signal: AbortSignal.timeout(DDE_CHANGE_CALL_TIMEOUT_MS),
      },
      state.cursor,
    );
    if (!result.ok) {
      // Code only: the provider's reason text is not provably PHI-free and this string reaches job data and logs.
      const refused = result.degraded.code === DDE.INVALID_REQUEST;
      throw failure(
        label,
        refused ? "change report request refused (cursor not reset)" : "change report pull",
        result.degraded.code,
      );
    }
    pages += 1;
    const page = result.data;
    if (
      !Array.isArray(page.items) ||
      typeof page.hasMore !== "boolean" ||
      typeof page.nextCursor !== "string" ||
      page.nextCursor.length < 1 ||
      page.nextCursor.length > MAX_CURSOR_LENGTH
    ) {
      throw failure(label, "the provider's page is unusable", DDE.INVALID_REQUEST);
    }
    if (page.hasMore && seen.has(page.nextCursor)) {
      throw failure(
        label,
        "the provider cursor did not advance (repeated position)",
        DDE.INVALID_REQUEST,
      );
    }
    let held = false;
    for (const item of page.items) {
      if ((await handleEvent(deps, key, label, item, tally)) === "held") held = true;
    }
    // An event for a reference we do not know yet may be an answer that beat its own submit's commit (the vendor is
    // called before the item records its reference). The page is held until the event has been seen twice; then it is
    // ignored. The delay is one tick, and replays of the held page are idempotent.
    if (held) return "done";
    if (page.nextCursor !== state.cursor) {
      // Lost the race: another tick owns this stream now and its position stands.
      if (!(await store.advanceCursor(key, state.version, page.nextCursor))) return "done";
      state = { cursor: page.nextCursor, version: state.version + 1 };
    }
    seen.add(page.nextCursor);
    if (!page.hasMore) return "done";
  }
  return "backlog";
}

async function handleEvent(
  deps: DdeChangeIngestDeps,
  key: DdeChangeCursorKey,
  label: string,
  item: unknown,
  tally: Tally,
): Promise<"held" | "ok"> {
  if (!isUsableOutcome(item)) {
    tally.malformed += 1;
    return "ok";
  }
  const { store, applier } = deps;
  if (await store.isQuarantined(key, item.eventId)) {
    tally.quarantined.push(`${label}: change ${item.eventId} ${CHANGE_QUARANTINED}`);
    return "ok";
  }
  let outcome: "applied" | "already" | "unmatched";
  try {
    outcome = await applier.applyProviderChange(
      key.organizationId,
      key.providerEntityId,
      item,
      key.operatorMembershipId,
    );
  } catch (err) {
    // An answer we will not act on, or a deterministic 4xx (a missing notice, a conflicting date), counts toward
    // quarantine so one bad event cannot stall the chain forever. An outage, a 5xx or a concurrent edit (412) stays
    // transient and is retried without counting.
    if (!isRefusal(err)) throw err;
    const refusalCode = CODE_SHAPE.test(err.code) ? err.code : ANSWER_INVALID_CODE;
    const refusal = await store.recordRefusal(
      key,
      item.eventId,
      refusalCode,
      MAX_REFUSALS_PER_CHANGE,
    );
    if (!refusal.quarantined) {
      throw failure(
        label,
        `change ${item.eventId} refused (${refusal.count}/${MAX_REFUSALS_PER_CHANGE})`,
        refusalCode,
      );
    }
    tally.quarantined.push(`${label}: change ${item.eventId} ${CHANGE_QUARANTINED}`);
    return "ok";
  }
  if (outcome === "unmatched") {
    tally.unmatched += 1;
    if (tally.newTraces < MAX_NEW_UNMATCHED_TRACES_PER_TICK) {
      const trace = await store.traceUnmatched(key, item.eventId);
      const hold = trace.seenCount < UNMATCHED_SIGHTINGS_BEFORE_IGNORE;
      if (trace.firstSeen) {
        tally.newTraces += 1;
        deps.logger?.warn(
          {
            organizationId: key.organizationId,
            providerEntityId: key.providerEntityId,
            eventId: item.eventId,
            code: UNKNOWN_ITEM,
          },
          "DDE change report event for an unknown queue item seen",
        );
      }
      return hold ? "held" : "ok";
    }
    return "ok";
  }
  if (outcome === "applied") tally.applied += 1;
  else tally.already += 1;
  await store.clearRefusals(key, item.eventId);
  return "ok";
}

/** The only transient concurrency error the apply step raises (a stale item version): retried, never counted. */
const TRANSIENT_CONFLICT_CODE = "VERSION_CONFLICT";

/**
 * True for an error that is the EVENT's fault and will recur: our answer-invalid code, or any 4xx other than the
 * transient stale-version conflict. Keyed on `code`, not status: a deterministic ConflictError (an invalid state
 * transition, a notice that cannot be accepted) is also a 409 and must reach the bounded refusal cap.
 */
function isRefusal(err: unknown): err is ChartWardenError {
  if (!(err instanceof ChartWardenError)) return false;
  if (err.code === TRANSIENT_CONFLICT_CODE) return false;
  if (err.code === ANSWER_INVALID_CODE) return true;
  return err.statusCode >= 400 && err.statusCode < 500;
}

// ── the cron ────────────────────────────────────────────────────────────────────────────────────────────

export interface DdeDailyChangeWorkerDeps extends DdeChangeIngestDeps {
  readonly connection: ConnectionOptions;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
}

/** One tick: every active org, a failing org does not stop the others; throws after all ran so BullMQ retries. */
export async function runDdeDailyChangeCron(
  deps: DdeDailyChangeWorkerDeps,
): Promise<DdeChangeIngestResult> {
  const total = { applied: 0, already: 0, unmatched: 0, malformed: 0 };
  const quarantined: string[] = [];
  const backlog: string[] = [];
  const failures: string[] = [];
  let orgs: Awaited<ReturnType<DdeDailyChangeWorkerDeps["activeOrgs"]["listActiveOrgs"]>>;
  try {
    orgs = await deps.activeOrgs.listActiveOrgs();
  } catch {
    throw new SafeIngestError("DDE daily change ingest failed: active orgs could not be listed");
  }
  for (const { organizationId } of orgs) {
    const r = await ingestDdeChanges(deps, organizationId);
    total.applied += r.applied;
    total.already += r.already;
    total.unmatched += r.unmatched;
    total.malformed += r.malformed;
    quarantined.push(...r.quarantined);
    backlog.push(...r.backlog);
    failures.push(...r.failures);
  }
  for (const q of quarantined)
    deps.logger?.warn({ quarantined: q }, "DDE change report event quarantined");
  if (backlog.length > 0)
    deps.logger?.warn({ backlog }, "DDE change report backlog carried to the next tick");
  if (failures.length > 0)
    throw new Error(`DDE daily change ingest failed: ${failures.join("; ")}`);
  return { ...total, quarantined, backlog, failures };
}

/** The lock outlives one worst-case tick (every org, every operator, the page cap) so a slow vendor is not a stall. */
const LOCK_DURATION_MS = 5 * 60_000;
// One attempt: a BullMQ retry seconds later would be a second sighting of a held page and defeat the hold; the next tick is 30 minutes away.
const SCHEDULE_ATTEMPTS = 1;
const RETRY_BACKOFF_MS = 5000;

export function registerDdeDailyChangeWorker(deps: DdeDailyChangeWorkerDeps): Worker {
  return new Worker(DDE_DAILY_CHANGE_QUEUE, async () => void (await runDdeDailyChangeCron(deps)), {
    connection: deps.connection,
    concurrency: 1,
    lockDuration: LOCK_DURATION_MS,
  });
}

/** Register the repeatable schedule; the caller owns `close()`. BullMQ dedupes an identical repeat pattern. */
export async function scheduleDdeDailyChange(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(DDE_DAILY_CHANGE_QUEUE, { connection });
  await queue.add(
    "scheduled",
    {},
    {
      repeat: { pattern: DDE_DAILY_CHANGE_SCHEDULE },
      attempts: SCHEDULE_ATTEMPTS,
      backoff: { type: "exponential", delay: RETRY_BACKOFF_MS },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 500 },
    },
  );
  return queue;
}

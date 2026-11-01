// apps/backend/src/bootstrap/rust-bridge/parity-sweep.ts — CW-RUST-M02 P1: the daily parity sweep (spec v0.3).
//
// Organic traffic on GET /api/v1/me/permissions is thin, so P2 is judged by comparing Bun and Rust for EVERY active
// membership once a day. The sweep runs in the `api` process: the only holder of the signing key and the socket.
//
//   1. List active orgs through the existing audited platform enumerator (`buildActiveOrgEnumerator`, a registered
//      job id). That is the ONLY cross-tenant read.
//   2. For each org, list its active members under that org's own `withOrgContext` (RLS-scoped, app role), and count
//      them independently so the run can prove it compared 100 % of what it listed.
//   3. For each (org, user), at most 2 in flight: Bun resolves with a FRESH, uncached resolver; Rust is called with an
//      assertion of class `parity-sweep` (which Rust accepts on this one read-only route only).
//   4. Compare as sets. On a difference resolve both once more: equal now → `explained:race`, else `unexplained`.
//   5. Log ids and counts only, never a permission key. Stop early once errors exceed 1 % of the planned pairs.
//
// The sweep writes nothing except the platform-context audit event of step 1.
import type { RustClient } from "./client";
import { type BridgeLogger, validPermissionsBody } from "./forwarder";
import { type AssertionSigner, CANONICAL_UUID_RE, SWEEP_CLASS } from "./signer";

/** Registered platform job id for the sweep's audited active-org list (registered only when the sweep is on). */
export const RUST_PARITY_SWEEP_JOB_ID = "m02-rust-parity-sweep";
export const SWEEP_MAX_IN_FLIGHT = 2;
export const SWEEP_ERROR_STOP_RATIO = 0.01;
const PATH = "/api/v1/me/permissions";

export interface ParitySweepDeps {
  readonly listActiveOrgs: () => Promise<readonly { organizationId: string }[]>;
  readonly listActiveMembers: (organizationId: string) => Promise<readonly string[]>;
  readonly countActiveMembers: (organizationId: string) => Promise<number>;
  /** Uncached resolution (store.loadGrants + resolveEffectivePermissions), as the route would compute it now. */
  readonly freshPermissions: (organizationId: string, userId: string) => Promise<readonly string[]>;
  readonly signer: AssertionSigner;
  readonly client: RustClient;
  readonly logger: BridgeLogger;
  readonly runId: string;
  /** Aborted on shutdown or when the run deadline passes; pending operations are abandoned and the run reports incomplete. */
  readonly signal?: AbortSignal;
  /** Per-operation limit (default SWEEP_OP_TIMEOUT_MS). */
  readonly opTimeoutMs?: number;
}

export interface ParitySweepSummary {
  readonly runId: string;
  orgs: number;
  listed: number;
  counted: number;
  compared: number;
  match: number;
  explainedRace: number;
  unexplained: number;
  errors: number;
  skipped: number;
  /** Orgs whose member list or count failed (the run is then incomplete). */
  orgErrors: number;
  /** The active-org list itself failed or timed out (the run is then incomplete). */
  listFailed: boolean;
  aborted: boolean;
  stoppedEarly: boolean;
  durationMs: number;
}

function sameSet(a: readonly string[], b: readonly string[]): { onlyA: number; onlyB: number } {
  const sa = new Set(a);
  const sb = new Set(b);
  let onlyA = 0;
  let onlyB = 0;
  for (const x of sa) if (!sb.has(x)) onlyA++;
  for (const x of sb) if (!sa.has(x)) onlyB++;
  return { onlyA, onlyB };
}

/** Hard per-operation limit for every database or Rust call the sweep makes (review round P1-2). */
export const SWEEP_OP_TIMEOUT_MS = 15_000;

class SweepAbort extends Error {
  override name = "SweepAbort";
}

/**
 * Settles with `p`, or rejects when `ms` passes or `signal` aborts, whichever is first. The underlying operation may
 * stay pending (a hung driver call cannot be cancelled from here), but the sweep moves on and still reports.
 */
export function bounded<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SweepAbort("aborted"));
      return;
    }
    const timer = setTimeout(
      () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
      ms,
    );
    const onAbort = () => reject(new SweepAbort("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

export async function runParitySweep(deps: ParitySweepDeps): Promise<ParitySweepSummary> {
  const started = performance.now();
  const s: ParitySweepSummary = {
    runId: deps.runId,
    orgs: 0,
    listed: 0,
    counted: 0,
    compared: 0,
    match: 0,
    explainedRace: 0,
    unexplained: 0,
    errors: 0,
    skipped: 0,
    orgErrors: 0,
    listFailed: false,
    aborted: false,
    stoppedEarly: false,
    durationMs: 0,
  };
  const op = <T>(p: Promise<T>) => bounded(p, deps.opTimeoutMs ?? SWEEP_OP_TIMEOUT_MS, deps.signal);
  const pairs: { org: string; user: string }[] = [];

  // Enumeration is inside the deadline too: a hung org list or member query ends the run with a summary.
  let orgs: readonly { organizationId: string }[] = [];
  try {
    orgs = await op(deps.listActiveOrgs());
  } catch (e) {
    if (e instanceof SweepAbort) s.aborted = true;
    else s.listFailed = true;
  }
  for (const { organizationId } of orgs) {
    if (deps.signal?.aborted) {
      s.aborted = true;
      break;
    }
    s.orgs++;
    try {
      const members = await op(deps.listActiveMembers(organizationId));
      const counted = await op(deps.countActiveMembers(organizationId));
      s.listed += members.length;
      s.counted += counted;
      for (const user of members) pairs.push({ org: organizationId, user });
    } catch (e) {
      if (e instanceof SweepAbort) {
        s.aborted = true;
        break;
      }
      // One org's failure must not hide every other org's comparison; the run is reported incomplete.
      s.orgErrors++;
      deps.logger.warn(
        {
          run_id: deps.runId,
          org_id: organizationId,
          outcome: "org_error",
          error: (e as Error)?.name ?? "Error",
        },
        "parity sweep could not list an org",
      );
    }
  }

  const rust = async (org: string, user: string): Promise<readonly string[] | null> => {
    const assertion = deps.signer.sign({
      userId: user,
      organizationId: org,
      sessionId: deps.runId,
      sessionClass: SWEEP_CLASS,
      requestId: `${deps.runId}:${user}`,
      method: "GET",
      path: PATH,
    });
    const v = validPermissionsBody(await deps.client.get(PATH, assertion));
    return "body" in v ? v.body.permissions : null;
  };

  const maxErrors = Math.max(1, Math.floor(pairs.length * SWEEP_ERROR_STOP_RATIO));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pairs.length && !s.stoppedEarly && !s.aborted) {
      if (deps.signal?.aborted) {
        s.aborted = true;
        return;
      }
      const { org, user } = pairs[next++] as { org: string; user: string };
      if (!CANONICAL_UUID_RE.test(org) || !CANONICAL_UUID_RE.test(user)) {
        // Not comparable (the signer refuses it). Logged and counted; it makes the run incomplete.
        s.skipped++;
        deps.logger.warn(
          { run_id: deps.runId, org_id: org, outcome: "skipped_non_uuid" },
          "parity sweep skipped a membership",
        );
        continue;
      }
      try {
        const [bun1, rust1] = await Promise.all([
          op(deps.freshPermissions(org, user)),
          op(rust(org, user)),
        ]);
        if (rust1 === null) throw new Error("rust");
        const d1 = sameSet(bun1, rust1);
        if (d1.onlyA === 0 && d1.onlyB === 0) {
          s.compared++;
          s.match++;
          continue;
        }
        const [bun2, rust2] = await Promise.all([
          op(deps.freshPermissions(org, user)),
          op(rust(org, user)),
        ]);
        if (rust2 === null) throw new Error("rust");
        s.compared++;
        const d2 = sameSet(bun2, rust2);
        if (d2.onlyA === 0 && d2.onlyB === 0) {
          s.explainedRace++;
          deps.logger.info(
            { run_id: deps.runId, org_id: org, user_id: user, outcome: "explained:race" },
            "parity sweep",
          );
        } else {
          s.unexplained++;
          deps.logger.warn(
            {
              run_id: deps.runId,
              org_id: org,
              user_id: user,
              outcome: "unexplained",
              only_bun: d2.onlyA,
              only_rust: d2.onlyB,
            },
            "parity sweep UNEXPLAINED difference",
          );
        }
      } catch (e) {
        if (e instanceof SweepAbort) {
          s.aborted = true;
          return;
        }
        s.errors++;
        if (s.errors > maxErrors) s.stoppedEarly = true;
      }
    }
  };
  await Promise.all(Array.from({ length: SWEEP_MAX_IN_FLIGHT }, worker));

  s.durationMs = Math.round(performance.now() - started);
  // Complete means every listed membership was actually compared: nothing skipped, errored, unlisted or cut short.
  const complete =
    !s.aborted &&
    !s.listFailed &&
    s.orgErrors === 0 &&
    !s.stoppedEarly &&
    s.skipped === 0 &&
    s.errors === 0 &&
    s.listed === s.counted &&
    s.compared === s.listed;
  deps.logger[s.unexplained || !complete ? "warn" : "info"](
    { ...s, run_id: deps.runId, complete, outcome: complete ? "summary" : "summary_incomplete" },
    complete ? "parity sweep summary" : "parity sweep INCOMPLETE",
  );
  return s;
}

/** Milliseconds from `now` until the next HH:MM UTC. */
export function msUntilNextUtc(hhmm: string, now: Date = new Date()): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`invalid HH:MM ${JSON.stringify(hhmm)}`);
  const next = new Date(now);
  next.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** A run longer than this is aborted (it stops between pairs and reports incomplete). */
export const SWEEP_RUN_DEADLINE_MS = 3 * 60 * 60_000;

/**
 * Runs `run` daily at HH:MM UTC with an AbortSignal that fires on `stop()` or after `deadlineMs`.
 * - The schedule re-arms on its own clock, so a run that never settles (e.g. a hung database call that ignores the
 *   signal) cannot silently end the schedule; the next day's run is skipped and logged while one is still running.
 * - A failed run logs the error's name/code only (no message: it could carry data) and the schedule continues.
 * Returns a stop function that aborts an in-flight run and clears the timer.
 */
export function scheduleDailyUtc(
  hhmm: string,
  run: (signal: AbortSignal) => Promise<unknown>,
  logger: BridgeLogger,
  deadlineMs: number = SWEEP_RUN_DEADLINE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let current: AbortController | undefined;
  let running = false;
  const fire = (): void => {
    if (stopped) return;
    if (running) {
      logger.warn(
        { outcome: "sweep_skipped_still_running" },
        "parity sweep skipped: previous run still running",
      );
    } else {
      running = true;
      const ac = new AbortController();
      current = ac;
      const deadline = setTimeout(() => ac.abort(), deadlineMs);
      deadline.unref?.();
      run(ac.signal)
        .catch((e: unknown) => {
          const err = e as { name?: unknown; code?: unknown };
          logger.warn(
            {
              outcome: "sweep_failed",
              error: typeof err?.name === "string" ? err.name : "Error",
              ...(typeof err?.code === "string" ? { code: err.code } : {}),
            },
            "parity sweep run failed",
          );
        })
        .finally(() => {
          clearTimeout(deadline);
          running = false;
          current = undefined;
        });
    }
    arm();
  };
  const arm = (): void => {
    if (stopped) return;
    timer = setTimeout(fire, msUntilNextUtc(hhmm));
    timer.unref?.();
  };
  arm();
  return () => {
    stopped = true;
    current?.abort();
    if (timer) clearTimeout(timer);
  };
}

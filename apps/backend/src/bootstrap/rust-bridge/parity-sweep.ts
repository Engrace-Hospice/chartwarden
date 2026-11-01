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
    stoppedEarly: false,
    durationMs: 0,
  };

  const pairs: { org: string; user: string }[] = [];
  for (const { organizationId } of await deps.listActiveOrgs()) {
    s.orgs++;
    const members = await deps.listActiveMembers(organizationId);
    s.listed += members.length;
    s.counted += await deps.countActiveMembers(organizationId);
    for (const user of members) pairs.push({ org: organizationId, user });
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
    while (next < pairs.length && !s.stoppedEarly) {
      const { org, user } = pairs[next++] as { org: string; user: string };
      if (!CANONICAL_UUID_RE.test(org) || !CANONICAL_UUID_RE.test(user)) {
        s.skipped++;
        continue;
      }
      try {
        const [bun1, rust1] = await Promise.all([
          deps.freshPermissions(org, user),
          rust(org, user),
        ]);
        if (rust1 === null) throw new Error("rust");
        s.compared++;
        const d1 = sameSet(bun1, rust1);
        if (d1.onlyA === 0 && d1.onlyB === 0) {
          s.match++;
          continue;
        }
        const [bun2, rust2] = await Promise.all([
          deps.freshPermissions(org, user),
          rust(org, user),
        ]);
        if (rust2 === null) throw new Error("rust");
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
      } catch {
        s.errors++;
        if (s.errors > maxErrors) s.stoppedEarly = true;
      }
    }
  };
  await Promise.all(Array.from({ length: SWEEP_MAX_IN_FLIGHT }, worker));

  s.durationMs = Math.round(performance.now() - started);
  const complete =
    !s.stoppedEarly && s.listed === s.counted && s.compared + s.errors + s.skipped === s.listed;
  deps.logger[s.unexplained || !complete ? "warn" : "info"](
    { ...s, run_id: deps.runId, complete, outcome: "summary" },
    "parity sweep summary",
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

/** Runs `run` daily at HH:MM UTC. Returns a stop function. A failed run is logged and does not stop the schedule. */
export function scheduleDailyUtc(
  hhmm: string,
  run: () => Promise<unknown>,
  logger: BridgeLogger,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      run()
        .catch(() => logger.warn({ outcome: "sweep_failed" }, "parity sweep run failed"))
        .finally(arm);
    }, msUntilNextUtc(hhmm));
    timer.unref?.();
  };
  arm();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

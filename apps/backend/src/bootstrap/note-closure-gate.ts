// apps/backend/src/bootstrap/note-closure-gate.ts — the request-time visit-note closure gate (ADR-0113 D6).
//
// WHAT IT DOES. A staff clinician whose OLDEST clocked open visit note is past its block instant is refused (403 NOTE_CLOSURE_REQUIRED)
// on every route outside the exact allowlist in note-closure-allowlist.ts, but only when the organization's policy mode is `block`
// and no supervisor override is active. `off` and `warn` refuse nothing. The authenticate hook (plugins/authenticate.ts) calls it
// for `staff` sessions only, after the not-live-organization confinement; the machine-credential path returns before it.
//
// ORDER OF CHECKS, cheapest first:
//   1. an allowlisted METHOD + route template: pass with ZERO IO (so an allowlisted route can never 503);
//   2. the policy mode (read through the shared 5s cache): `off` / `warn` pass;
//   3. `block`: a cached CLEAR verdict (5s per organization + member) passes; otherwise ask the one evaluator the banner and the
//      board also use. `blocked` refuses; `clear` / `warn` pass. Only `clear` is cached, never `blocked`, so a signature or an
//      override takes effect on the very next request on every replica. Concurrent evaluations for one organization + member share
//      ONE in-flight evaluator call (a settled result is never reused), so a burst of blocked requests costs one transaction. A
//      joiner can therefore inherit a block computed just before a signature or an override committed; the window is one evaluator
//      call, and the client's refresh-on-403 recovers it. A started evaluation is bounded by NOTE_CLOSURE_EVALUATION_TIMEOUT_MS (a hung
//      one answers 503 and frees its key, so it cannot poison that member), and each organization + member may START at most
//      NOTE_CLOSURE_EVALUATION_BUDGET_PER_SECOND evaluator calls a second: a block is never cached (so a signature or an override takes
//      effect at once), which means a refusal sits in front of the rate limiter, and a client looping sequentially would otherwise cost
//      one transaction per request. Over the budget the request is refused 429 RATE_LIMITED with Retry-After 1, never passed.
//   4. ANY throw in 2 or 3 (policy read, evaluator, a RangeError from the pure clock) on a non-allowlisted route answers 503
//      NOTE_CLOSURE_UNAVAILABLE. A failed read never passes by default: this is a security control, so it fails closed. The one
//      exception is a failed POLICY REFRESH for an organization whose last known mode was `off` or `warn` and was read less than
//      NOTE_CLOSURE_POLICY_STALE_MS ago: that last known policy is served (those modes refuse nothing, so a database blip must not
//      take every warn tenant down). Nothing known, a last known `block`, or a last known policy older than the bound fails closed.
//      The remembered policy is the one whose read STARTED latest (an older read resolving late never overwrites a newer one).
//      The failure is reported through `onFailure`, at most once per organization per NOTE_CLOSURE_FAILURE_LOG_INTERVAL_MS (with the
//      count it suppressed), so an outage is one log line per organization, not one stack trace per request.
//   A REFUSAL (403) is evidence that the control enforces, so it is reported too (`onRefusal`): at most once per organization per
//   NOTE_CLOSURE_REFUSAL_LOG_INTERVAL_MS, carrying the organization id and the count only (no member, no note, no patient).
//
// `assertNotBlocked` is steps 2-4 WITHOUT the allowlist, for a route that is allowlisted only for part of what it does (the EVV
// offline-sync routes carry check-OUT events a blocked clinician must be able to upload, and check-IN events that start a new visit):
// the composition root hands it to that route as a plain function, so the route imports nothing from here.
//
// This is bootstrap (M1) code and imports nothing from a module: the policy cache and the evaluator are injected by the
// composition root (index.ts), which hands the SAME policy cache to the closure routes so a policy PUT invalidates what is read here.
import {
  ChartWardenError,
  type DocumentationObligationKind,
  type DocumentationObligationMode,
  type ErrorDetailType,
  RateLimitedError,
} from "@chartwarden/types";
import { NOTE_CLOSURE_ALLOWED_ROUTES } from "./note-closure-allowlist";
import { VENDOR_AUTH_ROUTE_TEMPLATE, isCleanVendorAuthPath } from "./onboarding-org-gate";

export const NOTE_CLOSURE_REQUIRED_CODE = "NOTE_CLOSURE_REQUIRED";
export const NOTE_CLOSURE_UNAVAILABLE_CODE = "NOTE_CLOSURE_UNAVAILABLE";
const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** How long a CLEAR verdict is trusted per organization + member. A block is never cached. */
export const NOTE_CLOSURE_CLEAR_TTL_MS = 5_000;
/**
 * Upper bound on remembered clear verdicts per replica. At the bound the expired ones are purged and, if the map is still full of live
 * ones, the new verdict is simply not remembered (that request costs one indexed read, nothing more).
 * ponytail: per-replica in-process map, bounded by this constant. A Valkey-backed cache only if the extra reads ever show up.
 */
export const NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES = 10_000;

/**
 * How long the last successfully read policy of an organization may stand in for a failed refresh, and only when its mode was `off` or
 * `warn`. A `block` policy is never served stale: a failed read there fails closed at once. 55s, not 60s: the shared policy cache
 * hands out a value up to 5s old, so the policy the gate remembers can already be 5s stale when it is read, and the real worst case
 * (55s + 5s) is the 60s the ADR states.
 */
export const NOTE_CLOSURE_POLICY_STALE_MS = 55_000;

/** At most one `onFailure` call per organization per this long; the calls in between are counted into `suppressed`. */
export const NOTE_CLOSURE_FAILURE_LOG_INTERVAL_MS = 30_000;

/** At most one `onRefusal` call per organization per this long; the refusals in between are counted into the next call's `refused`. */
export const NOTE_CLOSURE_REFUSAL_LOG_INTERVAL_MS = 30_000;

/** How long one evaluator call may run before it answers 503 and frees its single-flight key. */
export const NOTE_CLOSURE_EVALUATION_TIMEOUT_MS = 5_000;

/** The most evaluator calls one organization + member may START per second (cache hits and single-flight joiners do not count). */
export const NOTE_CLOSURE_EVALUATION_BUDGET_PER_SECOND = 20;
const EVALUATION_BUDGET_WINDOW_MS = 1_000;
/** The `Retry-After` of a request refused for exceeding the evaluation budget: the window is one second. */
export const NOTE_CLOSURE_BUDGET_RETRY_AFTER_SECONDS = 1;
/** Upper bound on tracked budget windows per replica (the expired ones are purged first; a full map of live ones tracks no new key). */
export const NOTE_CLOSURE_BUDGET_MAX_ENTRIES = 10_000;

/** Slice 1 gates one obligation kind. */
const VISIT_NOTE: DocumentationObligationKind = "visit_note";

/** What the gate needs of the policy; the real `ClosurePolicy` (08-encounters) satisfies it and is passed through untouched. */
export interface NoteClosureGatePolicy {
  readonly mode: DocumentationObligationMode;
}

/** What the gate needs of one evaluation; the real `MemberClosureEvaluation` satisfies it. Ids and instants only, no PHI. */
export interface NoteClosureGateEvaluation {
  readonly verdict: "clear" | "warn" | "blocked";
  readonly encounterId: string | null;
  readonly overdueCount: number;
  readonly decision: { readonly deadlineAt: Date | null; readonly blockFrom: Date | null };
}

export interface NoteClosureEvaluateInput<Policy> {
  readonly organizationId: string;
  /** The Better Auth user id: the RLS / audit actor the evaluator's transaction runs as. */
  readonly userId: string;
  readonly membershipId: string;
  readonly now: Date;
  readonly policy: Policy;
}

export interface NoteClosureGateDeps<Policy extends NoteClosureGatePolicy> {
  /**
   * The shared 5s policy cache (`createDbClosurePolicyCache`). A read that throws makes the gate answer 503 on a non-allowlisted route,
   * unless the organization's last known policy was `off` / `warn` and is fresher than {@link NOTE_CLOSURE_POLICY_STALE_MS}.
   */
  readonly policyCache: {
    get(organizationId: string, kind: DocumentationObligationKind): Promise<Policy>;
  };
  /** The one evaluator, run inside `withOrgContext` by the composition root (`evaluateMemberClosure`). */
  readonly evaluate: (
    input: NoteClosureEvaluateInput<Policy>,
  ) => Promise<NoteClosureGateEvaluation>;
  /** Injected for tests; defaults to the server clock. */
  readonly now?: () => Date;
  /**
   * Called with the failure (and the organization id only) so the cause reaches the server log: before the 503, or when a stale `off` /
   * `warn` policy was served instead (`servedStale`). Throttled per organization: `suppressed` counts the failures swallowed since
   * the previous call for that organization.
   */
  readonly onFailure?: (failure: NoteClosureGateFailure) => void;
  /**
   * Called when a request was refused 403 NOTE_CLOSURE_REQUIRED: the evidence that the control enforces. Throttled per organization to
   * one call per {@link NOTE_CLOSURE_REFUSAL_LOG_INTERVAL_MS}; `refused` counts the refusals since the previous call (this one
   * included). The organization id only: no member, no note, no patient.
   * ponytail: a tail of refusals below the interval is reported with the next refusal, not by a timer.
   */
  readonly onRefusal?: (refusal: NoteClosureGateRefusal) => void;
  /** Injected for tests: the deadline timer around an evaluator call. Defaults to `setTimeout` / `clearTimeout`. */
  readonly timers?: NoteClosureGateTimers;
  /** Injected for tests; defaults to {@link NOTE_CLOSURE_EVALUATION_TIMEOUT_MS}. */
  readonly evaluationTimeoutMs?: number;
}

export interface NoteClosureGateTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface NoteClosureGateRefusal {
  readonly organizationId: string;
  /** Refusals for this organization since the previous report (at least 1). */
  readonly refused: number;
}

export interface NoteClosureGateFailure {
  readonly organizationId: string;
  readonly error: unknown;
  /** True when the request was passed on the organization's last known `off` / `warn` policy rather than refused. */
  readonly servedStale: boolean;
  /** Failures for this organization not reported since the previous report (0 on the first). */
  readonly suppressed: number;
}

export interface NoteClosureGateRequest {
  readonly method: string;
  /** `request.routeOptions.url`; absent (no route matched) is NOT allowlisted. */
  readonly routeTemplate: string | undefined;
  readonly rawUrl: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
}

/** What the authenticate hook asks of a staff session: resolve, or throw the typed refusal. */
export interface NoteClosureGate {
  assertMayCall(request: NoteClosureGateRequest): Promise<void>;
}

export type NoteClosureGateActor = Pick<
  NoteClosureGateRequest,
  "organizationId" | "userId" | "membershipId"
>;

/**
 * The policy + evaluator half of the gate with NO allowlist, for a route that is allowlisted for only part of what it does. Resolves
 * when the member is not blocked; throws the same 403 NOTE_CLOSURE_REQUIRED / 503 NOTE_CLOSURE_UNAVAILABLE / 429 RATE_LIMITED as
 * the gate does. A separate interface so the authenticate hook still depends on `assertMayCall` alone.
 */
export interface NoteClosureBlockGuard {
  assertNotBlocked(actor: NoteClosureGateActor): Promise<void>;
}

/**
 * True when the request is an allowlisted METHOD + route-template pair, so the gate does no IO for it. The one wildcard admitted by
 * path rather than by name is Better Auth's catch-all (sign-out, get-session), only for a path that decodes cleanly under it.
 */
export function noteClosureMayCall(
  request: Pick<NoteClosureGateRequest, "method" | "routeTemplate" | "rawUrl">,
): boolean {
  const { routeTemplate } = request;
  if (!routeTemplate) return false;
  if (routeTemplate === VENDOR_AUTH_ROUTE_TEMPLATE) return isCleanVendorAuthPath(request.rawUrl);
  return NOTE_CLOSURE_ALLOWED_ROUTES.has(`${request.method.toUpperCase()} ${routeTemplate}`);
}

function closureRequired(evaluation: NoteClosureGateEvaluation): ChartWardenError {
  const { encounterId, overdueCount, decision } = evaluation;
  // The envelope's `details` is `{ field, code, message }[]`: one entry per fact, the value in `message`.
  const details: ErrorDetailType[] = [
    ...(encounterId
      ? [{ field: "encounterId", code: "OLDEST_OPEN_NOTE", message: encounterId }]
      : []),
    ...(decision.deadlineAt
      ? [{ field: "deadlineAt", code: "DEADLINE", message: decision.deadlineAt.toISOString() }]
      : []),
    { field: "overdueCount", code: "OVERDUE_COUNT", message: String(overdueCount) },
  ];
  return new ChartWardenError(
    NOTE_CLOSURE_REQUIRED_CODE,
    "a visit note is past its closure deadline; complete your open visit notes to continue (closing notes, patient-safety and read-only chart routes stay available)",
    HTTP_FORBIDDEN,
    details,
  );
}

function closureUnavailable(): ChartWardenError {
  return new ChartWardenError(
    NOTE_CLOSURE_UNAVAILABLE_CODE,
    "the visit-note closure status could not be checked; try again shortly",
    HTTP_SERVICE_UNAVAILABLE,
  );
}

/** A bounded, expiring set of "this member is clear until T" facts. Mutable by nature; it never leaves this module. */
function createClearVerdictCache(maxEntries: number) {
  const expiresAtByKey = new Map<string, number>();
  function purgeExpired(nowMs: number): void {
    for (const [key, expiresAt] of expiresAtByKey) {
      if (expiresAt <= nowMs) expiresAtByKey.delete(key);
    }
  }
  return {
    isClear(key: string, nowMs: number): boolean {
      const expiresAt = expiresAtByKey.get(key);
      return expiresAt !== undefined && expiresAt > nowMs;
    },
    remember(key: string, nowMs: number, expiresAtMs: number): void {
      if (expiresAtByKey.size >= maxEntries) purgeExpired(nowMs);
      if (expiresAtByKey.size >= maxEntries && !expiresAtByKey.has(key)) return;
      expiresAtByKey.set(key, expiresAtMs);
    },
  };
}

/**
 * A verdict is trusted until the earlier of the TTL and the instant the note would start to block, so a cached clear can never carry a
 * member past `blockFrom`.
 */
function clearUntil(nowMs: number, blockFrom: Date | null): number {
  const ttlEnd = nowMs + NOTE_CLOSURE_CLEAR_TTL_MS;
  return blockFrom ? Math.min(ttlEnd, blockFrom.getTime()) : ttlEnd;
}

/** Remembers, per organization, the last policy a read returned and when. Mutable by nature; it never leaves this module. */
function createKnownPolicies<Policy extends NoteClosureGatePolicy>() {
  const byOrganization = new Map<string, { readonly policy: Policy; readonly readAtMs: number }>();
  // ponytail: one entry per organization that has made a gated request (the policy cache is unbounded by organization count too).
  return {
    /** Keeps the entry whose read STARTED latest: an older read that resolves late never overwrites a newer one. */
    remember(organizationId: string, policy: Policy, readAtMs: number): void {
      const known = byOrganization.get(organizationId);
      if (known && known.readAtMs > readAtMs) return;
      byOrganization.set(organizationId, { policy, readAtMs });
    },
    /** The last known policy if its mode refuses nothing and it was read within the bound; otherwise undefined (fail closed). */
    usableAsStale(organizationId: string, nowMs: number): Policy | undefined {
      const known = byOrganization.get(organizationId);
      if (!known) return undefined;
      const refusesNothing = known.policy.mode === "off" || known.policy.mode === "warn";
      const fresh = nowMs - known.readAtMs <= NOTE_CLOSURE_POLICY_STALE_MS;
      return refusesNothing && fresh ? known.policy : undefined;
    },
  };
}

/** Throttles `onFailure` to one call per organization per interval, carrying the count of the calls it swallowed. */
function createFailureReporter(
  onFailure: ((failure: NoteClosureGateFailure) => void) | undefined,
  intervalMs: number,
) {
  const stateByOrganization = new Map<
    string,
    { readonly reportedAtMs: number; readonly suppressed: number }
  >();
  return (failure: Omit<NoteClosureGateFailure, "suppressed">, nowMs: number): void => {
    if (!onFailure) return;
    const state = stateByOrganization.get(failure.organizationId);
    if (state && nowMs - state.reportedAtMs < intervalMs) {
      stateByOrganization.set(failure.organizationId, {
        reportedAtMs: state.reportedAtMs,
        suppressed: state.suppressed + 1,
      });
      return;
    }
    stateByOrganization.set(failure.organizationId, { reportedAtMs: nowMs, suppressed: 0 });
    onFailure({ ...failure, suppressed: state?.suppressed ?? 0 });
  };
}

/**
 * A fixed one-second window per key: `consume` counts one STARTED evaluator call and says whether it is still within the budget.
 * Bounded: at the bound the expired windows are purged and, if the map is still full of live ones, a new key is simply not tracked (its
 * call still runs and still decides; only the budget is skipped, never the verdict).
 * ponytail: fixed window, so up to 2x the budget can land across a window edge; a sliding window if that ever matters.
 */
function createEvaluationBudget(perWindow: number, maxEntries: number) {
  const windowByKey = new Map<string, { readonly startedAtMs: number; readonly count: number }>();
  function purgeExpired(nowMs: number): void {
    for (const [key, window] of windowByKey) {
      if (nowMs - window.startedAtMs >= EVALUATION_BUDGET_WINDOW_MS) windowByKey.delete(key);
    }
  }
  return {
    consume(key: string, nowMs: number): boolean {
      const window = windowByKey.get(key);
      if (window && nowMs - window.startedAtMs < EVALUATION_BUDGET_WINDOW_MS) {
        windowByKey.set(key, { startedAtMs: window.startedAtMs, count: window.count + 1 });
        return window.count + 1 <= perWindow;
      }
      if (windowByKey.size >= maxEntries) purgeExpired(nowMs);
      if (windowByKey.size >= maxEntries && !windowByKey.has(key)) return true;
      windowByKey.set(key, { startedAtMs: nowMs, count: 1 });
      return true;
    },
  };
}

/** Throttles `onRefusal` to one call per organization per interval, each carrying the number of refusals since the last call. */
function createRefusalReporter(
  onRefusal: ((refusal: NoteClosureGateRefusal) => void) | undefined,
  intervalMs: number,
) {
  const stateByOrganization = new Map<
    string,
    { readonly reportedAtMs: number | null; readonly pending: number }
  >();
  return (organizationId: string, nowMs: number): void => {
    if (!onRefusal) return;
    const state = stateByOrganization.get(organizationId);
    const pending = (state?.pending ?? 0) + 1;
    const due = state?.reportedAtMs == null || nowMs - state.reportedAtMs >= intervalMs;
    if (!due) {
      stateByOrganization.set(organizationId, {
        reportedAtMs: state?.reportedAtMs ?? null,
        pending,
      });
      return;
    }
    stateByOrganization.set(organizationId, { reportedAtMs: nowMs, pending: 0 });
    onRefusal({ organizationId, refused: pending });
  };
}

export function createNoteClosureGate<Policy extends NoteClosureGatePolicy>(
  deps: NoteClosureGateDeps<Policy>,
): NoteClosureGate & NoteClosureBlockGuard {
  const now = deps.now ?? (() => new Date());
  const clearCache = createClearVerdictCache(NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES);
  const knownPolicies = createKnownPolicies<Policy>();
  const reportFailure = createFailureReporter(deps.onFailure, NOTE_CLOSURE_FAILURE_LOG_INTERVAL_MS);
  const reportRefusal = createRefusalReporter(deps.onRefusal, NOTE_CLOSURE_REFUSAL_LOG_INTERVAL_MS);
  const budget = createEvaluationBudget(
    NOTE_CLOSURE_EVALUATION_BUDGET_PER_SECOND,
    NOTE_CLOSURE_BUDGET_MAX_ENTRIES,
  );
  const timers: NoteClosureGateTimers = deps.timers ?? {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const evaluationTimeoutMs = deps.evaluationTimeoutMs ?? NOTE_CLOSURE_EVALUATION_TIMEOUT_MS;
  /** Evaluations in flight per organization + member: concurrent callers await the same promise; it is dropped the moment it settles. */
  const evaluationsInFlight = new Map<string, Promise<NoteClosureGateEvaluation>>();

  /** The organization's policy; on a failed read, its last known `off` / `warn` policy while fresh, else the failure is rethrown. */
  async function policyFor(organizationId: string, asOfMs: number): Promise<Policy> {
    try {
      const policy = await deps.policyCache.get(organizationId, VISIT_NOTE);
      knownPolicies.remember(organizationId, policy, asOfMs);
      return policy;
    } catch (error) {
      const stale = knownPolicies.usableAsStale(organizationId, asOfMs);
      if (stale === undefined) throw error;
      reportFailure({ organizationId, error, servedStale: true }, asOfMs);
      return stale;
    }
  }

  /**
   * `running` raced against the deadline. On timeout `release` frees the single-flight key at once (so the next request starts a fresh
   * evaluation instead of joining a hung one) and the caller gets the failure that maps to 503; a late answer, if one ever comes,
   * is ignored.
   */
  function withDeadline(
    running: Promise<NoteClosureGateEvaluation>,
    release: () => void,
  ): Promise<NoteClosureGateEvaluation> {
    return new Promise<NoteClosureGateEvaluation>((resolve, reject) => {
      const handle = timers.set(() => {
        release();
        reject(new Error("note-closure evaluation timed out"));
      }, evaluationTimeoutMs);
      running.then(
        (evaluation) => {
          timers.clear(handle);
          resolve(evaluation);
        },
        (error: unknown) => {
          timers.clear(handle);
          reject(error);
        },
      );
    });
  }

  function evaluateOnce(
    key: string,
    input: NoteClosureEvaluateInput<Policy>,
    nowMs: number,
  ): Promise<NoteClosureGateEvaluation> {
    const joined = evaluationsInFlight.get(key);
    if (joined) return joined;
    // Only a call that is actually STARTED spends budget: a cache hit and a joiner above never reach here.
    if (!budget.consume(key, nowMs)) {
      throw new RateLimitedError(
        "too many visit-note closure checks; retry in a second",
        NOTE_CLOSURE_BUDGET_RETRY_AFTER_SECONDS,
      );
    }
    // Frees the key only if it still holds THIS call (a timed-out call may already have been replaced by a newer one).
    const release = (): void => {
      if (evaluationsInFlight.get(key) === bounded) evaluationsInFlight.delete(key);
    };
    const bounded: Promise<NoteClosureGateEvaluation> = withDeadline(
      deps.evaluate(input),
      release,
    ).finally(release);
    evaluationsInFlight.set(key, bounded);
    return bounded;
  }

  /** Steps 2 and 3. Resolves the evaluation that refuses, or null to pass; throws on any failure (the caller maps it to 503). */
  async function refusingEvaluation(
    request: NoteClosureGateActor,
  ): Promise<NoteClosureGateEvaluation | null> {
    const asOf = now();
    const policy = await policyFor(request.organizationId, asOf.getTime());
    if (policy.mode === "off" || policy.mode === "warn") return null;
    if (policy.mode !== "block") throw new RangeError("unknown note-closure policy mode");

    const cacheKey = `${request.organizationId}:${request.membershipId}`;
    if (clearCache.isClear(cacheKey, asOf.getTime())) return null;
    const evaluation = await evaluateOnce(
      cacheKey,
      {
        organizationId: request.organizationId,
        userId: request.userId,
        membershipId: request.membershipId,
        now: asOf,
        policy,
      },
      asOf.getTime(),
    );
    if (evaluation.verdict === "blocked") return evaluation;
    if (evaluation.verdict !== "clear" && evaluation.verdict !== "warn") {
      throw new RangeError("unknown note-closure verdict");
    }
    if (evaluation.verdict === "clear") {
      clearCache.remember(
        cacheKey,
        asOf.getTime(),
        clearUntil(asOf.getTime(), evaluation.decision.blockFrom),
      );
    }
    return null;
  }

  async function assertNotBlocked(actor: NoteClosureGateActor): Promise<void> {
    let refusal: NoteClosureGateEvaluation | null;
    try {
      refusal = await refusingEvaluation(actor);
    } catch (error) {
      // Over the evaluation budget: a typed 429 with its Retry-After, never a pass and not a "failure" of the control.
      if (error instanceof RateLimitedError) throw error;
      reportFailure(
        { organizationId: actor.organizationId, error, servedStale: false },
        now().getTime(),
      );
      throw closureUnavailable();
    }
    if (!refusal) return;
    reportRefusal(actor.organizationId, now().getTime());
    throw closureRequired(refusal);
  }

  return {
    async assertMayCall(request) {
      if (noteClosureMayCall(request)) return;
      await assertNotBlocked(request);
    },
    assertNotBlocked,
  };
}

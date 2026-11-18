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
//      override takes effect on the very next request on every replica.
//   4. ANY throw in 2 or 3 (policy read, evaluator, a RangeError from the pure clock) on a non-allowlisted route answers 503
//      NOTE_CLOSURE_UNAVAILABLE. A failed read never passes: this is a security control, so it fails closed.
//
// This is bootstrap (M1) code and imports nothing from a module: the policy cache and the evaluator are injected by the
// composition root (index.ts), which hands the SAME policy cache to the closure routes so a policy PUT invalidates what is read here.
import {
  ChartWardenError,
  type DocumentationObligationKind,
  type DocumentationObligationMode,
  type ErrorDetailType,
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
  /** The shared 5s policy cache (`createDbClosurePolicyCache`). A read that throws makes the gate answer 503 on a non-allowlisted route. */
  readonly policyCache: {
    get(organizationId: string, kind: DocumentationObligationKind): Promise<Policy>;
  };
  /** The one evaluator, run inside `withOrgContext` by the composition root (`evaluateMemberClosure`). */
  readonly evaluate: (
    input: NoteClosureEvaluateInput<Policy>,
  ) => Promise<NoteClosureGateEvaluation>;
  /** Injected for tests; defaults to the server clock. */
  readonly now?: () => Date;
  /** Called with the failure (and the organization id only) before the 503, so the cause reaches the server log. */
  readonly onFailure?: (failure: {
    readonly organizationId: string;
    readonly error: unknown;
  }) => void;
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

export function createNoteClosureGate<Policy extends NoteClosureGatePolicy>(
  deps: NoteClosureGateDeps<Policy>,
): NoteClosureGate {
  const now = deps.now ?? (() => new Date());
  const clearCache = createClearVerdictCache(NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES);

  /** Steps 2 and 3. Resolves the evaluation that refuses, or null to pass; throws on any failure (the caller maps it to 503). */
  async function refusingEvaluation(
    request: NoteClosureGateRequest,
  ): Promise<NoteClosureGateEvaluation | null> {
    const asOf = now();
    const policy = await deps.policyCache.get(request.organizationId, VISIT_NOTE);
    if (policy.mode === "off" || policy.mode === "warn") return null;
    if (policy.mode !== "block") throw new RangeError("unknown note-closure policy mode");

    const cacheKey = `${request.organizationId}:${request.membershipId}`;
    if (clearCache.isClear(cacheKey, asOf.getTime())) return null;
    const evaluation = await deps.evaluate({
      organizationId: request.organizationId,
      userId: request.userId,
      membershipId: request.membershipId,
      now: asOf,
      policy,
    });
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

  return {
    async assertMayCall(request) {
      if (noteClosureMayCall(request)) return;
      let refusal: NoteClosureGateEvaluation | null;
      try {
        refusal = await refusingEvaluation(request);
      } catch (error) {
        deps.onFailure?.({ organizationId: request.organizationId, error });
        throw closureUnavailable();
      }
      if (refusal) throw closureRequired(refusal);
    },
  };
}

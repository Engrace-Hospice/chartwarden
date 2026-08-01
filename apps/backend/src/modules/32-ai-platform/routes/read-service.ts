// apps/backend/src/modules/32-ai-platform/routes/read-service.ts — M32-T07's READ port (§4.1 R16, R17,
// R21, R22, R31, R32).
//
// The M32-T03/T04/T05 services already cover every §4.1 surface that has a COMMAND behind it —
// capabilities, kill switches, consent, hallucination triage, evaluation runs, prompt activation. What
// they do not cover is the six read-only surfaces whose tables no service owns a write path to: the
// disclosure ledger, the token ledger, the drift view and the backend health board. This is that port.
//
// ── R16/R17 MASK RATHER THAN REFUSE, AND THAT IS THE WHOLE POINT OF THE ROUTE ────────────────────────
//
// §4.1's R16 says "PHI fields masked unless `wardenx.phi.full_read` granted". A compliance officer
// running a §164.528 accounting needs to know THAT a disclosure happened, to whom, when, and about which
// patient — she does not need the prompt text, and in a ZDR deployment nobody can read it anyway (§3.6:
// the three `_cipher` columns are DEK-enveloped and this module binds no decipher port). So the
// projection below has NO field for a prompt, a response or a chart context: the masking is structural,
// not a runtime branch that a future caller could pass `includeCipher=true` to.
//
// What `phi.full_read` actually gates here is the PATIENT IDENTITY (`patientId`) and the free-text
// `errorMessage`. Without it the row still reports `touchedPatientChart: boolean` — which is the fact
// §164.528 turns on and the fact §3.2.8's own header calls "the PHI indicator" — so a search filtered to
// chart-touching disclosures works for an actor who may not see WHICH chart. Refusing the whole row
// instead would break the review the route exists for.
//
// ── R22's FORECAST IS ARITHMETIC OVER THE LEDGER, NOT A MODEL ───────────────────────────────────────
//
// "Forecast vs. soft/hard cap, current burn rate" — a linear projection of the current window's spend to
// the window's end. Nothing here predicts. The one judgement it makes is what to do when the budget is
// UNCONFIGURED: `null` caps, and `projectedBreach` is `null` rather than `false`. `token-cap.ts` already
// pins the rule that an absent bound is not an unbounded one, and a forecast that answered "no breach"
// against a cap nobody set would be a green dashboard tile minted from a missing configuration.
//
// ── R31 READS EVALUATION RUNS BECAUSE M32 OWNS NO DRIFT TABLE ───────────────────────────────────────
//
// §4.1's R31 is "drift sweep findings within last N hours" and the manifest's thirteen `ownedTables` hold
// no `ai_drift_*`. That is not an omission in the schema: §4.8's `ai:drift-sweeps` queue computes against
// MLflow baselines and publishes `m32.drift.detected` + a `drift_response` EVALUATION RUN, which is the
// durable, auditable record the platform keeps. R31 therefore answers from `ai_evaluation_run` filtered to
// `stage = 'drift_response'` and says so in its response shape. Inventing a table for this task would put
// a second, unmigrated home for a fact §3.2.11 already stores.
import type {
  AiEvaluationRunStatus,
  AiInvocationHitlOutcome,
  AiInvocationStatus,
  AiRoutingDecision,
} from "@wardenx/types";

import type { AiEvaluationRunRowProjection } from "../safety/store";

/** The actor facts every read is scoped by (assembled server-side; see ./actor). */
export interface AiPlatformReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string | null;
  readonly roles: readonly string[];
  /** True iff the session holds M3/M5's `wardenx.phi.full_read` grant (see the header). */
  readonly phiFullRead: boolean;
}

// ── R16 / R17 — the §164.528 disclosure ledger ──────────────────────────────────────────────────────

/**
 * One `ai_invocation` row as the compliance search reads it.
 *
 * NOTE WHAT IS ABSENT AND CANNOT BE ADDED BY A CALLER: `promptPayloadCipher`, `responsePayloadCipher`
 * and `chartContextCipher` have no field here at all (see the header). `patientId` is `null` for an
 * actor without `phi.full_read` AND for a call that touched no chart — which is why
 * `touchedPatientChart` exists as a separate boolean rather than being derived from `patientId !== null`.
 * Collapsing the two would make "you may not see the patient" indistinguishable from "there was no
 * patient", and those are opposite answers to a §164.528 question.
 */
export interface AiInvocationLedgerView {
  readonly invocationId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly capabilityId: string;
  readonly capabilityKey: string;
  readonly backendId: string;
  readonly backendKey: string;
  readonly modelVersionPin: string;
  readonly promptTemplateVersion: string | null;
  readonly actorMembershipId: string;
  readonly actorRole: string;
  /** Null when masked OR when no chart was touched — read with {@link touchedPatientChart}. */
  readonly patientId: string | null;
  readonly touchedPatientChart: boolean;
  readonly consumerCorrelationId: string | null;
  readonly routingDecision: AiRoutingDecision;
  readonly routingReason: string;
  readonly inputTokenCount: number;
  readonly outputTokenCount: number;
  readonly durationMs: number;
  readonly status: AiInvocationStatus;
  readonly errorClass: string | null;
  /** Masked to `null` without `phi.full_read` — §3.4 denylists it despite the upstream PHI strip. */
  readonly errorMessage: string | null;
  readonly hitlOutcome: AiInvocationHitlOutcome;
  readonly zdrConfirmed: boolean;
  readonly invokedAt: string;
  readonly completedAt: string | null;
  /** True iff the backend was `kind='cloud'` — i.e. this row IS a §164.528 disclosure. */
  readonly disclosedToVendor: boolean;
}

/** R16's filters. Every one is a column predicate; none of them widens the org scope. */
export interface AiInvocationSearchFilters {
  readonly capabilityId?: string;
  readonly capabilityKey?: string;
  readonly backendKey?: string;
  readonly status?: AiInvocationStatus;
  readonly patientId?: string;
  /** ISO instants — inclusive lower, exclusive upper, over the PARTITION key (`invoked_at`). */
  readonly from?: string;
  readonly to?: string;
  /** True → only rows that reached a cloud backend (the disclosure subset). */
  readonly disclosuresOnly?: boolean;
  readonly limit?: number;
}

/** A page of ledger rows. `nextInvokedAtBefore` is the partition-key cursor (see the store). */
export interface AiInvocationLedgerPage {
  readonly rows: readonly AiInvocationLedgerView[];
  readonly nextInvokedAtBefore: string | null;
}

// ── R21 / R22 — the token ledger + forecast ─────────────────────────────────────────────────────────

/** One `ai_token_ledger` accrual as §5.1.6 reads it. */
export interface AiTokenLedgerEntryView {
  readonly ledgerId: string;
  readonly capabilityId: string;
  readonly backendId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cloudCostUsd: string | null;
  readonly localComputeAttribution: string | null;
  readonly accruedAt: string;
}

/** R21's filters. */
export interface AiTokenLedgerFilters {
  readonly capabilityId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

/** R21's page plus the window total, so the console does not re-add the rows it was handed. */
export interface AiTokenLedgerPage {
  readonly entries: readonly AiTokenLedgerEntryView[];
  readonly windowInputTokens: number;
  readonly windowOutputTokens: number;
}

/**
 * R22 — spend against the caps, with a linear projection to the window's end.
 *
 * `softCap` / `hardCap` / `projectedBreach` are ALL `null` when the budget is unconfigured (see the
 * header). `burnRatePerHour` is still a number in that case — the spend is a fact whether or not anyone
 * set a bound on it.
 */
export interface AiTokenForecastView {
  readonly capabilityId: string;
  readonly capabilityKey: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly spentTokens: number;
  readonly softCap: number | null;
  readonly hardCap: number | null;
  readonly burnRatePerHour: number;
  readonly projectedWindowTotal: number;
  /** `null` = no cap configured, so no projection can breach one (never `false`). */
  readonly projectedBreach: boolean | null;
}

// ── R31 / R32 — drift + backend health ──────────────────────────────────────────────────────────────

/** R31's row: a `drift_response` evaluation run, with the capability key resolved for the console. */
export interface AiDriftFindingView {
  readonly run: AiEvaluationRunRowProjection;
  readonly capabilityKey: string;
}

/** R32's per-backend health. `unknown` is a real state: a backend nobody has probed is not healthy. */
export interface AiBackendHealthView {
  readonly backendId: string;
  readonly backendKey: string;
  readonly kind: string;
  readonly isActive: boolean;
  readonly lastHealthStatus: string;
  readonly zdrStatus: string;
  readonly modelVersionPin: string;
}

/** R32's envelope — liveness plus the per-backend board. Cached 10s at the route (§4.1). */
export interface AiHealthView {
  readonly status: "ok" | "degraded";
  readonly checkedAt: string;
  readonly backends: readonly AiBackendHealthView[];
  /** The §4.1 note in machine-readable form: Phase 1 runs with `ai.full` OFF, so "no healthy backend"
   *  is the EXPECTED state and must not read as an outage. */
  readonly capabilityShellMode: boolean;
}

// ── the port ────────────────────────────────────────────────────────────────────────────────────────

/** The six §4.1 read surfaces no command service owns (Drizzle in prod; in-memory in the §10 tests). */
export interface M32ReadService {
  /** R16 — the compliance search. Masking is applied INSIDE, from `actor.phiFullRead`. */
  searchInvocations(
    actor: AiPlatformReadActor,
    filters: AiInvocationSearchFilters,
  ): Promise<AiInvocationLedgerPage>;
  /** R17 — one row. `null` when absent or out of the actor's org (the route turns that into a 404). */
  getInvocation(
    actor: AiPlatformReadActor,
    invocationId: string,
  ): Promise<AiInvocationLedgerView | null>;
  /** R21 — the ledger page + window totals. */
  tokenLedger(
    actor: AiPlatformReadActor,
    filters: AiTokenLedgerFilters,
  ): Promise<AiTokenLedgerPage>;
  /** R22 — spend vs. caps for one capability, or for every opted-in capability when none is named. */
  tokenForecast(
    actor: AiPlatformReadActor,
    capabilityId: string | null,
    at: string,
  ): Promise<readonly AiTokenForecastView[]>;
  /** R31 — `drift_response` runs created within the last `withinHours`. */
  recentDrift(
    actor: AiPlatformReadActor,
    withinHours: number,
  ): Promise<readonly AiDriftFindingView[]>;
  /** R32 — liveness + per-backend health. Platform-shared; takes no org. */
  health(at: string): Promise<AiHealthView>;
}

/** The statuses R27/R31 treat as "the run reached a verdict" (the console's default filter). */
export const AI_TERMINAL_EVALUATION_STATUSES: readonly AiEvaluationRunStatus[] = [
  "passed",
  "failed",
  "aborted",
];

/** §4.1 — R16/R21/R31 page sizes. A caller may ask for less, never for more. */
export const M32_PAGE_SIZES = { default: 50, max: 200 } as const;

/** Clamp a caller-supplied `limit` into {@link M32_PAGE_SIZES}. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return M32_PAGE_SIZES.default;
  return Math.min(Math.floor(limit), M32_PAGE_SIZES.max);
}

/**
 * Apply the §4.1 masking rule to one ledger row.
 *
 * Exported because it is the ONE place the rule lives: the Drizzle store calls it, the in-memory store
 * calls it, and the §10 test asserts against it rather than against two spellings of the same branch.
 */
export function maskInvocationForActor(
  row: AiInvocationLedgerView,
  phiFullRead: boolean,
): AiInvocationLedgerView {
  if (phiFullRead) return row;
  return { ...row, patientId: null, errorMessage: null };
}

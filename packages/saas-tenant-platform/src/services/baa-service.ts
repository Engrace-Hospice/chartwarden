// @wardenx/saas-tenant-platform · services — the platform-tenant BAA service (M34 §3.8, §7.5, D11).
//
// The WardenX → tenant Business Associate Agreement control plane — DISTINCT from M40's tenant →
// external BAA register (`mdm_baa_record`). Three responsibilities, each PURE and IO-free over the
// `BaaRegisterRepository` data port + a small set of injected ports (clock + outbox publisher), in the
// MDM job-processor / lifecycle-machine pattern (packages/mdm/src/jobs/processors.ts): every fact is
// resolved upstream and passed in, so the logic is deterministic and unit-testable with no DB, queue,
// or M36. The caller (route handler / cron worker) wraps each repo call in `withOrgContext` (org-scoped
// register writes) or `withPlatformContext` (the cross-tenant expiry sweep) so RLS scopes the statement.
//
//   1. createBaaRecord / updateBaaRecord — register-row mutators. `createBaaRecord` inserts a
//      `pending` addendum version (§7.5 step 1); `markBaaExecuted` flips it to `executed` with the
//      attestation + M22 `document_id` (§7.5 step 2) and emits `m34.baa.executed`.
//   2. evaluateBaaOnboardingGate — the §2.4.12 / D11 `onboarding → active` predicate: the latest
//      `platform_tenant_baa_record` must be `executed` with `expires_on IS NULL OR expires_on >
//      CURRENT_DATE + 90 days`. PURE — returns the two booleans the lifecycle `activate` event consumes
//      (`baaExecuted` / `baaExpiryClearsNinetyDays`); a missing/expiring BAA blocks the activation step.
//   3. runBaaExpirySweep — the `tenant.baa_expiry_sweep` daily cron (§7.5 step 4 / §4.8): emits
//      `m34.baa.platform_tenant_expiring` at the 90d / 60d / 30d / 7d / expired tiers, one event per
//      record per tier crossing, for M36 to fan out to the tenant compliance officer.
//
// Cross-module reach is via OUTBOX only (no new manifest dependsOn edge — M34 dependsOn is [1,2,3,4,36]):
// the executed-BAA + expiry events are published through the injected `BaaOutboxPublisher` port; M36 is
// the live consumer (the alert-rule engine, §4.8). No direct import of M22/M36/M5.
import type { schema } from "@wardenx/db";
import type { BaaRegisterRepository } from "../repositories/baa-register";

/** The platform-tenant BAA register row (M34 §3.8) — surfaced via the `@wardenx/db` `schema` namespace
 *  (the M34 repos' `schema.PlatformTenantBaaRecord` convention). */
type PlatformTenantBaaRecord = schema.PlatformTenantBaaRecord;

// ── outbox event names (string-pinned, adopted verbatim by events-by-m34.ts — the §4.9 catalog) ──────
//
// The authoritative wire names already live in apps/backend/src/modules/34-saas-tenant-platform/
// events-by-m34.ts (`m34.baa.executed`, `m34.baa.platform_tenant_expiring`). This pure package pins them
// as constants so the service stays self-contained (the lifecycle-effects.ts precedent); the spec prose
// names the expiry alert by its bare M36 rule key `baa.platform_tenant_expiring`, but the canonical
// outbox name carries the owning module's `m34.` prefix (M01 D8 / M03 D9).

/** `m34.baa.executed` — a `platform_tenant_baa_record` flipped to `executed` (§7.5 step 2 / §4.9). */
export const M34_BAA_EXECUTED_EVENT = "m34.baa.executed" as const;
/** `m34.baa.platform_tenant_expiring` — a BAA crossed an expiry tier (§7.5 step 4 / §4.8). */
export const M34_BAA_EXPIRING_EVENT = "m34.baa.platform_tenant_expiring" as const;

/** The §7.5-step-4 expiry tiers the daily sweep emits, soonest-to-fire last (mirrors events-by-m34.ts). */
export type BaaExpiryTier =
  | "expiring_90d"
  | "expiring_60d"
  | "expiring_30d"
  | "expiring_7d"
  | "expired";

/** The §7.5 tier boundaries in days-to-expiry. A record fires the *nearest crossed* tier (the smallest
 *  threshold whose window the record has entered) — a record 5 days out fires `expiring_7d`, not 90/60/30. */
const EXPIRY_TIER_DAYS: ReadonlyArray<{
  readonly tier: BaaExpiryTier;
  readonly withinDays: number;
}> = [
  { tier: "expiring_7d", withinDays: 7 },
  { tier: "expiring_30d", withinDays: 30 },
  { tier: "expiring_60d", withinDays: 60 },
  { tier: "expiring_90d", withinDays: 90 },
];

/** D11 — the §2.4.12 activation guard rejects an executed BAA expiring within this many days. */
export const BAA_ONBOARDING_GATE_DAYS = 90 as const;

const MS_PER_DAY = 86_400_000;

/** Payload of the `m34.baa.platform_tenant_expiring` outbox event (mirrors the §4.9 catalog schema). */
export interface BaaExpiringEventPayload {
  readonly tenantAccountId: string;
  readonly addendumVersion: string;
  /** ISO date (`YYYY-MM-DD`) the BAA expires on, or `null` for a never-expiring BAA (never fires). */
  readonly expiresOn: string | null;
  readonly tier: BaaExpiryTier;
}

/** Payload of the `m34.baa.executed` outbox event (mirrors the §4.9 catalog schema). */
export interface BaaExecutedEventPayload {
  readonly tenantAccountId: string;
  readonly addendumVersion: string;
  readonly expiresOn: string | null;
}

/**
 * The outbox port the service publishes through (M36 is the live consumer, §4.8). The route/worker
 * binds a publisher that enqueues the row in the SAME transaction as the mutation (M1 §25.5/§25.6) so
 * "DB updated but the event never went out" is closed structurally; the in-memory publisher in tests
 * just records the calls. No direct M36 import — the dependency runs the other way (M36 consumes M34).
 */
export interface BaaOutboxPublisher {
  /** Publish `m34.baa.executed` when a BAA record flips to `executed` (§7.5 step 2). */
  publishBaaExecuted(payload: BaaExecutedEventPayload): Promise<void>;
  /** Publish `m34.baa.platform_tenant_expiring` for one record at one crossed tier (§7.5 step 4). */
  publishBaaExpiring(payload: BaaExpiringEventPayload): Promise<void>;
}

/** Injected clock (`@wardenx/tenancy` convention — no `Date.now()` in the pure layer), so the sweep's
 *  tier math + the onboarding-gate 90-day cutoff are deterministic and assertable. */
export type Clock = () => Date;

// ── §2.4.12 / D11 onboarding gate (PURE predicate) ───────────────────────────────────────────────────

/** The two booleans the lifecycle `activate` event consumes (§2.4.12 — `baaExecuted` /
 *  `baaExpiryClearsNinetyDays`), plus the reason a gate failed (for the route's 412 message). */
export interface BaaOnboardingGateResult {
  /** §2.4.12 — the latest BAA record is `baa_status='executed'`. */
  readonly baaExecuted: boolean;
  /** §2.4 D11 — that executed BAA has `expires_on IS NULL OR expires_on > now + 90 days`. */
  readonly baaExpiryClearsNinetyDays: boolean;
  /** Why the gate blocks (or `null` when both checks pass), for the activation route's precise message. */
  readonly blockReason: "no_executed_baa" | "baa_expiring_within_90d" | null;
}

/** Parse a Drizzle `date` column (`YYYY-MM-DD`, midnight UTC) to ms, or `null` (no expiry / unset). */
function dateToMs(isoDate: string | null): number | null {
  if (isoDate === null) return null;
  const ms = Date.parse(`${isoDate}T00:00:00.000Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Evaluate the §2.4.12 / D11 `onboarding → active` BAA gate against the LATEST BAA record for a tenant
 * (the caller passes the newest-executed row, e.g. `listByTenantAccountId(...)[0]`, or `null` if none).
 * PURE: no IO. A missing record, a non-`executed` record, or an `executed` record expiring within 90
 * days BLOCKS activation — the lifecycle `activate` guard raises `BAA_NOT_EXECUTED` / `BAA_EXPIRING_SOON`
 * off the returned booleans (lifecycle-transition.ts). A `null` `expires_on` (perpetual BAA) clears.
 */
export function evaluateBaaOnboardingGate(
  latest: PlatformTenantBaaRecord | null,
  now: Date,
): BaaOnboardingGateResult {
  if (latest === null || latest.baaStatus !== "executed") {
    return { baaExecuted: false, baaExpiryClearsNinetyDays: false, blockReason: "no_executed_baa" };
  }
  const expiresMs = dateToMs(latest.expiresOn);
  // Perpetual BAA (no expiry) always clears; otherwise require >90 days of runway from `now`.
  const cutoffMs = now.getTime() + BAA_ONBOARDING_GATE_DAYS * MS_PER_DAY;
  const clears = expiresMs === null || expiresMs > cutoffMs;
  return {
    baaExecuted: true,
    baaExpiryClearsNinetyDays: clears,
    blockReason: clears ? null : "baa_expiring_within_90d",
  };
}

// ── §7.5-step-4 daily expiry sweep (PURE tier selection over the repo's expiry-ordered read) ─────────

/** Whole days from `now` to a record's `expires_on` (UTC-midnight to `now`), floored. Negative once past. */
function daysUntil(expiresMs: number, nowMs: number): number {
  return Math.floor((expiresMs - nowMs) / MS_PER_DAY);
}

/**
 * Select the single expiry tier a record fires on `runAt`, or `null` if it is not yet inside the 90-day
 * window (and not expired). A past-expiry record fires `expired`; otherwise the NEAREST crossed tier
 * (smallest threshold whose window the record entered) — 5 days out → `expiring_7d`. Records with a
 * `null` `expires_on` (perpetual) never fire. Exported for the sweep's unit tests.
 */
export function selectBaaExpiryTier(expiresOn: string | null, runAt: Date): BaaExpiryTier | null {
  const expiresMs = dateToMs(expiresOn);
  if (expiresMs === null) return null;
  const days = daysUntil(expiresMs, runAt.getTime());
  if (days < 0) return "expired";
  for (const { tier, withinDays } of EXPIRY_TIER_DAYS) {
    if (days <= withinDays) return tier;
  }
  return null;
}

/** What one `runBaaExpirySweep` run reported (the cron's result + the §8 `m34_baa_expiring_within_90d_total` feed). */
export interface BaaExpirySweepResult {
  /** Records inspected (those with a non-null `expires_on`, the repo's `listByExpiry()` set). */
  readonly inspected: number;
  /** Records that fired an event this run (one per crossed tier). */
  readonly fired: number;
  /** Per-tier fired counts (drives the §8 gauge feed; `expired` distinguished from the warn tiers). */
  readonly byTier: Readonly<Record<BaaExpiryTier, number>>;
}

/** The ports `runBaaExpirySweep` binds — the BAA register read + the outbox publisher + the clock. The
 *  worker establishes `withPlatformContext` around the call (the sweep is cross-tenant, platform-ops). */
export interface BaaExpirySweepPorts {
  readonly baaRegister: Pick<BaaRegisterRepository, "listByExpiry">;
  readonly outbox: Pick<BaaOutboxPublisher, "publishBaaExpiring">;
  readonly now: Clock;
}

/**
 * Run the `tenant.baa_expiry_sweep` daily cron (§7.5 step 4 / §4.8). Reads every BAA record with an
 * expiry date (soonest-first, `listByExpiry()`), and for each that has crossed a tier emits one
 * `m34.baa.platform_tenant_expiring` event at that tier for M36 to fan out to the tenant compliance
 * officer. ONLY `executed` records are swept — a `pending`/`terminated`/`missing` BAA is not a live
 * agreement whose expiry the compliance officer must act on (a `terminated` BAA drives auto-suspension
 * via a SEPARATE lifecycle path, §7.5 step 5, not this alert). Deterministic ordering (the repo sorts by
 * `expires_on asc`) so a partial failure is reproducible. Idempotent-at-the-tier: re-running the same
 * day re-fires the same tier — the outbox/idempotency middleware dedupes on the keyed event id (§2.6).
 */
export async function runBaaExpirySweep(ports: BaaExpirySweepPorts): Promise<BaaExpirySweepResult> {
  const records = await ports.baaRegister.listByExpiry();
  const runAt = ports.now();
  const byTier: Record<BaaExpiryTier, number> = {
    expiring_90d: 0,
    expiring_60d: 0,
    expiring_30d: 0,
    expiring_7d: 0,
    expired: 0,
  };
  let inspected = 0;
  let fired = 0;

  for (const record of records) {
    // Only live, executed agreements are swept (§7.5 — pending/terminated/missing are not on the
    // compliance officer's renewal radar; terminated drives suspension on a separate path, step 5).
    if (record.baaStatus !== "executed") continue;
    inspected += 1;
    const tier = selectBaaExpiryTier(record.expiresOn, runAt);
    if (tier === null) continue; // not yet within 90 days (and not expired) — nothing to alert.
    await ports.outbox.publishBaaExpiring({
      tenantAccountId: record.tenantAccountId,
      addendumVersion: record.addendumVersion,
      expiresOn: record.expiresOn,
      tier,
    });
    byTier[tier] += 1;
    fired += 1;
  }

  return { inspected, fired, byTier };
}

// ── §7.5-step-1/2 register mutators (thin wrappers over the repo + the executed-event outbox) ────────

/** Input to `createBaaRecord` — issue a new addendum version `pending` execution (§7.5 step 1). The
 *  org spine + tenant id + addendum version are required; contacts / disclosure set are optional. */
export interface CreateBaaRecordInput {
  readonly organizationId: string;
  readonly tenantAccountId: string;
  readonly addendumVersion: string;
  readonly breachNotificationContactEmail?: string | null;
  readonly breachNotificationContactPhone?: string | null;
  readonly subcontractorDisclosureSet?: unknown;
}

/** Input to `markBaaExecuted` — the §7.5-step-2 attestation flip (`pending → executed`). */
export interface MarkBaaExecutedInput {
  /** The `platform_tenant_baa_record.id` being executed. */
  readonly baaRecordId: string;
  /** ISO `YYYY-MM-DD` the BAA was executed on. */
  readonly executedOn: string;
  /** ISO `YYYY-MM-DD` it takes effect (defaults to `executedOn` if omitted by the caller). */
  readonly effectiveOn: string;
  /** ISO `YYYY-MM-DD` it expires, or `null` for a perpetual BAA. */
  readonly expiresOn: string | null;
  /** The tenant compliance officer's membership id (the attesting actor, §7.5 step 2). */
  readonly complianceOfficerAttestationMembershipId: string;
  /** When the attestation step-up succeeded (the route's `now()`). */
  readonly attestedAt: Date;
  /** The M22 `document_id` of the stored, signed PDF (the §7.5-step-2 M22 handshake), or `null`. */
  readonly documentId: string | null;
}

/** The ports the register mutators bind — the BAA register repo + the outbox publisher. The route wraps
 *  the call in `withOrgContext` (the BAA register is org-scoped, M34-F02/ADR-0010) so RLS scopes it. */
export interface BaaRegisterServicePorts {
  readonly baaRegister: BaaRegisterRepository;
  readonly outbox: Pick<BaaOutboxPublisher, "publishBaaExecuted">;
}

/**
 * Issue a new platform-tenant BAA addendum version awaiting execution (§7.5 step 1): insert a
 * `platform_tenant_baa_record(baa_status='pending')`. One row per (tenant_account, addendum_version)
 * — the repo's `platform_tenant_baa_unique` index rejects a duplicate. No outbox event at this step;
 * the alert path begins at execution / the expiry sweep. Returns the inserted record.
 */
export async function createBaaRecord(
  ports: BaaRegisterServicePorts,
  input: CreateBaaRecordInput,
): Promise<PlatformTenantBaaRecord> {
  return ports.baaRegister.create({
    organizationId: input.organizationId,
    tenantAccountId: input.tenantAccountId,
    addendumVersion: input.addendumVersion,
    baaStatus: "pending",
    breachNotificationContactEmail: input.breachNotificationContactEmail ?? null,
    breachNotificationContactPhone: input.breachNotificationContactPhone ?? null,
    ...(input.subcontractorDisclosureSet !== undefined
      ? { subcontractorDisclosureSet: input.subcontractorDisclosureSet }
      : {}),
  });
}

/**
 * Execute a pending BAA (§7.5 step 2): flip `pending → executed`, stamp the executed/effective/expiry
 * dates + the compliance-officer attestation + the M22 `document_id`, then publish `m34.baa.executed`
 * so M36/M33 observe the agreement is live. The route gates this behind passkey step-up (D10 `baa.write`)
 * and wraps it in `withOrgContext`. Returns the updated record. The PUBLISH happens after the UPDATE in
 * the same transaction the route opens (outbox-in-tx, M1 §25.5/§25.6); the publisher here just enqueues.
 */
export async function markBaaExecuted(
  ports: BaaRegisterServicePorts,
  input: MarkBaaExecutedInput,
): Promise<PlatformTenantBaaRecord> {
  const updated = await ports.baaRegister.update(input.baaRecordId, {
    baaStatus: "executed",
    executedOn: input.executedOn,
    effectiveOn: input.effectiveOn,
    expiresOn: input.expiresOn,
    complianceOfficerAttestationMembershipId: input.complianceOfficerAttestationMembershipId,
    attestedAt: input.attestedAt,
    documentId: input.documentId,
  });
  await ports.outbox.publishBaaExecuted({
    tenantAccountId: updated.tenantAccountId,
    addendumVersion: updated.addendumVersion,
    expiresOn: updated.expiresOn,
  });
  return updated;
}

/**
 * Patch a BAA register row's contacts / disclosure set / status (§7.5 administrative edits +
 * termination). A `terminated` flip here records the agreement end; the auto-suspension of a tenant
 * whose BAA is `terminated` is driven by a SEPARATE lifecycle/sweep path (§7.5 step 5), not this call.
 * No outbox event (use `markBaaExecuted` for the execution transition). Returns the updated record.
 */
export async function updateBaaRecord(
  ports: Pick<BaaRegisterServicePorts, "baaRegister">,
  baaRecordId: string,
  patch: Partial<{
    baaStatus: PlatformTenantBaaRecord["baaStatus"];
    breachNotificationContactEmail: string | null;
    breachNotificationContactPhone: string | null;
    subcontractorDisclosureSet: unknown;
    expiresOn: string | null;
  }>,
): Promise<PlatformTenantBaaRecord> {
  return ports.baaRegister.update(baaRecordId, patch);
}

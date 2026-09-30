// apps/backend/src/modules/39-consent/jobs/expiration.ts — M39 §4.9 `consent-expiration` and
// `expiration-reminder` cron bodies (F-216). THE PURE ENGINES ALREADY EXISTED (`shouldExpire`,
// `mostUrgentReminder` in `@wardenx/consent`'s `jobs/index.ts`, `nextConsentStatus` in its status
// machine) with no production caller — `M39_QUEUES`/`shouldExpire` had zero uses under apps/backend, so
// nothing ever flipped a lapsed consent to `expired` and `m39.consent.expired` / `.expiring_soon` had no
// producer (the `m5 <- m39.consent.expired` deferral's real blocker, F-167).
//
// RELAY/CRON TICKS ARE NOT REQUESTS. Every function here takes the org id EXPLICITLY and opens its own
// `withOrgContext` transaction (RLS scoped to that one org); nothing reads an ambient request context. The
// fan-out over orgs is the caller's `ActiveOrgListPort` (the audited platform enumerator).
//
// STATE CHANGE + EVENT IN ONE TRANSACTION. The status flip, the reminder row and the outbox row commit or
// roll back together, through whatever publisher the composition root injects (the REAL catalog-validating
// `bindCallerModule(txOutboxPublisher, "m39")` in production and in the live suite).
//
// IDEMPOTENT / NEVER RE-EXPIRES. Candidates are selected `status = 'active'` only and the UPDATE repeats that
// guard, so a revoked / superseded / already-expired row is never touched and a second run finds nothing to
// emit. Candidate rows are taken `FOR UPDATE SKIP LOCKED`, so two overlapping ticks never double-process a
// row. Reminders are idempotent on `consent_expiration_reminder.idempotency_key` (`ON CONFLICT DO NOTHING`).
//
// RENEWAL SAFETY. `renew` leaves the prior record `active` until its `expires_at` passes (spec §3.2 flow 6),
// so a Part-2 consent that was renewed ticks to `expired` while its successor is live. The `expired` payload
// therefore carries `remainingActiveConsentRecordId` when another active consent of the same patient+type
// exists, and M5's consumer keeps the privacy flag lifted in that case instead of re-restricting SUD.
//
// BACKLOG BOUND. See `M39_CRON_BOUNDS`: at most `pageSize * maxPagesPerOrg` rows per org per tick.
import { type ConsentReminderKind, mostUrgentReminder, nextConsentStatus, shouldExpire } from "@wardenx/consent";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { ConsentWriteOutboxPort } from "../consent-store-db";
import { M39_CRON_BOUNDS } from "./index";

const CR = schema.consentRecord;
const CAT = schema.consentTypeCatalog;
const REM = schema.consentExpirationReminder;

/** The system actor id the cron stamps on its per-org tx. Empty, not a UUID: the M4 write-audit trigger on
 *  `consent_record` casts the ambient acting-user variable to `actor_user_id` (NOT-NULL-FK to `user` only when
 *  non-empty); an empty string reads back as SQL NULL, which the FK accepts (the M20 watchdog precedent). */
export const M39_WORKER_SYSTEM_USER_ID = "";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The widest §4.9 reminder window. */
const REMINDER_LOOKAHEAD_MS = 90 * DAY_MS;

/** The structural active-org reader the composition root injects (the M14/M20 `ActiveOrgListPort` shape). */
export interface M39ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface M39CronDeps {
  readonly db: DbClient;
  readonly outbox: ConsentWriteOutboxPort;
  readonly now?: () => Date;
}

export interface ExpirationRunSummary {
  readonly expired: number;
  /** True when the per-org page cap was hit — more lapsed rows remain and drain on the next tick. */
  readonly backlogRemaining: boolean;
}

export interface ReminderRunSummary {
  readonly reminded: number;
  readonly backlogRemaining: boolean;
}

// ── pure decisions ─────────────────────────────────────────────────────────────────────────────────

/** §4.9: may this row tick to `expired` at `nowMs`? Composes the two pure engines (the `shouldExpire` window
 *  check and the status machine's `tickExpired` legality) so neither can be bypassed. */
export function planConsentExpiry(input: {
  status: "draft" | "active" | "superseded" | "revoked" | "expired";
  expiresAtMs: number | null;
  nowMs: number;
}): boolean {
  return shouldExpire(input) && nextConsentStatus(input.status, "tickExpired").ok;
}

/** §4.9 / D9: the ONE reminder to fire this tick for a consent — the most urgent OPEN window that the
 *  consent type's cadence floor actually lists. A consent that first enters the scan already inside several
 *  windows gets only its most urgent one (never a 90/30/14/7/1 burst); windows the type's floor omits never
 *  fire. `null` when nothing is due. */
export function planConsentReminder(input: {
  expiresAtMs: number | null;
  nowMs: number;
  cadenceFloor: readonly string[];
}): ConsentReminderKind | null {
  if (input.expiresAtMs === null) return null;
  const allowed = new Set(input.cadenceFloor);
  const remaining = input.expiresAtMs - input.nowMs;
  if (remaining <= 0) return null;
  // Smallest window first = most urgent; the first ALLOWED open one wins.
  for (const kind of ["1_day", "7_days", "14_days", "30_days", "90_days"] as const) {
    if (!allowed.has(kind)) continue;
    if (remaining <= Number.parseInt(kind, 10) * DAY_MS) return kind;
  }
  return null;
}

// Keep the package's own engine in the decision path: a window is only ever "open" if the package agrees.
function windowOpen(expiresAtMs: number | null, nowMs: number): boolean {
  return mostUrgentReminder({ expiresAtMs, nowMs }) !== null;
}

// ── per-org expiration ────────────────────────────────────────────────────────────────────────────

/** Flip up to one page of lapsed `active` consents to `expired` for ONE org, publishing
 *  `m39.consent.expired` in the same transaction. Returns how many rows flipped. */
async function expireOnePage(
  deps: M39CronDeps,
  organizationId: string,
  now: Date,
): Promise<number> {
  const nowIso = now.toISOString();
  return withOrgContext(
    deps.db,
    { organizationId, userId: M39_WORKER_SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const rows = await tx
        .select()
        .from(CR)
        .where(
          and(
            eq(CR.organizationId, organizationId),
            eq(CR.status, "active"),
            lte(CR.expiresAt, now),
          ),
        )
        .orderBy(asc(CR.expiresAt), asc(CR.id))
        .limit(M39_CRON_BOUNDS.pageSize)
        .for("update", { skipLocked: true });
      let flipped = 0;
      for (const row of rows) {
        if (
          !planConsentExpiry({
            status: row.status,
            expiresAtMs: row.expiresAt?.getTime() ?? null,
            nowMs: now.getTime(),
          })
        )
          continue;
        const [updated] = await tx
          .update(CR)
          .set({ status: "expired", updatedAt: now })
          .where(
            and(
              eq(CR.organizationId, organizationId),
              eq(CR.id, row.id),
              eq(CR.status, "active"),
            ),
          )
          .returning({ id: CR.id });
        if (!updated) continue; // lost a race to a revoke/supersede — never re-expire
        const [remaining] = await tx
          .select({ id: CR.id })
          .from(CR)
          .where(
            and(
              eq(CR.organizationId, organizationId),
              eq(CR.patientId, row.patientId),
              eq(CR.typeKey, row.typeKey),
              eq(CR.status, "active"),
              ne(CR.id, row.id),
              or(isNull(CR.expiresAt), gt(CR.expiresAt, now)),
            ),
          )
          .limit(1);
        await deps.outbox.publish(tx, {
          eventName: "m39.consent.expired",
          payload: {
            organizationId,
            patientId: row.patientId,
            consentRecordId: row.id,
            typeKey: row.typeKey,
            expiredAt: nowIso,
            ...(remaining ? { remainingActiveConsentRecordId: remaining.id } : {}),
          },
          organizationId,
          aggregateKind: "consent_record",
          aggregateId: row.id,
        });
        flipped += 1;
      }
      return flipped;
    },
  );
}

/** `m39.consent_expiration` for ONE org: bounded pages until nothing lapsed remains or the cap is hit. */
export async function runConsentExpirationForOrg(
  deps: M39CronDeps,
  organizationId: string,
): Promise<ExpirationRunSummary> {
  const now = (deps.now ?? (() => new Date()))();
  let expired = 0;
  for (let page = 0; page < M39_CRON_BOUNDS.maxPagesPerOrg; page += 1) {
    const n = await expireOnePage(deps, organizationId, now);
    expired += n;
    if (n < M39_CRON_BOUNDS.pageSize) return { expired, backlogRemaining: false };
  }
  return { expired, backlogRemaining: true };
}

// ── per-org reminders ─────────────────────────────────────────────────────────────────────────────

async function remindOnePage(
  deps: M39CronDeps,
  organizationId: string,
  now: Date,
  cursor: { expiresAt: Date; id: string } | null,
): Promise<{ reminded: number; scanned: number; next: { expiresAt: Date; id: string } | null }> {
  const nowMs = now.getTime();
  const horizon = new Date(nowMs + REMINDER_LOOKAHEAD_MS);
  return withOrgContext(
    deps.db,
    { organizationId, userId: M39_WORKER_SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const where = [
        eq(CR.organizationId, organizationId),
        eq(CR.status, "active"),
        gt(CR.expiresAt, now),
        lte(CR.expiresAt, horizon),
      ];
      if (cursor) where.push(sql`(${CR.expiresAt}, ${CR.id}) > (${cursor.expiresAt}, ${cursor.id})`);
      const rows = await tx
        .select({
          id: CR.id,
          patientId: CR.patientId,
          typeKey: CR.typeKey,
          expiresAt: CR.expiresAt,
          cadenceFloor: CAT.reminderCadenceFloor,
        })
        .from(CR)
        .innerJoin(CAT, eq(CAT.typeKey, CR.typeKey))
        .where(and(...where))
        .orderBy(asc(CR.expiresAt), asc(CR.id))
        .limit(M39_CRON_BOUNDS.pageSize);
      let reminded = 0;
      for (const row of rows) {
        const expiresAtMs = row.expiresAt?.getTime() ?? null;
        if (!windowOpen(expiresAtMs, nowMs)) continue;
        const kind = planConsentReminder({
          expiresAtMs,
          nowMs,
          cadenceFloor: row.cadenceFloor as string[],
        });
        if (kind === null || row.expiresAt === null) continue;
        const days = Number.parseInt(kind, 10);
        const [inserted] = await tx
          .insert(REM)
          .values({
            organizationId,
            consentRecordId: row.id,
            reminderKind: kind,
            scheduledFor: new Date(row.expiresAt.getTime() - days * DAY_MS),
            firedAt: now,
            deliveryChannel: "m36_alert",
            // Recipients are resolved by M36's alert-rule registry at delivery (spec §4.10); the log row
            // records that the resolution is M36's, not a snapshot taken here.
            recipientResolutionJsonb: { resolver: "m36_alert_rule_registry" },
            idempotencyKey: `m39.consent_reminder:${row.id}:${kind}`,
          })
          .onConflictDoNothing({ target: REM.idempotencyKey })
          .returning({ id: REM.id });
        if (!inserted) continue; // this (consent, kind) already fired — idempotent
        await deps.outbox.publish(tx, {
          eventName: "m39.consent.expiring_soon",
          payload: {
            organizationId,
            patientId: row.patientId,
            consentRecordId: row.id,
            typeKey: row.typeKey,
            expiresAt: row.expiresAt.toISOString(),
            reminderKind: kind,
          },
          organizationId,
          aggregateKind: "consent_record",
          aggregateId: row.id,
        });
        reminded += 1;
      }
      const last = rows[rows.length - 1];
      return {
        reminded,
        scanned: rows.length,
        next: last?.expiresAt ? { expiresAt: last.expiresAt, id: last.id } : null,
      };
    },
  );
}

/** `m39.expiration_reminder` for ONE org: keyset-paged scan of consents inside the 90-day window. */
export async function runExpirationReminderForOrg(
  deps: M39CronDeps,
  organizationId: string,
): Promise<ReminderRunSummary> {
  const now = (deps.now ?? (() => new Date()))();
  let reminded = 0;
  let cursor: { expiresAt: Date; id: string } | null = null;
  for (let page = 0; page < M39_CRON_BOUNDS.maxPagesPerOrg; page += 1) {
    const r = await remindOnePage(deps, organizationId, now, cursor);
    reminded += r.reminded;
    if (r.scanned < M39_CRON_BOUNDS.pageSize || r.next === null)
      return { reminded, backlogRemaining: false };
    cursor = r.next;
  }
  return { reminded, backlogRemaining: true };
}

// ── fan-out ───────────────────────────────────────────────────────────────────────────────────────

/** Fan a per-org body out over the active orgs. One org's failure never aborts the orgs after it (each
 *  org's tx commits independently); failures are collected and rethrown together so the job still fails
 *  loudly for DLQ alerting (the M14 review-clock-sweep precedent). */
async function fanOut<T>(
  activeOrgs: M39ActiveOrgListPort,
  jobName: string,
  body: (organizationId: string) => Promise<T>,
): Promise<ReadonlyMap<string, T>> {
  const orgs = await activeOrgs.listActiveOrgs();
  const out = new Map<string, T>();
  const failures: { organizationId: string; error: unknown }[] = [];
  for (const { organizationId } of orgs) {
    try {
      out.set(organizationId, await body(organizationId));
    } catch (error) {
      failures.push({ organizationId, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `${jobName}: ${failures.length} of ${orgs.length} org(s) failed — ${failures
        .map((f) => f.organizationId)
        .join(", ")}`,
    );
  }
  return out;
}

export function runConsentExpirationCron(
  deps: M39CronDeps & { readonly activeOrgs: M39ActiveOrgListPort },
): Promise<ReadonlyMap<string, ExpirationRunSummary>> {
  return fanOut(deps.activeOrgs, "M39_CONSENT_EXPIRATION", (orgId) =>
    runConsentExpirationForOrg(deps, orgId),
  );
}

export function runExpirationReminderCron(
  deps: M39CronDeps & { readonly activeOrgs: M39ActiveOrgListPort },
): Promise<ReadonlyMap<string, ReminderRunSummary>> {
  return fanOut(deps.activeOrgs, "M39_EXPIRATION_REMINDER", (orgId) =>
    runExpirationReminderForOrg(deps, orgId),
  );
}

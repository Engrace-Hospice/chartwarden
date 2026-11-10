// apps/backend/src/modules/23-billing-medicare/claimmd-webhook/sweep.ts — settles stored Claim.MD webhook receipts
// (ADR-0053 amendment D7/D8). Runs on the platform role (the receipt table is platform-only; one Claim.MD account serves
// every tenant), every minute, over at most 100 rows taken FOR UPDATE SKIP LOCKED.
//
// Tenant resolution (D8), never from the payload's own claims about a tenant:
//   enroll  → prov_npi       → provider_entity (NPI is unique platform-wide) → organization + provider entity, ONLY
//             when platform staff have verified that entity's current NPI (provider_npi_verification, migration 1326)
//   appeal  → remote_claimid → the live clearinghouse_submission_attempt with that (usage, control_number), which is
//             unique per usage platform-wide. (`remote_claimid` is Claim.MD's REF*D9 / remote_claimid: what we must send
//             as our control number for this to match; `claimid` is Claim.MD's own id, which an X12 upload never returns.)
// An unknown NPI or claim is terminal `unroutable_*` (ids-only log). Once the tenant is known the Billing add-on is
// checked through BillingEntitlementPort: not entitled → `awaiting_entitlement` (kept encrypted, re-checked hourly,
// processed when the add-on is granted, `expired_not_entitled` after the retention window); a port error leaves the row
// as it was for the next sweep, and so does a payload the sweep cannot decrypt (a key fault; one ops alert per sweep),
// but not for ever: a row stored under another key id is refused before any decrypt (`payload_key_mismatch`), rows that
// already failed sort after fresh ones so they cannot starve new receipts, and a key-fault row still unreadable
// CLAIMMD_KEY_FAULT_GRACE_DAYS after receipt goes terminal `failed` (ops alert). Retention clears EVERY cipher
// CLAIMMD_PAYLOAD_RETENTION_DAYS after `received_at`, processed or not.
// Entitled → one PHI-free `m23.clearinghouse.*_reported` event in the SAME transaction
// that marks the row `published`, so a row is published at most once.
//
// The decrypted element (which can hold a provider TIN, possibly an SSN, and untrusted vendor text) never leaves this
// file: payloads carry ids, the control number, enroll_type and ONE bounded vendor status word.
import { createHash } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import type { WebhookPayloadCipher } from "@chartwarden/shared";
import { sql } from "drizzle-orm";
import { providerEntityByNpi } from "../../../bootstrap/provider-entity-npi-lookup";
import { isNpiVerified } from "../routes/npi-verification-service";
import type { ClaimMdPlatformRunner } from "./receipt-store";

/** The Billing add-on capability (M35). Bound at the composition root; see index.ts. */
export interface BillingEntitlementPort {
  isEntitled(organizationId: string): Promise<boolean>;
}

export interface ClaimMdSweepOutbox {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface ClaimMdSweepDeps {
  readonly runner: ClaimMdPlatformRunner;
  readonly cipher: WebhookPayloadCipher;
  readonly entitlement: BillingEntitlementPort;
  readonly outbox: ClaimMdSweepOutbox;
  readonly now?: () => Date;
  /** Ids and outcome words only. */
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
  /**
   * A receipt went terminal `failed`: Claim.MD already has its 200 and will not resend, so the event is lost unless an
   * operator acts. Bound to the ops alert sink (error level). Ids and the error class only, never the payload.
   */
  readonly onFailed?: (detail: {
    readonly usage: string;
    readonly eventId: string;
    readonly attempts: number;
    readonly errorClass: string;
  }) => void;
  /**
   * Payloads this sweep could not decrypt: a key/config fault (a wrong CLAIMMD_WEBHOOK_PAYLOAD_KEY), not a bad row, so
   * no attempt is spent and the rows wait for the next sweep. Raised once per sweep with the count, never per row.
   */
  readonly onUndecryptable?: (detail: {
    readonly count: number;
    readonly errorClass: string;
  }) => void;
}

export const CLAIMMD_WEBHOOK_SWEEP_QUEUE = "claimmd-webhook-sweep";
export const CLAIMMD_SWEEP_BATCH = 100;
export const CLAIMMD_SWEEP_MAX_ATTEMPTS = 5;
/** Days after `received_at` that ANY receipt (settled or not) keeps its cipher, and an entitlement-blocked one waits, before it is cleared. */
export const CLAIMMD_PAYLOAD_RETENTION_DAYS = 90;
/** Days after `received_at` a receipt that stays undecryptable / under another key id is retried before it goes terminal `failed`. */
export const CLAIMMD_KEY_FAULT_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;
/** How often an `awaiting_entitlement` row is re-checked against the Billing add-on. */
export const CLAIMMD_ENTITLEMENT_RECHECK_MINUTES = 60;

const VENDOR = "claimmd";
const WORD_RE = /^[a-z][a-z0-9_]{0,31}$/;
const NPI_RE = /^\d{10}$/;
const ENROLL_TYPES = new Set(["era", "1500", "500", "ub", "elig", "attach"]);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
// Printable values only: a NUL or control character would fail the row's write on every attempt.
export const vendorText = (v: unknown, max = 64): string | null => {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== "string" || s.length > max) return null;
  const t = s.trim();
  return t.length > 0 && !/\p{Cc}/u.test(t) ? t : null;
};
const text = vendorText;

// What a tenant receives from the vendor is id/code- or timestamp-shaped (CW-AC-05B), never free text: anything else is null.
const CODE_RE = /^[A-Za-z0-9._-]+$/;
/** The documented Claim.MD shapes, `2022-09-01 11:34:59am` and `09-06-2022 13:07`. */
const TIME_RE = /^\d{2,4}-\d{2}-\d{2,4}[ T]\d{2}:\d{2}(?::\d{2})?(?:[ap]m)?$/i;
export const vendorCode = (v: unknown, max = 64): string | null => {
  const t = vendorText(v, max);
  return t !== null && CODE_RE.test(t) ? t : null;
};
export const vendorTime = (v: unknown): string | null => {
  const t = vendorText(v, 32);
  return t !== null && TIME_RE.test(t) ? t : null;
};

/** ONE vendor status word, lower-case, bounded; anything else is `unrecognized` (never the vendor's text). */
export function vendorStatusWord(v: unknown): string {
  const w =
    typeof v === "string"
      ? v
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, "_")
      : "";
  return WORD_RE.test(w) ? w : "unrecognized";
}

interface PendingRow {
  readonly usage: string;
  readonly acct_number: string;
  readonly event_id: string;
  readonly event_type: string | null;
  readonly payload_cipher: string;
  readonly payload_key_ref: string | null;
  readonly payload_sha256: string;
  readonly received_at: Date;
}

type KeyFault = {
  readonly outcome: "payload_undecryptable" | "payload_key_mismatch";
  readonly errorClass: string;
};

type Settlement =
  | { readonly outcome: "unsupported_type" | "unroutable_npi" | "unroutable_claim" | "malformed" }
  | { readonly outcome: "awaiting_entitlement"; readonly org: string; readonly pe: string }
  | { readonly outcome: "published"; readonly org: string; readonly pe: string }
  | { readonly outcome: "entitlement_unavailable"; readonly org: string; readonly pe: string }
  | KeyFault;

const isKeyFault = (s: Settlement): s is KeyFault =>
  s.outcome === "payload_undecryptable" || s.outcome === "payload_key_mismatch";

interface Route {
  readonly org: string;
  readonly pe: string;
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
}

async function one<T>(tx: DbClient, query: ReturnType<typeof sql>): Promise<T | undefined> {
  const res = (await tx.execute(query)) as unknown as { rows: T[] };
  return res.rows[0];
}

async function routeOf(
  tx: DbClient,
  row: PendingRow,
  element: Json,
  reportedAt: string,
): Promise<Route | Settlement> {
  const data = obj(element.event_data);
  const sourceEventKey = `${row.usage}:${row.acct_number}:${row.event_id}`;
  const base = {
    sourceEventKey,
    usage: row.usage,
    vendor: VENDOR,
    reportedAt,
    eventTime: vendorTime(element.event_time),
  };
  if (row.event_type === "enroll") {
    const e = obj(data.enroll);
    const npi = text(e.prov_npi, 10);
    if (!npi || !NPI_RE.test(npi)) return { outcome: "unroutable_npi" };
    const pe = await providerEntityByNpi(tx, npi);
    // A tenant can register any valid NPI, so only a platform-verified one routes (ADR-0053 amendment precondition 2).
    if (!pe || !(await isNpiVerified(tx, pe.id, npi))) return { outcome: "unroutable_npi" };
    const enrollType = text(e.enroll_type, 16)?.toLowerCase() ?? null;
    return {
      org: pe.organizationId,
      pe: pe.id,
      eventName: "m23.clearinghouse.enrollment_reported",
      payload: {
        ...base,
        providerEntityId: pe.id,
        vendorEnrollId: vendorCode(e.enrollid),
        enrollType: enrollType && ENROLL_TYPES.has(enrollType) ? enrollType : "unrecognized",
        vendorStatus: vendorStatusWord(e.event),
        clearinghousePayerId: vendorCode(e.payerid, 32),
      },
    };
  }
  if (row.event_type === "appeal") {
    const a = obj(data.appeal);
    const controlNumber = vendorCode(a.remote_claimid);
    if (!controlNumber) return { outcome: "unroutable_claim" };
    const attempt = await one<{ organization_id: string; provider_entity_id: string }>(
      tx,
      sql`SELECT organization_id, provider_entity_id FROM clearinghouse_submission_attempt
          WHERE usage = ${row.usage} AND control_number = ${controlNumber} AND status NOT IN ('released', 'voided')`,
    );
    if (!attempt) return { outcome: "unroutable_claim" };
    return {
      org: attempt.organization_id,
      pe: attempt.provider_entity_id,
      eventName: "m23.clearinghouse.appeal_reported",
      payload: {
        ...base,
        providerEntityId: attempt.provider_entity_id,
        controlNumber,
        vendorAppealId: vendorCode(a.appealid),
        vendorStatus: vendorStatusWord(a.event),
        appealType: vendorStatusWord(a.appeal_type),
      },
    };
  }
  return { outcome: "unsupported_type" };
}

async function settle(deps: ClaimMdSweepDeps, tx: DbClient, row: PendingRow): Promise<Settlement> {
  // Sealed under another key id than the one this process holds: refuse before any decrypt (it cannot succeed, and a
  // rotated key must not be tried against old rows). Distinct from a cipher that fails to open under the right id.
  if (row.payload_key_ref !== deps.cipher.keyId) {
    return { outcome: "payload_key_mismatch", errorClass: "PayloadKeyMismatch" };
  }
  let element: Json;
  try {
    const plaintext = deps.cipher.decrypt(row.payload_cipher);
    // The digest stored at receipt binds this ciphertext to this row: one moved from another row is refused.
    if (createHash("sha256").update(plaintext).digest("hex") !== row.payload_sha256) {
      throw Object.assign(new Error("payload digest mismatch"), { name: "PayloadDigestMismatch" });
    }
    element = obj(JSON.parse(plaintext));
  } catch (err) {
    // A cipher we cannot open is a key/config fault, not a bad row: spending attempts would fail every pending receipt
    // for good within five sweeps of a wrong key. Leave the row for the next sweep (like entitlement_unavailable).
    return { outcome: "payload_undecryptable", errorClass: (err as Error).name };
  }
  const route = await routeOf(tx, row, element, row.received_at.toISOString());
  if ("outcome" in route) return route;
  let entitled: boolean;
  try {
    entitled = await deps.entitlement.isEntitled(route.org);
  } catch {
    return { outcome: "entitlement_unavailable", org: route.org, pe: route.pe };
  }
  if (!entitled) return { outcome: "awaiting_entitlement", org: route.org, pe: route.pe };
  await deps.outbox.publish(tx, {
    eventName: route.eventName,
    payload: route.payload,
    organizationId: route.org,
    aggregateKind: "clearinghouse_report",
    aggregateId: route.pe,
  });
  return { outcome: "published", org: route.org, pe: route.pe };
}

const keyOf = (row: PendingRow) =>
  sql`usage = ${row.usage} AND acct_number = ${row.acct_number} AND event_id = ${row.event_id}`;

/**
 * A key fault spends no attempt (a wrong key must not fail every pending receipt in five sweeps), but it is not retried
 * for ever either: once the row is CLAIMMD_KEY_FAULT_GRACE_DAYS old it goes terminal `failed`. Returns the outcome the
 * sweep reports: the fault itself while it is still being retried, `failed` once it is terminal.
 */
async function recordKeyFault(
  tx: DbClient,
  row: PendingRow,
  fault: KeyFault,
  now: Date,
): Promise<string> {
  const aged = now.getTime() - row.received_at.getTime() >= CLAIMMD_KEY_FAULT_GRACE_DAYS * DAY_MS;
  if (!aged) {
    await tx.execute(
      sql`UPDATE claimmd_webhook_event SET last_error_class = ${fault.outcome} WHERE ${keyOf(row)}`,
    );
    return fault.outcome;
  }
  await tx.execute(sql`UPDATE claimmd_webhook_event SET processing_outcome = 'failed', processed_at = ${now},
    last_error_class = ${fault.outcome} WHERE ${keyOf(row)}`);
  return "failed";
}

/** Writes the settlement; resolves the outcome the sweep reports for the row. */
async function record(tx: DbClient, row: PendingRow, s: Settlement, now: Date): Promise<string> {
  const org = "org" in s ? s.org : null;
  const pe = "pe" in s ? s.pe : null;
  if (isKeyFault(s)) return recordKeyFault(tx, row, s, now);
  if (s.outcome === "entitlement_unavailable") {
    await tx.execute(sql`UPDATE claimmd_webhook_event SET derived_organization_id = ${org},
      derived_provider_entity_id = ${pe}, last_error_class = 'entitlement_unavailable' WHERE ${keyOf(row)}`);
    return s.outcome;
  }
  if (s.outcome === "awaiting_entitlement") {
    await tx.execute(sql`UPDATE claimmd_webhook_event SET derived_organization_id = ${org},
      derived_provider_entity_id = ${pe}, processing_outcome = 'awaiting_entitlement', entitlement_checked_at = ${now},
      last_error_class = NULL WHERE ${keyOf(row)}`);
    return s.outcome;
  }
  await tx.execute(sql`UPDATE claimmd_webhook_event SET derived_organization_id = ${org},
    derived_provider_entity_id = ${pe}, processing_outcome = ${s.outcome}, processed_at = ${now},
    attempt_count = attempt_count + 1, last_error_class = NULL WHERE ${keyOf(row)}`);
  return s.outcome;
}

/** Count a failed attempt. Returns the error class when this attempt made the row terminal `failed`, else null. */
async function recordFailure(
  tx: DbClient,
  row: PendingRow,
  err: unknown,
  now: Date,
): Promise<string | null> {
  const errorClass = String(
    (err as { errorClass?: unknown }).errorClass ?? (err as Error)?.name ?? "Error",
  ).slice(0, 64);
  const res = (await tx.execute(sql`
    UPDATE claimmd_webhook_event SET attempt_count = attempt_count + 1, last_error_class = ${errorClass},
      processing_outcome = CASE WHEN attempt_count + 1 >= ${CLAIMMD_SWEEP_MAX_ATTEMPTS} THEN 'failed' ELSE processing_outcome END,
      processed_at = CASE WHEN attempt_count + 1 >= ${CLAIMMD_SWEEP_MAX_ATTEMPTS} THEN ${now}::timestamptz ELSE NULL END
    WHERE ${keyOf(row)} RETURNING processing_outcome`)) as unknown as {
    rows: { processing_outcome: string | null }[];
  };
  return res.rows[0]?.processing_outcome === "failed" ? errorClass : null;
}

/**
 * Past the retention window (CLAIMMD_PAYLOAD_RETENTION_DAYS after `received_at`), for EVERY receipt, processed or not:
 * close out an entitlement wait, fail a row that never settled (a key fault or an entitlement read that never
 * recovered; alerted, because Claim.MD will not resend), then clear the cipher. The cipher is never kept longer for
 * being unprocessed: a stuck row must not hold PHI-bearing ciphertext indefinitely.
 */
async function applyRetention(deps: ClaimMdSweepDeps, tx: DbClient, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - CLAIMMD_PAYLOAD_RETENTION_DAYS * DAY_MS);
  await tx.execute(sql`
    UPDATE claimmd_webhook_event SET processing_outcome = 'expired_not_entitled', processed_at = ${now}
    WHERE processing_outcome = 'awaiting_entitlement' AND processed_at IS NULL AND received_at < ${cutoff}`);
  const unsettled = (await tx.execute(sql`
    UPDATE claimmd_webhook_event SET processing_outcome = 'failed', processed_at = ${now}
    WHERE processing_outcome IS NULL AND processed_at IS NULL AND received_at < ${cutoff}
    RETURNING usage, event_id, attempt_count, last_error_class`)) as unknown as {
    rows: {
      usage: string;
      event_id: string;
      attempt_count: number;
      last_error_class: string | null;
    }[];
  };
  for (const r of unsettled.rows) {
    deps.onFailed?.({
      usage: r.usage,
      eventId: r.event_id,
      attempts: r.attempt_count,
      errorClass: r.last_error_class ?? "unsettled",
    });
  }
  // ponytail: no index on received_at for this scan; the set that still holds a cipher is at most the retention window.
  await tx.execute(sql`
    UPDATE claimmd_webhook_event SET payload_cipher = NULL, payload_key_ref = NULL, payload_cleared_at = ${now}
    WHERE payload_cipher IS NOT NULL AND received_at < ${cutoff}`);
}

export interface ClaimMdSweepResult {
  readonly seen: number;
  readonly outcomes: Readonly<Record<string, number>>;
}

/** One sweep. Never throws for one row's failure; a row failing 5 times is terminal `failed` and raises `onFailed`. */
export async function runClaimMdWebhookSweep(deps: ClaimMdSweepDeps): Promise<ClaimMdSweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const recheckBefore = new Date(now.getTime() - CLAIMMD_ENTITLEMENT_RECHECK_MINUTES * 60_000);
  return deps.runner(async (tx) => {
    await applyRetention(deps, tx, now);
    // Fresh receipts first: a row that already failed (a key fault, an entitlement read error) sorts after every row that
    // has not, so a backlog of unreadable receipts can never fill the batch and starve new ones.
    const pending = (
      (await tx.execute(sql`
        SELECT usage, acct_number, event_id, event_type, payload_cipher, payload_key_ref, payload_sha256, received_at
        FROM claimmd_webhook_event
        WHERE processed_at IS NULL AND payload_cipher IS NOT NULL
          AND (processing_outcome IS NULL
            OR (processing_outcome = 'awaiting_entitlement' AND entitlement_checked_at < ${recheckBefore}))
        ORDER BY (last_error_class IS NOT NULL), received_at
        LIMIT ${CLAIMMD_SWEEP_BATCH}
        FOR UPDATE SKIP LOCKED`)) as unknown as { rows: PendingRow[] }
    ).rows.map((r) => ({ ...r, received_at: new Date(r.received_at) }));
    const outcomes: Record<string, number> = {};
    let undecryptableClass = "";
    for (const row of pending) {
      let outcome: string;
      try {
        // A savepoint per row: one row's failure (a bad publish, a constraint) rolls back only that row's work.
        const { settled, reported } = await tx.transaction(async (sp) => {
          const settledRow = await settle(deps, sp as unknown as DbClient, row);
          const final = await record(sp as unknown as DbClient, row, settledRow, now);
          return { settled: settledRow, reported: final };
        });
        outcome = reported;
        if (isKeyFault(settled)) {
          undecryptableClass = settled.errorClass;
          // Out of grace: terminal `failed`. No attempt was spent on it, and Claim.MD will not resend: alert it by id.
          if (reported === "failed") {
            deps.onFailed?.({
              usage: row.usage,
              eventId: row.event_id,
              attempts: 0,
              errorClass: settled.outcome,
            });
          }
        }
      } catch (err) {
        const failedClass = await recordFailure(tx, row, err, now);
        outcome = failedClass === null ? "retry" : "failed";
        if (failedClass !== null) {
          deps.onFailed?.({
            usage: row.usage,
            eventId: row.event_id,
            attempts: CLAIMMD_SWEEP_MAX_ATTEMPTS,
            errorClass: failedClass,
          });
        }
      }
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if (outcome !== "published") {
        deps.log?.("claimmd.webhook.settled", { usage: row.usage, eventId: row.event_id, outcome });
      }
    }
    const undecryptable =
      (outcomes.payload_undecryptable ?? 0) + (outcomes.payload_key_mismatch ?? 0);
    if (undecryptable > 0) {
      deps.onUndecryptable?.({ count: undecryptable, errorClass: undecryptableClass });
    }
    return { seen: pending.length, outcomes };
  });
}

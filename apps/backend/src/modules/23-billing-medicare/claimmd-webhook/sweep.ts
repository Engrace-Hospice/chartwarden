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
// as it was for the next sweep, and so does a payload the sweep cannot decrypt (a key fault; one ops alert per sweep).
// Entitled → one PHI-free `m23.clearinghouse.*_reported` event in the SAME transaction
// that marks the row `published`, so a row is published at most once.
//
// The decrypted element (which can hold a provider TIN, possibly an SSN, and untrusted vendor text) never leaves this
// file: payloads carry ids, the control number, enroll_type and ONE bounded vendor status word.
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
/** Days a settled receipt keeps its cipher, and an entitlement-blocked receipt waits, before it is cleared. */
export const CLAIMMD_PAYLOAD_RETENTION_DAYS = 90;
/** How often an `awaiting_entitlement` row is re-checked against the Billing add-on. */
export const CLAIMMD_ENTITLEMENT_RECHECK_MINUTES = 60;

const VENDOR = "claimmd";
const WORD_RE = /^[a-z][a-z0-9_]{0,31}$/;
const NPI_RE = /^\d{10}$/;
const ENROLL_TYPES = new Set(["era", "1500", "500", "ub", "elig", "attach"]);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
const text = (v: unknown, max = 64): string | null => {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  return typeof s === "string" && s.trim().length > 0 && s.length <= max ? s.trim() : null;
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
  readonly received_at: Date;
}

type Settlement =
  | { readonly outcome: "unsupported_type" | "unroutable_npi" | "unroutable_claim" | "malformed" }
  | { readonly outcome: "awaiting_entitlement"; readonly org: string; readonly pe: string }
  | { readonly outcome: "published"; readonly org: string; readonly pe: string }
  | { readonly outcome: "entitlement_unavailable"; readonly org: string; readonly pe: string }
  | { readonly outcome: "payload_undecryptable"; readonly errorClass: string };

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
    eventTime: text(element.event_time),
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
        vendorEnrollId: text(e.enrollid),
        enrollType: enrollType && ENROLL_TYPES.has(enrollType) ? enrollType : "unrecognized",
        vendorStatus: vendorStatusWord(e.event),
        clearinghousePayerId: text(e.payerid, 32),
      },
    };
  }
  if (row.event_type === "appeal") {
    const a = obj(data.appeal);
    const controlNumber = text(a.remote_claimid);
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
        vendorAppealId: text(a.appealid),
        vendorStatus: vendorStatusWord(a.event),
        appealType: vendorStatusWord(a.appeal_type),
      },
    };
  }
  return { outcome: "unsupported_type" };
}

async function settle(deps: ClaimMdSweepDeps, tx: DbClient, row: PendingRow): Promise<Settlement> {
  let element: Json;
  try {
    element = obj(JSON.parse(deps.cipher.decrypt(row.payload_cipher)));
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

async function record(tx: DbClient, row: PendingRow, s: Settlement, now: Date): Promise<void> {
  const org = "org" in s ? s.org : null;
  const pe = "pe" in s ? s.pe : null;
  if (s.outcome === "payload_undecryptable") {
    await tx.execute(
      sql`UPDATE claimmd_webhook_event SET last_error_class = 'payload_undecryptable' WHERE ${keyOf(row)}`,
    );
    return;
  }
  if (s.outcome === "entitlement_unavailable") {
    await tx.execute(sql`UPDATE claimmd_webhook_event SET derived_organization_id = ${org},
      derived_provider_entity_id = ${pe}, last_error_class = 'entitlement_unavailable' WHERE ${keyOf(row)}`);
    return;
  }
  if (s.outcome === "awaiting_entitlement") {
    await tx.execute(sql`UPDATE claimmd_webhook_event SET derived_organization_id = ${org},
      derived_provider_entity_id = ${pe}, processing_outcome = 'awaiting_entitlement', entitlement_checked_at = ${now},
      last_error_class = NULL WHERE ${keyOf(row)}`);
    return;
  }
  await tx.execute(sql`UPDATE claimmd_webhook_event SET derived_organization_id = ${org},
    derived_provider_entity_id = ${pe}, processing_outcome = ${s.outcome}, processed_at = ${now},
    attempt_count = attempt_count + 1, last_error_class = NULL WHERE ${keyOf(row)}`);
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

/** Clear expired ciphers (terminal rows) and close out entitlement waits past the retention window. */
async function applyRetention(tx: DbClient, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - CLAIMMD_PAYLOAD_RETENTION_DAYS * 86_400_000);
  await tx.execute(sql`
    UPDATE claimmd_webhook_event SET processing_outcome = 'expired_not_entitled', processed_at = ${now}
    WHERE processing_outcome = 'awaiting_entitlement' AND processed_at IS NULL AND received_at < ${cutoff}`);
  await tx.execute(sql`
    UPDATE claimmd_webhook_event SET payload_cipher = NULL, payload_key_ref = NULL, payload_cleared_at = ${now}
    WHERE payload_cipher IS NOT NULL AND processed_at IS NOT NULL
      AND (processed_at < ${cutoff} OR processing_outcome = 'expired_not_entitled')`);
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
    await applyRetention(tx, now);
    const pending = (
      (await tx.execute(sql`
        SELECT usage, acct_number, event_id, event_type, payload_cipher, received_at
        FROM claimmd_webhook_event
        WHERE processed_at IS NULL AND payload_cipher IS NOT NULL
          AND (processing_outcome IS NULL
            OR (processing_outcome = 'awaiting_entitlement' AND entitlement_checked_at < ${recheckBefore}))
        ORDER BY received_at
        LIMIT ${CLAIMMD_SWEEP_BATCH}
        FOR UPDATE SKIP LOCKED`)) as unknown as { rows: PendingRow[] }
    ).rows.map((r) => ({ ...r, received_at: new Date(r.received_at) }));
    const outcomes: Record<string, number> = {};
    let undecryptableClass = "";
    for (const row of pending) {
      let outcome: string;
      try {
        // A savepoint per row: one row's failure (a bad publish, a constraint) rolls back only that row's work.
        const s = await tx.transaction(async (sp) => {
          const settled = await settle(deps, sp as unknown as DbClient, row);
          await record(sp as unknown as DbClient, row, settled, now);
          return settled;
        });
        outcome = s.outcome;
        if (s.outcome === "payload_undecryptable") undecryptableClass = s.errorClass;
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
    const undecryptable = outcomes.payload_undecryptable ?? 0;
    if (undecryptable > 0) {
      deps.onUndecryptable?.({ count: undecryptable, errorClass: undecryptableClass });
    }
    return { seen: pending.length, outcomes };
  });
}

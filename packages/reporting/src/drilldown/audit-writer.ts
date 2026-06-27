// @wardenx/reporting · drilldown — the drilldown-audit writer (M33 §3.3 / §3.6 / §4.10 / W-R-05 / D16).
//
// Step 3 of the drilldown emit: record the navigation in `report_drilldown_audit` (insert-only, retention class
// `compliance`) and emit the `m33.drilldown.*` outbox event. The audit row's `query_filters_cipher` carries the
// navigation's filter context, which can re-identify a patient, so it is ENVELOPE-ENCRYPTED under the per-tenant
// DEK before it is stored (§3.6 — the column is also denylisted in the M4 write-audit trigger). The row records
// the consent-narrowing posture (`is_consent_narrowed` / `consent_narrowing_reason`) decided upstream; the
// emitted event is warn-level when narrowed so M36 fans the `drilldownConsentNarrowed` alert to compliance.
//
// ★ FAIL-CLOSED (the load-bearing invariant). When the injected per-tenant DEK port is UNAVAILABLE — unbound at
//   boot (a fail-closed thunk), down, or it raises any error — this handler THROWS {@link DrilldownDekUnavailable}
//   and writes NOTHING. It NEVER falls back to storing the filter context in plaintext: a drilldown whose
//   navigation context cannot be encrypted is DENIED rather than persisted un-protected.
//
// PURE row build + thin async shell (the insert-only `ReportDrilldownAuditRepository` precedent): the row build
// is a total pure function; the writer resolves the DEK encrypt port (fail-closed on error), appends via an
// injected write port, and emits via an injected outbox port. No clock/RNG/Drizzle/`getSeam` import — the
// trace-id, clock, encryption, append, and emit all arrive as ports (bound at P2C).
import type { schema } from "@wardenx/db";

/** The drilldown navigation outcome (§4.10 `m33.drilldown.{emitted,denied,target_unavailable}`). An audit row
 *  is written for ALL outcomes (W-R-05 records `denied` / `target_unavailable` too). */
export type DrilldownOutcome = "emitted" | "denied" | "target_unavailable";

/** Raised when the per-tenant DEK port is unavailable — the drilldown is DENIED rather than store plaintext
 *  filter context (fail-closed; §3.6). */
export class DrilldownDekUnavailable extends Error {
  constructor(reason: string) {
    super(`drilldown audit denied — per-tenant DEK unavailable, refusing to store plaintext filter context: ${reason}`);
    this.name = "DrilldownDekUnavailable";
  }
}

// ── injected ports ────────────────────────────────────────────────────────────────────────────────────────

/** Envelope-encrypts the drilldown filter context under the per-tenant DEK (§3.6). Bound at boot to the M1 DEK
 *  helper; a fail-closed thunk until then — any throw here denies the drilldown (never plaintext at rest). */
export interface DrilldownFilterEncryptionPort {
  encryptFilters(input: { readonly organizationId: string; readonly plaintext: string }): Promise<string>;
}

/** The insert-only write port over `report_drilldown_audit` (bound at boot to `ReportDrilldownAuditRepository.
 *  append` under `withOrgContext`). The table admits no UPDATE/DELETE, so this is the only mutating op. */
export interface DrilldownAuditAppendPort {
  append(row: schema.NewReportDrilldownAudit): Promise<void>;
}

/** The §4.10 `m33.drilldown.*` event payload (a projection — NO PHI; the cipher stays in the audit row). The
 *  boot adapter maps `outcome` → the wire `eventType` (`m33.drilldown.${outcome}`) and routes the warn-level
 *  `drilldownConsentNarrowed` alert when `isConsentNarrowed`. */
export interface DrilldownEmittedPayload {
  readonly drilldownTraceId: string;
  readonly organizationId: string;
  readonly actorMembershipId: string;
  readonly sourceTileKey: string;
  readonly drilldownTargetModule: number;
  readonly drilldownTargetSurface: string;
  readonly isConsentNarrowed: boolean;
  readonly consentNarrowingReason: string | null;
  readonly outcome: DrilldownOutcome;
}

/** The injected outbox port for the §4.10 drilldown event (the live transactional outbox; a thunk until P2C). */
export interface DrilldownAuditOutboxPort {
  emitDrilldown(payload: DrilldownEmittedPayload): Promise<void>;
}

/** The ports the audit writer composes over. */
export interface DrilldownAuditPorts {
  readonly encryption: DrilldownFilterEncryptionPort;
  readonly audit: DrilldownAuditAppendPort;
  readonly outbox: DrilldownAuditOutboxPort;
  /** Mint the `report_drilldown_audit` row id (the composite-PK `id`; injected — no RNG in the pure layer). */
  newRowId(): string;
  /** Mint the cross-module `drilldown_trace_id` (injected — no RNG in the pure layer). */
  newTraceId(): string;
  now(): Date;
}

// ── the request ───────────────────────────────────────────────────────────────────────────────────────────

/** One drilldown-audit write: the navigation identity, the filter context to encrypt, and the upstream-decided
 *  consent-narrowing posture + outcome. */
export interface DrilldownAuditInput {
  readonly organizationId: string;
  readonly actorMembershipId: string;
  /** The saved view the drilldown originated from, or null for an ad-hoc drilldown (the column is nullable). */
  readonly reportViewId: string | null;
  readonly sourceTileKey: string;
  /** The owner module the drilldown navigates into (e.g. `8` for M8's late-entry register). */
  readonly drilldownTargetModule: number;
  readonly drilldownTargetSurface: string;
  /** The navigation filter context (dimension/filter values, possibly patient identifiers) — encrypted at rest. */
  readonly queryFilters: unknown;
  readonly isConsentNarrowed: boolean;
  readonly consentNarrowingReason: string | null;
  /** Defaults to `emitted`; `denied` / `target_unavailable` still write an audit row (W-R-05). */
  readonly outcome?: DrilldownOutcome;
}

/**
 * Build the `report_drilldown_audit` insert row (PURE) from the resolved fields + the already-encrypted cipher +
 * the minted trace id + the clock instant. `accessed_at` is supplied (not DB-default) so the partition key is
 * deterministic for tests; `consent_narrowing_reason` is set only when narrowed.
 */
export function buildDrilldownAuditRow(
  input: DrilldownAuditInput,
  queryFiltersCipher: string,
  rowId: string,
  drilldownTraceId: string,
  accessedAt: Date,
): schema.NewReportDrilldownAudit {
  return {
    id: rowId,
    organizationId: input.organizationId,
    actorMembershipId: input.actorMembershipId,
    reportViewId: input.reportViewId,
    sourceTileKey: input.sourceTileKey,
    drilldownTargetModule: input.drilldownTargetModule,
    drilldownTargetSurface: input.drilldownTargetSurface,
    queryFiltersCipher,
    drilldownTraceId,
    isConsentNarrowed: input.isConsentNarrowed,
    consentNarrowingReason: input.isConsentNarrowed ? input.consentNarrowingReason : null,
    accessedAt,
  };
}

/** What one drilldown-audit write reported: the minted trace id (the cross-module join key) + the outcome. */
export interface DrilldownAuditResult {
  readonly drilldownTraceId: string;
  readonly outcome: DrilldownOutcome;
}

/**
 * Write one drilldown-audit row + emit the §4.10 event (W-R-05 steps 8–9). Envelope-encrypts the filter context
 * under the per-tenant DEK FIRST — if the DEK port is unavailable the write is DENIED ({@link DrilldownDekUnavailable})
 * and nothing is persisted (fail-closed; never plaintext at rest). On success appends the insert-only row (MUST
 * run under the tenant's `withOrgContext`, F09) and emits `m33.drilldown.${outcome}` (warn-level when narrowed so
 * M36 fans the compliance alert).
 *
 * @throws {DrilldownDekUnavailable} the per-tenant DEK could not encrypt the filter context (fail-closed deny)
 */
export async function writeDrilldownAudit(
  input: DrilldownAuditInput,
  ports: DrilldownAuditPorts,
): Promise<DrilldownAuditResult> {
  const plaintext = JSON.stringify(input.queryFilters ?? null);

  // ★ FAIL-CLOSED: encrypt BEFORE any write. A DEK failure denies the drilldown — never store plaintext (§3.6).
  let queryFiltersCipher: string;
  try {
    queryFiltersCipher = await ports.encryption.encryptFilters({
      organizationId: input.organizationId,
      plaintext,
    });
  } catch (err) {
    throw new DrilldownDekUnavailable(err instanceof Error ? err.message : String(err));
  }

  const outcome = input.outcome ?? "emitted";
  const drilldownTraceId = ports.newTraceId();
  const row = buildDrilldownAuditRow(input, queryFiltersCipher, ports.newRowId(), drilldownTraceId, ports.now());

  await ports.audit.append(row);
  await ports.outbox.emitDrilldown({
    drilldownTraceId,
    organizationId: input.organizationId,
    actorMembershipId: input.actorMembershipId,
    sourceTileKey: input.sourceTileKey,
    drilldownTargetModule: input.drilldownTargetModule,
    drilldownTargetSurface: input.drilldownTargetSurface,
    isConsentNarrowed: input.isConsentNarrowed,
    consentNarrowingReason: input.isConsentNarrowed ? input.consentNarrowingReason : null,
    outcome,
  });

  return { drilldownTraceId, outcome };
}

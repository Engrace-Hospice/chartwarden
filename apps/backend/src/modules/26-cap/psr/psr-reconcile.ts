// apps/backend/src/modules/26-cap/psr/psr-reconcile.ts — the M26 `cap:psr-reconcile` job body (§4.8, GAP-078).
// Reads the DEK-encrypted PS&R CSV back through the injected file store, strictly validates + parses it, diffs
// each figure against the M26 accrual ledger (beneficiary by normalized MBI · agency aggregate · inpatient
// days), persists the above-threshold variance lines as `cap_psr_reconciliation` rows, stamps the import
// `reconciled` / `parse_failed`, and emits `m26.cap.psr_variance_raised` on the same tx. Runs under
// withOrgContext (a worker is not a request). Lines + the `reconciled` stamp land in ONE tx, so a
// non-reconciled import never has lines: re-running a reconciled import is a no-op and re-running a
// `parse_failed` one (the operator re-trigger) cannot duplicate (the app role has no DELETE on the table).
// No PHI in the outbox payload, the parse_error column or the quarantine detail (line numbers + codes only).
// A malformed ROW is quarantined (excluded, counted, never zero-filled) and the import reconciles on the good
// rows; only a structural error, an all-bad file or >20% quarantined rows ends `parse_failed`.
import {
  ERASED_MBI_SENTINEL,
  type MacRegion,
  aggregatePsrRows,
  formatPsrRejection,
  parsePsrCsvStrict,
  quarantineEffect,
  reconcilePsr,
  reconcilePsrInpatientDays,
  summarizePsrQuarantine,
} from "@chartwarden/cap-management";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, ne } from "drizzle-orm";
import type { WriteOutboxPort } from "../routes/write-service";

/** The per-tenant DEK-encrypted raw-file store (MinIO in production; bound at the composition root). */
export interface PsrFileStorePort {
  put(organizationId: string, storageKey: string, bytes: Uint8Array): Promise<void>;
  get(organizationId: string, storageKey: string): Promise<Uint8Array>;
}

/** The `cap:psr-reconcile` producer (BullMQ in production; bound at the composition root). */
export interface PsrReconcileEnqueuePort {
  enqueue(job: { organizationId: string; importId: string }): Promise<void>;
}

export interface PsrReconcileDeps {
  readonly db: DbClient;
  readonly files: PsrFileStorePort;
  readonly outbox: WriteOutboxPort;
  /** Per-tenant variance threshold in cents (spec D9 default $50); a configurable column is not modelled. */
  readonly thresholdCents?: number;
}

export type PsrReconcileOutcome =
  | { readonly status: "missing" }
  | { readonly status: "already_reconciled" }
  | { readonly status: "parse_failed"; readonly parseError: string }
  | {
      readonly status: "reconciled";
      readonly rowsQuarantined: number;
      readonly lineCount: number;
      readonly totalVarianceCents: number;
    };

/** Reconcile one queued PS&R import. Throws on a transient failure (file-store read) so BullMQ retries. */
export async function reconcilePsrImport(
  deps: PsrReconcileDeps,
  organizationId: string,
  importId: string,
): Promise<PsrReconcileOutcome> {
  const PI = schema.capPsrImport;
  // A worker is not a request: the NULL system actor (audit attribution without a `user` FK).
  const actor = { organizationId, userId: "", systemActor: true, roles: [] };

  const head = await withOrgContext(deps.db, actor, async (tx) => {
    const rows = await tx.select().from(PI).where(eq(PI.id, importId)).limit(1);
    return rows[0] ?? null;
  });
  if (!head) return { status: "missing" };
  if (head.parseStatus === "reconciled") return { status: "already_reconciled" };

  const bytes = await deps.files.get(organizationId, head.fileStorageKey);
  const parsed = parsePsrCsvStrict(
    Buffer.from(bytes).toString("utf8"),
    head.macRegion as MacRegion,
  );

  return withOrgContext(deps.db, actor, async (tx) => {
    const locked = await tx.select().from(PI).where(eq(PI.id, importId)).for("update").limit(1);
    const row = locked[0];
    if (!row) return { status: "missing" } as const;
    if (row.parseStatus === "reconciled") return { status: "already_reconciled" } as const;

    const quarantine = summarizePsrQuarantine(parsed.quarantined);
    const quarantineCols =
      quarantine.rowsQuarantined > 0
        ? { rowsQuarantined: quarantine.rowsQuarantined, quarantineDetail: quarantine.detail }
        : { rowsQuarantined: null, quarantineDetail: null };

    if (parsed.issues.length > 0) {
      const parseError = formatPsrRejection(parsed);
      await tx
        .update(PI)
        .set({ parseStatus: "parse_failed", parseError, ...quarantineCols })
        .where(eq(PI.id, importId));
      return { status: "parse_failed", parseError } as const;
    }

    const psrRows = aggregatePsrRows(parsed.rows);
    const BA = schema.capBeneficiaryAccrual;
    const ledger = await tx
      .select({
        mbiNormalized: BA.mbiNormalized,
        patientId: BA.patientId,
        paidCents: BA.paidCents,
      })
      .from(BA)
      .where(and(eq(BA.capPeriodId, row.capPeriodId), ne(BA.mbiNormalized, ERASED_MBI_SENTINEL)));
    const IA = schema.capInpatientAccrual;
    const inpatient = await tx
      .select({ gip: IA.gipDays, irc: IA.ircDays })
      .from(IA)
      .where(eq(IA.capPeriodId, row.capPeriodId))
      .limit(1);

    const threshold = deps.thresholdCents;
    // Quarantined rows are never zero-filled into a variance: flagged beneficiaries are excluded from both
    // sides; unreadable-MBI rows suppress the lines they could explain (see PsrQuarantineEffect).
    const effect = quarantineEffect(parsed.quarantined);
    const lines = reconcilePsr(ledger, psrRows, threshold, effect).filter((l) => l.aboveThreshold);
    const psrDays = psrRows.reduce((n, r) => n + r.inpatientDays, 0);
    const m26Days = (inpatient[0]?.gip ?? 0) + (inpatient[0]?.irc ?? 0);
    // A quarantined row's days are missing from the PS&R total, so the agency day diff would be false.
    const dayLine =
      parsed.hasInpatientDays && quarantine.rowsQuarantined === 0
        ? reconcilePsrInpatientDays(m26Days, psrDays)
        : null;
    const paidTotal = psrRows.reduce((n, r) => n + r.paidCents, 0);

    const PR = schema.capPsrReconciliation;
    const values = [
      ...lines.map((l) => ({
        organizationId,
        capPeriodId: row.capPeriodId,
        psrImportId: importId,
        scope: l.scope,
        patientId: l.patientId,
        m26AccrualCents: l.m26AccrualCents,
        psrAmountCents: l.psrAmountCents,
        varianceCents: l.varianceCents,
        varianceReason: l.varianceReason,
      })),
      ...(dayLine
        ? [
            {
              organizationId,
              capPeriodId: row.capPeriodId,
              psrImportId: importId,
              scope: "inpatient" as const,
              patientId: null,
              m26InpatientDays: dayLine.m26InpatientDays,
              psrInpatientDays: dayLine.psrInpatientDays,
              varianceDays: dayLine.varianceDays,
              varianceReason: "unknown" as const,
            },
          ]
        : []),
    ];
    if (values.length > 0) await tx.insert(PR).values(values);

    await tx
      .update(PI)
      .set({
        parseStatus: "reconciled",
        parseError: null,
        beneficiaryCountPsr: psrRows.length,
        paidTotalCentsPsr: paidTotal,
        inpatientDaysPsr: parsed.hasInpatientDays ? psrDays : null,
        ...quarantineCols,
      })
      .where(eq(PI.id, importId));

    // totalVarianceCents = Σ |variance| over the raised beneficiary lines (the agency-aggregate line nets
    // offsetting beneficiary variances to ~0, which would hide a real discrepancy).
    const totalVarianceCents = lines
      .filter((l) => l.scope === "beneficiary")
      .reduce((n, l) => n + Math.abs(l.varianceCents), 0);
    if (values.length > 0) {
      await deps.outbox.publish(tx, {
        eventName: "m26.cap.psr_variance_raised",
        organizationId,
        aggregateKind: "cap_psr_import",
        aggregateId: importId,
        payload: {
          organizationId,
          capPeriodId: row.capPeriodId,
          importId,
          totalVarianceCents,
          lineCount: values.length,
        },
      });
    }
    return {
      status: "reconciled",
      rowsQuarantined: quarantine.rowsQuarantined,
      lineCount: values.length,
      totalVarianceCents,
    } as const;
  });
}

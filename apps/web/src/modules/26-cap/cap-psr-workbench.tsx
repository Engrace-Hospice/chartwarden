import { EmptyState, PageHeader, WorkQueueLayout } from "@wardenx/ui";
// apps/web/src/modules/26-cap — M26, the PS&R RECONCILIATION WORKBENCH (R2, §5.1.5). The reimbursement
// specialist's surface: upload the quarterly CMS PS&R CSV, then reconcile the per-beneficiary variance lines
// (M26 ledger vs the MAC figure) above the per-tenant threshold (default $50). Phase 1 is upload-driven — the
// import is created via POST /api/v1/cap/periods/:id/psr-imports and the per-import variance view drills in at
// /api/v1/cap/psr-imports/:importId/reconciliation (server-authoritative, gated on cap.psr.read/reconcile).
// This nav surface gates visibility only (ADR-0030); the upload + per-line resolution land on the import view.
import type { JSX } from "react";

export function CapPsrWorkbench(): JSX.Element {
  return (
    <WorkQueueLayout
      header={<PageHeader title="PS&R Reconciliation" breadcrumb="Revenue Cycle — MAC reconciliation" />}
      table={
        <EmptyState
          title="Upload a PS&R extract to reconcile"
          description={
            "Upload the quarterly CMS PS&R cap-year CSV for the open cap period. WardenX parses it, diffs each " +
            "figure against the running accrual ledger, and routes any variance above the per-tenant threshold " +
            "(default $50) to this workbench with a categorical reason for investigation. Variances trace to the " +
            "835-derived remittance line that posted them."
          }
        />
      }
    />
  );
}

import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/13-emar — reconciliation worksheet (M13 §4.1/§6.1 #6, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Detail" (reconciliation worksheet).
// Read-only per-line view of an admission/transfer/discharge/recert worksheet: the trigger, the line count, and
// the per-line decisions (carry_forward / discontinue / hold / new_order / document_only). The decision picker,
// the "Send to prescriber" M12-draft mint, the add-caregiver-reported-line form, and the Finalize CTA (disabled
// until every line has a decision + back-linked M12 order) fill in as their write surfaces harden; the SERVER
// owns the §2.8 D17 finalize handshake (ADR-0030). Reads GET /api/v1/reconciliation/worksheets/:id via the
// typed client. Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { DECISION_TONE, WORKSHEET_TONE, stateLabel } from "./emar-status";

interface DecisionView {
  lineId: string;
  lineKind: string;
  sourceId: string;
  decision: string;
}
interface WorksheetView {
  id: string;
  patientId: string;
  admissionId: string;
  triggerKind: string;
  status: string;
  lineCount: number;
  decisions: DecisionView[];
}

export function ReconciliationWorksheet(): JSX.Element {
  const client = useApiClient();
  const { worksheetId } = useParams<{ worksheetId: string }>();
  const [row, setRow] = useState<WorksheetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!worksheetId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/reconciliation/worksheets/{id}", {
        params: { path: { id: worksheetId } },
      });
      if (!active) return;
      if (err) {
        setError("Could not load the reconciliation worksheet.");
        setLoading(false);
        return;
      }
      setRow(data as WorksheetView);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, worksheetId]);

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Medication Reconciliation"
          actions={
            row ? (
              <StatusPill
                label={stateLabel(row.status)}
                tone={WORKSHEET_TONE[row.status] ?? "neutral"}
              />
            ) : undefined
          }
        >
          {row ? (
            <span style={meta}>
              {stateLabel(row.triggerKind)} ·{" "}
              <span className="tabular-nums">
                {row.decisions.length}/{row.lineCount}
              </span>{" "}
              decided
            </span>
          ) : null}
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : row.lineCount === 0 ? (
        <EmptyState title="No lines" description="This worksheet has no reconciliation lines." />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Line</th>
              <th>Source kind</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {row.decisions.map((d) => (
              <tr key={d.lineId}>
                <td className="wx-data-md">{d.sourceId.slice(0, 8)}</td>
                <td>{stateLabel(d.lineKind)}</td>
                <td>
                  <StatusPill
                    label={stateLabel(d.decision)}
                    tone={DECISION_TONE[d.decision] ?? "neutral"}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailPageLayout>
  );
}

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;

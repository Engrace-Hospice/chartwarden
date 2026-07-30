import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the ACKNOWLEDGMENTS TIMELINE (R2, §5.1 #9). Every ack
// received against this claim's submissions: kind (999 / 277CA / state-specific), outcome, the payer's own
// claim control number, the accepted/rejected line numbers, and the payer error codes. A PARTIAL ack is the
// signal that puts the claim on the validation worklist — the rejected line numbers here are the biller's
// starting point. Backed by GET /api/v1/medicaid-claims/{id}/acknowledgments. Lantern: WorkQueueLayout +
// No-Line table (§6.7) + §6.6 StatusPill; mono identifiers; CSS-var tokens only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { ACK_OUTCOME_TONE, ackKindLabel, humanize, toneOf } from "./medicaid-status";
import {
  linkStyle,
  mutedStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  th,
} from "./medicaid-ui";

interface Acknowledgment {
  id: string;
  medicaidSubmissionId: string;
  kind: string;
  outcome: string;
  payerClaimControlNumber: string | null;
  acceptedLineNumbers: unknown;
  rejectedLineNumbers: unknown;
  errorCodes: unknown;
  receivedAt: string;
}

/** The wire carries these as jsonb; render defensively rather than trusting the shape. */
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
}

export function MedicaidAcknowledgmentsTimeline(): JSX.Element {
  const client = useApiClient();
  const { claimId } = useParams<{ claimId: string }>();
  const [rows, setRows] = useState<Acknowledgment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!claimId) return;
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/medicaid-claims/{id}/acknowledgments", {
      params: { path: { id: claimId } },
    });
    if (res.error) {
      setError("The acknowledgment history is unavailable — you may lack billing visibility for this claim.");
      setLoading(false);
      return;
    }
    setRows((res.data as unknown as Acknowledgment[]) ?? []);
    setLoading(false);
  }, [client, claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!claimId) return <EmptyState title="No claim" description="No claim was specified." />;
  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const ordered = [...rows].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Acknowledgments"
          breadcrumb="Billing — Medicaid · payer acknowledgments"
          actions={
            <a href={`/medicaid/billing/claims/${claimId}`} style={linkStyle}>
              ← Back to claim
            </a>
          }
        />
      }
      table={
        ordered.length === 0 ? (
          <EmptyState
            title="No acknowledgments"
            description="No acknowledgment has been received for this claim's submissions."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Received</th>
                <th style={th}>Kind</th>
                <th style={th}>Outcome</th>
                <th style={th}>Payer control #</th>
                <th style={th}>Accepted lines</th>
                <th style={th}>Rejected lines</th>
                <th style={th}>Error codes</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((a) => {
                const accepted = asList(a.acceptedLineNumbers);
                const rejected = asList(a.rejectedLineNumbers);
                const codes = asList(a.errorCodes);
                return (
                  <tr key={a.id} style={rowLine}>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                      {a.receivedAt.slice(0, 16).replace("T", " ")}
                    </td>
                    <td style={td}>{ackKindLabel(a.kind)}</td>
                    <td style={td}>
                      <StatusPill
                        label={humanize(a.outcome)}
                        tone={toneOf(ACK_OUTCOME_TONE, a.outcome)}
                      />
                    </td>
                    <td style={tdMono}>{a.payerClaimControlNumber ?? "—"}</td>
                    <td style={{ ...tdMono, fontVariantNumeric: "tabular-nums" }}>
                      {accepted.length > 0 ? accepted.join(", ") : "—"}
                    </td>
                    <td style={{ ...tdMono, fontVariantNumeric: "tabular-nums" }}>
                      {rejected.length > 0 ? rejected.join(", ") : "—"}
                    </td>
                    <td style={tdMono}>{codes.length > 0 ? codes.join(" · ") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      }
      detail={
        <span style={mutedStyle}>
          A partial acknowledgment moves the claim onto the validation worklist — start from the rejected
          line numbers and the payer error codes.
        </span>
      }
    />
  );
}

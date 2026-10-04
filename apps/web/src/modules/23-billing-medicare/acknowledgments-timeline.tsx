import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the ACKNOWLEDGMENTS TIMELINE (R2,
// §5.1 #9). All `claim_acknowledgment` rows for one claim — 999 / 277CA / 835 — each with its MAC
// jurisdiction, receipt/parse timestamps, outcome (§6.6 pill), and an expandable parsed-payload viewer.
// Per §8.7 the parsed payload carries X12 status/reason codes only — NEVER PHI/MBI — so it renders inline
// as a code block. Reads GET /api/v1/billing/claims/:id/acknowledgments (read-only). The server is the only
// authz point (ADR-0030) — a 404/503/403 degrades the surface. Lantern: DetailPageLayout + No-Line table
// (§6.7), mono identifiers (MAC, ack id), tabular-nums, CSS-var tokens only; tones flow through
// billing-status.ts (§6.6). NOTE: the openapi marks the body as `never`, so the result payload is cast.
import { Fragment, useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { ackOutcomeTone, statusLabel } from "./billing-status";

interface ClaimAcknowledgment {
  acknowledgmentId: string;
  submissionId: string;
  kind: string;
  macJurisdiction: string;
  ackReceivedAt: string;
  parsedAt: string;
  outcomeStatus: string;
  // X12 status/reason codes only — never PHI/MBI (§8.7).
  parsedPayload: unknown;
}

const ACK_KIND_LABEL: Record<string, string> = {
  "999": "999 · Functional ack",
  "277ca": "277CA · Claim ack",
  "835": "835 · Remittance advice",
};

function ackKindLabel(kind: string): string {
  return ACK_KIND_LABEL[kind.toLowerCase()] ?? statusLabel(kind);
}

// :claimId is the second-to-last path segment of /billing/claims/:claimId/acknowledgments.
function claimIdFromPath(): string {
  const segs = window.location.pathname.split("/").filter(Boolean);
  return segs[segs.length - 2] ?? "";
}

export function AcknowledgmentsTimeline(): JSX.Element {
  const client = useApiClient();
  const [claimId] = useState(claimIdFromPath);
  const [rows, setRows] = useState<ClaimAcknowledgment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/billing/claims/{id}/acknowledgments", {
      params: { path: { id: claimId } },
    });
    if (err) {
      setError(
        "Acknowledgments unavailable — the billing read seam is not bound, or you lack scope.",
      );
      setLoading(false);
      return;
    }
    setRows(((data as unknown as ClaimAcknowledgment[]) ?? []) as ClaimAcknowledgment[]);
    setLoading(false);
  }, [client, claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Acknowledgments"
          breadcrumb={
            <>
              Billing — Medicare ·{" "}
              <a
                href={`/billing/claims/${claimId}`}
                style={{ fontFamily: "var(--font-mono)", color: "var(--color-primary)" }}
              >
                {claimId}
              </a>
            </>
          }
        />
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          title="No acknowledgments"
          description="No 999 / 277CA / 835 acknowledgments have been received for this claim."
        />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Outcome</th>
              <th style={thStyle}>MAC</th>
              <th style={thStyle}>Received</th>
              <th style={thStyle}>Parsed</th>
              <th style={thStyle}>Payload</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isOpen = expanded === r.acknowledgmentId;
              return (
                <Fragment key={r.acknowledgmentId}>
                  <tr
                    style={{ background: i % 2 === 1 ? "var(--color-surface-low)" : "transparent" }}
                  >
                    <td style={tdStyle}>{ackKindLabel(r.kind)}</td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={statusLabel(r.outcomeStatus)}
                        tone={ackOutcomeTone(r.outcomeStatus)}
                      />
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>
                      {r.macJurisdiction}
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {r.ackReceivedAt}
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>{r.parsedAt}</td>
                    <td style={tdStyle}>
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={`ack-payload-${r.acknowledgmentId}`}
                        onClick={() => setExpanded(isOpen ? null : r.acknowledgmentId)}
                        style={togglePayloadStyle}
                      >
                        {isOpen ? "Hide payload" : "View payload"}
                      </button>
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr
                      style={{
                        background: i % 2 === 1 ? "var(--color-surface-low)" : "transparent",
                      }}
                    >
                      <td colSpan={6} style={{ padding: "0.25rem 0.75rem 0.75rem" }}>
                        <pre id={`ack-payload-${r.acknowledgmentId}`} style={payloadStyle}>
                          {JSON.stringify(r.parsedPayload, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </DetailPageLayout>
  );
}

const thStyle = {
  padding: "0.5rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600 as const,
};
const tdStyle = { padding: "0.5rem 0.75rem", color: "var(--color-on-surface)" };
const togglePayloadStyle = {
  padding: "0.2rem 0.5rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.75rem",
};
const payloadStyle = {
  margin: 0,
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
  whiteSpace: "pre-wrap" as const,
  overflowX: "auto" as const,
};

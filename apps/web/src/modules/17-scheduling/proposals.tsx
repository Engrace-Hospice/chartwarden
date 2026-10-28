import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/17-scheduling — Proposals Inbox (M17 §5.1 `/app/scheduling/proposals`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The scheduler's pending-proposals inbox: frequency / supervisory /
// order / IDG-driven proposals awaiting publish. The bulk publish/dismiss write surfaces fill in as those write
// paths harden (publish reruns the §1.1 D8 pre-schedule gate SERVER-side); ADR-0030 — no frontend authz. The
// patient filter comes from `?patient=`. Reads GET /api/v1/visit-proposals via the typed client. Leaves only
// (@chartwarden/ui).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { dismissProposal, publishProposal } from "./scheduling-api";
import { PROPOSAL_TONE, stateLabel } from "./scheduling-status";

interface ProposalRow {
  id: string;
  patientId: string;
  proposedVisitPurpose: string;
  proposedForDate: string;
  status: string;
}

export function SchedulingProposals(): JSX.Element {
  const client = useApiClient();
  const [params] = useSearchParams();
  const patient = params.get("patient") ?? undefined;
  const [rows, setRows] = useState<ProposalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/visit-proposals", {
      params: { query: patient ? { patient } : {} },
    });
    if (err) {
      setError("Could not load the proposal inbox.");
      setLoading(false);
      return;
    }
    setRows((data ?? []) as ProposalRow[]);
    setLoading(false);
  }, [client, patient]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * #91 — decide a proposal. PUBLISH is the write this inbox exists for: M17 generates proposals from
   * the care plan's frequency orders, the IDG's decisions and the supervisory cadence, and publishing is
   * what turns one into a real scheduled visit. With no caller, every proposal the platform produced sat
   * in this list and the visits the plan of care called for were never created.
   *
   * A dismissal keeps the row — declining to schedule is a decision, not an absence of one.
   */
  async function decide(proposalId: string, kind: "publish" | "dismiss"): Promise<void> {
    setBusyId(proposalId);
    setNotice(null);
    const res =
      kind === "publish"
        ? await publishProposal(client, proposalId)
        : await dismissProposal(client, proposalId, "Not scheduling this occurrence.");
    setBusyId(null);
    setNotice(
      res.ok
        ? kind === "publish"
          ? "Published — the visit is on the schedule."
          : "Dismissed."
        : res.message,
    );
    if (res.ok) await load();
  }

  const pending = rows.filter((r) => r.status === "pending");

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Proposal Inbox">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Pending visit proposals awaiting publish
            {patient ? ` for patient ${patient.slice(0, 8)}` : ""}.
          </div>
          {notice ? (
            <output
              style={{
                display: "block",
                color: "var(--color-on-surface-variant)",
                fontSize: "0.8rem",
              }}
            >
              {notice}
            </output>
          ) : null}
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          <div style={infoBannerStyle}>
            The server owns proposal visibility and publish eligibility. Bulk publish/dismiss
            actions remain outside this read-only queue until those write paths land.
          </div>
        </div>
      }
      table={
        error ? (
          <div style={emptyShellStyle}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading && rows.length === 0 ? (
          <div style={loadingShellStyle}>
            <LoadingSpinner />
          </div>
        ) : pending.length === 0 ? (
          <div style={emptyShellStyle}>
            <EmptyState
              title="No pending proposals"
              description="There are no proposals awaiting publish."
            />
          </div>
        ) : (
          <div style={tableShellStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={tableHeadRowStyle}>
                  <th style={thStyle}>For date</th>
                  <th style={thStyle}>Purpose</th>
                  <th style={thStyle}>Patient</th>
                  <th style={thStyle}>Status</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Decide</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.id} style={rowStyle}>
                    <td className="tabular-nums" style={tdStyle}>
                      {r.proposedForDate}
                    </td>
                    <td style={tdStyle}>{stateLabel(r.proposedVisitPurpose)}</td>
                    <td className="wx-data-md" style={tdStyle}>
                      {r.patientId.slice(0, 8)}
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={stateLabel(r.status)}
                        tone={PROPOSAL_TONE[r.status] ?? "neutral"}
                      />
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <span style={{ display: "inline-flex", gap: "0.35rem" }}>
                        <Button
                          size="sm"
                          disabled={busyId === r.id}
                          onClick={() => void decide(r.id, "publish")}
                        >
                          Publish
                        </Button>
                        <Button
                          size="sm"
                          tone="tertiary"
                          disabled={busyId === r.id}
                          onClick={() => void decide(r.id, "dismiss")}
                        >
                          Dismiss
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const tableShellStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const emptyShellStyle: CSSProperties = {
  padding: "2rem 1.5rem",
};

const loadingShellStyle: CSSProperties = {
  padding: "2.5rem 1.5rem",
  textAlign: "center",
};

const infoBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)",
  background: "var(--color-primary-tint)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};

const tableHeadRowStyle: CSSProperties = {
  background: "var(--color-surface-low)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const thStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};

const tdStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  color: "var(--color-on-surface)",
};

const rowStyle: CSSProperties = {
  borderTop: "1px solid var(--color-surface-container)",
};

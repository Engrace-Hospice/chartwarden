import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the SUBMISSIONS TIMELINE (R2, §5.1 #8). Every submission
// attempt for one claim: attempt index, resolved channel, adapter vendor + version, result, error code, and
// the next poll time for an async channel. Backed by GET /api/v1/medicaid-claims/{id}/submissions. Read-only
// — retry is a server-side worker decision, not a button (§4.9). Lantern: WorkQueueLayout + No-Line table
// (§6.7) + §6.6 StatusPill; mono control numbers and adapter versions; CSS-var tokens only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { SUBMISSION_RESULT_TONE, channelLabel, humanize, toneOf } from "./medicaid-status";
import {
  linkStyle,
  mutedStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  tdNum,
  th,
  thNum,
} from "./medicaid-ui";

interface Submission {
  id: string;
  serviceState: string;
  channel: string;
  medicaidClaimControlNumber: string;
  attemptIndex: number;
  adapterVendor: string;
  adapterVersion: string;
  result: string;
  errorCode: string | null;
  nextPollAt: string | null;
  submittedAt: string | null;
  createdAt: string;
}

const stamp = (value: string | null): string =>
  value ? value.slice(0, 16).replace("T", " ") : "—";

export function MedicaidSubmissionsTimeline(): JSX.Element {
  const client = useApiClient();
  const { claimId } = useParams<{ claimId: string }>();
  const [rows, setRows] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!claimId) return;
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/medicaid-claims/{id}/submissions", {
      params: { path: { id: claimId } },
    });
    if (res.error) {
      setError(
        "The submission history is unavailable — you may lack billing visibility for this claim.",
      );
      setLoading(false);
      return;
    }
    setRows((res.data as unknown as Submission[]) ?? []);
    setLoading(false);
  }, [client, claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!claimId) return <EmptyState title="No claim" description="No claim was specified." />;
  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  // Most recent attempt first — the timeline reads newest-at-top like every other M24 history.
  const ordered = [...rows].sort((a, b) => b.attemptIndex - a.attemptIndex);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Submissions"
          breadcrumb="Billing — Medicaid · transmission attempts"
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
            title="Never submitted"
            description="This claim has not been transmitted to a state channel yet."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thNum}>Attempt</th>
                <th style={th}>Channel</th>
                <th style={th}>Control #</th>
                <th style={th}>Adapter</th>
                <th style={th}>Result</th>
                <th style={th}>Error</th>
                <th style={th}>Submitted</th>
                <th style={th}>Next poll</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((s) => (
                <tr key={s.id} style={rowLine}>
                  <td style={tdNum}>{s.attemptIndex}</td>
                  <td style={td}>
                    {channelLabel(s.channel)}
                    <span style={{ ...mutedStyle, marginLeft: "0.4rem" }}>{s.serviceState}</span>
                  </td>
                  <td style={tdMono}>{s.medicaidClaimControlNumber}</td>
                  <td style={tdMono}>
                    {s.adapterVendor} {s.adapterVersion}
                  </td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(s.result)}
                      tone={toneOf(SUBMISSION_RESULT_TONE, s.result)}
                    />
                  </td>
                  <td style={tdMono}>{s.errorCode ?? "—"}</td>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                    {stamp(s.submittedAt)}
                  </td>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                    {stamp(s.nextPollAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
      detail={
        <span style={mutedStyle}>
          Retries are scheduled by the submission worker — a transport failure or timeout
          re-attempts automatically; a synchronous rejection does not.
        </span>
      }
    />
  );
}

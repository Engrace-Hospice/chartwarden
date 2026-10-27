// apps/web/src/modules/41-billing-commercial — COMMERCIAL CLAIM TIMELINE (M41, issue #822).
//   GET /api/v1/billing/commercial/claims/{id}/timeline   state changes, submissions and acknowledgments in order (read-audited)
// Ids, dates and codes only. The server bounds the list (newest kept) and says so with `truncated`. A submission's free-text failure
// message is deliberately not shown (it can carry clearinghouse text); the stable failure code is.
import { EmptyState, InlineAlert, Panel, StatusPill, useApiClient } from "@chartwarden/ui";
import type { StatusTone, paths } from "@chartwarden/ui";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { ClaimSubpage } from "./claim-subpage";
import { COMMERCIAL_PATHS, claimStateTone, statusLabel } from "./commercial-model";

type Item =
  paths["/api/v1/billing/commercial/claims/{id}/timeline"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

const SUBMISSION_TONE: Record<string, StatusTone> = {
  queued: "progress",
  sent: "success",
  failed: "error",
  in_doubt: "warning",
};

function when(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

function describe(item: Item): { kind: string; what: string; status: JSX.Element } {
  if (item.kind === "state_change") {
    return {
      kind: "State change",
      what: item.fromState
        ? `${statusLabel(item.fromState)} to ${statusLabel(item.toState)} (by ${item.actorKind})`
        : `Claim created as ${statusLabel(item.toState)}`,
      status: <StatusPill label={statusLabel(item.toState)} tone={claimStateTone(item.toState)} />,
    };
  }
  if (item.kind === "submission") {
    const detail = [
      `${item.attemptCount} attempt${item.attemptCount === 1 ? "" : "s"}`,
      item.failureCode ? `failure ${item.failureCode}` : null,
      item.sentAt ? `sent ${when(item.sentAt)}` : null,
    ].filter(Boolean);
    return {
      kind: "Submission",
      what: `Submission ${item.controlNumber} · ${detail.join(" · ")}`,
      status: (
        <StatusPill
          label={statusLabel(item.status)}
          tone={SUBMISSION_TONE[item.status] ?? "neutral"}
        />
      ),
    };
  }
  const codes = item.reasonCodes.length > 0 ? ` · reason codes ${item.reasonCodes.join(", ")}` : "";
  const payerNo = item.payerClaimNumber ? ` · payer claim number ${item.payerClaimNumber}` : "";
  return {
    kind: "Acknowledgment",
    what: `${statusLabel(item.stage)} acknowledgment${codes}${payerNo}`,
    status: (
      <StatusPill
        label={statusLabel(item.disposition)}
        tone={item.disposition === "accepted" ? "success" : "warning"}
      />
    ),
  };
}

export function CommercialClaimTimeline(): JSX.Element {
  const client = useApiClient();
  return (
    <ClaimSubpage
      title="Claim history"
      description="State changes, submissions and payer acknowledgments, oldest first."
      read={(id) =>
        client.GET("/api/v1/billing/commercial/claims/{id}/timeline", { params: { path: { id } } })
      }
    >
      {(timeline) => (
        <Panel title="Timeline" icon="clock" flush>
          {timeline.truncated ? (
            <InlineAlert tone="warning">
              Older events are not shown. Only the newest events are kept on this screen.
            </InlineAlert>
          ) : null}
          {timeline.items.length === 0 ? (
            <EmptyState title="No history yet" description="This claim has no recorded events." />
          ) : (
            <div className="wx-list-table-wrap">
              <table className="wx-list-table wx-list-table-static">
                <caption className="wx-sr-only">Claim history</caption>
                <thead>
                  <tr>
                    <th scope="col">When (UTC)</th>
                    <th scope="col">Event</th>
                    <th scope="col">What happened</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.items.map((item, i) => {
                    const d = describe(item);
                    return (
                      <tr key={`${item.kind}-${item.at}-${i}`}>
                        <td className="wx-nums">{when(item.at)}</td>
                        <td>{d.kind}</td>
                        <td>{d.what}</td>
                        <td>{d.status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="wx-row-sub" style={{ margin: "0.75rem 1rem" }}>
            <Link to={COMMERCIAL_PATHS.claim(timeline.claimId)}>Back to the claim</Link> ·{" "}
            <Link to={COMMERCIAL_PATHS.sendGate(timeline.claimId)}>Send gate</Link>
          </p>
        </Panel>
      )}
    </ClaimSubpage>
  );
}

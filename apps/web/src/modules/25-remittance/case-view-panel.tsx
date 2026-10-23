import { LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the read-only CLAIM CASE VIEW (milestone 7a-1): every appeal, ADR, reopening,
// recorded deadline, audit request and submission on one claim, newest first, with the next deadline on top. Dates
// shown come from the API as computed or as recorded from a notice, and say which. A claim with no recorded due date
// is flagged loudly, never given a default.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Hint } from "./action-ui";
import { type CaseView, type TimelineItem, loadCaseView } from "./audit-api";
import { NOT_COMPUTED, NoDueDateAlert } from "./recorded-deadlines";
import { humanize } from "./remittance-status";

const UNCONFIRMED = "Window not SME-confirmed";

function deadlineText(item: TimelineItem): string {
  if (!item.deadlineAt) return "";
  const day = new Date(item.deadlineAt).toLocaleDateString();
  return item.deadlineSource === "recorded" ? `${day} (from your notice)` : `${day} (computed)`;
}

function Row({ item }: { readonly item: TimelineItem }): JSX.Element {
  return (
    <li>
      <strong>{humanize(item.kind)}</strong> · {item.label} · {humanize(item.state)}
      {item.tier ? ` · ${humanize(item.tier)}` : ""} · {new Date(item.at).toLocaleDateString()}
      {item.deadlineAt ? ` · due ${deadlineText(item)}` : ""}
      {item.deadlineAt && !item.windowConfirmed ? (
        <>
          {" "}
          <StatusPill label={UNCONFIRMED} tone="warning" />
        </>
      ) : null}
    </li>
  );
}

export function CaseViewPanel({ claimId }: { readonly claimId: string }): JSX.Element {
  const client = useApiClient();
  const [view, setView] = useState<CaseView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadCaseView(client, claimId).then((res) => {
      if (!live) return;
      if (res.ok && Array.isArray(res.value.items)) setView(res.value);
      else if (res.ok) setError("unexpected response");
      else setError(res.message);
    });
    return () => {
      live = false;
    };
  }, [client, claimId]);

  if (error) return <Hint>Case timeline unavailable: {error}</Hint>;
  if (!view) return <LoadingSpinner />;

  const next = view.nextDeadline;
  return (
    <section aria-label="Case timeline">
      <h3 className="wx-action-title">Case timeline</h3>
      {next ? (
        <p className="wx-action-hint">
          <strong>Next deadline:</strong> {next.label} · {deadlineText(next)}
          {!next.windowConfirmed ? (
            <>
              {" "}
              <StatusPill label={UNCONFIRMED} tone="warning" />
            </>
          ) : null}
        </p>
      ) : (
        <NoDueDateAlert />
      )}
      <Hint>{NOT_COMPUTED}</Hint>
      {view.items.length === 0 ? (
        <Hint>Nothing has been recorded against this claim yet.</Hint>
      ) : (
        <ul className="wx-action-hint wx-action-list">
          {view.items.map((item) => (
            <Row key={`${item.kind}:${item.id}`} item={item} />
          ))}
        </ul>
      )}
      {view.truncated ? <Hint>Showing the most recent items only.</Hint> : null}
    </section>
  );
}

import { LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the read-only CLAIM CASE VIEW (milestone 7a-1): every appeal, ADR, reopening,
// recorded deadline, audit request and submission on one claim, newest first, with the next deadline on top. Dates
// shown come from the API as computed or as recorded from a notice, and say which. A claim with no recorded due date
// is flagged loudly, never given a default.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ErrorAlert, Hint, RetryAlert } from "./action-ui";
import { type TimelineItem, loadCaseView } from "./audit-api";
import { loadDenialCaseView } from "./payer-appeal-api";
import { NOT_COMPUTED, NoDueDateAlert } from "./recorded-deadlines";
import { formatDay, humanize } from "./remittance-status";

const UNCONFIRMED = "Window not SME-confirmed";

function deadlineText(item: TimelineItem): string {
  if (!item.deadlineAt) return "";
  const day = formatDay(item.deadlineAt);
  return item.deadlineSource === "recorded" ? `${day} (from your notice)` : `${day} (computed)`;
}

function Row({ item }: { readonly item: TimelineItem }): JSX.Element {
  return (
    <li>
      <strong>{humanize(item.kind)}</strong> · {item.label} · {humanize(item.state)}
      {item.tier ? ` · ${humanize(item.tier)}` : ""} · {formatDay(item.at)}
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

/** Keyed on the claim (the Medicare/ADR chain), or on the DENIAL when it has no claim (a commercial denial). */
export type CaseViewPanelProps = (
  | { readonly claimId: string; readonly denialId?: undefined }
  | { readonly denialId: string; readonly claimId?: undefined }
) & {
  /**
   * Changes whenever something on this claim was written (a version, a counter): the timeline is read again and
   * the last good timeline stays on screen while it does.
   */
  readonly refreshKey?: string | number;
};

interface Timeline {
  readonly nextDeadline: TimelineItem | null;
  readonly items: TimelineItem[];
  readonly truncated: boolean;
}

export function CaseViewPanel({ claimId, denialId, refreshKey }: CaseViewPanelProps): JSX.Element {
  const client = useApiClient();
  const [view, setView] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    latest.current += 1;
    const seq = latest.current;
    const res = denialId
      ? await loadDenialCaseView(client, denialId)
      : await loadCaseView(client, claimId as string);
    if (seq !== latest.current) return; // a newer read (or unmount) superseded this one
    if (res.ok && Array.isArray(res.value.items)) {
      setView(res.value);
      setError(null);
    } else setError(res.ok ? "unexpected response" : res.message);
  }, [client, claimId, denialId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the explicit "read again" trigger
  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load, refreshKey]);

  if (!view) {
    return error ? (
      <section aria-label="Case timeline">
        <RetryAlert message={`Case timeline unavailable: ${error}`} onRetry={() => void load()} />
      </section>
    ) : (
      <LoadingSpinner />
    );
  }

  const next = view.nextDeadline;
  return (
    <section aria-label="Case timeline">
      <h3 className="wx-action-title">Case timeline</h3>
      {error ? <ErrorAlert message={`Case timeline could not be refreshed: ${error}`} /> : null}
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

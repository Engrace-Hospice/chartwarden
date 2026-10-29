// M36 WP 5.8 (ADR-0087, PROPOSED) - the compliance review of break-glass access, for a holder of messaging.break_glass.review. A queue (Pending oldest
// first, Reviewed, All) of flat rows on the shared kit, and a detail with the justification, the audited reads (kind, count and time only, never
// message text) and a form that completes the review as Reviewed or Concern (a concern needs a note). State is a word, never colour alone. Every
// write is disabled while offline and is never queued. The justification and the note are staff free text and are only ever rendered as text.
import type { BreakGlassReviewDetailDto, BreakGlassReviewDto } from "@chartwarden/types";
import { BREAK_GLASS_NOTE_MAX } from "@chartwarden/types";
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  TextAreaField,
} from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../shell/session";
import * as W from "./break-glass-wording";
import { useOnlineStatus } from "./offline-banner";
import {
  type LoadView,
  type ReviewStatusFilter,
  useBreakGlassActions,
  useReviewDetail,
  useReviews,
} from "./use-break-glass";
import "./break-glass.css";

const formatTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

function LoadGate<T>({
  view,
  retry,
  children,
}: {
  readonly view: LoadView<T>;
  readonly retry: () => void;
  readonly children: (data: T) => JSX.Element;
}): JSX.Element {
  switch (view.status) {
    case "loading":
      return <LoadingSpinner />;
    case "error":
      return (
        <div className="wx-break-glass-error" role="alert">
          <p>{W.LOAD_FAILED}</p>
          <Button type="button" tone="secondary" size="sm" onClick={retry}>
            {W.RETRY_LABEL}
          </Button>
        </div>
      );
    case "denied":
      return (
        <p className="wx-break-glass-error" role="alert">
          {view.code === 401 ? W.SIGN_IN : W.REVIEW_DENIED}
        </p>
      );
    case "ready":
      return children(view.data);
  }
}

function StatusBadge({ review }: { readonly review: BreakGlassReviewDto }): JSX.Element {
  if (review.status === "pending")
    return <StatusPill tone="progress" glyph="clock" label={W.STATUS_OPEN} />;
  return review.outcome === "concern" ? (
    <StatusPill tone="warning" glyph="alert" label={W.STATUS_CONCERN} />
  ) : (
    <StatusPill tone="success" glyph="check" label={W.STATUS_REVIEWED} />
  );
}

function channelText(review: BreakGlassReviewDto): string {
  return review.channelKind === "care_team"
    ? W.CHANNEL_CARE_TEAM
    : (review.channelTitle ?? review.channelKind.replace(/_/g, " "));
}

function Facts({ review }: { readonly review: BreakGlassReviewDto }): JSX.Element {
  return (
    <>
      <span className="wx-break-glass-title">
        {W.holderText(review.granteeName)} · {channelText(review)}
      </span>
      {review.patientId ? (
        <span className="wx-break-glass-detail">
          {W.PATIENT_LABEL}{" "}
          {/* An id only (never a name or a title); the chart route enforces the reviewer's own patient access. */}
          <Link className="wx-break-glass-mono" to={`/patients/${review.patientId}`}>
            {review.patientId}
          </Link>
        </span>
      ) : null}
      <span className="wx-break-glass-detail">
        {W.REASON_LABELS[review.reasonCode]} · {W.readsText(review.readCount)}
      </span>
      <span className="wx-break-glass-detail">
        {W.endedText(formatTime(review.endedAt))} · {W.dueText(formatTime(review.dueAt))}
      </span>
    </>
  );
}

function ReviewRow({
  review,
  onOpen,
}: {
  readonly review: BreakGlassReviewDto;
  readonly onOpen: () => void;
}): JSX.Element {
  return (
    <li className="wx-break-glass-row">
      <div className="wx-break-glass-main">
        <Facts review={review} />
      </div>
      <div className="wx-break-glass-meta">
        <StatusBadge review={review} />
        {review.overdue ? <StatusPill tone="error" glyph="alert" label={W.OVERDUE_LABEL} /> : null}
        {review.stillActive ? <StatusPill tone="neutral" label={W.STILL_ACTIVE_LABEL} /> : null}
        <Button type="button" tone="secondary" size="sm" onClick={onOpen}>
          {W.OPEN_REVIEW}
        </Button>
      </div>
    </li>
  );
}

function Detail({
  reviewId,
  onBack,
  onChanged,
}: {
  readonly reviewId: string;
  readonly onBack: () => void;
  readonly onChanged: () => void;
}): JSX.Element {
  const { view, reload } = useReviewDetail(reviewId);
  return (
    <>
      <Button type="button" tone="secondary" size="sm" onClick={onBack}>
        {W.BACK_LABEL}
      </Button>
      <LoadGate view={view} retry={reload}>
        {(detail) => (
          <DetailBody
            detail={detail}
            reload={() => {
              reload();
              onChanged();
            }}
          />
        )}
      </LoadGate>
    </>
  );
}

function DetailBody({
  detail,
  reload,
}: {
  readonly detail: BreakGlassReviewDetailDto;
  readonly reload: () => void;
}): JSX.Element {
  const actions = useBreakGlassActions();
  const online = useOnlineStatus();
  const me = useSession()?.userId;
  // The server stays the authority; this only pre-empts the refusal it would give for the person's own grant.
  const own = me !== undefined && me === detail.granteeUserId;
  const statusRef = useRef<HTMLOutputElement>(null);
  const [outcome, setOutcome] = useState<"reviewed" | "concern">("reviewed");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const complete = async (): Promise<void> => {
    if (busy || !online || own) return;
    const trimmed = note.trim();
    if (outcome === "concern" && trimmed === "") return setMessage(W.NOTE_REQUIRED);
    if (trimmed.length > BREAK_GLASS_NOTE_MAX) return setMessage(W.NOTE_TOO_LONG);
    setBusy(true);
    setMessage(null);
    const result = await actions.complete(detail.reviewId, {
      outcome,
      ...(trimmed === "" ? {} : { note: trimmed }),
    });
    setBusy(false);
    if (result.kind === "ok") {
      setMessage(W.COMPLETED);
      statusRef.current?.focus(); // the form is replaced by the result: keep focus on it
      reload();
    } else if (result.kind === "conflict" && result.code === "BREAK_GLASS_REVIEW_DONE") {
      setMessage(W.ALREADY_DONE);
      reload();
    } else if (result.kind === "conflict" && result.code === "BREAK_GLASS_STILL_ACTIVE") {
      setMessage(W.STILL_ACTIVE_TEXT);
      reload();
    } else if (result.kind === "denied") {
      setMessage(result.code === 401 ? W.SIGN_IN : W.NOT_PERMITTED);
    } else if (result.kind === "invalid") {
      setMessage(outcome === "concern" ? W.NOTE_REQUIRED : W.COMPLETE_FAILED);
    } else {
      setMessage(W.COMPLETE_FAILED);
    }
  };
  const endAccess = async (): Promise<void> => {
    if (busy || !online) return;
    setBusy(true);
    const result = await actions.end(detail.grantId);
    setBusy(false);
    // Ended, already ended (409) or gone (404): the access is over either way, so re-read rather than report a failure.
    if (result.kind === "ok" || result.kind === "not_available" || result.kind === "conflict") {
      setMessage(null);
      reload();
    } else setMessage(W.END_FAILED);
  };

  return (
    <section className="wx-break-glass-detail-pane" aria-label={W.DETAIL_TITLE}>
      <div className="wx-break-glass-main">
        <Facts review={detail} />
        <span className="wx-break-glass-meta">
          <StatusBadge review={detail} />
          {detail.overdue ? (
            <StatusPill tone="error" glyph="alert" label={W.OVERDUE_LABEL} />
          ) : null}
        </span>
      </div>
      <h2>{W.JUSTIFICATION_HEADING}</h2>
      <p className="wx-break-glass-text">{detail.justification}</p>
      <h2>{W.READS_HEADING}</h2>
      {detail.readsTruncated ? (
        <p className="wx-break-glass-detail" role="note">
          {W.readsTruncatedText(detail.reads.length, detail.readCount)}
        </p>
      ) : null}
      {detail.reads.length === 0 ? (
        <p className="wx-break-glass-detail">{W.READS_NONE}</p>
      ) : (
        <ul className="wx-break-glass-reads" aria-label={W.READS_HEADING}>
          {detail.reads.map((r, i) => (
            <li key={`${r.readAt}-${i}`}>
              {W.readLine(W.READ_KIND_LABELS[r.readKind], r.itemCount)} · {formatTime(r.readAt)}
            </li>
          ))}
        </ul>
      )}
      {detail.status === "reviewed" ? (
        <p className="wx-break-glass-detail">
          {detail.outcome === "concern" ? W.OUTCOME_CONCERN : W.OUTCOME_REVIEWED}
          {detail.reviewedAt ? ` · ${formatTime(detail.reviewedAt)}` : ""}
          {detail.note ? ` · ${detail.note}` : ""}
        </p>
      ) : (
        <form
          className="wx-break-glass-form"
          aria-describedby={own ? "wx-break-glass-own" : undefined}
          onSubmit={(e) => {
            e.preventDefault();
            void complete();
          }}
        >
          {own ? (
            <p id="wx-break-glass-own" className="wx-break-glass-detail">
              {W.OWN_GRANT}
            </p>
          ) : null}
          {detail.stillActive ? (
            <div className="wx-break-glass-status">
              <p>{W.STILL_ACTIVE_TEXT}</p>
              <Button
                type="button"
                tone="secondary"
                size="sm"
                disabled={busy || !online}
                onClick={() => void endAccess()}
              >
                {W.END_ACCESS}
              </Button>
            </div>
          ) : null}
          <fieldset className="wx-break-glass-outcome">
            <legend>{W.OUTCOME_LABEL}</legend>
            <label>
              <input
                type="radio"
                name="outcome"
                checked={outcome === "reviewed"}
                onChange={() => setOutcome("reviewed")}
              />
              {W.OUTCOME_REVIEWED}
            </label>
            <label>
              <input
                type="radio"
                name="outcome"
                checked={outcome === "concern"}
                onChange={() => setOutcome("concern")}
              />
              {W.OUTCOME_CONCERN}
            </label>
          </fieldset>
          <TextAreaField
            label={W.NOTE_LABEL}
            hint={W.NOTE_HINT}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {!online ? (
            <p className="wx-break-glass-error" role="alert">
              {W.OFFLINE_TEXT}
            </p>
          ) : null}
          <Button type="submit" tone="primary" disabled={busy || !online || own}>
            {W.COMPLETE_LABEL}
          </Button>
        </form>
      )}
      <output ref={statusRef} tabIndex={-1} className="wx-break-glass-status" aria-live="polite">
        {message}
      </output>
    </section>
  );
}

const TABS: readonly { readonly id: ReviewStatusFilter; readonly label: string }[] = [
  { id: "pending", label: W.TAB_PENDING },
  { id: "reviewed", label: W.TAB_REVIEWED },
  { id: "all", label: W.TAB_ALL },
];

export function BreakGlassReview(): JSX.Element {
  const [tab, setTab] = useState<ReviewStatusFilter>("pending");
  const [selected, setSelected] = useState<string | null>(null);
  const { view, reload } = useReviews(tab);
  const panelRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const swapped = useRef(false);
  // Swapping the list for a detail (and back) unmounts what had focus: land on the new pane instead of <body>.
  useEffect(() => {
    if (!swapped.current) {
      swapped.current = true;
      return;
    }
    (selected ? detailRef : panelRef).current?.focus();
  }, [selected]);
  const overdue = view.status === "ready" ? view.data.filter((r) => r.overdue).length : 0;
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const here = TABS.findIndex((t) => t.id === tab);
    const last = TABS.length - 1;
    const to =
      e.key === "ArrowRight"
        ? (here + 1) % TABS.length
        : e.key === "ArrowLeft"
          ? (here + last) % TABS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    const next = TABS[to];
    if (!next) return;
    e.preventDefault();
    setTab(next.id);
    document.getElementById(`wx-break-glass-tab-${next.id}`)?.focus();
  };
  return (
    <>
      <PageHeader title={W.REVIEW_TITLE}>
        <p className="wx-break-glass-detail">{W.REVIEW_NOTICE}</p>
        {overdue > 0 ? (
          <StatusPill tone="error" glyph="alert" label={W.overdueCount(overdue)} />
        ) : null}
      </PageHeader>
      <section className="wx-break-glass" aria-label={W.REVIEW_TITLE}>
        {selected ? (
          <div ref={detailRef} tabIndex={-1} className="wx-break-glass-detail-pane">
            <Detail reviewId={selected} onBack={() => setSelected(null)} onChanged={reload} />
          </div>
        ) : (
          <>
            <div className="wx-subtabs" role="tablist" aria-label={W.TABS_LABEL}>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  id={`wx-break-glass-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  aria-controls={tab === t.id ? "wx-break-glass-panel" : undefined}
                  tabIndex={tab === t.id ? 0 : -1}
                  onClick={() => setTab(t.id)}
                  onKeyDown={onKeyDown}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              id="wx-break-glass-panel"
              ref={panelRef}
              aria-labelledby={`wx-break-glass-tab-${tab}`}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tabs pattern - a panel with no focusable content must itself be reachable
              tabIndex={0}
              className="wx-break-glass-panel"
            >
              <LoadGate view={view} retry={reload}>
                {(reviews) =>
                  reviews.length === 0 ? (
                    <EmptyState title={W.EMPTY_TITLE} description={W.EMPTY_TEXT} />
                  ) : (
                    <ul className="wx-break-glass-rows" aria-label={W.LIST_LABEL}>
                      {reviews.map((r) => (
                        <ReviewRow
                          key={r.reviewId}
                          review={r}
                          onOpen={() => setSelected(r.reviewId)}
                        />
                      ))}
                    </ul>
                  )
                }
              </LoadGate>
            </div>
          </>
        )}
      </section>
    </>
  );
}

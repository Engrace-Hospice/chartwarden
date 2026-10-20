// M36 WP 5.6 (ADR-0086, PROPOSED) - "Retention and legal holds" for a compliance officer. Two tabs on the shared kit, flat rows (no card grid):
// Retention (per message class: period, source, eligible and held counts, capped notice, scan times, certificate state) and Legal holds (list,
// place, release). The scan is plan-only and approving a destruction certificate destroys nothing yet; the page says so. It shows ids, counts and
// dates only, never message content. State is a word, never colour alone.
import type { MessageLegalHoldDto, RetentionClassDto, RetentionOverviewDto } from "@wardenx/types";
import { Button, EmptyState, LoadingSpinner, PageHeader, StatusPill } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import {
  CREATE_DRAFT_KEY,
  CreateHoldDialog,
  RELEASE_DRAFT_KEY,
  ReleaseHoldDialog,
  type ReleaseDraft,
} from "./legal-hold-dialogs";
import * as W from "./retention-wording";
import {
  type LoadView,
  useLegalHoldActions,
  useLegalHolds,
  useRetentionOverview,
} from "./use-retention";
import { peekStepUpDraft } from "../../shell/step-up-redirect";
import "./retention.css";

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
        <div className="wx-retention-error" role="alert">
          <p>{W.LOAD_FAILED}</p>
          <Button type="button" tone="secondary" size="sm" onClick={retry}>
            {W.RETRY_LABEL}
          </Button>
        </div>
      );
    case "denied":
      return (
        <p className="wx-retention-error" role="alert">
          {view.code === 401 ? W.SIGN_IN : W.DENIED}
        </p>
      );
    case "ready":
      return children(view.data);
  }
}

function ClassRow({ row }: { readonly row: RetentionClassDto }): JSX.Element {
  return (
    <li className="wx-retention-row">
      <div className="wx-retention-main">
        <span className="wx-retention-title">{W.CLASS_WORDING[row.class]}</span>
        <span className="wx-retention-detail">
          {W.periodText(row.period_years)}. {W.SOURCE_TEXT}
        </span>
      </div>
      <div className="wx-retention-meta">
        <span className="wx-retention-count">{W.eligibleText(row.eligible)}</span>
        {row.held !== null && row.held > 0 ? (
          <span className="wx-retention-detail">{W.heldText(row.held)}</span>
        ) : null}
        {row.capped ? <span className="wx-retention-detail">{W.CAPPED_TEXT}</span> : null}
        {row.certificate_id !== null && row.certificate_status !== null ? (
          <span className="wx-retention-detail">
            <StatusPill tone="progress" glyph="clock" label={row.certificate_status} />{" "}
            {W.certificateText(row.certificate_status)} {W.certificateIdText(row.certificate_id)}
          </span>
        ) : (
          <span className="wx-retention-detail">{W.CERTIFICATE_NONE}</span>
        )}
      </div>
    </li>
  );
}

function RetentionPanel({ data }: { readonly data: RetentionOverviewDto }): JSX.Element {
  return (
    <>
      <p className="wx-retention-detail">
        {data.last_scan_at === null
          ? W.NEVER_SCANNED
          : W.lastScanText(formatTime(data.last_scan_at))}
        {" · "}
        {W.nextScanText(formatTime(data.next_scan_at))}
      </p>
      <ul className="wx-retention-rows" aria-label={W.RETENTION_LIST_LABEL}>
        {data.classes.map((row) => (
          <ClassRow key={row.class} row={row} />
        ))}
      </ul>
    </>
  );
}

function HoldRow({
  hold,
  onRelease,
}: {
  readonly hold: MessageLegalHoldDto;
  readonly onRelease: () => void;
}): JSX.Element {
  const status = W.HOLD_STATUS[hold.status];
  return (
    <li className="wx-retention-row">
      <div className="wx-retention-main">
        <span className="wx-retention-title">{hold.name}</span>
        <span className="wx-retention-detail">{W.scopeText(hold.scope)}</span>
        <span className="wx-retention-detail">
          {W.placedText(hold.placed_by, formatTime(hold.placed_at))}
          {hold.released_at ? `. ${W.releasedText(formatTime(hold.released_at))}` : ""}
        </span>
      </div>
      <div className="wx-retention-meta">
        <StatusPill tone={status.tone} glyph={status.glyph} label={status.label} />
        <span className="wx-retention-detail">{W.heldMessagesText(hold.held_messages)}</span>
        {hold.status === "active" ? (
          <Button
            type="button"
            tone="secondary"
            size="sm"
            aria-label={W.releaseLabel(hold)}
            onClick={onRelease}
          >
            {W.RELEASE_BUTTON}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function HoldsPanel(): JSX.Element {
  const { view, reload } = useLegalHolds();
  const actions = useLegalHoldActions();
  const [creating, setCreating] = useState(() => peekStepUpDraft(CREATE_DRAFT_KEY) !== null);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // Back from the step-up page with a stashed release: reopen that hold's dialog once the list is known.
  const resumeId = peekStepUpDraft<ReleaseDraft>(RELEASE_DRAFT_KEY)?.holdId ?? null;
  useEffect(() => {
    if (
      resumeId &&
      view.status === "ready" &&
      view.data.some((h) => h.id === resumeId && h.status === "active")
    ) {
      setReleasing(resumeId);
    }
  }, [resumeId, view]);

  const target = view.status === "ready" ? view.data.find((h) => h.id === releasing) : undefined;
  return (
    <>
      <div className="wx-retention-actions">
        <Button type="button" tone="primary" onClick={() => setCreating(true)}>
          {W.PLACE_HOLD_LABEL}
        </Button>
      </div>
      <output className="wx-retention-status" aria-live="polite">
        {announcement}
      </output>
      <LoadGate view={view} retry={reload}>
        {(holds) =>
          holds.length === 0 ? (
            <EmptyState title={W.HOLDS_EMPTY_TITLE} description={W.HOLDS_EMPTY_TEXT} />
          ) : (
            <ul className="wx-retention-rows" aria-label={W.HOLDS_LIST_LABEL}>
              {holds.map((h) => (
                <HoldRow key={h.id} hold={h} onRelease={() => setReleasing(h.id)} />
              ))}
            </ul>
          )
        }
      </LoadGate>
      {creating ? (
        <CreateHoldDialog
          actions={actions}
          onClose={() => setCreating(false)}
          onPlaced={() => {
            setCreating(false);
            setAnnouncement(W.PLACED_ANNOUNCEMENT);
            reload();
          }}
        />
      ) : null}
      {target ? (
        <ReleaseHoldDialog
          key={target.id}
          hold={target}
          actions={actions}
          onClose={() => setReleasing(null)}
          onReleased={() => {
            setReleasing(null);
            setAnnouncement(W.RELEASE_ANNOUNCEMENT);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

function RetentionTab(): JSX.Element {
  const { view, reload } = useRetentionOverview();
  return (
    <LoadGate view={view} retry={reload}>
      {(data) => <RetentionPanel data={data} />}
    </LoadGate>
  );
}

const TABS = [
  { id: "retention", label: W.TAB_RETENTION },
  { id: "holds", label: W.TAB_HOLDS },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function RetentionGovernance(): JSX.Element {
  const [tab, setTab] = useState<TabId>("retention");
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = TABS[(TABS.findIndex((t) => t.id === tab) + 1) % TABS.length];
    if (next) {
      setTab(next.id);
      document.getElementById(`wx-retention-tab-${next.id}`)?.focus();
    }
  };
  return (
    <>
      <PageHeader title={W.RETENTION_TITLE} breadcrumb={W.RETENTION_BREADCRUMB}>
        <p className="wx-retention-detail">{W.RETENTION_NOTICE}</p>
      </PageHeader>
      <section className="wx-retention" aria-label={W.RETENTION_TITLE}>
        <div className="wx-subtabs" role="tablist" aria-label={W.TABS_LABEL}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`wx-retention-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`wx-retention-panel-${t.id}`}
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
          id={`wx-retention-panel-${tab}`}
          aria-labelledby={`wx-retention-tab-${tab}`}
          className="wx-retention-panel"
        >
          {tab === "retention" ? <RetentionTab /> : <HoldsPanel />}
        </div>
      </section>
    </>
  );
}

// M36 WP 5.6 (ADR-0086, PROPOSED) - "Retention and legal holds" for a compliance officer. Two tabs on the shared kit, flat rows (no card grid):
// Retention (per message class: period, source, eligible and held counts, capped notice, scan times, certificate state) and Legal holds (list,
// place, release). The scan is plan-only and approving a destruction certificate destroys nothing yet; the page says so. It shows ids, counts and
// dates only, never message content. State is a word, never colour alone.
import type { MessageLegalHoldDto, RetentionClassDto, RetentionOverviewDto } from "@wardenx/types";
import { Button, EmptyState, LoadingSpinner, PageHeader, StatusPill } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { useSession } from "../../shell/session";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import { CreateHoldDialog, ReleaseHoldDialog } from "./legal-hold-dialogs";
import {
  HOLD_ACTIONS,
  type HoldResume,
  NO_RESUME,
  createDraftKey,
  readResume,
  releaseDraftKey,
} from "./legal-hold-drafts";
import * as W from "./retention-wording";
import {
  type LoadView,
  useLegalHoldActions,
  useLegalHolds,
  useRetentionOverview,
} from "./use-retention";
import { UUID_RE } from "./uuid";
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
            <StatusPill
              tone="progress"
              glyph="clock"
              label={W.certificateStatusLabel(row.certificate_status)}
            />{" "}
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

// placed_by is the placing user's id; the contract carries no staff name, so show "you" or a labelled short id (full id in a title), never a bare uuid.
function PlacedBy({ hold }: { readonly hold: MessageLegalHoldDto }): JSX.Element {
  const me = useSession()?.userId;
  const by = hold.placed_by;
  const when = formatTime(hold.placed_at);
  if (!UUID_RE.test(by)) return <>{W.placedText(by, when)}</>;
  const who = by === me ? W.PLACED_BY_YOU : W.shortUserId(by);
  return <span title={by}>{W.placedText(who, when)}</span>;
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
          <PlacedBy hold={hold} />
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

function HoldsPanel({ resume }: { readonly resume: HoldResume }): JSX.Element {
  const owner = useStepUpOwner();
  const { view, reload } = useLegalHolds();
  const actions = useLegalHoldActions();
  const [creating, setCreating] = useState(() => resume.create !== null);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [announceSeq, setAnnounceSeq] = useState(0);
  const statusRef = useRef<HTMLOutputElement>(null);
  const resumedRelease = useRef(false);

  // Back from the step-up page with a stashed release: reopen that hold's dialog once the list is known (once).
  const resumeRelease = resume.release;
  useEffect(() => {
    if (!resumeRelease || resumedRelease.current || view.status !== "ready") return;
    resumedRelease.current = true;
    if (view.data.some((h) => h.id === resumeRelease.holdId && h.status === "active")) {
      setReleasing(resumeRelease.holdId);
    }
  }, [resumeRelease, view]);

  // After a place/release the trigger may be gone (the row changed, the dialog closed): keep focus on the result.
  useEffect(() => {
    if (announceSeq > 0) statusRef.current?.focus();
  }, [announceSeq]);
  const announce = (text: string): void => {
    setAnnouncement(text);
    setAnnounceSeq((n) => n + 1);
  };

  const target = view.status === "ready" ? view.data.find((h) => h.id === releasing) : undefined;
  return (
    <>
      <div className="wx-retention-actions">
        <Button type="button" tone="primary" onClick={() => setCreating(true)}>
          {W.PLACE_HOLD_LABEL}
        </Button>
      </div>
      <output ref={statusRef} tabIndex={-1} className="wx-retention-status" aria-live="polite">
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
          initial={resume.create}
          draftKey={createDraftKey(owner)}
          onClose={() => setCreating(false)}
          onPlaced={() => {
            setCreating(false);
            announce(W.PLACED_ANNOUNCEMENT);
            reload();
          }}
        />
      ) : null}
      {target ? (
        <ReleaseHoldDialog
          key={target.id}
          hold={target}
          actions={actions}
          initialReason={resumeRelease?.holdId === target.id ? resumeRelease.reason : ""}
          draftKey={releaseDraftKey(owner, target.id)}
          onClose={() => setReleasing(null)}
          onReleased={() => {
            setReleasing(null);
            announce(W.RELEASE_ANNOUNCEMENT);
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
  // Back from the step-up page with a stashed place/release: land on the Legal holds tab, where that dialog reopens.
  // A draft left by an abandoned step-up is discarded, never reopened.
  const owner = useStepUpOwner();
  const returning = useStepUpReturn(owner, HOLD_ACTIONS);
  const [resume] = useState<HoldResume>(() => (returning ? readResume(owner) : NO_RESUME));
  const [tab, setTab] = useState<TabId>(() =>
    resume.create !== null || resume.release !== null ? "holds" : "retention",
  );
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
    document.getElementById(`wx-retention-tab-${next.id}`)?.focus();
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
              aria-controls={tab === t.id ? `wx-retention-panel-${t.id}` : undefined}
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
          // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tabs pattern - a panel with no focusable content must itself be reachable
          tabIndex={0}
          className="wx-retention-panel"
        >
          {tab === "retention" ? <RetentionTab /> : <HoldsPanel resume={resume} />}
        </div>
      </section>
    </>
  );
}

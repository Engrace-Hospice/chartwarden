// apps/web/src/modules/36-messaging - WP 6.1 (ADR-0100): the smart work inbox. Read-only: one ranked list of the caller's own waiting work,
// grouped by the server's bands in the server's order (the web never re-ranks). Every row shows the reason the server gave. It has no
// acknowledge / accept / complete button: those stay on the screens that own the item. Loading, off, empty, error (with retry), stale
// and a missing source are each said in words.
import {
  SMART_INBOX_BANDS,
  type SmartInboxBand,
  type SmartInboxItemDto,
  type SmartInboxResponse,
} from "@chartwarden/types";
import { Button, EmptyState, LoadingSpinner, PageHeader, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  BAND_LABELS,
  INBOX_BREADCRUMB,
  INBOX_DENIED,
  INBOX_EMPTY_TEXT,
  INBOX_EMPTY_TITLE,
  INBOX_INCOMPLETE,
  INBOX_LOAD_FAILED,
  INBOX_NOTICE,
  INBOX_OFF_TEXT,
  INBOX_OFF_TITLE,
  INBOX_OPEN_LABEL,
  INBOX_RESTRICTED,
  INBOX_RETRY_LABEL,
  INBOX_SIGN_IN,
  INBOX_STALE,
  INBOX_TITLE,
  INBOX_URGENT_INCOMPLETE,
  SOURCE_UNAVAILABLE,
} from "./smart-inbox-wording";
import { type SmartInboxView, useSmartInbox } from "./use-smart-inbox";
import "./smart-inbox.css";

const OPEN_PATH = "/messaging";

function Problem({
  text,
  retry,
}: { readonly text: string; readonly retry?: (() => void) | undefined }): JSX.Element {
  return (
    <div className="wx-inbox-problem" role="alert">
      <p>{text}</p>
      {retry ? (
        <Button type="button" tone="secondary" size="sm" onClick={retry}>
          {INBOX_RETRY_LABEL}
        </Button>
      ) : null}
    </div>
  );
}

function Row({ item }: { readonly item: SmartInboxItemDto }): JSX.Element {
  const urgent = item.band === "urgent_ack";
  return (
    <li className="wx-inbox-row" data-band={item.band}>
      <span className="wx-inbox-rank" aria-label={`Rank ${item.rank}`}>
        {item.rank}
      </span>
      <div className="wx-inbox-main">
        <p className="wx-inbox-title">
          {item.title}
          {item.count ? ` (${item.count})` : ""}
        </p>
        {item.reasons.map((r) => (
          <p key={r.code} className="wx-inbox-reason">
            <StatusPill
              tone={urgent ? "critical" : "neutral"}
              label={urgent ? "Urgent" : "Why here"}
            />
            <span>{r.text}</span>
          </p>
        ))}
        {item.restricted ? <p className="wx-inbox-reason">{INBOX_RESTRICTED}</p> : null}
      </div>
      {item.restricted ? null : (
        <Link className="wx-inbox-open" to={OPEN_PATH}>
          {INBOX_OPEN_LABEL}
        </Link>
      )}
    </li>
  );
}

function Groups({ inbox }: { readonly inbox: SmartInboxResponse }): JSX.Element {
  return (
    <>
      {SMART_INBOX_BANDS.map((band: SmartInboxBand) => {
        const rows = inbox.items.filter((i) => i.band === band);
        if (rows.length === 0) return null;
        return (
          <section key={band} className="wx-inbox-group" aria-label={BAND_LABELS[band]}>
            <h2 className="wx-inbox-heading">
              {BAND_LABELS[band]} <span>{inbox.band_counts[band]}</span>
            </h2>
            <ul className="wx-inbox-rows">
              {rows.map((item) => (
                <Row key={item.key} item={item} />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function Body({
  view,
  retry,
}: { readonly view: SmartInboxView; readonly retry: () => void }): JSX.Element {
  if (view.status === "loading") return <LoadingSpinner />;
  if (view.status === "denied") {
    return <Problem text={view.code === 401 ? INBOX_SIGN_IN : INBOX_DENIED} />;
  }
  if (view.status === "error") return <Problem text={INBOX_LOAD_FAILED} retry={retry} />;
  const { inbox } = view;
  if (!inbox.enabled) {
    return <EmptyState title={INBOX_OFF_TITLE} description={INBOX_OFF_TEXT} />;
  }
  return (
    <>
      {view.stale ? <Problem text={INBOX_STALE} retry={retry} /> : null}
      {inbox.unavailable_sources.map((band) => (
        <Problem key={band} text={SOURCE_UNAVAILABLE(band)} retry={retry} />
      ))}
      {inbox.urgent_complete ? null : <Problem text={INBOX_URGENT_INCOMPLETE} />}
      {inbox.items.length === 0 && inbox.unavailable_sources.length === 0 ? (
        <EmptyState title={INBOX_EMPTY_TITLE} description={INBOX_EMPTY_TEXT} />
      ) : (
        <Groups inbox={inbox} />
      )}
      {inbox.complete ? null : <p className="wx-inbox-note">{INBOX_INCOMPLETE}</p>}
    </>
  );
}

export function SmartInbox(): JSX.Element {
  const { view, retry } = useSmartInbox();
  return (
    <>
      <PageHeader title={INBOX_TITLE} breadcrumb={INBOX_BREADCRUMB}>
        <p className="wx-inbox-note">{INBOX_NOTICE}</p>
      </PageHeader>
      <section className="wx-inbox" aria-label={INBOX_TITLE}>
        <Body view={view} retry={retry} />
      </section>
    </>
  );
}

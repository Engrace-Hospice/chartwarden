// apps/web/src/modules/16-bereavement — the ITEMS of one mailing run (ADR-0109 D10, route 46): which families are in the batch and why
// anyone was left out. An item names a contact by id and a relationship, a channel and a status; it NEVER carries a name or an address
// (those exist only inside the rendered batch), so each row links to the contact the way the other M16 screens do.
//
// A 403 renders nothing. Any other failure is announced and keeps the rows on screen. `refreshKey` changes whenever the run moved
// (generated, confirmed, cancelled): the items reload, and the rows already shown stay until the new ones arrive.
import { Button, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { type MailingItem, type MailingItemStatus, listMailingItems } from "./bereavement-api";
import { countLabel, humanize, shortId, toneOf } from "./bereavement-status";
import {
  Card,
  ErrorText,
  FilterRow,
  SelectField,
  linkStyle,
  mutedStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./bereavement-ui";
import { usePagedList } from "./mailing-load";
import { ITEM_STATUSES, ITEM_STATUS_TONE, exclusionLabel, itemStatusLabel } from "./mailing-status";

const ITEM_PAGE_SIZE = 100;
const ITEMS_LOAD_FAILED = "The run's items could not be loaded.";
const ALL_ITEMS = "";

export function MailingRunItems({
  runId,
  refreshKey,
}: {
  runId: string;
  /** Changes whenever the run moved; the items are read again. */
  refreshKey: string;
}): JSX.Element | null {
  const client = useApiClient();
  const [status, setStatus] = useState<MailingItemStatus | typeof ALL_ITEMS>(ALL_ITEMS);

  // `refreshKey` is not read in the body: it is a dependency, so a moved run re-reads the items.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the reload trigger
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const {
        page,
        error,
        status: http,
      } = await listMailingItems(client, runId, {
        ...(status === ALL_ITEMS ? {} : { status }),
        ...(cursor === null ? {} : { cursor }),
        limit: ITEM_PAGE_SIZE,
      });
      return { data: page, error, status: http };
    },
    [client, runId, status, refreshKey],
  );
  const { state, reload, loadMore } = usePagedList<MailingItem>(fetchPage, ITEMS_LOAD_FAILED);

  if (state.kind === "hidden") return null;
  // No card chrome before the first answer: a reader the server refuses must not see a card flash and vanish.
  if (state.kind === "loading") return <LoadingSpinner label="Loading the run's items" />;
  const rows = state.kind === "ready" ? state.rows : [];
  const failure =
    state.kind === "error" ? state.message : state.kind === "ready" ? state.notice : null;
  const busy = state.kind === "ready" && state.busy;
  const hasMore = state.kind === "ready" && state.hasMore;
  return (
    <Card title="Families in this run">
      <FilterRow>
        <SelectField
          label="Item status"
          value={status}
          onChange={(next) => setStatus(next as MailingItemStatus | typeof ALL_ITEMS)}
          options={[
            { value: ALL_ITEMS, label: "All items" },
            ...ITEM_STATUSES.map((s) => ({ value: s, label: itemStatusLabel(s) })),
          ]}
        />
      </FilterRow>
      {failure ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" tone="secondary" loading={busy} onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : null}
      {state.kind === "ready" && rows.length === 0 ? (
        <span style={mutedStyle}>
          {status === ALL_ITEMS
            ? "This run has no items yet. They are listed when the batch is generated."
            : "No item has this status."}
        </span>
      ) : null}
      {rows.length > 0 ? (
        <>
          <span style={mutedStyle}>
            Families are listed by id, relationship and channel. Names and addresses appear only in
            the generated batch.
          </span>
          <table style={tableStyle} aria-label="Run items" aria-busy={busy}>
            <thead>
              <tr>
                <th style={thNum}>Order</th>
                <th style={th}>Contact</th>
                <th style={th}>Relationship</th>
                <th style={th}>Channel</th>
                <th style={th}>Status</th>
                <th style={th}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.itemId} style={rowLine}>
                  <td style={tdNum}>{item.ordinal ?? "—"}</td>
                  <td style={td}>
                    <Link
                      to={`/bereavement/plans/${item.planId}/contacts/${item.contactId}`}
                      style={linkStyle}
                      aria-label={`Open contact ${shortId(item.contactId)}`}
                    >
                      Contact {shortId(item.contactId)}
                    </Link>
                  </td>
                  <td style={td}>{humanize(item.relationshipCode)}</td>
                  <td style={td}>{humanize(item.channel)}</td>
                  <td style={td}>
                    <StatusPill
                      label={itemStatusLabel(item.status)}
                      tone={toneOf(ITEM_STATUS_TONE, item.status)}
                    />
                  </td>
                  <td style={td}>{exclusionLabel(item.exclusionReason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <span style={mutedStyle}>{countLabel(rows.length, hasMore)} items shown</span>
            {hasMore ? (
              <Button size="sm" tone="secondary" loading={busy} onClick={() => void loadMore()}>
                Load more
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </Card>
  );
}

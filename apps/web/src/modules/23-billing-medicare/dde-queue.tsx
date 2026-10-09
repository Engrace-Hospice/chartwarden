// apps/web/src/modules/23-billing-medicare — the DDE work queue (ADR-0052): the Medicare Direct Data Entry (FISS)
// work a biller must key by hand — NOE/NOTR, claim entry, RTP corrections, adjustments, cancels, ADR responses. A
// cursor-paginated worklist (patient · work type · deadline · status) and a right rail for the selected item.
// HUMAN WORK TRACKING ONLY: WardenX never connects to DDE, so "recorded as keyed" is the operator's word, and
// recording it (or an acceptance) needs a fresh step-up. An NOE/NOTR is on time only once the MAC acceptance date
// is recorded; a keyed item with no acceptance date stays "at risk". No MBI is shown or accepted here; notes are
// never logged. 2026-09-25 redesign pattern (the admissions census + drawer); kit components and wx-* classes only.
// The server evaluates every rule and is the only authorization point (ADR-0030).
import {
  CursorPagination,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  interactiveRowProps,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { ItemRail } from "./dde-item-rail";
import {
  DEADLINE_LABEL,
  DEADLINE_TONE,
  type DdeItem,
  type DdeItemDetail,
  type DdeItemType,
  type DdeState,
  STATE_LABEL,
  STATE_TONE,
  TYPE_LABEL,
  fmtDay,
  plural,
} from "./dde-queue-model";
import { patientLabel, usePatientNames } from "./use-patient-names";

const PAGE_SIZE = 50;

const STATE_FILTERS: { value: "" | DdeState; label: string }[] = [
  { value: "", label: "All" },
  ...(Object.keys(STATE_LABEL) as DdeState[]).map((s) => ({ value: s, label: STATE_LABEL[s] })),
];
const TYPE_FILTERS: { value: "" | DdeItemType; label: string }[] = [
  { value: "", label: "All types" },
  ...(Object.keys(TYPE_LABEL) as DdeItemType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] })),
];

type DetailState = "idle" | "loading" | "ready" | "missing";

export function DdeQueue(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<DdeItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"" | DdeState>("");
  const [itemType, setItemType] = useState<"" | DdeItemType>("");
  const [overdue, setOverdue] = useState(false);
  const [atRisk, setAtRisk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Bumped whenever the list starts over (filter change, reload): a "Load more" response from an older generation is
  // discarded, so it can never append rows from a filter that is no longer selected.
  const generation = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [detail, setDetail] = useState<DdeItemDetail | null>(null);
  const [detailState, setDetailState] = useState<DetailState>("idle");
  const [conflict, setConflict] = useState<string | null>(null);
  const selectedId = params.get("item");

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const filterQuery = useCallback(
    () => ({
      limit: PAGE_SIZE,
      ...(state ? { state } : {}),
      ...(itemType ? { itemType } : {}),
      ...(overdue ? { overdue: true } : {}),
      ...(atRisk ? { atRisk: true } : {}),
    }),
    [state, itemType, overdue, atRisk],
  );

  // First page. Any filter change (or an action's reload) starts over from the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs the load after an action / "Try again".
  useEffect(() => {
    let active = true;
    generation.current += 1;
    setLoading(true);
    setError(null);
    setMoreError(null);
    setLoadingMore(false);
    void client
      .GET("/api/v1/billing/dde-items", { params: { query: filterQuery() } })
      .then(({ data, error: err }) => {
        if (!active) return;
        if (err || !data) {
          setError("The DDE queue could not be loaded. You may lack billing scope.");
          setItems([]);
          setHasMore(false);
          setNextCursor(null);
        } else {
          setItems(data.items as DdeItem[]);
          setHasMore(data.hasMore);
          setNextCursor(data.nextCursor ?? null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setError("The DDE queue could not be loaded. Check your connection.");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, filterQuery, reloadKey]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    void client
      .GET("/api/v1/billing/dde-items", {
        params: { query: { ...filterQuery(), cursor: nextCursor } },
      })
      .then(({ data, error: err }) => {
        if (mine !== generation.current) return;
        if (err || !data) {
          setMoreError("More items could not be loaded. Try again.");
          return;
        }
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.ddeWorkItemId));
          return [...prev, ...(data.items as DdeItem[]).filter((i) => !seen.has(i.ddeWorkItemId))];
        });
        setHasMore(data.hasMore);
        setNextCursor(data.nextCursor ?? null);
      })
      .catch(() => {
        if (mine === generation.current)
          setMoreError("More items could not be loaded. Check your connection.");
      })
      .finally(() => {
        if (mine === generation.current) setLoadingMore(false);
      });
  }, [client, filterQuery, nextCursor, loadingMore]);

  // The selected item is always read by id, so a `?item=` deep link beyond the loaded page still opens, and the rail
  // shows the server's current version of it after every action.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey refreshes the open item after an action.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailState("idle");
      return;
    }
    let active = true;
    setDetailState((s) => (s === "ready" ? s : "loading"));
    void client
      .GET("/api/v1/billing/dde-items/{id}", { params: { path: { id: selectedId } } })
      .then(({ data, error: err }) => {
        if (!active) return;
        if (err || !data) {
          setDetail(null);
          setDetailState("missing");
        } else {
          setDetail(data as DdeItemDetail);
          setDetailState("ready");
        }
      })
      .catch(() => {
        if (active) setDetailState("missing");
      });
    return () => {
      active = false;
    };
  }, [client, selectedId, reloadKey]);

  const names = usePatientNames(
    client,
    detail ? [...items.map((i) => i.patientId), detail.patientId] : items.map((i) => i.patientId),
  );
  const select = (id: string | null) => {
    setConflict(null);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (id) next.set("item", id);
        else next.delete("item");
        return next;
      },
      { replace: true },
    );
  };
  const overdueCount = items.filter((i) => i.deadlineStatus === "overdue").length;
  const atRiskCount = items.filter((i) => i.deadlineStatus === "at_risk").length;
  const showRail = selectedId !== null && detail !== null && detail.ddeWorkItemId === selectedId;
  const notInList = showRail && !loading && !items.some((i) => i.ddeWorkItemId === selectedId);

  return (
    <div className={`wx-admissions${showRail ? " has-drawer" : ""}`}>
      <div className="wx-admissions-main">
        <header className="wx-page-head">
          <div>
            <h1 className="wx-headline-lg">DDE Work Queue</h1>
            <p>
              Medicare Direct Data Entry work to key by hand. WardenX does not connect to DDE:
              record what you keyed and what came back. A notice is on time only once the MAC
              acceptance date is recorded.
            </p>
          </div>
        </header>

        <BillingTabs />

        <div className="wx-filter-panel">
          <label className="wx-filter-field">
            <span>Status</span>
            <select
              className="wx-select"
              aria-label="Status"
              value={state}
              onChange={(e) => setState(e.target.value as "" | DdeState)}
            >
              {STATE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wx-filter-field">
            <span>Type</span>
            <select
              className="wx-select"
              aria-label="Type"
              value={itemType}
              onChange={(e) => setItemType(e.target.value as "" | DdeItemType)}
            >
              {TYPE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wx-filter-field">
            <span>Overdue only</span>
            <input
              type="checkbox"
              aria-label="Overdue only"
              checked={overdue}
              onChange={(e) => setOverdue(e.target.checked)}
            />
          </label>
          <label className="wx-filter-field">
            <span>At risk only</span>
            <input
              type="checkbox"
              aria-label="At risk only"
              checked={atRisk}
              onChange={(e) => setAtRisk(e.target.checked)}
            />
          </label>
          <p className="wx-row-sub" aria-live="polite">
            {loading
              ? "Loading…"
              : `${plural(items.length, "item")} loaded${hasMore ? " (more available)" : ""} · ${overdueCount} overdue · ${atRiskCount} at risk (of those loaded)`}
          </p>
        </div>

        {conflict ? <InlineAlert>{conflict}</InlineAlert> : null}
        {selectedId && detailState === "missing" ? (
          <InlineAlert>
            That item could not be found, or it is outside your billing scope.
          </InlineAlert>
        ) : null}

        {error ? (
          <div className="wx-list-state" role="alert">
            <EmptyState title="DDE queue unavailable" description={error} />
            <button type="button" className="wx-btn-secondary" onClick={reload}>
              Try again
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title="No DDE work"
              description="Items appear here when a notice nears its filing window or when someone queues DDE work."
            />
          </div>
        ) : (
          <>
            <div className="wx-list-table-wrap">
              <table className="wx-list-table">
                <caption className="wx-sr-only">DDE work items</caption>
                <thead>
                  <tr>
                    <th scope="col">Patient</th>
                    <th scope="col">Work</th>
                    <th scope="col">Deadline</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((n) => {
                    const isSelected = n.ddeWorkItemId === selectedId;
                    return (
                      <tr
                        key={n.ddeWorkItemId}
                        className={
                          isSelected
                            ? "is-selected wx-data-row-interactive"
                            : "wx-data-row-interactive"
                        }
                        {...interactiveRowProps(() => select(n.ddeWorkItemId), isSelected, true)}
                      >
                        <td>
                          <span className="wx-row-title">
                            {patientLabel(names[n.patientId], n.patientId)}
                          </span>
                          <span className="wx-row-sub">
                            {n.assigneeMembershipId ? "Assigned" : "Unassigned"}
                            {n.attemptNumber > 1 ? ` · attempt ${n.attemptNumber}` : ""}
                          </span>
                        </td>
                        <td>{TYPE_LABEL[n.itemType]}</td>
                        <td>
                          <span className="wx-nums">{fmtDay(n.deadlineAt)}</span>
                          {n.deadlineStatus !== "none" ? (
                            <StatusPill
                              label={DEADLINE_LABEL[n.deadlineStatus]}
                              tone={DEADLINE_TONE[n.deadlineStatus]}
                            />
                          ) : null}
                        </td>
                        <td>
                          <StatusPill label={STATE_LABEL[n.state]} tone={STATE_TONE[n.state]} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {moreError ? <InlineAlert>{moreError}</InlineAlert> : null}
            <CursorPagination
              loadedCount={items.length}
              hasNextPage={hasMore}
              onNextPage={loadMore}
              loading={loadingMore}
              noun="items"
            />
          </>
        )}
      </div>

      {showRail && detail ? (
        <ItemRail
          key={detail.ddeWorkItemId}
          item={detail}
          patientName={patientLabel(names[detail.patientId], detail.patientId)}
          notInList={notInList}
          onClose={() => select(null)}
          onChanged={() => {
            setConflict(null);
            reload();
          }}
          onConflict={setConflict}
        />
      ) : null}
    </div>
  );
}

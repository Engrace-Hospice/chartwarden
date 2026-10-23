// apps/web/src/modules/21-supplies — S21.1 SUPPLY TEAM DASHBOARD (`/supplies`, §5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_SUPPLIES_DME_COMFORT_KIT.md — "Use Work Queue."
//
// Four reads compose this screen: the open supply-request worklist (row 2), the overdue return worklist
// (row 25), the shelf (row 32) and the dispatch list (row 21) for the reconciled-with-discrepancy tail.
//
// THE KPI TILES ARE PAGE-DERIVED, AND THE SCREEN SAYS SO. M21 publishes no aggregate/dashboard route and no
// `total_count` on its cursor envelope (§4.1 has no row for either), so every count here is computed from
// the page actually fetched. When a page is truncated the tile row carries an explicit "at least" notice
// rather than a number that reads like a census — a KPI that silently under-counts an overdue
// controlled-substance return is worse than no KPI at all.
//
// TWO §5.2 TILES ARE NOT BUILT, deliberately, and the screen names them:
//   • "requests-in-transit-late (past expected delivery window)" — `supply_request` has no expected-delivery
//     column (§3.1); "late" would have to be invented from `ordered_at` plus a guessed SLA, which would
//     flag vendors for a deadline nobody agreed to.
//   • "undeliverable-requests" — there is no `undeliverable` value in `m21_supply_request_status`. A failed
//     delivery is recorded as the request staying `in_transit` with a courier note, so the honest surface
//     is the age-in-status column on the queue, which is rendered.
import {
  DeniedState,
  ErrorState,
  LoadingSpinner,
  PageHeader,
  type ReadStatus,
  StatusPill,
  settleRead,
  t,
  useApiClient,
  useReloadFocus,
} from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import { HospiceCoverageBadge } from "../../shell/hospice-coverage";
import {
  type DispatchListItem,
  type ParStockView,
  type ReturnListItem,
  type SupplyRequestKind,
  type SupplyRequestListItem,
  type SupplyRequestStatus,
  listDispatches,
  listParStock,
  listReturns,
  listSupplyRequests,
} from "./supplies-api";
import {
  DISPATCH_STATUS_TONE,
  OPEN_REQUEST_STATUSES,
  PAR_SEVERITY_RANK,
  REQUEST_KINDS,
  REQUEST_STATUS_TONE,
  RETURN_STATE_TONE,
  ageInDays,
  deploymentSiteLabel,
  dueLabel,
  humanize,
  requestKindLabel,
  shortDate,
  shortId,
  toneOf,
} from "./supplies-status";
import {
  Card,
  CountGrid,
  FilterRow,
  Notice,
  ParSeverityPill,
  SelectField,
  columnStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  tdQty,
  th,
  thNum,
} from "./supplies-ui";

/** The §4.1 page cap for the request/dispatch/return lists. Named so the "at least" copy and the request
 *  agree — a hard-coded 100 in the query and a different literal in the sentence is how a KPI starts
 *  lying. */
const QUEUE_PAGE = 100;
/** The par list is a wider read (§4.1's catalog page size) — the shelf is browsed, not paged. */
const PAR_PAGE = 200;

const KIND_FILTERS = [{ value: "", label: "all kinds" }].concat(
  REQUEST_KINDS.map((k) => ({ value: k, label: requestKindLabel(k) })),
);
const STATUS_FILTERS = [
  { value: "", label: "open (default)" },
  ...OPEN_REQUEST_STATUSES.map((s) => ({ value: s, label: humanize(s) })),
];

/** One panel's read: denied (403) and failed (retry) are shown as such, never as the empty-list copy. */
function ReadPanel({
  status,
  subject,
  onRetry,
  children,
}: {
  status: ReadStatus;
  subject: string;
  onRetry: () => void;
  children: ReactNode;
}): JSX.Element {
  if (status === "denied") return <DeniedState subject={subject} />;
  if (status === "failed") {
    return (
      <ErrorState
        title={`${subject.charAt(0).toUpperCase()}${subject.slice(1)} could not be loaded`}
        description="Try again in a moment."
        onRetry={onRetry}
      />
    );
  }
  return <>{children}</>;
}

export function SupplyTeamDashboard(): JSX.Element {
  const client = useApiClient();
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [requests, setRequests] = useState<SupplyRequestListItem[]>([]);
  const [requestsTruncated, setRequestsTruncated] = useState(false);
  const [returns, setReturns] = useState<ReturnListItem[]>([]);
  const [par, setPar] = useState<ParStockView[]>([]);
  const [dispatches, setDispatches] = useState<DispatchListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const focusRef = useReloadFocus<HTMLDivElement>(loading);
  const [reqStatus, setReqStatus] = useState<ReadStatus>("ok");
  const [retStatus, setRetStatus] = useState<ReadStatus>("ok");
  const [parStatus, setParStatus] = useState<ReadStatus>("ok");
  const [dispStatus, setDispStatus] = useState<ReadStatus>("ok");

  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latestLoad.current;
    setLoading(true);
    // `status` and `openOnly` are mutually exclusive server-side semantics: naming a status IS the filter,
    // so `openOnly` only rides along when no explicit status was picked.
    // settleRead folds a rejected request (network/timeout) into a failed read, so the spinner always ends.
    const [reqs, rets, shelf, disp] = await Promise.all([
      settleRead(
        listSupplyRequests(client, {
          limit: QUEUE_PAGE,
          // `kind`/`status` are always "" or one of REQUEST_KINDS/OPEN_REQUEST_STATUSES — the SelectFields
          // below offer no other value.
          ...(kind ? { kind: kind as SupplyRequestKind } : {}),
          ...(status ? { status: status as SupplyRequestStatus } : { openOnly: true }),
        }),
      ),
      settleRead(listReturns(client, { limit: QUEUE_PAGE, openOnly: true })),
      settleRead(listParStock(client, { limit: PAR_PAGE, belowThresholdOnly: true })),
      settleRead(listDispatches(client, { limit: QUEUE_PAGE })),
    ]);
    if (mine !== latestLoad.current) return;
    // Each read is gated on ITS OWN permission key, so a coordinator who holds only the request read gets a
    // 403 on the other three. That must not blank the dashboard, and must not read as "nothing here" either:
    // each panel carries its own status, and a tile counts only when every read behind it succeeded.
    setRequests(reqs.res?.page?.data ?? []);
    setRequestsTruncated(reqs.res?.page?.has_more ?? false);
    setReturns(rets.res?.page?.data ?? []);
    setPar(shelf.res?.page?.data ?? []);
    setDispatches(disp.res?.page?.data ?? []);
    setReqStatus(reqs.status);
    setRetStatus(rets.status);
    setParStatus(shelf.status);
    setDispStatus(disp.status);
    setLoadedOnce(true);
    setLoading(false);
  }, [client, kind, status]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loadedOnce) return <LoadingSpinner />;

  const count = (readStatus: ReadStatus, n: number): number | null =>
    readStatus === "ok" ? n : null;
  const pendingVendor = requests.filter((r) => r.status === "requested").length;
  const inTransit = requests.filter((r) => r.status === "in_transit").length;
  const cancellationPending = requests.filter((r) => r.status === "cancellation_pending").length;
  // Overdue FIRST, then by due date — the point of a return worklist is what is most overdue.
  const openReturns = [...returns].sort(
    (x, y) => y.daysOverdue - x.daysOverdue || x.returnDueAt.localeCompare(y.returnDueAt),
  );
  const overdueReturns = returns.filter((r) => r.daysOverdue > 0).length;
  const discrepancies = dispatches.filter(
    (d) => d.dispatchStatus === "reconciled_with_discrepancy",
  );
  const criticalShelf = par.filter(
    (p) => p.severity === "critical_low" || p.severity === "depleted",
  ).length;

  const sortedPar = [...par].sort(
    (x, y) => (PAR_SEVERITY_RANK[x.severity] ?? 9) - (PAR_SEVERITY_RANK[y.severity] ?? 9),
  );

  return (
    <div
      ref={focusRef}
      tabIndex={-1}
      aria-busy={loading}
      className="wx-kit-column"
      style={{ ...columnStyle, outline: "none" }}
    >
      <PageHeader
        title={<span style={pageTitleStyle}>Supply team</span>}
        breadcrumb="Supplies, DME & comfort kits"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/supplies/dispatches/new" style={ghostButtonStyle}>
              Dispatch a kit
            </Link>
            <Link to="/supplies/par-stock" style={ghostButtonStyle}>
              Par stock
            </Link>
            <Link to="/supplies/items" style={ghostButtonStyle}>
              SKU catalog
            </Link>
          </div>
        }
      />

      {reqStatus === "ok" && requestsTruncated ? (
        <Notice tone="info">
          More than {QUEUE_PAGE} requests match this filter. The counts below are therefore "at
          least" — M21 publishes no aggregate route, so a tile counts the page it was given, never
          the whole tenant. Narrow the filters for an exact figure.
        </Notice>
      ) : null}

      <Card title="Queue">
        <CountGrid
          entries={[
            { label: "Awaiting vendor", value: count(reqStatus, pendingVendor) },
            { label: "In transit", value: count(reqStatus, inTransit) },
            { label: "Cancellation pending", value: count(reqStatus, cancellationPending) },
            { label: "Returns overdue", value: count(retStatus, overdueReturns) },
            {
              label: "Discrepancy reconciliations",
              value: count(dispStatus, discrepancies.length),
            },
            { label: "Shelf critical / empty", value: count(parStatus, criticalShelf) },
          ]}
        />
        <span style={mutedStyle}>
          "In-transit late" and "undeliverable" are not shown: `supply_request` carries no
          expected-delivery window and `m21_supply_request_status` has no undeliverable value, so
          both would have to be invented. The age-in-status column below is the real signal.
        </span>
      </Card>

      <FilterRow>
        <SelectField label="Kind" value={kind} options={KIND_FILTERS} onChange={setKind} />
        <SelectField label="Status" value={status} options={STATUS_FILTERS} onChange={setStatus} />
      </FilterRow>

      <Card title="Action queue">
        <ReadPanel status={reqStatus} subject="the supply worklist" onRetry={() => void load()}>
          {requests.length === 0 ? (
            <span style={mutedStyle}>
              Nothing needs supply-team action in this view — every open request has a vendor and is
              moving.
            </span>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Request</th>
                  <th style={th}>Kind</th>
                  <th style={th}>Patient</th>
                  <th style={th}>Status</th>
                  <th style={th}>Vendor</th>
                  <th style={th}>Tracking</th>
                  <th style={thNum}>Age (days)</th>
                  <th style={th}>Requested</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.supplyRequestId} style={rowLine}>
                    <td style={td}>
                      <Link to={`/supplies/requests/${r.supplyRequestId}`} style={linkStyle}>
                        {shortId(r.supplyRequestId)}
                      </Link>
                    </td>
                    <td style={td}>{requestKindLabel(r.kind)}</td>
                    <td style={td}>{shortId(r.patientId)}</td>
                    <td style={td}>
                      <span className="wx-coverage-cell">
                        <StatusPill
                          label={humanize(r.status)}
                          tone={toneOf(REQUEST_STATUS_TONE, r.status)}
                        />
                        <HospiceCoverageBadge coverage={r.hospiceCoverage} />
                      </span>
                    </td>
                    <td style={td}>{shortId(r.assignedVendorId)}</td>
                    <td style={td}>
                      {r.trackingNumber ? `${r.carrier ?? "—"} · ${r.trackingNumber}` : "—"}
                    </td>
                    <td style={tdNum}>{ageInDays(r.createdAt)}</td>
                    <td style={td}>{shortDate(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ReadPanel>
      </Card>

      <Card
        title="Par stock below watermark"
        actions={
          <Link to="/supplies/par-stock" style={linkStyle}>
            Open par admin
          </Link>
        }
      >
        <ReadPanel status={parStatus} subject="the par stock list" onRetry={() => void load()}>
          {sortedPar.length === 0 ? (
            <span style={mutedStyle}>Every active shelf row is at or above its reorder point.</span>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Item</th>
                  <th style={th}>Location</th>
                  <th style={th}>Band</th>
                  <th style={thNum}>On hand</th>
                  <th style={thNum}>Reorder point</th>
                  <th style={thNum}>Safety stock</th>
                  <th style={th}>Last counted</th>
                </tr>
              </thead>
              <tbody>
                {sortedPar.map((p) => (
                  <tr key={p.parStockId} style={rowLine}>
                    <td style={td}>{p.skuName}</td>
                    <td style={td}>{shortId(p.locationId)}</td>
                    <td style={td}>
                      <ParSeverityPill severity={p.severity} />
                    </td>
                    <td style={tdQty}>
                      {p.currentQuantity} {p.unit}
                    </td>
                    <td style={tdQty}>{p.reorderPoint}</td>
                    <td style={tdQty}>{p.minSafetyStock}</td>
                    <td style={td}>{shortDate(p.lastParReviewAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ReadPanel>
      </Card>

      {/* §4.1 publishes no standalone list SCREEN for returns or dispatches — the dashboard IS the index
          for both, which is why these two panels carry the whole open set rather than a preview. */}
      <Card
        title="Comfort-kit returns awaiting reconciliation"
        actions={
          overdueReturns > 0 ? (
            <StatusPill label={`${overdueReturns} overdue`} tone="error" />
          ) : undefined
        }
      >
        <ReadPanel status={retStatus} subject="the returns worklist" onRetry={() => void load()}>
          {openReturns.length === 0 ? (
            <span style={mutedStyle}>
              No comfort-kit return is open. A return row is created when the obligation ARISES (the
              patient died, the kit must come back) — long before anything is physically counted.
            </span>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Return</th>
                  <th style={th}>State</th>
                  <th style={th}>Patient</th>
                  <th style={th}>Due</th>
                  <th style={thNum}>Days overdue</th>
                  <th style={th}>Controlled</th>
                </tr>
              </thead>
              <tbody>
                {openReturns.map((r) => (
                  <tr key={r.returnId} style={rowLine}>
                    <td style={td}>
                      <Link to={`/supplies/returns/${r.returnId}`} style={linkStyle}>
                        {shortId(r.returnId)}
                      </Link>
                    </td>
                    <td style={td}>
                      <StatusPill
                        label={humanize(r.state)}
                        tone={toneOf(RETURN_STATE_TONE, r.state)}
                      />
                    </td>
                    <td style={td}>{shortId(r.patientId)}</td>
                    <td style={td}>
                      {shortDate(r.returnDueAt)} · {dueLabel(r.returnDueAt)}
                    </td>
                    <td style={tdNum}>{r.daysOverdue}</td>
                    <td style={td}>{r.containsControlledSubstance ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ReadPanel>
      </Card>

      <Card
        title="Comfort kits in the field"
        actions={
          <Link to="/supplies/dispatches/new" style={linkStyle}>
            Dispatch a kit
          </Link>
        }
      >
        <ReadPanel status={dispStatus} subject="the dispatch list" onRetry={() => void load()}>
          {dispatches.length === 0 ? (
            <span style={mutedStyle}>No comfort kit has been dispatched.</span>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Dispatch</th>
                  <th style={th}>Kit serial</th>
                  <th style={th}>Patient</th>
                  <th style={th}>Site</th>
                  <th style={th}>Status</th>
                  <th style={th}>Dispatched</th>
                  <th style={th}>Controlled</th>
                </tr>
              </thead>
              <tbody>
                {dispatches.map((d) => (
                  <tr key={d.dispatchId} style={rowLine}>
                    <td style={td}>
                      <Link to={`/supplies/dispatches/${d.dispatchId}`} style={linkStyle}>
                        {shortId(d.dispatchId)}
                      </Link>
                    </td>
                    <td style={{ ...td, fontFamily: t.fontMono }}>{d.kitSerialNumber}</td>
                    <td style={td}>{shortId(d.patientId)}</td>
                    <td style={td}>{deploymentSiteLabel(d.deploymentSite)}</td>
                    <td style={td}>
                      <StatusPill
                        label={humanize(d.dispatchStatus)}
                        tone={toneOf(DISPATCH_STATUS_TONE, d.dispatchStatus)}
                      />
                    </td>
                    <td style={td}>{shortDate(d.dispatchedAt)}</td>
                    <td style={td}>{d.containsControlledSubstance ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ReadPanel>
      </Card>

      <Card title="Reconciled with discrepancy">
        {dispStatus !== "ok" ? (
          <span style={mutedStyle}>
            Not shown: the dispatch list could not be read. See the "Comfort kits in the field"
            panel above.
          </span>
        ) : discrepancies.length === 0 ? (
          <span style={mutedStyle}>
            No dispatch in this page closed with an unexplained controlled-substance shortfall.
          </span>
        ) : (
          <>
            <Notice tone="error">
              A reconciliation that closed with a discrepancy has already raised the M30 survey
              investigation and the M36 high-severity alert. This list is the DISPATCH tail, not the
              investigation record — that lives in the compliance surface that owns it.
            </Notice>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Dispatch</th>
                  <th style={th}>Kit serial</th>
                  <th style={th}>Patient</th>
                  <th style={th}>Dispatched</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {discrepancies.map((d) => (
                  <tr key={d.dispatchId} style={rowLine}>
                    <td style={td}>
                      <Link to={`/supplies/dispatches/${d.dispatchId}`} style={linkStyle}>
                        {shortId(d.dispatchId)}
                      </Link>
                    </td>
                    <td style={{ ...td, fontFamily: t.fontMono }}>{d.kitSerialNumber}</td>
                    <td style={td}>{shortId(d.patientId)}</td>
                    <td style={td}>{shortDate(d.dispatchedAt)}</td>
                    <td style={td}>
                      <StatusPill label="Discrepancy" tone="error" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </div>
  );
}

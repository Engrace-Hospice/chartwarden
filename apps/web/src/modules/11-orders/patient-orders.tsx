import {
  CountdownChip,
  EmptyState,
  Glyph,
  type GlyphName,
  LoadingSpinner,
  Modal,
  Panel,
  PatientWorkspaceLayout,
  StatusPill,
  type StatusTone,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/11-orders — the patient chart's Orders tab (2026-09-25 redesign, mockup
// "Orders"). Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ORDERS.md — "Use Patient Workspace."
// KPI cards, order-kind tabs, a labeled filter bar, and the orders table (order · type · details ·
// prescriber · start date · status); under it the orders that need a signature and the M11 queues;
// the right rail carries Patient Summary, Active Diagnoses and Recent Orders. The list route carries
// only the order header, so each row's name and details are read from its detail route (the kind
// payload) and the prescriber name from MDM. Order sets, imaging, referrals and allergies are not
// modeled in ChartWarden, so they are not drawn. The server owns every status (ADR-0030).
import { useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import {
  ActiveDiagnosesPanel,
  ChartBanner,
  PatientSummaryPanel,
  useChartIdentity,
} from "../../shell/patient-context";
import { OrderEditor } from "./order-editor";
import { ORDER_TONE, PRIORITY_TONE, stateLabel } from "./orders-status";

type Kind =
  | "lab"
  | "dme"
  | "level_of_care_change"
  | "recertification"
  | "comfort_kit"
  | "supply"
  | "ancillary_service"
  | "idg_requested";

interface OrderRow {
  id: string;
  patientId: string;
  kind: Kind;
  status: string;
  priority: string;
  orderingPhysicianMdmId: string;
  drafterDiscipline: string;
  cosignRequired: boolean;
  cosignStatus: string | null;
  verbalDeadlineAt: string | null;
  discontinuationReason: string | null;
  signedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}
type KindData = Record<string, unknown>;

// Detail reads are one request per order; the newest ones cover every realistic hospice chart.
const DETAIL_LIMIT = 50;
const PENDING = ["pending_signature", "verbal_pending"];
const DAY = 86_400_000;

const KIND_META: Record<Kind, { tab: string; type: string; icon: GlyphName; color: string }> = {
  lab: {
    tab: "Laboratory",
    type: "Lab",
    icon: "flask",
    color: "var(--color-viz-violet)",
  },
  dme: { tab: "DME", type: "DME", icon: "bed", color: "var(--color-viz-blue)" },
  comfort_kit: {
    tab: "Comfort Kits",
    type: "Comfort Kit",
    icon: "package",
    color: "var(--color-viz-teal)",
  },
  supply: {
    tab: "Supplies",
    type: "Supply",
    icon: "package",
    color: "var(--color-viz-cyan)",
  },
  ancillary_service: {
    tab: "Services",
    type: "Service",
    icon: "stethoscope",
    color: "var(--color-viz-blue)",
  },
  level_of_care_change: {
    tab: "Level of Care",
    type: "Level of Care",
    icon: "activity",
    color: "var(--color-viz-orange)",
  },
  recertification: {
    tab: "Recertification",
    type: "Recertification",
    icon: "file-check",
    color: "var(--color-viz-green)",
  },
  idg_requested: {
    tab: "IDG Requests",
    type: "IDG Request",
    icon: "users",
    color: "var(--color-viz-rose)",
  },
};
const KINDS = Object.keys(KIND_META) as Kind[];

// The mockup reads completed orders blue and discontinued ones red; the rest follow the M11 taxonomy.
const ROW_TONE: Record<string, StatusTone> = {
  ...ORDER_TONE,
  completed: "progress",
  discontinued: "error",
};
const DOT_COLOR: Record<string, string> = {
  active: t.success,
  completed: t.primary,
  discontinued: t.error,
  expired_unsigned: t.error,
};

const LEVELS: Record<string, string> = {
  rhc: "Routine Home Care",
  irc: "Inpatient Respite",
  chc: "Continuous Home Care",
  gip: "General Inpatient",
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function usDate(value: string | null | undefined): string {
  if (!value) return "—";
  // Date-only values are calendar dates, not UTC midnights.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

const startOf = (o: OrderRow): string => o.signedAt ?? o.createdAt;

function labName(data: KindData | undefined): string {
  const codes = Array.isArray(data?.testCodes) ? (data.testCodes as { display?: string }[]) : [];
  return codes
    .map((c) => str(c.display))
    .filter(Boolean)
    .join(", ");
}

/** The row title — the clinical thing ordered when the kind payload names it, else the kind. */
function orderName(o: OrderRow, data: KindData | undefined): string {
  if (o.status === "discontinued" && data) return `Discontinue ${baseName(o, data)}`;
  return baseName(o, data);
}
function baseName(o: OrderRow, data: KindData | undefined): string {
  switch (o.kind) {
    case "lab":
      return labName(data) || "Lab order";
    case "level_of_care_change": {
      const to = LEVELS[str(data?.toLevel)];
      return to ? `Change to ${to}` : "Level-of-care change";
    }
    case "comfort_kit":
      return "Comfort Kit";
    case "recertification":
      return "Recertification";
    case "idg_requested":
      return str(data?.requestedKind) ? `IDG: ${str(data?.requestedKind)}` : "IDG request";
    default:
      return (
        str(data?.itemName) ||
        str(data?.description) ||
        str(data?.name) ||
        `${KIND_META[o.kind].type} order`
      );
  }
}

/** Two short lines of kind-specific detail, read from the order's payload. */
function orderDetails(o: OrderRow, data: KindData | undefined): [string, string] {
  if (!data) return ["…", ""];
  switch (o.kind) {
    case "lab": {
      const codes = Array.isArray(data.testCodes) ? (data.testCodes as { code?: string }[]) : [];
      const first = [
        codes.length ? `LOINC ${codes.map((c) => c.code).join(", ")}` : "",
        data.fastingRequired ? "Fasting" : "",
        stateLabel(str(data.priority) || o.priority),
      ]
        .filter(Boolean)
        .join(" · ");
      return [first, str(data.clinicalJustification) || str(data.collectionInstructions)];
    }
    case "level_of_care_change":
      return [
        `${str(data.fromLevel).toUpperCase() || "—"} → ${str(data.toLevel).toUpperCase() || "—"}${
          str(data.effectiveAt) ? ` · effective ${usDate(str(data.effectiveAt))}` : ""
        }`,
        str(data.clinicalJustification),
      ];
    case "comfort_kit":
      return [
        [str(data.kitSku) ? `Kit ${str(data.kitSku)}` : "", stateLabel(str(data.deploymentSite))]
          .filter(Boolean)
          .join(" · "),
        str(data.notes),
      ];
    case "recertification":
      return [
        str(data.periodEndDate) ? `Period ends ${usDate(str(data.periodEndDate))}` : "",
        "Certification of terminal illness",
      ];
    case "idg_requested":
      return [str(data.narrative), str(data.recommendedTimeframe)];
    default:
      return [
        str(data.notes) || str(data.instructions),
        o.discontinuationReason ? stateLabel(o.discontinuationReason) : "",
      ];
  }
}

type RangeKey = "all" | "7" | "30" | "90";

export function PatientOrders(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const identity = useChartIdentity(patientId);
  const [items, setItems] = useState<OrderRow[]>([]);
  const [details, setDetails] = useState<Record<string, KindData>>({});
  const [physicians, setPhysicians] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createChoiceOpen, setCreateChoiceOpen] = useState(false);
  const [createVerbal, setCreateVerbal] = useState(false);
  const [verbalOpen, setVerbalOpen] = useState(false);

  const [kind, setKind] = useState<Kind | "all">("all");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [prescriber, setPrescriber] = useState("");
  const [range, setRange] = useState<RangeKey>("all");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey re-runs the load on "Try again" / after a save.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    if (!patientId) {
      setError("Patient ID is missing.");
      setLoading(false);
      return () => {
        active = false;
      };
    }
    void (async () => {
      try {
        const { data, error: requestError } = await client.GET("/api/v1/orders", {
          params: { query: { patientId } },
        });
        if (!active) return;
        if (requestError) throw new Error("Request failed");
        const orders = ((data?.orders ?? []) as OrderRow[]).sort((a, b) =>
          startOf(b).localeCompare(startOf(a)),
        );
        setItems(orders);
        setLoading(false);

        // Enrichment: the kind payload (order name + details) and the ordering physician's name.
        const recent = orders.slice(0, DETAIL_LIMIT);
        void Promise.all(
          recent.map((o) =>
            client
              .GET("/api/v1/orders/{id}", { params: { path: { id: o.id } } })
              .then((r) => [o.id, (r.data as { data?: KindData } | undefined)?.data ?? {}] as const)
              .catch(() => [o.id, {}] as const),
          ),
        ).then((pairs) => {
          if (active) setDetails(Object.fromEntries(pairs));
        });
        const mdmIds = [...new Set(orders.map((o) => o.orderingPhysicianMdmId).filter(Boolean))];
        void Promise.all(
          mdmIds.map((id) =>
            client
              .GET("/api/v1/mdm/{kind}/{id}", {
                params: { path: { kind: "physician", id } },
              })
              .then((r) => [id, r.data?.canonical.displayName ?? ""] as const)
              .catch(() => [id, ""] as const),
          ),
        ).then((pairs) => {
          if (active) setPhysicians(Object.fromEntries(pairs.filter(([, name]) => name)));
        });
      } catch {
        if (active) {
          setError("Could not load orders for this patient.");
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, retryKey]);

  const prescriberOf = (o: OrderRow): string => physicians[o.orderingPhysicianMdmId] ?? "—";

  const kpis = useMemo(() => {
    const since = (days: number, v: string | null) =>
      v ? Date.parse(v) >= Date.now() - days * DAY : false;
    const activeOrders = items.filter((o) => o.status === "active");
    return {
      active: activeOrders.length,
      newActive: activeOrders.filter((o) => since(7, startOf(o))).length,
      urgent: activeOrders.filter((o) => o.priority !== "routine").length,
      pending: items.filter((o) => PENDING.includes(o.status)).length,
      verbal: items.filter((o) => o.status === "verbal_pending").length,
      completed: items.filter((o) => o.status === "completed" && since(30, o.completedAt)).length,
      discontinued: items.filter((o) => o.status === "discontinued").length,
    };
  }, [items]);

  const kindCounts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const o of items) c[o.kind] = (c[o.kind] ?? 0) + 1;
    return c;
  }, [items]);

  const prescriberNames = useMemo(
    () => [...new Set(Object.values(physicians))].sort((a, b) => a.localeCompare(b)),
    [physicians],
  );

  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const cutoff = range === "all" ? 0 : Date.now() - Number(range) * DAY;
    return items.filter((o) => {
      if (kind !== "all" && o.kind !== kind) return false;
      if (status && o.status !== status) return false;
      if (priority && o.priority !== priority) return false;
      if (prescriber && physicians[o.orderingPhysicianMdmId] !== prescriber) return false;
      if (cutoff && Date.parse(startOf(o)) < cutoff) return false;
      if (!needle) return true;
      const d = details[o.id];
      return [
        orderName(o, d),
        ...orderDetails(o, d),
        KIND_META[o.kind].type,
        physicians[o.orderingPhysicianMdmId] ?? "",
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [items, details, physicians, kind, status, priority, prescriber, range, search]);

  // Any filter change goes back to the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the filters are the trigger, not inputs.
  useEffect(() => setPage(0), [kind, status, priority, prescriber, range, search, pageSize]);

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const pageRows = rows.slice(page * pageSize, page * pageSize + pageSize);
  const filtered = Boolean(search || status || priority || prescriber || range !== "all");
  const clearFilters = () => {
    setSearch("");
    setStatus("");
    setPriority("");
    setPrescriber("");
    setRange("all");
  };

  const attention = items.filter(
    (o) => PENDING.includes(o.status) || o.status === "draft" || o.cosignStatus === "pending",
  );

  return (
    <PatientWorkspaceLayout
      banner={
        identity ? (
          <ChartBanner
            nameAsHeading
            identity={identity}
            actions={
              <>
                <Link to={`/patients/${patientId}`} className="wx-btn-secondary">
                  <Glyph name="file-text" size={16} /> View Patient Chart
                </Link>
                {/* <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setVerbalOpen(true)}
                  disabled={!patientId}
                >
                  <Glyph name="phone" size={16} /> Verbal Order
                </button> */}

                <button
                  type="button"
                  className="wx-btn-primary"
                  onClick={() => setCreateChoiceOpen(true)}
                  disabled={!patientId}
                >
                  <Glyph name="plus" size={16} /> New Order
                </button>
              </>
            }
          />
        ) : (
          <div className="wx-patient-banner" aria-busy="true" style={{ minHeight: "6.25rem" }} />
        )
      }
      rail={
        patientId ? (
          <>
            <PatientSummaryPanel identity={identity} />
            <ActiveDiagnosesPanel patientId={patientId} />
            <RecentOrdersPanel items={items} details={details} />
          </>
        ) : undefined
      }
    >
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {patientId ? <ChartModuleRail patientId={patientId} current="orders" /> : null}
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "0.5rem 1.5rem 1.5rem",
            minWidth: 0,
          }}
        >
          <section className="wx-chart-section" aria-label="Orders" aria-busy={loading}>
            <div className="wx-subtabs wx-subtabs-scroll" role="tablist" aria-label="Order type">
              {(["all", ...KINDS] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={kind === k}
                  onClick={() => setKind(k)}
                >
                  {k === "all" ? "Orders" : KIND_META[k].tab}
                  {kindCounts[k] ? (
                    <span className="wx-seg-count wx-nums">{kindCounts[k]}</span>
                  ) : null}
                </button>
              ))}
            </div>

            <div className="wx-stat-grid" aria-label="Order summary">
              <StatCard
                icon="clipboard-check"
                color={t.primary}
                value={kpis.active}
                label="Active Orders"
                hint={`${kpis.newActive} new · ${kpis.urgent} STAT/ASAP`}
              />
              <StatCard
                icon="clock"
                color="var(--color-viz-violet)"
                value={kpis.pending}
                label="Pending Signature"
                hint={
                  kpis.verbal ? `${kpis.verbal} verbal · 48h window` : "Physician review needed"
                }
              />
              <StatCard
                icon="check-circle"
                color={t.success}
                value={kpis.completed}
                label="Completed"
                hint="In last 30 days"
              />
              <StatCard
                icon="x-circle"
                color={t.error}
                value={kpis.discontinued}
                label="Discontinued"
                hint="All time"
              />
            </div>

            <div className="wx-filter-panel">
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  aria-label="Search orders"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search orders, tests, or prescribers…"
                />
              </label>
              <FilterSelect label="Status" value={status} onChange={setStatus}>
                <option value="">All</option>
                {[
                  "active",
                  "pending_signature",
                  "verbal_pending",
                  "draft",
                  "completed",
                  "discontinued",
                  "expired_unsigned",
                ].map((s) => (
                  <option key={s} value={s}>
                    {stateLabel(s)}
                  </option>
                ))}
              </FilterSelect>
              <FilterSelect label="Priority" value={priority} onChange={setPriority}>
                <option value="">All</option>
                <option value="routine">Routine</option>
                <option value="asap">ASAP</option>
                <option value="stat">STAT</option>
              </FilterSelect>
              <FilterSelect label="Prescriber" value={prescriber} onChange={setPrescriber}>
                <option value="">All</option>
                {prescriberNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </FilterSelect>
              <FilterSelect
                label="Date Range"
                value={range}
                onChange={(v) => setRange(v as RangeKey)}
              >
                <option value="all">All</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
              </FilterSelect>
              {filtered ? (
                <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
                  <Glyph name="filter" size={15} /> Clear filters
                </button>
              ) : null}
            </div>

            {loading ? (
              <LoadingSpinner />
            ) : error ? (
              <div className="wx-list-state">
                <EmptyState title="Orders unavailable" description={error} />
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setRetryKey((k) => k + 1)}
                >
                  Try again
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="wx-list-state">
                <EmptyState
                  title={filtered ? "No matching orders" : "No orders"}
                  description={
                    filtered
                      ? "Try a different search or clear the filters."
                      : kind === "all"
                        ? "There are no orders for this patient yet."
                        : `There are no ${KIND_META[kind].tab.toLowerCase()} orders for this patient.`
                  }
                />
                {filtered ? (
                  <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
                    Clear filters
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="wx-list-table-wrap">
                <table className="wx-list-table wx-list-table-static">
                  <caption className="wx-sr-only">Orders for this patient</caption>
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Type</th>
                      <th scope="col">Details</th>
                      <th scope="col">Prescriber</th>
                      <th scope="col">Start Date</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="wx-sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((o) => {
                      const d = details[o.id];
                      const [line1, line2] = orderDetails(o, d);
                      const meta = KIND_META[o.kind];
                      const ended = o.status === "discontinued";
                      return (
                        <tr key={o.id}>
                          <td>
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.625rem",
                              }}
                            >
                              <span
                                aria-hidden
                                style={{
                                  color: ended ? t.error : meta.color,
                                  display: "flex",
                                }}
                              >
                                <Glyph
                                  name={ended ? "block" : meta.icon}
                                  size={20}
                                  strokeWidth={1.75}
                                />
                              </span>
                              <Link to={`/orders/${o.id}`} className="wx-row-title">
                                {orderName(o, d)}
                              </Link>
                            </span>
                          </td>
                          <td>{meta.type}</td>
                          <td style={{ maxWidth: "18rem" }}>
                            <div>{line1 || "—"}</div>
                            {line2 ? <div className="wx-row-sub">{line2}</div> : null}
                          </td>
                          <td>{prescriberOf(o)}</td>
                          <td className="wx-nums">{usDate(startOf(o))}</td>
                          <td>
                            <div
                              style={{
                                display: "grid",
                                gap: "0.25rem",
                                justifyItems: "start",
                              }}
                            >
                              <StatusPill
                                label={stateLabel(o.status)}
                                tone={ROW_TONE[o.status] ?? "neutral"}
                              />
                              {o.priority !== "routine" ? (
                                <StatusPill
                                  label={o.priority.toUpperCase()}
                                  tone={PRIORITY_TONE[o.priority] ?? "neutral"}
                                />
                              ) : null}
                              {o.status === "verbal_pending" && o.verbalDeadlineAt ? (
                                <CountdownChip
                                  dueAt={o.verbalDeadlineAt}
                                  warnWithinHours={12}
                                  alertWithinHours={2}
                                  label="Sign"
                                />
                              ) : null}
                            </div>
                          </td>
                          <td>
                            <Link
                              to={`/orders/${o.id}`}
                              className="wx-icon-link"
                              aria-label={`Open ${orderName(o, d)}`}
                            >
                              <Glyph name="more-horizontal" size={18} />
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="wx-table-footer">
                  <span className="wx-nums">
                    Showing {page * pageSize + 1}–{Math.min(rows.length, (page + 1) * pageSize)} of{" "}
                    {rows.length} orders
                  </span>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                    }}
                  >
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                      }}
                    >
                      Rows per page
                      <select
                        className="wx-select"
                        value={pageSize}
                        onChange={(e) => setPageSize(Number(e.target.value))}
                      >
                        {[10, 25, 50].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                    {pageCount > 1 ? (
                      <>
                        <button
                          type="button"
                          className="wx-icon-link"
                          aria-label="Previous page"
                          disabled={page === 0}
                          onClick={() => setPage((p) => p - 1)}
                        >
                          <Glyph name="chevron-left" size={18} />
                        </button>
                        <button
                          type="button"
                          className="wx-icon-link"
                          aria-label="Next page"
                          disabled={page >= pageCount - 1}
                          onClick={() => setPage((p) => p + 1)}
                        >
                          <Glyph name="chevron-right" size={18} />
                        </button>
                      </>
                    ) : null}
                  </span>
                </div>
              </div>
            )}

            <div className="wx-orders-foot">
              <AttentionCard items={attention} details={details} />
              <OrderActions pending={kpis.pending} onCreate={() => setCreateChoiceOpen(true)} />
            </div>
          </section>
        </div>
      </div>
      <OrderEditor
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        patientId={patientId ?? ""}
        verbal={createVerbal}
        onSaved={() => {
          setCreateOpen(false);
          setRetryKey((k) => k + 1);
        }}
      />
      <Modal
        open={createChoiceOpen}
        onClose={() => setCreateChoiceOpen(false)}
        ariaLabel="Create order"
        width="30rem"
      >
        <div style={createChoiceBody}>
          <div>
            <h2 style={{ margin: 0 }}>Create an order</h2>
            <p style={createChoiceHint}>Choose how the order was received.</p>
          </div>
          <button
            type="button"
            style={createChoiceOption}
            onClick={() => {
              setCreateChoiceOpen(false);
              setCreateVerbal(false);
              setCreateOpen(true);
            }}
          >
            <span aria-hidden style={createChoiceIcon}>
              <Glyph name="file-text" size={20} />
            </span>
            <span style={createChoiceCopy}>
              <strong>Standard order</strong>
              <span>Create and send a standard clinical order for signature.</span>
            </span>
            <Glyph name="chevron-right" size={18} />
          </button>
          <button
            type="button"
            style={createChoiceOption}
            onClick={() => {
              setCreateChoiceOpen(false);
              setCreateVerbal(true);
              setCreateOpen(true);
            }}
          >
            <span aria-hidden style={createChoiceIcon}>
              <Glyph name="phone" size={20} />
            </span>
            <span style={createChoiceCopy}>
              <strong>Verbal order</strong>
              <span>Document an order received verbally from a practitioner.</span>
            </span>
            <Glyph name="chevron-right" size={18} />
          </button>
          <div style={createChoiceFooter}>
            <button
              type="button"
              className="wx-btn-secondary"
              onClick={() => setCreateChoiceOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </PatientWorkspaceLayout>
  );
}

const createChoiceBody = {
  padding: "1.5rem",
  display: "grid",
  gap: "0.75rem",
  minWidth: 0,
} as const;
const createChoiceHint = {
  margin: "0.35rem 0 0",
  color: t.onSurfaceVariant,
  fontSize: "0.875rem",
} as const;
const createChoiceOption = {
  display: "grid",
  gridTemplateColumns: "2.5rem minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "0.75rem",
  width: "100%",
  minWidth: 0,
  padding: "1rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.75rem",
  background: "var(--color-surface-container-low)",
  color: "var(--color-on-surface)",
  cursor: "pointer",
  textAlign: "left" as const,
} as const;
const createChoiceIcon = {
  display: "grid",
  placeItems: "center",
  width: "2.5rem",
  height: "2.5rem",
  borderRadius: "0.625rem",
  color: t.primary,
  background: t.primaryTint,
} as const;
const createChoiceCopy = {
  display: "grid",
  minWidth: 0,
  gap: "0.2rem",
  lineHeight: 1.35,
} as const;
const createChoiceFooter = {
  display: "flex",
  justifyContent: "flex-end",
  marginTop: "0.25rem",
} as const;

function StatCard({
  icon,
  color,
  value,
  label,
  hint,
}: {
  icon: GlyphName;
  color: string;
  value: number;
  label: string;
  hint: string;
}): JSX.Element {
  return (
    <div className="wx-stat-card">
      <span
        aria-hidden
        className="wx-stat-icon"
        style={{
          color,
          background: `color-mix(in srgb, ${color} 12%, ${t.surfaceLowest})`,
          borderRadius: "9999px",
        }}
      >
        <Glyph name={icon} size={24} strokeWidth={1.6} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="wx-stat-label">{label}</div>
        <strong className="wx-stat-value wx-nums">{value}</strong>
        <div className="wx-stat-label">{hint}</div>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="wx-filter-field">
      <span>{label}</span>
      <select className="wx-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

/** Stands in for the mockup's "Order Sets" card, which ChartWarden does not model: the orders waiting on someone. */
function AttentionCard({
  items,
  details,
}: {
  items: OrderRow[];
  details: Record<string, KindData>;
}): JSX.Element {
  const reason = (o: OrderRow): string =>
    o.status === "verbal_pending"
      ? "Verbal order — sign within 48h"
      : o.status === "pending_signature"
        ? "Awaiting physician signature"
        : o.cosignStatus === "pending"
          ? "Awaiting RN cosignature"
          : "Draft — not yet sent for signature";
  return (
    <section className="wx-foot-card" aria-labelledby="orders-attention">
      <header>
        <span style={{ color: t.primary }}>
          <Glyph name="alert-circle" size={22} strokeWidth={1.75} />
        </span>
        <div>
          <h2 id="orders-attention">Needs Attention</h2>
          <p>Orders waiting on a signature, cosignature, or completion.</p>
        </div>
      </header>
      {items.length === 0 ? (
        <p className="wx-row-sub" style={{ margin: 0 }}>
          Nothing is waiting on a signature for this patient.
        </p>
      ) : (
        <div className="wx-attention-grid">
          {items.slice(0, 3).map((o) => (
            <div key={o.id} className="wx-attention-item">
              <strong>{orderName(o, details[o.id])}</strong>
              <span className="wx-row-sub">{reason(o)}</span>
              {o.status === "verbal_pending" && o.verbalDeadlineAt ? (
                <CountdownChip
                  dueAt={o.verbalDeadlineAt}
                  warnWithinHours={12}
                  alertWithinHours={2}
                  label="Sign"
                />
              ) : null}
              <Link to={`/orders/${o.id}`} className="wx-btn-secondary wx-btn-sm">
                Review
              </Link>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function OrderActions({
  pending,
  onCreate,
}: {
  pending: number;
  onCreate: () => void;
}): JSX.Element {
  const links: { label: string; icon: GlyphName; to: string }[] = [
    { label: `Signature Inbox (${pending})`, icon: "pencil", to: "/orders" },
    { label: "Cosign Queue", icon: "users", to: "/orders/cosign-pending" },
    {
      label: "Results Review",
      icon: "flask",
      to: "/orders/results-pending-review",
    },
    { label: "Standing Orders", icon: "file-check", to: "/standing-orders" },
  ];
  return (
    <section className="wx-foot-card" aria-labelledby="orders-actions">
      <header>
        <span style={{ color: t.primary }}>
          <Glyph name="clipboard-list" size={22} strokeWidth={1.75} />
        </span>
        <div>
          <h2 id="orders-actions">Order Actions</h2>
        </div>
      </header>
      <ul className="wx-action-list">
        <li>
          <button type="button" onClick={onCreate}>
            <Glyph name="plus" size={16} /> Create New Order
          </button>
        </li>
        {links.map((l) => (
          <li key={l.label}>
            <Link to={l.to}>
              <Glyph name={l.icon} size={16} /> {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentOrdersPanel({
  items,
  details,
}: {
  items: OrderRow[];
  details: Record<string, KindData>;
}): JSX.Element {
  const recent = items.slice(0, 5);
  return (
    <Panel title="Recent Orders" icon="clipboard-check">
      {recent.length === 0 ? (
        <p
          style={{
            margin: 0,
            color: t.onSurfaceVariant,
            fontSize: "0.8125rem",
          }}
        >
          No orders yet.
        </p>
      ) : (
        <ul className="wx-recent-orders">
          {recent.map((o) => {
            const ended = o.status === "discontinued";
            return (
              <li key={o.id}>
                <span aria-hidden style={{ color: ended ? t.error : KIND_META[o.kind].color }}>
                  <Glyph
                    name={ended ? "block" : KIND_META[o.kind].icon}
                    size={18}
                    strokeWidth={1.75}
                  />
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <Link to={`/orders/${o.id}`}>{orderName(o, details[o.id])}</Link>
                  <span className="wx-row-sub wx-nums">{usDate(startOf(o))}</span>
                </span>
                <span
                  className="wx-status-dot"
                  title={stateLabel(o.status)}
                  style={{ background: DOT_COLOR[o.status] ?? t.warning }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

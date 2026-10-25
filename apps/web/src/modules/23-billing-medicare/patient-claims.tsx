import {
  EmptyState,
  Glyph,
  type GlyphName,
  KpiCard,
  LoadingSpinner,
  OffsetPagination,
  Panel,
  PatientWorkspaceLayout,
  StatusPill,
  type StatusTone,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/23-billing-medicare — the patient chart's Claims tab (M23, Track B / ADR-0030;
// 2026-09-25 redesign, mockup "Billing / Claims" patient variant). Every claim billed for one patient:
// four headline cards, a payer switch (All · Medicare · Medicaid), and a claims table, with a right rail
// of the patient summary and the patient's NOE / NOTR filing notices.
//   GET /api/v1/billing/claims?patientId  → Medicare claims (carry billed + expected payment).
//   GET /api/v1/medicaid-claims?patientId → Medicaid claims (the list row carries no amounts).
//   GET /api/v1/noe-records|notr-records?patientId → the filing notices in the rail.
// Paid amounts and patient responsibility live on remittance lines, which the browser cannot read per
// claim (the patient-responsibility ledger is a system-only seam), so the cards show billed, the expected
// payment on paid claims, pending and denied — not remitted dollars. Every read is org-scoped server-side
// (RLS); the server is the only authz point (ADR-0030).
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { ChartBanner, PatientSummaryPanel, useChartIdentity } from "../../shell/patient-context";
import { claimStateTone, dollars, statusLabel } from "./billing-status";
import { PatientWorkPanel } from "./patient-work-panel";

interface MedicareClaim {
  claimId: string;
  tob: string;
  state: string;
  serviceFrom: string;
  serviceTo: string;
  claimControlNumber: string;
  macJurisdiction: string;
  totalChargeCents: number;
  totalExpectedPaymentCents: number;
  attention?: { flags: readonly string[] } | null;
}
interface MedicaidClaim {
  id: string;
  serviceState: string;
  kind: string;
  tob: string;
  serviceFrom: string;
  serviceTo: string;
  medicaidClaimControlNumber: string;
  state: string;
}
interface Notice {
  id: string;
  kind: "NOE" | "NOTR";
  state: string;
  controlNumber: string;
  effective: string;
  windowTargetAt: string;
  windowBreachedAt: string | null;
}
/** One table row, either payer. Medicaid rows have no amounts on the list read. */
interface Row {
  id: string;
  payer: "Medicare" | "Medicaid";
  controlNumber: string;
  serviceFrom: string;
  serviceTo: string;
  state: string; // lower-cased
  tone: StatusTone;
  detail: string;
  /** Medicare only: the claim needs a biller's action because of how the stay ended. */
  attention: string | null;
  billedCents: number | null;
  expectedCents: number | null;
  to: string;
}
type Load<T> = T | null | "error";
type Payer = "all" | "Medicare" | "Medicaid";

const PAID = new Set(["paid", "partial_paid"]);
const PENDING = new Set([
  "submitted",
  "polling",
  "ack_pending",
  "ack_accepted",
  "ack_partial",
  "ack_timeout",
]);
const INERT = new Set(["replaced", "voided", "abandoned"]);
const PAGE_SIZES = [10, 20, 50];

// Medicaid's claim machine has states Medicare's lacks; everything shared resolves through the M23 map.
const MEDICAID_EXTRA_TONE: Record<string, StatusTone> = {
  failed_validation: "error",
  awaiting_medicare_primary: "warning",
  failed_medicare_primary: "error",
  polling: "progress",
  ack_timeout: "warning",
  ack_rejected: "error",
  abandoned: "neutral",
};
const TOB_SHORT: Record<string, string> = {
  "811": "Admit–discharge",
  "812": "Interim · first",
  "813": "Interim · continuing",
  "814": "Interim · last",
  "817": "Replacement",
  "818": "Void",
};

/** The "needs attention" line under a Medicare claim's state (the claim editor explains and resolves it). */
function attentionLabel(flags: readonly string[] | undefined): string | null {
  if (!flags || flags.length === 0) return null;
  const parts = [
    flags.includes("missing_discharge_details") ? "Missing discharge details" : null,
    flags.includes("tob_changed") ? "Type of bill changed" : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

const ymd = (v: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const md = (d: Date) =>
  `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
function servicePeriod(from: string, to: string): string {
  const a = ymd(from);
  const b = ymd(to);
  return a && b ? `${md(a)} – ${md(b)}/${b.getFullYear()}` : "—";
}
const shortDate = (v: string): string => {
  const d = ymd(v);
  return d ? `${md(d)}/${d.getFullYear()}` : "—";
};
const wholeDollars = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

type Page<T> = { items?: T[]; nextCursor?: string | null; hasMore?: boolean };

export function PatientClaims(): JSX.Element {
  const { patientId } = useParams<{ patientId: string }>();
  const client = useApiClient();
  const identity = useChartIdentity(patientId);
  const [medicare, setMedicare] = useState<Load<MedicareClaim[]>>(null);
  const [medicaid, setMedicaid] = useState<Load<MedicaidClaim[]>>(null);
  const [notices, setNotices] = useState<Load<Notice[]>>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [payer, setPayer] = useState<Payer>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0] as number);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey re-runs the load on "Retry".
  useEffect(() => {
    if (!patientId) return;
    let active = true;
    setMedicare(null);
    setMedicaid(null);
    setNotices(null);
    // A patient's claims fit in one 200-row page; a longer history would need paging here.
    const query = { patientId, limit: 200 };
    void client
      .GET("/api/v1/billing/claims", { params: { query } } as never)
      .then((r) => {
        if (active) setMedicare(r.error ? "error" : ((r.data as Page<MedicareClaim>)?.items ?? []));
      })
      .catch(() => active && setMedicare("error"));
    void client
      .GET("/api/v1/medicaid-claims", { params: { query } } as never)
      .then((r) => {
        if (active) setMedicaid(r.error ? "error" : ((r.data as Page<MedicaidClaim>)?.items ?? []));
      })
      .catch(() => active && setMedicaid("error"));
    void Promise.all([
      client.GET("/api/v1/noe-records", { params: { query: { patientId } } } as never),
      client.GET("/api/v1/notr-records", { params: { query: { patientId } } } as never),
    ])
      .then(([noe, notr]) => {
        if (!active) return;
        if (noe.error && notr.error) return setNotices("error");
        const noes = ((noe.data as unknown as Page<Record<string, string>>)?.items ?? []).map(
          (n): Notice => ({
            id: n.noeId as string,
            kind: "NOE",
            state: n.state as string,
            controlNumber: n.noeControlNumber as string,
            effective: n.electionEffectiveDate as string,
            windowTargetAt: n.windowTargetAt as string,
            windowBreachedAt: n.windowBreachedAt ?? null,
          }),
        );
        const notrs = ((notr.data as unknown as Page<Record<string, string>>)?.items ?? []).map(
          (n): Notice => ({
            id: n.notrId as string,
            kind: "NOTR",
            state: n.state as string,
            controlNumber: n.notrControlNumber as string,
            effective: n.effectiveEndDate as string,
            windowTargetAt: n.windowTargetAt as string,
            windowBreachedAt: n.windowBreachedAt ?? null,
          }),
        );
        setNotices(
          [...noes, ...notrs].sort((a, b) => (b.effective ?? "").localeCompare(a.effective ?? "")),
        );
      })
      .catch(() => active && setNotices("error"));
    return () => {
      active = false;
    };
  }, [client, patientId, retryKey]);

  const rows = useMemo<Row[]>(() => {
    const a = (Array.isArray(medicare) ? medicare : []).map(
      (c): Row => ({
        id: c.claimId,
        payer: "Medicare",
        controlNumber: c.claimControlNumber,
        serviceFrom: c.serviceFrom,
        serviceTo: c.serviceTo,
        state: c.state,
        tone: claimStateTone(c.state),
        detail: `${TOB_SHORT[c.tob] ?? `TOB ${c.tob}`} · ${c.macJurisdiction}`,
        attention: attentionLabel(c.attention?.flags),
        billedCents: c.totalChargeCents,
        expectedCents: c.totalExpectedPaymentCents,
        to: `/billing/claims/${c.claimId}`,
      }),
    );
    const b = (Array.isArray(medicaid) ? medicaid : []).map((c): Row => {
      const state = c.state.toLowerCase();
      return {
        id: c.id,
        payer: "Medicaid",
        controlNumber: c.medicaidClaimControlNumber,
        serviceFrom: c.serviceFrom,
        serviceTo: c.serviceTo,
        state,
        tone: MEDICAID_EXTRA_TONE[state] ?? claimStateTone(state),
        detail: `${TOB_SHORT[c.tob] ?? `TOB ${c.tob}`} · ${c.serviceState}`,
        attention: null,
        billedCents: null,
        expectedCents: null,
        to: `/medicaid/billing/claims/${c.id}`,
      };
    });
    return [...a, ...b].sort((x, y) => y.serviceFrom.localeCompare(x.serviceFrom));
  }, [medicare, medicaid]);

  const loading = medicare === null || medicaid === null;
  const bothFailed = medicare === "error" && medicaid === "error";
  const counts = {
    all: rows.length,
    Medicare: rows.filter((r) => r.payer === "Medicare").length,
    Medicaid: rows.filter((r) => r.payer === "Medicaid").length,
  };

  // Cards: Medicare amounts only (the Medicaid list carries none); replaced/voided claims don't count.
  const live = Array.isArray(medicare) ? medicare.filter((c) => !INERT.has(c.state)) : [];
  const billed = live.reduce((n, c) => n + c.totalChargeCents, 0);
  const paid = live.filter((c) => PAID.has(c.state));
  const pending = live.filter((c) => PENDING.has(c.state));
  const deniedCount = rows.filter((r) => r.state === "denied").length;

  const q = search.trim().toLowerCase();
  const visible = rows.filter(
    (r) =>
      (payer === "all" || r.payer === payer) &&
      (!q ||
        r.controlNumber.toLowerCase().includes(q) ||
        statusLabel(r.state).toLowerCase().includes(q)),
  );
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const current = Math.min(page, pages);
  const pageRows = visible.slice((current - 1) * pageSize, current * pageSize);

  return (
    <PatientWorkspaceLayout
      banner={
        identity ? (
          <ChartBanner
            nameAsHeading
            identity={identity}
            actions={
              <Link to={`/patients/${patientId}`} className="wx-btn-secondary">
                <Glyph name="file-text" size={16} /> View Patient Chart
              </Link>
            }
          />
        ) : (
          <div
            className="wx-patient-banner"
            aria-busy="true"
            style={{ minHeight: "6.25rem", background: t.surfaceLowest }}
          />
        )
      }
      rail={
        patientId ? (
          <>
            <PatientSummaryPanel identity={identity} />
            <PatientWorkPanel key={patientId} patientId={patientId} />
            <NoticesPanel notices={notices} />
          </>
        ) : undefined
      }
    >
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {patientId ? <ChartModuleRail patientId={patientId} current="claims" /> : null}
        <div style={{ flex: 1, overflow: "auto", padding: "0.5rem 1.5rem 1.5rem", minWidth: 0 }}>
          <section className="wx-chart-section" aria-label="Claims" aria-busy={loading}>
            <div className="wx-subtabs" role="tablist" aria-label="Payer">
              {(["all", "Medicare", "Medicaid"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={payer === p}
                  onClick={() => {
                    setPayer(p);
                    setPage(1);
                  }}
                >
                  {p === "all" ? "Claims" : p}
                  {counts[p] ? <span className="wx-seg-count wx-nums">{counts[p]}</span> : null}
                </button>
              ))}
            </div>

            <div className="wx-stat-grid" aria-label="Claim summary">
              <Kpi
                icon="file-text"
                color={t.primary}
                label="Total Billed"
                value={medicare === "error" ? "—" : medicare ? wholeDollars(billed) : "…"}
                hint={
                  medicare === "error"
                    ? "Unavailable"
                    : `${live.length} Medicare claim${live.length === 1 ? "" : "s"}`
                }
              />
              <Kpi
                icon="check-circle"
                color={t.success}
                label="Paid Claims"
                value={
                  medicare === "error"
                    ? "—"
                    : medicare
                      ? wholeDollars(paid.reduce((n, c) => n + c.totalExpectedPaymentCents, 0))
                      : "…"
                }
                hint={`Expected payment · ${paid.length} paid`}
              />
              <Kpi
                icon="clock"
                color={t.warning}
                label="Pending"
                value={
                  medicare === "error"
                    ? "—"
                    : medicare
                      ? wholeDollars(pending.reduce((n, c) => n + c.totalChargeCents, 0))
                      : "…"
                }
                hint={`${pending.length} awaiting payment`}
                accent={pending.length > 0}
              />
              <Kpi
                icon="x-circle"
                color={t.error}
                label="Denied"
                value={loading ? "…" : String(deniedCount)}
                hint={deniedCount > 0 ? "Worked in Denials" : "No denials"}
                accent={deniedCount > 0}
              />
            </div>

            <div className="wx-filter-panel">
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  aria-label="Search claims"
                  placeholder="Search by claim # or status…"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
            </div>

            {loading ? (
              <div className="wx-list-state">
                <LoadingSpinner />
              </div>
            ) : bothFailed ? (
              <div className="wx-list-state">
                <EmptyState
                  title="Claims unavailable"
                  description="This patient's claims could not be loaded."
                />
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => setRetryKey((k) => k + 1)}
                >
                  Retry
                </button>
              </div>
            ) : visible.length === 0 ? (
              <div className="wx-list-state">
                <EmptyState
                  title={rows.length === 0 ? "No claims yet" : "No matching claims"}
                  description={
                    rows.length === 0
                      ? "Claims appear here once a billing period is assembled for this patient."
                      : "Try a different search or payer."
                  }
                />
              </div>
            ) : (
              <div className="wx-list-table-wrap">
                <table className="wx-list-table wx-list-table-static">
                  <caption className="wx-sr-only">Claims</caption>
                  <thead>
                    <tr>
                      <th>Claim #</th>
                      <th>From – To</th>
                      <th>Payer</th>
                      <th>Status</th>
                      <th style={{ textAlign: "right" }}>Billed</th>
                      <th style={{ textAlign: "right" }}>Expected</th>
                      <th>
                        <span className="wx-sr-only">Open</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => (
                      <tr key={`${r.payer}-${r.id}`}>
                        <td className="wx-nums">
                          <Link to={r.to} className="wx-row-title">
                            {r.controlNumber}
                          </Link>
                        </td>
                        <td className="wx-nums">{servicePeriod(r.serviceFrom, r.serviceTo)}</td>
                        <td>
                          {r.payer}
                          <div className="wx-row-sub">{r.detail}</div>
                        </td>
                        <td>
                          <StatusPill label={statusLabel(r.state)} tone={r.tone} />
                          {r.attention ? (
                            <div className="wx-row-sub">
                              <Link to={r.to}>{r.attention}</Link>
                            </div>
                          ) : null}
                        </td>
                        <td className="wx-nums" style={{ textAlign: "right" }}>
                          {r.billedCents === null ? "—" : dollars(r.billedCents)}
                        </td>
                        <td className="wx-nums" style={{ textAlign: "right" }}>
                          {r.expectedCents === null ? "—" : dollars(r.expectedCents)}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <Link
                            to={r.to}
                            className="wx-icon-link"
                            aria-label={`Open claim ${r.controlNumber}`}
                          >
                            <Glyph name="chevron-right" size={18} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <OffsetPagination
                  page={current}
                  pageSize={pageSize}
                  totalItems={visible.length}
                  onPageChange={setPage}
                  onPageSizeChange={(size) => {
                    setPageSize(size);
                    setPage(1);
                  }}
                  pageSizeOptions={PAGE_SIZES}
                  noun="claims"
                />
              </div>
            )}
            {medicare === "error" || medicaid === "error" ? (
              <p className="wx-row-sub" style={{ margin: "0.75rem 0 0" }}>
                {medicare === "error" ? "Medicare" : "Medicaid"} claims could not be loaded; the
                table shows the other payer only.
              </p>
            ) : null}
            {counts.Medicaid > 0 ? (
              <p className="wx-row-sub" style={{ margin: "0.75rem 0 0", fontSize: "0.75rem" }}>
                Medicaid amounts are on each claim's detail page. Totals above are Medicare only.
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

// The shared stat card (label · value · detail), like every other summary row in the app.
function Kpi({
  icon,
  color,
  label,
  value,
  hint,
}: {
  icon: GlyphName;
  color: string;
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}): JSX.Element {
  return <KpiCard icon={icon} accentColor={color} label={label} value={value} detail={hint} />;
}

function NoticesPanel({ notices }: { notices: Load<Notice[]> }): JSX.Element {
  return (
    <Panel title="Filing Notices" icon="calendar-check">
      {notices === null ? (
        <LoadingSpinner />
      ) : notices === "error" ? (
        <p className="wx-rail-empty" style={{ padding: 0 }}>
          Filing notices are unavailable.
        </p>
      ) : notices.length === 0 ? (
        <p className="wx-rail-empty" style={{ padding: 0 }}>
          No NOE or NOTR filed for this patient.
        </p>
      ) : (
        <ul className="wx-rail-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {notices.map((n) => {
            const open = !["ack_accepted", "cancelled", "ack_rejected"].includes(n.state);
            const breached = open && Boolean(n.windowBreachedAt);
            const days = Math.floor((Date.parse(n.windowTargetAt) - Date.now()) / 86_400_000);
            const tone: StatusTone =
              n.state === "ack_accepted"
                ? "success"
                : n.state === "ack_rejected" || breached
                  ? "error"
                  : open && days <= 2
                    ? "warning"
                    : open
                      ? "progress"
                      : "neutral";
            return (
              <li
                key={`${n.kind}-${n.id}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.5rem 0",
                  borderBottom: `1px solid ${t.cardBorder}`,
                }}
              >
                <span style={{ display: "grid", minWidth: 0 }}>
                  <Link
                    to={`/billing/${n.kind.toLowerCase()}/${n.id}`}
                    className="wx-row-title"
                    style={{ fontSize: "0.875rem" }}
                  >
                    {n.kind} · {n.controlNumber}
                  </Link>
                  <span className="wx-row-sub wx-nums" style={{ fontSize: "0.75rem" }}>
                    {n.kind === "NOE" ? "Election" : "End"} {shortDate(n.effective)}
                    {open && !breached && Number.isFinite(days) ? ` · ${days}d left` : ""}
                  </span>
                </span>
                <StatusPill label={breached ? "Breached" : statusLabel(n.state)} tone={tone} />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

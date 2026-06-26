import {
  cardSurface,
  CountdownChip,
  EmptyState,
  ghostBorder,
  Glyph,
  LeftNavRail,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/11-orders — patient orders (M11 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Patient Workspace."
// Matched to the P1 Pencil frame (wardenx-P1-clinical.pen `pQiC0`): a Patient Workspace (banner + module
// rail) over an orders table | a right rail with the selected order's detail. Every order for the patient
// with its §2.2 D2 lifecycle status, kind, priority, and (for verbal_pending) the live 48h deadline. The
// server owns the authoritative status (ADR-0030, no frontend authz). Reads GET /api/v1/orders?patientId
// (+ the patient summary for the banner). Honest gap: the list carries the order KIND, not the clinical
// order text (drug/dose) the frame shows — that lives on the order detail (/orders/:id) — so rows label by
// kind, never a fabricated drug name.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ORDER_TONE, PRIORITY_TONE, stateLabel } from "./orders-status";

interface OrderRow {
  id: string;
  patientId: string;
  kind: string;
  status: string;
  priority: string;
  verbalDeadlineAt: string | null;
  createdAt: string;
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

type NavIconName = "summary" | "carePlan" | "stethoscope" | "checklist" | "orders" | "pill" | "folder" | "idg";
const NAV_ICON_PATHS: Record<NavIconName, string> = {
  summary: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  carePlan: "M9 4h6v3H9z M7 5H5v15h14V5h-2 M9 11h6 M9 15h4",
  stethoscope: "M6 4v5a4 4 0 0 0 8 0V4 M10 16a4 4 0 0 0 8 0v-2 M18 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  checklist: "M4 6h9 M4 12h9 M4 18h9 M17 5l1.5 1.5L21 4 M17 11l1.5 1.5L21 10",
  orders: "M7 3h7l4 4v14H7z M14 3v4h4 M10 13h5 M10 17h5",
  pill: "M5 13l8-8a4 4 0 0 1 6 6l-8 8a4 4 0 0 1-6-6z M9 9l6 6",
  folder: "M3 6h6l2 2h10v11H3z",
  idg: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 19c0-3 2.7-5 6-5s6 2 6 5 M16 11a3 3 0 0 0 0-6 M15 14c3 .2 5 2.2 5 5",
};
function NavIcon({ name }: { name: NavIconName }): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
      <path d={NAV_ICON_PATHS[name]} />
    </svg>
  );
}
const NAV_ITEMS: { label: string; icon: NavIconName; current?: boolean }[] = [
  { label: "Summary", icon: "summary" },
  { label: "Care Plan", icon: "carePlan" },
  { label: "Encounters", icon: "stethoscope" },
  { label: "Assessments", icon: "checklist" },
  { label: "Orders", icon: "orders", current: true },
  { label: "Medications", icon: "pill" },
  { label: "Documents", icon: "folder" },
  { label: "IDG History", icon: "idg" },
];

export function PatientOrders(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<OrderRow[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const [oRes, pRes] = await Promise.all([
      client.GET("/api/v1/orders", { params: { query: { patientId } } }),
      client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
    ]);
    if (pRes.data) setPatient(pRes.data as PatientSummary);
    if (oRes.error) {
      setError("Could not load orders for this patient.");
      setLoading(false);
      return;
    }
    setItems((oRes.data?.orders ?? []) as OrderRow[]);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const visible = status ? items.filter((o) => o.status === status) : items;
    return [...visible].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [items, status]);

  const selected = items.find((o) => o.id === selectedId) ?? null;

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""}`}
      chips={
        <>
          <MonoChip>{patient.mrn}</MonoChip>
          <StatusPill label={stateLabel(patient.status)} tone={ORDER_TONE[patient.status] ?? "neutral"} />
        </>
      }
    />
  ) : (
    <PatientBanner name="Orders" />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {/* Module nav rail */}
        <LeftNavRail ariaLabel="Patient modules">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.125rem" }}>
            {NAV_ITEMS.map((it) => {
              const inner = (<><NavIcon name={it.icon} />{it.label}</>);
              return (
                <li key={it.label}>
                  {it.current ? (
                    <span style={{ ...navItem, ...navItemActive }} aria-current="page">{inner}</span>
                  ) : (
                    <Link to={`/patients/${patientId}`} style={navItem}>{inner}</Link>
                  )}
                </li>
              );
            })}
          </ul>
        </LeftNavRail>

        {/* Center — orders table */}
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", marginBottom: "1rem" }}>
            <h1 style={{ margin: 0, fontFamily: t.fontDisplay, fontWeight: 500, fontSize: "1.375rem", color: t.onSurface }}>Orders</h1>
            <select aria-label="Order status" value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
              <option value="">Any status</option>
              <option value="draft">Draft</option>
              <option value="pending_signature">Pending Signature</option>
              <option value="verbal_pending">Verbal Pending</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="discontinued">Discontinued</option>
              <option value="expired_unsigned">Expired Unsigned</option>
            </select>
          </div>

          {error ? (
            <EmptyState title="Unavailable" description={error} />
          ) : loading && items.length === 0 ? (
            <LoadingSpinner />
          ) : rows.length === 0 ? (
            <EmptyState title="No orders" description="No orders match the current filter." />
          ) : (
            <section style={{ ...cardSurface, padding: "0 1.25rem" }}>
              <div style={{ ...orderRow, color: t.muted, borderTop: "none", cursor: "default" }}>
                <span style={{ flex: 1 }}>Order · kind</span>
                <span style={col}>Priority</span>
                <span style={col}>Status</span>
                <span style={col}>Verbal</span>
              </div>
              {rows.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setSelectedId(o.id)}
                  aria-pressed={o.id === selectedId}
                  style={{ ...orderRow, borderTop: ghostBorder, background: o.id === selectedId ? t.primaryTint : "transparent" }}
                >
                  <span style={{ flex: 1, minWidth: 0, textAlign: "left", color: t.onSurface, fontWeight: 600 }}>
                    {stateLabel(o.kind)}
                    <span style={dateMeta}> · {o.createdAt.slice(0, 10)}</span>
                  </span>
                  <span style={col}><StatusPill label={stateLabel(o.priority)} tone={PRIORITY_TONE[o.priority] ?? "neutral"} /></span>
                  <span style={col}><StatusPill label={stateLabel(o.status)} tone={ORDER_TONE[o.status] ?? "neutral"} /></span>
                  <span style={col}>
                    {o.status === "verbal_pending" && o.verbalDeadlineAt ? (
                      <CountdownChip dueAt={o.verbalDeadlineAt} warnWithinHours={12} alertWithinHours={2} label="Sign" />
                    ) : (
                      <span style={{ color: t.muted }}>—</span>
                    )}
                  </span>
                </button>
              ))}
            </section>
          )}
        </div>

        {/* Right rail — selected order detail */}
        <aside style={rightRail}>
          {selected ? (
            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={railTitle}>{stateLabel(selected.kind)}</h2>
              <dl style={detailGrid}>
                <dt style={dt}>Status</dt>
                <dd style={dd}><StatusPill label={stateLabel(selected.status)} tone={ORDER_TONE[selected.status] ?? "neutral"} /></dd>
                <dt style={dt}>Priority</dt>
                <dd style={dd}><StatusPill label={stateLabel(selected.priority)} tone={PRIORITY_TONE[selected.priority] ?? "neutral"} /></dd>
                <dt style={dt}>Ordered</dt>
                <dd style={{ ...dd }} className="tabular-nums">{selected.createdAt.slice(0, 16).replace("T", " ")}</dd>
                {selected.status === "verbal_pending" && selected.verbalDeadlineAt ? (
                  <>
                    <dt style={dt}>Verbal</dt>
                    <dd style={dd}><CountdownChip dueAt={selected.verbalDeadlineAt} warnWithinHours={12} alertWithinHours={2} label="Sign within" /></dd>
                  </>
                ) : null}
              </dl>
              <button type="button" onClick={() => navigate(`/orders/${selected.id}`)} style={{ ...primaryBtn, marginTop: "1rem", width: "100%" }}>
                Open order
              </button>
            </div>
          ) : (
            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={railTitle}>Order detail</h2>
              <p style={meta}>Select an order to see its status, priority, and verbal-order window here.</p>
            </div>
          )}
        </aside>
      </div>
    </PatientWorkspaceLayout>
  );
}

function ageYears(dob: string): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 150 ? a : null;
}
function MonoChip({ children }: { children: ReactNode }): JSX.Element {
  return <span style={{ fontFamily: t.fontMono, fontSize: "0.78rem", color: t.onSurfaceVariant, background: t.surfaceContainer, borderRadius: "9999px", padding: "0.15rem 0.55rem" }}>{children}</span>;
}

const navItem: CSSProperties = { display: "flex", alignItems: "center", gap: "0.625rem", padding: "0.5rem 0.75rem", borderRadius: "0.5rem", fontSize: "0.8125rem", fontWeight: 500, textDecoration: "none", color: t.onSurfaceVariant };
const navItemActive: CSSProperties = { background: t.primaryTint, color: t.primary, fontWeight: 600 };
const rightRail: CSSProperties = { width: "19rem", flexShrink: 0, overflow: "auto", padding: "1.5rem", background: t.surfaceLow };
const railTitle: CSSProperties = { margin: "0 0 0.625rem", fontFamily: t.fontDisplay, fontWeight: 500, fontSize: "1rem", color: t.onSurface };
const orderRow: CSSProperties = { display: "flex", alignItems: "center", gap: "0.75rem", width: "100%", padding: "0.75rem 0", border: "none", background: "transparent", cursor: "pointer", fontSize: "0.85rem" };
const col: CSSProperties = { width: "8rem", flexShrink: 0, display: "flex", alignItems: "center" };
const dateMeta: CSSProperties = { color: t.muted, fontWeight: 400, fontSize: "0.78rem" };
const selectStyle: CSSProperties = { padding: "0.4rem 0.6rem", borderRadius: t.radiusMd, border: "none", background: t.surfaceLow, color: t.onSurface, fontSize: "0.85rem" };
const detailGrid: CSSProperties = { display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: "0.5rem 1rem", margin: 0, fontSize: "0.8rem" };
const dt: CSSProperties = { fontWeight: 600, color: t.onSurfaceVariant };
const dd: CSSProperties = { margin: 0, color: t.onSurface };
const primaryBtn: CSSProperties = { padding: "0.5rem 1rem", borderRadius: "9999px", background: t.primary, color: t.onPrimary, fontSize: "0.8125rem", fontWeight: 600, border: "none", cursor: "pointer" };
const meta: CSSProperties = { fontSize: "0.78rem", color: t.onSurfaceVariant, margin: "0.25rem 0 0" };

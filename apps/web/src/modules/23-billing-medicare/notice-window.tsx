import {
  CountdownChip,
  DetailPageLayout,
  EmptyState,
  FilterBar,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — shared NOE / NOTR filing-window surface (R2, §5.1 #11–14,
// §10 PR-J). NOE (Notice of Election) and NOTR (Notice of Termination/Revocation) are structurally identical:
// a state-grouped Work Queue of records, each racing a CMS 5-day filing window (the `windowTargetAt`
// deadline, with `windowBreachedAt` set once it lapses), plus a detail surface with submit + cancel
// actions. They differ only in the wire path (`/api/v1/noe-records` vs `/api/v1/notr-records`) and labels —
// so the queue and detail are authored ONCE here and parameterized by a `NoticeWindowConfig`; the four
// registered screens (noe-queue / noe-detail / notr-queue / notr-detail) are thin wrappers.
//
// Lantern: WorkQueueLayout + FilterBar + No-Line table (§6.7) + RightDetailPanel for the queue; DetailPageLayout
// for the detail. Every window tier renders through billing-status.ts (§6.6) and a §7.5 CountdownChip clock
// to `windowTargetAt`. CSS-var tokens only, mono identifiers, tabular figures. The server is the only authz
// point (ADR-0030): a 503 (seams unbound) degrades to EmptyState; a write 412 (If-Match) / 422 (validation) /
// 401-403 (step-up) surfaces inline (role="alert"), never a toast.
//
// §5.4 accessibility: the countdown timers carry NON-VISUAL equivalents — a visually-hidden aria-live region
// updates `polite` as the window approaches its threshold and `assertive` once a record breaches.
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  dollars,
  noeNotrStateTone,
  statusLabel,
  windowTierLabel,
  windowTierTone,
} from "./billing-status";

// ── config (the only NOE↔NOTR difference) ─────────────────────────────────────────────────────────────
export interface NoticeWindowConfig {
  /** Short acronym for headers/labels, e.g. "NOE". */
  acronym: string;
  /** Full name for prose, e.g. "Notice of Election". */
  longName: string;
  /** Collection list/create path, e.g. "/api/v1/noe-records". */
  listPath: string;
  /** Detail path template, e.g. "/api/v1/noe-records/{id}". */
  detailPath: string;
  /** Submit action path template. */
  submitPath: string;
  /** Cancel action path template. */
  cancelPath: string;
  /** Web route base (no /app prefix — repo convention), e.g. "/billing/noe". */
  routeBase: string;
}

export const NOE_CONFIG: NoticeWindowConfig = {
  acronym: "NOE",
  longName: "Notice of Election",
  listPath: "/api/v1/noe-records",
  detailPath: "/api/v1/noe-records/{id}",
  submitPath: "/api/v1/noe-records/{id}/submit",
  cancelPath: "/api/v1/noe-records/{id}/cancel",
  routeBase: "/billing/noe",
};

export const NOTR_CONFIG: NoticeWindowConfig = {
  acronym: "NOTR",
  longName: "Notice of Termination / Revocation",
  listPath: "/api/v1/notr-records",
  detailPath: "/api/v1/notr-records/{id}",
  submitPath: "/api/v1/notr-records/{id}/submit",
  cancelPath: "/api/v1/notr-records/{id}/cancel",
  routeBase: "/billing/notr",
};

// ── wire shape (openapi emits no response schema for billing; model the fields the surface reads) ───────
interface NoticeRecord {
  // The backend keys the id as `id`, `noeRecordId`, or `notrRecordId` depending on the route shape; accept all.
  id?: string;
  noeRecordId?: string;
  notrRecordId?: string;
  state: string;
  patientId?: string | null;
  providerEntityId?: string | null;
  windowTargetAt: string | null;
  windowBreachedAt: string | null;
  effectiveDate?: string | null;
  admissionDate?: string | null;
  submittedAt?: string | null;
  payerControlNumber?: string | null;
  totalChargeCents?: number | null;
  version: number;
}

interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// Terminal notice states have left the filing window — they don't contribute to window posture.
const TERMINAL_STATES = new Set([
  "ack_accepted",
  "accepted",
  "cancelled",
  "ack_rejected",
  "rejected",
]);

function recordId(rec: NoticeRecord): string {
  return rec.id ?? rec.noeRecordId ?? rec.notrRecordId ?? "";
}

// Days remaining until the filing window closes (negative = breached). A row already flagged
// `windowBreachedAt` is breached regardless of the wall clock; a row with no target is treated as open.
function daysRemaining(rec: NoticeRecord): number {
  if (rec.windowBreachedAt) return -1;
  if (!rec.windowTargetAt) return Number.POSITIVE_INFINITY;
  return Math.floor((new Date(rec.windowTargetAt).getTime() - Date.now()) / 86_400_000);
}

function isActive(rec: NoticeRecord): boolean {
  return !TERMINAL_STATES.has(rec.state);
}

interface WindowPosture {
  inWindow: number;
  atRisk: number;
  breached: number;
  total: number;
}

function summarize(records: NoticeRecord[]): WindowPosture {
  let inWindow = 0;
  let atRisk = 0;
  let breached = 0;
  for (const r of records) {
    if (!isActive(r)) continue;
    const d = daysRemaining(r);
    if (d < 0) breached += 1;
    else if (d <= 2) atRisk += 1;
    else inWindow += 1;
  }
  return { inWindow, atRisk, breached, total: records.length };
}

// ── QUEUE (§5.1 #11 / #13) ────────────────────────────────────────────────────────────────────────────
export function NoticeWindowQueue({ config }: { config: NoticeWindowConfig }): JSX.Element {
  const client = useApiClient();
  const [records, setRecords] = useState<NoticeRecord[]>([]);
  const [stateFilter, setStateFilter] = useState("");
  const [selected, setSelected] = useState<NoticeRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // The list path is config-chosen at runtime, so the typed GET collapses to `never`; cast the read. The
    // server (re)parses the request and remains the authoritative org-scoped (RLS) + authz boundary.
    const { data, error: err } = (await client.GET(config.listPath as never)) as {
      data?: unknown;
      error?: unknown;
    };
    if (err) {
      setError(
        `${config.acronym} queue unavailable — the billing read seam is not bound, or you lack scope.`,
      );
      setLoading(false);
      return;
    }
    setRecords(((data as ListPage<NoticeRecord>)?.items ?? []) as NoticeRecord[]);
    setLoading(false);
  }, [client, config]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = stateFilter ? records.filter((r) => r.state === stateFilter) : records;
  const posture = summarize(records);
  const states = Array.from(new Set(records.map((r) => r.state))).sort();

  // §5.4 non-visual countdown equivalent: assertive once anything has breached, polite while only at-risk.
  const liveTone: "assertive" | "polite" = posture.breached > 0 ? "assertive" : "polite";
  const liveMessage =
    posture.breached > 0
      ? `${posture.breached} ${config.acronym} ${posture.breached === 1 ? "record has" : "records have"} breached the filing window; ${posture.atRisk} at risk.`
      : posture.atRisk > 0
        ? `${posture.atRisk} ${config.acronym} ${posture.atRisk === 1 ? "record is" : "records are"} at risk of breaching the filing window.`
        : `All ${config.acronym} filing windows are within range.`;

  return (
    <WorkQueueLayout
      header={
        <PageHeader title={`${config.acronym} Queue`} breadcrumb={`Billing — ${config.longName}`} />
      }
      kpis={
        <KpiStrip>
          <KpiCard label="In window" value={posture.inWindow} />
          <KpiCard label="At risk" value={posture.atRisk} />
          <KpiCard label="Breached" value={posture.breached} />
          <KpiCard label={`Total ${config.acronym}`} value={posture.total} />
        </KpiStrip>
      }
      filters={
        <FilterBar>
          <select
            aria-label={`${config.acronym} state`}
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            style={selectStyle}
          >
            <option value="">All states</option>
            {states.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <VisuallyHiddenLive tone={liveTone} message={liveMessage} />
        </FilterBar>
      }
      table={
        loading ? (
          <LoadingSpinner />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={`No ${config.acronym} records`}
            description={`No ${config.longName} records match the current filter in your scope.`}
          />
        ) : (
          <NoticeTable
            records={visible}
            config={config}
            selectedId={selected ? recordId(selected) : null}
            onSelect={setSelected}
          />
        )
      }
      detail={
        selected ? (
          <RightDetailPanel title={`${config.acronym} preview`} onClose={() => setSelected(null)}>
            <NoticePreview record={selected} config={config} onChanged={() => void load()} />
          </RightDetailPanel>
        ) : undefined
      }
    />
  );
}

// ── No-Line queue table (§6.7), grouped by state, most-urgent-first within each group ──────────────────
function NoticeTable({
  records,
  config,
  selectedId,
  onSelect,
}: {
  records: NoticeRecord[];
  config: NoticeWindowConfig;
  selectedId: string | null;
  onSelect: (r: NoticeRecord) => void;
}): JSX.Element {
  // Group by state; within a group, sort by days-remaining ascending (closest to breach surfaces first).
  const groups = new Map<string, NoticeRecord[]>();
  for (const r of records) {
    const bucket = groups.get(r.state) ?? [];
    bucket.push(r);
    groups.set(r.state, bucket);
  }
  for (const bucket of groups.values()) bucket.sort((a, b) => daysRemaining(a) - daysRemaining(b));
  const orderedStates = Array.from(groups.keys()).sort();

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
          <th style={thStyle}>Record</th>
          <th style={thStyle}>State</th>
          <th style={thStyle}>Window</th>
          <th style={thStyle}>Countdown</th>
          <th style={thStyle}>Target</th>
        </tr>
      </thead>
      {orderedStates.map((state) => (
        <tbody key={state}>
          <tr>
            <th
              colSpan={5}
              style={{
                textAlign: "left",
                padding: "0.6rem 0.75rem 0.3rem",
                fontSize: "0.7rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--color-on-surface-variant)",
              }}
            >
              {statusLabel(state)} · {groups.get(state)?.length ?? 0}
            </th>
          </tr>
          {(groups.get(state) ?? []).map((r, i) => {
            const id = recordId(r);
            const days = daysRemaining(r);
            const finite = Number.isFinite(days);
            return (
              <tr
                key={id}
                // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                role="button"
                tabIndex={0}
                aria-pressed={id === selectedId}
                onClick={() => onSelect(r)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelect(r);
                  }
                }}
                style={{
                  cursor: "pointer",
                  background:
                    id === selectedId
                      ? "var(--color-primary-tint)"
                      : i % 2 === 1
                        ? "var(--color-surface-low)"
                        : "transparent",
                }}
              >
                <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{id || "—"}</td>
                <td style={tdStyle}>
                  <StatusPill label={statusLabel(r.state)} tone={noeNotrStateTone(r.state)} />
                </td>
                <td style={tdStyle}>
                  {finite ? (
                    <StatusPill label={windowTierLabel(days)} tone={windowTierTone(days)} />
                  ) : (
                    <span style={{ color: "var(--color-on-surface-variant)" }}>No window</span>
                  )}
                </td>
                <td style={tdStyle}>
                  {r.windowTargetAt && isActive(r) ? (
                    <CountdownChip
                      dueAt={r.windowBreachedAt ?? r.windowTargetAt}
                      label="File by"
                      warnWithinHours={48}
                      alertWithinHours={24}
                    />
                  ) : (
                    <span style={{ color: "var(--color-on-surface-variant)" }}>—</span>
                  )}
                </td>
                <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                  {r.windowTargetAt ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}

// ── right-panel preview (queue) ───────────────────────────────────────────────────────────────────────
function NoticePreview({
  record,
  config,
  onChanged,
}: {
  record: NoticeRecord;
  config: NoticeWindowConfig;
  onChanged: () => void;
}): JSX.Element {
  const id = recordId(record);
  const days = daysRemaining(record);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Field label="Record" value={id || "—"} mono />
      <Field
        label="State"
        value={
          <StatusPill label={statusLabel(record.state)} tone={noeNotrStateTone(record.state)} />
        }
      />
      {record.windowTargetAt && isActive(record) ? (
        <Field
          label="Filing window"
          value={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
              <StatusPill label={windowTierLabel(days)} tone={windowTierTone(days)} />
              <CountdownChip
                dueAt={record.windowBreachedAt ?? record.windowTargetAt}
                label="File by"
                warnWithinHours={48}
                alertWithinHours={24}
              />
            </span>
          }
        />
      ) : null}
      {record.patientId ? <Field label="Patient" value={record.patientId} mono /> : null}
      {record.providerEntityId ? (
        <Field label="Provider entity" value={record.providerEntityId} mono />
      ) : null}
      {record.effectiveDate ? <Field label="Effective date" value={record.effectiveDate} /> : null}
      <NoticeActions record={record} config={config} onChanged={onChanged} compact />
      <a
        href={`${config.routeBase}/${id}`}
        style={{ fontSize: "0.8rem", color: "var(--color-primary)" }}
      >
        Open detail →
      </a>
    </div>
  );
}

// ── DETAIL (§5.1 #12 / #14) ───────────────────────────────────────────────────────────────────────────
export function NoticeWindowDetail({
  config,
  id,
}: {
  config: NoticeWindowConfig;
  id: string;
}): JSX.Element {
  const client = useApiClient();
  const [record, setRecord] = useState<NoticeRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Detail path + the id are config/route-chosen at runtime → the typed GET collapses to `never`; cast it.
    const { data, error: err } = (await client.GET(
      config.detailPath as never,
      {
        params: { path: { id } },
      } as never,
    )) as { data?: unknown; error?: unknown; response?: Response };
    if (err) {
      setError(
        `${config.acronym} record unavailable — the billing read seam is not bound, or you lack scope.`,
      );
      setLoading(false);
      return;
    }
    setRecord(data as NoticeRecord);
    setLoading(false);
  }, [client, config, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !record)
    return <EmptyState title="Unavailable" description={error ?? "No record."} />;

  const days = daysRemaining(record);
  const finite = Number.isFinite(days);
  // §5.4 non-visual countdown equivalent for the single record.
  const liveTone: "assertive" | "polite" = finite && days < 0 ? "assertive" : "polite";
  const liveMessage = !finite
    ? `This ${config.acronym} record has no active filing window.`
    : days < 0
      ? `This ${config.acronym} record has breached its filing window by ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"}.`
      : `This ${config.acronym} record has ${days} ${days === 1 ? "day" : "days"} left in its filing window.`;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={`${config.acronym} ${recordId(record)}`}
          breadcrumb={`Billing — ${config.longName}`}
        />
      }
      aside={
        <aside style={asideStyle}>
          <h3 style={asideTitleStyle}>Filing window</h3>
          {finite ? (
            <>
              <StatusPill label={windowTierLabel(days)} tone={windowTierTone(days)} />
              {record.windowTargetAt ? (
                <CountdownChip
                  dueAt={record.windowBreachedAt ?? record.windowTargetAt}
                  label="File by"
                  warnWithinHours={48}
                  alertWithinHours={24}
                />
              ) : null}
            </>
          ) : (
            <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
              No active filing window
            </span>
          )}
          <VisuallyHiddenLive tone={liveTone} message={liveMessage} />
        </aside>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem", maxWidth: "40rem" }}>
        <Field label="Record" value={recordId(record) || "—"} mono />
        <Field
          label="State"
          value={
            <StatusPill label={statusLabel(record.state)} tone={noeNotrStateTone(record.state)} />
          }
        />
        {record.patientId ? <Field label="Patient" value={record.patientId} mono /> : null}
        {record.providerEntityId ? (
          <Field label="Provider entity" value={record.providerEntityId} mono />
        ) : null}
        {record.effectiveDate ? (
          <Field label="Effective date" value={record.effectiveDate} />
        ) : null}
        {record.admissionDate ? (
          <Field label="Admission date" value={record.admissionDate} />
        ) : null}
        {record.windowTargetAt ? (
          <Field label="Window target" value={record.windowTargetAt} />
        ) : null}
        {record.submittedAt ? <Field label="Submitted at" value={record.submittedAt} /> : null}
        {record.payerControlNumber ? (
          <Field label="Payer control #" value={record.payerControlNumber} mono />
        ) : null}
        {typeof record.totalChargeCents === "number" ? (
          <Field label="Total charge" value={dollars(record.totalChargeCents)} />
        ) : null}
        <NoticeActions record={record} config={config} onChanged={() => void load()} />
      </div>
    </DetailPageLayout>
  );
}

// ── shared submit / cancel actions (queue preview + detail) ───────────────────────────────────────────
function NoticeActions({
  record,
  config,
  onChanged,
  compact,
}: {
  record: NoticeRecord;
  config: NoticeWindowConfig;
  onChanged: () => void;
  compact?: boolean;
}): JSX.Element {
  const client = useApiClient();
  const id = recordId(record);
  const [busy, setBusy] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const runWrite = useCallback(
    async (kind: "submit" | "cancel") => {
      setBusy(true);
      setActionError(null);
      const path = kind === "submit" ? config.submitPath : config.cancelPath;
      const init = {
        params: { path: { id }, header: { "If-Match": String(record.version) } },
        body: kind === "submit" ? {} : { reason: cancelReason },
      };
      // Runtime-chosen path → typed POST collapses to `never`; read the result through a narrow shape (error
      // envelope + raw Response for the HTTP status). The server stays the authoritative authz + step-up gate.
      const { error: err, response } = (await client.POST(path as never, init as never)) as {
        error?: unknown;
        response?: Response;
      };
      if (err) {
        const status = response?.status;
        if (status === 412)
          setActionError(`This ${config.acronym} changed since you opened it — reopen to retry.`);
        else if (status === 422)
          setActionError("Validation failed — resolve the record's open findings first.");
        else if (status === 401 || status === 403)
          setActionError("Step-up authentication required — re-authenticate, then retry.");
        else if (status === 503)
          setActionError("Billing write seam unavailable — try again shortly.");
        else setActionError("The action could not be completed.");
        setBusy(false);
        return;
      }
      setBusy(false);
      setShowCancel(false);
      setCancelReason("");
      onChanged();
    },
    [client, config, id, record.version, cancelReason, onChanged],
  );

  const canSubmit = record.state === "draft" || record.state === "ready";
  const canCancel = !TERMINAL_STATES.has(record.state) && record.state !== "draft";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        marginTop: compact ? "0.25rem" : "0.5rem",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <button
          type="button"
          disabled={!canSubmit || busy}
          onClick={() => void runWrite("submit")}
          style={canSubmit ? primaryButtonStyle : disabledButtonStyle}
        >
          Submit
        </button>
        <button
          type="button"
          disabled={!canCancel || busy}
          onClick={() => setShowCancel((v) => !v)}
          style={canCancel ? ghostButtonStyle : disabledButtonStyle}
        >
          Cancel {config.acronym}
        </button>
      </div>

      {showCancel ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <label
            htmlFor={`cancel-reason-${id}`}
            style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}
          >
            Cancellation reason
          </label>
          <textarea
            id={`cancel-reason-${id}`}
            aria-label={`Reason for cancelling ${config.acronym} ${id}`}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            rows={3}
            style={textareaStyle}
          />
          <button
            type="button"
            disabled={busy || cancelReason.trim().length < 1}
            onClick={() => void runWrite("cancel")}
            style={cancelReason.trim().length >= 1 ? primaryButtonStyle : disabledButtonStyle}
          >
            Confirm cancellation
          </button>
        </div>
      ) : null}

      {actionError ? (
        <p role="alert" style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-error)" }}>
          {actionError}
        </p>
      ) : null}
    </div>
  );
}

// ── small shared building blocks ──────────────────────────────────────────────────────────────────────
function Field({
  label,
  value,
  mono,
}: { label: string; value: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      <span
        style={{
          fontSize: "0.85rem",
          color: "var(--color-on-surface)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// §5.4 visually-hidden live region — the non-visual equivalent of the CountdownChip clock.
function VisuallyHiddenLive({
  tone,
  message,
}: { tone: "assertive" | "polite"; message: string }): JSX.Element {
  return (
    <output
      aria-live={tone}
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        margin: -1,
        padding: 0,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    >
      {message}
    </output>
  );
}

const thStyle = {
  padding: "0.5rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const tdStyle = { padding: "0.5rem 0.75rem", color: "var(--color-on-surface)" };
const selectStyle = {
  padding: "0.35rem 0.5rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
const textareaStyle = {
  ...selectStyle,
  minWidth: "16rem",
  resize: "vertical" as const,
  fontFamily: "inherit",
};
const asideStyle = {
  width: "18rem",
  flexShrink: 0,
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.6rem",
  background: "var(--color-surface-lowest)",
};
const asideTitleStyle = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: "0.95rem",
  fontWeight: 500,
  color: "var(--color-on-surface)",
};
const primaryButtonStyle = {
  padding: "0.4rem 0.85rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.8rem",
  fontWeight: 600,
};
const ghostButtonStyle = {
  padding: "0.4rem 0.85rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8rem",
  fontWeight: 600,
  textDecoration: "none",
};
const disabledButtonStyle = {
  ...ghostButtonStyle,
  cursor: "not-allowed",
  opacity: 0.5,
};

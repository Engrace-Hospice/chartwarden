import {
  Button,
  CursorPagination,
  DetailPageLayout,
  EmptyState,
  FilterBar,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  interactiveRowProps,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/23-billing-medicare — shared NOE / NOTR filing-window surface (R2, §5.1 #11–14,
// §10 PR-J). NOE (Notice of Election) and NOTR (Notice of Termination/Revocation) are structurally identical:
// a state-grouped Work Queue of records, each racing a CMS 5-day filing window (the `windowTargetAt`
// deadline, with `windowBreachedAt` set once it lapses), plus a detail surface with submit + cancel
// actions. They differ only in the wire path (`/api/v1/noe-records` vs `/api/v1/notr-records`) and labels —
// so the queue and detail are authored ONCE here and parameterized by a `NoticeWindowConfig`; the four
// registered screens (noe-queue / noe-detail / notr-queue / notr-detail) are thin wrappers.
//
// Lantern: WorkQueueLayout + FilterBar + No-Line table (§6.7) + RightDetailPanel for the queue; DetailPageLayout
// for the detail. Deadline posture comes from the backend policy projection; the browser never re-computes CMS dates.
// CSS-var tokens only, mono identifiers, tabular figures. The server is the only authz
// point (ADR-0030): a 503 (seams unbound) degrades to EmptyState; a write 409 (stale If-Match) / 422 (validation) /
// 401-403 (step-up) surfaces inline (role="alert"), never a toast.
//
// §5.4 accessibility: server deadline posture is announced through a visually-hidden aria-live region.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import {
  dollars,
  noeNotrStateTone,
  statusLabel,
} from "./billing-status";
import { DdeFileAction, noticeDdeOptions } from "./dde-file-action";
import {
  type CorrectableNotice,
  NoticeCorrectionAction,
  NoticeCorrectionLinks,
} from "./notice-correction";
import { payerDateLabel } from "./notice-correction-model";

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
  /** "File corrected …" action path template (a rejected notice → a new linked DRAFT). */
  correctPath: string;
  /** The notice-owned date a correction may fix: NOE admission date, NOTR effective end date. */
  correctableDateLabel: string;
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
  correctPath: "/api/v1/noe-records/{id}/correct",
  correctableDateLabel: "Admission (election) date",
  routeBase: "/billing/noe",
};

export const NOTR_CONFIG: NoticeWindowConfig = {
  acronym: "NOTR",
  longName: "Notice of Termination / Revocation",
  listPath: "/api/v1/notr-records",
  detailPath: "/api/v1/notr-records/{id}",
  submitPath: "/api/v1/notr-records/{id}/submit",
  cancelPath: "/api/v1/notr-records/{id}/cancel",
  correctPath: "/api/v1/notr-records/{id}/correct",
  correctableDateLabel: "Discharge / revocation date",
  routeBase: "/billing/notr",
};

// ── wire shape (openapi emits no response schema for billing; model the fields the surface reads) ───────
interface NoticeRecord {
  // The backend keys the id as `noeId` / `notrId` (older shapes: `id`, `noeRecordId`, `notrRecordId`); accept all.
  id?: string;
  noeId?: string;
  notrId?: string;
  noeRecordId?: string;
  notrRecordId?: string;
  state: string;
  patientId?: string | null;
  providerEntityId?: string | null;
  windowTargetAt: string | null;
  windowBreachedAt: string | null;
  deadline?: {
    applies: boolean;
    risk: string;
    basis: string;
    triggerDate: string | null;
    dueDate: string | null;
    lifecycle: string;
    acceptance: string;
    acceptedAt: string | null;
    timeliness: string;
    followUp: string;
  };
  latestAttempt?: {
    submissionId: string;
    attemptIndex: number;
    outcome: string;
    dispatchState: string;
    dispatchStartedAt: string | null;
    submittedAt: string | null;
    createdAt: string;
  } | null;
  evidenceTimeline?: readonly {
    kind: string;
    source: string;
    at: string;
    referenceId: string;
    submissionId: string | null;
    verification: string;
    safeSummary: string;
  }[];
  effectiveDate?: string | null;
  admissionDate?: string | null;
  submittedAt?: string | null;
  payerControlNumber?: string | null;
  payerNoeControlNumber?: string | null;
  payerNotrControlNumber?: string | null;
  // The MAC's answer: the 277CA acceptance date, or the 999 / 277CA rejection with its PHI-free reason codes.
  acceptedAt?: string | null;
  // When the clearinghouse (not Medicare) accepted the file; never the NOE timeliness date.
  clearinghouseAcceptedAt?: string | null;
  rejectedAt?: string | null;
  rejectionStage?: "999" | "277ca" | "clearinghouse" | null;
  rejectionCodes?: string[];
  // Medicare's own date for that answer (277CA STC02 / 999 GS04 / ISA09, else our receipt date) + its source.
  payerStatusDate?: string | null;
  payerStatusDateSource?: string | null;
  // The correction chain: the rejected notice a correction was filed for, and the correction of a rejected one.
  correctsNoticeId?: string | null;
  correctionReason?: string | null;
  correctedBy?: { noticeId: string; state: string } | null;
  electionEffectiveDate?: string | null;
  effectiveEndDate?: string | null;
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

function ddeOptions(rec: NoticeRecord, config: NoticeWindowConfig) {
  return noticeDdeOptions(config.acronym === "NOE" ? "noe" : "notr", rec.state);
}

function recordId(rec: NoticeRecord): string {
  return rec.id ?? rec.noeId ?? rec.notrId ?? rec.noeRecordId ?? rec.notrRecordId ?? "";
}

function correctable(rec: NoticeRecord): CorrectableNotice {
  return {
    id: recordId(rec),
    state: rec.state,
    correctsNoticeId: rec.correctsNoticeId ?? null,
    correctionReason: rec.correctionReason ?? null,
    correctedBy: rec.correctedBy ?? null,
    correctableDate: rec.electionEffectiveDate ?? rec.effectiveEndDate ?? null,
    rejectionStage: rec.rejectionStage ?? null,
    rejectionCodes: rec.rejectionCodes ?? [],
  };
}

function payerControlNumberOf(rec: NoticeRecord): string | null {
  return rec.payerControlNumber ?? rec.payerNoeControlNumber ?? rec.payerNotrControlNumber ?? null;
}

const DEADLINE_RANK: Record<string, number> = {
  overdue: 0, rejected: 0, transport_rejected: 0, accepted_after_deadline: 1, due_today: 1, approaching: 2,
  submitted_awaiting_verification: 2, filing_timeliness_unknown: 2, on_track: 3,
  accepted_within_deadline: 4, not_applicable: 5, not_determinable: 6,
};
const DEADLINE_TONE: Record<string, "neutral" | "progress" | "success" | "warning" | "error"> = {
  overdue: "error", rejected: "error", transport_rejected: "error", accepted_after_deadline: "error", due_today: "error",
  approaching: "warning", submitted_awaiting_verification: "progress", filing_timeliness_unknown: "warning",
  on_track: "warning", accepted_within_deadline: "success", not_applicable: "neutral", not_determinable: "warning",
};
const DEADLINE_LABEL: Record<string, string> = {
  overdue: "Overdue — acceptance unverified", rejected: "MAC rejected — correction needed", transport_rejected: "Transport rejected — filing unverified",
  accepted_after_deadline: "Accepted after deadline", due_today: "Due today — acceptance required",
  approaching: "Approaching — acceptance required", submitted_awaiting_verification: "Submitted — awaiting MAC verification",
  filing_timeliness_unknown: "Timeliness unknown", on_track: "On track — MAC acceptance required",
  accepted_within_deadline: "Accepted within deadline", not_applicable: "No five-day deadline",
  not_determinable: "Deadline not determinable",
};
function riskKey(rec: NoticeRecord): string {
  return rec.deadline?.risk ?? "not_determinable";
}
function riskLabel(rec: NoticeRecord): string { return DEADLINE_LABEL[riskKey(rec)] ?? "Deadline status unavailable"; }
function riskTone(rec: NoticeRecord): "neutral" | "progress" | "success" | "warning" | "error" {
  return DEADLINE_TONE[riskKey(rec)] ?? "neutral";
}
const LIFECYCLE_LABEL: Record<string, string> = {
  draft: "Draft",
  ready: "Internally ready · dispatch held",
  submission_requested: "Submission requested · not transmitted",
  dispatch_started: "Dispatch started · outcome not final",
  transport_receipt_confirmed: "Transport response recorded · awaiting MAC acknowledgment",
  transport_rejected: "Transport rejected · filing unverified",
  known_not_sent: "Known not sent · correction/retry review",
  outcome_unknown: "Outcome unknown · reconciliation required",
  awaiting_mac_acknowledgment: "Awaiting MAC acknowledgment",
  mac_accepted_verified: "MAC acceptance verified",
  mac_rejected_verified: "MAC rejection verified",
  external_filing_recorded: "External filing recorded · acceptance unverified",
  cancelled: "Cancelled",
  unknown: "Lifecycle evidence incomplete",
};
const LIFECYCLE_TONE: Record<string, "neutral" | "progress" | "success" | "warning" | "error"> = {
  draft: "neutral", ready: "warning", submission_requested: "progress", dispatch_started: "warning",
  transport_receipt_confirmed: "progress", transport_rejected: "error", known_not_sent: "warning",
  outcome_unknown: "error", awaiting_mac_acknowledgment: "progress", mac_accepted_verified: "success",
  mac_rejected_verified: "error", external_filing_recorded: "warning", cancelled: "neutral", unknown: "neutral",
};
function lifecycleLabel(rec: NoticeRecord): string {
  return LIFECYCLE_LABEL[rec.deadline?.lifecycle ?? ""] ?? (rec.deadline ? "Lifecycle evidence incomplete" : statusLabel(rec.state));
}
function lifecycleTone(
  rec: NoticeRecord,
): "neutral" | "progress" | "success" | "warning" | "error" | "critical" {
  return LIFECYCLE_TONE[rec.deadline?.lifecycle ?? ""] ?? (rec.deadline ? "neutral" : noeNotrStateTone(rec.state));
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
    const risk = riskKey(r);
    if (risk === "overdue" || risk === "rejected" || risk === "transport_rejected" || risk === "accepted_after_deadline") breached += 1;
    else if (["approaching", "due_today", "submitted_awaiting_verification", "filing_timeliness_unknown"].includes(risk)) atRisk += 1;
    else if (risk === "on_track") inWindow += 1;
  }
  return { inWindow, atRisk, breached, total: records.length };
}

// ── QUEUE (§5.1 #11 / #13) ────────────────────────────────────────────────────────────────────────────
export function NoticeWindowQueue({ config }: { config: NoticeWindowConfig }): JSX.Element {
  const client = useApiClient();
  const [records, setRecords] = useState<NoticeRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [stateFilter, setStateFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selected, setSelected] = useState<NoticeRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setError(null);
      }
      // The list path is config-chosen at runtime, so the typed GET collapses to `never`; cast the read. The
      // server (re)parses the request and remains the authoritative org-scoped (RLS) + authz boundary.
      const init = { params: { query: { limit: 50, ...(cursor ? { cursor } : {}) } } };
      const { data, error: err } = (await client.GET(config.listPath as never, init as never)) as {
        data?: unknown;
        error?: unknown;
      };
      if (err) {
        if (append) setLoadingMore(false);
        else {
          setError(
            `${config.acronym} queue unavailable — the billing read seam is not bound, or you lack scope.`,
          );
          setLoading(false);
        }
        return;
      }
      const page = (data as ListPage<NoticeRecord>) ?? {
        items: [],
        nextCursor: null,
        hasMore: false,
      };
      setRecords((prev) => (append ? [...prev, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      if (append) setLoadingMore(false);
      else setLoading(false);
    },
    [client, config],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const loadMore = useCallback(() => {
    if (nextCursor) void load(nextCursor, true);
  }, [load, nextCursor]);

  const visible = records.filter((r) => {
    const q = searchQuery.trim().toLowerCase();
    const id = recordId(r).toLowerCase();
    const matchesState = !stateFilter || r.state === stateFilter;
    const matchesSearch =
      !q ||
      id.includes(q) ||
      (r.patientId ?? "").toLowerCase().includes(q) ||
      (r.providerEntityId ?? "").toLowerCase().includes(q) ||
      (r.payerControlNumber ?? "").toLowerCase().includes(q);
    return matchesState && matchesSearch;
  });
  const posture = summarize(records);
  const states = Array.from(new Set(records.map((r) => r.state))).sort();
  const activeFilterCount = [stateFilter, searchQuery].filter(Boolean).length;

  // §5.4 non-visual countdown equivalent: assertive once anything has breached, polite while only at-risk.
  const liveTone: "assertive" | "polite" = posture.breached > 0 ? "assertive" : "polite";
  const liveMessage =
    posture.breached > 0
      ? `${posture.breached} ${config.acronym} ${posture.breached === 1 ? "record has" : "records have"} breached the filing window; ${posture.atRisk} at risk.`
      : posture.atRisk > 0
        ? `${posture.atRisk} ${config.acronym} ${posture.atRisk === 1 ? "record is" : "records are"} at risk of breaching the filing window.`
        : `No overdue or approaching ${config.acronym} deadlines among the loaded records. This does not mean notices are filed.`;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title={`Billing / ${config.acronym} Queue`}
          actions={
            <Link
              to={config.acronym === "NOE" ? "/billing/notr" : "/billing/noe"}
              className="wx-btn-secondary"
            >
              {config.acronym === "NOE" ? "NOTR queue" : "NOE queue"}
            </Link>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review notice lifecycle, Medicare acceptance evidence, and regulatory deadline risk.
          </div>
          <InlineAlert tone="warning">
            <strong>External notice transmission is unavailable.</strong> Direct MAC notice dispatch is awaiting gateway contract qualification. Claim.MD and Stedi hospice notice transaction support is not verified. A prepared notice is not a filed notice.
          </InlineAlert>
          <div style={{ marginTop: "0.75rem" }}>
            <BillingTabs />
          </div>
        </PageHeader>
      }
      filters={
        <FilterBar
          activeFilterCount={activeFilterCount}
          onClear={() => {
            setStateFilter("");
            setSearchQuery("");
          }}
          actions={
            <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8125rem" }}>
              {visible.length} of {records.length} loaded
            </span>
          }
        >
          <label className="wx-search-field">
            <Glyph name="search" size={16} />
            <input
              type="search"
              aria-label={`Search ${config.acronym} records`}
              placeholder={`Search ${config.acronym} records...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </label>
          <label className="wx-filter-field">
            <span>State</span>
            <select
              className="wx-select"
              aria-label={`${config.acronym} state`}
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
            >
              <option value="">All</option>
              {states.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <VisuallyHiddenLive tone={liveTone} message={liveMessage} />
        </FilterBar>
      }
      table={
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : visible.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={`No ${config.acronym} records`}
              description={`No ${config.longName} records match the current filter in your scope.`}
              action={
                activeFilterCount > 0 ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setStateFilter("");
                      setSearchQuery("");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
            <NoticeTable
              records={visible}
              config={config}
              selectedId={selected ? recordId(selected) : null}
              onSelect={setSelected}
            />
            <CursorPagination
              loadedCount={records.length}
              hasNextPage={hasMore}
              onNextPage={loadMore}
              loading={loadingMore}
              noun={`${config.acronym} records`}
            />
          </div>
        )
      }
      detail={
        selected ? (
          <RightDetailPanel
            title={`${config.acronym} Preview`}
            onClose={() => setSelected(null)}
            hideScrollbar
          >
            <NoticePreview
              record={selected}
              config={config}
              onChanged={() => void load(null, false)}
            />
          </RightDetailPanel>
        ) : null
      }
      fullPageScroll
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
  for (const bucket of groups.values()) bucket.sort((a, b) => (DEADLINE_RANK[riskKey(a)] ?? 99) - (DEADLINE_RANK[riskKey(b)] ?? 99));
  const orderedStates = Array.from(groups.keys()).sort();

  return (
    <table
      style={{ display: "table", width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}
    >
      <thead>
        <tr
          style={{
            textAlign: "left",
            color: "var(--color-on-surface-variant)",
            borderBottom:
              "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
            background: "var(--color-surface-low)",
          }}
        >
          <th style={{ ...thStyle, width: "24%" }}>Record</th>
          <th style={{ ...thStyle, width: "14%" }}>State</th>
          <th style={{ ...thStyle, width: "34%" }}>Deadline / evidence</th>
          <th style={{ ...thStyle, width: "20%" }}>Due date</th>
        </tr>
      </thead>
      {orderedStates.map((state) => (
        <tbody key={state}>
          <tr>
            <th
              colSpan={4}
              style={{
                textAlign: "left",
                padding: "0.6rem 0.75rem 0.3rem",
                fontSize: "0.7rem",
                fontWeight: 700,
                color: "var(--color-on-surface-variant)",
              }}
            >
              {statusLabel(state)} · {groups.get(state)?.length ?? 0}
            </th>
          </tr>
          {(groups.get(state) ?? []).map((r, i) => {
            const id = recordId(r);
            return (
              <tr
                key={id}
                {...interactiveRowProps(() => onSelect(r), id === selectedId, true)}
                className="wx-data-row-interactive"
                style={{
                  borderBottom:
                    "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
                  cursor: "pointer",
                  background: id === selectedId ? "var(--color-primary-tint)" : "transparent",
                  transition: "background 0.15s ease",
                }}
              >
                <td style={tdStyle}>
                  <Link
                    to={`${config.routeBase}/${id}`}
                    style={{
                      color: "var(--color-primary)",
                      textDecoration: "none",
                      fontWeight: 600,
                      fontFamily: "var(--font-mono)",
                    }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {id || "—"}
                  </Link>
                  {r.correctsNoticeId ? (
                    <span className="wx-row-sub" style={{ display: "block" }}>
                      Corrected {config.acronym}
                    </span>
                  ) : null}
                </td>
                <td style={tdStyle}>
                  <StatusPill label={lifecycleLabel(r)} tone={lifecycleTone(r)} />
                </td>
                <td style={tdStyle}>
                  <StatusPill label={riskLabel(r)} tone={riskTone(r)} />
                </td>
                <td style={tdStyle}>
                  {r.deadline?.dueDate && isActive(r) ? (
                    <span aria-label={`${riskLabel(r)}; due ${r.deadline.dueDate}`}>{r.deadline.dueDate}</span>
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
  const risk = riskKey(record);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Field label="Record" value={id || "—"} mono />
      <Field
        label="State"
        value={
          <StatusPill label={lifecycleLabel(record)} tone={lifecycleTone(record)} />
        }
      />
      <NoticeAckOutcome record={record} config={config} />
      <NoticeCorrectionLinks notice={correctable(record)} config={config} />
      <NoticeCorrectionAction notice={correctable(record)} config={config} onFiled={onChanged} />
      <DdeFileAction key={id} subjectId={id} options={ddeOptions(record, config)} />
      {record.deadline?.applies ? (
        <Field
          label="Filing deadline"
          value={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
              <StatusPill label={riskLabel(record)} tone={riskTone(record)} />
              <span>{record.deadline.dueDate ?? "Date unavailable"}</span>
            </span>
          }
        />
      ) : null}
      {record.deadline?.followUp ? <p role="note" style={{ margin: 0, color: "var(--color-on-surface-variant)" }}>{record.deadline.followUp}</p> : null}
      {record.patientId ? <Field label="Patient" value={record.patientId} mono /> : null}
      {record.providerEntityId ? (
        <Field label="Provider entity" value={record.providerEntityId} mono />
      ) : null}
      {record.effectiveDate ? <Field label="Effective date" value={record.effectiveDate} /> : null}
      <NoticeActions record={record} config={config} onChanged={onChanged} compact />
      <Link
        to={`${config.routeBase}/${id}`}
        style={{ fontSize: "0.8rem", color: "var(--color-primary)" }}
      >
        Open detail →
      </Link>
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

  const liveTone: "assertive" | "polite" = ["overdue", "rejected"].includes(riskKey(record)) ? "assertive" : "polite";
  const liveMessage = `${config.acronym}: ${riskLabel(record)}${record.deadline?.dueDate ? `; due ${record.deadline.dueDate}` : "."}`;

  return (
    <DetailPageLayout
      header={<PageHeader title={`${config.acronym} ${recordId(record)}`} />}
      aside={
        <aside style={asideStyle}>
          <h3 style={asideTitleStyle}>Filing deadline</h3>
          {record.deadline?.applies ? (
            <>
              <StatusPill label={riskLabel(record)} tone={riskTone(record)} />
              <p>Due: {record.deadline.dueDate ?? "not determinable"}</p>
              <p>{record.deadline.followUp}</p>
              <p>Acceptance evidence: {record.deadline.acceptance === "verified" ? "verified MAC acknowledgment" : "not verified"}</p>
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
            <StatusPill label={lifecycleLabel(record)} tone={lifecycleTone(record)} />
          }
        />
        <NoticeAckOutcome record={record} config={config} />
        <NoticeEvidenceTimeline record={record} />
        {record.latestAttempt ? (
          <section aria-label="Latest submission attempt">
            <h2 style={{ fontSize: "1rem" }}>Latest attempt</h2>
            <Field label="Submission" value={`${record.latestAttempt.submissionId} · attempt ${record.latestAttempt.attemptIndex}`} mono />
            <Field label="Durable state" value={`${record.latestAttempt.dispatchState} · ${record.latestAttempt.outcome}`} />
            <Field label="Dispatch started" value={record.latestAttempt.dispatchStartedAt ?? "Not recorded"} />
            <Field label="Transport response time" value={record.latestAttempt.submittedAt ?? "Not recorded"} />
          </section>
        ) : null}
        <NoticeCorrectionLinks notice={correctable(record)} config={config} />
        <NoticeCorrectionAction
          notice={correctable(record)}
          config={config}
          onFiled={() => void load()}
        />
        <DdeFileAction
          key={recordId(record)}
          subjectId={recordId(record)}
          options={ddeOptions(record, config)}
        />
        {record.patientId ? <Field label="Patient" value={record.patientId} mono /> : null}
        {record.providerEntityId ? (
          <Field label="Provider entity" value={record.providerEntityId} mono />
        ) : null}
        {record.electionEffectiveDate ? (
          <Field label="Admission date" value={record.electionEffectiveDate} />
        ) : null}
        {record.effectiveEndDate ? (
          <Field label="Discharge / revocation date" value={record.effectiveEndDate} />
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
        {record.deadline?.basis ? <Field label="Regulatory basis" value={record.deadline.basis} /> : null}
        {record.submittedAt ? <Field label="Submitted at" value={record.submittedAt} /> : null}
        {payerControlNumberOf(record) ? (
          <Field label="Payer control #" value={payerControlNumberOf(record)} mono />
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
        if (status === 409)
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

  // No deployed external hospice notice transport is currently qualified. Keep the control present but disabled
  // with a visible reason; server-side worker guards remain authoritative for legacy clients and queued jobs.
  const canSubmit = false;
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
          style={disabledButtonStyle}
          aria-describedby={`notice-submit-hold-${id}`}
        >
          External submission unavailable
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
      <p id={`notice-submit-hold-${id}`} role="note" style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
        The notice may be reviewed or prepared internally, but no supported external filing pathway is enabled. Use the authorized external-filing record workflow only when filing through your organization’s biller.
      </p>

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

function NoticeEvidenceTimeline({ record }: { record: NoticeRecord }): JSX.Element {
  const events = record.evidenceTimeline ?? [];
  return (
    <section aria-labelledby="notice-evidence-heading" style={{ borderTop: "1px solid var(--color-outline-variant)", paddingTop: "0.75rem" }}>
      <h2 id="notice-evidence-heading" style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Evidence timeline</h2>
      {events.length === 0 ? (
        <p>No timestamped lifecycle evidence is available from the current read model.</p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: "1.25rem" }}>
          {events.map((event, index) => (
            <li key={`${event.kind}:${event.at}:${index}`} style={{ marginBottom: "0.5rem" }}>
              <strong>{event.safeSummary}</strong>
              <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8rem" }}>
                {new Date(event.at).toLocaleString()} · {event.verification === "verified" ? "Verified evidence" : "Recorded event"}
                {event.submissionId ? ` · Submission ${event.submissionId}` : ""}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ── small shared building blocks ──────────────────────────────────────────────────────────────────────
// The MAC's answer: when the 277CA accepted the notice, or when and at which stage it was rejected and why.
const REJECTION_STAGE_LABEL: Record<"999" | "277ca" | "clearinghouse", string> = {
  clearinghouse: "Clearinghouse edits (before Medicare)",
  "999": "999 (file syntax)",
  "277ca": "277CA (claim content)",
};

function NoticeAckOutcome({
  record,
  config,
}: {
  record: NoticeRecord;
  config: NoticeWindowConfig;
}): JSX.Element | null {
  if (record.rejectedAt) {
    const codes = record.rejectionCodes ?? [];
    return (
      <>
        <InlineAlert tone="error">
          {record.rejectionStage === "clearinghouse"
            ? `The clearinghouse rejected this ${config.acronym} before it reached Medicare: it was not filed. Correct it and file a new ${config.acronym}.`
            : `Medicare rejected this ${config.acronym}: it was not filed. Correct it and file a new ${config.acronym}.`}
        </InlineAlert>
        <Field
          label="Rejected"
          value={`${new Date(record.rejectedAt).toLocaleString()}${
            record.rejectionStage ? ` · ${REJECTION_STAGE_LABEL[record.rejectionStage]}` : ""
          }`}
        />
        <Field
          label="Reason codes"
          value={codes.length > 0 ? codes.join(", ") : "None reported"}
          mono={codes.length > 0}
        />
        {record.payerStatusDate ? (
          <Field
            label="Medicare's rejection date"
            value={payerDateLabel(record.payerStatusDate, record.payerStatusDateSource)}
          />
        ) : null}
      </>
    );
  }
  if (record.acceptedAt) {
    const payerDate = payerDateLabel(record.payerStatusDate, record.payerStatusDateSource);
    return (
      <>
        <Field label="Accepted by Medicare" value={new Date(record.acceptedAt).toLocaleString()} />
        {payerDate ? <Field label="Medicare's acceptance date" value={payerDate} /> : null}
      </>
    );
  }
  if (record.clearinghouseAcceptedAt) {
    return (
      <Field
        label="Accepted by clearinghouse (awaiting Medicare)"
        value={new Date(record.clearinghouseAcceptedAt).toLocaleString()}
      />
    );
  }
  return null;
}

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

const thStyle: CSSProperties = {
  padding: "0.625rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600,
};
const tdStyle: CSSProperties = {
  padding: "0.65rem 0.75rem",
  color: "var(--color-on-surface)",
  verticalAlign: "middle",
};
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

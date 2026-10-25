import {
  Button,
  CursorPagination,
  EmptyState,
  FilterBar,
  Glyph,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  interactiveRowProps,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the CLAIM WORKBENCH (R2, §5.1 #2).
// The §10 PR-J Work Queue: a FilterBar (state / TOB / ProviderEntity / patient) over a cursor-paginated
// ("Load more") No-Line claim table with §6.6 StatusPills, and a RightDetailPanel preview of the selected
// claim with a one-click Submit + deep links into the claim editor for Replace/Void (TASK-021/FLOW-008 —
// this panel used to write Replace/Void directly with a fabricated empty reason; that reason-capture
// ceremony now lives in exactly one place, the editor). Reads GET /api/v1/billing/claims; Submit writes
// POST {id}/submit directly. The server is the only authz point (ADR-0030): a 503 (seams unbound) degrades
// the surface; a 412 (If-Match) / 422 (validation) on a write surfaces inline, never a toast; a
// STEP_UP_REQUIRED denial routes to /step-up. Lantern: WorkQueueLayout + FilterBar + RightDetailPanel,
// No-Line table (§6.7), mono claim-control-number (IBM Plex), tabular-nums, CSS-var tokens only. Status
// tones flow through billing-status.ts (§6.6). NOTE: the openapi marks the list query as `never` (the
// route's query schema is not emitted into openapi.json), so the cursor/filter query is passed through a
// narrow cast — the server stays the authoritative parser of the query envelope.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { PatientLookupField, ProviderEntityLookupField } from "../../shell/entity-lookups";
import { claimStateTone, dollars, statusLabel, tobLabel } from "./billing-status";
import type { ClaimAttention } from "./discharge-attention";
import { authFailureRedirect } from "./write-workflow";

interface ClaimSummary {
  claimId: string;
  providerEntityId: string;
  patientId: string;
  tob: string;
  state: string;
  serviceFrom: string;
  serviceTo: string;
  claimControlNumber: string;
  payerClaimControlNumber: string | null;
  macJurisdiction: string;
  totalChargeCents: number;
  totalExpectedPaymentCents: number;
  version: number;
  attention?: ClaimAttention | null;
}

interface ClaimPage {
  items: ClaimSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ClaimFilters {
  state: string;
  providerEntityId: string;
  patientId: string;
  /** `missing_discharge_details` / `tob_changed` — the server-side "needs attention" filter. */
  attention: string;
}

const NO_FILTERS: ClaimFilters = { state: "", providerEntityId: "", patientId: "", attention: "" };

const ATTENTION_FILTERS = [
  { value: "missing_discharge_details", label: "Missing discharge details" },
  { value: "tob_changed", label: "Type of bill changed" },
] as const;

const CLAIM_STATES = [
  "draft",
  "validating",
  "ready",
  "submitted",
  "ack_pending",
  "ack_accepted",
  "ack_partial",
  "paid",
  "partial_paid",
  "denied",
  "replaced",
  "voided",
];

// openapi marks the billing list query as `never`; build the query object and pass it through. The cast is
// compile-time only — at runtime openapi-fetch serializes `params.query` and the server (re)parses it.
function listInit(filters: ClaimFilters, cursor: string | null): unknown {
  const query: Record<string, string | number> = { limit: 50 };
  if (filters.state) query.state = filters.state;
  if (filters.providerEntityId) query.providerEntityId = filters.providerEntityId;
  if (filters.patientId) query.patientId = filters.patientId;
  if (filters.attention) query.attention = filters.attention;
  if (cursor) query.cursor = cursor;
  return { params: { query } };
}

export function ClaimWorkbench(): JSX.Element {
  const client = useApiClient();
  const [filters, setFilters] = useState<ClaimFilters>(NO_FILTERS);
  const [claims, setClaims] = useState<ClaimSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<ClaimSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // TASK-021 — the cursor the server returns was previously read into `ClaimPage` and dropped; `append`
  // distinguishes a fresh filter change (replace the page) from "Load more" (grow it).
  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setError(null);
      }
      const { data, error: err } = await client.GET(
        "/api/v1/billing/claims",
        listInit(filters, cursor) as never,
      );
      if (err) {
        if (append) setLoadingMore(false);
        else {
          setError(
            "Claim workbench unavailable — the billing read seam is not bound, or you lack scope.",
          );
          setLoading(false);
        }
        return;
      }
      const page = (data as unknown as ClaimPage) ?? {
        items: [],
        nextCursor: null,
        hasMore: false,
      };
      setClaims((prev) => (append ? [...prev, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      if (append) setLoadingMore(false);
      else setLoading(false);
    },
    [client, filters],
  );

  useEffect(() => {
    // A `load` identity change (client/filters) always restarts at page 1 — only an explicit
    // "Load more" click appends.
    void load(null, false);
  }, [load]);

  const loadMore = useCallback(() => {
    if (nextCursor) void load(nextCursor, true);
  }, [load, nextCursor]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Claim Workbench"
          breadcrumb="Billing / Medicare"
          actions={
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <Link to="/billing/claims/new" style={ghostButtonStyle}>
                Assemble claim
              </Link>
              <Link to="/billing" style={ghostButtonStyle}>
                AR dashboard
              </Link>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review Medicare claims, submit ready claims, and open replace or void ceremonies from
            the editor.
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <BillingTabs />
          </div>
        </PageHeader>
      }
      filters={
        <FilterBar
          activeFilterCount={
            [filters.state, filters.providerEntityId, filters.patientId, filters.attention].filter(
              Boolean,
            ).length
          }
          onClear={() => setFilters(NO_FILTERS)}
          actions={
            <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8125rem" }}>
              {claims.length} claims loaded
            </span>
          }
        >
          <label className="wx-filter-field">
            <span>State</span>
            <select
              className="wx-select"
              aria-label="Claim state"
              value={filters.state}
              onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value }))}
              style={selectStyle}
            >
              <option value="">All</option>
              {CLAIM_STATES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="wx-filter-field">
            <span>Needs attention</span>
            <select
              className="wx-select"
              aria-label="Needs attention"
              value={filters.attention}
              onChange={(e) => setFilters((f) => ({ ...f, attention: e.target.value }))}
              style={selectStyle}
            >
              <option value="">Any</option>
              {ATTENTION_FILTERS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <div style={{ minWidth: "15rem" }}>
            <ProviderEntityLookupField
              label="Provider entity"
              value={filters.providerEntityId}
              onChange={(v) => setFilters((f) => ({ ...f, providerEntityId: v }))}
            />
          </div>
          <div style={{ minWidth: "15rem" }}>
            <PatientLookupField
              label="Patient"
              value={filters.patientId}
              onChange={(v) => setFilters((f) => ({ ...f, patientId: v }))}
            />
          </div>
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
        ) : claims.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No claims"
              description="No claims match the current filters in your scope."
              action={
                <Button tone="secondary" size="sm" onClick={() => setFilters(NO_FILTERS)}>
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
            <ClaimTable
              claims={claims}
              selectedId={selected?.claimId ?? null}
              onSelect={setSelected}
            />
            <CursorPagination
              loadedCount={claims.length}
              hasNextPage={hasMore}
              onNextPage={loadMore}
              loading={loadingMore}
              noun="claims"
            />
          </div>
        )
      }
      detail={
        selected ? (
          <RightDetailPanel title="Claim Preview" onClose={() => setSelected(null)} hideScrollbar>
            <ClaimPreview claim={selected} onChanged={() => void load(null, false)} />
          </RightDetailPanel>
        ) : null
      }
      fullPageScroll
    />
  );
}

// ── No-Line claim table (§6.7) — tonal zebra, mono identifiers, tabular figures ───────────────────────
function ClaimTable({
  claims,
  selectedId,
  onSelect,
}: {
  claims: ClaimSummary[];
  selectedId: string | null;
  onSelect: (c: ClaimSummary) => void;
}): JSX.Element {
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
          <th style={{ ...thStyle, width: "22%" }}>Control #</th>
          <th style={{ ...thStyle, width: "14%" }}>State</th>
          <th style={{ ...thStyle, width: "18%" }}>TOB</th>
          <th style={{ ...thStyle, width: "18%" }}>Service dates</th>
          <th style={{ ...thStyle, width: "10%" }}>MAC</th>
          <th style={{ ...thStyle, width: "18%", textAlign: "right" }}>Expected</th>
        </tr>
      </thead>
      <tbody>
        {claims.map((c) => (
          <tr
            key={c.claimId}
            {...interactiveRowProps(() => onSelect(c), c.claimId === selectedId, true)}
            className="wx-data-row-interactive"
            style={{
              borderBottom:
                "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
              cursor: "pointer",
              background: c.claimId === selectedId ? "var(--color-primary-tint)" : "transparent",
              transition: "background 0.15s ease",
            }}
          >
            <td style={tdStyle}>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                <Link
                  to={`/billing/claims/${c.claimId}`}
                  style={{
                    color: "var(--color-primary)",
                    textDecoration: "none",
                    fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                  }}
                  onClick={(event) => event.stopPropagation()}
                >
                  {c.claimControlNumber}
                </Link>
                {c.payerClaimControlNumber ? (
                  <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.75rem" }}>
                    Payer {c.payerClaimControlNumber}
                  </span>
                ) : null}
              </div>
            </td>
            <td style={tdStyle}>
              <StatusPill label={statusLabel(c.state)} tone={claimStateTone(c.state)} />
            </td>
            <td style={tdStyle}>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                <span>{tobLabel(c.tob)}</span>
                <AttentionChips attention={c.attention} />
              </div>
            </td>
            <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
              {c.serviceFrom} → {c.serviceTo}
            </td>
            <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{c.macJurisdiction}</td>
            <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {dollars(c.totalExpectedPaymentCents)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── right-panel claim preview: a one-click Submit + links into the full editor for Replace/Void ────────
// TASK-021/FLOW-008 — Replace/Void used to write directly from this compact panel with a fabricated
// `reason: ""` (always 422, since the server requires >=20 real chars + `ifVersion`). Rather than duplicate
// the reason-capture ceremony a second time here, those two actions now deep-link to the claim editor, which
// already builds the correct payload — a consequential, irreversible act like voiding a submitted Medicare
// claim also deserves the editor's full context, not a compact preview.
function ClaimPreview({
  claim,
  onChanged,
}: { claim: ClaimSummary; onChanged: () => void }): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Submit carries no reason, so it stays a direct one-click action here. It sends If-Match (the claim
  // version) for §2.5 optimistic concurrency; a 412 means the row moved under us (reopen to retry), a 422
  // carries the validation envelope, a 503 means the write seam is unbound, and a step-up denial routes to
  // the real /step-up screen (returning here) rather than a dead-end inline message.
  const submit = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    const { error: err, response } = (await client.POST("/api/v1/billing/claims/{id}/submit", {
      params: { path: { id: claim.claimId }, header: { "If-Match": String(claim.version) } },
      body: {},
    } as never)) as { error?: { error?: { code?: string } }; response?: Response };
    if (err) {
      const redirect = authFailureRedirect(
        response?.status,
        err?.error?.code,
        window.location.pathname,
      );
      if (redirect) {
        navigate(redirect);
        return;
      }
      setBusy(false);
      if (response?.status === 412)
        setActionError("This claim changed since you opened it — reopen to retry.");
      else if (response?.status === 422)
        setActionError("Validation failed — resolve the claim's open findings first.");
      else if (response?.status === 503)
        setActionError("Billing write seam unavailable — try again shortly.");
      else if (response?.status === 403)
        setActionError("You do not have permission for this action.");
      else setActionError("The action could not be completed.");
      return;
    }
    setBusy(false);
    onChanged();
  }, [client, claim.claimId, claim.version, navigate, onChanged]);

  const canSubmit = claim.state === "ready";
  const canReplaceVoid = claim.state === "paid" || claim.state === "ack_accepted";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Field label="Control #" value={claim.claimControlNumber} mono />
      <Field
        label="State"
        value={<StatusPill label={statusLabel(claim.state)} tone={claimStateTone(claim.state)} />}
      />
      <Field label="Type of bill" value={tobLabel(claim.tob)} />
      <Field label="MAC jurisdiction" value={claim.macJurisdiction} mono />
      <Field label="Service dates" value={`${claim.serviceFrom} → ${claim.serviceTo}`} />
      <Field label="Total charge" value={dollars(claim.totalChargeCents)} />
      <Field label="Expected payment" value={dollars(claim.totalExpectedPaymentCents)} />
      {claim.payerClaimControlNumber ? (
        <Field label="Payer control #" value={claim.payerClaimControlNumber} mono />
      ) : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem" }}>
        <Link to="/billing/claims/new" style={ghostButtonStyle}>
          Assemble new
        </Link>
        <button
          type="button"
          disabled={!canSubmit || busy}
          onClick={() => void submit()}
          style={canSubmit ? primaryButtonStyle : disabledButtonStyle}
        >
          {busy ? "Submitting…" : "Submit"}
        </button>
        <Link
          to={`/billing/claims/${claim.claimId}?ceremony=replace`}
          aria-disabled={!canReplaceVoid}
          style={canReplaceVoid ? ghostButtonStyle : disabledButtonStyle}
          onClick={(e) => {
            if (!canReplaceVoid) e.preventDefault();
          }}
        >
          Replace…
        </Link>
        <Link
          to={`/billing/claims/${claim.claimId}?ceremony=void`}
          aria-disabled={!canReplaceVoid}
          style={canReplaceVoid ? ghostButtonStyle : disabledButtonStyle}
          onClick={(e) => {
            if (!canReplaceVoid) e.preventDefault();
          }}
        >
          Void…
        </Link>
      </div>

      {actionError ? (
        <p role="alert" style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-error)" }}>
          {actionError}
        </p>
      ) : null}
      <Link
        to={`/billing/claims/${claim.claimId}`}
        style={{ fontSize: "0.8rem", color: "var(--color-primary)" }}
      >
        Open full editor →
      </Link>
    </div>
  );
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
const inputStyle = { ...selectStyle, minWidth: "10rem", height: "2.25rem" };
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

/** The row's "needs attention" chips (missing discharge details / TOB changed), from the list read. */
function AttentionChips({
  attention,
}: { attention: ClaimAttention | null | undefined }): JSX.Element | null {
  if (!attention || attention.flags.length === 0) return null;
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
      {attention.flags.includes("missing_discharge_details") ? (
        <StatusPill label="Missing discharge details" tone="warning" />
      ) : null}
      {attention.flags.includes("tob_changed") && attention.typeOfBill.derived ? (
        <StatusPill label={`TOB now ${attention.typeOfBill.derived}`} tone="warning" />
      ) : null}
    </span>
  );
}

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
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { MdmEntityLookupField, PatientLookupField } from "../../shell/entity-lookups";
// apps/web/src/modules/24-billing-medicaid — M24, the MEDICAID CLAIM WORKBENCH (R2, §5.1 #2). The biller's
// filterable claim list (state · kind · service state · MCO · patient) over the cursor-paginated
// GET /api/v1/medicaid-claims. Per §5.1 the only bulk actions are validate-now and abandon; both are
// server-authoritative writes (medicaid.validation.run / medicaid.claim.* + If-Match), so a partial failure
// reports per-claim inline (role="alert") and the queue reloads. Lantern: WorkQueueLayout + No-Line table
// (§6.7) + §6.6 StatusPill via medicaid-status.ts; mono control numbers; CSS-var tokens only.
import { MedicaidBillingTabs } from "../../shell/medicaid-billing-tabs";
import {
  CLAIM_STATE_TONE,
  humanize,
  kindLabel,
  shortDate,
  shortId,
  toneOf,
} from "./medicaid-status";
import {
  Field,
  SummaryGrid,
  alertStyle,
  inputStyle,
  linkMonoStyle,
  mutedStyle,
  rowLine,
  selectStyle,
  tableStyle,
  td,
  tdMono,
  th,
  visuallyHidden,
} from "./medicaid-ui";

interface ClaimRow {
  id: string;
  patientId: string;
  serviceState: string;
  kind: string;
  tob: string;
  serviceFrom: string;
  serviceTo: string;
  mcoId: string | null;
  medicaidClaimControlNumber: string;
  state: string;
  version: number;
  updatedAt: string;
}

interface ClaimPage {
  items?: ClaimRow[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

const CLAIM_STATES = [
  "DRAFT",
  "VALIDATING",
  "FAILED_VALIDATION",
  "READY",
  "AWAITING_MEDICARE_PRIMARY",
  "FAILED_MEDICARE_PRIMARY",
  "SUBMITTED",
  "POLLING",
  "ACK_PENDING",
  "ACK_TIMEOUT",
  "ACK_ACCEPTED",
  "ACK_REJECTED",
  "ACK_PARTIAL",
  "PAID",
  "DENIED",
  "REPLACED",
  "VOIDED",
  "ABANDONED",
] as const;

const STATE_OPTIONS = [
  { value: "", label: "Any state" },
  ...CLAIM_STATES.map((s) => ({ value: s, label: humanize(s) })),
];
const KIND_OPTIONS = [
  { value: "", label: "Any kind" },
  { value: "combined_hospice_rb", label: kindLabel("combined_hospice_rb") },
  { value: "hospice_only", label: kindLabel("hospice_only") },
  { value: "rb_only", label: kindLabel("rb_only") },
];

/** The pre-submission states a claim may be abandoned from (§2.2) — the bulk action disables elsewhere. */
const ABANDONABLE = new Set(["DRAFT", "FAILED_VALIDATION", "READY", "FAILED_MEDICARE_PRIMARY"]);

export function MedicaidClaimWorkbench(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState("");
  const [kind, setKind] = useState("");
  const [serviceState, setServiceState] = useState("");
  const [mcoId, setMcoId] = useState("");
  const [patientId, setPatientId] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string | null, append = false) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      const query: Record<string, string | number> = { limit: 50 };
      if (state) query.state = state;
      if (kind) query.kind = kind;
      if (serviceState) query.serviceState = serviceState.toUpperCase();
      if (mcoId.trim()) query.mcoId = mcoId.trim();
      if (patientId.trim()) query.patientId = patientId.trim();
      if (cursor) query.cursor = cursor;
      const res = await client.GET("/api/v1/medicaid-claims", { params: { query } } as never);
      if (res.error) {
        setError("The Medicaid claim list is unavailable — you may lack billing visibility.");
        setLoading(false);
        setLoadingMore(false);
        return;
      }
      const page = res.data as unknown as ClaimPage | undefined;
      const items = page?.items ?? [];
      setRows((current) => (append ? [...current, ...items] : items));
      setNextCursor(page?.nextCursor ?? null);
      setHasMore(Boolean(page?.hasMore));
      if (!append) {
        setSelected(new Set());
        setSelectedPreviewId(items[0]?.id ?? null);
      }
      setLoading(false);
      setLoadingMore(false);
    },
    [client, state, kind, serviceState, mcoId, patientId],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // §5.1: bulk actions are limited to validate-now and abandon. Each claim is its own request (the server
  // enforces per-claim ABAC + If-Match); one failure does not abort the rest, it is counted and reported.
  const runBulk = useCallback(
    async (mode: "validate" | "abandon") => {
      const targets = rows.filter((r) => selected.has(r.id));
      if (targets.length === 0) return;
      setBusy(true);
      setActionError(null);
      let failed = 0;
      for (const claim of targets) {
        if (mode === "abandon" && !ABANDONABLE.has(claim.state)) {
          failed += 1;
          continue;
        }
        const init =
          mode === "abandon"
            ? { params: { path: { id: claim.id }, header: { "If-Match": String(claim.version) } } }
            : { params: { path: { id: claim.id } } };
        const path =
          mode === "abandon"
            ? "/api/v1/medicaid-claims/{id}/abandon"
            : "/api/v1/medicaid-claims/{id}/validate";
        const { error: err } = (await client.POST(path as never, init as never)) as {
          error?: unknown;
        };
        if (err) failed += 1;
      }
      setBusy(false);
      if (failed > 0)
        setActionError(
          `${failed} of ${targets.length} claim${targets.length === 1 ? "" : "s"} could not be ${
            mode === "abandon" ? "abandoned" : "validated"
          } — check each claim's state and your permissions.`,
        );
      void load();
    },
    [client, rows, selected, load],
  );

  const selectionCount = selected.size;
  const selectedPreview = useMemo(
    () => rows.find((row) => row.id === selectedPreviewId) ?? null,
    [rows, selectedPreviewId],
  );
  const activeFilterCount =
    (state ? 1 : 0) +
    (kind ? 1 : 0) +
    (serviceState.trim() ? 1 : 0) +
    (mcoId.trim() ? 1 : 0) +
    (patientId.trim() ? 1 : 0);
  const clearFilters = (): void => {
    setState("");
    setKind("");
    setServiceState("");
    setMcoId("");
    setPatientId("");
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Medicaid Claims"
          actions={
            <>
              <a href="/medicaid/billing/ar-dashboard" style={linkButtonStyle}>
                AR dashboard
              </a>
              <a href="/medicaid/billing/claims/new" style={primaryLinkButtonStyle}>
                Assemble claim
              </a>
            </>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Filter, validate, abandon, and open Medicaid claims in the current organization scope.
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <MedicaidBillingTabs />
          </div>
        </PageHeader>
      }
      filters={
        <div style={{ display: "flex", flexDirection: "column" }}>
          <FilterBar
            activeFilterCount={activeFilterCount}
            onClear={activeFilterCount > 0 ? clearFilters : undefined}
            actions={
              <div
                style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
              >
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={selectionCount === 0 || busy}
                  loading={busy}
                  onClick={() => void runBulk("validate")}
                >
                  Validate now
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={selectionCount === 0 || busy}
                  loading={busy}
                  onClick={() => void runBulk("abandon")}
                >
                  Abandon
                </Button>
                <span style={mutedStyle}>
                  {selectionCount === 0 ? "No claims selected" : `${selectionCount} selected`}
                </span>
              </div>
            }
          >
            <label className="wx-filter-field">
              <span>State</span>
              <select
                className="wx-select"
                aria-label="Filter by claim state"
                value={state}
                onChange={(e) => setState(e.target.value)}
              >
                {STATE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wx-filter-field">
              <span>Kind</span>
              <select
                className="wx-select"
                aria-label="Filter by kind"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wx-filter-field" style={{ flex: "0 0 7rem", minWidth: "7rem" }}>
              <span>Service state</span>
              <input
                aria-label="Service state"
                value={serviceState}
                maxLength={2}
                placeholder="OR"
                onChange={(e) => setServiceState(e.target.value)}
                style={{ minHeight: "2.5rem", width: "100%" }}
              />
            </label>
            <div style={{ minWidth: "12rem" }}>
              <MdmEntityLookupField kind="payer" label="MCO" value={mcoId} onChange={setMcoId} />
            </div>
            <div style={{ minWidth: "12rem" }}>
              <PatientLookupField label="Patient" value={patientId} onChange={setPatientId} />
            </div>
          </FilterBar>
          {actionError ? (
            <p
              role="alert"
              aria-live="assertive"
              style={{ ...alertStyle, padding: "0 1.5rem 0.75rem" }}
            >
              {actionError}
            </p>
          ) : null}
        </div>
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
        ) : rows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No claims"
              description="No Medicaid claims match these filters. Assemble a claim to begin."
              action={
                activeFilterCount > 0 ? (
                  <Button size="sm" tone="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : (
                  <a href="/medicaid/billing/claims/new" style={primaryLinkButtonStyle}>
                    Assemble claim
                  </a>
                )
              }
            />
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
            <table style={{ ...tableStyle, fontSize: "0.875rem" }}>
              <thead>
                <tr style={headRowStyle}>
                  <th style={{ ...th, width: "2.5rem" }}>
                    <span style={visuallyHidden}>Select</span>
                  </th>
                  <th style={th}>Control #</th>
                  <th style={th}>Patient</th>
                  <th style={th}>State</th>
                  <th style={th}>Kind</th>
                  <th style={th}>TOB</th>
                  <th style={th}>Service dates</th>
                  <th style={th}>MCO</th>
                  <th style={th}>Status</th>
                  <th style={th}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const active = r.id === selectedPreviewId;
                  return (
                    <tr
                      key={r.id}
                      tabIndex={0}
                      style={{
                        ...enhancedRowLine,
                        background: active ? "var(--color-primary-tint)" : "transparent",
                        cursor: "pointer",
                      }}
                      className="wx-data-row-interactive"
                      onClick={() => setSelectedPreviewId(r.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedPreviewId(r.id);
                        }
                      }}
                    >
                      <td
                        style={td}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggle(r.id)}
                          aria-label={`Select claim ${r.medicaidClaimControlNumber}`}
                        />
                      </td>
                      <td style={tdMono}>
                        <a href={`/medicaid/billing/claims/${r.id}`} style={linkMonoStyle}>
                          {r.medicaidClaimControlNumber}
                        </a>
                      </td>
                      <td style={tdMono}>{shortId(r.patientId)}</td>
                      <td style={td}>{r.serviceState}</td>
                      <td style={td}>{kindLabel(r.kind)}</td>
                      <td style={tdMono}>{r.tob}</td>
                      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                        {shortDate(r.serviceFrom)} → {shortDate(r.serviceTo)}
                      </td>
                      <td style={tdMono}>{r.mcoId ? shortId(r.mcoId) : "FFS"}</td>
                      <td style={td}>
                        <StatusPill
                          label={humanize(r.state)}
                          tone={toneOf(CLAIM_STATE_TONE, r.state)}
                        />
                      </td>
                      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                        {shortDate(r.updatedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <CursorPagination
              loadedCount={rows.length}
              hasNextPage={hasMore}
              onNextPage={() => void load(nextCursor, true)}
              loading={loadingMore}
              noun="claims"
            />
          </div>
        )
      }
      detail={
        selectedPreview ? (
          <RightDetailPanel
            title="Claim Preview"
            onClose={() => setSelectedPreviewId(null)}
            hideScrollbar
          >
            <ClaimPreview claim={selectedPreview} />
          </RightDetailPanel>
        ) : null
      }
      fullPageScroll
    />
  );
}

function ClaimPreview({ claim }: { claim: ClaimRow }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        <a href={`/medicaid/billing/claims/${claim.id}`} style={linkMonoStyle}>
          {claim.medicaidClaimControlNumber}
        </a>
        <StatusPill label={humanize(claim.state)} tone={toneOf(CLAIM_STATE_TONE, claim.state)} />
      </header>
      <SummaryGrid>
        <Field label="Patient" value={shortId(claim.patientId)} mono />
        <Field label="Service state" value={claim.serviceState} />
        <Field label="Kind" value={kindLabel(claim.kind)} />
        <Field label="TOB" value={claim.tob} mono />
        <Field
          label="Service dates"
          value={`${shortDate(claim.serviceFrom)} to ${shortDate(claim.serviceTo)}`}
        />
        <Field label="MCO" value={claim.mcoId ? shortId(claim.mcoId) : "Fee-for-service"} mono />
        <Field label="Updated" value={shortDate(claim.updatedAt)} />
        <Field label="Version" value={claim.version.toLocaleString()} />
      </SummaryGrid>
      <a href={`/medicaid/billing/claims/${claim.id}`} style={primaryLinkButtonStyle}>
        Open editor
      </a>
    </div>
  );
}

const headRowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const enhancedRowLine = {
  ...rowLine,
  borderTop: "none",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const linkButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "2rem",
  padding: "0.35rem 0.7rem",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.75rem",
  fontWeight: 650,
  textDecoration: "none",
};
const primaryLinkButtonStyle = {
  ...linkButtonStyle,
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
};

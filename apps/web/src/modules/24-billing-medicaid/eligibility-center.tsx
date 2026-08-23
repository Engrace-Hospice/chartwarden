import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  MaskedIdentifier,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the ELIGIBILITY CENTER (R2, §5.1 #15). Per-patient
// Medicaid eligibility history with the MCO assignment timeline and a refresh action. The Recipient ID is
// NEVER returned by the API — only the masked last-4 fact (D12 / §3.6) — so it renders through the shared
// MaskedIdentifier primitive, which is the system's one honest way to show "we hold this, masked". A check
// past its staleness horizon is called out because assembly and submission both validate freshness.
// Backed by GET/POST /api/v1/medicaid-eligibility-checks. Lantern: WorkQueueLayout + No-Line table (§6.7).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { ELIGIBILITY_OUTCOME_TONE, humanize, shortDate, shortId, toneOf } from "./medicaid-status";
import {
  FilterRow,
  alertStyle,
  inputStyle,
  mutedStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  th,
} from "./medicaid-ui";

interface EligibilityCheck {
  id: string;
  patientId: string;
  patientPayerId: string;
  serviceState: string;
  asOfServiceDate: string;
  outcome: string;
  mcoId: string | null;
  recipientIdMaskedAtCheck: string | null;
  checkedAt: string;
  staleAt: string;
  errorMessage: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function MedicaidEligibilityCenter(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<EligibilityCheck[]>([]);
  const [patientId, setPatientId] = useState("");
  const [payerId, setPayerId] = useState("");
  const [asOf, setAsOf] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: Record<string, string> = {};
    if (UUID_RE.test(patientId)) query.patientId = patientId;
    const res = await client.GET("/api/v1/medicaid-eligibility-checks", {
      params: { query },
    } as never);
    if (res.error) {
      setError("Eligibility history is unavailable — you may lack billing visibility.");
      setLoading(false);
      return;
    }
    setRows((res.data as unknown as EligibilityCheck[]) ?? []);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const canRefresh = UUID_RE.test(patientId) && UUID_RE.test(payerId) && ISO_DATE_RE.test(asOf);

  const refresh = useCallback(async () => {
    if (!canRefresh) return;
    setBusy(true);
    setActionError(null);
    const { error: err, response } = (await client.POST("/api/v1/medicaid-eligibility-checks", {
      body: { patientId, patientPayerId: payerId, asOfServiceDate: asOf },
    } as never)) as { error?: unknown; response?: Response };
    setBusy(false);
    if (err) {
      setActionError(refreshErrorMessage(response?.status));
      return;
    }
    void load();
  }, [client, canRefresh, patientId, payerId, asOf, load]);

  const ordered = useMemo(
    () => [...rows].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)),
    [rows],
  );
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((r) =>
      [
        r.id,
        r.patientId,
        r.patientPayerId,
        r.serviceState,
        r.outcome,
        r.mcoId ?? "",
        r.recipientIdMaskedAtCheck ?? "",
      ].some((value) => value.toLowerCase().includes(q)),
    );
  }, [ordered, searchQuery]);
  const nowIso = new Date().toISOString();
  const freshCount = rows.filter((r) => r.staleAt > nowIso).length;
  const staleCount = rows.length - freshCount;
  const eligibleCount = rows.filter((r) => r.outcome === "eligible").length;
  const errorCount = rows.filter((r) => r.outcome === "error" || r.errorMessage).length;
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || patientId !== "";

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Eligibility"
          breadcrumb="Billing — Medicaid · coverage and MCO assignment"
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review eligibility history, masked recipient identifiers, MCO routing, and freshness.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Checks"
            value={loading || error ? "—" : rows.length}
            detail="History loaded"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Eligible"
            value={loading || error ? "—" : eligibleCount}
            detail="Coverage confirmed"
            tone="success"
            accentColor="var(--color-success)"
          />
          <KpiCard
            label="Fresh"
            value={loading || error ? "—" : freshCount}
            detail="Inside horizon"
            tone="success"
            accentColor="var(--color-success)"
          />
          <KpiCard
            label="Stale"
            value={loading || error ? "—" : staleCount}
            detail="Blocks submission"
            tone={staleCount > 0 ? "warning" : "neutral"}
            accentColor={staleCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Errors"
            value={loading || error ? "—" : errorCount}
            detail="Need follow-up"
            tone={errorCount > 0 ? "danger" : "neutral"}
            accentColor={errorCount > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
          />
        </KpiStrip>
      }
      filters={
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            padding: "0 1.5rem 0.75rem",
          }}
        >
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          <FilterRow>
            <div style={{ position: "relative", minWidth: "16rem" }}>
              <input
                type="search"
                placeholder="Search history by patient, state, outcome..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search eligibility history"
                style={{
                  width: "100%",
                  paddingLeft: "2rem",
                  height: "2.25rem",
                  fontSize: "0.85rem",
                }}
              />
              <div style={searchIconStyle}>
                <Glyph name="eye" size={14} />
              </div>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={mutedStyle}>Patient id</span>
              <input
                aria-label="Patient id"
                value={patientId}
                onChange={(e) => {
                  setPatientId(e.target.value);
                  setPage(1);
                }}
                style={inputStyle}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={mutedStyle}>Patient payer id</span>
              <input
                aria-label="Patient payer id"
                value={payerId}
                onChange={(e) => setPayerId(e.target.value)}
                style={inputStyle}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={mutedStyle}>As of service date</span>
              <input
                aria-label="As of service date"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                style={inputStyle}
              />
            </label>
            <Button
              type="button"
              tone="primary"
              size="sm"
              onClick={() => void refresh()}
              disabled={!canRefresh || busy}
            >
              {busy ? "Checking..." : "Refresh eligibility"}
            </Button>
            {hasActiveFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setPatientId("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filteredRows.length} of {rows.length} checks
            </span>
          </FilterRow>
          {actionError ? (
            <p role="alert" aria-live="assertive" style={alertStyle}>
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
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No eligibility checks"
              description={
                hasActiveFilters
                  ? "No eligibility check matches these filters."
                  : "Enter a patient, payer, and service date, then refresh to run a check."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setPatientId("");
                      setPage(1);
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
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={th}>Checked</th>
                  <th style={th}>Patient</th>
                  <th style={th}>State</th>
                  <th style={th}>As of</th>
                  <th style={th}>Outcome</th>
                  <th style={th}>MCO</th>
                  <th style={th}>Recipient ID</th>
                  <th style={th}>Freshness</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((r) => {
                  const stale = r.staleAt <= nowIso;
                  return (
                    <tr key={r.id} style={rowLine} className="wx-data-row-interactive">
                      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                        {r.checkedAt.slice(0, 16).replace("T", " ")}
                      </td>
                      <td style={tdMono}>{shortId(r.patientId)}</td>
                      <td style={td}>{r.serviceState}</td>
                      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                        {shortDate(r.asOfServiceDate)}
                      </td>
                      <td style={td}>
                        <StatusPill
                          label={humanize(r.outcome)}
                          tone={toneOf(ELIGIBILITY_OUTCOME_TONE, r.outcome)}
                        />
                        {r.errorMessage ? (
                          <div style={mutedStyle} title={r.errorMessage}>
                            {r.errorMessage.slice(0, 60)}
                          </div>
                        ) : null}
                      </td>
                      <td style={tdMono}>{r.mcoId ? shortId(r.mcoId) : "FFS"}</td>
                      <td style={td}>
                        {r.recipientIdMaskedAtCheck ? (
                          // No value beyond the mask ever reaches the browser, and no reveal is wired.
                          <MaskedIdentifier
                            label="Recipient ID"
                            value=""
                            masked={r.recipientIdMaskedAtCheck}
                          />
                        ) : (
                          <span style={mutedStyle}>—</span>
                        )}
                      </td>
                      <td style={td}>
                        <StatusPill
                          label={stale ? "Stale" : `Fresh to ${shortDate(r.staleAt)}`}
                          tone={stale ? "warning" : "success"}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredRows.length}
              onPageChange={setPage}
              onPageSizeChange={(next) => {
                setPageSize(next);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="checks"
            />
          </div>
        )
      }
      detail={
        <span style={mutedStyle}>
          The full Recipient ID is never returned to the browser — only the masked last-4 recorded
          at check time. A stale check is a validation finding at assembly and blocks submission.
        </span>
      }
    />
  );
}

/** Map an eligibility-refresh status code to a precise, PHI-free inline message (§5.4). */
function refreshErrorMessage(status: number | undefined): string {
  if (status === 404) return "That patient or payer record was not found in your organization.";
  if (status === 422)
    return "The payer is not a Medicaid payer, or the service date is out of range.";
  if (status === 401 || status === 403) return "You lack permission to run eligibility checks.";
  if (status === 503)
    return "The state eligibility adapter is not wired for this service state — no check was run.";
  return "The eligibility check could not be completed.";
}

const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};

const searchIconStyle = {
  position: "absolute" as const,
  left: "0.625rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none" as const,
};

const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};

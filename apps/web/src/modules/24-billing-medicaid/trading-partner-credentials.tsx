import {
  Button,
  EmptyState,
  Glyph,
  GuardChip,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the STATE TRADING PARTNER CREDENTIALS (R2, §5.1 #16). The
// org admin's per-ProviderEntity per-state channel configuration: trading-partner id, channel, MCO scope,
// active window, and a sandbox connectivity test. Secrets are WRITE-ONLY — the read surface returns only
// presence flags (§3.6), so this screen shows "configured / not configured" and never a value, not even
// masked. The sandbox test is a server-side adapter round trip; in an environment where the state adapter
// is not wired it returns the ADAPTER_NOT_WIRED deferral, surfaced here as a precise inline message.
// Backed by GET/POST /api/v1/state-medicaid-trading-partner-credentials (+ /{id}/test). Lantern:
// WorkQueueLayout + No-Line table (§6.7) + §6.6 StatusPill; CSS-var tokens only.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { SANDBOX_RESULT_TONE, channelLabel, shortDate, shortId, toneOf } from "./medicaid-status";
import {
  FilterRow,
  SelectFilter,
  alertStyle,
  mutedStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  th,
} from "./medicaid-ui";

interface Credential {
  id: string;
  providerEntityId: string;
  serviceState: string;
  channel: string;
  mcoId: string | null;
  tradingPartnerId: string;
  clientId: string | null;
  sftpHost: string | null;
  portalUrl: string | null;
  activeFrom: string;
  activeTo: string | null;
  lastSandboxTestAt: string | null;
  lastSandboxTestResult: string | null;
  hasClientSecret: boolean;
  hasSftpKey: boolean;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function MedicaidTradingPartnerCredentials(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Credential[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/state-medicaid-trading-partner-credentials", {});
    if (res.error) {
      setError(
        "Trading-partner credentials are unavailable — this surface requires org-admin access.",
      );
      setLoading(false);
      return;
    }
    setRows((res.data as unknown as Credential[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const runTest = useCallback(
    async (credentialId: string) => {
      setTestingId(credentialId);
      setActionError(null);
      const {
        data,
        error: err,
        response,
      } = (await client.POST("/api/v1/state-medicaid-trading-partner-credentials/{id}/test", {
        params: { path: { id: credentialId } },
      } as never)) as {
        data?: { ok?: boolean; errorMessage?: string };
        error?: unknown;
        response?: Response;
      };
      setTestingId(null);
      if (err) {
        setActionError(testErrorMessage(response?.status));
        return;
      }
      if (data && data.ok === false)
        setActionError(data.errorMessage ?? "The sandbox test did not succeed.");
      void load();
    },
    [client, load],
  );

  const stateOptions = useMemo(
    () => [
      { value: "", label: "Any state" },
      ...Array.from(new Set(rows.map((r) => r.serviceState)))
        .sort()
        .map((value) => ({ value, label: value })),
    ],
    [rows],
  );
  const channelOptions = useMemo(
    () => [
      { value: "", label: "Any channel" },
      ...Array.from(new Set(rows.map((r) => r.channel)))
        .sort()
        .map((value) => ({ value, label: channelLabel(value) })),
    ],
    [rows],
  );
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows.filter((c) => {
      const matchesState = !stateFilter || c.serviceState === stateFilter;
      const matchesChannel = !channelFilter || c.channel === channelFilter;
      const matchesSearch =
        !q ||
        [
          c.id,
          c.providerEntityId,
          c.serviceState,
          c.channel,
          c.mcoId ?? "",
          c.tradingPartnerId,
          c.clientId ?? "",
          c.sftpHost ?? "",
          c.portalUrl ?? "",
          c.lastSandboxTestResult ?? "",
        ].some((value) => value.toLowerCase().includes(q));
      return matchesState && matchesChannel && matchesSearch;
    });
  }, [channelFilter, rows, searchQuery, stateFilter]);

  const now = new Date().toISOString().slice(0, 10);
  const activeCount = rows.filter(
    (c) => c.activeFrom <= now && (!c.activeTo || c.activeTo >= now),
  ).length;
  const testedCount = rows.filter((c) => c.lastSandboxTestAt).length;
  const passingCount = rows.filter((c) => c.lastSandboxTestResult === "success").length;
  const secretGapCount = rows.filter((c) => !c.hasClientSecret && !c.hasSftpKey).length;
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || stateFilter !== "" || channelFilter !== "";

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Trading Partner Credentials"
          breadcrumb="Billing — Medicaid · state channel configuration"
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Monitor state channel setup, secret presence, active windows, and sandbox readiness.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Credentials"
            value={loading || error ? "—" : rows.length}
            detail="Total configured"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Active"
            value={loading || error ? "—" : activeCount}
            detail="Inside window"
            tone="success"
            accentColor="var(--color-success)"
          />
          <KpiCard
            label="Tested"
            value={loading || error ? "—" : testedCount}
            detail="Sandbox attempted"
            tone={testedCount > 0 ? "info" : "neutral"}
            accentColor={testedCount > 0 ? "var(--color-primary)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Passing"
            value={loading || error ? "—" : passingCount}
            detail="Last result success"
            tone={passingCount > 0 ? "success" : "neutral"}
            accentColor={passingCount > 0 ? "var(--color-success)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Secret Gaps"
            value={loading || error ? "—" : secretGapCount}
            detail="No secret/key"
            tone={secretGapCount > 0 ? "warning" : "neutral"}
            accentColor={
              secretGapCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
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
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search state, entity, partner, host..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search trading-partner credentials"
              />
            </label>
            <SelectFilter
              label="State"
              value={stateFilter}
              options={stateOptions}
              onChange={(next) => {
                setStateFilter(next);
                setPage(1);
              }}
            />
            <SelectFilter
              label="Channel"
              value={channelFilter}
              options={channelOptions}
              onChange={(next) => {
                setChannelFilter(next);
                setPage(1);
              }}
            />
            {hasActiveFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setStateFilter("");
                  setChannelFilter("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filteredRows.length} of {rows.length} credentials
            </span>
          </FilterRow>
          <GuardChip
            tone="warning"
            reason="Changing a trading-partner credential affects every future submission for that state and entity."
          />
          {actionError ? (
            <p role="alert" aria-live="assertive" style={alertStyle}>
              {actionError}
            </p>
          ) : null}
        </div>
      }
      detail={
        <span style={mutedStyle}>
          Client secrets and SFTP keys are stored encrypted and are never returned to the browser —
          not even masked. This surface shows only whether each is configured.
        </span>
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
              title="No credentials"
              description={
                hasActiveFilters
                  ? "No state trading-partner credential matches these filters."
                  : "No state trading-partner credential is configured for your provider entities."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setStateFilter("");
                      setChannelFilter("");
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
                  <th style={th}>State</th>
                  <th style={th}>Provider entity</th>
                  <th style={th}>Channel</th>
                  <th style={th}>MCO</th>
                  <th style={th}>Trading partner</th>
                  <th style={th}>Secrets</th>
                  <th style={th}>Active</th>
                  <th style={th}>Last sandbox test</th>
                  <th style={{ ...th, textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((c) => {
                  const testing = testingId === c.id;
                  return (
                    <tr key={c.id} style={rowLine}>
                      <td style={td}>{c.serviceState}</td>
                      <td style={tdMono}>{shortId(c.providerEntityId)}</td>
                      <td style={td}>
                        {channelLabel(c.channel)}
                        {c.sftpHost ? (
                          <div style={{ ...mutedStyle, fontFamily: "var(--font-mono)" }}>
                            {c.sftpHost}
                          </div>
                        ) : null}
                      </td>
                      <td style={tdMono}>{c.mcoId ? shortId(c.mcoId) : "FFS"}</td>
                      <td style={tdMono}>{c.tradingPartnerId}</td>
                      <td style={td}>
                        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                          <SecretFlag label="Client secret" present={c.hasClientSecret} />
                          <SecretFlag label="SFTP key" present={c.hasSftpKey} />
                        </div>
                      </td>
                      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                        {shortDate(c.activeFrom)} → {c.activeTo ? shortDate(c.activeTo) : "open"}
                      </td>
                      <td style={td}>
                        {c.lastSandboxTestAt ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                            <StatusPill
                              label={c.lastSandboxTestResult ?? "Unknown"}
                              tone={toneOf(SANDBOX_RESULT_TONE, c.lastSandboxTestResult)}
                            />
                            <span style={mutedStyle}>{shortDate(c.lastSandboxTestAt)}</span>
                          </div>
                        ) : (
                          <StatusPill label="Never tested" tone="neutral" />
                        )}
                      </td>
                      <td style={{ ...td, textAlign: "right" }}>
                        <Button
                          type="button"
                          size="sm"
                          tone="secondary"
                          onClick={() => void runTest(c.id)}
                          disabled={testing}
                          aria-label={`Run sandbox test for ${c.serviceState} ${c.tradingPartnerId}`}
                        >
                          {testing ? "Testing..." : "Test"}
                        </Button>
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
              noun="credentials"
            />
          </div>
        )
      }
    />
  );
}

/** Presence-only secret indicator — the value never crosses the wire (§3.6). */
function SecretFlag({ label, present }: { label: string; present: boolean }): JSX.Element {
  return (
    <span
      title={`${label}: ${present ? "configured" : "not configured"}`}
      aria-label={`${label} ${present ? "configured" : "not configured"}`}
      style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem", fontSize: "0.75rem" }}
    >
      <Glyph name={present ? "lock" : "block"} size={13} label="" />
      {present ? "Set" : "—"}
    </span>
  );
}

/** Map a sandbox-test status code to a precise inline message (§5.4). */
function testErrorMessage(status: number | undefined): string {
  if (status === 401 || status === 403) return "You lack permission to run a sandbox test.";
  if (status === 404) return "That credential no longer exists — reload the list.";
  if (status === 503)
    return "The state adapter is not wired in this environment — no connectivity test was performed.";
  return "The sandbox test could not be completed.";
}

const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
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

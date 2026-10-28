import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/26-cap — M26, the PLATFORM CONSTANTS ADMIN (R2, §5.1.7). Platform-admin-only: the
// CMS-published per-cap-year aggregate cap amounts (D3). Publish/amend are server-authoritative platform-admin
// mutations (amend only before first tenant use); this read surface gates nav visibility only (ADR-0030). It
// renders only in the platform-admin shell. Lantern: WorkQueueLayout + No-Line table + §6.6 StatusPill.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { money, shortDate } from "./cap-status";

interface Constant {
  capYear: string;
  aggregateCapAmountCents: number | null;
  inpatientCapPct: number;
  sourceUrl: string | null;
  firstTenantUseAt: string | null;
  recordedAt: string;
}

const cell = { padding: "0.55rem 0.75rem", textAlign: "left" as const };
const head = {
  ...cell,
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
const row = { borderTop: "1px solid var(--color-surface-container)" };

export function CapPlatformConstants(): JSX.Element {
  const client = useApiClient();
  const [constants, setConstants] = useState<Constant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/platform/cap/constants");
    if (res.error) {
      setError("Platform cap constants are unavailable — platform-admin only.");
      setLoading(false);
      return;
    }
    setConstants((res.data as unknown as Constant[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Cap Constants">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Platform-admin view of CMS-published per-beneficiary cap constants and tenant-use lock
            state.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          <div style={infoBannerStyle}>
            Constants can be amended only before first tenant use. Once a tenant calculation
            consumes a cap year, the row becomes historical evidence rather than an editable
            default.
          </div>
        </div>
      }
      table={
        constants.length === 0 ? (
          <div style={emptyShellStyle}>
            <EmptyState
              title="No published constants"
              description="Publish the CMS per-beneficiary cap amount for a cap year."
            />
          </div>
        ) : (
          <div style={tableShellStyle}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={tableHeadRowStyle}>
                  <th style={head}>Cap year</th>
                  <th style={{ ...head, textAlign: "right" }}>Per-beneficiary cap</th>
                  <th style={{ ...head, textAlign: "right" }}>Inpatient %</th>
                  <th style={head}>First tenant use</th>
                  <th style={head}>Source</th>
                  <th style={head}>Published</th>
                </tr>
              </thead>
              <tbody>
                {constants.map((c) => (
                  <tr key={c.capYear} style={row}>
                    <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>{c.capYear}</td>
                    <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {c.aggregateCapAmountCents == null ? (
                        <StatusPill tone="warning" label="Unpublished" />
                      ) : (
                        money(c.aggregateCapAmountCents)
                      )}
                    </td>
                    <td style={{ ...cell, textAlign: "right" }}>
                      {(c.inpatientCapPct * 100).toFixed(0)}%
                    </td>
                    <td style={cell}>
                      {c.firstTenantUseAt ? (
                        <StatusPill tone="neutral" label={shortDate(c.firstTenantUseAt)} />
                      ) : (
                        <StatusPill tone="success" label="Amendable" />
                      )}
                    </td>
                    <td style={cell}>
                      {c.sourceUrl ? (
                        <a href={c.sourceUrl} target="_blank" rel="noreferrer">
                          {sourceLabel(c.sourceUrl)}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={cell}>{shortDate(c.recordedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
      fullPageScroll
    />
  );
}

// FY2027 workstream E (migration 0393): the seeded FY2026/FY2027 rows cite their Federal Register document
// (federalregister.gov/d/<doc number>); show the doc number rather than the bare URL.
function sourceLabel(url: string): string {
  const doc = /federalregister\.gov\/d\/([\w-]+)/.exec(url)?.[1];
  return doc ? `Federal Register ${doc}` : "CMS source";
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const tableShellStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const tableHeadRowStyle: CSSProperties = {
  background: "var(--color-surface-low)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const emptyShellStyle: CSSProperties = {
  padding: "2rem 1.5rem",
};

const infoBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)",
  background: "var(--color-primary-tint)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};

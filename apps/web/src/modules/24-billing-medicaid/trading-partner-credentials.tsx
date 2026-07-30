import {
  EmptyState,
  Glyph,
  GuardChip,
  LoadingSpinner,
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
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { SANDBOX_RESULT_TONE, channelLabel, shortDate, shortId, toneOf } from "./medicaid-status";
import {
  Card,
  alertStyle,
  disabledButtonStyle,
  ghostButtonStyle,
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

export function MedicaidTradingPartnerCredentials(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/state-medicaid-trading-partner-credentials", {});
    if (res.error) {
      setError("Trading-partner credentials are unavailable — this surface requires org-admin access.");
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
      const { data, error: err, response } = (await client.POST(
        "/api/v1/state-medicaid-trading-partner-credentials/{id}/test",
        { params: { path: { id: credentialId } } } as never,
      )) as { data?: { ok?: boolean; errorMessage?: string }; error?: unknown; response?: Response };
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

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Trading Partner Credentials"
          breadcrumb="Billing — Medicaid · state channel configuration"
        />
      }
      filters={
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
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
        <Card title="About secrets">
          <span style={mutedStyle}>
            Client secrets and SFTP keys are stored encrypted and are never returned to the browser — not
            even masked. This surface shows only whether each is configured.
          </span>
        </Card>
      }
      table={
        rows.length === 0 ? (
        <EmptyState
          title="No credentials"
          description="No state trading-partner credential is configured for your provider entities."
        />
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
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
            {rows.map((c) => {
              const testing = testingId === c.id;
              return (
                <tr key={c.id} style={rowLine}>
                  <td style={td}>{c.serviceState}</td>
                  <td style={tdMono}>{shortId(c.providerEntityId)}</td>
                  <td style={td}>
                    {channelLabel(c.channel)}
                    {c.sftpHost ? (
                      <div style={{ ...mutedStyle, fontFamily: "var(--font-mono)" }}>{c.sftpHost}</div>
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
                    <button
                      type="button"
                      onClick={() => void runTest(c.id)}
                      disabled={testing}
                      aria-label={`Run sandbox test for ${c.serviceState} ${c.tradingPartnerId}`}
                      style={testing ? disabledButtonStyle : ghostButtonStyle}
                    >
                      {testing ? "Testing…" : "Test"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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

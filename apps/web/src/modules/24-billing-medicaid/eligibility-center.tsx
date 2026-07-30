import {
  EmptyState,
  LoadingSpinner,
  MaskedIdentifier,
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
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { ELIGIBILITY_OUTCOME_TONE, humanize, shortDate, shortId, toneOf } from "./medicaid-status";
import {
  alertStyle,
  disabledButtonStyle,
  inputStyle,
  mutedStyle,
  primaryButtonStyle,
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

export function MedicaidEligibilityCenter(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<EligibilityCheck[]>([]);
  const [patientId, setPatientId] = useState("");
  const [payerId, setPayerId] = useState("");
  const [asOf, setAsOf] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: Record<string, string> = {};
    if (UUID_RE.test(patientId)) query.patientId = patientId;
    const res = await client.GET("/api/v1/medicaid-eligibility-checks", { params: { query } } as never);
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

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const ordered = [...rows].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  const nowIso = new Date().toISOString();

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Eligibility"
          breadcrumb="Billing — Medicaid · coverage and MCO assignment"
        />
      }
      filters={
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={mutedStyle}>Patient id</span>
              <input
                aria-label="Patient id"
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
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
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={!canRefresh || busy}
              style={!canRefresh || busy ? disabledButtonStyle : primaryButtonStyle}
            >
              {busy ? "Checking…" : "Refresh eligibility"}
            </button>
          </div>
          {actionError ? (
            <p role="alert" aria-live="assertive" style={alertStyle}>
              {actionError}
            </p>
          ) : null}
        </div>
      }
      table={
        ordered.length === 0 ? (
          <EmptyState
            title="No eligibility checks"
            description="Enter a patient, payer, and service date, then refresh to run a check."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
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
              {ordered.map((r) => {
                const stale = r.staleAt <= nowIso;
                return (
                  <tr key={r.id} style={rowLine}>
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
                        // No `value` beyond the mask ever reaches the browser, and no onReveal is wired —
                        // the control is a read-only mask by construction (D12 / §3.6).
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
        )
      }
      detail={
        <span style={mutedStyle}>
          The full Recipient ID is never returned to the browser — only the masked last-4 recorded at check
          time. A stale check is a validation finding at assembly and blocks submission.
        </span>
      }
    />
  );
}

/** Map an eligibility-refresh status code to a precise, PHI-free inline message (§5.4). */
function refreshErrorMessage(status: number | undefined): string {
  if (status === 404) return "That patient or payer record was not found in your organization.";
  if (status === 422) return "The payer is not a Medicaid payer, or the service date is out of range.";
  if (status === 401 || status === 403) return "You lack permission to run eligibility checks.";
  if (status === 503)
    return "The state eligibility adapter is not wired for this service state — no check was run.";
  return "The eligibility check could not be completed.";
}

import { StatusPill, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Amendment request (`/p/:patientId/amendments`). HIPAA §164.526: a caregiver may ask
// for a correction to the record. The submit (POST /portal/amendments/submit) goes to M5, which owns the
// amendment workflow; M31 holds only the reference + a status mirror it lists back (GET /portal/amendments).
// The portal never edits the record directly — it forwards a request and reflects its state.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, FormEvent, JSX } from "react";
import { day, humanize, readError, statusTone } from "./portal-format";
import {
  PortalCard,
  PortalLoadState,
  PortalPage,
  tableCell,
  tableHead,
  tableRow,
} from "./portal-page";

interface Amendment {
  id?: string;
  targetKind?: string;
  requestedChange?: string;
  status?: string;
  submittedAt?: string;
}
type TargetKind = "patient_demographic" | "encounter_narrative";

const control: CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.6rem",
  borderRadius: "0.45rem",
  border: `1px solid ${t.surfaceContainer}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.9rem",
};
const primaryBtn: CSSProperties = {
  padding: "0.55rem 0.9rem",
  borderRadius: "0.5rem",
  border: "none",
  background: t.primary,
  color: t.onPrimary,
  fontWeight: 600,
  cursor: "pointer",
};

export function PortalAmendments(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Amendment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetKind, setTargetKind] = useState<TargetKind>("patient_demographic");
  const [requestedChange, setRequestedChange] = useState("");
  const [submitState, setSubmitState] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const res = await client.GET("/api/v1/portal/amendments", {});
    if (res.error) setError(readError(res.response?.status));
    else setRows((res.data?.items ?? []) as unknown as Amendment[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (active) await load();
    })();
    return () => {
      active = false;
    };
  }, [load]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitState(null);
    const res = await client.POST("/api/v1/portal/amendments/submit", {
      body: { targetKind, requestedChange },
    });
    if (res.error) {
      setSubmitState({ tone: "err", msg: readError(res.response?.status) });
      return;
    }
    setSubmitState({ tone: "ok", msg: "Your request was submitted. Your team will review it." });
    setRequestedChange("");
    await load();
  }

  return (
    <PortalPage
      title="Request a correction"
      subtitle="Ask your team to fix something in the record (HIPAA §164.526)."
    >
      <PortalCard heading="New request">
        <form onSubmit={(e) => void submit(e)} style={{ display: "grid", gap: "0.6rem" }}>
          <select
            value={targetKind}
            onChange={(e) => setTargetKind(e.target.value as TargetKind)}
            style={control}
            aria-label="What to correct"
          >
            <option value="patient_demographic">Personal details (name, address, contact)</option>
            <option value="encounter_narrative">Something written about a visit</option>
          </select>
          <textarea
            value={requestedChange}
            onChange={(e) => setRequestedChange(e.target.value)}
            required
            rows={3}
            placeholder="Describe what should be corrected and why."
            style={control}
            aria-label="Requested change"
          />
          <div>
            <button type="submit" style={primaryBtn} disabled={requestedChange.trim().length === 0}>
              Submit request
            </button>
          </div>
          {submitState ? (
            <p
              role={submitState.tone === "err" ? "alert" : "status"}
              style={{
                margin: 0,
                fontSize: "0.85rem",
                color: submitState.tone === "err" ? t.error : t.success,
              }}
            >
              {submitState.msg}
            </p>
          ) : null}
        </form>
      </PortalCard>

      <PortalLoadState
        loading={loading}
        error={error}
        empty={rows.length === 0}
        emptyTitle="No requests yet"
        emptyDescription="Correction requests you submit will be tracked here."
      >
        <PortalCard heading="Your requests">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={tableHead}>Submitted</th>
                <th style={tableHead}>About</th>
                <th style={tableHead}>Request</th>
                <th style={tableHead}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a, i) => (
                <tr key={a.id ?? i} style={tableRow}>
                  <td style={tableCell}>{day(a.submittedAt)}</td>
                  <td style={tableCell}>{a.targetKind ? humanize(a.targetKind) : "—"}</td>
                  <td style={tableCell}>{a.requestedChange ?? "—"}</td>
                  <td style={tableCell}>
                    {a.status ? (
                      <StatusPill tone={statusTone(a.status)} label={humanize(a.status)} />
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PortalCard>
      </PortalLoadState>
    </PortalPage>
  );
}

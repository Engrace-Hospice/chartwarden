import { StatusPill, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Medication list + administration log (`/p/:patientId/medications`). Reads the active
// medications (GET /portal/medications/active) and recent caregiver-attested administrations
// (GET /portal/administrations/recent). The attestation panel POSTs to /portal/administrations/caregiver-attested
// — the M13 caregiver-attested write path (M31-T06). The write is server-gated by ABAC
// `portal_caregiver_is_primary_or_dpoa`; a family (non-primary) caregiver still SEES the panel but the server
// answers 403, which we surface plainly rather than hiding the affordance and pretending it doesn't exist.
import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent, JSX } from "react";
import { day, humanize, readError } from "./portal-format";
import {
  PortalCard,
  PortalLoadState,
  PortalPage,
  tableCell,
  tableHead,
  tableRow,
} from "./portal-page";

interface Medication {
  medicationOrderId: string;
  drugName: string;
  dose?: string;
  route?: string;
  scheduleSummary?: string;
  isPrn?: boolean;
}
interface Administration {
  drugName?: string;
  administeredAt?: string;
  administeredAmount?: number;
  administeredUnit?: string;
}

const field: CSSProperties = {
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

export function PortalMedicationList(): JSX.Element {
  const client = useApiClient();
  const [meds, setMeds] = useState<Medication[]>([]);
  const [log, setLog] = useState<Administration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [orderId, setOrderId] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState("");
  const [route, setRoute] = useState("");
  const [attestText, setAttestText] = useState("");
  const [submitState, setSubmitState] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    const [mRes, aRes] = await Promise.all([
      client.GET("/api/v1/portal/medications/active", {}),
      client.GET("/api/v1/portal/administrations/recent", {}),
    ]);
    if (mRes.error) setError(readError(mRes.response?.status));
    else setMeds((mRes.data?.items ?? []) as unknown as Medication[]);
    if (!aRes.error) setLog((aRes.data?.items ?? []) as unknown as Administration[]);
    setLoading(false);
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      if (active) await load();
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  async function attest(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitState(null);
    const res = await client.POST("/api/v1/portal/administrations/caregiver-attested", {
      body: {
        medicationOrderId: orderId,
        administeredAt: new Date().toISOString(),
        administeredAmount: Number(amount),
        administeredUnit: unit,
        route,
        caregiverAttestationText: attestText,
      },
    });
    if (res.error) {
      setSubmitState({ tone: "err", msg: readError(res.response?.status) });
      return;
    }
    setSubmitState({ tone: "ok", msg: "Administration recorded. Thank you." });
    setOrderId("");
    setAmount("");
    setUnit("");
    setRoute("");
    setAttestText("");
    await load();
  }

  return (
    <PortalPage title="Medications" subtitle="Active medications and the doses you've given.">
      <PortalLoadState
        loading={loading}
        error={error}
        empty={meds.length === 0}
        emptyTitle="No active medications"
        emptyDescription="Active medications will appear here."
      >
        <PortalCard heading="Active medications">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={tableHead}>Medication</th>
                <th style={tableHead}>Dose</th>
                <th style={tableHead}>Route</th>
                <th style={tableHead}>Schedule</th>
              </tr>
            </thead>
            <tbody>
              {meds.map((m) => (
                <tr key={m.medicationOrderId} style={tableRow}>
                  <td style={tableCell}>
                    {m.drugName} {m.isPrn ? <StatusPill tone="neutral" label="As needed" /> : null}
                  </td>
                  <td style={tableCell}>{m.dose ?? "—"}</td>
                  <td style={tableCell}>{m.route ? humanize(m.route) : "—"}</td>
                  <td style={tableCell}>{m.scheduleSummary ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PortalCard>

        <PortalCard heading="Record a dose you gave">
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: t.onSurfaceVariant }}>
            Only the primary caregiver or a healthcare DPOA can record an administration. If the
            button is declined, your team can help set this up.
          </p>
          <form onSubmit={(e) => void attest(e)} style={{ display: "grid", gap: "0.6rem" }}>
            <select
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              required
              style={field}
              aria-label="Medication"
            >
              <option value="">Select a medication…</option>
              {meds.map((m) => (
                <option key={m.medicationOrderId} value={m.medicationOrderId}>
                  {m.drugName}
                </option>
              ))}
            </select>
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <input
                type="number"
                step="any"
                min="0"
                placeholder="Amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                style={{ ...field, flex: 1 }}
                aria-label="Amount given"
              />
              <input
                type="text"
                placeholder="Unit (e.g. mg)"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                required
                style={{ ...field, flex: 1 }}
                aria-label="Unit"
              />
              <input
                type="text"
                placeholder="Route (e.g. oral)"
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                required
                style={{ ...field, flex: 1 }}
                aria-label="Route"
              />
            </div>
            <textarea
              placeholder="Attestation — confirm what you gave and when"
              value={attestText}
              onChange={(e) => setAttestText(e.target.value)}
              required
              rows={2}
              style={field}
              aria-label="Attestation"
            />
            <div>
              <button type="submit" style={primaryBtn}>
                Record administration
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

        {log.length > 0 ? (
          <PortalCard heading="Recent doses given">
            <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.88rem" }}>
              {log.map((a, i) => (
                <li key={i}>
                  {day(a.administeredAt)} — {a.drugName ?? "Medication"}
                  {a.administeredAmount != null
                    ? ` (${a.administeredAmount} ${a.administeredUnit ?? ""})`
                    : ""}
                </li>
              ))}
            </ul>
          </PortalCard>
        ) : null}
      </PortalLoadState>
    </PortalPage>
  );
}

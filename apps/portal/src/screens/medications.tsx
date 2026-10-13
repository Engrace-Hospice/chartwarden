import {
  Button,
  InlineAlert,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  useApiClient,
} from "@wardenx/ui";
// @wardenx/portal — §5.1 Medication list + administration log (`/p/:patientId/medications`). Reads the active
// medications (GET /portal/medications/active) and recent caregiver-attested administrations
// (GET /portal/administrations/recent). The attestation panel POSTs to /portal/administrations/caregiver-attested
// — the M13 caregiver-attested write path (M31-T06). The write is server-gated by ABAC
// `portal_caregiver_is_primary_or_dpoa`; a family (non-primary) caregiver still SEES the panel but the server
// answers 403, which we surface plainly rather than hiding the affordance and pretending it doesn't exist.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { day, humanize, readError } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage } from "./portal-page";

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
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    const [mRes, aRes] = await Promise.all([
      client.GET("/api/v1/portal/medications/active", {}),
      client.GET("/api/v1/portal/administrations/recent", {}),
    ]);
    if (mRes.error) setError(readError(mRes.response?.status));
    else setMeds((mRes.data?.items ?? []) as unknown as Medication[]);
    if (!aRes.error) setLog((aRes.data?.items ?? []) as unknown as Administration[]);
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

  async function attest(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitState(null);
    setSubmitting(true);
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
    setSubmitting(false);
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
        onRetry={() => void load()}
      >
        <PortalCard heading="Active medications">
          <table className="wx-portal-data-table">
            <thead>
              <tr>
                <th>Medication</th>
                <th>Dose</th>
                <th>Route</th>
                <th>Schedule</th>
              </tr>
            </thead>
            <tbody>
              {meds.map((m) => (
                <tr key={m.medicationOrderId}>
                  <td data-label="Medication">
                    {m.drugName} {m.isPrn ? <StatusPill tone="neutral" label="As needed" /> : null}
                  </td>
                  <td data-label="Dose">{m.dose ?? "—"}</td>
                  <td data-label="Route">{m.route ? humanize(m.route) : "—"}</td>
                  <td data-label="Schedule">{m.scheduleSummary ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PortalCard>

        <PortalCard heading="Record a dose you gave">
          <p className="wx-portal-supporting-copy">
            Only the primary caregiver or a healthcare DPOA can record an administration. If the
            button is declined, your team can help set this up.
          </p>
          <form className="wx-portal-form" onSubmit={(e) => void attest(e)}>
            <SelectField
              label="Medication"
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              required
              options={[
                { value: "", label: "Select a medication…", disabled: true },
                ...meds.map((m) => ({ value: m.medicationOrderId, label: m.drugName })),
              ]}
            />
            <div className="wx-portal-field-grid">
              <TextField
                label="Amount given"
                type="number"
                step="any"
                min="0"
                placeholder="Amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
              <TextField
                label="Unit"
                type="text"
                placeholder="Unit (e.g. mg)"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                required
              />
              <TextField
                label="Route"
                type="text"
                placeholder="Route (e.g. oral)"
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                required
              />
            </div>
            <TextAreaField
              label="Caregiver attestation"
              placeholder="Attestation — confirm what you gave and when"
              value={attestText}
              onChange={(e) => setAttestText(e.target.value)}
              required
              rows={2}
            />
            <Button type="submit" loading={submitting}>
              Record administration
            </Button>
            {submitState ? (
              <InlineAlert tone={submitState.tone === "err" ? "error" : "success"}>
                {submitState.msg}
              </InlineAlert>
            ) : null}
          </form>
        </PortalCard>

        {log.length > 0 ? (
          <PortalCard heading="Recent doses given">
            <ul className="wx-portal-content-list">
              {log.map((a, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: server payload has no stable id; a read-only, never-reordered list
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

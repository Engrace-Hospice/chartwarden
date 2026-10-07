// apps/web/src/modules/04-audit — the two per-patient privacy reports of the HIPAA work queue (GAP-012):
//   · Accounting of disclosures (§164.528 / 42 CFR §2.13): GET /api/v1/audit/patients/:patientId/accounting
//     (scope hipaa_528 — the 6-year window; generating one is itself audited server-side).
//   · Access report: GET /api/v1/audit/patients/:patientId/access — who touched the chart, break-glass flagged.
import {
  Button,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import { useState } from "react";
import type { JSX } from "react";
import { PatientLookupField } from "../../shell/entity-lookups";

interface Disclosure {
  date: string;
  recipient: string;
  purpose: string;
  description: string;
  eventId: string;
}

interface AccountingView {
  period: { from: string; to: string };
  disclosures: Disclosure[];
  note: string;
}

interface AccessEntry {
  eventId: string;
  at: string;
  actorUserId: string | null;
  actorRole: string | null;
  eventType: string;
  fields: string[];
  viaBreakGlass: boolean;
}

const date = (iso: string): string => iso.slice(0, 10);

function PatientPicker({
  patientId,
  onChange,
  onRun,
  busy,
}: {
  patientId: string;
  onChange: (id: string) => void;
  onRun: () => void;
  busy: boolean;
}): JSX.Element {
  return (
    <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
      <PatientLookupField label="Patient" value={patientId} onChange={(v) => onChange(v)} />
      <Button type="button" disabled={patientId === ""} loading={busy} onClick={onRun}>
        Run report
      </Button>
    </div>
  );
}

export function AccountingReport(): JSX.Element {
  const client = useApiClient();
  const [patientId, setPatientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<AccountingView | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/audit/patients/{patientId}/accounting", {
      params: { path: { patientId }, query: { scope: "hipaa_528" } },
    });
    setBusy(false);
    if (err || !data) {
      setReport(null);
      return setError("Could not generate the accounting of disclosures.");
    }
    setReport(data as unknown as AccountingView);
  }

  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <PatientPicker
        patientId={patientId}
        onChange={setPatientId}
        onRun={() => void run()}
        busy={busy}
      />
      {error ? <InlineAlert>{error}</InlineAlert> : null}
      {busy ? <LoadingSpinner /> : null}
      {report ? (
        <>
          <p className="wx-row-sub">
            Period {date(report.period.from)} to {date(report.period.to)}. {report.note}
          </p>
          {report.disclosures.length === 0 ? (
            <EmptyState
              title="No disclosures in this period"
              description="No accountable disclosures were recorded for this patient."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Recipient</th>
                  <th>Purpose</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {report.disclosures.map((d) => (
                  <tr key={d.eventId}>
                    <td>{date(d.date)}</td>
                    <td>{d.recipient}</td>
                    <td>{d.purpose}</td>
                    <td>{d.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </div>
  );
}

export function AccessReport(): JSX.Element {
  const client = useApiClient();
  const [patientId, setPatientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<AccessEntry[] | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/audit/patients/{patientId}/access", {
      params: { path: { patientId } },
    });
    setBusy(false);
    if (err || !data) {
      setItems(null);
      return setError("Could not load the access history.");
    }
    setItems((data as unknown as { items: AccessEntry[] }).items);
  }

  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <PatientPicker
        patientId={patientId}
        onChange={setPatientId}
        onRun={() => void run()}
        busy={busy}
      />
      {error ? <InlineAlert>{error}</InlineAlert> : null}
      {busy ? <LoadingSpinner /> : null}
      {items && items.length === 0 ? (
        <EmptyState
          title="No access events"
          description="Nobody has accessed this chart in the period."
        />
      ) : null}
      {items && items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Role</th>
              <th>Event</th>
              <th>Fields</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.eventId}>
                <td>{e.at.slice(0, 16).replace("T", " ")}</td>
                <td>{e.actorRole ?? "system"}</td>
                <td>{e.eventType}</td>
                <td>{e.fields.join(", ")}</td>
                <td>
                  {e.viaBreakGlass ? <StatusPill label="Break-glass" tone="warning" /> : "Standard"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

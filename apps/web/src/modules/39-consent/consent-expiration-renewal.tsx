import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  cardSurface,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/39-consent — M39 CONSENT EXPIRATION & RENEWAL (§5.1, Track B / ADR-0030).
// Spec: docs/design/screens/compliance/CHARTWARDEN_UI_CONSENT_EXPIRATION_RENEWAL.md — "Use Patient Workspace."
//
// The renewal window: which of the patient's consents lapse soon, banded by urgency, with the contributing
// records underneath. Reads GET /api/v1/patients/:patientId/expiring-consents (cursor-paginated, §4.12)
// through the typed client.
//
// The urgency bands are the §2.4 D9 platform reminder cadence (90 / 30 / 14 / 7 / 1 days), resolved through
// `consent-status.ts` — the screen and the reminder worker MUST agree on what "urgent" means, or staff learn
// to distrust one of them. `daysUntilExpiry` is computed SERVER-side; the browser never re-derives it from
// a clock it cannot vouch for.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useParams } from "react-router-dom";
import { expiryBand, expiryTone, humanize, readErrorMessage } from "./consent-status";

interface ExpiringRow {
  id: string;
  typeKey: string;
  status: string;
  expiresAt: string | null;
  daysUntilExpiry: number;
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

const cell: CSSProperties = {
  padding: "0.55rem 0.75rem",
  textAlign: "left",
  verticalAlign: "middle",
};
const head: CSSProperties = {
  ...cell,
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
  fontWeight: 600,
};
const row: CSSProperties = { borderTop: `1px solid ${t.surfaceContainer}` };

const BANDS = ["≤7 days", "8–30 days", "31–90 days"] as const;

export function ConsentExpirationRenewal(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [rows, setRows] = useState<ExpiringRow[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!patientId) return;
    let active = true;
    void (async () => {
      setLoading(true);
      const [eRes, pRes] = await Promise.all([
        client.GET("/api/v1/patients/{patientId}/expiring-consents", {
          params: { path: { patientId }, query: { windowDays: 90, pageSize: 100 } },
        }),
        client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
      ]);
      if (!active) return;
      if (pRes.data) setPatient(pRes.data as PatientSummary);
      if (eRes.error) setError(readErrorMessage(eRes.response?.status, "consent.read"));
      else setRows(eRes.data?.data ?? []);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId]);

  const byBand = useMemo(() => {
    const counts: Record<string, number> = { "≤7 days": 0, "8–30 days": 0, "31–90 days": 0 };
    for (const r of rows)
      counts[expiryBand(r.daysUntilExpiry)] = (counts[expiryBand(r.daysUntilExpiry)] ?? 0) + 1;
    return counts;
  }, [rows]);

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      mrn={patient.mrn}
      dob={patient.dob}
    />
  ) : null;

  return (
    <PatientWorkspaceLayout banner={banner}>
      <KpiStrip>
        {BANDS.map((b) => (
          <KpiCard key={b} label={b} value={loading ? "—" : String(byBand[b] ?? 0)} />
        ))}
        <KpiCard label="In window" value={loading ? "—" : String(rows.length)} />
      </KpiStrip>

      <section style={cardSurface}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Expiring within 90 days</h2>
        <p style={{ margin: "0.25rem 0 1rem", color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
          Soonest first. Renewal opens a NEW consent record on the D13 renewal chain — it never
          edits the expiring one — and requires step-up re-authentication.
        </p>

        {loading ? (
          <LoadingSpinner />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing expiring"
            description="No consent for this patient lapses within the next 90 days."
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={head}>Type</th>
                <th style={head}>Expires</th>
                <th style={head}>Days left</th>
                <th style={head}>Urgency</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={row}>
                  <td style={cell}>{humanize(r.typeKey)}</td>
                  <td style={cell}>{r.expiresAt ? r.expiresAt.slice(0, 10) : "—"}</td>
                  <td style={cell}>{r.daysUntilExpiry}</td>
                  <td style={cell}>
                    <StatusPill
                      tone={expiryTone(r.daysUntilExpiry)}
                      label={expiryBand(r.daysUntilExpiry)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </PatientWorkspaceLayout>
  );
}

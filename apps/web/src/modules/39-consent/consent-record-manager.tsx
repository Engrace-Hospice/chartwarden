import {
  EmptyState,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  cardSurface,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/39-consent — M39 CONSENT RECORD MANAGER (§5.1, Track B / ADR-0030).
// Spec: docs/design/screens/compliance/WARDENX_UI_CONSENT_RECORD_MANAGER.md — "Use Patient Workspace."
//
// The patient's consent record set: what is on file, what it authorises, and what state each record is in.
// Reads GET /api/v1/patients/:patientId/consents (+ the patient summary for the banner) through the typed
// client — M39's read responses are enriched, so there is no `as unknown as` cast here.
//
// WX-PR-010: the capture and lifecycle-detail write screens now exist (`consent-capture.tsx`,
// `consent-detail.tsx`) over the real WX-PR-009 Drizzle lifecycle, so this row links out to them
// instead of naming the writes as unavailable.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { CONSENT_STATUS_TONE, humanize, readErrorMessage, toneOf } from "./consent-status";

interface ConsentRow {
  id: string;
  typeKey: string;
  grantorKind: string;
  captureMethod: string;
  status: string;
  version: number;
  effectiveAt: string | null;
  expiresAt: string | null;
  signedAt: string | null;
  survivesDeath?: boolean;
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
const primaryBtn: CSSProperties = {
  alignSelf: "flex-start",
  padding: "0.45rem 0.9rem",
  borderRadius: "9999px",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};
const rowLink: CSSProperties = { color: "var(--color-on-surface)", textDecoration: "none" };

/** ISO instant → a plain date. A consent's operative dates are dates; the time is noise here. */
function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

export function ConsentRecordManager(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [rows, setRows] = useState<ConsentRow[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!patientId) return;
    let active = true;
    void (async () => {
      setLoading(true);
      const [cRes, pRes] = await Promise.all([
        client.GET("/api/v1/patients/{patientId}/consents", { params: { path: { patientId } } }),
        client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
      ]);
      if (!active) return;
      if (pRes.data) setPatient(pRes.data as PatientSummary);
      if (cRes.error) setError(readErrorMessage(cRes.response?.status, "consent.read"));
      else setRows(cRes.data?.data ?? []);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId]);

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      mrn={patient.mrn}
      dob={patient.dob}
    />
  ) : null;

  // A consent that survives death is the rare one (D13: only family-caregiver / media / research may),
  // so it is surfaced as a distinct fact rather than buried in the scope descriptor.
  const survivingCount = useMemo(() => rows.filter((r) => r.survivesDeath).length, [rows]);

  return (
    <PatientWorkspaceLayout banner={banner}>
      <section style={cardSurface}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "1rem",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Consents on file</h2>
            <p style={{ margin: "0.25rem 0 0", color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
              Active consent records for this patient.
              {survivingCount > 0
                ? ` ${survivingCount} survive${survivingCount === 1 ? "s" : ""} death (D13).`
                : ""}
            </p>
          </div>
          {patientId ? (
            <Link to={`/patients/${patientId}/consents/new`} style={primaryBtn}>
              + New consent
            </Link>
          ) : null}
        </div>

        {loading ? (
          <LoadingSpinner />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No consents on file"
            description="Nothing has been captured for this patient yet. Capture runs through the consent flow, which requires step-up re-authentication."
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}>
            <thead>
              <tr>
                <th style={head}>Type</th>
                <th style={head}>Status</th>
                <th style={head}>Granted by</th>
                <th style={head}>Captured</th>
                <th style={head}>Effective</th>
                <th style={head}>Expires</th>
                <th style={head}>Ver.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={row}>
                  <td style={cell}>
                    <Link to={`/patients/${patientId}/consents/${r.id}`} style={rowLink}>
                      {humanize(r.typeKey)}
                    </Link>
                  </td>
                  <td style={cell}>
                    <StatusPill
                      tone={toneOf(CONSENT_STATUS_TONE, r.status)}
                      label={humanize(r.status)}
                    />
                  </td>
                  <td style={cell}>{humanize(r.grantorKind)}</td>
                  <td style={cell}>{humanize(r.captureMethod)}</td>
                  <td style={cell}>{day(r.effectiveAt)}</td>
                  <td style={cell}>{day(r.expiresAt)}</td>
                  <td style={cell}>{r.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </PatientWorkspaceLayout>
  );
}

import { Glyph, InlineAlert, useApiClient } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { humanize, readError } from "./portal-format";
import { PortalLoadState, PortalPage } from "./portal-page";

interface GrantedPatient {
  patientId: string;
  grantId: string;
  grantKind: string;
  scopeSet: string[];
  layPatientLabel: string;
}

export function PortalPatientPicker(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const autoOpen =
    (location.state as { openOnlyPatient?: boolean } | null)?.openOnlyPatient === true;
  const autoAttempted = useRef(false);
  const [patients, setPatients] = useState<GrantedPatient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const selectingRef = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);

  useEffect(() => {
    void loadAttempt;
    const version = ++generation.current;
    setLoading(true);
    setError(null);
    setSelectionError(null);
    setPatients([]);
    void (async () => {
      try {
        const res = await client.GET("/api/v1/portal/sessions/patients", {});
        if (!mounted.current || version !== generation.current) return;
        if ("error" in res) setError(readError(res.response?.status));
        else setPatients((res.data?.items ?? []) as GrantedPatient[]);
      } catch {
        if (mounted.current && version === generation.current) setError(readError(undefined));
      } finally {
        if (mounted.current && version === generation.current) setLoading(false);
      }
    })();
    return () => {
      generation.current++;
    };
  }, [client, loadAttempt]);

  useEffect(() => {
    // Only the immediate post-sign-in redirect may auto-open a single authorized patient.
    // Manual visits to /patient-picker must always allow the user to stay and choose.
    if (!autoOpen || loading || error || patients.length !== 1 || autoAttempted.current) return;
    autoAttempted.current = true;
    void enter(patients[0]!.patientId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, loading, error, patients]);

  async function enter(patientId: string): Promise<void> {
    if (selectingRef.current || loading) return;
    if (!patients.some((patient) => patient.patientId === patientId)) return;
    selectingRef.current = true;
    const version = generation.current;
    setSelecting(patientId);
    setSelectionError(null);
    try {
      // The server must bind the session before any patient route is rendered.
      const res = await client.POST("/api/v1/portal/sessions/select-patient", {
        body: { patientId },
      });
      if (!mounted.current || version !== generation.current) return;
      if ("error" in res) setSelectionError(readError(res.response?.status));
      else navigate(`/p/${encodeURIComponent(patientId)}`, { replace: true });
    } catch {
      if (mounted.current && version === generation.current)
        setSelectionError("We couldn't open this care record. Please try again.");
    } finally {
      selectingRef.current = false;
      if (mounted.current && version === generation.current) setSelecting(null);
    }
  }

  return (
    <PortalPage
      title="Choose a patient"
      subtitle="Select the care record you'd like to view."
      width="standard"
      className="wx-portal-picker-page"
    >
      {selectionError ? (
        <div className="wx-portal-picker-error" role="alert">
          <InlineAlert tone="error">{selectionError}</InlineAlert>
        </div>
      ) : null}
      {loading ? (
        <output className="wx-portal-picker-skeleton" aria-label="Loading care records">
          <span />
          <span />
        </output>
      ) : (
        <PortalLoadState
          loading={false}
          error={error}
          empty={patients.length === 0}
          emptyTitle="No active patient access"
          emptyDescription="No care records are currently shared with this account."
          onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
        >
          <section aria-labelledby="available-patients-heading">
            <div className="wx-portal-picker-heading">
              <h2 id="available-patients-heading">Available care records</h2>
              <span>{patients.length}</span>
            </div>
            <div className="wx-portal-patient-list">
              {patients.map((patient, index) => (
                <button
                  key={patient.grantId}
                  type="button"
                  className="wx-portal-patient-option"
                  disabled={selecting !== null}
                  aria-describedby={`patient-access-${index}`}
                  onClick={() => void enter(patient.patientId)}
                >
                  <span className="wx-portal-patient-option__avatar" aria-hidden="true">
                    <Glyph name="user" size={20} />
                  </span>
                  <span className="wx-portal-patient-option__copy">
                    <strong>{patient.layPatientLabel || "Patient care record"}</strong>
                    <span id={`patient-access-${index}`}>
                      Access as {humanize(patient.grantKind)}
                    </span>
                  </span>
                  <span className="wx-portal-patient-option__action">
                    {selecting === patient.patientId ? "Opening…" : "Open care record"}
                    <Glyph name="arrow-right" size={16} aria-hidden="true" />
                  </span>
                </button>
              ))}
            </div>
          </section>
        </PortalLoadState>
      )}
      <div className="wx-portal-picker-footer">
        <Glyph name="shield-check" size={19} />
        <p>
          Only records shared with your account appear here.{" "}
          <Link to="/account">Account & security</Link>
        </p>
      </div>
    </PortalPage>
  );
}

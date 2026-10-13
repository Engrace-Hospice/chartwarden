import { StatusPill, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Patient selector (`/patient-picker`). A portal session is scoped to the patients its ACCOUNT is
// granted — never to the signed-in user — and works on ONE at a time (D2). This lists the account's live grants
// (GET /portal/sessions/patients: the lay label, the relationship the grant came from and how many areas of care it
// opens), and choosing one binds the session via POST /portal/sessions/select-patient before routing into the
// dashboard. A grant that is revoked or whose consent has ended simply does not appear.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
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
  const [patients, setPatients] = useState<GrantedPatient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    // Reading the counter is intentional: incrementing it is the retry trigger for this effect.
    void loadAttempt;
    let active = true;
    void (async () => {
      setLoading(true);
      setError(null);
      const res = await client.GET("/api/v1/portal/sessions/patients", {});
      if (!active) return;
      if (res.error) setError(readError(res.response?.status));
      else setPatients((res.data?.items ?? []) as GrantedPatient[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, loadAttempt]);

  async function enter(patientId: string): Promise<void> {
    setSelecting(patientId);
    const res = await client.POST("/api/v1/portal/sessions/select-patient", {
      body: { patientId },
    });
    setSelecting(null);
    if (res.error) setError(readError(res.response?.status));
    else navigate(`/p/${patientId}`);
  }

  return (
    <PortalPage
      title="Who are you here for?"
      subtitle="Choose the person whose care you'd like to see."
    >
      <PortalLoadState
        loading={loading}
        error={error}
        empty={patients.length === 0}
        emptyTitle="No active access"
        emptyDescription="Your account doesn't have access to anyone's records right now. Your hospice team can help."
        onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
      >
        <div className="wx-portal-patient-list">
          {patients.map((p) => (
            <button
              key={p.grantId}
              type="button"
              className="wx-portal-patient-option"
              disabled={selecting !== null}
              aria-describedby={`patient-access-${p.grantId}`}
              onClick={() => void enter(p.patientId)}
            >
              <span className="wx-portal-patient-option__copy">
                <strong>{p.layPatientLabel}</strong>
                <span id={`patient-access-${p.grantId}`}>
                  {`${humanize(p.grantKind)} · ${p.scopeSet.length} area${p.scopeSet.length === 1 ? "" : "s"} of access`}
                </span>
              </span>
              <StatusPill
                tone={selecting === p.patientId ? "progress" : "neutral"}
                label={selecting === p.patientId ? "Opening" : "Open"}
              />
            </button>
          ))}
        </div>
      </PortalLoadState>
    </PortalPage>
  );
}

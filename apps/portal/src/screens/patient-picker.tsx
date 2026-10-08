import { StatusPill, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Patient selector (`/patient-picker`). A portal session is scoped to the patients its ACCOUNT is
// granted — never to the signed-in user — and works on ONE at a time (D2). This lists the account's live grants
// (GET /portal/sessions/patients: the lay label, the relationship the grant came from and how many areas of care it
// opens), and choosing one binds the session via POST /portal/sessions/select-patient before routing into the
// dashboard. A grant that is revoked or whose consent has ended simply does not appear.
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
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

const item: CSSProperties = {
  width: "100%",
  textAlign: "left",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.9rem 1rem",
  borderRadius: "0.6rem",
  border: `1px solid ${t.surfaceContainer}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  cursor: "pointer",
};

export function PortalPatientPicker(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [patients, setPatients] = useState<GrantedPatient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const res = await client.GET("/api/v1/portal/sessions/patients", {});
      if (!active) return;
      if (res.error) setError(readError(res.response?.status));
      else setPatients((res.data?.items ?? []) as GrantedPatient[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

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
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {patients.map((p) => (
            <button
              key={p.grantId}
              type="button"
              style={item}
              disabled={selecting !== null}
              onClick={() => void enter(p.patientId)}
            >
              <span>
                <span style={{ fontWeight: 600 }}>{p.layPatientLabel}</span>
                <span style={{ display: "block", color: t.onSurfaceVariant, fontSize: "0.82rem" }}>
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

import { StatusPill, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Patient selector (`/patient-picker`). The current session (GET /portal/sessions/current)
// carries the account's active grant — the patient it is bound to, the relationship, and the scope set. A
// single-grant account is the common case (D2: one patient at a time), so this surface confirms who the
// caregiver is here for and binds the session context via POST /portal/sessions/select-patient before routing
// into the dashboard. Multi-grant accounts re-enter here to switch patients.
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { humanize, readError, statusTone } from "./portal-format";
import { PortalLoadState, PortalPage } from "./portal-page";

interface SessionContext {
  portalAccountId: string;
  activePatientId: string | null;
  activeGrantId: string | null;
  scopeSet: string[];
  relationship: string;
  status: string;
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
  const [ctx, setCtx] = useState<SessionContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const res = await client.GET("/api/v1/portal/sessions/current", {});
      if (!active) return;
      if (res.error) setError(readError(res.response?.status));
      else setCtx((res.data as SessionContext) ?? null);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  async function enter(patientId: string): Promise<void> {
    const res = await client.POST("/api/v1/portal/sessions/select-patient", {
      body: { patientId },
    });
    if (!res.error) navigate(`/p/${patientId}`);
  }

  const patientId = ctx?.activePatientId ?? null;
  return (
    <PortalPage
      title="Who are you here for?"
      subtitle="Confirm the person whose care you'd like to see."
    >
      <PortalLoadState
        loading={loading}
        error={error}
        empty={!patientId}
        emptyTitle="No active access"
        emptyDescription="Your account doesn't have access to anyone's records right now. Your hospice team can help."
      >
        <button type="button" style={item} onClick={() => patientId && void enter(patientId)}>
          <span>
            <span style={{ fontWeight: 600 }}>Your loved one's records</span>
            <span style={{ display: "block", color: t.onSurfaceVariant, fontSize: "0.82rem" }}>
              {ctx
                ? `${humanize(ctx.relationship)} · ${ctx.scopeSet.length} area${ctx.scopeSet.length === 1 ? "" : "s"} of access`
                : ""}
            </span>
          </span>
          {ctx ? <StatusPill tone={statusTone(ctx.status)} label={humanize(ctx.status)} /> : null}
        </button>
      </PortalLoadState>
    </PortalPage>
  );
}

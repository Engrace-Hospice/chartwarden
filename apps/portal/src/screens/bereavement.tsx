import { t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Bereavement support hub (`/p/:patientId/bereavement`). Active only when the grant is
// in bereaved mode (the M16-driven flip after a patient's death, M31-T03). M16 owns the content — the program
// enrollment (GET /portal/bereavement/program) and the resource library (GET /portal/bereavement/resources);
// M31 owns the surface and the opt-out (POST /portal/bereavement/opt-out). Restrained palette, no celebratory
// color (§5.4).
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { humanize, readError } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage } from "./portal-page";

interface Resource {
  title?: string;
  summary?: string;
  kind?: string;
  url?: string;
}
interface ProgramItem {
  label?: string;
  detail?: string;
}

const ghostBtn: CSSProperties = {
  padding: "0.5rem 0.9rem",
  borderRadius: "0.5rem",
  border: `1px solid ${t.surfaceContainer}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  cursor: "pointer",
  fontSize: "0.85rem",
};

export function PortalBereavement(): JSX.Element {
  const client = useApiClient();
  const [program, setProgram] = useState<ProgramItem[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [optedOut, setOptedOut] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const [pRes, rRes] = await Promise.all([
        client.GET("/api/v1/portal/bereavement/program", {}),
        client.GET("/api/v1/portal/bereavement/resources", {}),
      ]);
      if (!active) return;
      if (pRes.error) setError(readError(pRes.response?.status));
      else setProgram((pRes.data?.items ?? []) as unknown as ProgramItem[]);
      if (!rRes.error) setResources((rRes.data?.items ?? []) as unknown as Resource[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  async function optOut(): Promise<void> {
    const res = await client.POST("/api/v1/portal/bereavement/opt-out", {});
    if (!res.error) setOptedOut(true);
  }

  return (
    <PortalPage title="Bereavement support" subtitle="You don't have to walk this alone.">
      <PortalLoadState
        loading={loading}
        error={error}
        empty={program.length === 0 && resources.length === 0}
        emptyTitle="Support resources coming"
        emptyDescription="Your hospice's bereavement team will make resources available here."
      >
        {program.length > 0 ? (
          <PortalCard heading="Your bereavement program">
            <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.9rem" }}>
              {program.map((p, i) => (
                <li key={i}>
                  <strong>{p.label ?? "Program"}</strong>
                  {p.detail ? ` — ${p.detail}` : ""}
                </li>
              ))}
            </ul>
          </PortalCard>
        ) : null}

        {resources.length > 0 ? (
          <PortalCard heading="Resources">
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {resources.map((r, i) => (
                <div key={i}>
                  <div style={{ fontWeight: 600, fontSize: "0.92rem" }}>
                    {r.title ?? "Resource"}
                    {r.kind ? <span style={{ color: t.onSurfaceVariant, fontWeight: 400 }}> · {humanize(r.kind)}</span> : null}
                  </div>
                  {r.summary ? <p style={{ margin: "0.2rem 0 0", fontSize: "0.85rem", color: t.onSurfaceVariant }}>{r.summary}</p> : null}
                </div>
              ))}
            </div>
          </PortalCard>
        ) : null}

        <PortalCard heading="Communication preferences">
          {optedOut ? (
            <p role="status" style={{ margin: 0, fontSize: "0.88rem" }}>
              You've opted out of bereavement outreach. You can always reach back out to your hospice team.
            </p>
          ) : (
            <>
              <p style={{ margin: "0 0 0.75rem", fontSize: "0.88rem", color: t.onSurfaceVariant }}>
                If you'd prefer not to receive bereavement outreach, you can opt out at any time.
              </p>
              <button type="button" style={ghostBtn} onClick={() => void optOut()}>
                Opt out of bereavement outreach
              </button>
            </>
          )}
        </PortalCard>
      </PortalLoadState>
    </PortalPage>
  );
}

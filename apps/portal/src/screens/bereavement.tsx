import { Button, InlineAlert, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Bereavement support hub (`/p/:patientId/bereavement`). Active only when the grant is
// in bereaved mode (the M16-driven flip after a patient's death, M31-T03). M16 owns the content — the program
// enrollment (GET /portal/bereavement/program) and the resource library (GET /portal/bereavement/resources);
// M31 owns the surface and the opt-out (POST /portal/bereavement/opt-out). Restrained palette, no celebratory
// color (§5.4).
import { useEffect, useState } from "react";
import type { JSX } from "react";
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

export function PortalBereavement(): JSX.Element {
  const client = useApiClient();
  const [program, setProgram] = useState<ProgramItem[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [optedOut, setOptedOut] = useState(false);
  const [optingOut, setOptingOut] = useState(false);
  const [optOutError, setOptOutError] = useState<string | null>(null);

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
    setOptingOut(true);
    setOptOutError(null);
    const res = await client.POST("/api/v1/portal/bereavement/opt-out", {});
    setOptingOut(false);
    if (res.error) setOptOutError(readError(res.response?.status));
    else setOptedOut(true);
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
            <ul className="wx-portal-content-list">
              {program.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: server payload has no stable id; a read-only, never-reordered list
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
            <div className="wx-portal-resource-list">
              {resources.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: server payload has no stable id; a read-only, never-reordered list
                <div key={i}>
                  <div className="wx-portal-resource-list__title">
                    {r.title ?? "Resource"}
                    {r.kind ? <span> · {humanize(r.kind)}</span> : null}
                  </div>
                  {r.summary ? <p>{r.summary}</p> : null}
                </div>
              ))}
            </div>
          </PortalCard>
        ) : null}

        <PortalCard heading="Communication preferences">
          {optedOut ? (
            <output className="wx-portal-body-copy">
              You've opted out of bereavement outreach. You can always reach back out to your
              hospice team.
            </output>
          ) : (
            <>
              <p className="wx-portal-supporting-copy">
                If you'd prefer not to receive bereavement outreach, you can opt out at any time.
              </p>
              <Button tone="secondary" loading={optingOut} onClick={() => void optOut()}>
                Opt out of bereavement outreach
              </Button>
              {optOutError ? <InlineAlert tone="error">{optOutError}</InlineAlert> : null}
            </>
          )}
        </PortalCard>
      </PortalLoadState>
    </PortalPage>
  );
}

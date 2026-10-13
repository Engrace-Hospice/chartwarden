import { StatusPill, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Care plan view (`/p/:patientId/care-plan`). Reads M7 via the backend
// PortalCarePlanReader seam as a PHI-minimised lay summary (GET /portal/care-plan/summary): problems with
// their goals + focus areas in plain language, coordinator notes stripped server-side. Read-only. If the
// server redacted anything (SUD / family-violence filtering), it flags `redacted` — we tell the caregiver
// that some content is hidden rather than silently omitting it.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { readError } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage } from "./portal-page";

interface CareProblem {
  problemId: string;
  label: string;
  goals: string[];
  focus: string[];
}

export function PortalCarePlanView(): JSX.Element {
  const client = useApiClient();
  const [problems, setProblems] = useState<CareProblem[]>([]);
  const [redacted, setRedacted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const res = await client.GET("/api/v1/portal/care-plan/summary", {});
      if (!active) return;
      if (res.error) setError(readError(res.response?.status));
      else {
        const data = res.data as { problems?: CareProblem[]; redacted?: boolean } | undefined;
        setProblems((data?.problems ?? []) as CareProblem[]);
        setRedacted(Boolean(data?.redacted));
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <PortalPage
      title="Care plan"
      subtitle="What your care team is working on, in plain language."
      actions={redacted ? <StatusPill tone="neutral" label="Some content hidden" /> : undefined}
    >
      <PortalLoadState
        loading={loading}
        error={error}
        empty={problems.length === 0}
        emptyTitle="No care-plan items yet"
        emptyDescription="Once your team sets goals, they'll appear here."
      >
        <div className="wx-portal-card-stack">
          {problems.map((p) => (
            <PortalCard key={p.problemId} heading={p.label}>
              {p.goals.length > 0 ? (
                <>
                  <h3 className="wx-portal-section-label">Goals</h3>
                  <ul className="wx-portal-content-list">
                    {p.goals.map((g, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: goals are plain strings with no id; a read-only, never-reordered list
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {p.focus.length > 0 ? (
                <p className="wx-portal-supporting-copy">Focus: {p.focus.join(", ")}</p>
              ) : null}
            </PortalCard>
          ))}
        </div>
      </PortalLoadState>
    </PortalPage>
  );
}

// apps/web/src/modules/10-hope — compact "iQIES submission" row on a signed assessment: which batch holds
// it (status badge -> batch page) or "Not yet packaged" (-> worklist, where the package is generated).
// A failed lookup renders nothing: this is a convenience link, never a reason to break the record.
import { StatusPill, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { SUBMISSION_TONE, stateLabel } from "./hope-status";

interface BatchRef {
  submissionId: string;
  status: string;
}

export function IqiesSubmissionPanel({
  assessmentId,
}: { assessmentId: string }): JSX.Element | null {
  const client = useApiClient();
  // undefined = loading or failed (render nothing); null = no batch yet.
  const [latest, setLatest] = useState<BatchRef | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setLatest(undefined);
    void (async () => {
      try {
        const { data, error } = await client.GET("/api/v1/hope/assessments/{id}/submissions", {
          params: { path: { id: assessmentId } },
        });
        if (!active || error || !data) return;
        // Newest first (server contract).
        setLatest(data.submissions[0] ?? null);
      } catch {
        // degrade quietly
      }
    })();
    return () => {
      active = false;
    };
  }, [client, assessmentId]);

  if (latest === undefined) return null;
  return (
    <div
      // biome-ignore lint/a11y/useSemanticElements: a <fieldset> is for form controls; this names an info row.
      role="group"
      aria-label="iQIES submission"
      style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem" }}
    >
      <span style={{ color: "var(--color-on-surface-variant)" }}>iQIES submission</span>
      {latest ? (
        <>
          <StatusPill
            label={stateLabel(latest.status)}
            tone={SUBMISSION_TONE[latest.status] ?? "neutral"}
          />
          <Link to={`/hope/submissions/${encodeURIComponent(latest.submissionId)}`}>
            View batch
          </Link>
        </>
      ) : (
        <>
          <span>Not yet packaged</span>
          <Link to="/hope/submissions">Open submissions</Link>
        </>
      )}
    </div>
  );
}

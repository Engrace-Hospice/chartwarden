import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/13-emar — comfort kit view (M13 §4.1/§6.1 #7, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Detail" (comfort-kit drawdown). Read-only
// detail of a deployed comfort kit: the deployment, the admission it serves, and the disposal/return status. The
// drawdown projection (remaining quantity × replenishment threshold × last-administered) and the
// acknowledge-return write action fill in as their write surfaces harden; the SERVER owns the §2.7 D5 drawdown
// math and the replenishment trigger (ADR-0030). Reads GET /api/v1/comfort-kits/deployments/:id via the typed
// client. Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { DISPOSAL_TONE, stateLabel } from "./emar-status";

interface DeploymentView {
  id: string;
  patientId: string;
  admissionId: string;
  disposalStatus: string;
}

export function ComfortKitView(): JSX.Element {
  const client = useApiClient();
  const { deploymentId } = useParams<{ deploymentId: string }>();
  const [row, setRow] = useState<DeploymentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!deploymentId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/comfort-kits/deployments/{id}", {
        params: { path: { id: deploymentId } },
      });
      if (!active) return;
      if (err) {
        setError("Could not load the comfort kit.");
        setLoading(false);
        return;
      }
      setRow(data as DeploymentView);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, deploymentId]);

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Comfort Kit"
          actions={
            row ? (
              <StatusPill
                label={stateLabel(row.disposalStatus)}
                tone={DISPOSAL_TONE[row.disposalStatus] ?? "neutral"}
              />
            ) : undefined
          }
        />
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "12rem 1fr",
            gap: "0.4rem 1rem",
            fontSize: "0.85rem",
          }}
        >
          <dt style={dt}>Deployment</dt>
          <dd style={dd} className="wx-data-md">
            {row.id}
          </dd>
          <dt style={dt}>Admission</dt>
          <dd style={dd} className="wx-data-md">
            {row.admissionId}
          </dd>
          <dt style={dt}>Disposal status</dt>
          <dd style={dd}>
            <StatusPill
              label={stateLabel(row.disposalStatus)}
              tone={DISPOSAL_TONE[row.disposalStatus] ?? "neutral"}
            />
          </dd>
        </dl>
      )}
    </DetailPageLayout>
  );
}

const dt = { fontWeight: 600, color: "var(--color-on-surface)" } as const;
const dd = { margin: 0 } as const;

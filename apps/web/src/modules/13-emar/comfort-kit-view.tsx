import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  TextAreaField,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/13-emar — comfort kit view (M13 §4.1/§6.1 #7, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_MEDICATIONS_EMAR.md — "Use Detail" (comfort-kit drawdown). Read-only
// detail of a deployed comfort kit: the deployment, the admission it serves, and the disposal/return status. The
// drawdown projection (remaining quantity × replenishment threshold × last-administered) still awaits the
// DTO that carries it — the deployment read exposes only id/patient/admission/disposal status, so there is
// nothing here to render it from and nothing is invented. F-031 — the acknowledge-return action is live:
// `POST /api/v1/comfort-kits/deployments/{id}/acknowledge-return`, the §2.7 Phase-1 manual fallback used when
// M21 has not reconciled the kit itself. It is offered only while the kit is unreconciled, because an
// already-returned kit has nothing left to acknowledge. The SERVER owns the §2.7 D5 drawdown math and the
// replenishment trigger (ADR-0030). Reads GET /api/v1/comfort-kits/deployments/:id via the typed client.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { type DeploymentView, acknowledgeReturn, errorMessage, getDeployment } from "./emar-api";
import { DISPOSAL_TONE, stateLabel } from "./emar-status";

export function ComfortKitView(): JSX.Element {
  const client = useApiClient();
  const { deploymentId } = useParams<{ deploymentId: string }>();
  const [row, setRow] = useState<DeploymentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!deploymentId) return;
    setLoading(true);
    setError(null);
    const { deployment, error: err } = await getDeployment(client, deploymentId);
    if (err) {
      setError("Could not load the comfort kit.");
      setLoading(false);
      return;
    }
    setRow(deployment);
    setLoading(false);
  }, [client, deploymentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const acknowledge = useCallback(async () => {
    if (!deploymentId) return;
    setBusy(true);
    setActionError(null);
    const { error: err } = await acknowledgeReturn(client, deploymentId, {
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (err) {
      setActionError(errorMessage(err, "The return could not be acknowledged."));
      return;
    }
    setNote("");
    void load();
  }, [client, deploymentId, note, load]);

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

      {row && row.disposalStatus !== "returned" && row.disposalStatus !== "disposed_unreturned" ? (
        <section style={{ marginTop: "1.5rem", maxWidth: "32rem" }}>
          <h2 style={sectionTitle}>Acknowledge return</h2>
          <p style={meta}>
            The Phase-1 fallback for a kit returned outside M21&rsquo;s own reconciliation. The
            server records who acknowledged it; the controlled-substance count itself is
            M21&rsquo;s.
          </p>
          <TextAreaField
            label="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {actionError ? (
            <p role="alert" style={{ ...meta, color: "var(--color-error)" }}>
              {actionError}
            </p>
          ) : null}
          <Button tone="primary" loading={busy} onClick={() => void acknowledge()}>
            Acknowledge return
          </Button>
        </section>
      ) : null}
    </DetailPageLayout>
  );
}

const dt = { fontWeight: 600, color: "var(--color-on-surface)" } as const;
const dd = { margin: 0 } as const;
const sectionTitle = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  color: "var(--color-muted)",
  margin: "0 0 0.5rem",
} as const;
const meta = {
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
  margin: "0 0 0.75rem",
} as const;

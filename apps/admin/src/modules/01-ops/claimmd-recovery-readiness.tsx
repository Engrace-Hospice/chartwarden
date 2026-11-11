import { Button, InlineAlert, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

type Stage = "capture" | "ownership_resolution" | "m25_delivery";
type Assessment = {
  inboxId: string;
  stage: Stage;
  currentState: string;
  currentVersion: number;
  sourceDigestPresent: boolean;
  tenantAttribution: "verified" | "unattributed";
  leaseActive: boolean;
  priorRecoveryAttempts: number;
  disposition: "eligible_for_simulation" | "already_processed" | "blocked";
  blockers: string[];
  simulation: {
    available: boolean;
    mutatesSource: false;
    callsVendor: false;
    authorizesExecution: false;
  };
  assessedAt: string;
};

export function ClaimMdRecoveryReadiness(): JSX.Element {
  const client = useApiClient();
  const recoveryClient = client as unknown as {
    GET(path: string, options: unknown): Promise<{ data?: unknown; error?: unknown }>;
    POST(path: string, options: unknown): Promise<{ data?: unknown; error?: unknown }>;
  };
  const [health, setHealth] = useState<{ usage: "test" | "production" }>();
  const [inboxId, setInboxId] = useState("");
  const [stage, setStage] = useState<Stage>("capture");
  const [assessment, setAssessment] = useState<Assessment>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const loadHealth = useCallback(async () => {
    setError(undefined);
    const result = await client.GET("/api/v1/ops/claimmd/observability");
    if (result.error || !result.data) setError("Central Claim.MD health is unavailable.");
    else setHealth(result.data as { usage: "test" | "production" });
  }, [client]);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  const assess = async (dryRun: boolean) => {
    setLoading(true);
    setError(undefined);
    if (!health) return;
    const params = { path: { inboxId }, query: { usage: health.usage, stage } };
    let data: unknown;
    let failed = false;
    if (dryRun) {
      const result = await recoveryClient.POST(
        "/api/v1/ops/claimmd/eras/{inboxId}/recovery-dry-run",
        {
          params,
        },
      );
      data = result.data;
      failed = Boolean(result.error || !result.data);
    } else {
      const result = await recoveryClient.GET(
        "/api/v1/ops/claimmd/eras/{inboxId}/recovery-preflight",
        { params },
      );
      data = result.data;
      failed = Boolean(result.error || !result.data);
    }
    if (failed) setError("The recovery assessment could not be completed for this exact source.");
    else setAssessment(data as Assessment);
    setLoading(false);
  };

  return (
    <main className="wx-page-stack">
      <header className="wx-page-head">
        <div>
          <h1>Claim.MD recovery readiness</h1>
          <p>
            Inspect durable central evidence and simulate eligibility without replaying or posting.
          </p>
        </div>
        <Button tone="secondary" onClick={() => void loadHealth()}>
          Refresh health
        </Button>
      </header>

      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {!health && !error ? <LoadingSpinner label="Loading central Claim.MD health…" /> : null}
      {health ? (
        <section className="wx-card" aria-label="Central Claim.MD health">
          <h2>Durable source health</h2>
          <p>
            Central aggregate evidence is available. Cursor values, account credentials, and source
            payloads are intentionally hidden.
          </p>
        </section>
      ) : null}

      <section className="wx-card" aria-labelledby="recovery-assessment-title">
        <h2 id="recovery-assessment-title">Assess one source</h2>
        <p>A dry-run is a point-in-time assessment. It never authorizes later execution.</p>
        <div className="wx-filter-row">
          <label>
            ERA inbox ID
            <input
              value={inboxId}
              onChange={(event) => setInboxId(event.target.value)}
              placeholder="00000000-0000-4000-8000-000000000000"
            />
          </label>
          <label>
            Processing stage
            <select value={stage} onChange={(event) => setStage(event.target.value as Stage)}>
              <option value="capture">Capture</option>
              <option value="ownership_resolution">Ownership resolution</option>
              <option value="m25_delivery">M25 delivery</option>
            </select>
          </label>
          <Button disabled={loading || !inboxId} onClick={() => void assess(false)}>
            Run preflight
          </Button>
          <Button tone="secondary" disabled={loading || !inboxId} onClick={() => void assess(true)}>
            Run nonmutating dry-run
          </Button>
        </div>
        {loading ? <LoadingSpinner label="Assessing durable evidence…" /> : null}
      </section>

      {assessment ? (
        <section className="wx-card" aria-live="polite">
          <div className="wx-section-head">
            <h2>Assessment result</h2>
            <StatusPill
              label={assessment.disposition.replaceAll("_", " ")}
              tone={assessment.disposition === "eligible_for_simulation" ? "success" : "warning"}
            />
          </div>
          <dl className="wx-data-grid">
            <div>
              <dt>Stage</dt>
              <dd>{assessment.stage}</dd>
            </div>
            <div>
              <dt>Current state</dt>
              <dd>{assessment.currentState}</dd>
            </div>
            <div>
              <dt>Tenant attribution</dt>
              <dd>{assessment.tenantAttribution}</dd>
            </div>
            <div>
              <dt>Active lease</dt>
              <dd>{assessment.leaseActive ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Prior attempts</dt>
              <dd>{assessment.priorRecoveryAttempts}</dd>
            </div>
            <div>
              <dt>Assessed</dt>
              <dd>{new Date(assessment.assessedAt).toLocaleString()}</dd>
            </div>
          </dl>
          {assessment.blockers.length ? (
            <InlineAlert tone="warning">
              Blockers: {assessment.blockers.map((item) => item.replaceAll("_", " ")).join(", ")}
            </InlineAlert>
          ) : null}
          <InlineAlert tone="info">
            No source, cursor, attribution, vendor, or financial mutation was performed. This result
            cannot be used as execution authorization.
          </InlineAlert>
        </section>
      ) : null}
    </main>
  );
}

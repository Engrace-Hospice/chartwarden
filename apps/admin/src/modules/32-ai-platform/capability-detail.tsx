import {
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/32-ai-platform — §5.1.2 capability detail
// (`/admin/ai-platform/capabilities/:capabilityId`, `ai.capability.read`). Six tabs: Overview,
// Lifecycle, Calibration, Prompts, Invocations, Drift.
//
// THE FSM'S NEXT STATES COME FROM THE SERVER. The detail response carries `permittedNextStates`, so the
// transition dialog offers exactly what §2.2 allows from the current state — the console never keeps its
// own copy of the edge table to drift out of sync with the one the route enforces.
//
// EVIDENCE IS NOT VALIDATED HERE. §5.1.2's "required-evidence checklist per the 8-state FSM" (a design
// doc URL for DESIGN_REVIEW, golden-set replay metrics for PILOT, and so on) is enforced by the route:
// the service decides WHICH edges require a `linkedEvaluationRunId` and refuses without one. The dialog
// therefore surfaces the fields and lets the server be the authority — a client-side checklist that
// disagreed with it would either block a legal transition or promise an illegal one.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { InvocationSearch } from "./invocations";
import { EDGE_APPROVAL_KIND, lifecycleTone, riskTierTone } from "./status";
import {
  Field,
  Kv,
  OutcomeBanner,
  StandingNotice,
  actionButtonStyle,
  bodyRow,
  cap,
  cardStyle,
  cell,
  formatDate,
  inputStyle,
  pageStyle,
  tableStyle,
  theadRow,
} from "./ui";

type Detail =
  operations["getApiV1AiCapabilitiesByCapabilityId"]["responses"][200]["content"]["application/json"];
type ActivePrompt =
  operations["getApiV1AiPromptsByCapabilityKeyActive"]["responses"][200]["content"]["application/json"];

const TABS = ["Overview", "Lifecycle", "Calibration", "Prompts", "Invocations", "Drift"] as const;
type Tab = (typeof TABS)[number];

const ACTOR_ROLES = [
  "ai_safety_owner",
  "clinical_reviewer",
  "ai_engineer",
  "privacy_officer",
] as const;

export function CapabilityDetail(): JSX.Element {
  const { capabilityId = "" } = useParams<{ capabilityId: string }>();
  const client = useApiClient();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [transitioning, setTransitioning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/ai/capabilities/{capabilityId}", {
      params: { path: { capabilityId } },
    });
    if (res.error) {
      setError("Capability unavailable.");
      setLoading(false);
      return;
    }
    setDetail(res.data);
    setLoading(false);
  }, [client, capabilityId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !detail) return <LoadingSpinner />;
  if (error || !detail)
    return <EmptyState title={error ?? "Not found"} description="Retry shortly." />;

  const c = detail.capability;
  const posture = detail.posture as { kind: string; reason?: string };

  return (
    <div style={pageStyle}>
      <PageHeader
        title={c.displayName}
        breadcrumb="AI Platform / Capabilities"
        actions={
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <StatusPill
              label={cap(c.lifecycleState.toLowerCase())}
              tone={lifecycleTone(c.lifecycleState)}
            />
            <StatusPill label={`${cap(c.riskTier)} risk`} tone={riskTierTone(c.riskTier)} />
            <button
              type="button"
              onClick={() => setTransitioning(true)}
              disabled={detail.permittedNextStates.length === 0}
              style={actionButtonStyle(true, detail.permittedNextStates.length === 0)}
            >
              Transition
            </button>
          </div>
        }
      />
      {outcome ? <OutcomeBanner ok={outcome.ok} message={outcome.message} /> : null}

      {/* Posture is the operational answer to "would a call to this capability actually be served right
          now" — and it is NOT implied by the lifecycle state: an APPROVED capability with an active kill
          switch or an unhealthy backend is unavailable. Shown at the top of every tab. */}
      {posture.kind === "unavailable" ? (
        <StandingNotice tone="error">
          Not currently serving — {cap(posture.reason ?? "unknown")}.
        </StandingNotice>
      ) : (
        <StandingNotice tone="success">Serving — {cap(posture.kind)}.</StandingNotice>
      )}

      <nav
        style={{
          display: "flex",
          gap: "0.4rem",
          borderBottom: "1px solid var(--color-outline-variant)",
        }}
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            aria-current={tab === name ? "page" : undefined}
            style={{
              ...actionButtonStyle(false),
              border: "none",
              borderBottom:
                tab === name ? "2px solid var(--color-primary)" : "2px solid transparent",
              borderRadius: 0,
              color: tab === name ? "var(--color-primary)" : "var(--color-on-surface-variant)",
            }}
          >
            {name}
          </button>
        ))}
      </nav>

      {tab === "Overview" ? <OverviewTab detail={detail} /> : null}
      {tab === "Lifecycle" ? <LifecycleTab detail={detail} /> : null}
      {tab === "Calibration" ? <CalibrationTab detail={detail} /> : null}
      {tab === "Prompts" ? <PromptsTab capabilityKey={c.capabilityKey} /> : null}
      {tab === "Invocations" ? <InvocationSearch capabilityId={c.id} embedded /> : null}
      {tab === "Drift" ? (
        <StandingNotice tone="warning">
          Per-capability drift series are not served by the API — the drift feed is run-shaped, not
          a time series. See the <Link to="/admin/ai-platform/drift">platform drift overview</Link>{" "}
          for this capability's most recent drift-response run.
        </StandingNotice>
      ) : null}

      {transitioning ? (
        <TransitionDialog
          detail={detail}
          onClose={() => setTransitioning(false)}
          onDone={(message, ok) => {
            setTransitioning(false);
            setOutcome({ ok, message });
            if (ok) void load();
          }}
        />
      ) : null}
    </div>
  );
}

function OverviewTab({ detail }: { detail: Detail }): JSX.Element {
  const c = detail.capability;
  return (
    <section
      style={{ ...cardStyle, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.9rem" }}
    >
      <Kv label="Capability key">
        <code>{c.capabilityKey}</code>
      </Kv>
      <Kv label="Default backend">
        <code>{c.defaultBackendKey}</code>
      </Kv>
      <Kv label="Allowed backends">
        {c.allowedBackendKeys.map((b) => (
          <code key={b} style={{ marginRight: "0.4rem" }}>
            {b}
          </code>
        ))}
      </Kv>
      <Kv label="Active prompt template">
        {c.currentPromptTemplateKey ? <code>{c.currentPromptTemplateKey}</code> : "None"}
      </Kv>
      <Kv label="Tenant opt-in required">{c.tenantOptInRequired ? "Yes" : "No"}</Kv>
      <Kv label="Clinician opt-out supported">{c.clinicianOptOutSupported ? "Yes" : "No"}</Kv>
      <Kv label="First approved">{formatDate(c.firstApprovedAt)}</Kv>
      <Kv label="Last re-approved">{formatDate(c.lastReapprovedAt)}</Kv>
      <Kv label="Re-approval due">{formatDate(c.nextReapprovalDueAt)}</Kv>
    </section>
  );
}

function LifecycleTab({ detail }: { detail: Detail }): JSX.Element {
  const events = [...detail.lifecycleEvents].sort((a, b) =>
    a.transitionedAt < b.transitionedAt ? 1 : -1,
  );
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
        Permitted next states:{" "}
        {detail.permittedNextStates.length === 0
          ? "none — this capability is at a terminal state"
          : detail.permittedNextStates.map((s) => cap(s.toLowerCase())).join(", ")}
      </p>
      {events.length === 0 ? (
        <EmptyState title="No transitions" description="This capability has not moved yet." />
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={theadRow}>
              <th style={cell}>When</th>
              <th style={cell}>From → To</th>
              <th style={cell}>Stage</th>
              <th style={cell}>Signer role</th>
              <th style={cell}>Rationale</th>
              <th style={cell}>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} style={bodyRow}>
                <td style={cell} className="tabular-nums">
                  {formatDate(e.transitionedAt)}
                </td>
                <td style={cell}>
                  {e.fromState ? cap(e.fromState.toLowerCase()) : "—"} →{" "}
                  <StatusPill
                    label={cap(e.toState.toLowerCase())}
                    tone={lifecycleTone(e.toState)}
                  />
                </td>
                <td style={cell}>{cap(e.approvalKind)}</td>
                <td style={cell}>{cap(e.actorRole)}</td>
                <td style={{ ...cell, maxWidth: "24rem" }}>{e.rationaleText}</td>
                <td style={cell}>
                  {e.linkedEvaluationRunId ? <code>{e.linkedEvaluationRunId}</code> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CalibrationTab({ detail }: { detail: Detail }): JSX.Element {
  const current = detail.calibrations.find((c) => c.isCurrent) ?? null;
  const history = [...detail.calibrations].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
      {current === null ? (
        // Worth stating rather than showing an empty card: an APPROVED capability with no calibration is
        // a governance gap (§2.5), not a cosmetic one.
        <StandingNotice tone="warning">
          No current calibration is published for this capability.
        </StandingNotice>
      ) : (
        <div style={cardStyle}>
          <h2 style={{ fontSize: "0.95rem", fontWeight: 600 }}>Current calibration</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.7rem" }}>
            <Kv label="Backend">
              <code>{current.backendKey}</code>
            </Kv>
            <Kv label="Baseline set">{formatDate(current.baselineSetAt)}</Kv>
            <Kv label="Thresholds">
              <code style={{ fontSize: "0.75rem" }}>{JSON.stringify(current.thresholds)}</code>
            </Kv>
            <Kv label="Baseline metrics">
              <code style={{ fontSize: "0.75rem" }}>{JSON.stringify(current.baselineMetrics)}</code>
            </Kv>
          </div>
        </div>
      )}
      {history.length === 0 ? null : (
        <table style={tableStyle}>
          <thead>
            <tr style={theadRow}>
              <th style={cell}>Published</th>
              <th style={cell}>Backend</th>
              <th style={cell}>Current</th>
              <th style={cell}>Superseded</th>
              <th style={cell}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id} style={bodyRow}>
                <td style={cell} className="tabular-nums">
                  {formatDate(h.createdAt)}
                </td>
                <td style={cell}>
                  <code>{h.backendKey}</code>
                </td>
                <td style={cell}>{h.isCurrent ? "Yes" : "—"}</td>
                <td style={cell} className="tabular-nums">
                  {formatDate(h.supersededAt)}
                </td>
                <td style={cell}>{h.supersededReason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * §5.1.2 tab 4. The ACTIVE prompt only: there is no route that lists a capability's prompt versions, so
 * the "version history + diff vs current" the spec sketches cannot be populated. Registering a new
 * version (R30) is a git-artifact registration — eleven required fields including a content hash — which
 * belongs to the release pipeline, not to a console form a human retypes a SHA into.
 */
function PromptsTab({ capabilityKey }: { capabilityKey: string }): JSX.Element {
  const client = useApiClient();
  const [prompt, setPrompt] = useState<ActivePrompt | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await client.GET("/api/v1/ai/prompts/{capabilityKey}/active", {
        params: { path: { capabilityKey } },
      });
      if (cancelled) return;
      if (res.error) setMissing(true);
      else setPrompt(res.data);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, capabilityKey]);

  if (loading) return <LoadingSpinner />;
  if (missing || !prompt)
    return (
      <EmptyState
        title="No active prompt template"
        description="This capability serves no prompt yet — expected below APPROVED."
      />
    );

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
      <div style={{ ...cardStyle, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.7rem" }}>
        <Kv label="Template key">
          <code>{prompt.templateKey}</code>
        </Kv>
        <Kv label="Version">v{prompt.version}</Kv>
        <Kv label="Content hash">
          <code style={{ fontSize: "0.75rem" }}>{prompt.contentHash}</code>
        </Kv>
        <Kv label="Approved">{formatDate(prompt.approvedAt)}</Kv>
        <Kv label="Git artifact">
          <code style={{ fontSize: "0.75rem" }}>{prompt.gitArtifactPath}</code>
        </Kv>
        <Kv label="Compatible backends">
          {prompt.compatibleBackendKeys.map((b) => (
            <code key={b} style={{ marginRight: "0.4rem" }}>
              {b}
            </code>
          ))}
        </Kv>
        <Kv label="Input schema">
          <code style={{ fontSize: "0.75rem" }}>{prompt.inputSchemaRef}</code>
        </Kv>
        <Kv label="Output schema">
          <code style={{ fontSize: "0.75rem" }}>{prompt.outputSchemaRef}</code>
        </Kv>
        <Kv label="Clinical reviewer attestation">
          {prompt.clinicalReviewerAttestation ?? "None recorded"}
        </Kv>
      </div>
      <StandingNotice tone="warning">
        Version history and activation are not exposed here: no route lists a capability's prompt
        versions, and registering one (R30) is a release-pipeline step carrying the artifact's
        content hash — not a console form.
      </StandingNotice>
    </section>
  );
}

/** R4 — walk a §2.2 edge. Next states come from the server's `permittedNextStates`. */
function TransitionDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: Detail;
  onClose: () => void;
  onDone: (message: string, ok: boolean) => void;
}): JSX.Element {
  const client = useApiClient();
  const [toState, setToState] = useState(detail.permittedNextStates[0] ?? "");
  const [actorRole, setActorRole] = useState<string>("ai_safety_owner");
  const [rationale, setRationale] = useState("");
  const [runId, setRunId] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    const res = await client.POST("/api/v1/ai/capabilities/{capabilityId}/transitions", {
      params: { path: { capabilityId: detail.capability.id } },
      body: {
        toState: toState as never,
        // The stage a ledger entry records is determined by the EDGE, so it is derived from the target
        // state rather than asked for — an operator picking a mismatched pair is a data-quality bug the
        // route would have to reject anyway.
        approvalKind: (EDGE_APPROVAL_KIND[toState] ?? "reapproval") as never,
        actorRole: actorRole as never,
        rationaleText: rationale,
        linkedEvaluationRunId: runId.trim() === "" ? null : runId.trim(),
      },
    });
    setBusy(false);
    onDone(
      res.error
        ? "Transition refused — the edge may require evidence this request did not carry."
        : `Moved to ${cap(toState.toLowerCase())}.`,
      !res.error,
    );
  }

  return (
    <Modal
      open
      ariaLabel="Transition capability"
      role="alertdialog"
      onClose={onClose}
      width="34rem"
    >
      <div style={{ ...cardStyle, border: "none" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>
          Transition {detail.capability.capabilityKey}
        </h2>
        <Field label="To state" htmlFor="tx-state">
          <select
            id="tx-state"
            value={toState}
            onChange={(e) => setToState(e.target.value)}
            style={inputStyle}
          >
            {detail.permittedNextStates.map((s) => (
              <option key={s} value={s}>
                {cap(s.toLowerCase())}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Signing as" htmlFor="tx-role">
          <select
            id="tx-role"
            value={actorRole}
            onChange={(e) => setActorRole(e.target.value)}
            style={inputStyle}
          >
            {ACTOR_ROLES.map((r) => (
              <option key={r} value={r}>
                {cap(r)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Evidence — evaluation run id" htmlFor="tx-run">
          <input
            id="tx-run"
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
            style={inputStyle}
            placeholder="Required by some edges; the route decides which"
          />
        </Field>
        <Field label="Rationale" htmlFor="tx-rationale">
          <textarea
            id="tx-rationale"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={4}
            style={inputStyle}
            placeholder="Why this capability may move to that state."
          />
        </Field>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !toState || rationale.trim().length === 0}
            style={actionButtonStyle(true, busy || !toState || rationale.trim().length === 0)}
          >
            {busy ? "Recording…" : "Record transition"}
          </button>
          <button type="button" onClick={onClose} style={actionButtonStyle(false)}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

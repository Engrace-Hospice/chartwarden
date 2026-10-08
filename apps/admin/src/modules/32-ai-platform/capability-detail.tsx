import {
  Button,
  Modal,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  useApiClient,
  useRequestGuard,
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
  EmptyListState,
  ErrorState,
  LoadingState,
  OutcomeBanner,
  PageHead,
  SectionTitle,
  StandingNotice,
  cap,
  formatDate,
} from "./ui";

type Detail =
  operations["getApiV1AiCapabilitiesByCapabilityId"]["responses"][200]["content"]["application/json"];
type ActivePrompt =
  operations["getApiV1AiPromptsByCapabilityKeyActive"]["responses"][200]["content"]["application/json"];

const TABS = ["Overview", "Lifecycle", "Calibration", "Prompts", "Invocations", "Drift"] as const;
type Tab = (typeof TABS)[number];

const TAB_PANEL_ID = "cap-tabpanel";
const tabId = (name: Tab): string => `cap-tab-${name}`;

/** Arrow keys / Home / End move between tabs (WAI-ARIA tabs pattern, automatic activation); anything else is not ours. */
function nextTab(current: Tab, key: string): Tab | null {
  const i = TABS.indexOf(current);
  if (key === "ArrowRight") return TABS[(i + 1) % TABS.length] ?? null;
  if (key === "ArrowLeft") return TABS[(i - 1 + TABS.length) % TABS.length] ?? null;
  if (key === "Home") return TABS[0] ?? null;
  if (key === "End") return TABS[TABS.length - 1] ?? null;
  return null;
}

const ACTOR_ROLES = [
  "ai_safety_owner",
  "clinical_reviewer",
  "ai_engineer",
  "privacy_officer",
] as const;

/** Keyed by id: going from one capability to another remounts, so the previous capability, tab and outcome never linger. */
export function CapabilityDetail(): JSX.Element {
  const { capabilityId = "" } = useParams<{ capabilityId: string }>();
  return <CapabilityDetailBody key={capabilityId} capabilityId={capabilityId} />;
}

function CapabilityDetailBody({ capabilityId }: { capabilityId: string }): JSX.Element {
  const client = useApiClient();
  const guard = useRequestGuard();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [transitioning, setTransitioning] = useState(false);

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/ai/capabilities/{capabilityId}", {
      params: { path: { capabilityId } },
    });
    if (!isCurrent()) return;
    if (res.error) {
      setError("Capability unavailable.");
      setLoading(false);
      return;
    }
    setDetail(res.data);
    setLoading(false);
  }, [client, capabilityId, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  if ((loading && !detail) || error || !detail) {
    return (
      <div className="wx-list-drawer">
        <div className="wx-list-drawer-main">
          <PageHead
            title="AI capability"
            description="Lifecycle, calibration, prompt and invocations for one registered capability."
          />
          {loading && !detail ? (
            <LoadingState label="Loading capability…" />
          ) : (
            <ErrorState message={error ?? "Not found"} onRetry={() => void load()} />
          )}
        </div>
      </div>
    );
  }

  const c = detail.capability;
  const posture = detail.posture as { kind: string; reason?: string };

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <PageHead
          title={c.displayName}
          description={<span className="wx-data-md">{c.capabilityKey}</span>}
        >
          <StatusPill
            label={cap(c.lifecycleState.toLowerCase())}
            tone={lifecycleTone(c.lifecycleState)}
          />
          <StatusPill label={`${cap(c.riskTier)} risk`} tone={riskTierTone(c.riskTier)} />
          <Button
            onClick={() => setTransitioning(true)}
            disabled={detail.permittedNextStates.length === 0}
          >
            Transition
          </Button>
        </PageHead>
        {outcome ? <OutcomeBanner ok={outcome.ok} message={outcome.message} /> : null}

        {/* Posture is the operational answer to "would a call to this capability actually be served right
            now" — and it is NOT implied by the lifecycle state: an APPROVED capability with an active kill
            switch or an unhealthy backend is unavailable. Shown at the top of every tab. */}
        {posture.kind === "unavailable" ? (
          <StandingNotice tone="error">
            Not currently serving — {cap(posture.reason ?? "unknown").toLowerCase()}.
          </StandingNotice>
        ) : (
          <StandingNotice tone="success">
            Serving — {cap(posture.kind).toLowerCase()}.
          </StandingNotice>
        )}

        <div className="wx-list-toolbar">
          <div
            className="flex flex-wrap gap-1"
            role="tablist"
            aria-label="Capability sections"
            onKeyDown={(event) => {
              const next = nextTab(tab, event.key);
              if (!next) return;
              event.preventDefault();
              setTab(next);
              document.getElementById(tabId(next))?.focus();
            }}
          >
            {TABS.map((name) => (
              <Button
                key={name}
                id={tabId(name)}
                role="tab"
                size="sm"
                tone={tab === name ? "secondary" : "tertiary"}
                aria-selected={tab === name}
                aria-controls={TAB_PANEL_ID}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
              >
                {name}
              </Button>
            ))}
          </div>
        </div>

        <div id={TAB_PANEL_ID} role="tabpanel" aria-labelledby={tabId(tab)} className="grid gap-4">
          {tab === "Overview" ? <OverviewTab detail={detail} /> : null}
          {tab === "Lifecycle" ? <LifecycleTab detail={detail} /> : null}
          {tab === "Calibration" ? <CalibrationTab detail={detail} /> : null}
          {tab === "Prompts" ? <PromptsTab capabilityKey={c.capabilityKey} /> : null}
          {tab === "Invocations" ? <InvocationSearch capabilityId={c.id} embedded /> : null}
          {tab === "Drift" ? (
            <StandingNotice tone="warning">
              Per-capability drift series are not served by the API — the drift feed is run-shaped,
              not a time series. See the{" "}
              <Link to="/admin/ai-platform/drift">platform drift overview</Link> for this
              capability's most recent drift-response run.
            </StandingNotice>
          ) : null}
        </div>
      </div>

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
    <section className="wx-drawer-card">
      <h3>Registry entry</h3>
      <dl className="wx-kv">
        <dt>Capability key</dt>
        <dd className="wx-data-md">{c.capabilityKey}</dd>
        <dt>Default backend</dt>
        <dd className="wx-data-md">{c.defaultBackendKey}</dd>
        <dt>Allowed backends</dt>
        <dd className="wx-data-md">{c.allowedBackendKeys.join(", ")}</dd>
        <dt>Active prompt template</dt>
        <dd className={c.currentPromptTemplateKey ? "wx-data-md" : undefined}>
          {c.currentPromptTemplateKey ?? "None"}
        </dd>
        <dt>Tenant opt-in required</dt>
        <dd>{c.tenantOptInRequired ? "Yes" : "No"}</dd>
        <dt>Clinician opt-out supported</dt>
        <dd>{c.clinicianOptOutSupported ? "Yes" : "No"}</dd>
        <dt>First approved</dt>
        <dd className="wx-nums">{formatDate(c.firstApprovedAt)}</dd>
        <dt>Last re-approved</dt>
        <dd className="wx-nums">{formatDate(c.lastReapprovedAt)}</dd>
        <dt>Re-approval due</dt>
        <dd className="wx-nums">{formatDate(c.nextReapprovalDueAt)}</dd>
      </dl>
    </section>
  );
}

function LifecycleTab({ detail }: { detail: Detail }): JSX.Element {
  const events = [...detail.lifecycleEvents].sort((a, b) =>
    a.transitionedAt < b.transitionedAt ? 1 : -1,
  );
  return (
    <section className="grid gap-3">
      <p className="wx-source-line">
        Permitted next states:{" "}
        {detail.permittedNextStates.length === 0
          ? "none — this capability is at a terminal state"
          : detail.permittedNextStates.map((s) => cap(s.toLowerCase())).join(", ")}
      </p>
      {events.length === 0 ? (
        <EmptyListState
          glyph="clock"
          title="No transitions"
          description="This capability has not moved yet."
        />
      ) : (
        <div className="wx-list-table-wrap">
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Lifecycle transitions</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">From → to</th>
                <th scope="col">Stage</th>
                <th scope="col">Signer role</th>
                <th scope="col">Rationale</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="wx-nums">{formatDate(e.transitionedAt)}</td>
                  <td>
                    {e.fromState ? cap(e.fromState.toLowerCase()) : "—"} →{" "}
                    <StatusPill
                      label={cap(e.toState.toLowerCase())}
                      tone={lifecycleTone(e.toState)}
                    />
                  </td>
                  <td>{cap(e.approvalKind)}</td>
                  <td>{cap(e.actorRole)}</td>
                  <td className="max-w-96">{e.rationaleText}</td>
                  <td className="wx-data-md">{e.linkedEvaluationRunId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CalibrationTab({ detail }: { detail: Detail }): JSX.Element {
  const current = detail.calibrations.find((c) => c.isCurrent) ?? null;
  const history = [...detail.calibrations].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (
    <section className="grid gap-4">
      {current === null ? (
        // Worth stating rather than showing an empty card: an APPROVED capability with no calibration is
        // a governance gap (§2.5), not a cosmetic one.
        <StandingNotice tone="warning">
          No current calibration is published for this capability.
        </StandingNotice>
      ) : (
        <section className="wx-drawer-card">
          <h3>Current calibration</h3>
          <dl className="wx-kv">
            <dt>Backend</dt>
            <dd className="wx-data-md">{current.backendKey}</dd>
            <dt>Baseline set</dt>
            <dd className="wx-nums">{formatDate(current.baselineSetAt)}</dd>
          </dl>
          <h3>Thresholds</h3>
          <pre className="wx-code-block">{JSON.stringify(current.thresholds, null, 2)}</pre>
          <h3>Baseline metrics</h3>
          <pre className="wx-code-block">{JSON.stringify(current.baselineMetrics, null, 2)}</pre>
        </section>
      )}
      {history.length === 0 ? null : (
        <>
          <SectionTitle>Calibration history</SectionTitle>
          <div className="wx-list-table-wrap">
            <table className="wx-list-table wx-list-table-static">
              <caption className="wx-sr-only">Calibration history</caption>
              <thead>
                <tr>
                  <th scope="col">Published</th>
                  <th scope="col">Backend</th>
                  <th scope="col">Current</th>
                  <th scope="col">Superseded</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="wx-nums">{formatDate(h.createdAt)}</td>
                    <td className="wx-data-md">{h.backendKey}</td>
                    <td>{h.isCurrent ? "Yes" : "—"}</td>
                    <td className="wx-nums">{formatDate(h.supersededAt)}</td>
                    <td>{h.supersededReason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
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

  if (loading) return <LoadingState label="Loading prompt…" />;
  if (missing || !prompt)
    return (
      <EmptyListState
        glyph="file-text"
        title="No active prompt template"
        description="This capability serves no prompt yet — expected below APPROVED."
      />
    );

  return (
    <section className="grid gap-4">
      <section className="wx-drawer-card">
        <h3>Active prompt template</h3>
        <dl className="wx-kv">
          <dt>Template key</dt>
          <dd className="wx-data-md">{prompt.templateKey}</dd>
          <dt>Version</dt>
          <dd className="wx-nums">v{prompt.version}</dd>
          <dt>Content hash</dt>
          <dd className="wx-data-md break-all">{prompt.contentHash}</dd>
          <dt>Approved</dt>
          <dd className="wx-nums">{formatDate(prompt.approvedAt)}</dd>
          <dt>Git artifact</dt>
          <dd className="wx-data-md break-all">{prompt.gitArtifactPath}</dd>
          <dt>Compatible backends</dt>
          <dd className="wx-data-md">{prompt.compatibleBackendKeys.join(", ")}</dd>
          <dt>Input schema</dt>
          <dd className="wx-data-md break-all">{prompt.inputSchemaRef}</dd>
          <dt>Output schema</dt>
          <dd className="wx-data-md break-all">{prompt.outputSchemaRef}</dd>
          <dt>Clinical reviewer attestation</dt>
          <dd>{prompt.clinicalReviewerAttestation ?? "None recorded"}</dd>
        </dl>
      </section>
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
    <Modal open ariaLabel="Transition capability" onClose={onClose} width="34rem">
      <div className="wx-modal-body">
        <h2>
          Transition <span className="wx-data-md">{detail.capability.capabilityKey}</span>
        </h2>
        <SelectField
          id="tx-state"
          label="To state"
          value={toState}
          onChange={(e) => setToState(e.target.value)}
          options={detail.permittedNextStates.map((s) => ({
            value: s,
            label: cap(s.toLowerCase()),
          }))}
        />
        <SelectField
          id="tx-role"
          label="Signing as"
          value={actorRole}
          onChange={(e) => setActorRole(e.target.value)}
          options={ACTOR_ROLES.map((r) => ({ value: r, label: cap(r) }))}
        />
        <TextField
          id="tx-run"
          label="Evidence — evaluation run id"
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
          placeholder="Required by some edges; the route decides which"
        />
        <TextAreaField
          id="tx-rationale"
          label="Rationale"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          rows={4}
          placeholder="Why this capability may move to that state."
        />
        <div className="wx-modal-actions">
          <Button tone="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={busy || !toState || rationale.trim().length === 0}
          >
            {busy ? "Recording…" : "Record transition"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

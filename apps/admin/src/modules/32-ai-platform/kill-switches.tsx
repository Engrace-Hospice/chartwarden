import {
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/32-ai-platform — §5.1.3 kill-switch dashboard
// (`/admin/ai-platform/kill-switches`, `ai.kill_switch.read` + `ai.kill_switch.activate`).
//
// Two stacked tables — platform-wide kills (`organizationId === null`) and tenant-scoped kills — because
// they are different orders of severity: a platform kill has stopped a capability for every tenant on the
// system, and burying it in a mixed list under an "Organization: —" cell would be exactly the wrong
// emphasis. When any platform kill is active the page leads with an assertive banner.
//
// THE ACTOR KIND IS THE OPERATOR'S OWN CLAIM, and only the two HUMAN kinds are offerable. §3.2.12 lets the
// four `automated_*` kinds carry a NULL membership id, so a form that could name one would let a person
// file a stop as though a monitor had raised it — erasing the accountability §8.3 exists to keep. The
// backend's `KillSwitchHumanActorKind` union refuses them too; this select just never shows them.
//
// ACTIVATION IS PER CAPABILITY. §5.1.3's dialog sketches a capability MULTISELECT (or "all capabilities"),
// but R7 is keyed on a single `:capabilityId` and there is no bulk route. Rather than fan out N writes
// from the browser — where a partial failure would leave half the platform stopped and no record of the
// intent — this activates one capability at a time and says so.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  Field,
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

type KillSwitchPage =
  operations["getApiV1AiKillswitches"]["responses"][200]["content"]["application/json"];
type KillSwitch = KillSwitchPage["killSwitches"][number];
type CapabilityPage =
  operations["getApiV1AiCapabilities"]["responses"][200]["content"]["application/json"];
type Capability = CapabilityPage["capabilities"][number];

const REASONS = [
  "sev1_hallucination",
  "sev2_hallucination",
  "cost_cap_reached",
  "vendor_outage_exceeded_sla",
  "prompt_injection_detected",
  "manual_safety_pause",
  "misuse_detected",
  "bias_drift_severe",
  "lifecycle_demotion",
] as const;
const ACTOR_KINDS = ["ai_safety_owner", "incident_commander"] as const;

/** Elapsed time since activation, in the coarsest unit that is still informative. */
function since(iso: string | null, now: Date): string {
  if (!iso) return "—";
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min`;
  if (hours < 48) return `${Math.floor(hours)} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function KillSwitches(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<KillSwitch[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState<KillSwitch | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [switches, caps] = await Promise.all([
      client.GET("/api/v1/ai/kill-switches", {}),
      client.GET("/api/v1/ai/capabilities", { params: { query: {} } }),
    ]);
    if (switches.error || caps.error) {
      setError("Kill-switch state unavailable.");
      setLoading(false);
      return;
    }
    setRows(switches.data.killSwitches);
    setCapabilities(caps.data.capabilities);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const now = new Date();
  const keyOf = useMemo(() => {
    const byId = new Map(capabilities.map((c) => [c.id, c.capabilityKey]));
    return (id: string) => byId.get(id) ?? id;
  }, [capabilities]);

  const active = rows.filter((r) => r.active);
  const platformKills = active.filter((r) => r.organizationId === null);
  const tenantKills = active.filter((r) => r.organizationId !== null);

  function renderTable(list: KillSwitch[], withOrg: boolean): JSX.Element {
    return (
      <table style={tableStyle}>
        <thead>
          <tr style={theadRow}>
            <th style={cell}>Capability</th>
            {withOrg ? <th style={cell}>Organization</th> : null}
            <th style={cell}>Activated</th>
            <th style={cell}>Elapsed</th>
            <th style={cell}>Reason</th>
            <th style={cell}>Actor</th>
            <th style={cell} />
          </tr>
        </thead>
        <tbody>
          {list.map((k) => (
            <tr key={k.id} style={bodyRow}>
              <td style={cell}>
                <Link to={`/admin/ai-platform/capabilities/${k.capabilityId}`}>
                  <code>{keyOf(k.capabilityId)}</code>
                </Link>
              </td>
              {withOrg ? (
                <td style={cell}>
                  <code>{k.organizationId}</code>
                </td>
              ) : null}
              <td style={cell} className="tabular-nums">
                {formatDate(k.activatedAt)}
              </td>
              <td style={cell} className="tabular-nums">
                {since(k.activatedAt, now)}
              </td>
              <td style={cell}>{k.reason ? cap(k.reason) : "—"}</td>
              <td style={cell}>{k.activationActorKind ? cap(k.activationActorKind) : "—"}</td>
              <td style={cell}>
                <button
                  type="button"
                  onClick={() => setDeactivating(k)}
                  style={actionButtonStyle(false)}
                >
                  Deactivate
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div style={pageStyle}>
      <PageHeader
        title="Kill switches"
        breadcrumb="AI Platform"
        actions={
          <button
            type="button"
            onClick={() => setActivating(true)}
            style={actionButtonStyle(true)}
            disabled={capabilities.length === 0}
          >
            Activate kill switch
          </button>
        }
      />
      {outcome ? <OutcomeBanner ok={outcome.ok} message={outcome.message} /> : null}
      {loading && rows.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : (
        <>
          {platformKills.length > 0 ? (
            <StandingNotice tone="critical">
              {platformKills.length} capability
              {platformKills.length === 1 ? " is" : "ies are"} stopped platform-wide. Every tenant
              is affected.
            </StandingNotice>
          ) : (
            <StandingNotice tone="success">
              All capabilities operational — no active kill switch.
            </StandingNotice>
          )}

          <section style={cardStyle}>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600 }}>Active platform-wide kills</h2>
            {platformKills.length === 0 ? (
              <EmptyState
                title="None active"
                description="No capability is stopped across the platform."
              />
            ) : (
              renderTable(platformKills, false)
            )}
          </section>

          <section style={cardStyle}>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600 }}>Active tenant-scoped kills</h2>
            {tenantKills.length === 0 ? (
              <EmptyState title="None active" description="No tenant-scoped kill is in effect." />
            ) : (
              renderTable(tenantKills, true)
            )}
          </section>
        </>
      )}

      {activating ? (
        <ActivateDialog
          capabilities={capabilities}
          onClose={() => setActivating(false)}
          onDone={(message, ok) => {
            setActivating(false);
            setOutcome({ ok, message });
            if (ok) void load();
          }}
        />
      ) : null}
      {deactivating ? (
        <DeactivateDialog
          killSwitch={deactivating}
          capabilityKey={keyOf(deactivating.capabilityId)}
          onClose={() => setDeactivating(null)}
          onDone={(message, ok) => {
            setDeactivating(null);
            setOutcome({ ok, message });
            if (ok) void load();
          }}
        />
      ) : null}
    </div>
  );
}

/** R7 — activate. One capability per activation; see the file header on why there is no multiselect. */
function ActivateDialog({
  capabilities,
  onClose,
  onDone,
}: {
  capabilities: Capability[];
  onClose: () => void;
  onDone: (message: string, ok: boolean) => void;
}): JSX.Element {
  const client = useApiClient();
  const [capabilityId, setCapabilityId] = useState(capabilities[0]?.id ?? "");
  const [scope, setScope] = useState<"platform" | "tenant">("tenant");
  const [reason, setReason] = useState<string>("manual_safety_pause");
  const [actorKind, setActorKind] = useState<string>("ai_safety_owner");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    const res = await client.POST("/api/v1/ai/capabilities/{capabilityId}/kill-switch", {
      params: { path: { capabilityId } },
      body: {
        scope,
        reason: reason as never,
        actorKind: actorKind as never,
        activationMessage: message,
      },
    });
    setBusy(false);
    onDone(res.error ? "Activation refused." : `Kill switch active (${scope}).`, !res.error);
  }

  return (
    <Modal open ariaLabel="Activate kill switch" role="alertdialog" onClose={onClose} width="34rem">
      <div style={{ ...cardStyle, border: "none" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>Activate kill switch</h2>
        <Field label="Capability" htmlFor="ks-capability">
          <select
            id="ks-capability"
            value={capabilityId}
            onChange={(e) => setCapabilityId(e.target.value)}
            style={inputStyle}
          >
            {capabilities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} ({c.capabilityKey})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Scope" htmlFor="ks-scope">
          <select
            id="ks-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as "platform" | "tenant")}
            style={inputStyle}
          >
            <option value="tenant">Tenant — this organization only</option>
            <option value="platform">Platform — every tenant</option>
          </select>
        </Field>
        <Field label="Reason" htmlFor="ks-reason">
          <select
            id="ks-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={inputStyle}
          >
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {cap(r)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Acting as" htmlFor="ks-actor">
          <select
            id="ks-actor"
            value={actorKind}
            onChange={(e) => setActorKind(e.target.value)}
            style={inputStyle}
          >
            {ACTOR_KINDS.map((a) => (
              <option key={a} value={a}>
                {cap(a)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Narrative (no PHI)" htmlFor="ks-message">
          <textarea
            id="ks-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            style={inputStyle}
            placeholder="What happened, and what a reader six months from now needs to know."
          />
        </Field>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !capabilityId || message.trim().length === 0}
            style={actionButtonStyle(true, busy || !capabilityId || message.trim().length === 0)}
          >
            {busy ? "Activating…" : "Activate"}
          </button>
          <button type="button" onClick={onClose} style={actionButtonStyle(false)}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** R8 — deactivate. The resolution narrative is required by the route, so it is required here. */
function DeactivateDialog({
  killSwitch,
  capabilityKey,
  onClose,
  onDone,
}: {
  killSwitch: KillSwitch;
  capabilityKey: string;
  onClose: () => void;
  onDone: (message: string, ok: boolean) => void;
}): JSX.Element {
  const client = useApiClient();
  const [narrative, setNarrative] = useState("");
  const [actorKind, setActorKind] = useState<string>("ai_safety_owner");
  const [busy, setBusy] = useState(false);
  const scope: "platform" | "tenant" = killSwitch.organizationId === null ? "platform" : "tenant";

  async function submit(): Promise<void> {
    setBusy(true);
    const res = await client.DELETE("/api/v1/ai/capabilities/{capabilityId}/kill-switch", {
      params: { path: { capabilityId: killSwitch.capabilityId } },
      body: { scope, actorKind: actorKind as never, resolutionNarrative: narrative },
    });
    setBusy(false);
    onDone(res.error ? "Deactivation refused." : `${capabilityKey} resumed.`, !res.error);
  }

  return (
    <Modal
      open
      ariaLabel="Deactivate kill switch"
      role="alertdialog"
      onClose={onClose}
      width="34rem"
    >
      <div style={{ ...cardStyle, border: "none" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>Resume {capabilityKey}</h2>
        <StandingNotice tone="warning">
          {scope === "platform"
            ? "This capability will resume for every tenant on the platform."
            : "This capability will resume for this organization."}
        </StandingNotice>
        <Field label="Acting as" htmlFor="ks-d-actor">
          <select
            id="ks-d-actor"
            value={actorKind}
            onChange={(e) => setActorKind(e.target.value)}
            style={inputStyle}
          >
            {ACTOR_KINDS.map((a) => (
              <option key={a} value={a}>
                {cap(a)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Resolution narrative" htmlFor="ks-d-narrative">
          <textarea
            id="ks-d-narrative"
            value={narrative}
            onChange={(e) => setNarrative(e.target.value)}
            rows={4}
            style={inputStyle}
            placeholder="What was fixed, and why it is safe to resume."
          />
        </Field>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || narrative.trim().length === 0}
            style={actionButtonStyle(true, busy || narrative.trim().length === 0)}
          >
            {busy ? "Resuming…" : "Resume capability"}
          </button>
          <button type="button" onClick={onClose} style={actionButtonStyle(false)}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

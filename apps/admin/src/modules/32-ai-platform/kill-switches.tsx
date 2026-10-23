import {
  Button,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  Modal,
  SelectField,
  TextAreaField,
  focusFirstInvalid,
  interactiveRowProps,
  useApiClient,
  useDrawerA11y,
  useRequestGuard,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
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
// The redesign's list + right drawer: a row opens the kill switch in the drawer (`?killSwitch=<id>`), where
// the operator resumes it. Activating one — which stops a capability — stays a confirm Modal.
//
// ACTIVATION IS PER CAPABILITY. §5.1.3's dialog sketches a capability MULTISELECT (or "all capabilities"),
// but R7 is keyed on a single `:capabilityId` and there is no bulk route. Rather than fan out N writes
// from the browser — where a partial failure would leave half the platform stopped and no record of the
// intent — this activates one capability at a time and says so.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useSearchParams } from "react-router-dom";
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
const ACTOR_OPTIONS = ACTOR_KINDS.map((a) => ({ value: a, label: cap(a) }));
const SELECTED_PARAM = "killSwitch";

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
  const [params, setParams] = useSearchParams();
  const selectedId = params.get(SELECTED_PARAM);
  const [rows, setRows] = useState<KillSwitch[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [activating, setActivating] = useState(false);
  const guard = useRequestGuard();

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setError(null);
    const [switches, caps] = await Promise.all([
      client.GET("/api/v1/ai/kill-switches", {}),
      client.GET("/api/v1/ai/capabilities", { params: { query: {} } }),
    ]);
    if (!isCurrent()) return;
    if (switches.error || caps.error) {
      setError("Kill-switch state unavailable.");
      setLoading(false);
      return;
    }
    setRows(switches.data.killSwitches);
    setCapabilities(caps.data.capabilities);
    setLoading(false);
  }, [client, guard]);

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
  const selected = active.find((r) => r.id === selectedId) ?? null;

  function renderTable(list: KillSwitch[], withOrg: boolean, caption: string): JSX.Element {
    return (
      <div className="wx-list-table-wrap">
        <table className="wx-list-table">
          <caption className="wx-sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Capability</th>
              {withOrg ? <th scope="col">Organization</th> : null}
              <th scope="col">Activated</th>
              <th scope="col">Elapsed</th>
              <th scope="col">Reason</th>
              <th scope="col">Actor</th>
            </tr>
          </thead>
          <tbody>
            {list.map((k) => {
              const isSelected = k.id === selectedId;
              const open = (): void => setParams({ [SELECTED_PARAM]: k.id });
              return (
                <tr
                  key={k.id}
                  className={
                    isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                  }
                  {...interactiveRowProps(open, isSelected)}
                >
                  <td>
                    <span className="wx-row-title wx-data-md">{keyOf(k.capabilityId)}</span>
                  </td>
                  {withOrg ? <td className="wx-data-md">{k.organizationId}</td> : null}
                  <td className="wx-nums">{formatDate(k.activatedAt)}</td>
                  <td className="wx-nums">{since(k.activatedAt, now)}</td>
                  <td>{k.reason ? cap(k.reason) : "—"}</td>
                  <td>{k.activationActorKind ? cap(k.activationActorKind) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className={`wx-list-drawer${selectedId ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <PageHead
          title="Kill switches"
          description="Capabilities stopped platform-wide or for one tenant, and who stopped them."
        >
          <Button
            tone="danger"
            onClick={() => setActivating(true)}
            disabled={capabilities.length === 0}
          >
            Activate kill switch
          </Button>
        </PageHead>
        {outcome ? <OutcomeBanner ok={outcome.ok} message={outcome.message} /> : null}
        {loading && rows.length === 0 ? (
          <LoadingState label="Loading kill switches…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
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

            <div className="wx-stat-grid" aria-label="Kill-switch summary">
              <div className="wx-stat-card">
                <div>
                  <span className="wx-stat-label">Platform-wide kills</span>
                  <span className="wx-stat-value wx-nums">{platformKills.length}</span>
                </div>
              </div>
              <div className="wx-stat-card">
                <div>
                  <span className="wx-stat-label">Tenant-scoped kills</span>
                  <span className="wx-stat-value wx-nums">{tenantKills.length}</span>
                </div>
              </div>
            </div>

            <SectionTitle>Active platform-wide kills</SectionTitle>
            {platformKills.length === 0 ? (
              <EmptyListState
                title="None active"
                description="No capability is stopped across the platform."
              />
            ) : (
              renderTable(platformKills, false, "Active platform-wide kills")
            )}

            <SectionTitle>Active tenant-scoped kills</SectionTitle>
            {tenantKills.length === 0 ? (
              <EmptyListState
                title="None active"
                description="No tenant-scoped kill is in effect."
              />
            ) : (
              renderTable(tenantKills, true, "Active tenant-scoped kills")
            )}
          </>
        )}
      </div>

      {selectedId ? (
        <KillSwitchDrawer
          key={selectedId}
          id={selectedId}
          killSwitch={selected}
          capabilityKey={selected ? keyOf(selected.capabilityId) : null}
          loading={loading}
          onClose={() => setParams({})}
          onDone={(message, ok) => {
            setOutcome({ ok, message });
            if (ok) {
              setParams({});
              void load();
            }
          }}
        />
      ) : null}

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
  const [attempted, setAttempted] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const messageError =
    attempted && message.trim().length === 0
      ? "Describe what happened so the audit trail explains the pause."
      : undefined;

  async function submit(): Promise<void> {
    setAttempted(true);
    if (!capabilityId || message.trim().length === 0) {
      focusFirstInvalid(bodyRef.current);
      return;
    }
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
    <Modal open ariaLabel="Activate kill switch" onClose={onClose} width="34rem">
      <div className="wx-modal-body" ref={bodyRef}>
        <h2>Activate kill switch</h2>
        <SelectField
          id="ks-capability"
          label="Capability"
          value={capabilityId}
          onChange={(e) => setCapabilityId(e.target.value)}
          options={capabilities.map((c) => ({
            value: c.id,
            label: `${c.displayName} (${c.capabilityKey})`,
          }))}
        />
        <SelectField
          id="ks-scope"
          label="Scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as "platform" | "tenant")}
          options={[
            { value: "tenant", label: "Tenant — this organization only" },
            { value: "platform", label: "Platform — every tenant" },
          ]}
        />
        <SelectField
          id="ks-reason"
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          options={REASONS.map((r) => ({ value: r, label: cap(r) }))}
        />
        <SelectField
          id="ks-actor"
          label="Acting as"
          value={actorKind}
          onChange={(e) => setActorKind(e.target.value)}
          options={ACTOR_OPTIONS}
        />
        <TextAreaField
          id="ks-message"
          label="Narrative (no PHI)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          error={messageError}
          rows={4}
          placeholder="What happened, and what a reader six months from now needs to know."
        />
        <div className="wx-modal-actions">
          <Button tone="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            tone="danger"
            onClick={() => void submit()}
            loading={busy}
            disabled={busy || !capabilityId}
          >
            {busy ? "Activating…" : "Activate"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The selected kill switch in the right drawer, with R8 — deactivate. The resolution narrative is required
 * by the route, so it is required here.
 */
function KillSwitchDrawer({
  id,
  killSwitch,
  capabilityKey,
  loading,
  onClose,
  onDone,
}: {
  id: string;
  killSwitch: KillSwitch | null;
  capabilityKey: string | null;
  loading: boolean;
  onClose: () => void;
  onDone: (message: string, ok: boolean) => void;
}): JSX.Element {
  const client = useApiClient();
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const [narrative, setNarrative] = useState("");
  const [actorKind, setActorKind] = useState<string>("ai_safety_owner");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const narrativeError =
    attempted && narrative.trim().length === 0
      ? "Describe what was fixed; the route requires a resolution narrative."
      : undefined;
  const scope: "platform" | "tenant" = killSwitch?.organizationId === null ? "platform" : "tenant";

  async function submit(): Promise<void> {
    if (!killSwitch) return;
    setAttempted(true);
    if (narrative.trim().length === 0) {
      focusFirstInvalid(bodyRef.current);
      return;
    }
    setBusy(true);
    const res = await client.DELETE("/api/v1/ai/capabilities/{capabilityId}/kill-switch", {
      params: { path: { capabilityId: killSwitch.capabilityId } },
      body: { scope, actorKind: actorKind as never, resolutionNarrative: narrative },
    });
    setBusy(false);
    onDone(res.error ? "Deactivation refused." : `${capabilityKey} resumed.`, !res.error);
  }

  return (
    <aside className="wx-admission-drawer" aria-label="Kill switch" {...drawer}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="block" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2 className="wx-data-md">{capabilityKey ?? "Kill switch"}</h2>
          <span className="wx-row-sub">
            {killSwitch ? (scope === "platform" ? "Platform-wide" : "Tenant-scoped") : id}
          </span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body" ref={bodyRef}>
        {killSwitch === null ? (
          loading ? (
            <LoadingSpinner label="Loading kill switch…" />
          ) : (
            <InlineAlert tone="info">This kill switch is no longer active.</InlineAlert>
          )
        ) : (
          <>
            <section className="wx-drawer-card">
              <h3>Activation</h3>
              <dl className="wx-kv">
                <dt>Capability</dt>
                <dd>
                  <Link
                    className="wx-data-md"
                    to={`/admin/ai-platform/capabilities/${killSwitch.capabilityId}`}
                  >
                    {capabilityKey}
                  </Link>
                </dd>
                {killSwitch.organizationId ? (
                  <>
                    <dt>Organization</dt>
                    <dd className="wx-data-md break-all">{killSwitch.organizationId}</dd>
                  </>
                ) : null}
                <dt>Activated</dt>
                <dd className="wx-nums">{formatDate(killSwitch.activatedAt)}</dd>
                <dt>Reason</dt>
                <dd>{killSwitch.reason ? cap(killSwitch.reason) : "—"}</dd>
                <dt>Actor</dt>
                <dd>
                  {killSwitch.activationActorKind ? cap(killSwitch.activationActorKind) : "—"}
                </dd>
              </dl>
            </section>
            <section className="wx-drawer-card">
              <h3>Resume capability</h3>
              <InlineAlert tone="warning">
                {scope === "platform"
                  ? "This capability will resume for every tenant on the platform."
                  : "This capability will resume for this organization."}
              </InlineAlert>
              <SelectField
                id="ks-d-actor"
                label="Acting as"
                value={actorKind}
                onChange={(e) => setActorKind(e.target.value)}
                options={ACTOR_OPTIONS}
              />
              <TextAreaField
                id="ks-d-narrative"
                label="Resolution narrative"
                value={narrative}
                onChange={(e) => setNarrative(e.target.value)}
                error={narrativeError}
                rows={4}
                placeholder="What was fixed, and why it is safe to resume."
              />
              <div className="wx-drawer-actions">
                <Button onClick={() => void submit()} loading={busy} disabled={busy}>
                  {busy ? "Resuming…" : "Resume capability"}
                </Button>
              </div>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

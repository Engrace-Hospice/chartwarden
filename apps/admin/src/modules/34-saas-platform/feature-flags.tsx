import {
  Button,
  CeremonyModal,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  SelectField,
  StatusPill,
  TextField,
  interactiveRowProps,
  useApiClient,
  useDebouncedValue,
  useDrawerA11y,
  useRequestGuard,
} from "@chartwarden/ui";
import type { GlyphName, paths } from "@chartwarden/ui";
// apps/web/src/modules/34-saas — Feature Flags admin (M34, §4.7 / D13, platform-ops surface).
// Spec: docs/design/screens — M34 §5.1 screen inventory. Matched to the P4 Pencil frame
// (chartwarden-P4-admin-platform.pen `bxUqf`): a KPI strip (total / enabled / kill-switches / per-tenant)
// over the flags Work Queue + a right detail panel + the §6/D10 kill-switch ceremony. "Use Work Queue."
// Lists platform-global + per-tenant feature flags via GET /api/v1/platform/feature-flags, and arms
// the kill-switch toggle as a confirm-by-typing Guardrail ceremony. The write is step-up-gated server
// side (feature_flag.kill_switch + passkey_recent_5min, §6/D10); the screen mirrors that gravity with
// a CeremonyModal that requires the operator to type the flag key to commit. Imports only leaves.
// Laid out as the redesign's list + right drawer (outbox is the reference): KPI stat grid, filter row,
// list table, and the selected flag in an `aside.wx-admission-drawer`.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { FLAG_KIND_TONE, statusLabel } from "./saas-status";

// §4.7 wire enums (platform-typebox `FLAG_KIND` / `FLAG_VALUE_TYPE`) — the UI owns its copy.
const FLAG_KINDS = ["product", "rollout", "kill_switch", "migration"] as const;
type FlagKind = (typeof FLAG_KINDS)[number];

// The `FeatureFlagViewSchema` read shape the route serves (CursorPageOf<FeatureFlagView>).
export interface FeatureFlagView {
  id: string;
  flagKey: string;
  organizationId: string | null;
  flagKind: FlagKind;
  valueType: "bool" | "string" | "number" | "json";
  value: unknown;
  rolloutPercent: number | null;
  killSwitchActive: boolean;
  updatedAt: string;
}
interface FeatureFlagPage {
  items: FeatureFlagView[];
  nextCursor: string | null;
  hasMore: boolean;
}

const KIND_OPTIONS = [
  { value: "", label: "All kinds" },
  ...FLAG_KINDS.map((k) => ({ value: k, label: statusLabel(k) })),
];

const scopeLabel = (f: FeatureFlagView): string =>
  f.organizationId ? "Per-tenant" : "Platform-global";

const renderValue = (f: FeatureFlagView): string => {
  if (f.value === null || f.value === undefined) return "—";
  if (typeof f.value === "object") return JSON.stringify(f.value);
  return String(f.value);
};

const filterKey = (select: string, text: string): string => `${select}\u0000${text.trim()}`;

export function FeatureFlags(): JSX.Element {
  const client = useApiClient();
  const [flagKind, setFlagKind] = useState<FlagKind | "">("");
  const [orgFilter, setOrgFilter] = useState("");
  // Typing must not refetch per keystroke; Enter applies the raw text immediately.
  const debouncedOrg = useDebouncedValue(orgFilter);
  const guard = useRequestGuard();
  const [flags, setFlags] = useState<FeatureFlagView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FeatureFlagView | null>(null);
  const [ceremony, setCeremony] = useState<FeatureFlagView | null>(null);
  const [committing, setCommitting] = useState(false);

  // The filter the list was last fetched with: Enter/Apply/Refresh load the typed text at once, and the debounced value then
  // catches up to the same text — without this the effect would fetch the identical query a second time.
  const loadedKey = useRef<string | null>(null);

  const load = useCallback(
    async (org: string = debouncedOrg) => {
      const isCurrent = guard();
      loadedKey.current = filterKey(flagKind, org);
      setLoading(true);
      setError(null);
      const query: NonNullable<
        paths["/api/v1/platform/feature-flags"]["get"]["parameters"]["query"]
      > = { limit: 50 };
      if (flagKind) query.flagKind = flagKind as typeof query.flagKind;
      if (org.trim()) query.organizationId = org.trim();
      const { data, error: err } = await client.GET("/api/v1/platform/feature-flags", {
        params: { query },
      });
      if (!isCurrent()) return;
      if (err) {
        setError("Could not load feature flags.");
        setLoading(false);
        return;
      }
      const page = data as FeatureFlagPage | undefined;
      setFlags(page?.items ?? []);
      setLoading(false);
    },
    [client, guard, flagKind, debouncedOrg],
  );

  useEffect(() => {
    if (loadedKey.current === filterKey(flagKind, debouncedOrg)) return;
    void load();
  }, [load, flagKind, debouncedOrg]);

  // §6/D10 — the kill-switch toggle is the controlled act. We confirm-by-typing the flag key, then
  // POST the enqueue route; the server enforces the passkey-recent-5min step-up + ABAC authority.
  const commitKillSwitch = useCallback(
    async (typed?: string): Promise<void> => {
      const flag = ceremony;
      if (!flag || typed !== flag.flagKey) return;
      setCommitting(true);
      const { error: err } = await client.POST(
        "/api/v1/platform/feature-flags/{flagKey}/kill-switch",
        {
          params: { path: { flagKey: flag.flagKey } },
          body: {
            killSwitchActive: !flag.killSwitchActive,
            reason: `Kill switch toggled via platform feature-flags console for ${flag.flagKey}`,
          },
        },
      );
      setCommitting(false);
      setCeremony(null);
      if (!err) {
        setSelected(null);
        void load();
      }
    },
    [ceremony, client, load],
  );

  return (
    <div className={`wx-list-drawer${selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Feature flags</h1>
            <p>Platform-global and per-tenant flags, with the step-up-gated kill switch.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <Button tone="secondary" onClick={() => void load(orgFilter)}>
              <Glyph name="rotate-ccw" size={15} /> Refresh
            </Button>
          </div>
        </header>

        <FlagKpis flags={flags} loadFailed={error !== null} />

        <div className="wx-list-toolbar">
          <div className="grid w-full gap-3 md:grid-cols-2">
            <SelectField
              label="Flag kind"
              value={flagKind}
              options={KIND_OPTIONS}
              onChange={(e) => setFlagKind(e.target.value as FlagKind | "")}
            />
            <TextField
              label="Tenant organization id"
              placeholder="Optional"
              value={orgFilter}
              onChange={(e) => setOrgFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void load(orgFilter);
              }}
            />
          </div>
        </div>

        <FlagsTable
          items={flags}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onRetry={() => void load()}
        />
      </div>
      {selected ? (
        <FlagDrawer
          flag={selected}
          onClose={() => setSelected(null)}
          onArmKillSwitch={() => setCeremony(selected)}
        />
      ) : null}
      {ceremony ? (
        <CeremonyModal
          open
          epcs
          title={ceremony.killSwitchActive ? "Disarm kill switch" : "Arm kill switch"}
          attestation={
            <div className="flex flex-col gap-2">
              <div>
                You are about to <strong>{ceremony.killSwitchActive ? "disarm" : "arm"}</strong> the
                kill switch for <span className="wx-data-md">{ceremony.flagKey}</span> (
                {scopeLabel(ceremony).toLowerCase()}).
              </div>
              <div className="text-[0.8125rem] text-[var(--color-on-surface-variant)]">
                Arming the kill switch immediately disables this capability for every affected
                tenant and emits a platform-emergency alert.
              </div>
            </div>
          }
          legalText="I confirm this emergency change is authorized and understand it takes effect immediately."
          signer={{ name: "Platform operator", role: "platform-ops" }}
          stepUp={{
            label: `Type the flag key to confirm: ${ceremony.flagKey}`,
            type: "text",
            placeholder: ceremony.flagKey,
          }}
          commitLabel={committing ? "Working…" : "Confirm & toggle"}
          onCommit={(typed) => void commitKillSwitch(typed)}
          onCancel={() => setCeremony(null)}
        />
      ) : null}
    </div>
  );
}

// §4.7 KPI strip (frame `bxUqf`) — counts derived from the loaded page (no separate count endpoint;
// the loaded set is the platform flag inventory). Enabled = a truthy boolean flag not kill-switched.
// `loadFailed` renders every tile "—" instead of a misleading literal 0 when the GET errored (the
// same live-browser-audit misleading-zeros pattern already fixed for Staff Management).
/** Enabled = a boolean flag (wire value type `bool`, as in the DB enum) that is true and not kill-switched. */
export const countEnabledFlags = (flags: readonly FeatureFlagView[]): number =>
  flags.filter((f) => f.valueType === "bool" && f.value === true && !f.killSwitchActive).length;

function FlagKpis({
  flags,
  loadFailed,
}: {
  flags: FeatureFlagView[];
  loadFailed: boolean;
}): JSX.Element {
  const total = loadFailed ? null : flags.length;
  const enabled = loadFailed ? null : countEnabledFlags(flags);
  const killed = loadFailed ? null : flags.filter((f) => f.killSwitchActive).length;
  const perTenant = loadFailed ? null : flags.filter((f) => f.organizationId !== null).length;
  return (
    <div className="wx-stat-grid" aria-label="Feature flag summary">
      <StatCard icon="layout-grid" label="Total flags" value={total} sub="loaded" />
      <StatCard icon="check-circle" label="Enabled" value={enabled} sub="boolean · on" />
      <StatCard
        icon="alert"
        label="Kill switches"
        value={killed}
        sub="armed"
        alert={Boolean(killed)}
      />
      <StatCard icon="building" label="Per-tenant" value={perTenant} sub="org-scoped" />
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  alert,
}: {
  icon: GlyphName;
  label: string;
  value: number | null;
  sub: string;
  alert?: boolean;
}): JSX.Element {
  return (
    <div className="wx-stat-card">
      <span className="wx-stat-icon" aria-hidden>
        <Glyph name={icon} size={18} />
      </span>
      <div>
        <span className="wx-stat-label">{label}</span>
        <span className={`wx-stat-value wx-nums${alert ? " text-[var(--color-alert)]" : ""}`}>
          {value ?? "—"}
        </span>
        <span className="wx-row-sub">{sub}</span>
      </div>
    </div>
  );
}

function FlagsTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: {
  items: FeatureFlagView[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (f: FeatureFlagView) => void;
  onRetry: () => void;
}): JSX.Element {
  if (error)
    return (
      <div className="wx-list-state" role="alert">
        <InlineAlert tone="error">{error}</InlineAlert>
        <Button tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (loading)
    return (
      <div className="wx-list-state">
        <LoadingSpinner label="Loading feature flags…" />
      </div>
    );
  if (items.length === 0)
    return (
      <div className="wx-list-state">
        <Glyph name="check-circle" size={24} />
        <span>No feature flags match this filter.</span>
      </div>
    );
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Feature flags</caption>
        <thead>
          <tr>
            <th scope="col">Flag key</th>
            <th scope="col">Kind</th>
            <th scope="col">Value</th>
            <th scope="col">Kill switch</th>
          </tr>
        </thead>
        <tbody>
          {items.map((f) => {
            const isSelected = f.id === selectedId;
            const open = (): void => onSelect(f);
            return (
              <tr
                key={f.id}
                className={
                  isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                }
                {...interactiveRowProps(open, isSelected)}
              >
                <td>
                  <span className="wx-row-title wx-data-md">{f.flagKey}</span>
                  <span className="wx-row-sub">{scopeLabel(f)}</span>
                </td>
                <td>
                  <StatusPill
                    label={statusLabel(f.flagKind)}
                    tone={FLAG_KIND_TONE[f.flagKind] ?? "neutral"}
                  />
                </td>
                <td className="wx-data-md">{renderValue(f)}</td>
                <td>
                  {f.killSwitchActive ? (
                    <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold text-[var(--color-alert)]">
                      <Glyph name="alert" size={14} label="Kill switch armed" />
                      Armed
                    </span>
                  ) : (
                    <span className="text-[0.8125rem] text-[var(--color-on-surface-variant)]">
                      Inactive
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FlagDrawer({
  flag,
  onClose,
  onArmKillSwitch,
}: {
  flag: FeatureFlagView;
  onClose: () => void;
  onArmKillSwitch: () => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside className="wx-admission-drawer" aria-label="Feature flag" {...drawer}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="settings" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2 className="wx-data-md">{flag.flagKey}</h2>
          <span className="wx-row-sub">{scopeLabel(flag)}</span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Flag</h3>
            <StatusPill
              label={statusLabel(flag.flagKind)}
              tone={FLAG_KIND_TONE[flag.flagKind] ?? "neutral"}
            />
          </div>
          <dl className="wx-kv">
            <dt>Scope</dt>
            <dd>{scopeLabel(flag)}</dd>
            {flag.organizationId ? (
              <>
                <dt>Tenant organization</dt>
                <dd className="wx-data-md break-words">{flag.organizationId}</dd>
              </>
            ) : null}
            <dt>Value type</dt>
            <dd>{statusLabel(flag.valueType)}</dd>
            <dt>Value</dt>
            <dd className="wx-data-md break-words">{renderValue(flag)}</dd>
            <dt>Rollout</dt>
            <dd className="wx-nums">
              {flag.rolloutPercent !== null ? `${flag.rolloutPercent}%` : "—"}
            </dd>
            <dt>Updated</dt>
            <dd className="wx-nums">{new Date(flag.updatedAt).toLocaleString()}</dd>
          </dl>
        </section>
        <section className="wx-drawer-card">
          <h3>Kill switch</h3>
          <InlineAlert tone={flag.killSwitchActive ? "error" : "warning"}>
            {flag.killSwitchActive
              ? "Kill switch armed — capability disabled tenant-wide"
              : "Kill switch is a step-up-gated emergency lever"}
          </InlineAlert>
          <div className="wx-drawer-actions">
            <Button tone="secondary" onClick={onArmKillSwitch}>
              {flag.killSwitchActive ? "Disarm kill switch…" : "Arm kill switch…"}
            </Button>
          </div>
        </section>
      </div>
    </aside>
  );
}

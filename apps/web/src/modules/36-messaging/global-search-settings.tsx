// M36 WP 2.7b - tenant admin screen for global message search (ADR-0058 decisions 2-3). Shows the switch, the go-live
// checklist and the index build progress. The server is the authority: the Switch on button is only a convenience gate,
// every refusal (409 checklist, step-up, 403, 503) is the server's own text, and success is shown only from its reply.
import {
  ConfirmDialog,
  ErrorState,
  InlineAlert,
  LoadingSpinner,
  PageHeader,
  Panel,
  StatusPill,
  isStepUpRequired,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { stepUpRedirectFor } from "../../shell/step-up-redirect";
import { savedReplyErrorText } from "./saved-replies-types";
import "./global-search-settings.css";

interface Checklist {
  readonly platformEnabled: boolean;
  readonly legacyBodiesMigrated: boolean;
  readonly escrowAttested: boolean;
  readonly leakageAttested: boolean;
  readonly rateLimitActive: boolean;
}
interface Rebuild {
  readonly status: "building" | "ready" | "stale";
  readonly effectiveReady: boolean;
}
interface SettingsView {
  readonly enabled: boolean;
  readonly changedAt: string | null;
  readonly purgeRequestedAt: string | null;
  readonly purgeCompletedAt: string | null;
  readonly checklist: Checklist;
  readonly rebuild: Rebuild | null;
}
type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly status: number | undefined }
  | { readonly kind: "ready"; readonly view: SettingsView };

const SETTINGS_PATH = "/api/v1/messaging/global-search/settings";
const CHECKS: ReadonlyArray<{ key: keyof Checklist; label: string }> = [
  { key: "platformEnabled", label: "Global search is allowed on the platform" },
  { key: "legacyBodiesMigrated", label: "All message bodies use the current encryption format" },
  { key: "escrowAttested", label: "The encryption key escrow and restore drill are on record" },
  { key: "leakageAttested", label: "The leakage review is signed off" },
  { key: "rateLimitActive", label: "Search requests are rate limited" },
];

const purgePending = (v: SettingsView): boolean =>
  !v.enabled && v.purgeRequestedAt !== null && v.purgeCompletedAt === null;

function loadErrorCopy(status: number | undefined): { title: string; description: string } {
  if (status === 403) {
    return {
      title: "You do not have permission",
      description:
        "Managing global search needs the global search permission. Ask an administrator.",
    };
  }
  return {
    title: "Global search settings are unavailable",
    description: "The settings could not be loaded. Try again in a moment.",
  };
}

function indexStatus(view: SettingsView): string {
  if (purgePending(view)) {
    return "The search index is still being removed. Switching on is unavailable until it finishes.";
  }
  if (!view.enabled) return "Global search is off for your organization.";
  if (view.rebuild?.effectiveReady) return "The search index is ready.";
  return "The search index is still being built. Search stays closed until it is ready.";
}

function blockedReason(view: SettingsView): string | null {
  if (purgePending(view)) return "Wait for the last switch-off to finish removing the index.";
  const unmet = CHECKS.filter((c) => !view.checklist[c.key]).length;
  return unmet > 0 ? `${unmet} prerequisite${unmet === 1 ? " is" : "s are"} not met.` : null;
}

export function GlobalSearchSettings(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [confirming, setConfirming] = useState<boolean | null>(null); // the value to switch to
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const inFlight = useRef(false);
  const reasonId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual retry trigger
  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    client
      .GET(SETTINGS_PATH)
      .then(({ data, response }) => {
        if (!current) return;
        setState(
          data
            ? { kind: "ready", view: data as unknown as SettingsView }
            : { kind: "error", status: response?.status },
        );
      })
      .catch(() => current && setState({ kind: "error", status: undefined }));
    return () => {
      current = false;
    };
  }, [client, tick]);

  const submit = useCallback(async () => {
    if (confirming === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      const { data, error } = await client.PUT(SETTINGS_PATH, { body: { enabled: confirming } });
      if (data) {
        setState({ kind: "ready", view: data as unknown as SettingsView });
      } else if (isStepUpRequired(error)) {
        const to = stepUpRedirectFor(error, `${location.pathname}${location.search}`);
        if (to) navigate(to);
      } else {
        setRefusal(savedReplyErrorText(error, "The setting could not be changed."));
        // Re-read quietly so the checklist shown is the server's current one (no spinner: the refusal stays visible).
        const fresh = await client.GET(SETTINGS_PATH);
        if (fresh.data) setState({ kind: "ready", view: fresh.data as unknown as SettingsView });
      }
    } catch {
      setRefusal("The setting could not be changed. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
      setConfirming(null);
    }
  }, [client, confirming, location.pathname, location.search, navigate]);

  if (state.kind === "loading") return <LoadingSpinner label="Loading global search settings" />;
  if (state.kind === "error") {
    const copy = loadErrorCopy(state.status);
    return (
      <ErrorState
        title={copy.title}
        description={copy.description}
        onRetry={state.status === 403 ? undefined : () => setTick((n) => n + 1)}
      />
    );
  }

  const { view } = state;
  const blocked = view.enabled ? null : blockedReason(view);
  const turningOn = confirming === true;
  return (
    <div className="wx-gss">
      <PageHeader title="Global search" breadcrumb="Messaging / Settings">
        <p className="wx-gss-lede">
          Lets staff search messages across every conversation they can already read.
        </p>
      </PageHeader>
      {refusal ? <InlineAlert>{refusal}</InlineAlert> : null}
      <Panel title="Status">
        <div className="wx-gss-status">
          <StatusPill
            label={view.enabled ? "On" : "Off"}
            tone={view.enabled ? "success" : "neutral"}
          />
          <p>{indexStatus(view)}</p>
        </div>
        <button
          type="button"
          className="wx-gss-action"
          disabled={busy || blocked !== null}
          aria-describedby={blocked ? reasonId : undefined}
          onClick={() => setConfirming(!view.enabled)}
        >
          {view.enabled ? "Switch off global search" : "Switch on global search"}
        </button>
        {blocked ? (
          <p id={reasonId} className="wx-gss-hint">
            {blocked}
          </p>
        ) : null}
      </Panel>
      <Panel
        title="Go-live prerequisites"
        description="All must be met before it can be switched on."
      >
        <ul className="wx-gss-checks" aria-label="Go-live prerequisites">
          {CHECKS.map((check) => (
            <li key={check.key}>
              <span>{check.label}</span>
              <StatusPill
                label={view.checklist[check.key] ? "Met" : "Not met"}
                tone={view.checklist[check.key] ? "success" : "warning"}
              />
            </li>
          ))}
        </ul>
      </Panel>
      <ConfirmDialog
        open={confirming !== null}
        title={turningOn ? "Switch on global search?" : "Switch off global search?"}
        description={
          turningOn
            ? "This builds a blind-token index of message content for your organization so search can find words without storing readable text. The index takes time to build, and search stays closed until it is ready. You will be asked to confirm your identity."
            : "Search stops immediately and the search index for your organization is removed. Switching back on needs the removal to finish and the index to be rebuilt."
        }
        confirmLabel={turningOn ? "Switch on" : "Switch off"}
        pending={busy}
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}

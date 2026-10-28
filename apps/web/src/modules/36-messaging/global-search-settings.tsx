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
} from "@chartwarden/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { stepUpRedirectFor } from "../../shell/step-up-redirect";
import "./global-search-settings.css";

interface Checklist {
  readonly platformEnabled: boolean;
  readonly legacyBodiesMigrated: boolean;
  readonly escrowAttested: boolean;
  readonly leakageAttested: boolean;
  readonly rateLimitActive: boolean;
  readonly excludedMembersCleared: boolean;
}
interface Notice {
  readonly version: string;
  readonly text: string;
}
interface NoticeAcknowledgement {
  readonly version: string;
  readonly byUserId: string;
  readonly at: string;
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
  readonly notice: Notice;
  readonly noticeAcknowledgement: NoticeAcknowledgement | null;
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
  {
    key: "excludedMembersCleared",
    label: "No channel has patient-family, external-auditor or platform-staff members",
  },
];
const NOTICE_REFUSAL_CODE = "GLOBAL_SEARCH_NOTICE_NOT_ACKNOWLEDGED";

/** True when the server refused because the acknowledged notice version is missing or out of date. */
function isNoticeRefusal(error: unknown): boolean {
  return (error as { error?: { code?: unknown } } | null)?.error?.code === NOTICE_REFUSAL_CODE;
}

const POLL_MS = 15_000;

/** The server's refusal as readable text: its message, then each failing check's own sentence (no field-name prefix). */
function refusalText(error: unknown, fallback: string): string {
  const envelope = (error as { error?: { message?: unknown; details?: unknown } } | null)?.error;
  const message = typeof envelope?.message === "string" ? envelope.message : "";
  const details = Array.isArray(envelope?.details) ? envelope.details : [];
  const reasons = details
    .map((d) =>
      typeof (d as { message?: unknown }).message === "string"
        ? (d as { message: string }).message
        : "",
    )
    .filter(Boolean);
  if (message && reasons.length > 0) return `${message} ${reasons.join(" ")}`;
  return message || fallback;
}

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
  if (view.rebuild?.status === "stale") {
    return "The search index is behind and is catching up. Search stays closed until it is ready.";
  }
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
  const [accepted, setAccepted] = useState(false); // the notice checkbox; reset whenever the dialog opens or re-prompts
  const [refusal, setRefusal] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Bumped by every (re)load and on unmount: a reply from an older epoch never overwrites newer state.
  const epoch = useRef(0);
  const reasonId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual retry trigger
  useEffect(() => {
    let current = true;
    epoch.current += 1;
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
      epoch.current += 1;
    };
  }, [client, tick]);

  // Quiet re-read (no spinner). Dropped if a reload, a write or an unmount happened since it started, or a write is in flight.
  const readQuietly = useCallback(() => {
    const mine = epoch.current;
    client
      .GET(SETTINGS_PATH)
      .then(({ data }) => {
        if (data && mine === epoch.current && !inFlight.current) {
          setState({ kind: "ready", view: data as unknown as SettingsView });
        }
      })
      .catch(() => undefined);
  }, [client]);

  // While the index builds the admin is waiting on it: re-read quietly until it reports ready.
  const waitingOnIndex =
    state.kind === "ready" && state.view.enabled && !state.view.rebuild?.effectiveReady;
  useEffect(() => {
    if (!waitingOnIndex) return;
    const timer = setInterval(readQuietly, POLL_MS);
    return () => clearInterval(timer);
  }, [readQuietly, waitingOnIndex]);

  const noticeVersion = state.kind === "ready" ? state.view.notice.version : undefined;
  const submit = useCallback(async () => {
    if (confirming === null || inFlight.current) return;
    if (confirming && (!accepted || !noticeVersion)) return; // the server enforces it too; this is the convenience gate
    let reprompt = false;
    inFlight.current = true;
    epoch.current += 1; // any read already in flight predates this write and must not overwrite its result
    const mine = epoch.current;
    setBusy(true);
    setRefusal(null);
    const fresh = () => mine === epoch.current; // false once the screen reloaded or unmounted meanwhile
    try {
      const { data, error } = await client.PUT(SETTINGS_PATH, {
        body: confirming
          ? { enabled: true, acknowledgedNoticeVersion: noticeVersion }
          : { enabled: false },
      });
      if (!fresh()) return;
      if (data) {
        setState({ kind: "ready", view: data as unknown as SettingsView });
      } else if (isStepUpRequired(error)) {
        const to = stepUpRedirectFor(error, `${location.pathname}${location.search}`);
        if (to) navigate(to);
        else setRefusal("Confirm your identity to change this setting, then try again.");
      } else {
        setRefusal(refusalText(error, "The setting could not be changed."));
        // A stale or missing acknowledgement: show the re-read notice again and ask for a fresh acceptance.
        reprompt = isNoticeRefusal(error);
        // Re-read quietly so the checklist shown is the server's current one (no spinner: the refusal stays visible).
        // A failed re-read must not replace the server's refusal, so it is ignored.
        const latest = await client.GET(SETTINGS_PATH).catch(() => undefined);
        if (latest?.data && fresh()) {
          setState({ kind: "ready", view: latest.data as unknown as SettingsView });
        }
      }
    } catch {
      if (fresh()) {
        setRefusal("The setting could not be changed. Check your connection and try again.");
      }
    } finally {
      inFlight.current = false;
      if (fresh()) {
        setBusy(false);
        setAccepted(false);
        if (!reprompt) setConfirming(null);
      }
      epoch.current += 1; // a poll that started during the write carries pre-write data
    }
  }, [accepted, client, confirming, noticeVersion, location.pathname, location.search, navigate]);

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
      <PageHeader title="Global search">
        <p className="wx-gss-lede">
          Lets staff search messages across every conversation they can already read.
        </p>
      </PageHeader>
      {refusal && confirming === null ? <InlineAlert>{refusal}</InlineAlert> : null}
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
          onClick={() => {
            setAccepted(false);
            setConfirming(!view.enabled);
          }}
        >
          {view.enabled ? "Switch off global search" : "Switch on global search"}
        </button>
        {view.enabled && !view.rebuild?.effectiveReady ? (
          <button type="button" className="wx-gss-action" onClick={readQuietly}>
            Refresh status
          </button>
        ) : null}
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
      {view.noticeAcknowledgement ? (
        <p className="wx-gss-hint">
          Discoverability notice version {view.noticeAcknowledgement.version} was last acknowledged
          on {new Date(view.noticeAcknowledgement.at).toLocaleString()}.
        </p>
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        title={turningOn ? "Switch on global search?" : "Switch off global search?"}
        description={
          <>
            {refusal ? <InlineAlert>{refusal}</InlineAlert> : null}
            {turningOn ? (
              <>
                <p>
                  This builds a blind-token index of message content for your organization so search
                  can find words without storing readable text. The index takes time to build, and
                  search stays closed until it is ready. You will be asked to confirm your identity.
                </p>
                <p className="wx-gss-notice" data-testid="search-notice">
                  {view.notice.text}
                </p>
                <label className="wx-gss-accept">
                  <input
                    type="checkbox"
                    checked={accepted}
                    disabled={busy}
                    onChange={(e) => setAccepted(e.target.checked)}
                  />
                  I have read and accept this notice
                </label>
              </>
            ) : (
              "Search stops immediately and the search index for your organization is removed. Switching back on needs the removal to finish and the index to be rebuilt."
            )}
          </>
        }
        confirmDisabled={turningOn && !accepted}
        confirmLabel={turningOn ? "Switch on" : "Switch off"}
        tone={turningOn ? "default" : "danger"}
        pending={busy}
        onConfirm={() => void submit()}
        onCancel={() => {
          setConfirming(null);
          setRefusal(null);
        }}
      />
    </div>
  );
}

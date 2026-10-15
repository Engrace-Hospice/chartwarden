import { Button, LoadingSpinner, StatusPill, TextField, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/25-remittance — the PATH section of the denial work panel (hospice ADR/TPE/QIC PRD, milestone
// 3): which route the denial takes (an appeal, or a reopening the MAC handles itself), which rule decided it, and the
// reopening once there is one. The route is computed by the server from the organization's dated rules plus a
// built-in 56900 default and is shown verbatim (ADR-0030); an unverified rule says so, so nobody mistakes a default
// for a confirmed MAC rule. Until an 835 mapping is confirmed the MAC's own reason code (for example 56900) is typed
// in here, which is what the rule matches.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ButtonRow, ErrorAlert, Facts, Hint, NoticeAlert } from "./action-ui";
import {
  type DenialRouteView,
  type ReopeningSummary,
  createReopening,
  loadDenialRoute,
  loadReopeningsForDenial,
  setMacReasonCode,
} from "./remittance-api";
import { DENIAL_ROUTE_TONE, humanize, toneOf } from "./remittance-status";
import { ReopeningPanel } from "./reopening-panel";

const ROUTE_LABEL: Record<DenialRouteView["route"], string> = {
  appeal: "Appeal",
  reopening: "MAC reopening",
  undetermined: "Not determined",
};

/** A reopening that is still being worked (withdrawn and closed ones are history). */
const isLive = (r: ReopeningSummary): boolean =>
  r.state === "draft" || r.state === "submitted" || r.state === "decided";

export interface DenialRoutePanelProps {
  readonly denialId: string;
  /** The denial's row version (If-Match for recording the MAC reason code). */
  readonly denialVersion: number | null;
  /** Reload the denial after the MAC reason code changed (its version moved). */
  readonly onDenialChanged: () => Promise<void>;
  /** Called after any successful write so the worklist reloads. */
  readonly onChanged: () => void;
  /** Tells the parent which path the denial takes, so its appeal action can ask for an override reason. */
  readonly onRoute: (route: DenialRouteView["route"] | null) => void;
  /** The parent is mid-action: both mutate the denial on the same If-Match version, so this panel waits. */
  readonly locked?: boolean;
  /** Tells the parent a command here is in flight, so its own actions wait too. */
  readonly onBusyChange?: (busy: boolean) => void;
  /** Bumped by the parent after one of its actions succeeded, so the path is read again. */
  readonly refreshToken?: number;
}

export function DenialRoutePanel({
  denialId,
  denialVersion,
  onDenialChanged,
  onChanged,
  onRoute,
  locked = false,
  onBusyChange,
  refreshToken = 0,
}: DenialRoutePanelProps): JSX.Element {
  const client = useApiClient();
  const [route, setRoute] = useState<DenialRouteView | null>(null);
  const [live, setLive] = useState<ReopeningSummary | null>(null);
  /** False when the reopenings list could not be read: then "Open reopening" must not be offered (a live one may exist). */
  const [listOk, setListOk] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [macName, setMacName] = useState("");
  const [ownBusy, setOwnBusy] = useState(false);
  const busy = ownBusy || locked;
  const setBusy = (next: boolean): void => {
    setOwnBusy(next);
    onBusyChange?.(next);
  };
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  /** True once the person has typed in the reason code field: a reload must not overwrite their text. */
  const codeTouched = useRef(false);
  const onRouteRef = useRef(onRoute);
  onRouteRef.current = onRoute;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const [routeRes, reopenings] = await Promise.all([
      loadDenialRoute(client, denialId),
      loadReopeningsForDenial(client, denialId),
    ]);
    if (!mounted.current) return;
    if (!routeRes.ok) {
      // Keep the last good path and any open form; the error is shown inline with a retry.
      setLoadError(routeRes.message);
      return;
    }
    setLoadError(null);
    setRoute(routeRes.value);
    onRouteRef.current(routeRes.value.route);
    if (!codeTouched.current) setCode(routeRes.value.macReasonCode ?? "");
    setMacName((cur) => cur || (routeRes.value.macName ?? ""));
    setListOk(reopenings.ok);
    if (reopenings.ok) setLive(reopenings.value.find(isLive) ?? null);
  }, [client, denialId]);

  // refreshToken is a trigger, not a value the effect reads: the parent bumps it after its own action succeeded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on refreshToken by design
  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  async function saveCode(): Promise<void> {
    if (denialVersion === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await setMacReasonCode(client, denialId, denialVersion, code.trim() || null);
    if (!mounted.current) return;
    if (!res.ok) setError(res.message);
    else {
      setNotice("MAC reason code saved.");
      codeTouched.current = false;
    }
    // The denial's version moved (or is stale after a refusal): reload both before the next action. A refused
    // value stays in the field so the person can correct it.
    await onDenialChanged();
    await load();
    if (res.ok) onChanged();
    if (mounted.current) setBusy(false);
  }

  async function openReopening(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await createReopening(client, { denialCaseId: denialId, macName: macName.trim() });
    if (!mounted.current) return;
    if (!res.ok) setError(res.message);
    else setNotice("Reopening opened.");
    await load();
    if (res.ok) onChanged();
    if (mounted.current) setBusy(false);
  }

  if (!route) {
    return loadError ? (
      <>
        <ErrorAlert message={loadError} />
        <ButtonRow>
          <Button tone="tertiary" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </ButtonRow>
      </>
    ) : (
      <LoadingSpinner />
    );
  }

  const codeChanged = code.trim().toUpperCase() !== (route.macReasonCode ?? "");

  return (
    <>
      <h3 className="wx-action-title">Path</h3>
      <NoticeAlert message={notice} />
      <ErrorAlert message={error} />
      {loadError ? (
        <>
          <ErrorAlert message={loadError} />
          <ButtonRow>
            <Button tone="tertiary" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </ButtonRow>
        </>
      ) : null}
      {listOk ? null : (
        <Hint>
          The reopenings for this denial could not be read, so a new one cannot be opened until they
          can.
        </Hint>
      )}
      <Facts
        items={[
          [
            "This denial goes to",
            <StatusPill
              key="r"
              label={ROUTE_LABEL[route.route]}
              tone={toneOf(DENIAL_ROUTE_TONE, route.route)}
            />,
          ],
          [
            "Decided by",
            route.rule
              ? `${route.rule.origin === "platform" ? "Built-in rule" : "Your rule"}: ${humanize(route.rule.codeKind)} ${route.rule.code}`
              : "No rule matches, so it can be appealed",
          ],
          ["MAC reason code", route.macReasonCode ?? "Not recorded"],
        ]}
      />
      {route.route === "reopening" ? (
        <Hint>
          The MAC reopens this kind of denial; it is not appealed.
          {route.unverified
            ? " This path comes from a rule nobody has verified with your MAC. Confirm it before relying on it."
            : ""}
        </Hint>
      ) : null}
      {route.route === "reopening" && route.rule?.sourceNote ? (
        <Hint>Source: {route.rule.sourceNote}</Hint>
      ) : null}

      <TextField
        label="MAC reason code (for example 56900)"
        value={code}
        onChange={(e) => {
          codeTouched.current = true;
          setCode(e.target.value);
        }}
        maxLength={16}
      />
      <ButtonRow end>
        <Button
          tone="tertiary"
          size="sm"
          disabled={busy || denialVersion === null || !codeChanged}
          onClick={() => void saveCode()}
        >
          Save reason code
        </Button>
      </ButtonRow>

      {live ? (
        <ReopeningPanel
          key={live.id}
          denialId={denialId}
          reopeningId={live.id}
          onChanged={() => {
            void load();
            onChanged();
          }}
        />
      ) : route.route === "reopening" && listOk ? (
        <>
          <TextField
            label="MAC that is reopening this claim"
            value={macName}
            onChange={(e) => setMacName(e.target.value)}
            maxLength={120}
          />
          <ButtonRow end>
            <Button disabled={busy || macName.trim() === ""} onClick={() => void openReopening()}>
              Open reopening
            </Button>
          </ButtonRow>
        </>
      ) : null}
    </>
  );
}

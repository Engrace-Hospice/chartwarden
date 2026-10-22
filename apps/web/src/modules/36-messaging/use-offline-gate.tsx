// The shared "needs a connection" gate for the actions that are never queued (Urgent clinical, Message on-call role, Needs a
// response). The control stays focusable and aria-disabled (not `disabled`) so its reason can be read (aria-describedby); a
// click that is blocked says why. The hint is visible but NOT live (aria-live="off"): the offline transition is announced once,
// by the page-level OfflineBanner, and a blocked click or a cleared request once, through the polite region below.
import { useCallback, useId } from "react";
import type { ReactElement } from "react";
import { useOnlineStatus } from "./offline-banner";
import { NEEDS_CONNECTION_TEXT } from "./urgent-wording";
import { useLiveAnnouncement } from "./use-live-announcement";
import "./offline-gate.css";

export interface OfflineGate {
  readonly online: boolean;
  /** Spread on the control: `aria-disabled` and `aria-describedby` while offline. */
  readonly controlProps: { readonly "aria-disabled"?: true; readonly "aria-describedby"?: string };
  /** Render next to the control, always: the status hint plus the polite region `onBlocked`/`announce` speak through. */
  readonly hint: ReactElement;
  /** Just the polite region, for a control that has its own visible hint text. */
  readonly region: ReactElement;
  /** Call from a click the gate swallowed: says why, even when the hint text did not change. */
  readonly onBlocked: () => void;
  /** Announce something else through the same polite region (e.g. a cleared request). */
  readonly announce: (message: string) => void;
}

export function useOfflineGate(): OfflineGate {
  const online = useOnlineStatus();
  const hintId = useId();
  const { region, announce } = useLiveAnnouncement();
  const onBlocked = useCallback(() => announce(NEEDS_CONNECTION_TEXT), [announce]);
  const hint = (
    <>
      <output id={hintId} className="wx-offline-hint" aria-live="off">
        {online ? "" : NEEDS_CONNECTION_TEXT}
      </output>
      {region}
    </>
  );
  const controlProps = online
    ? {}
    : ({ "aria-disabled": true, "aria-describedby": hintId } as const);
  return { online, controlProps, hint, region, onBlocked, announce };
}

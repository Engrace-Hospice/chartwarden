// M36 WP 5.5 (ADR-0083, PROPOSED) - the list of devices shared by the self-service page and the security officer's page: a flat list of rows
// (label, last used, push state as text, a pill for the current one) and a Revoke button that names its device. State is words, never colour
// alone. It shows no IP address, no raw user agent and no id. Presentational: the screens own the data and the confirm step.
import type { DeviceDto } from "@chartwarden/types";
import { Button, EmptyState, LoadingSpinner, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import {
  CURRENT_LABEL,
  CURRENT_PILL,
  PUSH_OFF_TEXT,
  PUSH_ON_PILL,
  REVOKE_LABEL,
  REVOKE_RETRY_LABEL,
  REVOKING_LABEL,
  lastUsedText,
  revokeFailedText,
} from "./devices-wording";
import type { DevicesView, RowState } from "./use-devices";
import "./devices.css";

export interface DeviceListProps {
  readonly view: DevicesView;
  readonly rowState: Readonly<Record<string, RowState>>;
  readonly listLabel: string;
  readonly emptyTitle: string;
  readonly emptyText: string;
  readonly loadFailedText: string;
  readonly signInText: string;
  readonly deniedText: string;
  readonly retryLabel: string;
  /** The accessible name of a row's button: it must say which device. */
  readonly buttonName: (device: DeviceDto) => string;
  readonly onRevoke: (device: DeviceDto) => void;
  readonly onRetry: () => void;
  readonly nowMs: number;
}

function Row({
  device,
  state,
  buttonName,
  onRevoke,
  nowMs,
}: {
  readonly device: DeviceDto;
  readonly state: RowState | undefined;
  readonly buttonName: string;
  readonly onRevoke: () => void;
  readonly nowMs: number;
}): JSX.Element {
  const busy = state === "revoking";
  return (
    <li className="wx-device-row">
      <div className="wx-device-main">
        <span className="wx-device-name">{device.current ? CURRENT_LABEL : device.label}</span>
        {device.current ? <span className="wx-device-detail">{device.label}</span> : null}
        {device.current ? <StatusPill tone="progress" glyph="dot" label={CURRENT_PILL} /> : null}
      </div>
      <div className="wx-device-meta">
        <span className="wx-device-detail">{lastUsedText(device.last_used_at, nowMs)}</span>
        {device.push_registered ? (
          <StatusPill tone="success" glyph="check-circle" label={PUSH_ON_PILL} />
        ) : (
          <span className="wx-device-detail">{PUSH_OFF_TEXT}</span>
        )}
      </div>
      <div className="wx-device-action">
        <Button
          type="button"
          tone="secondary"
          size="sm"
          aria-label={
            busy
              ? `${REVOKING_LABEL}: ${buttonName}`
              : state === "failed"
                ? `${REVOKE_RETRY_LABEL}: ${buttonName}`
                : buttonName
          }
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onRevoke();
          }}
        >
          {busy ? REVOKING_LABEL : state === "failed" ? REVOKE_RETRY_LABEL : REVOKE_LABEL}
        </Button>
      </div>
      {state === "failed" ? (
        <p className="wx-device-error" role="alert">
          {revokeFailedText(device.label)}
        </p>
      ) : null}
    </li>
  );
}

export function DeviceList(props: DeviceListProps): JSX.Element {
  const { view } = props;
  if (view.status === "loading") return <LoadingSpinner />;
  if (view.status === "denied") {
    return (
      <p className="wx-device-error" role="alert">
        {view.code === 401 ? props.signInText : props.deniedText}
      </p>
    );
  }
  if (view.status === "error") {
    return (
      <div className="wx-device-error" role="alert">
        <p>{props.loadFailedText}</p>
        <Button type="button" tone="secondary" size="sm" onClick={props.onRetry}>
          {props.retryLabel}
        </Button>
      </div>
    );
  }
  if (view.devices.length === 0) {
    return <EmptyState title={props.emptyTitle} description={props.emptyText} />;
  }
  return (
    <ul className="wx-device-rows" aria-label={props.listLabel}>
      {view.devices.map((device) => (
        <Row
          key={device.id}
          device={device}
          state={props.rowState[device.id]}
          buttonName={props.buttonName(device)}
          onRevoke={() => props.onRevoke(device)}
          nowMs={props.nowMs}
        />
      ))}
    </ul>
  );
}

// M36 WP 5.5 (ADR-0083, PROPOSED) - "Devices and sessions": every place the caller is signed in, with a Revoke for each. Revoking ANOTHER device
// acts at once (the row leaves the list only after the server confirms, and "<device> revoked" is announced politely). Revoking THIS device asks
// first, because it signs the caller out: the confirm names what will happen, and only after the server says the session is revoked does the page
// leave for the sign-in screen (drafts and the remembered deep link are cleared, like the account menu's sign-out).
import type { DeviceDto } from "@wardenx/types";
import { Button, Modal, PageHeader } from "@wardenx/ui";
import { useId, useRef, useState } from "react";
import type { JSX } from "react";
import { clearAllDrafts } from "../../shell/ceremony-drafts";
import { clearPendingNotificationLink } from "../../shell/pending-deep-link";
import { DeviceList } from "./device-list";
import {
  CONFIRM_CANCEL,
  CONFIRM_CURRENT_ACTION,
  CONFIRM_CURRENT_TEXT,
  CONFIRM_CURRENT_TITLE,
  DEVICES_BREADCRUMB,
  DEVICES_DENIED,
  DEVICES_EMPTY_TEXT,
  DEVICES_EMPTY_TITLE,
  DEVICES_LIST_LABEL,
  DEVICES_LOAD_FAILED,
  DEVICES_NOTICE,
  DEVICES_RETRY_LABEL,
  DEVICES_SIGN_IN,
  DEVICES_TITLE,
  revokeButtonName,
} from "./devices-wording";
import { useDevices } from "./use-devices";
import "./devices.css";

/** Where the browser goes once the current session is revoked: the same exit as the account menu's sign-out. */
export function leaveForSignIn(): void {
  clearAllDrafts();
  clearPendingNotificationLink();
  window.location.href = "/login";
}

export function DeviceManager({
  onSignedOut = leaveForSignIn,
}: { readonly onSignedOut?: () => void }): JSX.Element {
  const { view, rowState, announcement, revoke, retry } = useDevices({});
  const [confirming, setConfirming] = useState<DeviceDto | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const confirmId = useId();

  const run = async (device: DeviceDto): Promise<void> => {
    const result = await revoke(device);
    if (result.kind === "not_found") {
      headingRef.current?.focus(); // the stale row is gone after the re-read
      return;
    }
    if (result.kind !== "revoked") return;
    if (result.current) onSignedOut();
    else headingRef.current?.focus(); // the row that held focus is gone
  };

  return (
    <>
      <PageHeader title={DEVICES_TITLE} breadcrumb={DEVICES_BREADCRUMB}>
        <p className="wx-device-detail">{DEVICES_NOTICE}</p>
      </PageHeader>
      <section className="wx-devices" aria-labelledby={`${confirmId}-heading`}>
        <h2
          id={`${confirmId}-heading`}
          ref={headingRef}
          tabIndex={-1}
          className="wx-devices-heading"
        >
          {DEVICES_LIST_LABEL}
        </h2>
        <output className="wx-devices-status" aria-live="polite">
          {announcement}
        </output>
        <DeviceList
          view={view}
          rowState={rowState}
          listLabel={DEVICES_LIST_LABEL}
          emptyTitle={DEVICES_EMPTY_TITLE}
          emptyText={DEVICES_EMPTY_TEXT}
          loadFailedText={DEVICES_LOAD_FAILED}
          signInText={DEVICES_SIGN_IN}
          deniedText={DEVICES_DENIED}
          retryLabel={DEVICES_RETRY_LABEL}
          buttonName={(d) => revokeButtonName(d.label, d.current)}
          onRevoke={(d) => (d.current ? setConfirming(d) : void run(d))}
          onRetry={retry}
          nowMs={Date.now()}
        />
      </section>
      {confirming ? (
        <Modal
          open
          role="alertdialog"
          ariaLabel={CONFIRM_CURRENT_TITLE}
          ariaDescribedBy={`${confirmId}-confirm`}
          onClose={() => setConfirming(null)}
        >
          <div className="wx-device-confirm">
            <h2>{CONFIRM_CURRENT_TITLE}</h2>
            <p id={`${confirmId}-confirm`}>{CONFIRM_CURRENT_TEXT}</p>
            <div className="wx-device-confirm-actions">
              <Button type="button" tone="secondary" onClick={() => setConfirming(null)}>
                {CONFIRM_CANCEL}
              </Button>
              <Button
                type="button"
                tone="danger"
                onClick={() => {
                  const device = confirming;
                  setConfirming(null);
                  void run(device);
                }}
              >
                {CONFIRM_CURRENT_ACTION}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

// M36 WP 5.5 (ADR-0083, PROPOSED) - the security officer's page: list and revoke ANOTHER person's sessions in this organization. The person is
// named by user id (`?user=<uuid>` or pasted): there is no organization-wide user picker yet, so the page never lists everyone. A bad id is said
// in words before any request. The revoke needs a fresh step-up: the server answers STEP_UP_REQUIRED and the page sends the officer through the
// step-up screen and back; the list stays as it was. Every look and revoke is audited server-side; the page shows no IP address or user agent.
import type { DeviceDto } from "@wardenx/types";
import { Button, PageHeader } from "@wardenx/ui";
import { useId, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { stepUpRedirectFor } from "../../shell/step-up-redirect";
import { DeviceList } from "./device-list";
import { leaveForSignIn } from "./device-manager";
import {
  DEVICES_DENIED,
  DEVICES_LOAD_FAILED,
  DEVICES_RETRY_LABEL,
  DEVICES_SIGN_IN,
  GOVERNANCE_BAD_ID,
  GOVERNANCE_BREADCRUMB,
  GOVERNANCE_EMPTY_TEXT,
  GOVERNANCE_EMPTY_TITLE,
  GOVERNANCE_LIST_LABEL,
  GOVERNANCE_NOTICE,
  GOVERNANCE_SHOW_LABEL,
  GOVERNANCE_STEP_UP_TEXT,
  GOVERNANCE_TITLE,
  GOVERNANCE_USER_HINT,
  GOVERNANCE_USER_LABEL,
  governanceRevokeName,
} from "./devices-wording";
import { useDevices } from "./use-devices";
import "./devices.css";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function PersonSessions({ userId }: { readonly userId: string }): JSX.Element {
  const { view, rowState, announcement, revoke, retry } = useDevices({ userId });
  const [stepUpNeeded, setStepUpNeeded] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const run = async (device: DeviceDto): Promise<void> => {
    setStepUpNeeded(false);
    const result = await revoke(device);
    if (result.kind === "revoked") {
      // An officer who named their own id revoked their own session: leave, like the self-service page. Otherwise the row that held
      // focus is gone, so focus the heading.
      if (result.current) leaveForSignIn();
      else headingRef.current?.focus();
      return;
    }
    if (result.kind !== "step_up") return;
    const to = stepUpRedirectFor(result.error, `${location.pathname}${location.search}`);
    if (to) navigate(to);
    else setStepUpNeeded(true);
  };

  return (
    <>
      <h2 ref={headingRef} tabIndex={-1} className="wx-devices-heading">
        {GOVERNANCE_LIST_LABEL}
      </h2>
      <output className="wx-devices-status" aria-live="polite">
        {announcement}
      </output>
      {stepUpNeeded ? (
        <p className="wx-device-error" role="alert">
          {GOVERNANCE_STEP_UP_TEXT}
        </p>
      ) : null}
      <DeviceList
        view={view}
        rowState={rowState}
        listLabel={GOVERNANCE_LIST_LABEL}
        emptyTitle={GOVERNANCE_EMPTY_TITLE}
        emptyText={GOVERNANCE_EMPTY_TEXT}
        loadFailedText={DEVICES_LOAD_FAILED}
        signInText={DEVICES_SIGN_IN}
        deniedText={DEVICES_DENIED}
        retryLabel={DEVICES_RETRY_LABEL}
        buttonName={(d) => governanceRevokeName(d.label)}
        onRevoke={(d) => void run(d)}
        onRetry={retry}
        nowMs={Date.now()}
      />
    </>
  );
}

export function SessionGovernance(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("user") ?? "";
  // The URL is the single source of truth for who is shown (Back and Forward work); `refresh` re-reads the same person.
  const showing = UUID.test(fromUrl) ? fromUrl : "";
  const [text, setText] = useState(fromUrl);
  const [badInput, setBadInput] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const invalid = badInput || (fromUrl !== "" && showing === "");
  const inputId = useId();

  const show = (): void => {
    const id = text.trim();
    if (!UUID.test(id)) {
      setBadInput(true);
      return;
    }
    setBadInput(false);
    if (id === showing) setRefresh((n) => n + 1);
    else setParams({ user: id }, { replace: true });
  };

  return (
    <>
      <PageHeader title={GOVERNANCE_TITLE} breadcrumb={GOVERNANCE_BREADCRUMB}>
        <p className="wx-device-detail">{GOVERNANCE_NOTICE}</p>
      </PageHeader>
      <section className="wx-devices" aria-label={GOVERNANCE_TITLE}>
        <form
          className="wx-device-lookup"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            show();
          }}
        >
          <label htmlFor={inputId}>{GOVERNANCE_USER_LABEL}</label>
          <input
            id={inputId}
            type="text"
            value={text}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid}
            aria-describedby={`${inputId}-hint`}
            onChange={(event) => setText(event.target.value)}
          />
          <p id={`${inputId}-hint`} className="wx-device-detail">
            {GOVERNANCE_USER_HINT}
          </p>
          <Button type="submit" tone="primary" size="sm">
            {GOVERNANCE_SHOW_LABEL}
          </Button>
          {invalid ? (
            <p className="wx-device-error" role="alert">
              {GOVERNANCE_BAD_ID}
            </p>
          ) : null}
        </form>
        {showing ? <PersonSessions key={`${showing}:${refresh}`} userId={showing} /> : null}
      </section>
    </>
  );
}

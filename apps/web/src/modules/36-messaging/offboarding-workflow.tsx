// M36 WP 5.9 (ADR-0084, PROPOSED) - "Offboarding": a departed person's checklist for a security officer. A flat list on the shared kit: one row per
// thing messaging holds for them, a word plus a glyph for its state, a count, and what running it does. "Run offboarding" asks first (it ends the
// person's sessions), then shows the server's answer; a row that failed says so and the button becomes "Run again". An item that needs a person
// stays listed with its count (never dropped) and, for acknowledgment requests, links to the supervisors' queue. The page is reached by user id
// (`/messaging/governance/offboarding/:userId`); a person who has not left, an unknown one and another tenant's all read as a plain sentence.
import type { OffboardingDto, OffboardingItemDto } from "@wardenx/types";
import { Button, EmptyState, LoadingSpinner, Modal, PageHeader, StatusPill } from "@wardenx/ui";
import { useId, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { stepUpRedirectFor } from "../../shell/step-up-redirect";
import {
  COMPLETE_TEXT,
  CONFIRM_ACTION,
  CONFIRM_CANCEL,
  CONFIRM_TEXT,
  CONFIRM_TITLE,
  ITEM_WORDING,
  OFFBOARDING_BREADCRUMB,
  OFFBOARDING_DENIED,
  OFFBOARDING_LIST_LABEL,
  OFFBOARDING_LOAD_FAILED,
  OFFBOARDING_NOTICE,
  OFFBOARDING_NOT_FOUND,
  OFFBOARDING_NOT_OFFBOARDED,
  OFFBOARDING_RETRY_LABEL,
  OFFBOARDING_RUN_FAILED,
  OFFBOARDING_SIGN_IN,
  OFFBOARDING_STEP_UP_TEXT,
  OFFBOARDING_TITLE,
  RAN_ANNOUNCEMENT,
  RUNNING_ANNOUNCEMENT,
  RUNNING_LABEL,
  RUN_AGAIN_LABEL,
  RUN_LABEL,
  STATE_WORDING,
  UNACKNOWLEDGED_LINK,
  UNACKNOWLEDGED_LINK_LABEL,
  advisoryText,
  blockedText,
  countText,
  progressText,
} from "./offboarding-wording";
import { useOffboarding } from "./use-offboarding";
import "./offboarding.css";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What a row says next to its state: what this run changed, and what is left (or, for a kept item, how many are kept). */
function metaText(item: OffboardingItemDto): string {
  if (item.state === "advisory") return "";
  const changed = item.acted > 0 ? `Changed ${item.acted}. ` : "";
  if (item.state === "kept") return `${changed}${countText(item.count)} kept`;
  return item.count > 0 ? `${changed}${countText(item.count)} left` : changed.trim();
}

function ItemRow({ item }: { readonly item: OffboardingItemDto }): JSX.Element {
  const words = ITEM_WORDING[item.key];
  const state = STATE_WORDING[item.state];
  const meta = metaText(item);
  return (
    <li className="wx-offboarding-row" data-state={item.state}>
      <div className="wx-offboarding-main">
        <span className="wx-offboarding-title">{words.title}</span>
        <span className="wx-offboarding-detail">{words.detail}</span>
        {item.key === "ack_assigned" && item.state === "needs_person" ? (
          <Link className="wx-offboarding-link" to={UNACKNOWLEDGED_LINK}>
            {UNACKNOWLEDGED_LINK_LABEL}
          </Link>
        ) : null}
      </div>
      <div className="wx-offboarding-meta">
        <StatusPill tone={state.tone} glyph={state.glyph} label={state.label} />
        {meta ? <span className="wx-offboarding-detail">{meta}</span> : null}
      </div>
    </li>
  );
}

function Checklist({ data }: { readonly data: OffboardingDto }): JSX.Element {
  return (
    <ul className="wx-offboarding-rows" aria-label={OFFBOARDING_LIST_LABEL}>
      {data.items.map((item) => (
        <ItemRow key={item.key} item={item} />
      ))}
    </ul>
  );
}

function Ready({
  data,
  running,
  runFailed,
  onRun,
  stepUpNeeded,
  announcement,
  hasRun,
}: {
  readonly data: OffboardingDto;
  readonly running: boolean;
  readonly runFailed: boolean;
  readonly onRun: () => void;
  readonly stepUpNeeded: boolean;
  readonly announcement: string;
  readonly hasRun: boolean;
}): JSX.Element {
  const confirmId = useId();
  const [confirming, setConfirming] = useState(false);
  const advisory = data.items.filter((i) => i.state === "advisory").length;
  const ranBefore = hasRun || data.items.some((i) => i.acted > 0 || i.state === "failed");
  return (
    <>
      <p className="wx-offboarding-progress">
        <strong>{progressText(data.done, data.total)}</strong>
        {" · "}
        {data.complete ? COMPLETE_TEXT : blockedText(data.blocked_by.length)}
        {advisory > 0 ? advisoryText(advisory) : null}
      </p>
      <output className="wx-offboarding-status" aria-live="polite">
        {announcement}
      </output>
      {stepUpNeeded ? (
        <p className="wx-offboarding-error" role="alert">
          {OFFBOARDING_STEP_UP_TEXT}
        </p>
      ) : null}
      {runFailed ? (
        <p className="wx-offboarding-error" role="alert">
          {OFFBOARDING_RUN_FAILED}
        </p>
      ) : null}
      <Checklist data={data} />
      <div className="wx-offboarding-actions">
        <Button
          type="button"
          tone="primary"
          aria-disabled={running}
          onClick={() => {
            if (!running) setConfirming(true);
          }}
        >
          {running ? RUNNING_LABEL : ranBefore ? RUN_AGAIN_LABEL : RUN_LABEL}
        </Button>
      </div>
      {confirming ? (
        <Modal
          open
          role="alertdialog"
          ariaLabel={CONFIRM_TITLE}
          ariaDescribedBy={`${confirmId}-confirm`}
          onClose={() => setConfirming(false)}
        >
          <div className="wx-offboarding-confirm">
            <h2>{CONFIRM_TITLE}</h2>
            <p id={`${confirmId}-confirm`}>{CONFIRM_TEXT}</p>
            <div className="wx-offboarding-confirm-actions">
              <Button type="button" tone="secondary" onClick={() => setConfirming(false)}>
                {CONFIRM_CANCEL}
              </Button>
              <Button
                type="button"
                tone="danger"
                onClick={() => {
                  setConfirming(false);
                  onRun();
                }}
              >
                {CONFIRM_ACTION}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function Person({ userId }: { readonly userId: string }): JSX.Element {
  const { view, running, runFailed, run, retry } = useOffboarding(userId);
  const [stepUpNeeded, setStepUpNeeded] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [hasRun, setHasRun] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const onRun = async (): Promise<void> => {
    setStepUpNeeded(false);
    setAnnouncement(RUNNING_ANNOUNCEMENT);
    setHasRun(true);
    const result = await run();
    if (result.kind === "ran") {
      setAnnouncement(RAN_ANNOUNCEMENT);
      headingRef.current?.focus();
      return;
    }
    if (result.kind !== "step_up") return;
    const to = stepUpRedirectFor(result.error, `${location.pathname}${location.search}`);
    if (to) navigate(to);
    else setStepUpNeeded(true);
  };

  let body: JSX.Element;
  switch (view.status) {
    case "loading":
      body = <LoadingSpinner />;
      break;
    case "error":
      body = (
        <div className="wx-offboarding-error" role="alert">
          <p>{OFFBOARDING_LOAD_FAILED}</p>
          <Button type="button" tone="secondary" size="sm" onClick={retry}>
            {OFFBOARDING_RETRY_LABEL}
          </Button>
        </div>
      );
      break;
    case "denied":
      body = (
        <p className="wx-offboarding-error" role="alert">
          {view.code === 401 ? OFFBOARDING_SIGN_IN : OFFBOARDING_DENIED}
        </p>
      );
      break;
    case "not_found":
      body = <EmptyState title="Person not found" description={OFFBOARDING_NOT_FOUND} />;
      break;
    case "not_offboarded":
      body = <EmptyState title="Not offboarded" description={OFFBOARDING_NOT_OFFBOARDED} />;
      break;
    case "ready":
      body = (
        <Ready
          data={view.data}
          running={running}
          runFailed={runFailed}
          onRun={() => void onRun()}
          stepUpNeeded={stepUpNeeded}
          announcement={announcement}
          hasRun={hasRun}
        />
      );
      break;
  }

  return (
    <>
      <h2 ref={headingRef} tabIndex={-1} className="wx-offboarding-heading">
        {OFFBOARDING_LIST_LABEL}
      </h2>
      {body}
    </>
  );
}

export function OffboardingWorkflow(): JSX.Element {
  const { userId = "" } = useParams();
  return (
    <>
      <PageHeader title={OFFBOARDING_TITLE} breadcrumb={OFFBOARDING_BREADCRUMB}>
        <p className="wx-offboarding-detail">{OFFBOARDING_NOTICE}</p>
      </PageHeader>
      <section className="wx-offboarding" aria-label={OFFBOARDING_TITLE}>
        {UUID.test(userId) ? (
          <Person key={userId} userId={userId} />
        ) : (
          <EmptyState title="Person not found" description={OFFBOARDING_NOT_FOUND} />
        )}
      </section>
    </>
  );
}

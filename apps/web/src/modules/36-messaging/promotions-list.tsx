// M36 WP 3.7 - the "Chart proposals" tab of Notifications & Tasks: the caller's own proposals. Rows carry no message
// text. Withdraw appears only when the server's allowed_actions say so.
import type { ChartPromotionDto } from "@wardenx/types";
import { Button, EmptyState, LoadingSpinner, StatusPill } from "@wardenx/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { promotionTone } from "./message-promotion-button";
import {
  PROMOTION_STATUS_LABELS,
  PROMOTION_TARGET_SHORT,
  PROPOSALS_EMPTY,
  PROPOSALS_HEADING,
  PROPOSALS_LOAD_FAILED,
  WITHDRAWN_TEXT,
  WITHDRAW_LABEL,
  promotionErrorText,
} from "./promotion-wording";
import { type PromotionStatusFilter, usePromotionActions, usePromotions } from "./use-promotions";
import "./tasks.css";
import "./promotions.css";

const FILTERS: readonly { value: PromotionStatusFilter; label: string }[] = [
  { value: "active", label: "Open" },
  { value: "closed", label: "Closed" },
];

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

export function PromotionsList(): JSX.Element {
  const [filter, setFilter] = useState<PromotionStatusFilter>("active");
  const { view, reload } = usePromotions(filter);
  const actions = usePromotionActions();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  async function withdraw(promotion: ChartPromotionDto): Promise<void> {
    setBusyId(promotion.id);
    setMessage("");
    const result = await actions.withdraw(promotion.id);
    setBusyId(null);
    setMessage(result.ok ? WITHDRAWN_TEXT : promotionErrorText(result.status, result.code));
    reload();
    // The withdrawn row leaves the open list, taking the focused button with it.
    headingRef.current?.focus();
  }

  return (
    <section className="wx-tasks" aria-labelledby="wx-promotions-heading">
      <h2 id="wx-promotions-heading" ref={headingRef} tabIndex={-1}>
        {PROPOSALS_HEADING}
      </h2>
      <fieldset className="wx-task-toggle">
        <legend className="sr-only">Proposal state</legend>
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </fieldset>
      <output className="sr-only" aria-live="polite">
        {message}
      </output>
      {view.status === "loading" ? (
        <LoadingSpinner />
      ) : view.status === "error" ? (
        <p className="wx-task-error" role="alert">
          {PROPOSALS_LOAD_FAILED}
        </p>
      ) : view.promotions.length === 0 ? (
        <EmptyState title={PROPOSALS_HEADING} description={PROPOSALS_EMPTY[filter]} />
      ) : (
        <ul className="wx-task-rows">
          {view.promotions.map((promotion) => (
            <li className="wx-task-row" key={promotion.id}>
              <div className="wx-task-badges">
                <StatusPill
                  label={PROMOTION_STATUS_LABELS[promotion.status]}
                  tone={promotionTone(promotion.status)}
                />
                <span className="wx-task-tag">
                  {PROMOTION_TARGET_SHORT[promotion.target_module]}
                </span>
              </div>
              <p className="wx-task-people-line">Proposed {when(promotion.requested_at)}</p>
              <div className="wx-task-row-actions">
                {promotion.allowed_actions.includes("withdraw") ? (
                  <Button
                    type="button"
                    tone="secondary"
                    size="sm"
                    disabled={busyId === promotion.id}
                    onClick={() => void withdraw(promotion)}
                  >
                    {WITHDRAW_LABEL}
                  </Button>
                ) : null}
                <Link
                  className="wx-task-link"
                  to={`/messaging?channelId=${promotion.channel_id}&messageId=${promotion.message_id}`}
                >
                  Open message
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

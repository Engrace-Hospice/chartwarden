// M36 WP 3.7 - the message-row "Propose for chart" trigger plus the caller's own proposals on this message (status chip,
// Withdraw). It renders nothing unless the tenant has chart proposals on (the list route's `enabled`) AND the viewer holds
// messaging.promote AND the channel is a patient's care-team conversation; the server stays the authority on all three.
import type { ChartPromotionDto } from "@wardenx/types";
import { Button, StatusPill } from "@wardenx/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { PromotionDialog } from "./promotion-dialog";
import {
  PROMOTION_STATUS_LABELS,
  PROMOTION_TARGET_SHORT,
  PROPOSED_OK_TEXT,
  PROPOSED_REPLAY_TEXT,
  PROPOSE_BUTTON_LABEL,
  WITHDRAWN_TEXT,
  WITHDRAW_LABEL,
  promotionErrorText,
} from "./promotion-wording";
import { usePromotionActions } from "./use-promotions";
import { usePromotionsIndex } from "./use-promotions-enabled";
import "./tasks.css";
import "./promotions.css";

const PROMOTE_PERMISSION = "messaging.promote";

export function promotionTone(status: ChartPromotionDto["status"]) {
  if (status === "accepted") return "success" as const;
  if (status === "proposed") return "progress" as const;
  return "neutral" as const;
}

export interface MessagePromotionButtonProps {
  readonly channelId: string;
  readonly messageId: string;
  /** The channel is a patient's care-team conversation (what the client knows; the server decides). */
  readonly patientLinked: boolean;
}

export function MessagePromotionButton({
  channelId,
  messageId,
  patientLinked,
}: MessagePromotionButtonProps): JSX.Element | null {
  const session = useSession();
  const { enabled, promotions } = usePromotionsIndex();
  const actions = usePromotionActions();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const permitted = session?.permissions?.includes(PROMOTE_PERMISSION) ?? false;
  if (!enabled || !permitted || !patientLinked) return null;
  const mine = promotions.filter((promotion) => promotion.message_id === messageId);

  function close(): void {
    setOpen(false);
    // The dialog's own restore can lose to the re-render; the trigger is the one stable control on the row.
    queueMicrotask(() => triggerRef.current?.focus());
  }

  async function withdraw(id: string): Promise<void> {
    setBusyId(id);
    setStatus("");
    const result = await actions.withdraw(id);
    setBusyId(null);
    setStatus(result.ok ? WITHDRAWN_TEXT : promotionErrorText(result.status, result.code));
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="wx-pin-toggle"
        aria-label="Propose this message for the patient's chart"
        onClick={() => {
          setStatus("");
          setOpen(true);
        }}
      >
        {PROPOSE_BUTTON_LABEL}
      </button>
      {mine.map((promotion) => (
        <span className="wx-promo-chip" key={promotion.id}>
          <StatusPill
            label={`${PROMOTION_TARGET_SHORT[promotion.target_module]}: ${PROMOTION_STATUS_LABELS[promotion.status]}`}
            tone={promotionTone(promotion.status)}
          />
          {promotion.allowed_actions.includes("withdraw") ? (
            <Button
              type="button"
              tone="tertiary"
              size="sm"
              disabled={busyId === promotion.id}
              onClick={() => void withdraw(promotion.id)}
            >
              {WITHDRAW_LABEL}
            </Button>
          ) : null}
        </span>
      ))}
      <output className="sr-only" aria-live="polite">
        {status}
      </output>
      {open ? (
        <PromotionDialog
          channelId={channelId}
          messageId={messageId}
          onClose={close}
          onProposed={(created) => {
            setStatus(created ? PROPOSED_OK_TEXT : PROPOSED_REPLAY_TEXT);
            close();
          }}
        />
      ) : null}
    </>
  );
}

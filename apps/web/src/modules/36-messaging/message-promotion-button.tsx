// M36 WP 3.7 - the message-row "Propose for chart" trigger plus the caller's own proposals on this message (status chip,
// Withdraw). It renders nothing unless the tenant has chart proposals on (the list route's `enabled`) AND the viewer holds
// messaging.promote AND the channel is a patient's care-team conversation; the server stays the authority on all three.
import type { ChartPromotionDto } from "@wardenx/types";
import { Button, StatusPill } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { PromotionDialog } from "./promotion-dialog";
import {
  PROMOTION_STATUS_LABELS,
  PROMOTION_TARGET_SHORT,
  PROPOSED_OK_TEXT,
  PROPOSED_REPLAY_TEXT,
  PROPOSE_BUTTON_LABEL,
  UNKNOWN_PERSON,
  WITHDRAWN_TEXT,
  WITHDRAW_LABEL,
  promotionErrorText,
} from "./promotion-wording";
import { usePromotionActions } from "./use-promotions";
import { PROMOTE_PERMISSION, usePromotionsIndex } from "./use-promotions-enabled";
import "./tasks.css";
import "./promotions.css";

export function promotionTone(status: ChartPromotionDto["status"]) {
  if (status === "accepted") return "success" as const;
  if (status === "proposed") return "progress" as const;
  return "neutral" as const;
}

export interface MessagePromotionButtonProps {
  readonly channelId: string;
  readonly messageId: string;
  /** Who wrote the message; names the trigger for assistive tech. */
  readonly authorName?: string | null;
  /** The channel is a patient's care-team conversation (what the client knows; the server decides). */
  readonly patientLinked: boolean;
}

export function MessagePromotionButton({
  channelId,
  messageId,
  authorName,
  patientLinked,
}: MessagePromotionButtonProps): JSX.Element | null {
  const session = useSession();
  const permitted = session?.permissions?.includes(PROMOTE_PERMISSION) ?? false;
  // No read at all for a viewer who cannot propose or in a channel that is not patient-linked.
  const { enabled, promotions } = usePromotionsIndex(!permitted || !patientLinked);
  const actions = usePromotionActions();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // The trigger is the one stable control on the row: focus returns to it whenever the dialog closes.
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  if (!enabled || !permitted || !patientLinked) return null;
  const mine = promotions.filter((promotion) => promotion.message_id === messageId);

  function close(): void {
    setOpen(false);
  }

  async function withdraw(id: string): Promise<void> {
    setBusyId(id);
    setStatus("");
    const result = await actions.withdraw(id);
    setBusyId(null);
    setStatus(result.ok ? WITHDRAWN_TEXT : promotionErrorText(result.status, result.code));
    // The chip (and its Withdraw button) may leave on the re-read; the trigger stays.
    triggerRef.current?.focus();
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="wx-pin-toggle"
        aria-label={`${PROPOSE_BUTTON_LABEL}, message from ${authorName || UNKNOWN_PERSON}`}
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
      <output className="sr-only">{status}</output>
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

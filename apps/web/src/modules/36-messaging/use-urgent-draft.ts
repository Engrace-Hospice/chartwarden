// M36 WP 4.1 - the urgent dialog's draft and send attempt, owned by the composer button (not the dialog), so closing and
// reopening the dialog neither loses the text nor mints a new {client_message_id, Idempotency-Key} for an IDENTICAL payload (a
// lost response can then never become a second urgent message). Any edit rotates both ids. The button is keyed by channel, so a
// different conversation starts clean. `reset` is for a deliberate discard or a successful send.
import { useRef, useState } from "react";
import { type SbarSectionText, emptySbarValues } from "./sbar-utils";

export interface UrgentAttempt {
  readonly clientMessageId: string;
  readonly idempotencyKey: string;
  /** What the ids were minted for; null until a send is tried. */
  readonly signature: string | null;
}

export interface UrgentDraft {
  readonly sections: SbarSectionText;
  readonly recipientId: string;
  readonly setSections: (update: (current: SbarSectionText) => SbarSectionText) => void;
  readonly setRecipientId: (id: string) => void;
  readonly dirty: boolean;
  /** The ids to send `signature` under: reused for an identical payload, rotated for a changed one. */
  readonly attemptFor: (signature: string) => UrgentAttempt;
  /** A 409 means the server holds the first key as unfinished: only a new key can succeed (same message id). */
  readonly rotateKey: () => void;
  readonly reset: () => void;
}

const newAttempt = (signature: string | null): UrgentAttempt => ({
  clientMessageId: crypto.randomUUID(),
  idempotencyKey: crypto.randomUUID(),
  signature,
});

export function useUrgentDraft(): UrgentDraft {
  const [sections, setSectionsState] = useState<SbarSectionText>(
    () => emptySbarValues("care_team").sections,
  );
  const [recipientId, setRecipientId] = useState("");
  const attempt = useRef<UrgentAttempt | null>(null);
  const current = (): UrgentAttempt => {
    attempt.current ??= newAttempt(null);
    return attempt.current;
  };
  return {
    sections,
    recipientId,
    setSections: (change) => setSectionsState((s) => change(s)),
    setRecipientId,
    dirty: Object.values(sections).some((text) => text.trim() !== ""),
    attemptFor: (signature) => {
      const prior = current();
      attempt.current =
        prior.signature !== null && prior.signature !== signature
          ? newAttempt(signature)
          : { ...prior, signature };
      return attempt.current;
    },
    rotateKey: () => {
      attempt.current = { ...current(), idempotencyKey: crypto.randomUUID() };
    },
    reset: () => {
      attempt.current = null;
      setSectionsState(emptySbarValues("care_team").sections);
      setRecipientId("");
    },
  };
}
